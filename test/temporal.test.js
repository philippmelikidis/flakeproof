import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { temporalScript } from '../src/probe/temporal.js';

// Fix 2 (review, CRITICAL): a count taken only once, at DOMContentLoaded, is
// blind to a single-page app that inserts its anchor later - the css rule
// still applies to it (visibility rules are continuous, not one-shot), but
// nothing was ever reported after it appeared. This pins the fix directly:
// the anchor is inserted 150ms after DOMContentLoaded, well inside a 400ms
// delay window, so the DOMContentLoaded report must see 0 (honest - it
// really does not exist yet) while the end-of-window recount, immediately
// before the style is removed, must see it and confirm the rule was live.
test('temporalScript recounts at the end of the delay window, catching an anchor inserted later', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const context = await browser.newContext();
    const calls = [];
    await context.exposeFunction('__flakeproofTemporalMatchCount', (count, ruleLive) => {
      calls.push({ count, ruleLive });
    });
    // Simulate an SPA: the anchor does not exist at DOMContentLoaded, only
    // appearing 150ms afterwards.
    /* eslint-disable no-undef */
    await context.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
          const late = document.createElement('a');
          late.id = 'late-cta';
          document.documentElement.appendChild(late);
        }, 150);
      });
    });
    /* eslint-enable no-undef */
    await context.addInitScript(temporalScript('#late-cta', 400));
    const page = await context.newPage();
    await page.goto(server.url);
    await page.waitForTimeout(700);
    assert.ok(
      calls.length >= 2,
      `expected the DOMContentLoaded report and the end-of-window recount, got ${JSON.stringify(calls)}`,
    );
    assert.equal(calls[0].count, 0, 'at DOMContentLoaded the late element genuinely does not exist yet');
    const last = calls.at(-1);
    assert.equal(last.count, 1, 'the end-of-window recount must see the element inserted at 150ms');
    assert.equal(last.ruleLive, true, 'the rule must be confirmed live at the moment it matched');
  } finally {
    await browser?.close();
    await server?.close();
  }
});

test('temporalScript hides the element and releases it after the delay', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.addInitScript(temporalScript('#cta', 800));
    const page = await context.newPage();
    const t0 = Date.now();
    await page.goto(server.url);
    assert.equal(await page.locator('#cta').isVisible(), false, 'must start hidden');
    await page.locator('#cta').waitFor({ state: 'visible', timeout: 5000 });
    assert.ok(Date.now() - t0 >= 400, 'must stay hidden for a meaningful part of the delay');
  } finally {
    await browser?.close();
    await server?.close();
  }
});
