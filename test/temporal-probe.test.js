import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { temporalProbe } from '../src/triage/temporal-probe.js';

// Mimics a suite with the inject wrapper installed: acknowledges the
// injection with a match count and rule-live flag in the current ack
// format, then fails when the delay is at least 500 ms. `count` defaults to
// 1 and `ruleLive` defaults to true (a genuine, confirmed-live match); pass
// `count: 0` to simulate a wrapper that installed the delay style but never
// matched the anchor, or `ruleLive: false` to simulate a selector that
// matched real elements while the css rule itself was silently discarded.
async function ackedTimingScript(dir, { count = 1, ruleLive = true } = {}) {
  const script = join(dir, 'timing.cjs');
  await writeFile(
    script,
    'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
      'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
      `if(ms>0&&ack)fs.writeFileSync(ack,JSON.stringify({installed:true,count:${count},ruleLive:${ruleLive}}));` +
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

// A count alone cannot carry a reproduction claim (item D in the review):
// `querySelectorAll` can match real elements even when the browser silently
// discarded the css rule built from the same selector string. A wrapper
// that acknowledges a nonzero count but an unconfirmed (or explicitly false)
// rule-live flag must not be treated as a reproduction, and the raw count
// must still be surfaced (not silently zeroed) so the caller can explain why.
test('a nonzero count whose rule was never confirmed live is not a reproduction claim', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const script = await ackedTimingScript(dir, { count: 3, ruleLive: false });
    const result = await temporalProbe(`node ${script}`, '[data-x', { delays: [250, 500], runsPerDelay: 2 });
    assert.equal(result.reproduced, false, 'the browser may have discarded the rule; a count alone is not proof');
    assert.equal(result.injected, true, 'the wrapper did run and did acknowledge');
    assert.equal(result.matched, 3, 'the observed count must still be surfaced, not hidden or zeroed');
    assert.equal(result.ruleLive, false, 'the rule was never confirmed live');
    assert.equal(result.delay, null);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Mirrors what the real wrapper produces (src/inject/playwright.js): every
// acknowledging write gets its OWN file inside the ack directory, and the
// round's count is the MAX of every writer's known count. Flipping
// `Math.max` to `Math.min` in the aggregation must fail this test (a lower
// bound of 2 would surface instead of the true strongest evidence, 5).
test('multiple writers in one round aggregate to the MAX known count, not the min', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const script = join(dir, 'multi-writer.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const path=require("path");' +
        'const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'if(ms>0&&ack){' +
        'fs.mkdirSync(ack,{recursive:true});' +
        'fs.writeFileSync(path.join(ack,"a.json"),JSON.stringify({installed:true,count:2,ruleLive:true}));' +
        'fs.writeFileSync(path.join(ack,"b.json"),JSON.stringify({installed:true,count:5,ruleLive:true}));' +
        '}' +
        'process.exit(ms>=500?1:0);',
    );
    const result = await temporalProbe(`node ${script}`, '#cta', { delays: [500], runsPerDelay: 2 });
    assert.equal(result.reproduced, true);
    assert.equal(result.matched, 5, 'the strongest evidence observed (5) must win, never the weakest (2)');
    assert.equal(result.ruleLive, true);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Item B in the review: `injected` and `matched` must reflect the SAME
// scope. Reproduced bug: round 1 acknowledges a genuine match (7), round 2
// never acknowledges at all, and neither round fully fails (so the loop runs
// to exhaustion rather than returning early per-round) - the old code
// reported `injected: existsSync(lastRoundsAckPath)` (false, since round 2
// left nothing) alongside `matched: bestKnownMatch(everyRound)` (7), a
// self-contradicting pair that made engine.js claim the wrapper "never
// acknowledged" a delay it plainly did acknowledge.
test('injected and matched are computed over the same scope across rounds', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const script = join(dir, 'first-round-only.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        // Only the 250ms round ever acknowledges; the 500ms round writes
        // nothing. Neither round fails at all, so the loop runs to
        // completion instead of returning early.
        'if(ms===250&&ack)fs.writeFileSync(ack,JSON.stringify({installed:true,count:7,ruleLive:true}));' +
        'process.exit(0);',
    );
    const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500], runsPerDelay: 2 });
    assert.equal(result.reproduced, false, 'the test never failed, so nothing was reproduced');
    assert.equal(result.injected, true, 'round 1 genuinely acknowledged; this must not read as "never installed"');
    assert.equal(result.matched, 7, 'the strongest count actually observed must still be reported');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Rounds with counts [3, 0]: the strongest observed count (3) must be
// reported, but the per-round record must still show the true disagreement
// (3 then 0) so a caller (engine.js, item C) can tell the difference between
// "matched on every round" and "matched on some rounds".
test('rounds with disagreeing counts [3, 0] surface both the max and the per-round disagreement', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const script = join(dir, 'disagreeing-counts.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'const count = ms===250 ? 3 : 0;' +
        'if(ms>0&&ack)fs.writeFileSync(ack,JSON.stringify({installed:true,count,ruleLive:true}));' +
        'process.exit(0);',
    );
    const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500], runsPerDelay: 2 });
    assert.equal(result.reproduced, false);
    assert.equal(result.matched, 3, 'the max across rounds must be reported');
    assert.deepEqual(result.tried.map((t) => t.matched), [3, 0], 'the actual per-round disagreement must survive');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Item A: an ack that exists but cannot be read (a permissions problem) must
// be distinguishable from one that was simply never written - telling the
// user "install the wrapper" when it is actually installed but unreadable
// would be a false claim.
test('an unreadable ack directory is distinguished from a missing one', async () => {
  let dir = null;
  let leakedAckPath = null;
  const previousLeakVar = process.env.FP_LEAK_ACK_PATH;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const leakFile = join(dir, 'leaked-ack-path.txt');
    process.env.FP_LEAK_ACK_PATH = leakFile;
    const script = join(dir, 'unreadable.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const path=require("path");' +
        'const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'if(ms>0&&ack){' +
        'fs.mkdirSync(ack,{recursive:true});' +
        'fs.writeFileSync(path.join(ack,"x.json"),JSON.stringify({installed:true,count:1,ruleLive:true}));' +
        // Leak the real ack path out so the test can restore permissions and
        // clean up afterward - it lives inside temporalProbe's own scratch
        // directory, which the test has no other way to discover.
        'fs.writeFileSync(process.env.FP_LEAK_ACK_PATH, ack);' +
        // Making the directory itself unreadable (not just its contents)
        // simulates a permissions problem the wrapper cannot control.
        'fs.chmodSync(ack, 0o000);' +
        '}' +
        'process.exit(ms>=500?1:0);',
    );
    const result = await temporalProbe(`node ${script}`, '#cta', { delays: [500], runsPerDelay: 2 });
    leakedAckPath = await readFile(leakFile, 'utf8').then((s) => s.trim()).catch(() => null);
    assert.equal(result.reproduced, false);
    assert.equal(result.unreadable, true, 'an unreadable ack must be flagged, not silently treated as missing');
    assert.equal(result.injected, null, 'installed-ness is genuinely unknown here, not confirmed false');
    assert.equal(result.matched, null);
  } finally {
    if (leakedAckPath) {
      await chmod(leakedAckPath, 0o755).catch(() => {});
      await rm(leakedAckPath, { recursive: true, force: true }).catch(() => {});
    }
    if (previousLeakVar === undefined) delete process.env.FP_LEAK_ACK_PATH;
    else process.env.FP_LEAK_ACK_PATH = previousLeakVar;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Backward compatibility (item A): a hand-rolled or pre-fix wrapper may
// still write ackPath directly as a plain FILE rather than a directory. That
// legacy shape must still be read exactly as before.
test('a legacy plain-file ack (not a directory) is still read correctly', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
    const script = await ackedTimingScript(dir, { count: 4, ruleLive: true });
    const result = await temporalProbe(`node ${script}`, '#cta', { delays: [500], runsPerDelay: 2 });
    assert.equal(result.reproduced, true);
    assert.equal(result.matched, 4);
    assert.equal(result.injected, true);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
