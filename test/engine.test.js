import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, copyFile } from 'node:fs/promises';
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
  const server = await startFixtureServer();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(server.url)));
    const result = await triage({
      errorText: timeoutError('#cta'),
      baselinePath,
      currentUrl: server.url,
    });
    assert.equal(result.verdict, 'unclear');
  } finally {
    await server.close();
  }
});

test('leading body script does not derail anchor resolution', async () => {
  // The script must genuinely be part of the page at capture time, not
  // spliced into the html after the fact: only then does the serialized
  // tree also contain it, at the same index the html anchor resolution
  // sees. Build a temp copy of the fixture page with a script as the
  // first child of <body> and serve that.
  const fixtureDir = await mkdtemp(join(tmpdir(), 'fp-engine-fixture-'));
  const originalHtml = await readFile(join(FIXTURE_DIR, 'index.html'), 'utf8');
  const withLeadingScript = originalHtml.replace(
    /<body>/i,
    `<body><script>document.body.insertAdjacentHTML('afterbegin', '<div id="injected"></div>')</script>`,
  );
  await writeFile(join(fixtureDir, 'index.html'), withLeadingScript);
  await copyFile(join(FIXTURE_DIR, 'logo.svg'), join(fixtureDir, 'logo.svg'));

  const server = await startFixtureServer({ root: fixtureDir });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
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
    await server.close();
  }
});

test('html/tree divergence is caught by the fidelity check', async () => {
  const server = await startFixtureServer();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
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
    await server.close();
  }
});

test('robot-xml failure with an anchor that does not resolve in the baseline is unclear', async () => {
  const server = await startFixtureServer();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
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
    await server.close();
  }
});
