// Builds a self-contained init script that applies ONE semantic mutation
// (src/probe/catalogs/semantic.js) to the element matching `selector`, once
// the document has real content to query, and reports back through
// `reportFnName` whether it actually applied. This is the blindspots
// counterpart to src/probe/temporal.js: same reasoning applies almost
// unchanged.
//
// `addInitScript` runs before the document is populated, so calling the
// mutation immediately would almost always be a no-op querySelector miss,
// not proof the target is absent. Wait for `DOMContentLoaded` (or run right
// away if the document is already past the loading phase) exactly like the
// temporal script does.
//
// The catalog's `apply(selector)` functions are already written to run IN
// the page: they call `document.querySelector`, mutate, and return a
// boolean. Embedding the function's own source (via `Function#toString`)
// rather than re-implementing the mutation here means this script can never
// drift from the catalog's actual behaviour - proving the mutation catalog
// and the injected mutation are the same code, not two hand-kept copies.
//
// A mutation is a one-shot edit, not a continuous rule like the temporal
// delay style, so there is nothing to recount at a later moment: either the
// selector resolved at DOMContentLoaded and the edit happened, or it did
// not. `apply`'s own boolean return is the entire truth here, carried
// straight to the report through the ack (see src/inject/playwright.js).
export function mutationScript(mutation, selector, reportFnName = '__flakeproofMutationApplied') {
  const selectorJson = JSON.stringify(selector);
  const reportFnJson = JSON.stringify(reportFnName);
  return `(() => {
    const apply = ${mutation.apply.toString()};
    const run = () => {
      let applied = false;
      try {
        applied = apply(${selectorJson}) === true;
      } catch {
        applied = false;
      }
      try {
        const fn = window[${reportFnJson}];
        if (typeof fn === 'function') fn(applied);
      } catch {
        // Reporting must never break the page under test.
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run, { once: true });
    } else {
      run();
    }
  })();`;
}
