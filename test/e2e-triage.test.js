import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { triage } from '../src/triage/engine.js';
import { renderReport } from '../src/report.js';

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
  let dir = null;
  let v2 = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-e2e-'));
    const baselinePath = await baselineOfV1(dir);
    v2 = await startFixtureServer({ root: join(fixtures, 'page-v2') });
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
    await v2?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('changed text against the semantic build is a real change', async () => {
  let dir = null;
  let v3 = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-e2e-'));
    const baselinePath = await baselineOfV1(dir);
    v3 = await startFixtureServer({ root: join(fixtures, 'page-v3') });
    const result = await triage({
      errorText: timeoutError('#cta'),
      baselinePath,
      currentUrl: v3.url,
    });
    assert.equal(result.verdict, 'real-change');
  } finally {
    await v3?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('removed weak-identity element yields an honest unclear', async () => {
  let dir = null;
  let v3 = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-e2e-'));
    const baselinePath = await baselineOfV1(dir);
    v3 = await startFixtureServer({ root: join(fixtures, 'page-v3') });
    const result = await triage({
      errorText: timeoutError('li.css-9z8y7x'),
      baselinePath,
      currentUrl: v3.url,
    });
    assert.equal(result.verdict, 'unclear');
  } finally {
    await v3?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('fragile with a current file yields unproven candidates, honestly labeled', async () => {
  let dir = null;
  let v2 = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-e2e-'));
    const baselinePath = await baselineOfV1(dir);
    v2 = await startFixtureServer({ root: join(fixtures, 'page-v2') });
    const currentPath = join(dir, 'current.json');
    await writeFile(currentPath, JSON.stringify(await captureSnapshot(v2.url)));
    const result = await triage({
      errorText: timeoutError('li.css-1a2b3c'),
      baselinePath,
      currentPath,
    });
    assert.equal(result.verdict, 'fragile');
    assert.ok(result.recommendation?.length, 'unproven candidates must still be offered');
    assert.equal(result.recommendation[0].survived, null);
    assert.ok(result.notes.some((n) => n.includes('approximated, not verified')));
    const md = renderReport(result);
    assert.ok(md.includes('| unknown |'), 'unproven rows must render with unknown uniqueness');
    assert.ok(!md.includes('No candidate survived proving'));
  } finally {
    await v2?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
