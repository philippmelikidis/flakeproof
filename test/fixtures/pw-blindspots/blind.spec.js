import { test as base, expect } from '@playwright/test';
import { withTemporal } from '../../../src/inject/playwright.js';

const test = withTemporal(base);

// Deliberately asserts on something the change-text mutation to
// #header-title never touches: the whole point of this fixture is a suite
// that stays green while the page under it silently changed.
test('page loads', async ({ page }) => {
  await page.goto(process.env.FIXTURE_URL);
  await expect(page).toHaveTitle('flakeproof blindspots fixture');
});
