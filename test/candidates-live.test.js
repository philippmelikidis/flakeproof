// Proves the highest-value invariant of the recommendation pipeline: every
// candidate candidatesFor() emits for a real page must actually resolve to
// exactly one element on that page. A tree-side approximation (a role
// "verified" only against the serialized tree, a has-text scope computed
// without the real DOM) can be internally consistent yet still match zero or
// many elements live. This test is the only thing that would have caught the
// role-candidate regression where every emitted `role=...[name="..."]` for a
// list/listitem/banner element matched nothing on the live page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { serializeDom } from '../src/probe/serialize.js';
import { candidatesFor } from '../src/triage/candidates.js';
import { findNode } from '../src/triage/tree.js';

test('every emitted candidate resolves to exactly one element on the live page', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer({ root: './test/fixtures/page-v2' });
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);
    const snap = await page.evaluate(serializeDom, null);

    const targets = [
      { label: 'first nav li', find: (n) => n.tag === 'li' },
      { label: 'ul#main-nav', find: (n) => n.id === 'main-nav' },
      { label: 'header', find: (n) => n.tag === 'header' },
      // A link nested around an <img alt="..."> - the subtree text alone
      // does not agree with the real accessible name (the alt text
      // contributes to it), so this exercises the exactness gate.
      { label: 'nested link wrapping an img', find: (n) => n.id === 'logo-link' },
      // A plain leaf link with its own text - the case the accessible-name
      // change was meant to keep working.
      { label: 'plain link', find: (n) => n.id === 'cta' },
    ];

    for (const target of targets) {
      const node = findNode(snap.tree, target.find);
      assert.ok(node, `fixture must contain a node for "${target.label}"`);
      const candidates = candidatesFor(snap.tree, node.path);
      for (const candidate of candidates) {
        const count = await page.locator(candidate.selector).count();
        assert.equal(
          count,
          1,
          `${target.label}: candidate ${candidate.kind} "${candidate.selector}" matched ${count} elements live, expected 1`,
        );
      }
    }
  } finally {
    await browser?.close();
    await server?.close();
  }
});
