import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './helpers/serve.js';
import { rerunStats } from '../src/triage/rerun.js';
import { temporalProbe } from '../src/triage/temporal-probe.js';

const COMMAND = 'npx playwright test --config test/fixtures/pw-temporal/playwright.config.js';
const IFRAME_COMMAND = `${COMMAND} test/fixtures/pw-temporal/iframe.spec.js`;
const SPA_COMMAND = `${COMMAND} test/fixtures/pw-temporal/spa.spec.js`;

test('temporal probe reproduces a timing failure in a real playwright run', async () => {
  const server = await startFixtureServer();
  process.env.FIXTURE_URL = server.url;
  try {
    const clean = await rerunStats(COMMAND, 1);
    assert.equal(clean.failures, 0, 'spec must pass without temporal delay');

    const result = await temporalProbe(COMMAND, '#cta', { delays: [1000], runsPerDelay: 1 });
    assert.equal(result.reproduced, true, 'a 1000 ms delay against a 400 ms budget must fail deterministically');
    assert.equal(result.delay, 1000);
    assert.equal(result.injected, true, 'the real wrapper must acknowledge');
    assert.equal(result.matched, 1, 'the real wrapper must report that the delay rule matched the one #cta element');
  } finally {
    delete process.env.FIXTURE_URL;
    await server.close();
  }
});

// Real multi-writer scenario: addInitScript runs in every frame, so the
// outer page and the inner iframe each report independently. The iframe's
// genuine zero must never suppress the outer page's genuine match (Fix 1 in
// the review).
test('temporal probe reproduces despite a sibling iframe reporting zero', async () => {
  const server = await startFixtureServer();
  process.env.FIXTURE_URL = server.url;
  try {
    const clean = await rerunStats(IFRAME_COMMAND, 1);
    assert.equal(clean.failures, 0, 'spec must pass without temporal delay');

    const result = await temporalProbe(IFRAME_COMMAND, '#cta', { delays: [1000], runsPerDelay: 1 });
    assert.equal(result.reproduced, true);
    assert.equal(result.injected, true);
    assert.equal(result.matched, 1, "the iframe's genuine zero must not erase the outer page's genuine match");
    assert.equal(result.ruleLive, true);
  } finally {
    delete process.env.FIXTURE_URL;
    await server.close();
  }
});

// Real SPA-recount scenario (Fix 2 in the review): #cta does not exist at
// DOMContentLoaded, only appearing 300ms later. Only the end-of-window
// recount can see it, and only if the delay rule is still live at insertion
// time.
test('temporal probe reproduces a failure whose anchor is inserted after DOMContentLoaded', async () => {
  const server = await startFixtureServer();
  process.env.FIXTURE_URL = server.url;
  try {
    const clean = await rerunStats(SPA_COMMAND, 1);
    assert.equal(clean.failures, 0, 'spec must pass without temporal delay (600ms budget, cta inserted at 300ms)');

    const result = await temporalProbe(SPA_COMMAND, '#cta', { delays: [1000], runsPerDelay: 1 });
    assert.equal(result.reproduced, true, 'a delay still live past the 600ms budget must fail deterministically');
    assert.equal(result.injected, true);
    assert.equal(result.matched, 1, 'the end-of-window recount must catch the anchor inserted at 300ms');
    assert.equal(result.ruleLive, true);
  } finally {
    delete process.env.FIXTURE_URL;
    await server.close();
  }
});

test('temporal probe against a target that matches nothing never claims a reproduction', async () => {
  const server = await startFixtureServer();
  process.env.FIXTURE_URL = server.url;
  try {
    // #does-not-exist is a perfectly valid css selector, it just never
    // matches on the fixture page: the delay style is live but has nothing
    // to hide, so the spec's own #cta assertion is unaffected and always
    // passes.
    const result = await temporalProbe(COMMAND, '#does-not-exist', { delays: [250, 500], runsPerDelay: 1 });
    assert.equal(result.reproduced, false);
    assert.equal(result.injected, true, 'the real wrapper must still acknowledge installation');
    assert.equal(result.matched, 0, 'the real wrapper must report a confirmed zero, not unknown');
  } finally {
    delete process.env.FIXTURE_URL;
    await server.close();
  }
});
