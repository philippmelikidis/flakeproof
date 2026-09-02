import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureBlindspots } from '../src/blindspots/measure.js';

// A fake suite runner, standing in for a real Playwright command wrapped
// with withTemporal. Reads FP_RESULTS_PATH (where to write the playwright
// json reporter shape), FP_BEHAVIOR (a json-encoded map of
// "<mutationId>::<selector>" -> { applies, red }), and FP_CONTROL_RED
// (whether the control round, with no FLAKEPROOF_MUTATION_ID set, should
// fail). FP_NO_ACK skips writing any ack at all, simulating a suite that
// never installed the wrapper.
async function writeFakeSuite(dir) {
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
const controlRed = process.env.FP_CONTROL_RED === '1';
const noAck = process.env.FP_NO_ACK === '1';

function writeGreen() {
  fs.writeFileSync(resultsPath, JSON.stringify({ suites: [] }));
}
function writeRed(title) {
  fs.writeFileSync(resultsPath, JSON.stringify({
    suites: [{ specs: [{ file: 'fake.spec.js', title, tests: [{ results: [{ status: 'failed', error: { message: 'boom' } }] }] }] }],
  }));
}

if (!mutationId) {
  if (controlRed) { writeRed('control failure'); process.exit(1); }
  writeGreen();
  process.exit(0);
}

const key = mutationId + '::' + selector;
const cfg = behavior[key] || { applies: true, red: false };
if (!noAck && ackDir) {
  fs.mkdirSync(ackDir, { recursive: true });
  fs.writeFileSync(path.join(ackDir, 'a.json'), JSON.stringify({ installed: true, applied: !!cfg.applies }));
}
if (cfg.red) { writeRed('noticed ' + key); process.exit(1); }
writeGreen();
process.exit(0);
`,
  );
  return script;
}

test('a red control aborts before any mutation is attempted', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-blindspots-'));
    const script = await writeFakeSuite(dir);
    process.env.FP_RESULTS_PATH = join(dir, 'results.json');
    process.env.FP_CONTROL_RED = '1';
    const result = await measureBlindspots({
      cmd: `node ${script}`,
      reader: 'playwright',
      resultsPath: process.env.FP_RESULTS_PATH,
      selectors: ['#cta'],
      mutations: ['change-text'],
    });
    assert.equal(result.abstained, 'control-red');
    assert.equal(result.records.length, 0, 'no mutation round may run once the control is already red');
    assert.equal(result.counts, null);
  } finally {
    delete process.env.FP_RESULTS_PATH;
    delete process.env.FP_CONTROL_RED;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a missing wrapper refuses to score instead of reporting a false blind spot', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-blindspots-'));
    const script = await writeFakeSuite(dir);
    process.env.FP_RESULTS_PATH = join(dir, 'results.json');
    process.env.FP_NO_ACK = '1';
    const result = await measureBlindspots({
      cmd: `node ${script}`,
      reader: 'playwright',
      resultsPath: process.env.FP_RESULTS_PATH,
      selectors: ['#cta'],
      mutations: ['change-text'],
    });
    assert.equal(result.abstained, 'wrapper-not-installed');
    assert.equal(result.counts, null, 'no score is printed when the wrapper never acknowledged');
    assert.match(result.reason, /wrapper/i);
  } finally {
    delete process.env.FP_RESULTS_PATH;
    delete process.env.FP_NO_ACK;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a mutation that did not apply is excluded from the denominator, not folded into unnoticed', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-blindspots-'));
    const script = await writeFakeSuite(dir);
    process.env.FP_RESULTS_PATH = join(dir, 'results.json');
    process.env.FP_BEHAVIOR = JSON.stringify({
      'change-text::#cta': { applies: true, red: false }, // applied, unnoticed
      'change-href::#cta': { applies: false, red: false }, // never applied
    });
    const result = await measureBlindspots({
      cmd: `node ${script}`,
      reader: 'playwright',
      resultsPath: process.env.FP_RESULTS_PATH,
      selectors: ['#cta'],
      mutations: ['change-text', 'change-href'],
    });
    assert.equal(result.abstained, null);
    assert.equal(result.counts.attempted, 2);
    assert.equal(result.counts.applied, 1, 'only the mutation that actually applied counts toward the denominator');
    assert.equal(result.counts.notApplied, 1);
    assert.equal(result.counts.noticed, 0);
    assert.equal(result.counts.unnoticed, 1, 'the applied-but-unnoticed mutation, not the not-applied one');
    const notApplied = result.records.find((r) => r.id === 'change-href');
    assert.equal(notApplied.applied, false);
    // "Noticed" is not a meaningful concept for an experiment that never
    // happened - reporting `false` here would be a guessed guarantee the
    // code never actually established (Fix 8 in the review); `null` (not
    // applicable) is the honest answer.
    assert.equal(notApplied.noticed, null, 'a mutation that never touched the page has nothing to be noticed or not');
  } finally {
    delete process.env.FP_RESULTS_PATH;
    delete process.env.FP_BEHAVIOR;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a mutation that applies and turns the suite red is counted as noticed, with the red test named', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-blindspots-'));
    const script = await writeFakeSuite(dir);
    process.env.FP_RESULTS_PATH = join(dir, 'results.json');
    process.env.FP_BEHAVIOR = JSON.stringify({
      'change-text::#header-title': { applies: true, red: true },
    });
    const result = await measureBlindspots({
      cmd: `node ${script}`,
      reader: 'playwright',
      resultsPath: process.env.FP_RESULTS_PATH,
      selectors: ['#header-title'],
      mutations: ['change-text'],
    });
    assert.equal(result.abstained, null);
    assert.equal(result.counts.applied, 1);
    assert.equal(result.counts.noticed, 1);
    assert.equal(result.counts.unnoticed, 0);
    const record = result.records[0];
    assert.equal(record.id, 'change-text');
    assert.equal(record.target, '#header-title');
    assert.ok(record.redTests.some((t) => /noticed/.test(t)));
  } finally {
    delete process.env.FP_RESULTS_PATH;
    delete process.env.FP_BEHAVIOR;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('no mutation applying at all abstains, since there is nothing to compute a score over', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-blindspots-'));
    const script = await writeFakeSuite(dir);
    process.env.FP_RESULTS_PATH = join(dir, 'results.json');
    process.env.FP_BEHAVIOR = JSON.stringify({
      'change-text::#does-not-exist': { applies: false, red: false },
    });
    const result = await measureBlindspots({
      cmd: `node ${script}`,
      reader: 'playwright',
      resultsPath: process.env.FP_RESULTS_PATH,
      selectors: ['#does-not-exist'],
      mutations: ['change-text'],
    });
    assert.equal(result.abstained, 'no-mutations-applied');
    assert.equal(result.counts.applied, 0);
    assert.equal(result.counts.notApplied, 1);
  } finally {
    delete process.env.FP_RESULTS_PATH;
    delete process.env.FP_BEHAVIOR;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('selectors and mutations combine as a full cartesian product of experiments', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-blindspots-'));
    const script = await writeFakeSuite(dir);
    process.env.FP_RESULTS_PATH = join(dir, 'results.json');
    process.env.FP_BEHAVIOR = JSON.stringify({
      'change-text::#a': { applies: true, red: true },
      'change-text::#b': { applies: true, red: false },
      'remove-element::#a': { applies: true, red: false },
      'remove-element::#b': { applies: true, red: true },
    });
    const result = await measureBlindspots({
      cmd: `node ${script}`,
      reader: 'playwright',
      resultsPath: process.env.FP_RESULTS_PATH,
      selectors: ['#a', '#b'],
      mutations: ['change-text', 'remove-element'],
    });
    assert.equal(result.records.length, 4);
    assert.equal(result.counts.applied, 4);
    assert.equal(result.counts.noticed, 2);
    assert.equal(result.counts.unnoticed, 2);
  } finally {
    delete process.env.FP_RESULTS_PATH;
    delete process.env.FP_BEHAVIOR;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('defaults to the full semantic catalog when no mutations are specified', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-blindspots-'));
    const script = await writeFakeSuite(dir);
    process.env.FP_RESULTS_PATH = join(dir, 'results.json');
    const result = await measureBlindspots({
      cmd: `node ${script}`,
      reader: 'playwright',
      resultsPath: process.env.FP_RESULTS_PATH,
      selectors: ['#cta'],
    });
    assert.equal(result.records.length, 3, 'change-text, change-href, remove-element');
  } finally {
    delete process.env.FP_RESULTS_PATH;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a missing test command throws instead of silently doing nothing', async () => {
  await assert.rejects(() => measureBlindspots({ reader: 'playwright', resultsPath: 'r.json', selectors: ['#a'] }));
});

test('an unknown reader throws instead of silently doing nothing', async () => {
  await assert.rejects(() => measureBlindspots({ cmd: 'node -e 1', reader: 'nope', resultsPath: 'r.json', selectors: ['#a'] }));
});

test('no selectors throws instead of silently measuring nothing', async () => {
  await assert.rejects(() => measureBlindspots({ cmd: 'node -e 1', reader: 'playwright', resultsPath: 'r.json', selectors: [] }));
});
