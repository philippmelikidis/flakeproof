import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBlindspotsMarkdown, renderBlindspotsHtml } from '../src/blindspots/report.js';

const scored = {
  abstained: null,
  reason: null,
  control: { failures: [] },
  wrapperInstalled: true,
  counts: { attempted: 3, applied: 2, notApplied: 1, notSurvived: 0, judged: 2, noticed: 1, unnoticed: 1, inconclusive: 0 },
  records: [
    { id: 'change-text', description: 'Replace the visible text of the target', target: '#header-title', applied: true, survived: true, noticed: true, redTests: ['header.spec.js > shows the title'] },
    { id: 'change-href', description: 'Point the target link somewhere else', target: '#cta', applied: true, survived: true, noticed: false, redTests: [] },
    { id: 'remove-element', description: 'Remove the target entirely', target: '#missing', applied: false, applyReason: 'never-found', survived: null, noticed: false, redTests: [] },
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

const withInconclusiveAndReverted = {
  abstained: null,
  reason: null,
  control: { runs: 2, attempts: [] },
  wrapperInstalled: true,
  counts: { attempted: 3, applied: 3, notApplied: 0, notSurvived: 1, judged: 1, noticed: 1, unnoticed: 0, inconclusive: 1 },
  records: [
    { id: 'change-text', description: 'Replace the visible text of the target', target: '#header-title', applied: true, survived: true, noticed: true, redTests: ['a.spec.js > shows it'] },
    { id: 'change-href', description: 'Point the target link somewhere else', target: '#cta', applied: true, survived: false, noticed: null, redTests: [] },
    { id: 'remove-element', description: 'Remove the target entirely', target: '#footer', applied: true, survived: true, noticed: null, inconclusiveReason: 'unstable-across-runs', redTests: [] },
  ],
  skipped: [],
  notes: [],
};

test('renderBlindspotsMarkdown scores against judged, not applied, when some applied mutations are excluded', () => {
  const md = renderBlindspotsMarkdown(withInconclusiveAndReverted);
  assert.ok(md.includes('The suite notices 1 of 1 changes it was actually tested against.'), md);
});

test('renderBlindspotsMarkdown gives inconclusive and reverted mutations their own sections, never "unnoticed"', () => {
  const md = renderBlindspotsMarkdown(withInconclusiveAndReverted);
  assert.ok(md.includes('## Reverted before assertions'));
  assert.ok(md.includes('#cta'));
  assert.ok(md.includes('## Inconclusive'));
  assert.ok(md.includes('#footer'));
  assert.ok(md.includes('disagreed with itself across runs'));
  assert.ok(!md.includes('## Unnoticed'), 'nothing here was actually unnoticed');
});

test('renderBlindspotsHtml shows the inconclusive count, which the old renderer had no branch for at all', () => {
  const html = renderBlindspotsHtml(withInconclusiveAndReverted);
  assert.ok(html.includes('Inconclusive'));
  assert.ok(html.includes('Reverted before assertions'));
  assert.ok(html.includes('could not be judged'));
});

test('renderBlindspotsHtml never shows "(red: ...)" next to a not-applied or inconclusive record', () => {
  const withRedOnNotApplied = {
    abstained: null,
    reason: null,
    counts: { attempted: 1, applied: 0, notApplied: 1, notSurvived: 0, judged: 0, noticed: 0, unnoticed: 0, inconclusive: 0 },
    records: [
      { id: 'change-text', description: 'Replace the visible text of the target', target: '#missing', applied: false, applyReason: 'never-found', survived: null, noticed: false, redTests: ['unrelated.spec.js > flaked'] },
    ],
    skipped: [],
    notes: [],
  };
  const html = renderBlindspotsHtml(withRedOnNotApplied);
  assert.ok(!html.includes('unrelated.spec.js'), 'a not-applied mutation must never be shown as having caused a red test');
});

test('renderBlindspotsMarkdown distinguishes "never found" from "found but not applicable" for not-applied mutations', () => {
  const result = {
    abstained: null,
    reason: null,
    counts: { attempted: 2, applied: 0, notApplied: 2, notSurvived: 0, judged: 0, noticed: 0, unnoticed: 0, inconclusive: 0 },
    records: [
      { id: 'change-text', description: 'Replace the visible text of the target', target: '#missing', applied: false, applyReason: 'never-found', survived: null, noticed: false, redTests: [] },
      { id: 'change-href', description: 'Point the target link somewhere else', target: '#no-href', applied: false, applyReason: 'found-not-applicable', survived: null, noticed: false, redTests: [] },
    ],
    skipped: [],
    notes: [],
  };
  const md = renderBlindspotsMarkdown(result);
  assert.match(md, /#missing.*no element matched this selector/);
  assert.match(md, /#no-href.*could not be applied to it/);
});

test('renderBlindspotsMarkdown reports what the run budget skipped instead of looking like full coverage', () => {
  const result = {
    abstained: null,
    reason: null,
    counts: { attempted: 1, applied: 1, notApplied: 0, notSurvived: 0, judged: 1, noticed: 0, unnoticed: 1, inconclusive: 0 },
    records: [
      { id: 'change-text', description: 'Replace the visible text of the target', target: '#cta', applied: true, survived: true, noticed: false, redTests: [] },
    ],
    skipped: [{ target: '#footer', mutation: 'remove-element', description: 'Remove the target entirely' }],
    notes: ['the run budget (1) was reached; 1 of 2 experiment(s) were skipped: #footer / remove-element'],
  };
  const md = renderBlindspotsMarkdown(result);
  assert.ok(md.includes('## Skipped (run budget)'));
  assert.ok(md.includes('#footer'));
  assert.ok(md.includes('not full coverage') || md.includes('run budget'));
});
