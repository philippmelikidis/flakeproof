import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractAnchor } from '../src/triage/anchor.js';

async function fixture(name) {
  return readFile(new URL(`./fixtures/errors/${name}.txt`, import.meta.url), 'utf8');
}

test('waitFor timeout: selector and kind', async () => {
  const a = extractAnchor(await fixture('pw-waitfor-timeout'));
  assert.equal(a.selector, '#does-not-exist');
  assert.equal(a.kind, 'timeout');
});

test('click timeout: selector and kind', async () => {
  const a = extractAnchor(await fixture('pw-click-timeout'));
  assert.equal(a.selector, '#also-missing');
  assert.equal(a.kind, 'timeout');
});

test('strict mode violation: selector and kind', async () => {
  const a = extractAnchor(await fixture('pw-strict-violation'));
  assert.equal(a.selector, '.nav-item');
  assert.equal(a.kind, 'ambiguous');
});

test('@playwright/test expect timeout: selector and kind', async () => {
  const a = extractAnchor(await fixture('pwtest-expect-timeout'));
  assert.equal(a.selector, '#does-not-exist');
  assert.equal(a.kind, 'timeout');
});

test('selector containing quotes survives extraction', () => {
  const text = `TimeoutError: locator.waitFor: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('ul#menu-main-navigation > li > a:text-is("Leistungen")') to be visible`;
  const a = extractAnchor(text);
  assert.equal(a.selector, 'ul#menu-main-navigation > li > a:text-is("Leistungen")');
  assert.equal(a.kind, 'timeout');
});

test('no locator present: assertion failure', () => {
  const a = extractAnchor('AssertionError: Should Be Equal failed: A != B');
  assert.equal(a.selector, null);
  assert.equal(a.kind, 'assertion');
});

test('empty input', () => {
  assert.deepEqual(extractAnchor(''), { selector: null, kind: 'unknown' });
});

test('chained locator line yields no selector instead of a spliced one', () => {
  const a = extractAnchor("Error: locator.click: Timeout 1500ms exceeded.\nCall log:\n  - waiting for locator('#a').locator('b')");
  assert.equal(a.selector, null);
  assert.equal(a.kind, 'timeout');
});
