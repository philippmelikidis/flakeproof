import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTemporal } from '../src/inject/playwright.js';

// FLAKEPROOF_TEMPORAL_ACK is a directory: every acknowledging write gets its
// own uniquely named file inside it (see Fix 1 in the review). This reads
// every file back and parses it, mirroring what temporalProbe does.
async function readAcks(ackDir) {
  if (!existsSync(ackDir)) return [];
  const entries = await readdir(ackDir);
  return Promise.all(entries.map((entry) => readFile(join(ackDir, entry), 'utf8').then((raw) => JSON.parse(raw))));
}

const REPORT_FN = '__flakeproofTemporalMatchCount';

// withTemporal only needs base.extend; a stub keeps the test independent of
// the @playwright/test runner, which cannot be instantiated outside itself.
function stubBase() {
  return {
    extend(fixtures) {
      return { fixtures };
    },
  };
}

function stubContext() {
  return {
    scripts: [],
    bindings: {},
    async addInitScript(source) {
      this.scripts.push(source);
    },
    async exposeBinding(name, fn) {
      this.bindings[name] = fn;
    },
  };
}

async function runContextFixture(wrapped, context) {
  let used = null;
  await wrapped.fixtures.context({ context }, async (c) => {
    used = c;
  });
  return used;
}

test('injects the temporal script and acknowledges installation before any count is known', async () => {
  process.env.FLAKEPROOF_TEMPORAL_SELECTOR = '#cta';
  process.env.FLAKEPROOF_TEMPORAL_MS = '800';
  const ackDir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
  process.env.FLAKEPROOF_TEMPORAL_ACK = ackDir;
  try {
    const wrapped = withTemporal(stubBase());
    const context = stubContext();
    const used = await runContextFixture(wrapped, context);
    assert.equal(used, context, 'context must be passed through');
    assert.equal(context.scripts.length, 1);
    assert.ok(context.scripts[0].includes('#cta'));
    assert.ok(context.scripts[0].includes('800'));
    assert.equal(
      typeof context.bindings[REPORT_FN],
      'function',
      'the report binding must be exposed before the init script runs',
    );

    const afterInstall = await readAcks(ackDir);
    assert.equal(afterInstall.length, 1, 'exactly one receipt so far: the initial installation ack');
    assert.deepEqual(
      afterInstall[0],
      { installed: true, count: null, ruleLive: null },
      'installation is acknowledged before any page has had a chance to report back',
    );

    // Simulate the page reporting its real match count back through the
    // exposed binding once the document is populated.
    await context.bindings[REPORT_FN]({}, 3, true);
    const afterReport = await readAcks(ackDir);
    assert.equal(
      afterReport.length,
      2,
      'the real report must land in its OWN file, never overwrite the installation receipt (Fix 1)',
    );
    // Each receipt is its own file (Fix 1); readdir makes no promise about
    // filesystem enumeration order, so compare the two receipts as a set
    // rather than assuming the installation receipt sorts first.
    const sorted = [...afterReport].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const expected = [
      { installed: true, count: null, ruleLive: null },
      { installed: true, count: 3, ruleLive: true },
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(sorted, expected, 'the installation receipt survives untouched alongside the real report');
  } finally {
    delete process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
    delete process.env.FLAKEPROOF_TEMPORAL_MS;
    delete process.env.FLAKEPROOF_TEMPORAL_ACK;
    await rm(ackDir, { recursive: true, force: true });
  }
});

test('two writers reporting in the same round each keep their own receipt', async () => {
  // Mirrors what actually happens with a page plus an iframe, or two pages
  // in one context: addInitScript runs in every frame, and each one calls
  // the binding independently. Fix 1 in the review: the previous design
  // overwrote a single shared file, so whichever writer finished LAST won,
  // even if an earlier writer reported a genuine match.
  process.env.FLAKEPROOF_TEMPORAL_SELECTOR = '#cta';
  process.env.FLAKEPROOF_TEMPORAL_MS = '800';
  const ackDir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
  process.env.FLAKEPROOF_TEMPORAL_ACK = ackDir;
  try {
    const context = stubContext();
    await runContextFixture(withTemporal(stubBase()), context);
    // The main page frame reports a genuine match...
    await context.bindings[REPORT_FN]({}, 1, true);
    // ...and an unrelated iframe (or a second page) reports 0, finishing
    // after the genuine match.
    await context.bindings[REPORT_FN]({}, 0, true);
    const acks = await readAcks(ackDir);
    const counts = acks.map((a) => a.count).sort();
    assert.deepEqual(
      counts,
      [null, 0, 1].sort(),
      'every writer kept its own receipt; the 0 from the second writer must not have erased the 1',
    );
  } finally {
    delete process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
    delete process.env.FLAKEPROOF_TEMPORAL_MS;
    delete process.env.FLAKEPROOF_TEMPORAL_ACK;
    await rm(ackDir, { recursive: true, force: true });
  }
});

test('does nothing without env vars or with an invalid delay', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'fp-ack-'));
  const ackDir = join(scratch, 'acks');
  process.env.FLAKEPROOF_TEMPORAL_ACK = ackDir;
  try {
    const wrapped = withTemporal(stubBase());
    const context = stubContext();
    await runContextFixture(wrapped, context);
    assert.equal(context.scripts.length, 0);
    assert.equal(Object.keys(context.bindings).length, 0, 'no injection means no report binding either');
    assert.equal(existsSync(ackDir), false, 'no selector/ms means no injection, so the ack directory is never even created');

    process.env.FLAKEPROOF_TEMPORAL_SELECTOR = '#cta';
    process.env.FLAKEPROOF_TEMPORAL_MS = 'not-a-number';
    try {
      const context2 = stubContext();
      await runContextFixture(withTemporal(stubBase()), context2);
      assert.equal(context2.scripts.length, 0);
    } finally {
      delete process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
      delete process.env.FLAKEPROOF_TEMPORAL_MS;
    }
  } finally {
    delete process.env.FLAKEPROOF_TEMPORAL_ACK;
    await rm(scratch, { recursive: true, force: true });
  }
});

test('a failure to write the ack file never breaks the fixture', async () => {
  process.env.FLAKEPROOF_TEMPORAL_SELECTOR = '#cta';
  process.env.FLAKEPROOF_TEMPORAL_MS = '800';
  // A path that already exists as a plain FILE (not a directory) makes
  // `mkdir(path, { recursive: true })` fail, simulating a real write
  // failure (e.g. permissions) without relying on a parent directory that
  // simply does not exist yet, which `mkdir`'s own recursive mode would now
  // happily create.
  const scratch = await mkdtemp(join(tmpdir(), 'fp-ack-'));
  const blocked = join(scratch, 'blocked');
  await writeFile(blocked, 'not a directory');
  process.env.FLAKEPROOF_TEMPORAL_ACK = blocked;
  try {
    const wrapped = withTemporal(stubBase());
    const context = stubContext();
    await assert.doesNotReject(() => runContextFixture(wrapped, context));
    assert.equal(context.scripts.length, 1, 'the injection itself must still happen');
    await assert.doesNotReject(() => context.bindings[REPORT_FN]({}, 2, true), 'a late report must not throw either');
  } finally {
    delete process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
    delete process.env.FLAKEPROOF_TEMPORAL_MS;
    delete process.env.FLAKEPROOF_TEMPORAL_ACK;
    await rm(scratch, { recursive: true, force: true });
  }
});
