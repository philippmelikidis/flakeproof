import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startFixtureServer } from './helpers/serve.js';
import { measureBlindspots } from '../src/blindspots/measure.js';

const here = dirname(fileURLToPath(import.meta.url));
const pageRoot = join(here, 'fixtures', 'blindspots-page');
const configPath = join(here, 'fixtures', 'pw-blindspots', 'playwright.config.js');
const resultsPath = join(here, 'fixtures', 'pw-blindspots', 'results.json');
const COMMAND = (spec) => `npx playwright test --config ${configPath} ${spec}`;

// This is the whole point of the feature: prove it against a REAL suite run,
// not a stub of the runner. The fixture page's #header-title is changed by
// the change-text mutation; one suite asserts on exactly that text (must go
// red -> noticed), the other suite only asserts on the page <title> tag,
// which the mutation never touches (must stay green -> unnoticed).

test('a suite that asserts on the mutated text notices change-text', async () => {
  let server = null;
  try {
    server = await startFixtureServer({ root: pageRoot });
    process.env.FIXTURE_URL = server.url;
    const result = await measureBlindspots({
      cmd: COMMAND(join(here, 'fixtures', 'pw-blindspots', 'notices.spec.js')),
      reader: 'playwright',
      resultsPath,
      selectors: ['#header-title'],
      mutations: ['change-text'],
      // A single run per round here: this test is proving the base
      // categorization against a real browser, not the multi-run agreement
      // discipline (that has its own fast, deterministic coverage in
      // test/blindspots-measure-hardening.test.js) - pinning this keeps a
      // real-browser test from silently doubling in cost every time the
      // library's own default changes.
      runsPerRound: 1,
    });
    assert.equal(result.abstained, null, JSON.stringify(result));
    assert.equal(result.counts.attempted, 1);
    assert.equal(result.counts.applied, 1);
    assert.equal(result.counts.noticed, 1, 'a suite asserting on the mutated text must go red');
    assert.equal(result.counts.unnoticed, 0);
    const record = result.records[0];
    assert.equal(record.target, '#header-title');
    assert.equal(record.applied, true);
    assert.equal(record.noticed, true);
    assert.ok(record.redTests.some((t) => /shows the header title/.test(t)), JSON.stringify(record.redTests));
  } finally {
    delete process.env.FIXTURE_URL;
    await server?.close();
    await rm(resultsPath, { force: true });
  }
});

// This is the audit's flagship reproduction for Fix 4: blind.spec.js's own
// assertion (on the page <title>, never the mutated element) is satisfied
// almost instantly, so the page closes before flakeproof's wrapper gets a
// chance to report any final survived state at all (no settle report, no
// teardown hook - Chromium's CDP-driven page close does not reliably run
// those). Before the fix, `survived: null` here was silently treated as
// "tested against, and unnoticed" - a real blind spot, but for the wrong,
// dishonest reason (silence read as confirmation, not because the suite was
// actually shown to be blind). The suite genuinely never got a fair look at
// this change, so flakeproof must abstain instead of guessing a score.
test('a suite whose page closes before any survival report can land abstains instead of guessing "unnoticed"', async () => {
  let server = null;
  try {
    server = await startFixtureServer({ root: pageRoot });
    process.env.FIXTURE_URL = server.url;
    const result = await measureBlindspots({
      cmd: COMMAND(join(here, 'fixtures', 'pw-blindspots', 'blind.spec.js')),
      reader: 'playwright',
      resultsPath,
      selectors: ['#header-title'],
      mutations: ['change-text'],
      runsPerRound: 1,
    });
    assert.equal(result.abstained, 'all-survival-unknown', JSON.stringify(result));
    assert.equal(result.counts.attempted, 1);
    assert.equal(result.counts.applied, 1, 'the mutation genuinely reached the page and applied');
    assert.equal(result.counts.survivalUnknown, 1);
    assert.equal(result.counts.judged, 0, 'never scored as noticed or unnoticed - silence is not proof either way');
    const record = result.records[0];
    assert.equal(record.applied, true);
    assert.equal(record.survived, null);
    assert.equal(record.survivalUnknown, true);
    assert.equal(record.noticed, null);
  } finally {
    delete process.env.FIXTURE_URL;
    await server?.close();
    await rm(resultsPath, { force: true });
  }
});

// Fix 3's exact reproduction, run for real: a suite that IS sensitive to the
// mutated text (identical assertion to notices.spec.js above) must never be
// scored as blind just because an ordinary client-side re-render (see
// test/fixtures/blindspots-page/hydrate.html - rewrites #header-title 50ms
// after DOMContentLoaded) undid the mutation before the assertion ran.
test('a suite sensitive to the mutation is never scored as blind when hydration undoes the mutation first', async () => {
  let server = null;
  try {
    server = await startFixtureServer({ root: pageRoot });
    process.env.FIXTURE_URL = server.url;
    const result = await measureBlindspots({
      cmd: COMMAND(join(here, 'fixtures', 'pw-blindspots', 'notices-hydrate.spec.js')),
      reader: 'playwright',
      resultsPath,
      selectors: ['#header-title'],
      mutations: ['change-text'],
      runsPerRound: 1,
    });
    assert.equal(result.abstained, 'all-not-survived', JSON.stringify(result));
    assert.equal(result.counts.applied, 1, 'the mutation did genuinely apply at DOMContentLoaded');
    assert.equal(result.counts.notSurvived, 1);
    assert.equal(result.counts.judged, 0);
    const record = result.records[0];
    assert.equal(record.applied, true);
    assert.equal(record.survived, false);
    assert.equal(record.noticed, null, 'never scored as unnoticed - the suite never got a fair look at it');
  } finally {
    delete process.env.FIXTURE_URL;
    await server?.close();
    await rm(resultsPath, { force: true });
  }
});

// The second review round's exact reproduction: a revert landing at 900ms,
// well past the old fixed SETTLE_MS window (300ms, see
// src/probe/mutation-script.js). Before the fix, the observer disconnected
// once the 300ms settle timer reported `survived: true`, so this later
// revert was never seen and this exact suite - genuinely sensitive to the
// mutated text - was reported as noticing 0 of 1 changes. The fix must
// watch for the page's whole lifetime, not a fixed window.
test('a suite sensitive to the mutation is never scored as blind when a revert lands well after the old fixed settle window', async () => {
  let server = null;
  try {
    server = await startFixtureServer({ root: pageRoot });
    process.env.FIXTURE_URL = server.url;
    const result = await measureBlindspots({
      cmd: COMMAND(join(here, 'fixtures', 'pw-blindspots', 'notices-hydrate-late.spec.js')),
      reader: 'playwright',
      resultsPath,
      selectors: ['#header-title'],
      mutations: ['change-text'],
      runsPerRound: 1,
    });
    assert.equal(result.abstained, 'all-not-survived', JSON.stringify(result));
    assert.equal(result.counts.applied, 1, 'the mutation did genuinely apply at DOMContentLoaded');
    assert.equal(result.counts.notSurvived, 1);
    assert.equal(result.counts.judged, 0);
    const record = result.records[0];
    assert.equal(record.applied, true);
    assert.equal(record.survived, false, 'the observer, not the old 300ms settle fallback, must have caught this revert');
    assert.equal(record.noticed, null, 'never scored as blind - the suite genuinely never got a fair look at it');
  } finally {
    delete process.env.FIXTURE_URL;
    await server?.close();
    await rm(resultsPath, { force: true });
  }
});

// Audit Fix 2's exact reproduction, run for real: a backend dependency that
// is unreachable during every mutation round (but not during the control
// pass) turns the suite red for a reason no mutation caused. `#header-title`
// genuinely applies change-text and would look "noticed" in isolation;
// `#does-not-exist` never applies at all, yet the suite is red there too -
// direct proof the redness is unrelated to any mutation. No round may be
// scored "noticed" once that proof exists.
test('a suite red for a reason unrelated to any mutation abstains instead of scoring a false perfect noticed count', async () => {
  let server = null;
  try {
    server = await startFixtureServer({ root: pageRoot });
    process.env.FIXTURE_URL = server.url;
    const result = await measureBlindspots({
      cmd: COMMAND(join(here, 'fixtures', 'pw-blindspots', 'checkout.spec.js')),
      reader: 'playwright',
      resultsPath,
      selectors: ['#header-title', '#does-not-exist'],
      mutations: ['change-text'],
      runsPerRound: 1,
    });
    assert.equal(result.abstained, 'red-unrelated-to-mutations', JSON.stringify(result));
    assert.match(result.reason, /does-not-exist/);
    assert.match(result.reason, /change-text/);
    assert.ok(!JSON.stringify(result).includes('"noticed":true'), 'nothing may be scored noticed once this confound is found');
  } finally {
    delete process.env.FIXTURE_URL;
    await server?.close();
    await rm(resultsPath, { force: true });
  }
});

// Audit Fix 3's exact reproduction, run for real: two genuine runs of the
// same (selector, mutation) round disagree on survived (one hits a fixture
// that reverts the mutation, the other a fixture that never does), while
// both are green on an assertion untouched by the mutation either way. The
// one run that positively observed the revert must exclude the round -
// never overridden by the other run's silence-turned-true.
test('one run observing a revert excludes the round for real, even when the other run of the same round disagrees', async () => {
  let server = null;
  let counterDir = null;
  try {
    server = await startFixtureServer({ root: pageRoot });
    process.env.FIXTURE_URL = server.url;
    counterDir = await mkdtemp(join(tmpdir(), 'fp-disagree-'));
    process.env.FP_DISAGREE_COUNTER = join(counterDir, 'counter');
    const result = await measureBlindspots({
      cmd: COMMAND(join(here, 'fixtures', 'pw-blindspots', 'notices-disagree.spec.js')),
      reader: 'playwright',
      resultsPath,
      selectors: ['#header-title'],
      mutations: ['change-text'],
      runsPerRound: 2,
    });
    assert.equal(result.abstained, 'all-not-survived', JSON.stringify(result));
    assert.equal(result.records[0].survived, false, 'the one positive observation of a revert must win');
    assert.equal(result.records[0].noticed, null);
  } finally {
    delete process.env.FIXTURE_URL;
    delete process.env.FP_DISAGREE_COUNTER;
    await server?.close();
    await rm(resultsPath, { force: true });
    if (counterDir) await rm(counterDir, { recursive: true, force: true });
  }
});
