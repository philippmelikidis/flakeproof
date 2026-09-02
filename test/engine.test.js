import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { triage, fragileCandidateSource } from '../src/triage/engine.js';

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

test('fragileCandidateSource points at the current tree when a match exists', () => {
  const current = { tree: { tag: 'html', path: [], children: [] } };
  const source = fragileCandidateSource({ match: { path: [0, 1] } }, current);
  assert.deepEqual(source, { tree: current.tree, path: [0, 1] });
});
