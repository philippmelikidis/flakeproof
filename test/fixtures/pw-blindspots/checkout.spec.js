import { test as base, expect } from '@playwright/test';
import { withTemporal } from '../../../src/inject/playwright.js';

const test = withTemporal(base);

// Reproduces the audit's Fix 2 finding for real: the control run (no
// mutation env vars set) only ever loads the real fixture page, so it is
// reliably green. Every mutation round also tries to reach a backend
// dependency at a port nothing listens on - modelling "a backend that went
// down" or "the injection itself breaking the suite" (the audit's own
// phrasing) - which fails with a real ERR_CONNECTION_REFUSED regardless of
// which mutation or selector was used, or whether that mutation ever
// touched the page at all.
test('completes checkout', async ({ page }) => {
  await page.goto(process.env.FIXTURE_URL);
  // Asserts on the page <title> only, deliberately untouched by any
  // semantic mutation in the catalog - so a failure here can only ever come
  // from the backend call below, never from noticing a mutation.
  await expect(page).toHaveTitle('flakeproof blindspots fixture');
  if (process.env.FLAKEPROOF_MUTATION_ID) {
    await page.evaluate(() =>
      fetch('http://127.0.0.1:1/backend').catch((err) => {
        throw new Error(`backend unreachable: ${err.message}`);
      }),
    );
  }
});
