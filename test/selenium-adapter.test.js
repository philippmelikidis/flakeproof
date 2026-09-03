import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { extractSeleniumAnchor, failedTestsFromSeleniumJson } from '../src/adapters/selenium.js';

async function fixture(name) {
  return readFile(new URL(`./fixtures/errors/${name}.txt`, import.meta.url), 'utf8');
}

const RESULTS = fileURLToPath(new URL('./fixtures/runner/selenium-results.json', import.meta.url));

test('By.css wait timeout: translated straight through, real chromedriver capture', async () => {
  const a = extractSeleniumAnchor(await fixture('sel-wait-css-timeout'));
  assert.equal(a.selector, '#does-not-exist');
  assert.equal(a.kind, 'timeout');
});

test('By.css NoSuchElementError: translated, kind is not-found (never "timeout")', async () => {
  const a = extractSeleniumAnchor(await fixture('sel-nosuchelement-css'));
  assert.equal(a.selector, '#also-missing');
  assert.equal(a.kind, 'not-found');
});

// Mutation check: By.xpath has no css equivalent flakeproof's DOM matcher can
// resolve. flakeproof must abstain here instead of passing the raw xpath
// string through as if it were css.
test('By.xpath: abstains instead of treating the xpath string as css', async () => {
  const a = extractSeleniumAnchor(await fixture('sel-wait-xpath-timeout'));
  assert.equal(a.selector, null);
  assert.equal(a.kind, 'timeout');
});

// Mutation check (second locator strategy that cannot be resolved): By.linkText
// is a text-matching strategy, not a css selector.
test('By.linkText: abstains instead of treating link text as css', async () => {
  const a = extractSeleniumAnchor(await fixture('sel-nosuchelement-linktext'));
  assert.equal(a.selector, null);
  assert.equal(a.kind, 'not-found');
});

test('empty input abstains', () => {
  const a = extractSeleniumAnchor('');
  assert.equal(a.selector, null);
});

test('reads the failed selenium tests from a real mocha --reporter json capture', async () => {
  const failures = await failedTestsFromSeleniumJson(RESULTS);
  assert.equal(failures.length, 2);
  const timeout = failures.find((f) => f.anchor.kind === 'timeout');
  assert.equal(timeout.anchor.selector, '#does-not-exist');
  const notFound = failures.find((f) => f.anchor.kind === 'not-found');
  assert.equal(notFound.anchor.selector, '#also-missing');
});
