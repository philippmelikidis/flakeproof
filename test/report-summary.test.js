import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSummaryMarkdown, renderSummaryHtml } from '../src/report-summary.js';

const runResult = {
  ran: true,
  exitCode: 1,
  failures: 2,
  notes: [],
  results: [
    {
      testId: 'nav.spec.js > menu shows products',
      triage: {
        verdict: 'fragile', testId: null, anchor: { selector: 'li.css-1a2b3c', kind: 'timeout' },
        rerun: null, temporal: null,
        classification: { verdict: 'cosmetic', reasons: ['selector relies on build-generated class ".css-1a2b3c" which is gone from the element'] },
        recommendation: [{ selector: '#main-nav li:has-text("Products")', kind: 'container-text', uniqueInCurrent: true, survived: 5, applied: 5 }],
        notes: [], detail: { anchorBefore: null, anchorAfter: null, steps: [] },
      },
    },
    {
      testId: 'cta.spec.js > cta is visible',
      triage: {
        verdict: 'real-change', testId: null, anchor: { selector: '#cta', kind: 'timeout' },
        rerun: null, temporal: null,
        classification: { verdict: 'semantic', reasons: ['own text changed: "Contact us" -> "Get a quote"'] },
        recommendation: null, notes: [], detail: { anchorBefore: null, anchorAfter: null, steps: [] },
      },
    },
  ],
};

test('the markdown summary lists every test with its verdict', () => {
  const md = renderSummaryMarkdown(runResult);
  assert.ok(md.includes('nav.spec.js > menu shows products'));
  assert.ok(md.includes('cta.spec.js > cta is visible'));
  assert.ok(md.includes('fragile'));
  assert.ok(md.includes('real-change'));
});

test('the html summary counts the verdicts and embeds every report', () => {
  const html = renderSummaryHtml(runResult);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('2 failed tests'), 'the overview names the total');
  assert.ok(html.includes('nav.spec.js'));
  assert.ok(html.includes('cta.spec.js'));
  assert.ok(html.includes('Get a quote'), 'the individual evidence is embedded');
  assert.ok(!/<script/i.test(html), 'still self-contained');
});

test('a green run is reported as such', () => {
  const md = renderSummaryMarkdown({ ran: true, exitCode: 0, failures: 0, results: [], notes: [] });
  assert.ok(/no failed tests/i.test(md), md);
});
