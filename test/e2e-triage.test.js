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

test('removed weak-identity element is confidently reported once its name is nowhere in the current build', async () => {
  // A bare <li> wrapping a link has no own text, no id, no href and no
  // explicit aria-label of its own - the only markers the classifier treats
  // as intrinsic identity (see the weakIdentity check in
  // src/triage/classify.js). Its computed accessible `name` ("Solutions",
  // from the child <a>) is not an intrinsic marker of the li itself: it
  // changes whenever the child's text changes, so it alone cannot tell
  // "this exact element was removed" from "the matcher could not
  // confidently re-identify it after a reword". But the classifier can
  // check something stronger than the li's own weak identity: whether that
  // name survives ANYWHERE in the current build at all. Page v3 removes
  // this li outright (Products/Company/Careers remain, Solutions does not,
  // and nothing on the page mentions "Solutions" anymore), so the removal
  // is well-supported and the verdict is a confident real-change, not a
  // hedge - even though other <li> elements of the same tag survive.
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
    assert.ok(
      result.classification.reasons.some((msg) => msg.includes('no longer exists in current build')),
      `expected a confident removal reason, got: ${JSON.stringify(result.classification.reasons)}`,
    );
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

test('a --current <file> whose html cannot be walked to the matched node is reported honestly, not as "no html snippet"', async () => {
  // Only the CURRENT side can be loaded from a hand-built file with no
  // browser involved at all (the baseline always gets re-resolved against a
  // real page via resolveAnchorPath). That makes it the easy, deterministic
  // way to reproduce a genuine snapshot/html shape mismatch: swap the whole
  // `html` field for a document that shares nothing with `tree`, so
  // src/probe/snippet.js#nodeHtmlAtPath cannot walk to the matched node at
  // all. This must read as "the stored page html could not be walked to
  // this element", never as "no html snippet in this snapshot" (both halves
  // of that message would be false: the snapshot does have html, and a
  // fresh baseline of the same page would fail to resolve it the same way).
  let dir = null;
  let v2 = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-e2e-'));
    const baselinePath = await baselineOfV1(dir);
    v2 = await startFixtureServer({ root: join(fixtures, 'page-v2') });
    const currentSnapshot = await captureSnapshot(v2.url);
    currentSnapshot.html = '<html><head></head><body><div>completely unrelated document</div></body></html>';
    const currentPath = join(dir, 'current.json');
    await writeFile(currentPath, JSON.stringify(currentSnapshot));

    const result = await triage({
      errorText: timeoutError('li.css-1a2b3c'),
      baselinePath,
      currentPath,
    });

    assert.equal(result.verdict, 'fragile');
    assert.ok(result.detail.anchorAfter, 'a match must still have been found in the tree');
    assert.equal(result.detail.anchorAfter.htmlUnresolved, true);
    assert.equal('html' in result.detail.anchorAfter, false);
    assert.ok(
      result.notes.some((n) => n.includes('could not be walked') && n.includes('after (current)')),
      `expected a note naming the failed side, got: ${JSON.stringify(result.notes)}`,
    );

    const md = renderReport(result);
    assert.ok(md.includes('could not be walked'), 'the markdown report must carry the note too');

    const html = renderHtmlReport(result);
    assert.ok(html.includes('The stored page html could not be walked to this element'));
    assert.ok(!html.includes('No html snippet in this snapshot'), 'must not claim the snapshot has no html at all');
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
