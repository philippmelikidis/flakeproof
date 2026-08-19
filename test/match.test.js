import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarity, findBestMatch } from '../src/triage/match.js';

// Compact node builder matching the serializer's shape.
function n(tag, props = {}, children = []) {
  return {
    tag, id: null, classes: [], attrs: {}, text: '', name: '', role: '', path: [],
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

test('matching explicit role adds to the score', () => {
  const a = n('div', { attrs: { role: 'dialog' } });
  const b = n('div', { attrs: { role: 'dialog' } });
  const c = n('div', {});
  assert.ok(similarity(a, b) > similarity(a, c));
});

test('two bare anchors at the same path do not match on tag+position alone', () => {
  // No id, text, name, href, classes or children on either side - tag and
  // position are the only things they share, and that must not be enough.
  const target = n('a', { path: [0, 0, 0] });
  const tree = withPaths(n('body', {}, [n('div', {}, [n('div', {}, [n('a', {})])])]));
  assert.equal(findBestMatch(tree, target), null);
});

test('locality prefers the element in the same region over a distant twin', () => {
  const target = n('a', { text: 'Products', attrs: { href: '/products/' }, path: [0, 0, 1, 0, 0] });
  const tree = withPaths(
    n('body', {}, [
      n('header', {}, [
        n('div', {}, [
          n('ul', {}, [n('li', {}, [n('a', { text: 'Products', attrs: { href: '/products/' } })])]),
        ]),
      ]),
      n('footer', {}, [
        n('ul', {}, [n('li', {}, [n('a', { text: 'Products', attrs: { href: '/products/' } })])]),
      ]),
    ]),
  );
  const match = findBestMatch(tree, target);
  assert.ok(match, 'must find a match');
  assert.equal(match.node.path[0], 0, 'must pick the header copy, not the footer twin');
});

test('weak-identity element is re-identified via locality', () => {
  // Bare li (tag + classes only) used to cap at score 4 and never match.
  const target = n('li', { classes: ['css-1a2b3c', 'nav-item'], path: [0, 0, 0, 0] });
  const tree = withPaths(
    n('body', {}, [
      n('header', {}, [
        n('nav', {}, [
          n('ul', {}, [
            n('li', { classes: ['css-1a2b3c', 'fp-added', 'nav-item'] }),
            n('li', { classes: ['css-9z8y7x', 'nav-item'] }),
          ]),
        ]),
      ]),
    ]),
  );
  const match = findBestMatch(tree, target);
  assert.ok(match, 'locality must lift the true element above the threshold');
  assert.ok(match.node.classes.includes('fp-added'));
});

test('a sibling sliding into the removed element position is not mistaken for it', () => {
  // Removal scenario: the target li (child "Products") is gone; its sibling
  // (child "Solutions") now sits at the exact same path and would inherit
  // the full locality bonus. The child signature must veto that match.
  const target = n(
    'li',
    { classes: ['css-1a2b3c', 'nav-item'], path: [0, 0, 0, 0] },
    [n('a', { text: 'Products', attrs: { href: '/products/' } })],
  );
  const tree = withPaths(
    n('body', {}, [
      n('header', {}, [
        n('nav', {}, [
          n('ul', {}, [
            n('li', { classes: ['css-9z8y7x', 'nav-item'] }, [
              n('a', { text: 'Solutions', attrs: { href: '/solutions/' } }),
            ]),
            n('li', { classes: ['css-4d5e6f', 'nav-item'] }, [
              n('a', { text: 'Company', attrs: { href: '/company/' } }),
            ]),
          ]),
        ]),
      ]),
    ]),
  );
  assert.equal(findBestMatch(tree, target), null, 'no confident match may exist after removal');
});
