// Opt-in injection for Puppeteer users - the Puppeteer counterpart to
// src/inject/playwright.js's withTemporal, built on Puppeteer's own
// equivalents: `page.evaluateOnNewDocument()` for the init script and
// `page.exposeFunction()` for the report callback. Same env var contract
// (FLAKEPROOF_TEMPORAL_SELECTOR/MS/ACK), same ack directory format that
// src/triage/temporal-probe.js already reads - reusing src/probe/temporal.js
// unchanged means no framework-specific code is needed on the reading side.
//
//   import { installTemporal } from 'flakeproof/inject-puppeteer';
//   const page = await browser.newPage();
//   await installTemporal(page);
//   await page.goto(url);
//
// Call this once per page, right after it is created and before the first
// navigation you want provoked - `evaluateOnNewDocument` only affects
// navigations that happen after it is registered, exactly like Playwright's
// `addInitScript`. Verified end to end against this repo's fixture page: a
// real Puppeteer session with `installTemporal` wired up delayed a real
// element's visibility by the requested amount and produced the same
// installed/count/ruleLive ack shape src/triage/temporal-probe.js expects
// (see this cycle's report for the capture).
import { temporalScript } from '../probe/temporal.js';
import { writeTemporalAck } from './shared/ack.js';

const REPORT_FN = '__flakeproofTemporalMatchCount';

export async function installTemporal(page, { env = process.env } = {}) {
  const selector = env.FLAKEPROOF_TEMPORAL_SELECTOR;
  const ms = Number(env.FLAKEPROOF_TEMPORAL_MS);
  if (!selector || !Number.isFinite(ms) || ms <= 0) return false;

  const ackDir = env.FLAKEPROOF_TEMPORAL_ACK;
  const writeAck = (count, ruleLive) => writeTemporalAck(ackDir, { count, ruleLive });

  if (ackDir) {
    // Puppeteer's exposeFunction is the direct counterpart of Playwright's
    // context.exposeBinding used in src/inject/playwright.js: it must be
    // registered before evaluateOnNewDocument runs so window[REPORT_FN]
    // exists by the time the injected script looks it up.
    await page.exposeFunction(REPORT_FN, (count, ruleLive) => writeAck(count, ruleLive)).catch(() => {});
  }
  await page.evaluateOnNewDocument(temporalScript(selector, ms, REPORT_FN));
  // Same honesty guarantee as the Playwright wrapper: an initial "installed,
  // count unknown" receipt proves installation before any page has had a
  // chance to report back - never a fabricated zero if the page never gets
  // that far.
  await writeAck(null, null);
  return true;
}
