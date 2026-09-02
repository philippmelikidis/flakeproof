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

// A per-node `html` snippet used to be captured for EVERY node (see the old
// version of this test), including the root - a ~404 byte duplicate of what
// captureSnapshot already stores once, in full, as the snapshot's top-level
// `html`. On the 21-node fixture that alone more than doubled the JSON, and
// on real pages every ancestor serializing its whole subtree first
// approaches quadratic cost. Exactly two nodes per report ever consumed it
// (the anchor before and after), so the field was dropped entirely and the
// two needed snippets are reconstructed on demand at report time from the
// full-page html plus the node's path (src/probe/snippet.js). No node -
// root included - should carry `html` anymore.
test('serializeDom no longer stores a per-node html snippet, root included', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);
    const snap = await page.evaluate(serializeDom, null);
    assert.equal('html' in snap.tree, false, 'the root node must not carry a per-node html snippet');
    const cta = findNode(snap.tree, (x) => x.id === 'cta');
    assert.equal('html' in cta, false, 'a leaf node must not carry a per-node html snippet either');
  } finally {
    await browser?.close();
    await server?.close();
  }
});

// Regression guard against the per-node html cost creeping back in. The
// fixture page has 21 nodes; before this change the serialized JSON was
// 5967 bytes, after it is roughly a third of that. Assert a generous but
// meaningful ceiling rather than the exact byte count, so unrelated field
// additions do not make this test flaky.
test('dropping the per-node html snippet shrinks the serialized snapshot', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);
    const snap = await page.evaluate(serializeDom, null);
    const size = JSON.stringify(snap).length;
    assert.ok(size < 4000, `expected the snapshot to shrink well below the old 5967 bytes, got ${size}`);
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

test('serializeDom stamps the current snapshotVersion at the top level', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);
    const snap = await page.evaluate(serializeDom, null);
    assert.equal(typeof snap.snapshotVersion, 'number');
  } finally {
    await browser?.close();
    await server?.close();
  }
});

describe('IMPLICIT_ROLES for headings, cells, rows and headers', () => {
  test('h1-h6, td and tr get their implicit roles', async () => {
    let server = null;
    let browser = null;
    let dir = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'fp-serialize-'));
      server = await serveHtml(
        dir,
        '<!doctype html><html><body>' +
          '<h1 id="h1">One</h1><h6 id="h6">Six</h6>' +
          '<table><tr id="tr1"><td id="td1">Cell</td></tr></table>' +
          '</body></html>',
      );
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(server.url);
      const snap = await page.evaluate(serializeDom, null);
      assert.equal(findNode(snap.tree, (n) => n.id === 'h1').role, 'heading');
      assert.equal(findNode(snap.tree, (n) => n.id === 'h6').role, 'heading');
      assert.equal(findNode(snap.tree, (n) => n.id === 'tr1').role, 'row');
      assert.equal(findNode(snap.tree, (n) => n.id === 'td1').role, 'cell');
    } finally {
      await browser?.close();
      await server?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  test('th role depends on its scope attribute; without one it is left unmapped', async () => {
    // A thead-ancestry heuristic (no scope, but inside <thead>) was tried
    // and dropped: live-verified in a real browser, it only exposes
    // columnheader when the table also has a body row - a header-only table
    // collapses in the accessibility tree and exposes no columnheader at
    // all. That table shape is not decidable from the <th> element alone,
    // so scope is the only signal trusted here.
    let server = null;
    let browser = null;
    let dir = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'fp-serialize-'));
      server = await serveHtml(
        dir,
        '<!doctype html><html><body><table>' +
          '<tr><th id="col" scope="col">Name</th></tr>' +
          '<tr><th id="row" scope="row">Row</th></tr>' +
          '<thead><tr><th id="unscoped">Plain</th></tr></thead>' +
          '</table></body></html>',
      );
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(server.url);
      const snap = await page.evaluate(serializeDom, null);
      assert.equal(findNode(snap.tree, (n) => n.id === 'col').role, 'columnheader');
      assert.equal(findNode(snap.tree, (n) => n.id === 'row').role, 'rowheader');
      assert.equal(findNode(snap.tree, (n) => n.id === 'unscoped').role, '', 'no scope and only thead ancestry must not guess');
    } finally {
      await browser?.close();
      await server?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the accessible-name exactness gate (nameInexact)', () => {
  test('nameInexact is absent (not just false) when the subtree agrees with textContent', async () => {
    let server = null;
    let browser = null;
    let dir = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'fp-serialize-'));
      server = await serveHtml(dir, '<!doctype html><html><body><a id="x" href="/x">Contact <b>us</b></a></body></html>');
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(server.url);
      const snap = await page.evaluate(serializeDom, null);
      const node = findNode(snap.tree, (n) => n.id === 'x');
      assert.equal('nameInexact' in node, false, 'exact nodes must omit the key entirely, not carry it as false');
    } finally {
      await browser?.close();
      await server?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  const inexactCases = [
    ['a descendant aria-label', '<span aria-label="x">icon</span> text'],
    ['a descendant aria-labelledby', '<span aria-labelledby="lb">local</span> text'],
    ['an embedded input', 'Qty: <input value="1">'],
    ['an embedded textarea', 'Notes: <textarea>hi</textarea>'],
    ['an embedded select', 'Pick: <select><option>a</option></select>'],
    ['a line break', 'Line<br>break'],
    ['an aria-hidden descendant', '<span aria-hidden="true">x</span> text'],
    ['a hidden-attribute descendant', '<span hidden>x</span> text'],
    ['a display:none descendant', '<span style="display:none">x</span> text'],
    ['a visibility:hidden descendant', '<span style="visibility:hidden">x</span> text'],
    ['an img[alt] descendant', '<img alt="x"> text'],
  ];

  for (const [label, inner] of inexactCases) {
    test(`nameInexact is true when the subtree contains ${label}`, async () => {
      let server = null;
      let browser = null;
      let dir = null;
      try {
        dir = await mkdtemp(join(tmpdir(), 'fp-serialize-'));
        server = await serveHtml(dir, `<!doctype html><html><body><button id="x">${inner}</button></body></html>`);
        browser = await chromium.launch();
        const page = await browser.newPage();
        await page.goto(server.url);
        const snap = await page.evaluate(serializeDom, null);
        const node = findNode(snap.tree, (n) => n.id === 'x');
        assert.equal(node.nameInexact, true);
      } finally {
        await browser?.close();
        await server?.close();
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('own text and line breaks (textHasLineBreak)', () => {
  test('a direct <br> child sets textHasLineBreak and does not silently concatenate the surrounding text', async () => {
    let server = null;
    let browser = null;
    let dir = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'fp-serialize-'));
      server = await serveHtml(dir, '<!doctype html><html><body><button id="x">Line<br>break</button></body></html>');
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(server.url);
      const snap = await page.evaluate(serializeDom, null);
      const node = findNode(snap.tree, (n) => n.id === 'x');
      assert.equal(node.textHasLineBreak, true);
    } finally {
      await browser?.close();
      await server?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  test('no <br> means textHasLineBreak is absent', async () => {
    let server = null;
    let browser = null;
    let dir = null;
    try {
      dir = await mkdtemp(join(tmpdir(), 'fp-serialize-'));
      server = await serveHtml(dir, '<!doctype html><html><body><button id="x">No break here</button></body></html>');
      browser = await chromium.launch();
      const page = await browser.newPage();
      await page.goto(server.url);
      const snap = await page.evaluate(serializeDom, null);
      const node = findNode(snap.tree, (n) => n.id === 'x');
      assert.equal('textHasLineBreak' in node, false);
    } finally {
      await browser?.close();
      await server?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
});
