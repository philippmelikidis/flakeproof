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

test('positional candidate survives renames but not reordering', async () => {
  const server = await startFixtureServer();
  try {
    const snap = await anchorPathFor(server.url, 'li.css-1a2b3c');
    const candidates = candidatesFor(snap, snap.anchorPath);
    const proven = await proveCandidates(server.url, snap.anchorPath, candidates);
    const positional = proven.find((c) => c.selector === '#main-nav li:nth-child(1)');
    assert.ok(positional, 'positional candidate must exist for the anonymous li');
    assert.equal(positional.applied, 5);
    assert.equal(positional.survived, 4, 'move-to-end must defeat the positional candidate');
  } finally {
    await server.close();
  }
});

test('text candidate survives cosmetic mutations but not the copy tweak', async () => {
  const server = await startFixtureServer();
  try {
    const snap = await anchorPathFor(server.url, 'li.css-1a2b3c > a');
    const candidates = candidatesFor(snap, snap.anchorPath);
    const textCand = candidates.find((c) => c.kind === 'text');
    assert.ok(textCand, 'nav link must get a text candidate');
    assert.equal(textCand.selector, 'text="Products"');

    const proven = await proveCandidates(server.url, snap.anchorPath, candidates);
    const top = proven[0];
    assert.ok(top.kind === 'text' || top.kind === 'role', `expected a text/role candidate on top, got ${top.selector}`);
    assert.equal(top.uniqueInCurrent, true);
    assert.equal(top.survived, top.applied - 1, 'the copy tweak must defeat the text candidate; that is its honest weakness');
    assert.ok(top.applied >= 4, `expected at least 4 applicable mutations, got ${top.applied}`);
  } finally {
    await server.close();
  }
});

// Merges what used to be two nearly identical #cta tests (one only checking
// the id candidate's own survival, the other only checking it still ranks
// above text): proveCandidates defaults to the full PROVING catalog
// (cosmetic mutations plus the copy tweak, see src/probe/catalogs/proving.js)
// - not the plain cosmetic catalog, despite what an earlier version of this
// test's name implied - so one test asserting everything that catalog
// actually proves about #cta is both more complete and less redundant than
// two overlapping ones.
test('id candidate for #cta survives every proving-catalog mutation and outranks the weaker text candidate', async () => {
  const server = await startFixtureServer();
  try {
    const snap = await anchorPathFor(server.url, '#cta');
    const candidates = candidatesFor(snap, snap.anchorPath);
    const proven = await proveCandidates(server.url, snap.anchorPath, candidates);
    const top = proven[0];
    assert.equal(top.selector, '#cta');
    assert.equal(top.uniqueInCurrent, true);
    assert.ok(top.applied >= 3, `expected at least 3 applicable mutations, got ${top.applied}`);
    assert.equal(top.survived, top.applied, 'the id must survive every mutation, including the copy tweak');

    const text = proven.find((c) => c.kind === 'text');
    assert.ok(text, 'cta must still get a text candidate');
    assert.equal(text.survived, text.applied - 1, 'the copy tweak must defeat the text candidate; that is its honest weakness');
  } finally {
    await server.close();
  }
});
