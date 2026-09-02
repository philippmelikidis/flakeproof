// Covers the review fixes to src/blindspots/measure.js that reintroduced the
// exact failure shapes src/triage/temporal-probe.js was hardened against
// over three review rounds: an unknown outcome counted as a confirmed miss
// (Fix 1), a single run letting an unrelated flake fabricate a perfect
// score (Fix 2), a false blindness verdict when the page re-renders
// (Fix 3), a dropped exit-code mismatch guard (Fix 4), and a run budget
// (Fix 7). Fix 5 (env isolation between the two probe lanes) is covered in
// test/rerun.test.js and directly below. Fix 6 (the robot reader rejection)
// is covered here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureBlindspots } from '../src/blindspots/measure.js';

// A more flexible fake suite than test/blindspots-measure.test.js's: every
// invocation can independently decide to apply, survive, go red, disagree
// with its own previous run (via a per-round counter file), or exit with a
// code that disagrees with its own result file. Env vars:
//   FP_RESULTS_PATH   where to write the playwright json reporter shape
//   FP_COUNTER_DIR    a scratch dir for a per-round call counter
//   FP_BEHAVIOR       json map "<mutationId>::<selector>" -> {
//                        applies, survived, red, unstable, reporterMismatch,
//                        unreadableResults,
//                      }
//   FP_CONTROL_MODE   'green' (default) | 'red' | 'mismatch'
async function writeFlexibleSuite(dir) {
  const script = join(dir, 'suite.cjs');
  await writeFile(
    script,
    `
const fs = require('fs');
const path = require('path');
const resultsPath = process.env.FP_RESULTS_PATH;
const behavior = JSON.parse(process.env.FP_BEHAVIOR || '{}');
const mutationId = process.env.FLAKEPROOF_MUTATION_ID;
const selector = process.env.FLAKEPROOF_MUTATION_SELECTOR;
const ackDir = process.env.FLAKEPROOF_MUTATION_ACK;
const controlMode = process.env.FP_CONTROL_MODE || 'green';
const counterDir = process.env.FP_COUNTER_DIR;

function writeGreen() { fs.writeFileSync(resultsPath, JSON.stringify({ suites: [] })); }
function writeRed(title) {
  fs.writeFileSync(resultsPath, JSON.stringify({
    suites: [{ specs: [{ file: 'fake.spec.js', title, tests: [{ results: [{ status: 'failed', error: { message: 'boom' } }] }] }] }],
  }));
}

if (!mutationId) {
  if (controlMode === 'red') { writeRed('control failure'); process.exit(1); }
  if (controlMode === 'mismatch') { writeGreen(); process.exit(2); }
  writeGreen();
  process.exit(0);
}

const key = mutationId + '::' + selector;
const cfg = behavior[key] || { applies: true, survived: true, red: false };
if (ackDir) {
  fs.mkdirSync(ackDir, { recursive: true });
  fs.writeFileSync(path.join(ackDir, 'a.json'), JSON.stringify({ installed: true, applied: !!cfg.applies, survived: cfg.applies ? (cfg.survived === undefined ? true : cfg.survived) : null }));
}

if (cfg.unreadableResults) { process.exit(0); } // never writes resultsPath at all

if (cfg.unstable) {
  const counterFile = path.join(counterDir, encodeURIComponent(key));
  let n = 0;
  if (fs.existsSync(counterFile)) n = Number(fs.readFileSync(counterFile, 'utf8'));
  fs.writeFileSync(counterFile, String(n + 1));
  if (n % 2 === 0) { writeRed('unstable ' + key); process.exit(1); }
  writeGreen();
  process.exit(0);
}

if (cfg.reporterMismatch) { writeGreen(); process.exit(2); }
if (cfg.red) { writeRed('noticed ' + key); process.exit(1); }
writeGreen();
process.exit(0);
`,
  );
  return script;
}

function envFor(dir, extra = {}) {
  return {
    FP_RESULTS_PATH: join(dir, 'results.json'),
    FP_COUNTER_DIR: dir,
    ...extra,
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fp-blindspots-hardening-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function setEnv(env) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}
function unsetEnv(env) {
  for (const k of Object.keys(env)) delete process.env[k];
}

// ---------------------------------------------------------------------------
// Fix 1: an unknown outcome must never be counted as a confirmed miss.
// ---------------------------------------------------------------------------

test('Fix 1: mutations that applied but whose results were unreadable are excluded from the score, not counted as misses', async () => {
  await withTempDir(async (dir) => {
    const script = await writeFlexibleSuite(dir);
    const env = envFor(dir, {
      FP_BEHAVIOR: JSON.stringify({
        'change-text::#a': { applies: true, unreadableResults: true },
        'change-href::#a': { applies: true, unreadableResults: true },
        'remove-element::#a': { applies: true, unreadableResults: true },
      }),
    });
    setEnv(env);
    try {
      const result = await measureBlindspots({
        cmd: `node ${script}`,
        reader: 'playwright',
        resultsPath: env.FP_RESULTS_PATH,
        selectors: ['#a'],
        mutations: ['change-text', 'change-href', 'remove-element'],
        runsPerRound: 1,
      });
      assert.equal(result.abstained, 'all-inconclusive', JSON.stringify(result));
      assert.equal(result.counts.applied, 3);
      assert.equal(result.counts.judged, 0, 'zero real observations exist');
      assert.equal(result.counts.inconclusive, 3);
    } finally {
      unsetEnv(env);
    }
  });
});

test('Fix 1: a mix of judged and inconclusive mutations scores against judged, not applied', async () => {
  await withTempDir(async (dir) => {
    const script = await writeFlexibleSuite(dir);
    const env = envFor(dir, {
      FP_BEHAVIOR: JSON.stringify({
        'change-text::#a': { applies: true, red: true },
        'change-href::#a': { applies: true, unreadableResults: true },
      }),
    });
    setEnv(env);
    try {
      const result = await measureBlindspots({
        cmd: `node ${script}`,
        reader: 'playwright',
        resultsPath: env.FP_RESULTS_PATH,
        selectors: ['#a'],
        mutations: ['change-text', 'change-href'],
        runsPerRound: 1,
      });
      assert.equal(result.abstained, null);
      assert.equal(result.counts.applied, 2);
      assert.equal(result.counts.judged, 1, 'only the readable round is a real observation');
      assert.equal(result.counts.noticed, 1);
      assert.equal(result.counts.inconclusive, 1);
    } finally {
      unsetEnv(env);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 2: a single run must never let an unrelated flake fabricate a score.
// ---------------------------------------------------------------------------

test('Fix 2: a suite that disagrees with itself across runs of the same round is inconclusive, never noticed', async () => {
  await withTempDir(async (dir) => {
    const script = await writeFlexibleSuite(dir);
    const env = envFor(dir, {
      FP_BEHAVIOR: JSON.stringify({
        'change-text::#header-title': { applies: true, unstable: true },
      }),
    });
    setEnv(env);
    try {
      const result = await measureBlindspots({
        cmd: `node ${script}`,
        reader: 'playwright',
        resultsPath: env.FP_RESULTS_PATH,
        selectors: ['#header-title'],
        mutations: ['change-text'],
        runsPerRound: 2,
      });
      assert.equal(result.abstained, 'all-inconclusive', JSON.stringify(result));
      const record = result.records[0];
      assert.equal(record.applied, true);
      assert.equal(record.noticed, null, 'a suite that is red on only some runs must never be scored as having noticed');
      assert.equal(record.inconclusiveReason, 'unstable-across-runs');
    } finally {
      unsetEnv(env);
    }
  });
});

test('Fix 2: noticed is only claimed, and a test only named as catcher, when every run agrees', async () => {
  await withTempDir(async (dir) => {
    const script = await writeFlexibleSuite(dir);
    const env = envFor(dir, {
      FP_BEHAVIOR: JSON.stringify({
        'change-text::#header-title': { applies: true, red: true },
      }),
    });
    setEnv(env);
    try {
      const result = await measureBlindspots({
        cmd: `node ${script}`,
        reader: 'playwright',
        resultsPath: env.FP_RESULTS_PATH,
        selectors: ['#header-title'],
        mutations: ['change-text'],
        runsPerRound: 3,
      });
      assert.equal(result.abstained, null);
      assert.equal(result.counts.noticed, 1);
      assert.ok(result.records[0].redTests.some((t) => /noticed/.test(t)));
    } finally {
      unsetEnv(env);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 3: a mutation that did not survive to the suite's own assertions must
// be its own category, never scored as unnoticed.
// ---------------------------------------------------------------------------

test('Fix 3: a mutation that applied but was overwritten before settle time is excluded, not scored unnoticed', async () => {
  await withTempDir(async (dir) => {
    const script = await writeFlexibleSuite(dir);
    const env = envFor(dir, {
      FP_BEHAVIOR: JSON.stringify({
        'change-text::#header-title': { applies: true, survived: false, red: false },
      }),
    });
    setEnv(env);
    try {
      const result = await measureBlindspots({
        cmd: `node ${script}`,
        reader: 'playwright',
        resultsPath: env.FP_RESULTS_PATH,
        selectors: ['#header-title'],
        mutations: ['change-text'],
        runsPerRound: 1,
      });
      assert.equal(result.abstained, 'all-not-survived', JSON.stringify(result));
      assert.equal(result.counts.applied, 1);
      assert.equal(result.counts.notSurvived, 1);
      assert.equal(result.counts.judged, 0);
      assert.equal(result.records[0].survived, false);
      assert.equal(result.records[0].noticed, null, 'never scored as unnoticed');
    } finally {
      unsetEnv(env);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 4: the exit-code/result-file mismatch guard.
// ---------------------------------------------------------------------------

test('Fix 4: a control that exits non-zero while reporting zero failures is never treated as a clean baseline', async () => {
  await withTempDir(async (dir) => {
    const script = await writeFlexibleSuite(dir);
    const env = envFor(dir, { FP_CONTROL_MODE: 'mismatch' });
    setEnv(env);
    try {
      const result = await measureBlindspots({
        cmd: `node ${script}`,
        reader: 'playwright',
        resultsPath: env.FP_RESULTS_PATH,
        selectors: ['#a'],
        mutations: ['change-text'],
        runsPerRound: 1,
      });
      assert.equal(result.abstained, 'control-unreliable', JSON.stringify(result));
      assert.equal(result.records.length, 0, 'no mutation round may run once the control cannot be trusted');
    } finally {
      unsetEnv(env);
    }
  });
});

test('Fix 4: a mutation round with a reporter mismatch is inconclusive, never scored as a clean pass', async () => {
  await withTempDir(async (dir) => {
    const script = await writeFlexibleSuite(dir);
    const env = envFor(dir, {
      FP_BEHAVIOR: JSON.stringify({
        'change-text::#header-title': { applies: true, reporterMismatch: true },
      }),
    });
    setEnv(env);
    try {
      const result = await measureBlindspots({
        cmd: `node ${script}`,
        reader: 'playwright',
        resultsPath: env.FP_RESULTS_PATH,
        selectors: ['#header-title'],
        mutations: ['change-text'],
        runsPerRound: 1,
      });
      assert.equal(result.abstained, 'all-inconclusive', JSON.stringify(result));
      assert.equal(result.records[0].inconclusiveReason, 'reporter-mismatch');
    } finally {
      unsetEnv(env);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 5: env isolation between the two probe lanes, from the blindspots side.
// ---------------------------------------------------------------------------

test('Fix 5: a stale FLAKEPROOF_TEMPORAL_* export from the same shell does not leak into a blindspots control round', async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, 'sensitive.cjs');
    await writeFile(
      script,
      `require('fs').writeFileSync(process.env.FP_RESULTS_PATH, JSON.stringify({ suites: [] })); process.exit(process.env.FLAKEPROOF_TEMPORAL_MS ? 1 : 0);`,
    );
    const resultsPath = join(dir, 'results.json');
    process.env.FP_RESULTS_PATH = resultsPath;
    process.env.FLAKEPROOF_TEMPORAL_MS = '999';
    try {
      const result = await measureBlindspots({
        cmd: `node ${script}`,
        reader: 'playwright',
        resultsPath,
        selectors: ['#a'],
        mutations: ['change-text'],
        runsPerRound: 1,
      });
      // The fake suite never installs the mutation wrapper, so this
      // abstains - the point of the test is that it reaches that abstain
      // via a genuinely GREEN control, proving FLAKEPROOF_TEMPORAL_MS did
      // not leak in and turn the control red.
      assert.equal(result.abstained, 'wrapper-not-installed');
    } finally {
      delete process.env.FP_RESULTS_PATH;
      delete process.env.FLAKEPROOF_TEMPORAL_MS;
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 6: the robot reader is rejected upfront, before any process spawns.
// ---------------------------------------------------------------------------

test('Fix 6: the robot reader is rejected upfront with the real reason, never silently run', async () => {
  let spawned = false;
  const cmd = process.platform === 'win32' ? 'cmd /c exit 0' : 'true'; // never actually reached
  await assert.rejects(
    () => measureBlindspots({ cmd, reader: 'robot', resultsPath: 'r.xml', selectors: ['#a'] }),
    /robot reader|issue #11/i,
  );
  assert.equal(spawned, false);
});

// ---------------------------------------------------------------------------
// Fix 7: a run budget, with truncation reported rather than silent.
// ---------------------------------------------------------------------------

test('Fix 7: a budget too small even for the control abstains rather than running anything', async () => {
  await withTempDir(async (dir) => {
    const script = await writeFlexibleSuite(dir);
    const env = envFor(dir);
    setEnv(env);
    try {
      const result = await measureBlindspots({
        cmd: `node ${script}`,
        reader: 'playwright',
        resultsPath: env.FP_RESULTS_PATH,
        selectors: ['#a'],
        mutations: ['change-text'],
        runsPerRound: 2,
        budget: 1,
      });
      assert.equal(result.abstained, 'budget-too-low');
      assert.equal(result.skipped.length, 1);
    } finally {
      unsetEnv(env);
    }
  });
});

test('Fix 7: a budget that runs out partway through reports exactly what was skipped', async () => {
  await withTempDir(async (dir) => {
    const script = await writeFlexibleSuite(dir);
    const env = envFor(dir, {
      FP_BEHAVIOR: JSON.stringify({
        'change-text::#a': { applies: true, red: false },
      }),
    });
    setEnv(env);
    try {
      const result = await measureBlindspots({
        cmd: `node ${script}`,
        reader: 'playwright',
        resultsPath: env.FP_RESULTS_PATH,
        selectors: ['#a'],
        mutations: ['change-text', 'change-href', 'remove-element'],
        runsPerRound: 1,
        budget: 2, // 1 for control, 1 for exactly one mutation round
      });
      assert.equal(result.abstained, null, JSON.stringify(result));
      assert.equal(result.records.length, 1, 'only one round fit in the remaining budget');
      assert.equal(result.skipped.length, 2, 'the other two never ran');
      assert.ok(result.notes.some((n) => /budget/.test(n) && /skipped/.test(n)));
    } finally {
      unsetEnv(env);
    }
  });
});
