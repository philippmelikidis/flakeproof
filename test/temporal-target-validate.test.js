// isValidCssTarget is kept in its own test file (rather than folded into
// temporal-target.test.js) because it needs a real browser: it is the
// round-trip backstop described in the temporal-target design comment, and
// it deliberately stays a separate, async, browser-backed check so the pure
// derivation tests in temporal-target.test.js can stay fast and
// dependency-free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { temporalTargetFor, isValidCssTarget } from '../src/triage/temporal-target.js';

test('isValidCssTarget accepts a syntactically valid selector', async () => {
  const browser = await chromium.launch();
  try {
    assert.equal(await isValidCssTarget(browser, '#cta'), true);
    assert.equal(await isValidCssTarget(browser, '[data-x=">>"]'), true);
    assert.equal(await isValidCssTarget(browser, 'li.css-1a2b3c > a'), true);
  } finally {
    await browser.close();
  }
});

test('isValidCssTarget rejects a target the string surgery could not anticipate', async () => {
  const browser = await chromium.launch();
  try {
    // temporalTargetFor happily returns this (it has a narrowing "[" token,
    // no chain/comma/pseudo issues, and the string surgery has no concept of
    // css identifier grammar), but an attribute name may not start with a
    // digit - a real browser rejects it outright. Exactly the gap the round
    // trip exists to catch.
    const target = temporalTargetFor('[123abc]');
    assert.equal(target, '[123abc]', 'sanity: the derivation does not itself reject this string');
    assert.equal(await isValidCssTarget(browser, target), false);
  } finally {
    await browser.close();
  }
});
