import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { serializeDom } from '../src/probe/serialize.js';
import { findNode } from '../src/triage/tree.js';
import { cosmeticMutations } from '../src/probe/catalogs/cosmetic.js';

function byId(id) { return (n) => n.id === id; }

test('every cosmetic mutation applies to a suitable target and changes the DOM', async () => {
  const server = await startFixtureServer();
  const browser = await chromium.launch();
  try {
    // Suitable target per mutation: rename-hashed-class needs a hashed class.
    const targets = {
      'wrap-element': '#cta',
      'add-class': '#cta',
      'rename-hashed-class': 'li.css-1a2b3c',
      'add-framework-attr': '#cta',
      'move-to-end': '#logo-link',
    };

    for (const m of cosmeticMutations) {
      const page = await browser.newPage();
      await page.goto(server.url);
      const before = await page.evaluate(serializeDom, targets[m.id]);
      const applied = await page.evaluate(m.apply, targets[m.id]);
      assert.equal(applied, true, `${m.id} must apply to ${targets[m.id]}`);
      const after = await page.evaluate(serializeDom, targets[m.id]);
      assert.notDeepEqual(after.tree, before.tree, `${m.id} must change the serialized DOM`);
      await page.close();
    }

    assert.equal(Object.keys(targets).length, cosmeticMutations.length);
  } finally {
    await browser.close();
    await server.close();
  }
});

test('wrap-element inserts one extra ancestor level', async () => {
  const server = await startFixtureServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);

    const before = await page.evaluate(serializeDom, '#cta');
    const wrap = cosmeticMutations.find((m) => m.id === 'wrap-element');
    await page.evaluate(wrap.apply, '#cta');
    const after = await page.evaluate(serializeDom, '#cta');

    const beforeCta = findNode(before.tree, byId('cta'));
    const afterCta = findNode(after.tree, byId('cta'));
    assert.equal(afterCta.path.length, beforeCta.path.length + 1);
  } finally {
    await browser.close();
    await server.close();
  }
});
