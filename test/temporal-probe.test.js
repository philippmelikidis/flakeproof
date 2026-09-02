import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { temporalProbe } from '../src/triage/temporal-probe.js';

// Mimics a suite with the inject wrapper installed: acknowledges the
// injection with a match count in the current ack format, then fails when
// the delay is at least 500 ms. `count` defaults to 1 (a genuine match);
// pass 0 to simulate a wrapper that installed the delay style but never
// matched the anchor.
async function ackedTimingScript(dir, { count = 1 } = {}) {
  const script = join(dir, 'timing.cjs');
  await writeFile(
    script,
    'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
      'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
      `if(ms>0&&ack)fs.writeFileSync(ack,JSON.stringify({installed:true,count:${count}}));` +
      'process.exit(ms>=500?1:0);',
  );
  return script;
}

test('finds the smallest delay that reproduces the failure', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const script = await ackedTimingScript(dir, { count: 2 });
    const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500, 1000], runsPerDelay: 2 });
    assert.equal(result.reproduced, true);
    assert.equal(result.delay, 500);
    assert.deepEqual(result.tried.map((t) => t.delay), [250, 500], 'must stop at the first reproducing delay');
    assert.deepEqual(result.tried.map((t) => t.failures), [0, 2]);
    assert.equal(result.control.failures, 0);
    assert.equal(result.injected, true);
    assert.equal(result.matched, 2, "the reproducing round's match count is surfaced");
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
    assert.equal(result.matched, null);
    assert.equal(result.tried.at(-1).failures, 2, 'the failing delay round must still be recorded');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a fully failing delay whose ack reports zero matches is not a reproduction claim either', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const script = await ackedTimingScript(dir, { count: 0 });
    const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500], runsPerDelay: 2 });
    assert.equal(result.reproduced, false, 'a delay rule that matched nothing cannot be blamed for the failure');
    assert.equal(result.injected, true, 'the wrapper did run and did acknowledge');
    assert.equal(result.matched, 0, 'the zero must be a confirmed zero, not an unknown');
    assert.equal(result.delay, null);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('an old-format ack (bare "injected") is an unknown count, not a false zero or a false success', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const script = join(dir, 'old-format.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'if(ms>0&&ack)fs.writeFileSync(ack,"injected");' +
        'process.exit(ms>=500?1:0);',
    );
    const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500], runsPerDelay: 2 });
    assert.equal(result.reproduced, false, 'an unknown count must never back a reproduction claim');
    assert.equal(result.injected, true, 'the old-format ack still proves installation');
    assert.equal(result.matched, null, 'the count is unknown, not zero');
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

test('a stale ack from an earlier round never validates a later round', async () => {
  // Acks with a nonzero count only when the delay is exactly 250ms, but
  // fails at 500ms and above without writing anything. If the ack file were
  // not reset per round, the round-1 receipt would still be sitting there
  // when round 2 (500ms, no ack) fully fails, and the probe would wrongly
  // call that a reproduction.
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const script = join(dir, 'partial-ack.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'if(ms===250&&ack)fs.writeFileSync(ack,JSON.stringify({installed:true,count:1}));' +
        'process.exit(ms>=500?1:0);',
    );
    const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500], runsPerDelay: 2 });
    assert.equal(result.reproduced, false, 'the stale 250ms receipt must not count for the 500ms round');
    assert.equal(result.injected, false);
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
