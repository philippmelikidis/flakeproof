import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBlindspotsMarkdown, renderBlindspotsHtml } from '../src/blindspots/report.js';

const scored = {
  abstained: null,
  reason: null,
  control: { failures: [] },
  wrapperInstalled: true,
  counts: { attempted: 3, applied: 2, notApplied: 1, noticed: 1, unnoticed: 1, inconclusive: 0 },
  records: [
    { id: 'change-text', description: 'Replace the visible text of the target', target: '#header-title', applied: true, noticed: true, redTests: ['header.spec.js > shows the title'] },
    { id: 'change-href', description: 'Point the target link somewhere else', target: '#cta', applied: true, noticed: false, redTests: [] },
    { id: 'remove-element', description: 'Remove the target entirely', target: '#missing', applied: false, noticed: false, redTests: [] },
  ],
};

test('renderBlindspotsMarkdown states the score against the applied denominator, not attempted', () => {
  const md = renderBlindspotsMarkdown(scored);
  assert.ok(md.includes('The suite notices 1 of 2 changes it was actually tested against.'));
  assert.ok(md.includes('3 mutations attempted: 2 applied, 1 not applied.'));
});

test('renderBlindspotsMarkdown separates unnoticed, noticed and not-applied into their own sections', () => {
  const md = renderBlindspotsMarkdown(scored);
  assert.ok(md.includes('## Unnoticed'));
  assert.ok(md.includes('`#cta`: Point the target link somewhere else'));
  assert.ok(md.includes('## Noticed'));
  assert.ok(md.includes('#header-title'));
  assert.ok(md.includes('shows the title'));
  assert.ok(md.includes('## Not applied'));
  assert.ok(md.includes('#missing'));
  assert.ok(md.includes('excluded from the score'));
});

test('renderBlindspotsMarkdown explains a control-red abstention in plain language', () => {
  const md = renderBlindspotsMarkdown({ abstained: 'control-red', reason: 'x', records: [], counts: null });
  assert.ok(md.includes('flakeproof cannot compute a score'));
  assert.ok(md.includes('already red before any mutation'));
});

test('renderBlindspotsMarkdown explains a missing-wrapper abstention with the install snippet', () => {
  const md = renderBlindspotsMarkdown({ abstained: 'wrapper-not-installed', reason: 'x', records: [], counts: null });
  assert.ok(md.includes('withTemporal'));
  assert.ok(md.includes('flakeproof/inject'));
});

test('renderBlindspotsMarkdown lists attempted mutations even when abstaining, if any ran', () => {
  const md = renderBlindspotsMarkdown({
    abstained: 'wrapper-not-installed',
    reason: 'x',
    records: [{ id: 'change-text', description: 'Replace the visible text of the target', target: '#cta', applied: true, noticed: null, redTests: [] }],
    counts: null,
  });
  assert.ok(md.includes('What was attempted before abstaining'));
  assert.ok(md.includes('#cta'));
});

test('renderBlindspotsHtml is a self-contained document with no script tags', () => {
  const html = renderBlindspotsHtml(scored);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!/<script/i.test(html));
  assert.ok(html.includes('The suite notices 1 of 2 changes'));
  assert.ok(html.includes('#header-title'));
  assert.ok(html.includes('#cta'));
  assert.ok(html.includes('#missing'));
});

test('renderBlindspotsHtml on an abstained result shows the reason, not a score', () => {
  const html = renderBlindspotsHtml({ abstained: 'no-mutations-applied', reason: 'x', records: [], counts: null });
  assert.ok(html.includes('No score'));
  assert.ok(html.includes('None of the attempted mutations'));
});
