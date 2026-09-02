import { test as base, expect } from '@playwright/test';
import { withTemporal } from '../../../src/inject/playwright.js';

const test = withTemporal(base);

test('shows the header title', async ({ page }) => {
  await page.goto(process.env.FIXTURE_URL);
  await expect(page.locator('#header-title')).toHaveText('Welcome to Acme');
});
