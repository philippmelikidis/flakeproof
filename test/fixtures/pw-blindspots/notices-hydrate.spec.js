import { test as base, expect } from '@playwright/test';
import { withTemporal } from '../../../src/inject/playwright.js';

const test = withTemporal(base);

// Same assertion as notices.spec.js - this suite IS sensitive to the
// mutated text - but against the hydration fixture, where the page itself
// rewrites #header-title back to its original text 50ms after
// DOMContentLoaded (see test/fixtures/blindspots-page/hydrate.html). The
// mutation genuinely applied, but never survived to this assertion; a suite
// this sensitive must never be reported as blind (Fix 3 in the review).
test('shows the header title', async ({ page }) => {
  await page.goto(`${process.env.FIXTURE_URL}hydrate.html`);
  await expect(page.locator('#header-title')).toHaveText('Welcome to Acme');
});
