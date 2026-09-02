// Builds a self-contained init script that applies ONE semantic mutation
// (src/probe/catalogs/semantic.js) to the element matching `selector`, once
// the document has real content to query, and reports back through
// `reportFnName` whether it actually applied, whether it survived to a later
// observation point, which frame it ran in, and whether the target was ever
// found at all. This is the blindspots counterpart to src/probe/temporal.js:
// same reasoning applies almost unchanged.
//
// The catalog's `apply(selector)` and `verify(selector)` functions are
// already written to run IN the page: they call `document.querySelector`,
// mutate or check, and return a boolean. Embedding the functions' own source
// (via `Function#toString`) rather than re-implementing them here means this
// script can never drift from the catalog's actual behaviour - proving the
// mutation catalog and the injected mutation are the same code, not two
// hand-kept copies.
//
// Three review fixes shape this file:
//
// Fix (client-rendered elements): `addInitScript` runs before the document
// is populated, so calling `apply` immediately would almost always be a
// no-op querySelector miss, not proof the target is absent. Waiting only for
// `DOMContentLoaded` is not enough either - plenty of real pages insert
// their interactive content well after that event (a client-side framework
// mounting its tree, an async data fetch resolving). This gives the selector
// a bounded chance to appear: it polls until `MAX_WAIT_MS` after
// `DOMContentLoaded` before concluding the element never showed up at all.
// `found` (was the element EVER present, whether or not `apply` could act on
// it) is reported separately from `applied`, so "no such element on this
// page" and "the element appeared but this mutation could not touch it"
// (e.g. change-href on a link with no `href`) are never conflated into the
// same, misleadingly generic "check your selector" message.
//
// Fix (hydration false blindness): a mutation is not a one-shot fact once
// applied - a page that re-renders the mutated node afterwards (ordinary
// React/Vue/Svelte hydration, or client-side i18n swapping text back in)
// silently undoes it before the suite's own assertions ever run. Reporting
// only the DOMContentLoaded-time `applied` boolean, as the previous version
// did, could not tell a genuinely blind suite from a suite that never got a
// fair look at the mutation at all. A `MutationObserver` watches the whole
// document from the moment the mutation applies, and the instant `verify`
// (the catalog's own check for whether the mutated state still holds) turns
// false, that is reported immediately as `survived: false` - its own
// signal, never folded into `applied`. A fixed delay was tried first and
// rejected: a suite whose assertion is satisfied quickly closes its page
// (and tears down all of this script's timers) well before any
// arbitrarily-chosen delay would fire, which is exactly the scenario this
// needs to catch - a sensitive suite passing fast because the page reverted
// the mutation in time. Reacting to the mutation as it happens, rather than
// polling for it later, has no such race. `SETTLE_MS` remains as a bounded
// fallback purely for the positive case (nothing ever reverted): useful
// when the page outlives it, harmless (an absent report, never a fabricated
// one) when it does not - mirroring src/probe/temporal.js's own precedent of
// treating "the process was torn down before this could report" as an
// honest "not knowable", never a guess.
//
// Fix (frame attribution): `addInitScript` runs in every frame a context
// creates, including iframes. `window.top === window.self` is available
// inside the page script itself and needs no extra plumbing, so every report
// says which frame it came from - `null` for the top-level page, the
// frame's own URL otherwise - so a mutation that only ever lands inside an
// iframe is never silently scored as if it applied to the main page.
const MAX_WAIT_MS = 1000;
const POLL_MS = 100;
const SETTLE_MS = 300;

export function mutationScript(mutation, selector, reportFnName = '__flakeproofMutationApplied') {
  const selectorJson = JSON.stringify(selector);
  const reportFnJson = JSON.stringify(reportFnName);
  return `(() => {
    const applyFn = ${mutation.apply.toString()};
    const verifyFn = ${mutation.verify.toString()};
    const selector = ${selectorJson};
    const frame = (window.top === window.self) ? null : String(location.href);
    const report = (applied, survived, found) => {
      try {
        const fn = window[${reportFnJson}];
        if (typeof fn === 'function') fn(applied, survived, frame, found);
      } catch {
        // Reporting must never break the page under test.
      }
    };
    const watch = (applied) => {
      let reported = false;
      let observer = null;
      const reportOnce = (survived) => {
        if (reported) return;
        reported = true;
        try { if (observer) observer.disconnect(); } catch {}
        report(applied, survived, true);
      };
      const check = () => {
        let survived = null;
        try {
          survived = verifyFn(selector) === true;
        } catch {
          survived = null;
        }
        // Only a definite "it got undone" is worth reacting to immediately;
        // a continuing true is reported by the bounded fallback below, if
        // the page lives long enough for it to fire.
        if (survived === false) reportOnce(false);
      };
      const root = document.body || document.documentElement;
      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(check);
        observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
      }
      setTimeout(() => {
        let survived = null;
        try {
          survived = verifyFn(selector) === true;
        } catch {
          survived = null;
        }
        reportOnce(survived);
      }, ${SETTLE_MS});
    };
    const attempt = (deadline) => {
      const exists = !!document.querySelector(selector);
      if (exists) {
        let applied = false;
        try {
          applied = applyFn(selector) === true;
        } catch {
          applied = false;
        }
        report(applied, null, true);
        if (applied) watch(applied);
        return;
      }
      if (Date.now() >= deadline) {
        // Gave the element a bounded chance to appear (see header comment);
        // it never did. This is a confirmed absence, not a fabricated one.
        report(false, null, false);
        return;
      }
      setTimeout(() => attempt(deadline), ${POLL_MS});
    };
    const start = () => attempt(Date.now() + ${MAX_WAIT_MS});
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  })();`;
}
