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

export function withTemporal(base) {
  return base.extend({
    context: async ({ context }, use) => {
      const selector = process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
      const ms = Number(process.env.FLAKEPROOF_TEMPORAL_MS);
      if (selector && Number.isFinite(ms) && ms > 0) {
        await context.addInitScript(temporalScript(selector, ms));
        const ack = process.env.FLAKEPROOF_TEMPORAL_ACK;
        // The acknowledgment lets the probe distinguish "delay never
        // happened" from "timing is not the cause". Failing to write it must
        // never break the user's test run.
        if (ack) await writeFile(ack, 'injected').catch(() => {});
      }
      await use(context);
    },
  });
}
