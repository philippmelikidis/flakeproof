import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { queryTree, candidatesFor, CURRENT_SNAPSHOT_VERSION } from '../src/triage/candidates.js';
import { serializeDom } from '../src/probe/serialize.js';
import { findNode } from '../src/triage/tree.js';
import { startFixtureServer } from './helpers/serve.js';

// Serves an arbitrary html string from an already-created temp directory.
// Callers must create `dir` themselves before calling this, so that if
// starting the server throws, the caller's cleanup guard still knows about
// the directory and does not leak it.
async function serveHtml(dir, html) {
  await writeFile(join(dir, 'index.html'), html);
  return startFixtureServer({ root: dir });
}

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

// candidatesFor takes the snapshot object serializeDom/captureSnapshot
// produce (`{ tree, snapshotVersion, ... }`), not a bare tree, so it can
// tell a current-format tree from one an older flakeproof captured. Test
// trees are built by hand rather than through the real serializer, so they
// need this wrapper to opt into "current format" explicitly.
function asSnapshot(tree) {
  return { tree, snapshotVersion: CURRENT_SNAPSHOT_VERSION };
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
          n('a', { id: 'cta', classes: ['btn'], text: 'Contact us', name: 'Contact us', role: 'link', attrs: { href: '/contact/', 'data-testid': 'cta-button' } }),
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
  const cands = candidatesFor(asSnapshot(t), ctaPath);
  const selectors = cands.map((c) => c.selector);
  assert.ok(selectors.includes('#cta'));
  assert.ok(selectors.includes('[data-testid="cta-button"]'));
  assert.ok(selectors.includes('a.btn'));
  assert.ok(!selectors.some((s) => s === '#site-header a'), 'non-unique candidates must be dropped');
  assert.equal(cands[0].kind, 'id', 'id candidate ranks first');
});

test('candidatesFor prefers container-text over positional for anonymous elements', () => {
  const t = tree();
  const liPath = [0, 0, 0, 0, 0]; // body > header > nav > ul > li(1)
  const cands = candidatesFor(asSnapshot(t), liPath);
  assert.deepEqual(cands.map((c) => c.selector), [
    '#main-nav li:has-text("Products")',
    '#main-nav li:nth-child(1)',
  ]);
  assert.equal(cands[0].kind, 'container-text');
  assert.equal(cands[1].kind, 'positional');
});

test('text and role candidates are generated for text-bearing elements', () => {
  const t = tree();
  const ctaPath = [0, 0, 1];
  const selectors = candidatesFor(asSnapshot(t), ctaPath).map((c) => c.selector);
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
  const cands = candidatesFor(asSnapshot(t), [0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'text'), 'duplicate text must not become a candidate');
});

test('text candidate is withheld when the element has a line break among its own children', () => {
  // ownText concatenates adjacent direct text nodes with no separator, so
  // <button>Line<br>break</button> would otherwise produce text="Linebreak",
  // a string nothing on the page actually renders as one run of text.
  const t = withPaths(
    n('html', {}, [n('body', {}, [n('button', { text: 'Linebreak', textHasLineBreak: true })])]),
  );
  const cands = candidatesFor(asSnapshot(t), [0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'text'), 'a line break in the own text must suppress the text candidate');
});

test('text containing a double quote is not offered (fail closed)', () => {
  const t = withPaths(
    n('html', {}, [n('body', {}, [n('a', { text: 'say "hi"', attrs: { href: '/x/' }, role: 'link' })])]),
  );
  const cands = candidatesFor(asSnapshot(t), [0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'text' || c.kind === 'role'));
});

test('a nested <a>Contact <b>us</b></a> now produces a role candidate named from its whole subtree', async () => {
  // Before the accessible-name fix, an element with children but no
  // explicit aria-label had its role candidate withheld entirely, because
  // the tree-side "name" was only the element's own text ('Contact') and
  // could not be trusted to match what Playwright computes from the whole
  // subtree ('Contact us'). The serializer now computes exactly that
  // subtree-derived name, so the tree-side value already agrees with
  // Playwright and the role candidate can be offered.
  //
  // Goes through the real serializer on real markup rather than hand-feeding
  // `name: 'Contact us'` into a synthetic node: a hand-fed name makes the OLD
  // gate (`node.name || node.children.length === 0`) pass too, since the OR's
  // first branch is already satisfied by the hand-fed value regardless of
  // whether the serializer can actually compute a subtree name. That pinned
  // nothing about the actual feature. Driving markup through serializeDom
  // pins the serializer's subtree-name computation as well as the gate.
  let server = null;
  let browser = null;
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-candidates-'));
    server = await serveHtml(
      dir,
      '<!doctype html><html><body><a id="contact" href="/contact/">Contact <b>us</b></a></body></html>',
    );
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);
    const snap = await page.evaluate(serializeDom, null);
    const link = findNode(snap.tree, (nd) => nd.id === 'contact');
    const cands = candidatesFor(snap, link.path);
    assert.ok(
      cands.some((c) => c.kind === 'role' && c.selector === 'role=link[name="Contact us"]'),
      'role candidate must use the serializer-computed subtree name, matching what Playwright computes',
    );
    // The assertion above only proves the tree-side computation agrees with
    // itself; it never asked the real page whether the selector resolves.
    // That is exactly the kind of claim this tool must never make on faith.
    assert.equal(
      await page.locator('role=link[name="Contact us"]').count(),
      1,
      'the emitted role selector must actually resolve to the link on the live page',
    );
    assert.ok(
      cands.some((c) => c.kind === 'text'),
      'own-text candidate is unaffected and stays since the text is unique',
    );
  } finally {
    await browser?.close();
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('role candidate is withheld when the element carries aria-labelledby', () => {
  // aria-labelledby names an element from a DIFFERENT element's content,
  // which the serializer cannot resolve per-element. Whatever "name" ended
  // up in the tree for this node is therefore not trustworthy as the real
  // accessible name, so the role candidate must not be offered rather than
  // guessed.
  const t = withPaths(
    n('html', {}, [
      n('body', {}, [
        n('span', { id: 'external-label', text: 'External label' }),
        n('a', {
          text: 'Contact',
          name: 'Contact', // what the serializer fell back to; not the real name
          role: 'link',
          attrs: { href: '/contact/', 'aria-labelledby': 'external-label' },
        }),
      ]),
    ]),
  );
  const cands = candidatesFor(asSnapshot(t), [0, 1]);
  assert.ok(!cands.some((c) => c.kind === 'role'), 'name is unverifiable when aria-labelledby is present, so never guess');
});

test('role candidate is withheld when the snapshot has no snapshotVersion', () => {
  // A snapshot with no version key predates the per-node nameInexact flag
  // entirely - every node in it looks "exact" simply because the field was
  // never written. Suppress role candidates wholesale rather than trust
  // exactness flags a snapshot this old could not have computed.
  const t = tree();
  const ctaPath = [0, 0, 1];
  const cands = candidatesFor({ tree: t }, ctaPath);
  assert.ok(!cands.some((c) => c.kind === 'role'), 'no snapshotVersion must suppress the role candidate');
  assert.ok(cands.some((c) => c.kind === 'id'), 'candidates unrelated to accessible name are unaffected');
});

test('role candidate is withheld when the snapshot carries an outdated snapshotVersion', () => {
  const t = tree();
  const ctaPath = [0, 0, 1];
  const cands = candidatesFor({ tree: t, snapshotVersion: CURRENT_SNAPSHOT_VERSION - 1 }, ctaPath);
  assert.ok(!cands.some((c) => c.kind === 'role'), 'a stale version number must suppress the role candidate too');
});

test('role candidate is offered when the snapshot carries the current snapshotVersion', () => {
  const t = tree();
  const ctaPath = [0, 0, 1];
  const cands = candidatesFor(asSnapshot(t), ctaPath);
  assert.ok(cands.some((c) => c.kind === 'role'), 'sanity check: the wrapper used by every other test here must not itself suppress role candidates');
});

test('role candidate is withheld when the serializer flags the subtree name as inexact', () => {
  // Direct, fast pin of the nameInexact branch itself, independent of which
  // markup pattern the real serializer would set it for (that live proof
  // lives in candidates-live.test.js / serialize.test.js).
  const t = withPaths(
    n('html', {}, [
      n('body', {}, [
        n('button', { text: 'starSave now', name: 'starSave now', role: 'button', nameInexact: true }),
      ]),
    ]),
  );
  const cands = candidatesFor(asSnapshot(t), [0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'role'), 'nameInexact must suppress the role candidate');
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
  const cands = candidatesFor(asSnapshot(t), [0, 0, 0, 0]); // body > nav > ul > li(1)
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
  const cands = candidatesFor(asSnapshot(t), [0, 0, 0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'container-text'), 'ambiguous child text must not become a candidate');
});

test('container-text is refused when a sibling text merely contains the same words', () => {
  const t = withPaths(
    n('html', {}, [n('body', {}, [n('nav', { id: 'main-nav' }, [n('ul', {}, [
      n('li', {}, [n('a', { text: 'Products' })]),
      n('li', {}, [n('a', { text: 'Products Overview' })]),
    ])])])]),
  );
  const cands = candidatesFor(asSnapshot(t), [0, 0, 0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'container-text'), 'has-text is a substring match, so this is not unique');
});

test('container-text is refused when a sibling differs only in case', () => {
  const t = withPaths(
    n('html', {}, [n('body', {}, [n('nav', { id: 'main-nav' }, [n('ul', {}, [
      n('li', {}, [n('a', { text: 'Products' })]),
      n('li', {}, [n('a', { text: 'PRODUCTS' })]),
    ])])])]),
  );
  const cands = candidatesFor(asSnapshot(t), [0, 0, 0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'container-text'), 'has-text is case-insensitive, so this is not unique');
});

test('container-text is refused when the element is nested inside another of the same tag', () => {
  const t = withPaths(
    n('html', {}, [n('body', {}, [n('nav', { id: 'main-nav' }, [
      n('li', {}, [n('li', {}, [n('a', { text: 'Products' })])]),
    ])])]),
  );
  const inner = [0, 0, 0, 0];
  const cands = candidatesFor(asSnapshot(t), inner);
  assert.ok(!cands.some((c) => c.kind === 'container-text'), 'an ancestor of the same tag also matches has-text');
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
  const kinds = candidatesFor(asSnapshot(t), [0, 0, 0, 0]).map((c) => c.kind);
  const ct = kinds.indexOf('container-text');
  const pos = kinds.indexOf('positional');
  assert.ok(ct !== -1 && pos !== -1, `expected both kinds, got ${kinds.join(', ')}`);
  assert.ok(ct < pos, 'container-text must rank above positional');
});
