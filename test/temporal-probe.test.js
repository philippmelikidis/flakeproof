import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { temporalProbe } from '../src/triage/temporal-probe.js';

// Mimics a suite with the inject wrapper installed: acknowledges the
// injection, then fails when the delay is at least 500 ms.
async function ackedTimingScript(dir) {
  const script = join(dir, 'timing.cjs');
  await writeFile(
    script,
    'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
      'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
      'if(ms>0&&ack)fs.writeFileSync(ack,"injected");' +
      'process.exit(ms>=500?1:0);',
  );
  return script;
}

test('finds the smallest delay that reproduces the failure', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const script = await ackedTimingScript(dir);
    const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500, 1000], runsPerDelay: 2 });
    assert.equal(result.reproduced, true);
    assert.equal(result.delay, 500);
    assert.deepEqual(result.tried.map((t) => t.delay), [250, 500], 'must stop at the first reproducing delay');
    assert.deepEqual(result.tried.map((t) => t.failures), [0, 2]);
    assert.equal(result.control.failures, 0);
    assert.equal(result.injected, true);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a fully failing delay without an acknowledgment is not a reproduction claim', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const script = join(dir, 'silent.cjs');
    await writeFile(
      script,
      'const ms = Number(process.env.FLAKEPROOF_TEMPORAL_MS || 0); process.exit(ms >= 500 ? 1 : 0);',
    );
    const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500], runsPerDelay: 2 });
    assert.equal(result.reproduced, false, 'no ack means no experiment, means no claim');
    assert.equal(result.injected, false);
    assert.equal(result.delay, null);
    assert.equal(result.tried.at(-1).failures, 2, 'the failing delay round must still be recorded');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('reports honestly when no delay reproduces', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const script = join(dir, 'stable.cjs');
    await writeFile(script, 'process.exit(0);');
    const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500], runsPerDelay: 2 });
    assert.equal(result.reproduced, false);
    assert.equal(result.delay, null);
    assert.equal(result.tried.length, 2);
    assert.equal(result.control.failures, 0);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('an unstable baseline is never attributed to timing', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const script = join(dir, 'always-fails.cjs');
    await writeFile(script, 'process.exit(1);');
    const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500], runsPerDelay: 2 });
    assert.equal(result.reproduced, false);
    assert.equal(result.tried.length, 0);
    assert.equal(result.control.failures, 2);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
