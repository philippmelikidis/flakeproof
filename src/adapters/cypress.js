// Cypress adapter: anchor extraction from Cypress's own failure message
// format, and a reader for the Mocha JSON reporter Cypress bundles
// (`cypress run --reporter json`), returning the same
// `{ testId, message, anchor }` shape the Playwright and Robot Framework
// readers return so `runSuite` can use it unchanged.
//
// Cypress does not surface a raw "waiting for locator" line the way
// Playwright does. Every retry-able command wraps its failure as
// "Timed out retrying after Nms: <reason>", and the reason takes one of three
// shapes, each verified against a real `cypress run` (see
// test/fixtures/errors/cy-*.txt, captured with the command in this file's
// header comment and cross-checked in this cycle's report):
//
//   1. `cy.get('#foo')` (or any jQuery-style existence check) names the
//      selector literally, backtick delimited:
//      "Expected to find element: `#foo`, but never found it."
//   2. A chai assertion on an ALREADY RESOLVED element describes the element
//      itself, not the locator the test wrote:
//      "expected '<a#cta.btn.btn-primary>' to have text 'X', but ...".
//      That bracketed form is chai's own rendering of the real DOM node
//      (tag, optional #id, then zero or more .class tokens) - translating it
//      to css (`a#cta.btn.btn-primary`) is mechanical, not a guess, because
//      it names the actual failing element rather than reconstructing what
//      the test asked for.
//   3. `cy.contains('some text')` names TEXT CONTENT, not a selector:
//      "Expected to find content: 'some text' but never did." jQuery (and
//      flakeproof's css-based DOM matcher) has no notion of "the selector
//      that would find this text" - there is no selector to hand back, so
//      this abstains rather than inventing one.
import { readMochaFailures } from './shared/mocha-json.js';

const ELEMENT_NOT_FOUND = /Expected to find element:\s*`([^`]+)`/;
const CONTENT_NOT_FOUND = /Expected to find content:/;
const CHAI_ELEMENT = /<([a-zA-Z][a-zA-Z0-9-]*)((?:#[\w-]+)?)((?:\.[\w-]+)*)>/;

function detectKind(text) {
  if (CONTENT_NOT_FOUND.test(text)) return 'unknown';
  if (/Timed out retrying/.test(text)) return 'timeout';
  if (/AssertionError/.test(text)) return 'assertion';
  return 'unknown';
}

export function extractCypressAnchor(errorText) {
  const text = String(errorText ?? '');
  const kind = detectKind(text);

  if (CONTENT_NOT_FOUND.test(text)) {
    // cy.contains(...) - text content, not a resolvable selector. Abstain
    // rather than guess (see header comment, case 3).
    return { selector: null, kind };
  }

  const found = text.match(ELEMENT_NOT_FOUND);
  if (found) return { selector: found[1], kind };

  const chai = text.match(CHAI_ELEMENT);
  if (chai) {
    const [, tag, id, classes] = chai;
    return { selector: `${tag}${id}${classes}`, kind };
  }

  return { selector: null, kind };
}

// Reads the Mocha JSON reporter file produced by
// `cypress run --reporter json > results.json` (Cypress writes this reporter
// to stdout; redirect it to a file yourself, `--reporter-options
// output=<file>` is not honored by Cypress's bundled json reporter).
export async function failedTestsFromCypressJson(path) {
  const failures = await readMochaFailures(path);
  return failures.map((f) => ({ ...f, anchor: extractCypressAnchor(f.message) }));
}
