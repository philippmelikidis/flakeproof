import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { nodeHtmlAtPath } from '../src/probe/snippet.js';
import { serializeDom } from '../src/probe/serialize.js';
import { walk, findNode } from '../src/triage/tree.js';

const PAGE =
  '<html><head><title>t</title></head><body>' +
  '<header id="site-header"><nav><ul id="main-nav">' +
  '<li class="nav-item css-1a2b3c"><a href="/products/">Products</a></li>' +
  '<li class="nav-item css-9z8y7x"><a href="/solutions/">Solutions</a></li>' +
  '</ul></nav></header>' +
  '<main><img id="logo" src="logo.svg" alt="Acme"></main>' +
  '</body></html>';

// Serves an arbitrary html string, mirroring the helper in
// test/serialize.test.js: callers create `dir` themselves so their own
// try/finally cleanup guard knows about it even if starting the server
// throws.
async function serveHtml(dir, html) {
  await writeFile(join(dir, 'index.html'), html);
  return startFixtureServer({ root: dir });
}

test('path [] returns the whole document, subject to the same bound as any other path', () => {
  // Previously named "unbounded" even though bound() is applied
  // unconditionally to the root path too - the test only ever passed
  // because PAGE happens to be shorter than the default 400-char cap, which
  // proved nothing about bounding behavior. Assert the bound explicitly
  // with a maxLen small enough to actually trigger it.
  assert.equal(nodeHtmlAtPath(PAGE, [], 'html'), PAGE);
  const bounded = nodeHtmlAtPath(PAGE, [], 'html', 10);
  assert.equal(bounded, PAGE.slice(0, 10) + ' ...', 'the root path must be bounded like any other path, not skip the cap');
});

test('a nested element is reconstructed from its path', () => {
  // body(1) > header(0) > nav(0) > ul(0) > li(0)
  const html = nodeHtmlAtPath(PAGE, [1, 0, 0, 0, 0], 'li');
  assert.ok(html.startsWith('<li'), `expected an <li>, got: ${html}`);
  assert.ok(html.includes('css-1a2b3c'));
  assert.ok(html.includes('Products'));
  assert.ok(html.endsWith('</li>'));
});

test('a sibling at a different index is reconstructed independently', () => {
  const html = nodeHtmlAtPath(PAGE, [1, 0, 0, 0, 1], 'li');
  assert.ok(html.includes('css-9z8y7x'));
  assert.ok(html.includes('Solutions'));
  assert.ok(!html.includes('css-1a2b3c'), 'must not bleed into the sibling');
});

test('a void element with no closing tag is reconstructed as a single tag', () => {
  // body(1) > main(1) > img(0)
  const html = nodeHtmlAtPath(PAGE, [1, 1, 0], 'img');
  assert.equal(html, '<img id="logo" src="logo.svg" alt="Acme">');
});

test('a path that does not resolve returns null instead of a wrong guess', () => {
  assert.equal(nodeHtmlAtPath(PAGE, [1, 0, 0, 0, 99], 'li'), null);
  assert.equal(nodeHtmlAtPath(PAGE, [9, 9, 9], 'div'), null);
});

test('missing or empty html degrades to null rather than throwing', () => {
  assert.equal(nodeHtmlAtPath(null, [0], 'div'), null);
  assert.equal(nodeHtmlAtPath('', [0], 'div'), null);
  assert.equal(nodeHtmlAtPath(undefined, [0], 'div'), null);
});

test('an oversized snippet is bounded, matching the old per-node cap', () => {
  const bigText = 'x'.repeat(1000);
  const html = `<html><body><p id="big">${bigText}</p></body></html>`;
  const out = nodeHtmlAtPath(html, [0, 0], 'p');
  assert.ok(out.length <= 404, `expected a bounded snippet, got ${out.length} chars`);
  assert.ok(out.endsWith(' ...'));
});

test('a quoted attribute value containing > does not truncate the tag early', () => {
  const html = '<html><body><div data-note="a > b"><span id="x">hi</span></div></body></html>';
  const out = nodeHtmlAtPath(html, [0, 0, 0], 'span');
  assert.equal(out, '<span id="x">hi</span>');
});

test('a path that resolves but to the wrong tag returns null instead of a mismatched snippet', () => {
  // body(1) > header(0) > nav(0) > ul(0) > li(0) is genuinely an <li>. The
  // caller expects an <a> at this path (a stale or mismatched tree/html
  // pairing); the self-check must catch that instead of silently handing
  // back the li's markup under the wrong label.
  assert.equal(nodeHtmlAtPath(PAGE, [1, 0, 0, 0, 0], 'a'), null);
});

test('a comment between siblings does not shift child indices', async () => {
  let server = null;
  let browser = null;
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-snippet-comment-'));
    server = await serveHtml(
      dir,
      '<!doctype html><html><body><ul>' +
        '<li id="a">A</li><!-- a comment between siblings --><li id="b">B</li>' +
        '</ul></body></html>',
    );
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);
    const snap = await page.evaluate(serializeDom, null);
    /* eslint-disable no-undef */
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    /* eslint-enable no-undef */

    const nodeB = findNode(snap.tree, (n) => n.id === 'b');
    assert.ok(nodeB, 'sanity: the second li must be found');
    // ul is body's only child; li#a is index 0, li#b must still be index 1,
    // not 2 - the comment must be invisible to child indexing on both the
    // serializeDom side (already true) and the html-walker side.
    assert.equal(nodeB.path.at(-1), 1, 'the comment must not shift the sibling index');

    const reconstructed = nodeHtmlAtPath(html, nodeB.path, 'li');
    assert.equal(reconstructed, '<li id="b">B</li>');
  } finally {
    await browser?.close();
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// The module's entire contract is "agree with the browser's outerHTML", and
// nothing in the hand-written PAGE constant above ever exercised a
// <script> body - which is exactly why the raw-text parsing bug this file
// fixes went undetected. This test drives the real serializeDom AND the
// real walker against markup a browser actually parsed, and cross-checks
// every single node against that same browser's own outerHTML.
test('browser differential: the walker matches outerHTML for every node, or returns null, never a WRONG element', async () => {
  const ADVERSARIAL_PAGE =
    '<!doctype html><html><head><meta charset="utf-8"><title>t</title>' +
    '<style>.icon::before { content: "<"; } .a[data-x="<value>"] { color: red; } .b > .c { color: blue; }</style>' +
    '</head><body>' +
    // A <script> body containing a fake closing tag and a `<` comparison -
    // both of which the old parser consumed as real markup.
    '<div id="tracker"><script>var tpl = \'</div>\'; if (1 < 2) { console.log(tpl); }</script></div>' +
    // An attribute value containing `>`.
    '<div id="noteDiv" data-note="a > b"><span>hi</span></div>' +
    // Void elements with and without the self-closing slash.
    '<p>line<br>break</p><p>line<br/>break</p>' +
    '<input id="void-no-slash" type="text"><input id="void-slash" type="text" />' +
    // A comment between siblings.
    '<div id="before-comment">x</div><!-- a comment --><div id="after-comment">y</div>' +
    // A table with no explicit <tbody> (the browser inserts one).
    '<table id="tbl"><tr><td>1</td></tr></table>' +
    // An unclosed <li> (html lets a new <li> implicitly close the previous
    // one; this scanner does not model that, so it may honestly return
    // null here, but it must never return the WRONG element).
    '<ul><li id="unclosed">first<li id="second">second</li></ul>' +
    // Mixed-case tag names.
    '<DIV id="mixedCase"><SPAN>MixedCase</SPAN></DIV>' +
    '</body></html>';

  let server = null;
  let browser = null;
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-snippet-adversarial-'));
    server = await serveHtml(dir, ADVERSARIAL_PAGE);
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);
    const snap = await page.evaluate(serializeDom, null);
    /* eslint-disable no-undef */
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    /* eslint-enable no-undef */

    const nodes = [];
    walk(snap.tree, (n) => nodes.push(n));
    assert.ok(nodes.length > 10, 'sanity: the adversarial page must serialize to a nontrivial tree');

    let correct = 0;
    let nulls = 0;
    let wrong = 0;
    const wrongDetails = [];
    for (const node of nodes) {
      const reconstructed = nodeHtmlAtPath(html, node.path, node.tag);
      /* eslint-disable no-undef */
      const real = await page.evaluate((path) => {
        let el = document.documentElement;
        for (const i of path) {
          el = el.children[i];
          if (!el) return null;
        }
        return el.outerHTML;
      }, node.path);
      /* eslint-enable no-undef */
      // nodeHtmlAtPath bounds long snippets to 400 chars (matching the old
      // per-node cap) - apply the identical bound to the browser's own
      // outerHTML before comparing, so a correctly-truncated match on a
      // large element (html, body) is not mistaken for a wrong one.
      const boundedReal = real !== null && real.length > 400 ? real.slice(0, 400) + ' ...' : real;
      if (reconstructed === null) {
        nulls += 1;
      } else if (reconstructed === boundedReal) {
        correct += 1;
      } else {
        wrong += 1;
        wrongDetails.push({ path: node.path, tag: node.tag, reconstructed, real });
      }
    }

    assert.equal(wrong, 0, `the walker must never return a WRONG element's html: ${JSON.stringify(wrongDetails, null, 2)}`);
    // With raw-text handling and the self-check both in place, every node on
    // this adversarial page reconstructs correctly - the tricky bits here
    // are all things a browser normalizes away or that raw-text handling
    // resolves cleanly. A regression in raw-text handling degrades some of
    // these from "correct" to "null" (the self-check keeps it from becoming
    // "wrong", but honest nulls where a real snippet is available are still
    // a coverage loss worth catching here).
    assert.equal(nulls, 0, `expected every node to resolve on this fixture, got ${nulls} nulls`);
    assert.equal(correct, nodes.length, 'every node must reconstruct correctly');
    console.log(`browser differential: correct=${correct} null=${nulls} wrong=${wrong} total=${nodes.length}`);
  } finally {
    await browser?.close();
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
