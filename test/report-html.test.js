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

test('a candidate that failed proving renders "proving failed", not "no current url"', () => {
  const failedProof = {
    ...fragile,
    recommendation: [
      { selector: '#cta', kind: 'id', uniqueInCurrent: null, survived: null, applied: null, unproven: 'failed' },
    ],
  };
  const html = renderHtmlReport(failedProof);
  assert.ok(html.includes('proving failed'), 'must name the real cause');
  assert.ok(!html.includes('no current url was given'), 'must not claim the wrong cause');
});

test('a before snippet with no html field explains itself instead of marking everything as changed', () => {
  const noHtml = {
    ...fragile,
    detail: {
      ...fragile.detail,
      anchorBefore: { tag: 'li', id: null, classes: ['css-1a2b3c'], text: '', attrs: {} },
    },
  };
  const html = renderHtmlReport(noHtml);
  assert.ok(html.includes('No html snippet in this snapshot'), 'must explain why there is nothing to diff');
  assert.ok(!html.includes('<mark>'), 'without a baseline snippet there is nothing to mark as changed');
});

test('a no-anchor result never claims a nonexistent element does not exist', () => {
  const noAnchor = {
    verdict: 'no-anchor',
    testId: null,
    anchor: { selector: null, kind: 'assertion' },
    rerun: null,
    temporal: null,
    classification: null,
    recommendation: null,
    notes: ['no locator found in the error; cannot triage without an anchor'],
    detail: { anchorBefore: null, anchorAfter: null, steps: [] },
  };
  const html = renderHtmlReport(noAnchor);
  assert.ok(!html.includes('does not exist'), 'flakeproof never looked, so it cannot claim nonexistence');
  assert.ok(html.includes('did not look'), 'must say flakeproof did not look, not that the element is absent');
});

test('proof outcomes render as mutation names with yes or no', () => {
  const withOutcomes = {
    ...fragile,
    recommendation: [
      {
        selector: '#main-nav li:has-text("Products")',
        kind: 'container-text',
        uniqueInCurrent: true,
        survived: 4,
        applied: 5,
        outcomes: [
          { id: 'wrap-element', survived: true },
          { id: 'add-class', survived: true },
          { id: 'rename-hashed-class', survived: true },
          { id: 'add-framework-attr', survived: true },
          { id: 'move-to-end', survived: false },
        ],
      },
    ],
  };
  const html = renderHtmlReport(withOutcomes);
  assert.ok(html.includes('wrap-element yes'));
  assert.ok(html.includes('add-class yes'));
  assert.ok(html.includes('rename-hashed-class yes'));
  assert.ok(html.includes('add-framework-attr yes'));
  assert.ok(html.includes('move-to-end no'));
});

// Extracts the inner content of every <mark ...>...</mark> in the given
// html, regardless of which diff class it carries.
function markContents(html) {
  return [...html.matchAll(/<mark[^>]*>(.*?)<\/mark>/gs)].map((m) => m[1]);
}

test('a minified attribute change marks only the changed value, not the whole element', () => {
  const minified = {
    ...fragile,
    detail: {
      ...fragile.detail,
      anchorBefore: { tag: 'li', id: null, classes: [], text: '', attrs: {}, html: '<li class="a"><span>Products</span></li>' },
      anchorAfter: { tag: 'li', id: null, classes: [], text: '', attrs: {}, html: '<li class="b"><span>Products</span></li>' },
    },
  };
  const html = renderHtmlReport(minified);
  const marks = markContents(html);
  assert.ok(marks.length > 0, 'the changed attribute value must be marked');
  for (const m of marks) {
    assert.ok(!m.includes('&lt;span&gt;') && !m.includes('<span>'), `mark must be tight, got: ${m}`);
  }
});

test('a word removed between before and after is marked in the before card', () => {
  const html = renderHtmlReport({
    ...fragile,
    detail: {
      ...fragile.detail,
      anchorBefore: { tag: 'p', id: null, classes: [], text: '', attrs: {}, html: '<p>hello brave world</p>' },
      anchorAfter: { tag: 'p', id: null, classes: [], text: '', attrs: {}, html: '<p>hello world</p>' },
    },
  });
  const beforeSection = html.split('Now, in the current build')[0];
  const marks = [...beforeSection.matchAll(/<mark class="diff-removed">([^<]*)<\/mark>/g)].map((m) => m[1]);
  assert.ok(marks.some((m) => m.includes('brave')), `expected "brave" in a removed mark, got: ${JSON.stringify(marks)}`);
});

test('a word added between before and after is marked in the after card', () => {
  const html = renderHtmlReport({
    ...fragile,
    detail: {
      ...fragile.detail,
      anchorBefore: { tag: 'p', id: null, classes: [], text: '', attrs: {}, html: '<p>hello world</p>' },
      anchorAfter: { tag: 'p', id: null, classes: [], text: '', attrs: {}, html: '<p>hello brave world</p>' },
    },
  });
  const afterSection = html.split('Now, in the current build')[1];
  const marks = [...afterSection.matchAll(/<mark class="diff-added">([^<]*)<\/mark>/g)].map((m) => m[1]);
  assert.ok(marks.some((m) => m.includes('brave')), `expected "brave" in an added mark, got: ${JSON.stringify(marks)}`);
});

test('diffed snippets stay escaped: no executable script tag reaches the output', () => {
  const html = renderHtmlReport({
    ...fragile,
    detail: {
      ...fragile.detail,
      anchorBefore: { tag: 'div', id: null, classes: [], text: '', attrs: {}, html: '<div>safe</div>' },
      anchorAfter: { tag: 'div', id: null, classes: [], text: '', attrs: {}, html: '<div><script>alert(1)</script></div>' },
    },
  });
  assert.ok(!/<script(?!\w)/i.test(html), 'no executable script tag may reach the output');
  assert.ok(html.includes('&lt;script&gt;'), 'the script tag must be shown as escaped text');
});

test('identical before and after produce no marks at all', () => {
  const html = renderHtmlReport({
    ...fragile,
    detail: {
      ...fragile.detail,
      anchorBefore: { tag: 'li', id: null, classes: ['css-1a2b3c'], text: '', attrs: {}, html: '<li class="css-1a2b3c"><a href="/x">Same</a></li>' },
      anchorAfter: { tag: 'li', id: null, classes: ['css-1a2b3c'], text: '', attrs: {}, html: '<li class="css-1a2b3c"><a href="/x">Same</a></li>' },
    },
  });
  assert.ok(!html.includes('<mark'), 'identical snippets must produce no marks');
});

// Undoes esc() exactly: esc() escapes `&` FIRST, then `<`, `>`, `"`, so none
// of the other entities can appear as a substring of `&amp;` and the
// reverse order below is unambiguous.
function unescapeHtml(s) {
  return s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

function stripMarks(s) {
  return s.replace(/<mark[^>]*>/g, '').replace(/<\/mark>/g, '');
}

// The tag tokenizer must be lossless: every character of an html snippet
// lands in exactly one token, so diffing an identical before/after and then
// undoing the rendering (strip <mark> wrappers, unescape entities) must
// reproduce the original snippet character for character. The previous
// tokenizer silently dropped whitespace between attributes and mishandled a
// `>` inside a quoted attribute value, so `<li class="a">` round-tripped as
// `<liclass="a">` - a fidelity regression the round-trip check below
// catches directly instead of only spot-checking specific bugs.
const ROUND_TRIP_SNIPPETS = [
  '<li class="a"><span>Products</span></li>',
  '<div data-note="a > b"><span>x</span></div>',
  '<div class="a" data-x="1"><span>hi &amp; bye</span></div>',
  '<p>line<br>break</p>',
  '<p>line<br/>break</p>',
  '<ul><li class="a">a</li><li class="b">b</li></ul>',
  '<p>hello brave world</p>',
  '<span data-old="a > b" data-more="x">text</span>',
  '<li  class="a"   data-x><span>x</span></li>',
];

test('the tag tokenizer is lossless: an identical before/after round-trips every snippet exactly', () => {
  let reproduced = 0;
  for (const snip of ROUND_TRIP_SNIPPETS) {
    const html = renderHtmlReport({
      ...fragile,
      detail: {
        ...fragile.detail,
        anchorBefore: { tag: 'div', id: null, classes: [], text: '', attrs: {}, html: snip },
        anchorAfter: { tag: 'div', id: null, classes: [], text: '', attrs: {}, html: snip },
      },
    });
    const beforeSection = html.split('Now, in the current build')[0];
    const preMatch = /<pre>([\s\S]*?)<\/pre>/.exec(beforeSection);
    assert.ok(preMatch, `expected a <pre> block for snippet: ${snip}`);
    const reconstructed = unescapeHtml(stripMarks(preMatch[1]));
    assert.equal(reconstructed, snip, `round-trip failed for: ${snip}`);
    if (reconstructed === snip) reproduced += 1;
  }
  assert.equal(reproduced, ROUND_TRIP_SNIPPETS.length, 'every snippet in the set must reproduce exactly');
});

test('an attribute value containing > does not mangle the tag or the attribute name', () => {
  const html = renderHtmlReport({
    ...fragile,
    detail: {
      ...fragile.detail,
      anchorBefore: { tag: 'div', id: null, classes: [], text: '', attrs: {}, html: '<div data-note="a > b"><span>x</span></div>' },
      anchorAfter: { tag: 'div', id: null, classes: [], text: '', attrs: {}, html: '<div data-note="a > b"><span>x</span></div>' },
    },
  });
  assert.ok(html.includes('data-note=&quot;a &gt; b&quot;'), 'the attribute name and value must survive intact');
  assert.ok(!html.includes('&lt;diva&gt;'), 'must not mangle the tag by stopping at the quoted >');
});

test('a real attribute-value change that both contain > is still detected, not silently treated as identical', () => {
  const html = renderHtmlReport({
    ...fragile,
    detail: {
      ...fragile.detail,
      anchorBefore: { tag: 'div', id: null, classes: [], text: '', attrs: {}, html: '<div data-old="a > b"><span>x</span></div>' },
      anchorAfter: { tag: 'div', id: null, classes: [], text: '', attrs: {}, html: '<div data-new="a > b"><span>x</span></div>' },
    },
  });
  assert.ok(html.includes('<mark'), 'a real attribute-name change must be marked, not silently treated as no change');
});

// Fix 3: a node marked htmlUnresolved (the snapshot DOES carry full-page
// html, but src/probe/snippet.js could not walk it to this element) must
// render a message distinct from "no html snippet in this snapshot" - both
// halves of that message are false in this case. This must hold regardless
// of which verdict wraps the detail: renderHtmlReport's snippet-rendering
// does not (and should not) special-case the verdict.
const VERDICTS_WITH_DETAIL = ['fragile', 'real-change', 'nondeterministic', 'unclear'];

for (const verdict of VERDICTS_WITH_DETAIL) {
  test(`an htmlUnresolved anchor reads honestly under a ${verdict} verdict`, () => {
    const result = {
      ...fragile,
      verdict,
      detail: {
        ...fragile.detail,
        anchorBefore: { tag: 'li', id: null, classes: ['css-1a2b3c'], text: '', attrs: {}, htmlUnresolved: true },
      },
    };
    const html = renderHtmlReport(result);
    assert.ok(
      html.includes('The stored page html could not be walked to this element'),
      `expected the honest walk-failure message under verdict ${verdict}`,
    );
    assert.ok(
      !html.includes('No html snippet in this snapshot'),
      `must not fall back to the false "no html" message under verdict ${verdict}`,
    );
  });
}

test('the worst case: after has a real snippet, before is htmlUnresolved - both cards read honestly, no marks, no legend', () => {
  const html = renderHtmlReport({
    ...fragile,
    verdict: 'real-change',
    detail: {
      ...fragile.detail,
      anchorBefore: { tag: 'li', id: null, classes: ['css-1a2b3c'], text: '', attrs: {}, htmlUnresolved: true },
      anchorAfter: { tag: 'li', id: null, classes: ['css-1a2b3c'], text: '', attrs: {}, html: '<li class="css-1a2b3c"><a href="/products/">Products</a></li>' },
    },
  });
  assert.ok(html.includes('The stored page html could not be walked to this element'), 'the before card must read honestly');
  assert.ok(html.includes('Products'), 'the after card must still show its real snippet');
  assert.ok(!html.includes('<mark'), 'without a comparable before snippet there is nothing to mark as changed');
  assert.ok(!html.includes('<p class="diff-legend'), 'no marks means no legend either (the css rule itself is always present)');
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
