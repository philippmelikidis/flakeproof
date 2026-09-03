import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { triage, fragileCandidateSource, withHtmlSnippet } from '../src/triage/engine.js';

const ROBOT_OUTPUT_FAIL = fileURLToPath(new URL('./fixtures/rf/output-fail.xml', import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/page/', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url));

const timeoutError = (selector) =>
  `TimeoutError: locator.waitFor: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('${selector}') to be visible`;

async function baselineOfV1(dir) {
  const v1 = await startFixtureServer();
  try {
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(v1.url)));
    return baselinePath;
  } finally {
    await v1.close();
  }
}

test('no locator in the error yields no-anchor', async () => {
  const result = await triage({ errorText: 'AssertionError: Should Be Equal failed: A != B' });
  assert.equal(result.verdict, 'no-anchor');
});

test('all-green reruns yield nondeterministic without touching the baseline', async () => {
  const result = await triage({
    errorText: timeoutError('#cta'),
    rerunCommand: 'node -e "process.exit(0)"',
    reruns: 2,
  });
  assert.equal(result.verdict, 'nondeterministic');
  assert.equal(result.rerun.failures, 0);
});

test('identical baseline and current yield unclear, never a guess', async () => {
  let server = null;
  let dir = null;
  try {
    server = await startFixtureServer();
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(server.url)));
    const result = await triage({
      errorText: timeoutError('#cta'),
      baselinePath,
      currentUrl: server.url,
    });
    assert.equal(result.verdict, 'unclear');
  } finally {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('leading body script does not derail anchor resolution', async () => {
  // The script must genuinely be part of the page at capture time, not
  // spliced into the html after the fact: only then does the serialized
  // tree also contain it, at the same index the html anchor resolution
  // sees. Build a temp copy of the fixture page with a script as the
  // first child of <body> and serve that.
  let fixtureDir = null;
  let server = null;
  let dir = null;
  try {
    fixtureDir = await mkdtemp(join(tmpdir(), 'fp-engine-fixture-'));
    const originalHtml = await readFile(join(FIXTURE_DIR, 'index.html'), 'utf8');
    const withLeadingScript = originalHtml.replace(
      /<body>/i,
      `<body><script>document.body.insertAdjacentHTML('afterbegin', '<div id="injected"></div>')</script>`,
    );
    await writeFile(join(fixtureDir, 'index.html'), withLeadingScript);
    await copyFile(join(FIXTURE_DIR, 'logo.svg'), join(fixtureDir, 'logo.svg'));

    server = await startFixtureServer({ root: fixtureDir });
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(server.url)));
    const result = await triage({
      errorText: timeoutError('#cta'),
      baselinePath,
      currentPath: baselinePath,
    });
    assert.equal(result.verdict, 'unclear');
    assert.ok(
      !result.notes.some((n) => n.includes('baseline html and serialized tree disagree')),
      `expected anchor resolution to stay aligned despite the leading script, got notes: ${JSON.stringify(result.notes)}`,
    );
  } finally {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  }
});

test('html/tree divergence is caught by the fidelity check', async () => {
  let server = null;
  let dir = null;
  try {
    server = await startFixtureServer();
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const baselinePath = join(dir, 'baseline.json');
    const baseline = await captureSnapshot(server.url);
    // documentElement children: head is index 0, body is index 1. Remove
    // the body's first child from the serialized tree only (not from the
    // stored html), so the tree and the html genuinely disagree about the
    // DOM shape at the anchor.
    baseline.tree.children[1].children.splice(0, 1);
    await writeFile(baselinePath, JSON.stringify(baseline));
    const result = await triage({
      errorText: timeoutError('#cta'),
      baselinePath,
      currentPath: baselinePath,
    });
    assert.equal(result.verdict, 'unclear');
    assert.ok(
      result.notes.some((n) => n.includes('baseline html and serialized tree disagree')),
      `expected a fidelity-check note, got: ${JSON.stringify(result.notes)}`,
    );
  } finally {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('robot-xml failure with an anchor that does not resolve in the baseline is unclear', async () => {
  let server = null;
  let dir = null;
  try {
    server = await startFixtureServer();
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(server.url)));
    const result = await triage({
      robotOutputXml: ROBOT_OUTPUT_FAIL,
      baselinePath,
      currentPath: baselinePath,
    });
    assert.equal(result.testId, 'Fails With Locator Timeout');
    assert.ok(result.anchor.selector.includes('#does-not-exist'));
    assert.equal(result.verdict, 'unclear');
    assert.ok(
      result.notes.some((n) => n.includes('does not resolve in the baseline')),
      `expected a note about the anchor not resolving, got: ${JSON.stringify(result.notes)}`,
    );
  } finally {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a strict mode violation is surfaced as a fragility note', async () => {
  let server = null;
  let dir = null;
  try {
    server = await startFixtureServer();
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(server.url)));
    const errorText = await readFile(new URL('./fixtures/errors/pw-strict-violation.txt', import.meta.url), 'utf8');
    const result = await triage({ errorText, baselinePath, currentPath: baselinePath });
    assert.equal(result.anchor.kind, 'ambiguous');
    assert.ok(result.notes.some((note) => note.includes('strict mode violation')));
  } finally {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('temporal requested without a rerun command is noted, not silently skipped', async () => {
  let server = null;
  let dir = null;
  try {
    server = await startFixtureServer();
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(server.url)));
    const result = await triage({
      errorText: timeoutError('#cta'),
      baselinePath,
      currentPath: baselinePath,
      temporal: true,
    });
    assert.ok(result.verdict, 'a verdict must still be produced');
    assert.ok(result.notes.some((note) => note.includes('temporal probing requires a rerun command')));
  } finally {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('temporal probe turns a green-on-rerun failure into a reproducible finding', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const script = join(dir, 'timing.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'if(ms>0&&ack)fs.writeFileSync(ack,JSON.stringify({installed:true,count:1,ruleLive:true}));' +
        'process.exit(ms>=500?1:0);',
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.equal(result.temporal.reproduced, true);
    assert.equal(result.temporal.delay, 500);
    assert.equal(result.temporal.injected, true);
    assert.equal(result.temporal.matched, 1);
    assert.ok(result.notes.some((note) => note.includes('likely a missing wait')));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a delay that matches nothing is named, not mistaken for a negative timing verdict', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const script = join(dir, 'matches-nothing.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'if(ms>0&&ack)fs.writeFileSync(ack,JSON.stringify({installed:true,count:0}));' +
        'process.exit(ms>=500?1:0);',
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.equal(result.temporal.reproduced, false);
    assert.equal(result.temporal.injected, true);
    assert.equal(result.temporal.matched, 0);
    assert.ok(result.notes.some((note) => note.includes('matched no element')), JSON.stringify(result.notes));
    assert.ok(!result.notes.some((note) => note.includes('likely a missing wait')));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('an old-format ack keeps the weakened wording rather than claiming a proven match', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const script = join(dir, 'old-format.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        // Old wrapper version: acknowledges installation but never reports a count.
        'if(ms>0&&ack)fs.writeFileSync(ack,"injected");' +
        'process.exit(0);', // never fails deterministically, so the loop is exhausted
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.equal(result.temporal.reproduced, false);
    assert.equal(result.temporal.injected, true);
    assert.equal(result.temporal.matched, null);
    assert.ok(
      result.notes.some((note) => note.includes('unverified') && note.includes('unlikely but not excluded')),
      JSON.stringify(result.notes),
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Item D: a nonzero count alone cannot carry any confident claim, positive
// or negative. `querySelectorAll` can match real elements even when the
// browser silently discarded the css rule built from that same selector
// string, so a wrapper acknowledging a match but never confirming the rule
// was live must not be phrased as either "likely a missing wait" or "timing
// is unlikely to be the cause" - both would overstate what was observed.
test('a matched count without a confirmed-live rule is named as unverified, not a reproduction or a clearance', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const script = join(dir, 'discarded-rule.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'if(ms>0&&ack)fs.writeFileSync(ack,JSON.stringify({installed:true,count:3,ruleLive:false}));' +
        'process.exit(ms>=500?1:0);',
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.equal(result.temporal.reproduced, false, 'an unconfirmed rule must never back a reproduction claim');
    assert.equal(result.temporal.matched, 3, 'the observed count is still surfaced');
    assert.equal(result.temporal.ruleLive, false);
    assert.ok(!result.notes.some((note) => note.includes('likely a missing wait')));
    assert.ok(!result.notes.some((note) => note.includes('timing is unlikely to be the cause')));
    assert.ok(
      result.notes.some((note) => note.includes('never confirmed live') && note.includes('not evidence against a timing cause')),
      JSON.stringify(result.notes),
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Item C: the strong "matched N element(s) on every round" wording is only
// used when every round tried actually confirmed a nonzero, known match.
// Here every one of the (default) delay rounds reports the same confirmed
// count, so the strong wording is earned.
test('a confirmed nonzero match on every round earns the strong "every round" wording', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const script = join(dir, 'every-round-confirmed.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'if(ms>0&&ack)fs.writeFileSync(ack,JSON.stringify({installed:true,count:2,ruleLive:true}));' +
        'process.exit(0);', // never fails: the loop runs to completion across every delay
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.equal(result.temporal.reproduced, false);
    assert.ok(
      result.temporal.tried.every((t) => t.matched === 2),
      `expected every round to confirm the same count, got: ${JSON.stringify(result.temporal.tried)}`,
    );
    assert.ok(
      result.notes.some((note) => note.includes('matched 2 element(s) on every round') && note.includes('timing is unlikely to be the cause')),
      JSON.stringify(result.notes),
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Item C, the reproduced disagreement scenario: rounds with counts [3, 0]
// (and further rounds at 0) must NOT earn the "on every round" wording -
// that would overstate what was actually observed. The note must hedge and
// show the reader the actual per-round disagreement instead.
test('disagreeing per-round counts are hedged, never rounded up to "every round"', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const script = join(dir, 'disagreeing-rounds.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'const count = ms===250 ? 3 : 0;' +
        'if(ms>0&&ack)fs.writeFileSync(ack,JSON.stringify({installed:true,count,ruleLive:true}));' +
        'process.exit(0);', // never fails: the loop runs to completion across every delay
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.equal(result.temporal.reproduced, false);
    assert.equal(result.temporal.matched, 3, 'the strongest count observed is still the headline number');
    assert.ok(
      !result.notes.some((note) => note.includes('on every round')),
      `must not claim "every round" when rounds disagreed, got: ${JSON.stringify(result.notes)}`,
    );
    assert.ok(
      result.notes.some((note) => note.includes('varied across rounds') && note.includes('not confidently ruled out')),
      JSON.stringify(result.notes),
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('an invalid derived css target is not silently probed; flakeproof abstains', async () => {
  // temporalTargetFor accepts `[123abc]` as-is (it has a narrowing `[`
  // token, no chain/comma/pseudo issues, and the string surgery has no
  // concept of css identifier grammar), but an attribute name may not start
  // with a digit - a real browser rejects it outright. The round-trip
  // validation in engine.js must catch what the string surgery could not.
  const result = await triage({
    errorText: timeoutError('[123abc]'),
    rerunCommand: 'node -e "process.exit(0)"',
    reruns: 2,
    temporal: true,
  });
  assert.equal(result.verdict, 'nondeterministic');
  assert.equal(result.temporal, null, 'an invalid target must never reach temporalProbe');
  assert.ok(
    result.notes.some((n) => n.includes('not valid css')),
    `expected an abstention note, got: ${JSON.stringify(result.notes)}`,
  );
});

test('a missing inject wrapper is named instead of blaming timing', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const script = join(dir, 'silent.cjs');
    await writeFile(
      script,
      'const ms = Number(process.env.FLAKEPROOF_TEMPORAL_MS || 0); process.exit(ms >= 500 ? 1 : 0);',
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.equal(result.temporal.injected, false);
    assert.ok(result.notes.some((note) => note.includes('never acknowledged')), JSON.stringify(result.notes));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('temporal control abort when baseline is too unstable', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const counterFile = join(dir, 'counter.txt');
    const script = join(dir, 'alternating.cjs');
    await writeFile(
      script,
      `const fs = require('fs');
const f = process.env.FP_COUNTER_FILE;
const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) + 1 : 1;
fs.writeFileSync(f, String(n));
process.exit(n % 2 === 1 ? 1 : 0);`,
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `FP_COUNTER_FILE=${counterFile} node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.ok(result.temporal.control && result.temporal.control.failures > 0);
    assert.ok(result.notes.some((note) => note.includes('control run without any delay already failed')));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Fix 1: an iframe writer reporting {count: 9, ruleLive: false} and a
// main-page writer reporting {count: 0, ruleLive: true} in the SAME round
// must never be fused into "matched 9, confirmed live" - no writer ever
// observed that conjunction. The old code reduced count with Math.max and
// ruleLive with payloads.some(...) independently.
test('Fix 1: two writers with disagreeing count and ruleLive never produce a confident reproduction claim', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const script = join(dir, 'two-writers.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const path=require("path");' +
        'const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'if(ms>0&&ack){' +
        'fs.mkdirSync(ack,{recursive:true});' +
        'fs.writeFileSync(path.join(ack,"iframe.json"),JSON.stringify({installed:true,count:9,ruleLive:false}));' +
        'fs.writeFileSync(path.join(ack,"main.json"),JSON.stringify({installed:true,count:0,ruleLive:true}));' +
        '}' +
        'process.exit(ms>=500?1:0);',
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.equal(result.temporal.reproduced, false, 'no single writer reported a live rule with a nonzero count');
    assert.equal(result.temporal.matched, 9, 'the strongest count observed is still surfaced');
    assert.equal(result.temporal.ruleLive, false, 'ruleLive must come from the same writer as the count, not a different one');
    assert.ok(!result.notes.some((note) => note.includes('likely a missing wait')), JSON.stringify(result.notes));
    assert.ok(
      result.notes.some((note) => note.includes('matched 9 element') && note.includes('never confirmed live') && note.includes('not evidence against a timing cause')),
      JSON.stringify(result.notes),
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Fix 2: rounds confirming a nonzero match but with ruleLive [true, false,
// false, false] must not earn the confident "matched N element(s) on every
// round ... timing is unlikely to be the cause" wording - only one round out
// of four ever confirmed the rule was live, even though the aggregate
// ruleLive flag (tried.some(...)) is true.
test('Fix 2: a confident negative requires ruleLive on every round, not just the aggregate', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const script = join(dir, 'partial-rule-live.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'const ruleLive = ms===250;' +
        'if(ms>0&&ack)fs.writeFileSync(ack,JSON.stringify({installed:true,count:2,ruleLive}));' +
        'process.exit(0);', // never fails: the loop runs to completion across every delay
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.equal(result.temporal.reproduced, false);
    assert.deepEqual(result.temporal.tried.map((t) => t.ruleLive), [true, false, false, false]);
    assert.deepEqual(result.temporal.tried.map((t) => t.matched), [2, 2, 2, 2]);
    assert.ok(
      !result.notes.some((note) => note.includes('on every round') && note.includes('timing is unlikely to be the cause')),
      `must not claim a confident negative when only one round confirmed a live rule, got: ${JSON.stringify(result.notes)}`,
    );
    assert.ok(
      result.notes.some((note) => note.includes('varied across rounds') && note.includes('not confidently ruled out')),
      JSON.stringify(result.notes),
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Fix 3: a round that failed on every one of its runs but whose ack could
// not report a count (an old-format ack) is weak evidence FOR timing, not
// evidence against it. The old catch-all phrasing ("timing remains unlikely
// but not excluded") was reached by this case too, contradicting the
// Timing provocation table showing that round failed on every run.
test('Fix 3: an old-format ack on a round that failed on every run is named as an unverified possible reproduction', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const script = join(dir, 'old-format-full-failure.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'if(ms>0&&ack)fs.writeFileSync(ack,"injected");' +
        'process.exit(ms>=500?1:0);',
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.equal(result.temporal.reproduced, false);
    assert.equal(result.temporal.matched, null);
    assert.equal(result.temporal.tried.at(-1).failures, result.temporal.tried.at(-1).runs, 'the last round tried must have failed on every run');
    assert.ok(
      result.notes.some((note) => note.includes('unverified possible reproduction')),
      JSON.stringify(result.notes),
    );
    assert.ok(
      !result.notes.some((note) => note.includes('timing remains unlikely but not excluded')),
      `a round that failed on every run must not be described as evidence against timing, got: ${JSON.stringify(result.notes)}`,
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Fix 4: the aggregate `injected` flag is `tried.some(t => t.installed)`, so
// it reads true even when only one of four rounds ever produced a receipt.
// The note must say what actually happened per round, not claim "installed
// on every round".
test('Fix 4: only some rounds acknowledging is named per round, not "installed on every round"', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const script = join(dir, 'partial-install.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        // Only the very first delay round (250ms) ever acknowledges, and
        // with an old-format ack (no count). The other three rounds never
        // write anything.
        'if(ms===250&&ack)fs.writeFileSync(ack,"injected");' +
        'process.exit(0);', // never fails, so the loop runs through every delay
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.deepEqual(result.temporal.tried.map((t) => t.installed), [true, false, false, false]);
    assert.ok(
      !result.notes.some((note) => note.includes('installed on every round')),
      `must not claim "installed on every round" when only one round installed, got: ${JSON.stringify(result.notes)}`,
    );
    assert.ok(
      result.notes.some((note) => note.includes('only acknowledged on some rounds')),
      JSON.stringify(result.notes),
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Fix 5: one unreadable file inside the ack directory must not discard a
// usable payload recovered from a sibling file in the same round - the
// reproduction that payload supports must survive.
test('Fix 5: one unreadable ack file alongside a usable payload still yields a reproduction', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const script = join(dir, 'mixed-readability.cjs');
    await writeFile(
      script,
      'const fs=require("fs");const path=require("path");' +
        'const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
        'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
        'if(ms>0&&ack){' +
        'fs.mkdirSync(ack,{recursive:true});' +
        'fs.writeFileSync(path.join(ack,"good.json"),JSON.stringify({installed:true,count:2,ruleLive:true}));' +
        'fs.writeFileSync(path.join(ack,"bad.json"),"unreadable-on-purpose");' +
        'fs.chmodSync(path.join(ack,"bad.json"),0o000);' +
        '}' +
        'process.exit(ms>=500?1:0);',
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.equal(result.temporal.reproduced, true, 'the usable payload must survive alongside one unreadable file');
    assert.equal(result.temporal.matched, 2);
    assert.ok(result.notes.some((note) => note.includes('likely a missing wait')), JSON.stringify(result.notes));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Fix 6: when the control run itself fails, the probe aborts before any
// delay round runs (`temporal.tried` is empty). The report renders every
// step under "What flakeproof did", so a "Provoked a delay" step must never
// be recorded when no delay round actually ran.
test('Fix 6: no "Provoked a delay" step is recorded when the control run aborts the probe', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const counterFile = join(dir, 'counter.txt');
    const script = join(dir, 'alternating.cjs');
    await writeFile(
      script,
      `const fs = require('fs');
const f = process.env.FP_COUNTER_FILE;
const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) + 1 : 1;
fs.writeFileSync(f, String(n));
process.exit(n % 2 === 1 ? 1 : 0);`,
    );
    const result = await triage({
      errorText: timeoutError('#cta'),
      rerunCommand: `FP_COUNTER_FILE=${counterFile} node ${script}`,
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.verdict, 'nondeterministic');
    assert.equal(result.temporal.tried.length, 0, 'the control failure must abort before any delay round runs');
    assert.ok(
      !result.detail.steps.some((s) => s.label === 'Provoked a delay on the anchor'),
      `no delay round ran, so this step must not be recorded, got steps: ${JSON.stringify(result.detail.steps)}`,
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('every triage result carries a temporal field', async () => {
  const result = await triage({ errorText: 'AssertionError: Should Be Equal failed: A != B' });
  assert.equal(result.verdict, 'no-anchor');
  assert.ok('temporal' in result, 'json consumers need a stable shape');
  assert.equal(result.temporal, null);
});

test('a deterministic red rerun skips the temporal probe with a named note, not silence', async () => {
  let server = null;
  let dir = null;
  try {
    server = await startFixtureServer();
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(server.url)));
    const result = await triage({
      errorText: timeoutError('#cta'),
      baselinePath,
      currentPath: baselinePath,
      rerunCommand: 'node -e "process.exit(1)"',
      reruns: 2,
      temporal: true,
    });
    assert.equal(result.temporal, null, 'no intermittency means no probe was run');
    assert.ok(
      result.notes.some((n) => n.includes('no intermittency')),
      `expected a note explaining the skip, got: ${JSON.stringify(result.notes)}`,
    );
  } finally {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a broken rerun command is named instead of trusted', async () => {
  let server = null;
  let dir = null;
  try {
    server = await startFixtureServer();
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(server.url)));
    const result = await triage({
      errorText: timeoutError('#cta'),
      baselinePath,
      currentPath: baselinePath,
      rerunCommand: 'definitely-not-a-command-fp-2b',
      reruns: 2,
    });
    assert.ok(result.notes.some((n) => n.includes('looks broken')), JSON.stringify(result.notes));
  } finally {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('every result carries a step log', async () => {
  const result = await triage({ errorText: 'AssertionError: Should Be Equal failed: A != B' });
  assert.equal(result.verdict, 'no-anchor');
  assert.ok(result.detail, 'detail must be present');
  assert.ok(result.detail.steps.length >= 1, 'the anchor step must be logged');
  assert.equal(result.detail.steps[0].ok, false);
});

test('a fragile verdict records both anchor states and the proving step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
  const baselinePath = await baselineOfV1(dir);
  const v2 = await startFixtureServer({ root: join(fixtures, 'page-v2') });
  try {
    const result = await triage({
      errorText: timeoutError('li.css-1a2b3c'),
      baselinePath,
      currentUrl: v2.url,
    });
    assert.equal(result.verdict, 'fragile');
    assert.equal(result.detail.anchorBefore.tag, 'li');
    assert.ok(result.detail.anchorBefore.html.includes('css-1a2b3c'));
    assert.ok(result.detail.anchorAfter, 'the matched element must be recorded');
    const labels = result.detail.steps.map((s) => s.label);
    assert.ok(labels.some((l) => /anchor/i.test(l)), `expected an anchor step, got ${labels.join(' | ')}`);
    assert.ok(labels.some((l) => /prov/i.test(l)), `expected a proving step, got ${labels.join(' | ')}`);
  } finally {
    await v2.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// A pair of custom fixture pages where the anchor's hashed class changes
// (so classification stays cosmetic/fragile) AND a second, non-hashed class
// on the very same element also changes name, independently of the
// classification-relevant class. The prover is never consulted here
// (currentPath, no currentUrl): the only way a candidate selector can name
// the CURRENT class is if candidate generation itself reads the current
// tree. If it read the baseline tree instead, it would produce the stale
// baseline class name, which does not exist in the current build at all.
async function writeRenamedClassPages(dir) {
  const baselineHtml =
    '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>' +
    '<ul>' +
    '<li class="css-1a2b3c marker-old"><a href="/a/">A</a></li>' +
    '<li class="css-9z8y7x marker-two"><a href="/b/">B</a></li>' +
    '</ul></body></html>';
  const currentHtml =
    '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>' +
    '<ul>' +
    '<li class="css-q1w2e3 marker-new"><a href="/a/">A</a></li>' +
    '<li class="css-r4t5z6 marker-two"><a href="/b/">B</a></li>' +
    '</ul></body></html>';
  const baselineDir = join(dir, 'baseline-page');
  const currentDir = join(dir, 'current-page');
  await mkdir(baselineDir, { recursive: true });
  await mkdir(currentDir, { recursive: true });
  await writeFile(join(baselineDir, 'index.html'), baselineHtml);
  await writeFile(join(currentDir, 'index.html'), currentHtml);
  return { baselineDir, currentDir };
}

test('a fragile verdict builds candidates from the current tree, not the stale baseline class', async () => {
  let dir = null;
  let baselineServer = null;
  let currentServer = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-rename-'));
    const { baselineDir, currentDir } = await writeRenamedClassPages(dir);
    baselineServer = await startFixtureServer({ root: baselineDir });
    currentServer = await startFixtureServer({ root: currentDir });

    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(baselineServer.url)));
    const currentPath = join(dir, 'current.json');
    await writeFile(currentPath, JSON.stringify(await captureSnapshot(currentServer.url)));

    const result = await triage({
      errorText: timeoutError('li.css-1a2b3c'),
      baselinePath,
      currentPath,
    });

    assert.equal(result.verdict, 'fragile');
    const selectors = result.recommendation.map((c) => c.selector);
    assert.ok(
      selectors.includes('li.marker-new'),
      `expected a candidate built from the current markup, got: ${selectors.join(', ')}`,
    );
    assert.ok(
      !selectors.includes('li.marker-old'),
      `candidate must not reflect the stale baseline class, got: ${selectors.join(', ')}`,
    );
    assert.ok(
      result.detail.steps.some((s) => /current tree/i.test(s.label) || /current tree/i.test(s.outcome)),
      'the step log must name which tree candidates came from',
    );
  } finally {
    await baselineServer?.close();
    await currentServer?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// A --current snapshot written by an earlier flakeproof has no
// snapshotVersion key at all (the field did not exist yet), which must not
// be confused with "verified exact": every node's per-node exactness flag
// is equally absent from such a file, so trusting it would silently
// reintroduce the same fail-open bug the flag was added to close.
test('an old-format current snapshot (no snapshotVersion) suppresses role candidates and adds a note', async () => {
  let dir = null;
  let baselineServer = null;
  let currentServer = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-engine-oldsnap-'));
    const baselineHtml =
      '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>' +
      '<a id="cta" class="css-1a2b3c" href="/contact/">Contact <b>us</b></a>' +
      '</body></html>';
    const currentHtml =
      '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>' +
      '<a id="cta" class="css-q1w2e3" href="/contact/">Contact <b>us</b></a>' +
      '</body></html>';
    const baselineDir = join(dir, 'baseline-page');
    const currentDir = join(dir, 'current-page');
    await mkdir(baselineDir, { recursive: true });
    await mkdir(currentDir, { recursive: true });
    await writeFile(join(baselineDir, 'index.html'), baselineHtml);
    await writeFile(join(currentDir, 'index.html'), currentHtml);
    baselineServer = await startFixtureServer({ root: baselineDir });
    currentServer = await startFixtureServer({ root: currentDir });

    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(baselineServer.url)));

    const currentSnapshot = await captureSnapshot(currentServer.url);
    assert.ok('snapshotVersion' in currentSnapshot, 'sanity: a fresh capture does carry the field');
    delete currentSnapshot.snapshotVersion; // simulate a file written before this field existed
    const currentPath = join(dir, 'current.json');
    await writeFile(currentPath, JSON.stringify(currentSnapshot));

    const result = await triage({
      errorText: timeoutError('a.css-1a2b3c'),
      baselinePath,
      currentPath,
    });

    assert.equal(result.verdict, 'fragile');
    assert.ok(
      !result.recommendation.some((c) => c.kind === 'role'),
      `expected no role candidate from a version-less snapshot, got: ${JSON.stringify(result.recommendation.map((c) => c.selector))}`,
    );
    assert.ok(
      result.notes.some((n) => n.includes('snapshotVersion')),
      `expected a note naming the missing snapshotVersion, got: ${JSON.stringify(result.notes)}`,
    );
  } finally {
    await baselineServer?.close();
    await currentServer?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// classifyDelta's own contract guarantees that a 'cosmetic' verdict (which
// triage maps to 'fragile') always carries a match: the "no confident
// match" branch in classify.js only ever returns 'semantic' or 'unclear',
// never 'cosmetic'. So the "no classification.match.path" case cannot be
// reached today through triage() with a real classifyDelta result. It is
// still guarded defensively in engine.js (never trust an invariant in
// another module to hold forever), so it is unit-tested directly against
// the small decision function rather than via a contrived end-to-end
// fixture that cannot actually produce this combination.
test('fragileCandidateSource refuses to fall back to the baseline when there is no current-build match', () => {
  const current = { tree: { tag: 'html', path: [], children: [] } };
  assert.equal(fragileCandidateSource({ match: null }, current), null);
  assert.equal(fragileCandidateSource({}, current), null);
});

test('fragileCandidateSource points at the current snapshot when a match exists', () => {
  const current = { tree: { tag: 'html', path: [], children: [] }, snapshotVersion: 1 };
  const source = fragileCandidateSource({ match: { path: [0, 1] } }, current);
  assert.deepEqual(source, { snapshot: current, path: [0, 1] });
});

// withHtmlSnippet is the glue Fix 3 lives in: it decides between three
// outcomes, and it is the only place that decides them, so it is tested
// directly rather than only through a full triage() run (reproducing a
// genuine scanner failure end-to-end is hard on purpose - browsers
// normalize markup before ever handing back outerHTML, so most malformed
// input never survives to become a snapshot's `html` field at all).
describe('withHtmlSnippet', () => {
  test('a null node passes through untouched, no note pushed', () => {
    const notes = [];
    assert.equal(withHtmlSnippet(null, '<html></html>', 'before', notes), null);
    assert.deepEqual(notes, []);
  });

  test('old-format snapshot (no fullHtml at all): node is returned as-is, no note pushed', () => {
    const notes = [];
    const node = { tag: 'li', path: [0] };
    const result = withHtmlSnippet(node, null, 'before', notes);
    assert.deepEqual(result, node);
    assert.equal('html' in result, false);
    assert.equal('htmlUnresolved' in result, false);
    assert.deepEqual(notes, [], 'a missing snapshot html is not a walk failure and must not be noted as one');
  });

  test('fullHtml present and the path resolves: the node gets its html, no note pushed', () => {
    const notes = [];
    const html = '<html><body><li id="x">hi</li></body></html>';
    const node = { tag: 'li', path: [0, 0] };
    const result = withHtmlSnippet(node, html, 'before', notes);
    assert.equal(result.html, '<li id="x">hi</li>');
    assert.equal('htmlUnresolved' in result, false);
    assert.deepEqual(notes, []);
  });

  test('fullHtml present but the path does not resolve: htmlUnresolved is set and a note names the side', () => {
    const notes = [];
    const html = '<html><body><li id="x">hi</li></body></html>';
    const node = { tag: 'li', path: [0, 99] }; // no such child
    const result = withHtmlSnippet(node, html, 'before (baseline)', notes);
    assert.equal(result.htmlUnresolved, true);
    assert.equal('html' in result, false, 'no html field must be set when resolution failed');
    assert.ok(
      notes.some((note) => note.includes('could not be walked') && note.includes('before (baseline)')),
      `expected a note naming the failure and the side, got: ${JSON.stringify(notes)}`,
    );
  });

  test('fullHtml present but a tag mismatch is caught by the self-check: htmlUnresolved is set', () => {
    const notes = [];
    const html = '<html><body><div id="x">hi</div></body></html>';
    const node = { tag: 'li', path: [0, 0] }; // the tree says li, the html has a div here
    const result = withHtmlSnippet(node, html, 'after (current)', notes);
    assert.equal(result.htmlUnresolved, true);
    assert.ok(notes.some((note) => note.includes('could not be walked')));
  });
});
