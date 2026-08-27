import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { serializeDom } from '../src/probe/serialize.js';
import { nodeAt, findNode } from '../src/triage/tree.js';

test('serializeDom captures the fixture header', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);

    const snap = await page.evaluate(serializeDom, '#cta');

    assert.equal(snap.tree.tag, 'html');
    const nav = findNode(snap.tree, (n) => n.id === 'main-nav');
    assert.equal(nav.children.length, 4);
    assert.deepEqual(nav.children[0].classes, ['css-1a2b3c', 'nav-item']); // sorted

    assert.ok(snap.anchorPath, 'anchorPath must be set');
    const anchor = nodeAt(snap.tree, snap.anchorPath);
    assert.equal(anchor.id, 'cta');
    assert.equal(anchor.text, 'Contact us');
    assert.equal(anchor.attrs.href, '/contact/');
  } finally {
    await browser?.close();
    await server?.close();
  }
});

test('serializeDom returns null anchorPath for unmatched selector', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);

    const snap = await page.evaluate(serializeDom, '#does-not-exist');
    assert.equal(snap.anchorPath, null);
  } finally {
    await browser?.close();
    await server?.close();
  }
});

test('serializeDom emits explicit and implicit roles', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);
    const snap = await page.evaluate(serializeDom, null);
    const nav = findNode(snap.tree, (x) => x.tag === 'nav');
    assert.equal(nav.role, 'navigation');
    const cta = findNode(snap.tree, (x) => x.id === 'cta');
    assert.equal(cta.role, 'link');
  } finally {
    await browser?.close();
    await server?.close();
  }
});
