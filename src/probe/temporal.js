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
//
// A single count taken at DOMContentLoaded is also blind to a single-page
// app: an anchor inserted into the DOM later still inherits the css rule
// (visibility rules apply continuously, not just at attach time), but a
// count taken only once, early, never sees it - a true positive reported as
// a false negative (Fix 2 in the review). `setTimeout(() => style.remove(),
// ms)` already marks the exact moment the delay window closes; recounting
// immediately before removing the style catches exactly the case the first
// count missed. Every `report()` call is its own independent acknowledgment
// (see src/inject/playwright.js, which gives each one its own file rather
// than overwriting a shared one - Fix 1), so this can only ever ADD
// evidence, never destroy the DOMContentLoaded count: if the process is
// torn down before this second call fires (the test failed fast and the
// timeout never ran), nothing is reported for it, which is the correct
// "not knowable" answer - never a fabricated zero.
//
// Fix 3 (review) also applies here: a match count from `querySelectorAll`
// alone does not prove the delay actually did anything, because the css
// selector string can match real elements even when the browser silently
// discarded the *rule* built from that same string (invalid attribute
// syntax the stylesheet parser rejects but querySelectorAll tolerates).
// Every report therefore also carries whether the rule was actually live in
// the stylesheet at that moment, so a confident claim can require both a
// nonzero count AND a live rule.
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
        // Whether the rule built from the same selector string is actually
        // live in the stylesheet right now - a count alone cannot tell the
        // difference between "the rule matched these elements" and "the
        // browser silently dropped the rule but the selector still matches
        // something" (Fix 3 in the review).
        let ruleLive = null;
        try {
          ruleLive = !!style.sheet && style.sheet.cssRules.length === 1;
        } catch {
          ruleLive = null;
        }
        fn(count, ruleLive);
      } catch {
        // Reporting must never break the page under test.
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', report, { once: true });
    } else {
      report();
    }
    // Recount immediately before the style is removed: this is the exact
    // moment the delay window closes, and for a single-page app it is often
    // the FIRST time the anchor exists at all (see the header comment,
    // Fix 2). If the process is torn down before this fires, it simply never
    // reports - never a fabricated zero.
    setTimeout(() => {
      report();
      style.remove();
    }, ${delay});
  })();`;
}
