import { test as base, expect } from '@playwright/test';
import { withTemporal } from '../../../src/inject/playwright.js';

const test = withTemporal(base);

test('cta appears quickly', async ({ page }) => {
  await page.goto(process.env.FIXTURE_URL);
  await expect(page.locator('#cta')).toBeVisible({ timeout: 400 });
});
