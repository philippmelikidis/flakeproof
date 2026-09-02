import { test as base, expect } from '@playwright/test';
import { withTemporal } from '../../../src/inject/playwright.js';

const test = withTemporal(base);

// Same assertion as notices.spec.js and notices-hydrate.spec.js - this suite
// IS sensitive to the mutated text - but against a page that reverts
// #header-title at 900ms, well past the old fixed SETTLE_MS window (300ms).
// This is the second review round's exact reproduction (see
// test/fixtures/blindspots-page/hydrate-late.html): before the fix, the
// observer disconnected after the 300ms settle report, so this revert was
// never seen and a demonstrably sensitive suite was reported as blind.
test('shows the header title', async ({ page }) => {
  await page.goto(`${process.env.FIXTURE_URL}hydrate-late.html`);
  await expect(page.locator('#header-title')).toHaveText('Welcome to Acme');
});
