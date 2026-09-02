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

// Fix 3 (review, CRITICAL): the previous oracle used `document.querySelector`,
// which is MORE PERMISSIVE than the css stylesheet parser temporalScript
// actually relies on. Every selector below was verified against a real
// browser to be accepted by `querySelector` (so the old oracle said
// "valid") while installing it as an actual `<style>` rule produces ZERO
// rules - the delay style is a silent no-op, but the old oracle waved it
// through. The fix installs the real rule and checks `cssRules.length`,
// which is the only oracle that matches what the probe actually does.
test('isValidCssTarget rejects every selector the stylesheet parser actually drops', async () => {
  const browser = await chromium.launch();
  try {
    const rejected = ['[data-x', '[data-x="a"', '.a[b="c', '[foo=bar', '#a[href^="/x"'];
    for (const selector of rejected) {
      assert.equal(
        await isValidCssTarget(browser, selector),
        false,
        `expected "${selector}" to be rejected: the stylesheet parser installs 0 rules for it`,
      );
    }
  } finally {
    await browser.close();
  }
});

test('isValidCssTarget still accepts a target that installs as exactly one real rule', async () => {
  const browser = await chromium.launch();
  try {
    assert.equal(await isValidCssTarget(browser, '#cta'), true);
    assert.equal(await isValidCssTarget(browser, '[data-x=">>"]'), true);
  } finally {
    await browser.close();
  }
});
