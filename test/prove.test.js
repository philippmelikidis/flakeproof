import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { serializeDom } from '../src/probe/serialize.js';
import { candidatesFor } from '../src/triage/candidates.js';
import { proveCandidates } from '../src/triage/prove.js';

async function anchorPathFor(url, selector) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url);
    return await page.evaluate(serializeDom, selector);
  } finally {
    await browser.close();
  }
}

test('id candidate survives every applicable cosmetic mutation', async () => {
  const server = await startFixtureServer();
  try {
    const snap = await anchorPathFor(server.url, '#cta');
    const candidates = candidatesFor(snap.tree, snap.anchorPath);
    const proven = await proveCandidates(server.url, snap.anchorPath, candidates);
    const top = proven[0];
    assert.equal(top.selector, '#cta');
    assert.equal(top.uniqueInCurrent, true);
    assert.ok(top.applied >= 3, `expected at least 3 applicable mutations, got ${top.applied}`);
    assert.equal(top.survived, top.applied);
  } finally {
    await server.close();
  }
});

test('positional candidate survives renames but not reordering', async () => {
  const server = await startFixtureServer();
  try {
    const snap = await anchorPathFor(server.url, 'li.css-1a2b3c');
    const candidates = candidatesFor(snap.tree, snap.anchorPath);
    const proven = await proveCandidates(server.url, snap.anchorPath, candidates);
    const positional = proven.find((c) => c.selector === '#main-nav li:nth-child(1)');
    assert.ok(positional, 'positional candidate must exist for the anonymous li');
    assert.equal(positional.applied, 5);
    assert.equal(positional.survived, 4, 'move-to-end must defeat the positional candidate');
  } finally {
    await server.close();
  }
});
