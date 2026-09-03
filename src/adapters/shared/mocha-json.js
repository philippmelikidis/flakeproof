// Shared reader for the Mocha JSON reporter shape, used by both the Cypress
// and the Selenium adapters.
//
// This is not a guess at a shared format: Cypress bundles Mocha internally
// and `cypress run --reporter json` emits Mocha's own bundled JSON reporter
// output verbatim (verified by an actual `cypress run --reporter json`
// against this repo's fixture page - see test/fixtures/runner/cypress-results.json,
// captured with the command recorded in its adjacent README note). Plain
// `selenium-webdriver` has no reporter of its own - it is a WebDriver client
// library, not a test framework - so a suite built on it needs a runner, and
// Mocha is the most common, framework-neutral pairing for that (as opposed to
// assuming WebdriverIO, which wraps Selenium in its own runner and its own
// JSON shape). `mocha --reporter json` produces the exact same top-level
// shape (verified the same way - see test/fixtures/runner/selenium-results.json).
// One reader, two callers, each supplying its own framework-specific anchor
// extractor for `err.message`.
import { readFile } from 'node:fs/promises';

export async function readMochaFailures(path) {
  const doc = JSON.parse(await readFile(path, 'utf8'));
  const out = [];
  for (const t of doc.tests ?? []) {
    if (t.err && typeof t.err.message === 'string' && t.err.message !== '') {
      out.push({ testId: t.fullTitle ?? t.title, message: t.err.message });
    }
  }
  return out;
}
