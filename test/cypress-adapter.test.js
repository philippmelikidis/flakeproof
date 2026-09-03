import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { extractCypressAnchor, failedTestsFromCypressJson } from '../src/adapters/cypress.js';

async function fixture(name) {
  return readFile(new URL(`./fixtures/errors/${name}.txt`, import.meta.url), 'utf8');
}

const RESULTS = fileURLToPath(new URL('./fixtures/runner/cypress-results.json', import.meta.url));

test('element-not-found: selector and kind, real cypress capture', async () => {
  const a = extractCypressAnchor(await fixture('cy-element-not-found'));
  assert.equal(a.selector, '#does-not-exist');
  assert.equal(a.kind, 'timeout');
});

test('chai element description is translated to css, not the original locator', async () => {
  const a = extractCypressAnchor(await fixture('cy-assertion-element'));
  assert.equal(a.selector, 'a#cta.btn.btn-primary');
  assert.equal(a.kind, 'timeout');
});

// Mutation check: cy.contains(...) names text content, not a selector.
// flakeproof must abstain here rather than invent a selector for text it
// cannot express as css.
test('content-not-found: abstains instead of guessing a selector', async () => {
  const a = extractCypressAnchor(await fixture('cy-content-not-found'));
  assert.equal(a.selector, null);
});

test('empty input abstains', () => {
  const a = extractCypressAnchor('');
  assert.equal(a.selector, null);
});

test('reads the failed cypress tests from a real cypress run --reporter json capture', async () => {
  const failures = await failedTestsFromCypressJson(RESULTS);
  assert.equal(failures.length, 3);
  const byTitle = Object.fromEntries(failures.map((f) => [f.testId, f]));
  const elementNotFound = failures.find((f) => f.anchor.selector === '#does-not-exist');
  assert.ok(elementNotFound, 'one failure should resolve the #does-not-exist anchor');
  assert.equal(elementNotFound.anchor.kind, 'timeout');
  const contentNotFound = Object.values(byTitle).find((f) => /nonexistent-copy-xyz/.test(f.message));
  assert.ok(contentNotFound, 'the content-based failure should be present');
  assert.equal(contentNotFound.anchor.selector, null, 'cy.contains failures must abstain, never guess');
});
