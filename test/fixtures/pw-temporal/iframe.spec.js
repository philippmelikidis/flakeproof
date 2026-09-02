import { test as base, expect } from '@playwright/test';
import { withTemporal } from '../../../src/inject/playwright.js';

const test = withTemporal(base);

// addInitScript runs in EVERY frame, including the iframe, so this page
// exercises the real multi-writer path: the outer page reports a genuine
// #cta match, the inner iframe reports a genuine zero, and neither must
// suppress the other's receipt (Fix 1 in the review).
test('cta appears quickly despite a sibling iframe', async ({ page }) => {
  await page.goto(`${process.env.FIXTURE_URL}iframe-outer.html`);
  await expect(page.locator('#cta')).toBeVisible({ timeout: 400 });
});
