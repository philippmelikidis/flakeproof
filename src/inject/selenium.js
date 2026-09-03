// Opt-in injection for Selenium 4 users. The WebDriver spec has no
// addInitScript equivalent, so this uses the escape hatch the issue names:
// Chrome DevTools Protocol's `Page.addScriptToEvaluateOnNewDocument`, reached
// through selenium-webdriver's own `driver.createCDPConnection('page')`
// (Chromium only - CDP is a Chromium-specific capability, not part of the
// WebDriver protocol Firefox/Safari implement).
//
//   import { installTemporal } from 'flakeproof/inject-selenium';
//   const driver = await new Builder().forBrowser('chrome').build();
//   await installTemporal(driver);
//   await driver.get(url);
//
// Call this before the first navigation you want provoked - like
// addScriptToEvaluateOnNewDocument itself, it only affects navigations that
// happen after it is registered.
//
// Verified end to end against this repo's fixture page with a real
// ChromeDriver session (see this cycle's report for the exact script): a
// real element's visibility was delayed by the requested amount, and the ack
// files written matched src/triage/temporal-probe.js's expected shape,
// including the same two-report pattern (an early, possibly-not-yet-live
// report followed by a confirmed-live one at the delay window's close) that
// src/probe/temporal.js's header comment documents for Playwright.
//
// Two things make this its own implementation rather than a thin wrapper
// around src/probe/temporal.js:
//
//   1. `Runtime.addBinding` - the raw CDP primitive Playwright's
//      exposeBinding and Puppeteer's exposeFunction are themselves built on
//      top of - delivers exactly ONE STRING argument per call, not the
//      richer multi-argument JS call those higher-level APIs simulate. The
//      injected script therefore serializes `{ count, ruleLive }` into one
//      JSON string instead of calling the report function with two
//      positional arguments.
//   2. selenium-webdriver's `CDPConnection` exposes `send()`/`execute()` for
//      commands but no public event-subscription API for asynchronous
//      protocol notifications like `Runtime.bindingCalled`. Those arrive on
//      the connection's underlying websocket, so this listens on
//      `connection._wsConnection` directly - an internal property, not
//      documented API, guarded defensively in case a future
//      selenium-webdriver release renames or removes it.
import { writeTemporalAck } from './shared/ack.js';

const REPORT_FN = '__flakeproofTemporalMatchCount';

// Same shape as src/probe/temporal.js's temporalScript, adapted for CDP's
// single-string binding contract (see header comment, point 1).
function cdpTemporalScript(selector, ms, reportFnName) {
  const selectorJson = JSON.stringify(selector);
  const reportFnJson = JSON.stringify(reportFnName);
  return `(() => {
    const style = document.createElement('style');
    style.textContent = ${selectorJson} + ' { visibility: hidden !important; }';
    const attach = () => {
      if (document.documentElement) { document.documentElement.appendChild(style); return true; }
      return false;
    };
    if (!attach()) {
      new MutationObserver((records, observer) => {
        if (attach()) observer.disconnect();
      }).observe(document, { childList: true });
    }
    const report = () => {
      try {
        const fn = window[${reportFnJson}];
        if (typeof fn !== 'function') return;
        let count = null;
        try { count = document.querySelectorAll(${selectorJson}).length; } catch { count = null; }
        let ruleLive = null;
        try { ruleLive = !!style.sheet && style.sheet.cssRules.length === 1; } catch { ruleLive = null; }
        fn(JSON.stringify({ count, ruleLive }));
      } catch {
        // Reporting must never break the page under test.
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', report, { once: true });
    } else {
      report();
    }
    setTimeout(() => { report(); style.remove(); }, ${Number(ms)});
  })();`;
}

export async function installTemporal(driver, { env = process.env } = {}) {
  const selector = env.FLAKEPROOF_TEMPORAL_SELECTOR;
  const ms = Number(env.FLAKEPROOF_TEMPORAL_MS);
  if (!selector || !Number.isFinite(ms) || ms <= 0) return false;

  const ackDir = env.FLAKEPROOF_TEMPORAL_ACK;
  const writeAck = (count, ruleLive) => writeTemporalAck(ackDir, { count, ruleLive });

  let connection;
  try {
    connection = await driver.createCDPConnection('page');
  } catch {
    // No CDP available (a non-Chromium browser, most likely) - there is no
    // injection mechanism to fall back to. Say nothing was installed rather
    // than silently doing nothing and letting the caller believe it worked.
    return false;
  }

  if (ackDir) {
    try {
      // Page.enable must be requested before Runtime.bindingCalled events
      // are delivered for a script installed via
      // Page.addScriptToEvaluateOnNewDocument (observed empirically against
      // a real ChromeDriver session - see this cycle's report); without it
      // the binding exists on the page but its calls never reach this
      // process.
      await connection.send('Page.enable', {});
      await connection.send('Runtime.enable', {});
      await connection.send('Runtime.addBinding', { name: REPORT_FN });
      connection._wsConnection?.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.method !== 'Runtime.bindingCalled' || msg.params?.name !== REPORT_FN) return;
        try {
          const { count, ruleLive } = JSON.parse(msg.params.payload);
          writeAck(count, ruleLive);
        } catch {
          // A payload that cannot be parsed proves nothing - never fabricate
          // a count from it.
        }
      });
    } catch {
      // Failing to wire up the report channel must never break the user's
      // suite; the initial ack below still proves installation was
      // attempted, and no further reports will be fabricated.
    }
  }

  await connection.send('Page.addScriptToEvaluateOnNewDocument', {
    source: cdpTemporalScript(selector, ms, REPORT_FN),
  });
  await writeAck(null, null);
  return true;
}
