import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDelta, selectorFeatures } from '../src/triage/classify.js';

function n(tag, props = {}, children = []) {
  return {
    tag, id: null, classes: [], attrs: {}, text: '', name: '', path: [],
    ...props, children,
  };
}
function withPaths(node, path = []) {
  node.path = path;
  node.children.forEach((c, i) => withPaths(c, path.concat(i)));
  return node;
}
function snap(tree, anchorPath) {
  return { tree: withPaths(tree), anchorPath };
}

const baselineTree = () =>
  n('html', {}, [
    n('body', {}, [
      n('header', { id: 'site-header' }, [
        n('a', { id: 'cta', classes: ['btn', 'css-1a2b3c'], text: 'Contact us', attrs: { href: '/contact/' } }),
      ]),
    ]),
  ]);
// anchor path to #cta in baselineTree: [0, 0, 0]  (body > header > a)

test('selectorFeatures parses ids, classes, text and structure', () => {
  const f = selectorFeatures('ul#main-nav > li.css-1a2b3c > a:text-is("Products")');
  assert.deepEqual(f.ids, ['main-nav']);
  assert.deepEqual(f.classes, ['css-1a2b3c']);
  assert.deepEqual(f.texts, ['Products']);
  assert.equal(f.structural, true);
});

test('element removed -> semantic', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [n('body', {}, [n('header', { id: 'site-header' })])]),
    null,
  );
  const r = classifyDelta(before, after, '#cta');
  assert.equal(r.verdict, 'semantic');
});

test('hashed class renamed, selector relied on it -> cosmetic', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('a', { id: 'cta', classes: ['btn', 'css-zz99xx'], text: 'Contact us', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'a.css-1a2b3c');
  assert.equal(r.verdict, 'cosmetic');
});

test('new wrapper broke a structural selector -> cosmetic', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('div', {}, [
            n('a', { id: 'cta', classes: ['btn', 'css-1a2b3c'], text: 'Contact us', attrs: { href: '/contact/' } }),
          ]),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'header > a.btn');
  assert.equal(r.verdict, 'cosmetic');
});

test('text the selector matched on has changed -> semantic', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('a', { id: 'cta', classes: ['btn', 'css-1a2b3c'], text: 'Get a quote', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'a:text-is("Contact us")');
  assert.equal(r.verdict, 'semantic');
});

test('mixed signals -> unclear', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('a', { id: 'cta', classes: ['btn', 'css-zz99xx'], text: 'Get a quote', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'a.css-1a2b3c:text-is("Contact us")');
  assert.equal(r.verdict, 'unclear');
});

test('no explaining delta -> unclear', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(baselineTree(), null);
  const r = classifyDelta(before, after, '#cta');
  assert.equal(r.verdict, 'unclear');
});

test('anchor missing in baseline -> unclear', () => {
  const before = snap(baselineTree(), null);
  const after = snap(baselineTree(), null);
  const r = classifyDelta(before, after, '#never-existed');
  assert.equal(r.verdict, 'unclear');
});
