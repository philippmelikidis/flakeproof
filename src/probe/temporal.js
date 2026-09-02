// Builds a self-contained init script (source string) that hides all
// elements matching `selector` for `ms` milliseconds after document start.
// Building block for provoking timing-dependent test failures.
//
// A hidden-for-N-ms rule is only useful evidence if we also know whether it
// actually matched anything. Counting `document.querySelectorAll(selector)`
// at script-execution time would be meaningless: `addInitScript` runs before
// the document is populated, so a count taken then is almost always a
// misleading zero, not proof of absence. The count is instead taken once the
// document has real content to query: immediately if the document is
// already past the loading phase (unusual this early, but honest to check),
// otherwise on `DOMContentLoaded`.
//
// If `reportFnName` names a function actually exposed on `window` (see
// src/inject/playwright.js, which wires this up via `context.exposeBinding`
// before this script runs), the count is handed back to the Node side - the
// only part of this system with filesystem access to persist it. If
// `DOMContentLoaded` never fires before the page/context is torn down (for
// example, the test failed and closed before the document finished
// parsing), the count is simply never reported. That is an honest "not
// knowable", and must never be papered over with a fabricated zero.
export function temporalScript(selector, ms, reportFnName = '__flakeproofTemporalMatchCount') {
  const delay = Number(ms);
  const selectorJson = JSON.stringify(selector);
  const reportFnJson = JSON.stringify(reportFnName);
  return `(() => {
    const style = document.createElement('style');
    style.textContent = ${selectorJson} + ' { visibility: hidden !important; }';
    const attach = () => {
      if (document.documentElement) {
        document.documentElement.appendChild(style);
        return true;
      }
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
        try {
          count = document.querySelectorAll(${selectorJson}).length;
        } catch {
          count = null;
        }
        fn(count);
      } catch {
        // Reporting must never break the page under test.
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', report, { once: true });
    } else {
      report();
    }
    setTimeout(() => style.remove(), ${delay});
  })();`;
}
