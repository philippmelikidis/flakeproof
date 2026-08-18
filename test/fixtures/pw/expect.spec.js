import { test, expect } from '@playwright/test';

test('expect timeout fixture', async ({ page }) => {
  await page.goto(process.env.FIXTURE_URL);
  await expect(page.locator('#does-not-exist')).toBeVisible({ timeout: 1500 });
});
