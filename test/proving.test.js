import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { copyTweak } from '../src/probe/catalogs/proving.js';

async function withPage(html, fn) {
  let dir = null;
  let server = null;
  let browser = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-proving-'));
    await writeFile(join(dir, 'index.html'), html);
    server = await startFixtureServer({ root: dir });
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);
    return await fn(page);
  } finally {
    await browser?.close();
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

test('copyTweak flips the first flippable letter when it is in the first text node', async () => {
  const html = '<!doctype html><html><body><button id="t">Save draft</button></body></html>';
  await withPage(html, async (page) => {
    const applied = await page.evaluate(copyTweak.apply, '#t');
    assert.equal(applied, true);
    const text = await page.locator('#t').innerText();
    assert.equal(text, 'save draft', 'the leading "S" must be flipped to lowercase');
  });
});

// Regression test for the bug fixed in this cycle: copyTweak used to inspect
// only the FIRST non-empty text node and bail out with `false` the moment
// that node had no letter to flip (a leading digit or punctuation), even
// when a later text node on the same element plainly had one. A button like
// "42 Products" (digits, then an inline element, then a text node that does
// have a letter) must still get a flip - and this only passes once the
// fix's `continue` (in place of the old early `return false`) is in place.
test('copyTweak keeps scanning past a leading text node with no flippable letter', async () => {
  const html = '<!doctype html><html><body><button id="t">42 <b>ignored</b> Products</button></body></html>';
  await withPage(html, async (page) => {
    const applied = await page.evaluate(copyTweak.apply, '#t');
    assert.equal(applied, true, 'a later text node with a letter must still be found and flipped');
    const text = await page.locator('#t').innerText();
    assert.match(text, /42 ignored products/i);
    assert.ok(text.includes('products'), 'the "P" in the later text node must have been flipped to lowercase');
  });
});

test('copyTweak returns false when no text node on the element has a flippable letter', async () => {
  const html = '<!doctype html><html><body><button id="t">42 - 100%</button></body></html>';
  await withPage(html, async (page) => {
    const applied = await page.evaluate(copyTweak.apply, '#t');
    assert.equal(applied, false);
  });
});
