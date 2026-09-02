import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temporalTargetFor } from '../src/triage/temporal-target.js';

test('plain css selectors pass through unchanged', () => {
  assert.equal(temporalTargetFor('#cta'), '#cta');
  assert.equal(temporalTargetFor('li.css-1a2b3c > a'), 'li.css-1a2b3c > a');
  assert.equal(temporalTargetFor('[data-testid="cta-button"]'), '[data-testid="cta-button"]');
  assert.equal(temporalTargetFor('#main-nav li:nth-child(1)'), '#main-nav li:nth-child(1)');
});

test('a css base is derived from chained and suffixed anchors', () => {
  assert.equal(temporalTargetFor('#a >> text=Save'), '#a');
  assert.equal(temporalTargetFor('#a >> nth=0'), '#a');
  assert.equal(temporalTargetFor('.card:has-text("Save")'), '.card');
  assert.equal(temporalTargetFor('a.btn:visible'), 'a.btn');
});

test('anchors without a specific css base are refused', () => {
  assert.equal(temporalTargetFor('text=Save'), null, 'engine-only anchor');
  assert.equal(temporalTargetFor('role=link[name="Save"]'), null);
  assert.equal(temporalTargetFor('a:visible'), null, 'bare tag after stripping');
  assert.equal(temporalTargetFor('div:near(#a)'), null, 'bare tag after stripping');
  assert.equal(temporalTargetFor('//div[@id="x"]'), null, 'bare xpath');
  assert.equal(temporalTargetFor('a:hover'), null, 'unknown pseudo syntax');
});

test('a comma selector list is refused, not narrowed to one branch', () => {
  assert.equal(temporalTargetFor('#a, div'), null, 'narrowest branch would hide the broader list');
  assert.equal(temporalTargetFor('.x, body'), null, 'style would hide the whole page via the body branch');
});

// Known holes fixed by this module: a `>>`, `:`, or `,` that lives inside a
// quoted attribute value is data, not chain/pseudo/list syntax, and must
// never be treated as one. The old raw-string surgery did not know the
// difference and produced a mangled (sometimes silently invalid) selector.
test('an attribute value containing ">>" is handled correctly, not mangled into an invalid rule', () => {
  assert.equal(
    temporalTargetFor('[data-x=">>"]'),
    '[data-x=">>"]',
    'the >> lives inside the quoted value, not at a chain boundary',
  );
});

test('an attribute value containing a colon is handled correctly, not stripped as pseudo syntax', () => {
  assert.equal(temporalTargetFor('[data-x="a:b"]'), '[data-x="a:b"]');
  // A real trailing :visible must still be stripped, while the colon inside
  // the quoted value must survive untouched - proving the two are told apart.
  assert.equal(temporalTargetFor('[data-x="a:visible"]:visible'), '[data-x="a:visible"]');
});

test('a quoted value containing a comma is not mistaken for a selector list', () => {
  assert.equal(temporalTargetFor('[data-x="a,b"]'), '[data-x="a,b"]');
});

test('a quoted has-text argument containing ">>" does not get treated as a chain separator', () => {
  assert.equal(temporalTargetFor('.card:has-text(">>")'), '.card');
});

// Fix 7 (review): segmentByQuotes's regex silently drops an unmatched quote
// character (it fits neither the quoted-span nor the unquoted-run
// alternative), and joinSegments reassembled the rest into a DIFFERENT,
// still-valid selector - `[data-x="a]` became `[data-x=a]`, which the round
// trip in isValidCssTarget cannot catch because that string really is valid
// css, just not the css the user's failing test refers to. Detecting the
// drop and abstaining is the fix; these pin the exact reproductions from the
// review rather than a generic "some unbalanced input is refused" claim.
test('an unmatched quote is refused, not silently rewritten into a different selector', () => {
  assert.equal(temporalTargetFor('[data-x="a]'), null, 'must not become [data-x=a]');
  assert.equal(temporalTargetFor('.a[b="c]'), null, 'must not become .a[b=c]');
  assert.equal(
    temporalTargetFor('[data-x="a"][data-y="b]'),
    null,
    'must not become [data-x="a"][data-y=b]; the first pair is balanced, the second is not',
  );
});

test('balanced quoting elsewhere in the selector still passes even when checked for imbalance', () => {
  // Sanity check that the new guard does not over-fire: a fully balanced
  // selector must still derive normally.
  assert.equal(temporalTargetFor('[data-x="a"]'), '[data-x="a"]');
});
