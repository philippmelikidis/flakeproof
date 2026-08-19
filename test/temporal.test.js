import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { temporalScript } from '../src/probe/temporal.js';

test('temporalScript hides the element and releases it after the delay', async () => {
  const server = await startFixtureServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addInitScript(temporalScript('#cta', 800));
    const page = await context.newPage();
    const t0 = Date.now();
    await page.goto(server.url);
    assert.equal(await page.locator('#cta').isVisible(), false, 'must start hidden');
    await page.locator('#cta').waitFor({ state: 'visible', timeout: 5000 });
    assert.ok(Date.now() - t0 >= 400, 'must stay hidden for a meaningful part of the delay');
  } finally {
    await browser.close();
    await server.close();
  }
});
