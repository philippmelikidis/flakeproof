import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { triage } from '../src/triage/engine.js';

const ROBOT_OUTPUT_FAIL = fileURLToPath(new URL('./fixtures/rf/output-fail.xml', import.meta.url));

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

test('corrupted baseline html (re-executed inline script) does not crash or shift the anchor', async () => {
  const server = await startFixtureServer();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const baselinePath = join(dir, 'baseline.json');
    const baseline = await captureSnapshot(server.url);
    // Simulate a baseline whose stored html still carries an inline script.
    // Re-running it against the already-hydrated markup would insert an
    // extra element and shift every child index computed from it.
    baseline.html = baseline.html.replace(
      /<body>/i,
      `<body><script>document.body.insertAdjacentHTML('afterbegin','<div id="injected"></div>')</script>`,
    );
    await writeFile(baselinePath, JSON.stringify(baseline));
    const result = await triage({
      errorText: timeoutError('#cta'),
      baselinePath,
      currentPath: baselinePath,
    });
    assert.equal(result.verdict, 'unclear');
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
