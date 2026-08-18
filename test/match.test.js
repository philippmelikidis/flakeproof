import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarity, findBestMatch } from '../src/triage/match.js';

// Compact node builder matching the serializer's shape.
function n(tag, props = {}, children = []) {
  return {
    tag, id: null, classes: [], attrs: {}, text: '', name: '', path: [],
    ...props, children,
  };
}

// Assign paths the way the serializer does.
function withPaths(node, path = []) {
  node.path = path;
  node.children.forEach((c, i) => withPaths(c, path.concat(i)));
  return node;
}

test('identical nodes score high, unrelated nodes score low', () => {
  const a = n('a', { id: 'cta', text: 'Contact us', attrs: { href: '/contact/' } });
  const b = n('a', { id: 'cta', text: 'Contact us', attrs: { href: '/contact/' } });
  const c = n('a', { text: 'Careers', attrs: { href: '/careers/' } });
  assert.ok(similarity(a, b) >= 10);
  assert.ok(similarity(a, c) < 5);
});

test('different tag never matches', () => {
  const a = n('a', { text: 'Contact us' });
  const b = n('div', { text: 'Contact us' });
  assert.equal(similarity(a, b), 0);
});

test('finds the moved element despite a new wrapper', () => {
  const target = n('a', { id: 'cta', text: 'Contact us', attrs: { href: '/contact/' }, path: [1, 2] });
  const tree = withPaths(
    n('body', {}, [
      n('header', {}, [
        n('nav', {}, [n('a', { text: 'Products', attrs: { href: '/products/' } })]),
        n('div', {}, [ // new wrapper
          n('a', { id: 'cta', text: 'Contact us', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
  );
  const match = findBestMatch(tree, target);
  assert.ok(match, 'must find a match');
  assert.equal(match.node.id, 'cta');
});

test('returns null when nothing is similar enough', () => {
  const target = n('a', { id: 'cta', text: 'Contact us' });
  const tree = withPaths(n('body', {}, [n('main', {}, [n('h1', { text: 'Fixture' })])]));
  assert.equal(findBestMatch(tree, target), null);
});
