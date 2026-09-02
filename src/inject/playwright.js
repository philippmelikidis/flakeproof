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
import { writeFile } from 'node:fs/promises';
import { temporalScript } from '../probe/temporal.js';

const REPORT_FN = '__flakeproofTemporalMatchCount';

export function withTemporal(base) {
  return base.extend({
    context: async ({ context }, use) => {
      const selector = process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
      const ms = Number(process.env.FLAKEPROOF_TEMPORAL_MS);
      if (selector && Number.isFinite(ms) && ms > 0) {
        const ack = process.env.FLAKEPROOF_TEMPORAL_ACK;
        // The wrapper is the only side of this with filesystem access, so it
        // is the one that persists the receipt. Failing to write it must
        // never break the user's test run.
        const writeAck = async (count) => {
          if (!ack) return;
          await writeFile(ack, JSON.stringify({ installed: true, count })).catch(() => {});
        };
        if (ack) {
          // The page reports its own match count back through this binding
          // once the document has real content (see temporalScript).
          // Registered before addInitScript so it is guaranteed to exist by
          // the time the injected script runs in any page this context
          // creates.
          await context.exposeBinding(REPORT_FN, (_source, count) => writeAck(count)).catch(() => {});
        }
        await context.addInitScript(temporalScript(selector, ms, REPORT_FN));
        // An initial receipt with an unknown count proves installation
        // before any page has had a chance to report back; the exposed
        // binding above overwrites it with the real count once known. If no
        // page ever reports back (for example the test fails and the
        // context closes before the document finishes parsing), this
        // initial "count unknown" receipt is what temporalProbe reads - the
        // honest answer, never a fabricated zero.
        await writeAck(null);
      }
      await use(context);
    },
  });
}
