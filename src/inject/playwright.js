// Opt-in temporal injection for @playwright/test users. Wrap your base test
// once and every browser context it creates honors the FLAKEPROOF_TEMPORAL_*
// environment variables that `flakeproof triage --temporal` sets:
//
//   import { test as base } from '@playwright/test';
//   import { withTemporal } from 'flakeproof/inject';
//   export const test = withTemporal(base);
//
// Without the env vars the wrapper is inert, so it can stay in place
// permanently.
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { temporalScript } from '../probe/temporal.js';

const REPORT_FN = '__flakeproofTemporalMatchCount';

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
      await use(context);
    },
  });
}
