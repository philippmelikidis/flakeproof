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
import { renderHtmlReport } from '../src/report-html.js';

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
    assert.equal(top.selector, '#main-nav li:has-text("Products")');
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

test('a removed element with a subtree-derived name is a confident real change, not a hedge', async () => {
  // Before the accessible-name fix, a bare <li> wrapping a link had no own
  // text and no explicit aria-label, so its computed "name" was blank and
  // it counted as a "weak identity" element: with no id/text/name/href of
  // its own, the classifier could not tell a rename from a removal and
  // hedged to 'unclear'. Now that the name is the whole subtree's text
  // ("Solutions"), the li has a real identity again. Page v3 removes this
  // li outright (Products/Company/Careers remain, Solutions does not), so
  // there is no other element anywhere with that name for it to have been
  // renamed into; the classifier can now say 'real-change' honestly instead
  // of hedging.
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
    assert.equal(result.verdict, 'real-change');
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

test('the html report of a real fragile run names both the container and the positional candidate', async () => {
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
    const html = renderHtmlReport(result);
    assert.ok(html.includes('Before and after'), 'the before/after section must be present');
    assert.ok(html.includes('What flakeproof did'), 'the step log must be present');
    const kinds = result.recommendation.map((c) => c.kind);
    assert.ok(kinds.includes('container-text'), `expected a container-text candidate, got ${kinds.join(', ')}`);
    assert.ok(result.recommendation.length >= 2, 'more than one recommendation must be offered');
  } finally {
    await v2.close();
    await rm(dir, { recursive: true, force: true });
  }
});
