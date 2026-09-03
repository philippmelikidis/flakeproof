import { test as base, expect } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { withTemporal } from '../../../src/inject/playwright.js';

const test = withTemporal(base);

// Real reproduction of the audit's Fix 3 finding: two REAL runs of the same
// (selector, mutation) round genuinely disagreeing on `survived`. A counter
// file (written by this spec itself, not the browser) makes which fixture
// page gets loaded deterministic per run: the first run hits the hydration
// fixture (reverts #header-title at 50ms -> survived: false), the second
// hits the plain fixture (never reverts -> survived: true). The assertion
// is on the page <title> - identical on both fixture pages, and untouched
// by the mutation either way - so both runs are GREEN regardless of which
// page loaded, isolating the survived disagreement from any difference in
// whether the suite went red.
test('page loads', async ({ page }) => {
  const counterFile = process.env.FP_DISAGREE_COUNTER;
  // Only mutation rounds consume the counter - the control pass (no
  // FLAKEPROOF_MUTATION_ID set) also runs this same spec twice and must not
  // steal a slot from it, or the two mutation-round runs would both land on
  // the same fixture page.
  let url = process.env.FIXTURE_URL;
  if (counterFile && process.env.FLAKEPROOF_MUTATION_ID) {
    let n = 0;
    if (existsSync(counterFile)) n = Number(readFileSync(counterFile, 'utf8'));
    writeFileSync(counterFile, String(n + 1));
    url = n === 0 ? `${process.env.FIXTURE_URL}hydrate.html` : process.env.FIXTURE_URL;
  }
  await page.goto(url);
  await expect(page).toHaveTitle(/flakeproof blindspots/);
  // Keep the page open past both SETTLE_MS (300ms) and the hydration
  // fixture's own 50ms revert, so the wrapper actually gets a chance to
  // observe and report a definite survived state on both runs - otherwise
  // this reproduction would conflate "the page closed too fast to tell"
  // (a separate, honest "unknown" outcome) with the disagreement this test
  // is specifically about.
  await page.waitForTimeout(400);
});
