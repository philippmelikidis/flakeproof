import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { triage } from '../src/triage/engine.js';

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
