// Real, end-to-end proof for issue #11: an actual Robot Framework Browser
// Library suite, run through the actual `robot` binary with
// rf/FlakeproofTemporalListener.py attached, reproduces a timing failure
// deterministically through the SAME temporalProbe() used for Playwright -
// no changes to temporal-probe.js were needed, because the listener writes
// the identical ack shape src/inject/playwright.js already does.
//
// Requires the project's Python virtualenv (`.venv`) with Robot Framework
// and the Browser library installed - already part of this repository's
// checked-in dev setup (see test/fixtures/rf/ for the existing adapter
// fixtures captured the same way).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startFixtureServer } from './helpers/serve.js';
import { rerunStats } from '../src/triage/rerun.js';
import { temporalProbe } from '../src/triage/temporal-probe.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROBOT_BIN = join(ROOT, '.venv', 'bin', 'robot');
const LISTENER = join(ROOT, 'rf', 'FlakeproofTemporalListener.py');
const SUITE = join(ROOT, 'test', 'fixtures', 'rf-temporal', 'flaky.robot');
const RUN_ISOLATED = join(ROOT, 'test', 'fixtures', 'rf-temporal', 'run-isolated.sh');

const canRun = existsSync(ROBOT_BIN);
// run-isolated.sh gives every single invocation of this command its own
// fresh --outputdir and deletes it afterward. This command runs several
// times back to back (a control round plus one round per delay), and
// reusing one fixed --outputdir across those invocations was an observed
// source of a spurious "invalid data" exit (252) from Robot Framework when
// this test ran alongside the rest of the suite's many other real-browser
// tests under heavy system load - see run-isolated.sh's own header comment.
const COMMAND = `"${RUN_ISOLATED}" "${ROBOT_BIN}" "${LISTENER}" "${SUITE}"`;

test('rf temporal listener reproduces a timing failure in a real robot run', { skip: !canRun && 'no .venv/bin/robot in this checkout' }, async () => {
  const server = await startFixtureServer();
  process.env.FIXTURE_URL = server.url;
  try {
    const clean = await rerunStats(COMMAND, 1);
    assert.equal(clean.failures, 0, 'suite must pass without temporal delay (2500ms budget, no injection)');

    // A wide margin over the suite's own 2500ms wait budget - both numbers
    // generous on purpose, since this runs as part of a suite that launches
    // many real browsers in parallel (Playwright, Puppeteer, Selenium's
    // ChromeDriver, this RF/Browser-Library session): under that contention
    // even the CONTROL run can take noticeably longer than it does in
    // isolation, and a tight budget here would make this proof of a
    // deterministic reproduction flaky in exactly the way this whole tool
    // exists to catch. 6500ms leaves ample room over 2500ms even under load.
    const result = await temporalProbe(COMMAND, '#cta', { delays: [6500], runsPerDelay: 1 });
    assert.equal(result.reproduced, true, 'a 6500ms delay against a 2500ms budget must fail deterministically');
    assert.equal(result.delay, 6500);
    assert.equal(result.injected, true, 'the listener must acknowledge installation');
    assert.equal(result.matched, 1, 'the listener must report the delay rule matched the one #cta element');
    assert.equal(result.ruleLive, true);
  } finally {
    delete process.env.FIXTURE_URL;
    await server.close();
  }
});
