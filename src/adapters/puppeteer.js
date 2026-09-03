// Puppeteer adapter: anchor extraction from Puppeteer's own error format,
// and a reader for the Jest JSON reporter (`jest --json --outputFile=...`),
// in the same `{ testId, message, anchor }` shape the other readers return.
//
// Puppeteer, like selenium-webdriver, is a browser automation library with no
// reporter of its own; Jest (directly, or via the jest-puppeteer preset) is
// by far the most common way real suites drive it, so that is the format
// this reader parses - not a guess, Jest's own `--json` output shape (see
// test/fixtures/errors/pptr-*.txt and test/fixtures/runner/puppeteer-results.json,
// captured with the command in this cycle's report).
//
// Three real failure shapes were captured against this repo's fixture page
// with an actual headless Chromium session:
//
//   1. `page.waitForSelector('#foo')` timing out:
//      "TimeoutError: Waiting for selector `#foo` failed"
//   2. `page.click('#foo')` (or similar) failing immediately because the
//      element never existed: "Error: No element found for selector: #foo"
//   3. A selector built from a non-css query handler - `::-p-xpath(...)`,
//      `::-p-text(...)`, `pierce/...` - compiles to Puppeteer's internal
//      combinator representation, which prints as a bracketed pseudo-JSON
//      array (`[[[{"name":"xpath","value":"..."}]]]`), never as the
//      original expression. That is not css, and it is not the xpath text
//      the test wrote either - reconstructing either from it would be a
//      guess, so this abstains. The Locator API (`page.locator(...)`)
//      abstains for a related reason: its timeout message ("Timed out after
//      waiting Nms") names no selector at all.
import { readFile } from 'node:fs/promises';

const WAIT_FAILED = /Waiting for selector `([^`]+)` failed/;
const NOT_FOUND = /No element found for selector:\s*(.+?)\s*$/m;

function detectKind(text) {
  if (/No element found for selector/.test(text)) return 'not-found';
  if (/TimeoutError|Timed out/.test(text)) return 'timeout';
  return 'unknown';
}

export function extractPuppeteerAnchor(errorText) {
  const text = String(errorText ?? '');
  const kind = detectKind(text);

  const waited = text.match(WAIT_FAILED);
  if (waited) {
    const raw = waited[1];
    if (raw.startsWith('[[[')) {
      // Compiled from a non-css query handler (::-p-xpath, ::-p-text, ...) -
      // see header comment, case 3. Abstain rather than guess at the
      // original expression.
      return { selector: null, kind };
    }
    return { selector: raw, kind };
  }

  const notFound = text.match(NOT_FOUND);
  if (notFound) return { selector: notFound[1], kind };

  return { selector: null, kind };
}

// Reads the Jest JSON reporter file produced by
// `jest --json --outputFile=results.json` for a suite built on Puppeteer.
export async function failedTestsFromPuppeteerJson(path) {
  const doc = JSON.parse(await readFile(path, 'utf8'));
  const out = [];
  for (const suite of doc.testResults ?? []) {
    for (const t of suite.assertionResults ?? []) {
      if (t.status !== 'failed') continue;
      const message = (t.failureMessages ?? [])[0];
      if (typeof message !== 'string' || message === '') continue;
      out.push({ testId: t.fullName ?? t.title, message });
    }
  }
  return out.map((f) => ({ ...f, anchor: extractPuppeteerAnchor(f.message) }));
}
