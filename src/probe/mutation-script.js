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
// Fix (hydration false blindness, hardened across two review rounds): a
// mutation is not a one-shot fact once applied - a page that re-renders the
// mutated node afterwards (ordinary React/Vue/Svelte hydration, or
// client-side i18n swapping text back in) silently undoes it before the
// suite's own assertions ever run. Reporting only the DOMContentLoaded-time
// `applied` boolean, as the first version did, could not tell a genuinely
// blind suite from a suite that never got a fair look at the mutation at
// all. A `MutationObserver` watches the whole document from the moment the
// mutation applies, and every time `verify` (the catalog's own check for
// whether the mutated state still holds) changes, that current reading is
// reported as `survived` - its own signal, never folded into `applied`.
//
// A second review round found that the observer above was watched for
// SETTLE_MS (300ms) only: the first report, whichever fired first, silenced
// everything afterwards, so a revert landing after that fixed window
// (reproduced with a page restoring its content at 900ms) was never seen,
// and the `survived: true` already written from the settle timer stood
// uncorrected - a demonstrably sensitive suite reported as blind. The claim
// this comment used to make here - that reacting to mutations as they
// happen "has no such race" - was true of the mechanism but not of the
// code: nothing kept that mechanism running past one report.
//
// The fix does two things together. First, this script never stops
// reporting: every observed change in `verify`'s reading - in EITHER
// direction - is reported as soon as it is seen, for as long as the page
// lives, never gated behind "only the first one counts". Second,
// src/blindspots/ack.js and src/inject/playwright.js treat `survived` as an
// evolving state rather than an independent fact each report contributes:
// the wrapper keeps a single, dedicated ack file that is OVERWRITTEN on
// every update, so whichever report landed most recently is always what
// gets read back, regardless of what an earlier report said. This is also
// what makes the async re-parent fix below correct without needing any
// arbitrary confirmation delay that would only reopen the exact race this
// fix exists to close: a delay long enough to survive a real re-parent gap
// is also long enough for a fast test's page teardown to win the race and
// silence the report entirely.
//
// `pagehide`, `beforeunload` and `visibilitychange` (hidden) hook the
// moment the page actually starts tearing down, so a final reading is taken
// as late as the browser gives this script any chance to run at all - a
// backstop for the (typically slow, CDP-driven) case where no DOM mutation
// happens right at the end. What is still, honestly, not guaranteed: a
// revert that happens strictly after every one of those signals has fired,
// with no further DOM mutation to react to (or one so fast the browser
// gives no JS turn to react to it at all), cannot be observed - there is no
// hook left to catch it, and this script reports nothing further rather
// than guess. `SETTLE_MS` remains as an early reading for the common
// positive case (nothing has reverted yet): useful context while the page
// is still running, but never treated as the last word by anything reading
// it back.
//
// Fix (async re-parent false revert): a single MutationObserver callback
// where `verify` reads false is not by itself proof of a genuine revert - a
// target detached from the document in one task and reattached (mutated
// content fully intact) in a later one reads exactly the same way for one
// instant. Reporting that instant used to discard a mutation the suite
// would genuinely have caught. Because every change is now reported (see
// above) and the ack side always keeps only the LATEST reading, a
// reattachment reported shortly after a detach naturally overwrites the
// premature false with the true, healed state - no fixed wait to get wrong
// in either direction, and no evidence thrown away either way.
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
      let observer = null;
      let torn = false; // the page's own teardown has already been reported
      const checkNow = () => {
        try {
          return verifyFn(selector) === true;
        } catch {
          return null;
        }
      };
      const onTeardown = () => {
        if (torn) return;
        torn = true;
        try { if (observer) observer.disconnect(); } catch {}
        try { window.removeEventListener('pagehide', onTeardown); } catch {}
        try { window.removeEventListener('beforeunload', onTeardown); } catch {}
        try { document.removeEventListener('visibilitychange', onVisibilityChange); } catch {}
        report(applied, checkNow(), true);
      };
      const onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') onTeardown();
      };
      // Every observed change is reported immediately, in EITHER direction -
      // see the header comment for why this, rather than a confirmation
      // delay, is what makes both the late-revert and the async-re-parent
      // fixes correct at the same time: reacting instantly wins the race
      // against a fast test's page teardown, and a later corrective report
      // (the target reattached, content intact) simply overwrites the
      // earlier one on the ack side (src/blindspots/ack.js), never the
      // other way around.
      const onMutation = () => {
        if (torn) return;
        const survived = checkNow();
        if (survived === true || survived === false) report(applied, survived, true);
      };
      const root = document.body || document.documentElement;
      if (root && typeof MutationObserver === 'function') {
        observer = new MutationObserver(onMutation);
        observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
      }
      // An early reading for the common positive case (nothing has reverted
      // yet): useful context while the page is still running, but - unlike
      // the previous version - never treated as conclusive by anything
      // reading it back, and never stops onMutation or the teardown hooks
      // from reporting whatever comes after it.
      setTimeout(() => {
        if (torn) return;
        report(applied, checkNow(), true);
      }, ${SETTLE_MS});
      // As late as the browser gives this script any chance to run: report
      // the true final state right as the page actually starts tearing
      // down, so a revert with no further DOM mutation to react to is still
      // caught if it happens before the page is gone.
      try { window.addEventListener('pagehide', onTeardown, { once: true }); } catch {}
      try { window.addEventListener('beforeunload', onTeardown, { once: true }); } catch {}
      try { document.addEventListener('visibilitychange', onVisibilityChange); } catch {}
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
