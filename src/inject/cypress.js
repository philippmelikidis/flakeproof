// Opt-in injection for Cypress users - a support-file hook, as the issue
// names. Cypress's own documented equivalent of an init script is
// `Cypress.on('window:before:load', win => ...)`: it runs inside the AUT's
// window before any of the page's own scripts execute, on every visit,
// exactly like Playwright's `addInitScript`.
//
// The one wrinkle a support-file hook cannot avoid: the callback given to
// `window:before:load` runs in the BROWSER (inside the AUT's window), the
// same process Playwright's addInitScript/exposeBinding pair lets a page
// script call straight back into Node. Cypress has no browser-to-Node RPC
// available from inside that callback - only `cy.task()` does that, and
// `cy.task()` is a queued Cypress *command*, callable only from spec code,
// never from a plain function running inside the page. So the injected
// script cannot write its own ack file directly the way the Playwright,
// Puppeteer and Selenium variants do; it stashes its result on `win` instead,
// and a small amount of spec-side glue (also below) reads it back and hands
// it to `cy.task()`, which is what actually writes the file - registered
// separately, from src/inject/cypress-node.js, because this file is bundled
// for the BROWSER (Cypress webpacks the support file) and cannot import any
// Node builtins at all; keeping them in one file broke that bundling in
// practice (an `UnhandledSchemeError` on `node:fs/promises` from Cypress's
// own webpack config) and is why they are split. Together they are exactly
// two things the user genuinely has to add - there is no hook that needs
// less than that without Cypress itself growing one.
//
// Usage - in cypress.config.js:
//
//   const { defineConfig } = require('cypress');
//   const { registerTemporalTask } = require('flakeproof/inject-cypress-node');
//   module.exports = defineConfig({
//     e2e: {
//       supportFile: 'cypress/support/e2e.js',
//       env: { FLAKEPROOF_TEMPORAL_SELECTOR: process.env.FLAKEPROOF_TEMPORAL_SELECTOR,
//              FLAKEPROOF_TEMPORAL_MS: process.env.FLAKEPROOF_TEMPORAL_MS },
//       // Cypress >=16 reads support-file env through `expose` instead of `env`
//       // (see readFlakeproofEnv below); setting both costs nothing and covers
//       // either version.
//       expose: { FLAKEPROOF_TEMPORAL_SELECTOR: process.env.FLAKEPROOF_TEMPORAL_SELECTOR,
//                 FLAKEPROOF_TEMPORAL_MS: process.env.FLAKEPROOF_TEMPORAL_MS },
//       setupNodeEvents(on, config) { registerTemporalTask(on); return config; },
//     },
//   });
//
// And in cypress/support/e2e.js:
//
//   const { installTemporal } = require('flakeproof/inject-cypress');
//   installTemporal();
//
// Verified end to end against this repo's fixture page with a real
// `cypress run`: a real element's visibility was delayed by the requested
// amount, and the resulting ack files matched the exact shape
// src/triage/temporal-probe.js expects (see this cycle's report).
const REPORT_KEY = '__flakeproofTemporalResult';
export const TEMPORAL_ACK_TASK = 'flakeproofTemporalAck';

// Cypress >=16 removed direct `Cypress.env()` access outside cy commands in
// favor of `Cypress.expose()`; versions before it have no `Cypress.expose`
// at all. Try the modern API first, fall back to the classic one, so this
// keeps working across the version split instead of only the newest release.
function readFlakeproofEnv(CypressRef, key) {
  if (typeof CypressRef.expose === 'function') {
    const value = CypressRef.expose(key);
    if (value !== undefined) return value;
  }
  try {
    return CypressRef.env(key);
  } catch {
    return undefined;
  }
}

// Call from the support file (cypress/support/e2e.js or e2e.ts). Inert
// without FLAKEPROOF_TEMPORAL_SELECTOR/MS, exactly like withTemporal, so it
// can stay in place permanently. Pure browser-side code - no Node imports,
// so Cypress's support-file bundler can process it.
export function installTemporal(
  CypressRef = globalThis.Cypress,
  cyRef = globalThis.cy,
  { beforeEachFn = globalThis.beforeEach, afterEachFn = globalThis.afterEach } = {},
) {
  if (!CypressRef || !cyRef) {
    throw new Error('installTemporal() must run inside a Cypress support file, where Cypress and cy are globals');
  }

  const active = () => {
    const selector = readFlakeproofEnv(CypressRef, 'FLAKEPROOF_TEMPORAL_SELECTOR');
    const ms = Number(readFlakeproofEnv(CypressRef, 'FLAKEPROOF_TEMPORAL_MS'));
    return selector && Number.isFinite(ms) && ms > 0 ? { selector, ms } : null;
  };

  beforeEachFn(() => {
    if (!active()) return;
    // Proves installation before the page has had any chance to report
    // back - the same honesty guarantee as src/inject/playwright.js's
    // initial ack.
    cyRef.task(TEMPORAL_ACK_TASK, { count: null, ruleLive: null }, { log: false });
  });

  CypressRef.on('window:before:load', (win) => {
    const config = active();
    if (!config) return;
    const { selector, ms } = config;

    const doc = win.document;
    const style = doc.createElement('style');
    style.textContent = `${selector} { visibility: hidden !important; }`;
    const attach = () => {
      if (doc.documentElement) {
        doc.documentElement.appendChild(style);
        return true;
      }
      return false;
    };
    if (!attach()) {
      new win.MutationObserver((records, observer) => {
        if (attach()) observer.disconnect();
      }).observe(doc, { childList: true });
    }
    const report = () => {
      let count;
      try {
        count = doc.querySelectorAll(selector).length;
      } catch {
        count = null;
      }
      let ruleLive;
      try {
        ruleLive = !!style.sheet && style.sheet.cssRules.length === 1;
      } catch {
        ruleLive = null;
      }
      win[REPORT_KEY] = { count, ruleLive };
    };
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', report, { once: true });
    } else {
      report();
    }
    win.setTimeout(() => {
      report();
      style.remove();
    }, ms);
  });

  afterEachFn(() => {
    if (!active()) return;
    // best-effort: if the delay window has not closed by the time the test
    // ends, there is nothing yet to report - never fabricate a result.
    cyRef.window({ log: false }).then((win) => {
      const result = win[REPORT_KEY];
      if (result) cyRef.task(TEMPORAL_ACK_TASK, result, { log: false });
    });
  });
}
