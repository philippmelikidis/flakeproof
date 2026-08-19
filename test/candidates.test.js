import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryTree, candidatesFor } from '../src/triage/candidates.js';

function n(tag, props = {}, children = []) {
  return {
    tag, id: null, classes: [], attrs: {}, text: '', name: '', role: '', path: [],
    ...props, children,
  };
}
function withPaths(node, path = []) {
  node.path = path;
  node.children.forEach((c, i) => withPaths(c, path.concat(i)));
  return node;
}

const tree = () =>
  withPaths(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('nav', {}, [
            n('ul', { id: 'main-nav' }, [
              n('li', { classes: ['css-1a2b3c', 'nav-item'] }, [n('a', { text: 'Products', attrs: { href: '/products/' } })]),
              n('li', { classes: ['css-9z8y7x', 'nav-item'] }, [n('a', { text: 'Solutions', attrs: { href: '/solutions/' } })]),
            ]),
          ]),
          n('a', { id: 'cta', classes: ['btn'], text: 'Contact us', attrs: { href: '/contact/', 'data-testid': 'cta-button' } }),
        ]),
      ]),
    ]),
  );

test('queryTree resolves supported selector forms', () => {
  const t = tree();
  assert.equal(queryTree(t, '#cta').length, 1);
  assert.equal(queryTree(t, 'li.nav-item').length, 2);
  assert.equal(queryTree(t, '#main-nav li.nav-item').length, 2);
  assert.equal(queryTree(t, '#main-nav li:nth-child(2)').length, 1);
  assert.equal(queryTree(t, '[data-testid="cta-button"]').length, 1);
  assert.equal(queryTree(t, '#site-header a.btn').length, 1);
  assert.equal(queryTree(t, 'a:hover'), null, 'unsupported syntax must return null, not guess');
});

test('candidatesFor prefers id and testid, drops non-unique candidates', () => {
  const t = tree();
  const ctaPath = [0, 0, 1]; // body > header > a#cta
  const cands = candidatesFor(t, ctaPath);
  const selectors = cands.map((c) => c.selector);
  assert.ok(selectors.includes('#cta'));
  assert.ok(selectors.includes('[data-testid="cta-button"]'));
  assert.ok(selectors.includes('a.btn'));
  assert.ok(!selectors.some((s) => s === '#site-header a'), 'non-unique candidates must be dropped');
  assert.equal(cands[0].kind, 'id', 'id candidate ranks first');
});

test('candidatesFor falls back to a positional candidate for anonymous elements', () => {
  const t = tree();
  const liPath = [0, 0, 0, 0, 0]; // body > header > nav > ul > li(1)
  const cands = candidatesFor(t, liPath);
  assert.deepEqual(cands.map((c) => c.selector), ['#main-nav li:nth-child(1)']);
  assert.equal(cands[0].kind, 'positional');
});
