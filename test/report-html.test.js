import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHtmlReport } from '../src/report-html.js';

const fragile = {
  verdict: 'fragile',
  testId: 'Menu Test',
  anchor: { selector: 'li.css-1a2b3c', kind: 'timeout' },
  rerun: null,
  temporal: null,
  classification: {
    verdict: 'cosmetic',
    reasons: ['selector relies on build-generated class ".css-1a2b3c" which is gone from the element'],
  },
  recommendation: [
    { selector: '#main-nav li:has-text("Products")', kind: 'container-text', uniqueInCurrent: true, survived: 5, applied: 5 },
    { selector: '#main-nav li:nth-child(1)', kind: 'positional', uniqueInCurrent: true, survived: 4, applied: 5 },
  ],
  notes: ['test failed on every rerun; deterministic failure'],
  detail: {
    anchorBefore: { tag: 'li', id: null, classes: ['css-1a2b3c'], text: '', attrs: {}, html: '<li class="css-1a2b3c"><a href="/products/">Products</a></li>' },
    anchorAfter: { tag: 'li', id: null, classes: ['css-q1w2e3'], text: '', attrs: {}, html: '<li class="css-q1w2e3"><a href="/products/">Products</a></li>' },
    steps: [
      { label: 'Anchor read from the error message', outcome: 'li.css-1a2b3c', ok: true },
      { label: 'Proved candidates in a real browser', outcome: '2 candidates tested', ok: true },
    ],
  },
};

test('the report is a self-contained html document', () => {
  const html = renderHtmlReport(fragile);
  assert.ok(html.startsWith('<!doctype html>'), 'must be a full document');
  assert.ok(html.includes('<style>'), 'css must be inline');
  assert.ok(!/<script/i.test(html), 'no scripts allowed');
  assert.ok(!/\s(?:src|href)\s*=\s*["']?https?:/i.test(html), 'no external resource may be loaded');
  assert.ok(!/@import/i.test(html), 'no css imports allowed');
});

test('the report shows verdict, anchor, evidence and every recommendation', () => {
  const html = renderHtmlReport(fragile);
  assert.ok(html.includes('fragile'));
  assert.ok(html.includes('Menu Test'));
  assert.ok(html.includes('li.css-1a2b3c'));
  assert.ok(html.includes('build-generated class'));
  // both recommendations, not only the first
  assert.ok(html.includes(':has-text(&quot;Products&quot;)') || html.includes(':has-text("Products")'));
  assert.ok(html.includes('nth-child(1)'));
  assert.ok(html.includes('5/5') && html.includes('4/5'));
});

test('the report shows the before and after snippets and the steps', () => {
  const html = renderHtmlReport(fragile);
  assert.ok(html.includes('css-1a2b3c'), 'before snippet');
  assert.ok(html.includes('css-q1w2e3'), 'after snippet');
  assert.ok(html.includes('Anchor read from the error message'));
  assert.ok(html.includes('Proved candidates in a real browser'));
});

test('page content is escaped, never injected as live markup', () => {
  const evil = {
    ...fragile,
    detail: {
      ...fragile.detail,
      anchorBefore: { ...fragile.detail.anchorBefore, html: '<img src=x onerror="alert(1)">' },
    },
  };
  const html = renderHtmlReport(evil);
  assert.ok(!html.includes('<img src=x'), 'raw markup from the page must be escaped');
  assert.ok(html.includes('&lt;img'), 'the snippet is shown as text');
});

test('an absolute href in the page data does not break self-containment', () => {
  const withAbsolute = {
    ...fragile,
    detail: {
      ...fragile.detail,
      anchorBefore: { ...fragile.detail.anchorBefore, attrs: { href: 'https://example.com/pricing' } },
    },
  };
  const html = renderHtmlReport(withAbsolute);
  assert.ok(html.includes('example.com/pricing'), 'the url is shown to the reader as text');
  assert.ok(!/\s(?:src|href)\s*=\s*["']?https?:/i.test(html), 'but never as a loaded resource');
});

test('a verdict without detail still renders every mandatory section', () => {
  const bare = {
    verdict: 'no-anchor',
    testId: null,
    anchor: { selector: null, kind: 'assertion' },
    rerun: null,
    temporal: null,
    classification: null,
    recommendation: null,
    notes: ['no locator found in the error; cannot triage without an anchor'],
    detail: { anchorBefore: null, anchorAfter: null, steps: [{ label: 'Anchor read from the error message', outcome: 'no locator found', ok: false }] },
  };
  const html = renderHtmlReport(bare);
  assert.ok(html.includes('no-anchor'));
  assert.ok(html.includes('cannot triage without an anchor'));
  assert.ok(html.includes('Anchor read from the error message'));
});
