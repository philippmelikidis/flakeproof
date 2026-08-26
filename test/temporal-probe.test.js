import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { temporalProbe } from '../src/triage/temporal-probe.js';

// Fails exactly when the injected delay is at least 500 ms, mimicking a test
// with a 400 ms implicit wait budget.
async function timingSensitiveScript() {
  const dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
  const script = join(dir, 'timing.cjs');
  await writeFile(
    script,
    'const ms = Number(process.env.FLAKEPROOF_TEMPORAL_MS || 0); process.exit(ms >= 500 ? 1 : 0);',
  );
  return script;
}

test('finds the smallest delay that reproduces the failure', async () => {
  const script = await timingSensitiveScript();
  const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500, 1000], runsPerDelay: 2 });
  assert.equal(result.reproduced, true);
  assert.equal(result.delay, 500);
  assert.deepEqual(result.tried.map((t) => t.delay), [250, 500], 'must stop at the first reproducing delay');
  assert.deepEqual(result.tried.map((t) => t.failures), [0, 2]);
  assert.equal(result.control.failures, 0);
});

test('reports honestly when no delay reproduces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
  const script = join(dir, 'stable.cjs');
  await writeFile(script, 'process.exit(0);');
  const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500], runsPerDelay: 2 });
  assert.equal(result.reproduced, false);
  assert.equal(result.delay, null);
  assert.equal(result.tried.length, 2);
  assert.equal(result.control.failures, 0);
});

test('an unstable baseline is never attributed to timing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
  const script = join(dir, 'always-fails.cjs');
  await writeFile(script, 'process.exit(1);');
  const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500], runsPerDelay: 2 });
  assert.equal(result.reproduced, false);
  assert.equal(result.tried.length, 0);
  assert.equal(result.control.failures, 2);
});
