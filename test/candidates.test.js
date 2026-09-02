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
          n('a', { id: 'cta', classes: ['btn'], text: 'Contact us', role: 'link', attrs: { href: '/contact/', 'data-testid': 'cta-button' } }),
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

test('queryTree fails closed on an empty or blank selector', () => {
  const t = tree();
  assert.equal(queryTree(t, ''), null);
  assert.equal(queryTree(t, '   '), null);
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
  assert.ok(cands.some((c) => c.kind === 'container-text'), 'container-text candidate available');
  assert.ok(cands.some((c) => c.kind === 'positional'), 'positional candidate available');
  assert.equal(cands[0].kind, 'container-text', 'container-text ranks above positional');
});

test('text and role candidates are generated for text-bearing elements', () => {
  const t = tree();
  const ctaPath = [0, 0, 1];
  const selectors = candidatesFor(t, ctaPath).map((c) => c.selector);
  assert.ok(selectors.includes('text="Contact us"'));
  assert.ok(selectors.includes('role=link[name="Contact us"]'));
});

test('text candidate is dropped when the text is not unique in the tree', () => {
  const t = withPaths(
    n('html', {}, [
      n('body', {}, [
        n('a', { text: 'Read more', attrs: { href: '/a/' } }),
        n('a', { text: 'Read more', attrs: { href: '/b/' } }),
      ]),
    ]),
  );
  const cands = candidatesFor(t, [0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'text'), 'duplicate text must not become a candidate');
});

test('text containing a double quote is not offered (fail closed)', () => {
  const t = withPaths(
    n('html', {}, [n('body', {}, [n('a', { text: 'say "hi"', attrs: { href: '/x/' }, role: 'link' })])]),
  );
  const cands = candidatesFor(t, [0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'text' || c.kind === 'role'));
});

test('role candidate is withheld for a node with element children and no explicit name', () => {
  const t = withPaths(
    n('html', {}, [
      n('body', {}, [
        n('a', { text: 'Contact us', role: 'link', attrs: { href: '/contact/' } }, [
          n('span', { text: 'arrow-icon' }),
        ]),
      ]),
    ]),
  );
  const cands = candidatesFor(t, [0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'role'), 'accessible name cannot be approximated from own text when element children exist');
  assert.ok(cands.some((c) => c.kind === 'text'), 'own-text candidate is unaffected and stays since the text is unique');
});

test('an anonymous element gets a container-text candidate from its unique child text', () => {
  const t = withPaths(
    n('html', {}, [
      n('body', {}, [
        n('nav', { id: 'main-nav' }, [
          n('ul', {}, [
            n('li', { classes: ['css-1a2b3c'] }, [n('a', { text: 'Products', attrs: { href: '/products/' } })]),
            n('li', { classes: ['css-9z8y7x'] }, [n('a', { text: 'Solutions', attrs: { href: '/solutions/' } })]),
          ]),
        ]),
      ]),
    ]),
  );
  const cands = candidatesFor(t, [0, 0, 0, 0]); // body > nav > ul > li(1)
  const ct = cands.find((c) => c.kind === 'container-text');
  assert.ok(ct, 'anonymous li must get a container-text candidate');
  assert.equal(ct.selector, '#main-nav li:has-text("Products")');
});

test('container-text is dropped when the child text is not unique', () => {
  const t = withPaths(
    n('html', {}, [
      n('body', {}, [
        n('nav', { id: 'main-nav' }, [
          n('ul', {}, [
            n('li', {}, [n('a', { text: 'Mehr', attrs: { href: '/a/' } })]),
            n('li', {}, [n('a', { text: 'Mehr', attrs: { href: '/b/' } })]),
          ]),
        ]),
      ]),
    ]),
  );
  const cands = candidatesFor(t, [0, 0, 0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'container-text'), 'ambiguous child text must not become a candidate');
});

test('container-text ranks above positional', () => {
  const t = withPaths(
    n('html', {}, [
      n('body', {}, [
        n('nav', { id: 'main-nav' }, [
          n('ul', {}, [n('li', {}, [n('a', { text: 'Products', attrs: { href: '/products/' } })])]),
        ]),
      ]),
    ]),
  );
  const kinds = candidatesFor(t, [0, 0, 0, 0]).map((c) => c.kind);
  const ct = kinds.indexOf('container-text');
  const pos = kinds.indexOf('positional');
  assert.ok(ct !== -1 && pos !== -1, `expected both kinds, got ${kinds.join(', ')}`);
  assert.ok(ct < pos, 'container-text must rank above positional');
});
