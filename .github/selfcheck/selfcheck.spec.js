// Deliberately fragile on purpose. It pins a build-generated class name,
// which is exactly the habit flakeproof exists to catch. The workflow serves
// the "before" page while the baseline is recorded and the "after" page when
// this runs, so the class is gone by the time the assertion happens and the
// test goes red for a reason that is not a real defect.
//
// This is flakeproof's own gate, running against flakeproof: the pull
// request comment it produces is the proof that the composite action works
// on GitHub's runner, not only in the unit tests.
import { test, expect } from '@playwright/test';

test('the first navigation item is reachable', async ({ page }) => {
  await page.goto(process.env.FIXTURE_URL);
  await expect(page.locator('li.css-1a2b3c')).toBeVisible({ timeout: 2000 });
});
