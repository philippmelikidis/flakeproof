import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { serializeDom } from '../src/probe/serialize.js';
import { findNode } from '../src/triage/tree.js';
import { semanticMutations } from '../src/probe/catalogs/semantic.js';

test('semantic mutations change meaning-bearing properties', async () => {
  const server = await startFixtureServer();
  const browser = await chromium.launch();
  try {
    const checks = {
      'change-text': async (page) => {
        const snap = await page.evaluate(serializeDom, null);
        const cta = findNode(snap.tree, (n) => n.id === 'cta');
        assert.equal(cta.text, 'FLAKEPROOF-CHANGED');
      },
      'change-href': async (page) => {
        const snap = await page.evaluate(serializeDom, null);
        const cta = findNode(snap.tree, (n) => n.id === 'cta');
        assert.equal(cta.attrs.href, '/fp-changed/');
      },
      'remove-element': async (page) => {
        const snap = await page.evaluate(serializeDom, null);
        assert.equal(findNode(snap.tree, (n) => n.id === 'cta'), null);
      },
    };

    for (const m of semanticMutations) {
      const page = await browser.newPage();
      await page.goto(server.url);
      const applied = await page.evaluate(m.apply, '#cta');
      assert.equal(applied, true, `${m.id} must apply`);
      await checks[m.id](page);
      await page.close();
    }

    assert.equal(Object.keys(checks).length, semanticMutations.length);
  } finally {
    await browser.close();
    await server.close();
  }
});
