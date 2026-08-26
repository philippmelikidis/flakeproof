import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { triage } from '../src/triage/engine.js';

const ROBOT_OUTPUT_FAIL = fileURLToPath(new URL('./fixtures/rf/output-fail.xml', import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/page/', import.meta.url));

const timeoutError = (selector) =>
  `TimeoutError: locator.waitFor: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('${selector}') to be visible`;

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
    assert.equal(result.temporal.reproduced, true);
    assert.equal(result.temporal.delay, 500);
    assert.equal(result.temporal.injected, true);
    assert.ok(result.notes.some((note) => note.includes('likely a missing wait')));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
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

test('every triage result carries a temporal field', async () => {
  const result = await triage({ errorText: 'AssertionError: Should Be Equal failed: A != B' });
  assert.equal(result.verdict, 'no-anchor');
  assert.ok('temporal' in result, 'json consumers need a stable shape');
  assert.equal(result.temporal, null);
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
