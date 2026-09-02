// Opt-in injection for @playwright/test users. Wrap your base test once and
// every browser context it creates honors two independent sets of
// FLAKEPROOF_* environment variables:
//
//   import { test as base } from '@playwright/test';
//   import { withTemporal } from 'flakeproof/inject';
//   export const test = withTemporal(base);
//
// - FLAKEPROOF_TEMPORAL_* (set by `flakeproof triage --temporal`): delays an
//   element to provoke a timing-dependent failure deterministically.
// - FLAKEPROOF_MUTATION_* (set by `flakeproof blindspots`): applies one
//   semantic mutation from src/probe/catalogs/semantic.js to an element, to
//   measure whether the user's suite notices.
//
// Despite the name, this single wrapper is the one opt-in injection point
// for both: they are the same mechanism (env vars read once per context,
// addInitScript, a filesystem ack directory acknowledging what actually
// happened) applied to two different experiments, and a project should only
// ever need to wire up one wrapper. Without either set of env vars the
// wrapper is inert, so it can stay in place permanently.
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { temporalScript } from '../probe/temporal.js';
import { mutationScript } from '../probe/mutation-script.js';
import { semanticMutations } from '../probe/catalogs/semantic.js';
import { MUTATION_SURVIVED_FILE } from '../blindspots/ack.js';

const REPORT_FN = '__flakeproofTemporalMatchCount';
const MUTATION_REPORT_FN = '__flakeproofMutationApplied';

export function withTemporal(base) {
  return base.extend({
    context: async ({ context }, use) => {
      const selector = process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
      const ms = Number(process.env.FLAKEPROOF_TEMPORAL_MS);
      if (selector && Number.isFinite(ms) && ms > 0) {
        // FLAKEPROOF_TEMPORAL_ACK names a DIRECTORY, not a single file to
        // overwrite. `addInitScript` runs in EVERY frame (including
        // iframes) and after every navigation, a suite may open more than
        // one page in the same context, and a real run may use more than
        // one worker process - every one of those is a writer that must be
        // able to report without erasing anyone else's receipt. Giving each
        // acknowledging write its own uniquely named file is the fix (see
        // Fix 1 in the review): a single shared file meant the LAST writer
        // to finish silently discarded every other writer's receipt, so an
        // unrelated iframe reporting 0 could erase a genuine match reported
        // by the page itself. temporalProbe reads every file in the
        // directory and aggregates as the MAX of the known counts, so no
        // single writer can suppress another's evidence.
        // `randomUUID` plus the process id rules out any collision between
        // writers in this process and writers in a different worker process
        // sharing the same directory.
        const ackDir = process.env.FLAKEPROOF_TEMPORAL_ACK;
        // The wrapper is the only side of this with filesystem access, so it
        // is the one that persists each receipt. Failing to write it must
        // never break the user's test run.
        const writeAck = async (count, ruleLive) => {
          if (!ackDir) return;
          const file = join(ackDir, `${process.pid}-${randomUUID()}.json`);
          await mkdir(ackDir, { recursive: true })
            .then(() => writeFile(file, JSON.stringify({ installed: true, count, ruleLive })))
            .catch(() => {});
        };
        if (ackDir) {
          // The page reports its own match count (and whether the delay
          // rule was actually live - see temporalScript and Fix 3) back
          // through this binding once the document has real content, and
          // again right before the delay window closes. Registered before
          // addInitScript so it is guaranteed to exist by the time the
          // injected script runs in any page this context creates.
          await context.exposeBinding(REPORT_FN, (_source, count, ruleLive) => writeAck(count, ruleLive)).catch(() => {});
        }
        await context.addInitScript(temporalScript(selector, ms, REPORT_FN));
        // An initial receipt with an unknown count proves installation
        // before any page has had a chance to report back; every later
        // report from the exposed binding above adds its own separate
        // receipt with the real count once known - it never overwrites this
        // one. If no page ever reports back (for example the test fails and
        // the context closes before the document finishes parsing), this
        // initial "count unknown" receipt is what temporalProbe reads - the
        // honest answer, never a fabricated zero.
        await writeAck(null, null);
      }

      // Mutation injection (the blindspots probe). Same shape as the
      // temporal block above, generalized from a match count to a
      // applied/survived/frame/found record: a mutation is closer to a
      // one-shot edit than the temporal delay's continuous rule, but it can
      // still be silently undone by the page afterwards (ordinary
      // hydration), so `survived` is its own later-observed signal, never
      // folded into `applied` (see src/probe/mutation-script.js).
      const mutationId = process.env.FLAKEPROOF_MUTATION_ID;
      const mutationSelector = process.env.FLAKEPROOF_MUTATION_SELECTOR;
      if (mutationId && mutationSelector) {
        const mutation = semanticMutations.find((m) => m.id === mutationId);
        const mutationAckDir = process.env.FLAKEPROOF_MUTATION_ACK;
        const writeMutationAck = async (fields) => {
          if (!mutationAckDir) return;
          const payload = JSON.stringify({ installed: true, ...fields });
          const file = join(mutationAckDir, `${process.pid}-${randomUUID()}.json`);
          await mkdir(mutationAckDir, { recursive: true })
            .then(() => writeFile(file, payload))
            .catch(() => {});
          if (fields.survived === true || fields.survived === false) {
            // `survived` describes the mutation's CURRENT state, not an
            // independent fact each writer contributes the way applied/found
            // do (see src/probe/mutation-script.js, which now reports every
            // observed change in either direction). A dedicated file that
            // gets OVERWRITTEN on every update always holds whichever report
            // landed most recently, so a later correction (a delayed
            // revert - audit Fix 1, or an async re-parent healing itself -
            // audit Fix 5) is never outraced or discarded by an earlier one,
            // in either direction. src/blindspots/ack.js reads this file as
            // the authoritative answer for `survived` when it exists.
            await mkdir(mutationAckDir, { recursive: true })
              .then(() => writeFile(join(mutationAckDir, MUTATION_SURVIVED_FILE), payload))
              .catch(() => {});
          }
        };
        if (!mutation) {
          // The env vars name a mutation id this copy of the catalog does
          // not know about - most likely `flakeproof` and `flakeproof/inject`
          // are different versions in the same project. Silently injecting
          // nothing here would leave no ack at all, which measureBlindspots
          // cannot tell apart from "the wrapper was never installed" - a
          // completely different, misleading diagnosis. Say what actually
          // happened instead.
          await writeMutationAck({ applied: false, survived: null, frame: null, found: null, error: 'unknown-mutation-id' });
        } else {
          if (mutationAckDir) {
            // The page reports applied/survived/frame/found once the
            // document has real content, and again after it settles (see
            // mutationScript). Registered before addInitScript so it exists
            // by the time the injected script runs in any page this context
            // creates.
            await context
              .exposeBinding(MUTATION_REPORT_FN, (_source, applied, survived, frame, found) =>
                writeMutationAck({ applied, survived, frame, found }),
              )
              .catch(() => {});
          }
          await context.addInitScript(mutationScript(mutation, mutationSelector, MUTATION_REPORT_FN));
          // An initial receipt with every field unknown proves installation
          // before any page has had a chance to report back - the same
          // honesty guarantee as the temporal ack above: if no page ever
          // reports (the test fails before the document finishes parsing),
          // this is what measureBlindspots reads, never a fabricated
          // false.
          await writeMutationAck({ applied: null, survived: null, frame: null, found: null });
        }
      }

      await use(context);
    },
  });
}
