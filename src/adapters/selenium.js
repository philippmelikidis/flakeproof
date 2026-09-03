// Selenium 4 adapter: anchor extraction from selenium-webdriver's own error
// format, and a reader for the Mocha JSON reporter a Mocha + selenium-webdriver
// suite produces (see src/adapters/shared/mocha-json.js for why Mocha), in
// the same `{ testId, message, anchor }` shape the other readers return.
//
// Selenium locates elements through `By` strategies, not one universal
// selector grammar: `By.css(...)` is directly css, but `By.xpath(...)`,
// `By.linkText(...)` and `By.partialLinkText(...)` name something flakeproof's
// css-based DOM matcher cannot resolve at all - an XPath expression needs an
// XPath engine, and "link text" needs text matching, neither of which is what
// `document.querySelectorAll` does. Two real error shapes were captured
// against this repo's fixture page with a real ChromeDriver session (see
// test/fixtures/errors/sel-*.txt and this cycle's report for the exact
// capture command):
//
//   1. An explicit wait that timed out:
//      "Waiting for element to be located By(css selector, #foo)
//       Wait timed out after 1656ms"
//   2. An immediate `findElement` failure:
//      'no such element: Unable to locate element:
//       {"method":"css selector","selector":"#foo"}
//       (Session info: chrome=...)'
//
// Only `By` strategies with an unambiguous, mechanical css equivalent are
// translated (css selector as-is, id, name, tag name, class name). Every
// other strategy - xpath, link text, partial link text - abstains: the
// method name is reported honestly in the `kind` is not enough context to
// invent one, so `selector` stays null.
import { readMochaFailures } from './shared/mocha-json.js';

const RESOLVABLE_BY = {
  'css selector': (v) => v,
  id: (v) => `#${v}`,
  name: (v) => `[name="${v}"]`,
  'tag name': (v) => v,
  'class name': (v) => `.${v}`,
};

const WAIT_LOCATED = /Waiting for element to be located By\(([^,]+),\s*([\s\S]*?)\)\s*(?:\n|$)/;
const NO_SUCH_ELEMENT_JSON = /\{"method":"[^"]+","selector":"(?:[^"\\]|\\.)*"\}/;

function detectKind(text) {
  // An immediate NoSuchElementError is not a timeout - it fired without ever
  // waiting, so calling it "timeout" would misrepresent what actually
  // happened. Checked first because a message can carry both a
  // "TimeoutError" wrapper class name and unrelated text; "no such element"
  // is the more specific signal when both could match.
  if (/NoSuchElementError|no such element/.test(text)) return 'not-found';
  if (/TimeoutError|Wait timed out/.test(text)) return 'timeout';
  return 'unknown';
}

function translate(method, value) {
  const fn = RESOLVABLE_BY[method.trim()];
  return fn ? fn(value) : null;
}

export function extractSeleniumAnchor(errorText) {
  const text = String(errorText ?? '');
  const kind = detectKind(text);

  const waited = text.match(WAIT_LOCATED);
  if (waited) {
    return { selector: translate(waited[1], waited[2].trim()), kind };
  }

  const notFound = text.match(NO_SUCH_ELEMENT_JSON);
  if (notFound) {
    try {
      const parsed = JSON.parse(notFound[0]);
      return { selector: translate(parsed.method, parsed.selector), kind };
    } catch {
      return { selector: null, kind };
    }
  }

  // Some `until` conditions (for example `until.elementTextIs`) operate on an
  // already-resolved WebElement and never mention a locator in their timeout
  // message at all. Nothing to extract - abstain rather than guess.
  return { selector: null, kind };
}

// Reads the Mocha JSON reporter file produced by
// `mocha --reporter json <spec> > results.json` for a suite built on
// selenium-webdriver.
export async function failedTestsFromSeleniumJson(path) {
  const failures = await readMochaFailures(path);
  return failures.map((f) => ({ ...f, anchor: extractSeleniumAnchor(f.message) }));
}
