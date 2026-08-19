import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/report.js';

test('renderReport keeps unproven candidates visible instead of hiding them behind the no-safe-recommendation line', () => {
  const md = renderReport({
    verdict: 'fragile',
    testId: 'Some Test',
    anchor: { selector: '#cta', kind: 'id' },
    rerun: null,
    classification: { reasons: [] },
    recommendation: [{ selector: '#cta', kind: 'id', survived: null, applied: null, uniqueInCurrent: null }],
    notes: [],
  });
  assert.match(md, /## Recommended selectors/);
  assert.match(md, /\| `#cta` \| id \| unknown \| not proven \(no current URL\) \|/);
  assert.doesNotMatch(md, /No candidate survived proving/);
});

test('renderReport still reports no safe recommendation when proving genuinely ran and nothing survived', () => {
  const md = renderReport({
    verdict: 'fragile',
    testId: 'Some Test',
    anchor: { selector: '#cta', kind: 'id' },
    rerun: null,
    classification: { reasons: [] },
    recommendation: [{ selector: '#cta', kind: 'id', survived: 0, applied: 2, uniqueInCurrent: false }],
    notes: [],
  });
  assert.match(md, /No candidate survived proving; no safe recommendation\./);
  assert.doesNotMatch(md, /## Recommended selectors/);
});
