import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeHtmlAtPath } from '../src/probe/snippet.js';

const PAGE =
  '<html><head><title>t</title></head><body>' +
  '<header id="site-header"><nav><ul id="main-nav">' +
  '<li class="nav-item css-1a2b3c"><a href="/products/">Products</a></li>' +
  '<li class="nav-item css-9z8y7x"><a href="/solutions/">Solutions</a></li>' +
  '</ul></nav></header>' +
  '<main><img id="logo" src="logo.svg" alt="Acme"></main>' +
  '</body></html>';

test('path [] returns the whole document, unbounded by the walker', () => {
  assert.equal(nodeHtmlAtPath(PAGE, []), PAGE);
});

test('a nested element is reconstructed from its path', () => {
  // body(1) > header(0) > nav(0) > ul(0) > li(0)
  const html = nodeHtmlAtPath(PAGE, [1, 0, 0, 0, 0]);
  assert.ok(html.startsWith('<li'), `expected an <li>, got: ${html}`);
  assert.ok(html.includes('css-1a2b3c'));
  assert.ok(html.includes('Products'));
  assert.ok(html.endsWith('</li>'));
});

test('a sibling at a different index is reconstructed independently', () => {
  const html = nodeHtmlAtPath(PAGE, [1, 0, 0, 0, 1]);
  assert.ok(html.includes('css-9z8y7x'));
  assert.ok(html.includes('Solutions'));
  assert.ok(!html.includes('css-1a2b3c'), 'must not bleed into the sibling');
});

test('a void element with no closing tag is reconstructed as a single tag', () => {
  // body(1) > main(1) > img(0)
  const html = nodeHtmlAtPath(PAGE, [1, 1, 0]);
  assert.equal(html, '<img id="logo" src="logo.svg" alt="Acme">');
});

test('a path that does not resolve returns null instead of a wrong guess', () => {
  assert.equal(nodeHtmlAtPath(PAGE, [1, 0, 0, 0, 99]), null);
  assert.equal(nodeHtmlAtPath(PAGE, [9, 9, 9]), null);
});

test('missing or empty html degrades to null rather than throwing', () => {
  assert.equal(nodeHtmlAtPath(null, [0]), null);
  assert.equal(nodeHtmlAtPath('', [0]), null);
  assert.equal(nodeHtmlAtPath(undefined, [0]), null);
});

test('an oversized snippet is bounded, matching the old per-node cap', () => {
  const bigText = 'x'.repeat(1000);
  const html = `<html><body><p id="big">${bigText}</p></body></html>`;
  const out = nodeHtmlAtPath(html, [0, 0]);
  assert.ok(out.length <= 404, `expected a bounded snippet, got ${out.length} chars`);
  assert.ok(out.endsWith(' ...'));
});

test('a quoted attribute value containing > does not truncate the tag early', () => {
  const html = '<html><body><div data-note="a > b"><span id="x">hi</span></div></body></html>';
  const out = nodeHtmlAtPath(html, [0, 0, 0]);
  assert.equal(out, '<span id="x">hi</span>');
});
