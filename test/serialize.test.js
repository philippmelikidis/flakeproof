import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { serializeDom } from '../src/probe/serialize.js';
import { nodeAt, findNode } from '../src/triage/tree.js';

// Serves an arbitrary html string from an already-created temp directory,
// for cases that need markup the shared fixture page does not contain.
// Callers must create `dir` themselves (and assign it to their own
// try/finally-scoped variable) before calling this, so that if starting the
// server throws, the caller's cleanup guard still knows about the directory
// and does not leak it.
async function serveHtml(dir, html) {
  await writeFile(join(dir, 'index.html'), html);
  return startFixtureServer({ root: dir });
}

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

test('serializeDom captures a bounded html snippet per node', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);
    const snap = await page.evaluate(serializeDom, null);
    const cta = findNode(snap.tree, (x) => x.id === 'cta');
    assert.ok(cta.html.startsWith('<a'), `expected an anchor snippet, got ${cta.html}`);
    assert.ok(cta.html.includes('Contact us'));
    assert.ok(cta.html.length <= 404, 'snippet must stay bounded');
  } finally {
    await browser?.close();
    await server?.close();
  }
});

describe('accessibleName', () => {
  test('a nested link is named from its whole subtree, not just its own text', async () => {
    let server = null;
    let browser = null;
    let dir = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'fp-serialize-'));
      server = await serveHtml(
        dir,
        '<!doctype html><html><body><a id="contact" href="/contact/">Contact <b>us</b></a></body></html>',
      );
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(server.url);
      const snap = await page.evaluate(serializeDom, null);
      const link = findNode(snap.tree, (n) => n.id === 'contact');
      assert.equal(link.name, 'Contact us');
    } finally {
      await browser?.close();
      await server?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  test('an aria-label beats the subtree text', async () => {
    let server = null;
    let browser = null;
    let dir = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'fp-serialize-'));
      server = await serveHtml(
        dir,
        '<!doctype html><html><body><a id="contact" aria-label="Reach out to us" href="/contact/">Contact <b>us</b></a></body></html>',
      );
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(server.url);
      const snap = await page.evaluate(serializeDom, null);
      const link = findNode(snap.tree, (n) => n.id === 'contact');
      assert.equal(link.name, 'Reach out to us');
    } finally {
      await browser?.close();
      await server?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  test('an img is named from its alt attribute', async () => {
    let server = null;
    let browser = null;
    let dir = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'fp-serialize-'));
      server = await serveHtml(
        dir,
        '<!doctype html><html><body><img id="logo" src="logo.svg" alt="Acme logo"></body></html>',
      );
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(server.url);
      const snap = await page.evaluate(serializeDom, null);
      const logo = findNode(snap.tree, (n) => n.id === 'logo');
      assert.equal(logo.name, 'Acme logo');
    } finally {
      await browser?.close();
      await server?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('IMPLICIT_ROLES for header and footer', () => {
  test('a header inside an article gets no banner role, but a top-level header does', async () => {
    let server = null;
    let browser = null;
    let dir = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'fp-serialize-'));
      server = await serveHtml(
        dir,
        '<!doctype html><html><body>' +
          '<header id="top-header">Site</header>' +
          '<article><header id="article-header">Post title</header></article>' +
          '</body></html>',
      );
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(server.url);
      const snap = await page.evaluate(serializeDom, null);
      const topHeader = findNode(snap.tree, (n) => n.id === 'top-header');
      const articleHeader = findNode(snap.tree, (n) => n.id === 'article-header');
      assert.equal(topHeader.role, 'banner');
      assert.equal(articleHeader.role, '', 'a header scoped to an article is not a page banner');
    } finally {
      await browser?.close();
      await server?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  test('a footer inside a section gets no contentinfo role, but a top-level footer does', async () => {
    let server = null;
    let browser = null;
    let dir = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'fp-serialize-'));
      server = await serveHtml(
        dir,
        '<!doctype html><html><body>' +
          '<section><footer id="section-footer">Section end</footer></section>' +
          '<footer id="top-footer">Site end</footer>' +
          '</body></html>',
      );
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(server.url);
      const snap = await page.evaluate(serializeDom, null);
      const topFooter = findNode(snap.tree, (n) => n.id === 'top-footer');
      const sectionFooter = findNode(snap.tree, (n) => n.id === 'section-footer');
      assert.equal(topFooter.role, 'contentinfo');
      assert.equal(sectionFooter.role, '', 'a footer scoped to a section is not the page contentinfo');
    } finally {
      await browser?.close();
      await server?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
});
