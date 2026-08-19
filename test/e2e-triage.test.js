import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { triage } from '../src/triage/engine.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
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

test('hashed-class selector against the cosmetic build is fragile, with a proven recommendation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-e2e-'));
  const baselinePath = await baselineOfV1(dir);
  const v2 = await startFixtureServer({ root: join(fixtures, 'page-v2') });
  try {
    const result = await triage({
      errorText: timeoutError('li.css-1a2b3c'),
      baselinePath,
      currentUrl: v2.url,
    });
    assert.equal(result.verdict, 'fragile');
    assert.ok(result.recommendation?.length, 'must recommend selectors');
    const top = result.recommendation[0];
    assert.equal(top.selector, '#main-nav li:nth-child(1)');
    assert.ok(top.survived >= 3, `recommendation must be proven, got ${top.survived}/${top.applied}`);
  } finally {
    await v2.close();
  }
});

test('changed text against the semantic build is a real change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-e2e-'));
  const baselinePath = await baselineOfV1(dir);
  const v3 = await startFixtureServer({ root: join(fixtures, 'page-v3') });
  try {
    const result = await triage({
      errorText: timeoutError('#cta'),
      baselinePath,
      currentUrl: v3.url,
    });
    assert.equal(result.verdict, 'real-change');
  } finally {
    await v3.close();
  }
});

test('removed weak-identity element yields an honest unclear', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-e2e-'));
  const baselinePath = await baselineOfV1(dir);
  const v3 = await startFixtureServer({ root: join(fixtures, 'page-v3') });
  try {
    const result = await triage({
      errorText: timeoutError('li.css-9z8y7x'),
      baselinePath,
      currentUrl: v3.url,
    });
    assert.equal(result.verdict, 'unclear');
  } finally {
    await v3.close();
  }
});
