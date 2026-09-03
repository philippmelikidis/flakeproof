import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { extractPuppeteerAnchor, failedTestsFromPuppeteerJson } from '../src/adapters/puppeteer.js';

async function fixture(name) {
  return readFile(new URL(`./fixtures/errors/${name}.txt`, import.meta.url), 'utf8');
}

const RESULTS = fileURLToPath(new URL('./fixtures/runner/puppeteer-results.json', import.meta.url));

test('waitForSelector timeout: selector and kind, real puppeteer capture', async () => {
  const a = extractPuppeteerAnchor(await fixture('pptr-waitforselector-timeout'));
  assert.equal(a.selector, '#does-not-exist');
  assert.equal(a.kind, 'timeout');
});

test('click on a missing element: kind is not-found, never "timeout"', async () => {
  const a = extractPuppeteerAnchor(await fixture('pptr-click-not-found'));
  assert.equal(a.selector, '#also-missing');
  assert.equal(a.kind, 'not-found');
});

// Mutation check: a selector built from a non-css query handler (::-p-xpath)
// compiles to Puppeteer's internal bracketed combinator representation.
// flakeproof must abstain rather than treat that string as a css selector or
// try to recover the original xpath from it.
test('compiled xpath combinator: abstains instead of guessing', async () => {
  const a = extractPuppeteerAnchor(await fixture('pptr-xpath-timeout'));
  assert.equal(a.selector, null);
  assert.equal(a.kind, 'timeout');
});

// Mutation check (second case): the Locator API's timeout message names no
// selector at all.
test('locator API timeout: abstains, message carries no selector', async () => {
  const a = extractPuppeteerAnchor(await fixture('pptr-locator-timeout'));
  assert.equal(a.selector, null);
  assert.equal(a.kind, 'timeout');
});

test('empty input abstains', () => {
  const a = extractPuppeteerAnchor('');
  assert.equal(a.selector, null);
});

test('reads the failed puppeteer tests from a real jest --json capture', async () => {
  const failures = await failedTestsFromPuppeteerJson(RESULTS);
  assert.equal(failures.length, 2);
  const timeout = failures.find((f) => f.anchor.kind === 'timeout');
  assert.equal(timeout.anchor.selector, '#does-not-exist');
  const notFound = failures.find((f) => f.anchor.kind === 'not-found');
  assert.equal(notFound.anchor.selector, '#also-missing');
});
