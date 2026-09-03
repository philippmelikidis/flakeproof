import { test as base, expect } from '@playwright/test';
import { withTemporal } from '../../../src/inject/playwright.js';

const test = withTemporal(base);

// #cta is inserted 300ms after load (test/fixtures/page/spa.html) - it does
// not exist at DOMContentLoaded, so only the end-of-window recount (Fix 2 in
// the review) can ever see it if a delay rule is still live when it is
// inserted.
//
// Playwright tears the page down almost immediately once the test body
// returns or throws, so a temporal delay large enough to fail the 600ms
// budget below would otherwise be torn down before its own end-of-window
// recount (scheduled at that same delay) ever gets to fire. The pass/fail
// verdict is decided by the 600ms budget exactly as a real user's test
// would; afterwards, regardless of outcome, the page is kept alive past the
// delay's removal window purely so the recount can report real evidence
// before teardown - then the original verdict is preserved.
test('cta appears once the SPA inserts it', async ({ page }) => {
  await page.goto(`${process.env.FIXTURE_URL}spa.html`);
  const budgetMs = 600;
  const delayMs = Number(process.env.FLAKEPROOF_TEMPORAL_MS || 0);
  let failure = null;
  try {
    await expect(page.locator('#cta')).toBeVisible({ timeout: budgetMs });
  } catch (err) {
    failure = err;
  }
  if (delayMs > budgetMs) await page.waitForTimeout(delayMs - budgetMs + 100);
  if (failure) throw failure;
});
