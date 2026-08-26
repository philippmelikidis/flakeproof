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
