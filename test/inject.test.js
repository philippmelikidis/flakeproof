import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTemporal } from '../src/inject/playwright.js';

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
  const ackPath = join(ackDir, 'ack');
  process.env.FLAKEPROOF_TEMPORAL_ACK = ackPath;
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

    const initial = JSON.parse(await readFile(ackPath, 'utf8'));
    assert.deepEqual(
      initial,
      { installed: true, count: null },
      'installation is acknowledged before any page has had a chance to report back',
    );

    // Simulate the page reporting its real match count back through the
    // exposed binding once the document is populated.
    await context.bindings[REPORT_FN]({}, 3);
    const updated = JSON.parse(await readFile(ackPath, 'utf8'));
    assert.deepEqual(updated, { installed: true, count: 3 }, 'the binding overwrites the receipt with the real count');
  } finally {
    delete process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
    delete process.env.FLAKEPROOF_TEMPORAL_MS;
    delete process.env.FLAKEPROOF_TEMPORAL_ACK;
    await rm(ackDir, { recursive: true, force: true });
  }
});

test('does nothing without env vars or with an invalid delay', async () => {
  const ackDir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
  const ackPath = join(ackDir, 'ack');
  process.env.FLAKEPROOF_TEMPORAL_ACK = ackPath;
  try {
    const wrapped = withTemporal(stubBase());
    const context = stubContext();
    await runContextFixture(wrapped, context);
    assert.equal(context.scripts.length, 0);
    assert.equal(Object.keys(context.bindings).length, 0, 'no injection means no report binding either');
    assert.equal(existsSync(ackPath), false, 'no selector/ms means no injection, so no acknowledgment either');

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
    await rm(ackDir, { recursive: true, force: true });
  }
});

test('a failure to write the ack file never breaks the fixture', async () => {
  process.env.FLAKEPROOF_TEMPORAL_SELECTOR = '#cta';
  process.env.FLAKEPROOF_TEMPORAL_MS = '800';
  // A directory that does not exist makes every writeFile to it fail.
  process.env.FLAKEPROOF_TEMPORAL_ACK = join(tmpdir(), 'fp-ack-missing-dir-xyz', 'ack');
  try {
    const wrapped = withTemporal(stubBase());
    const context = stubContext();
    await assert.doesNotReject(() => runContextFixture(wrapped, context));
    assert.equal(context.scripts.length, 1, 'the injection itself must still happen');
    await assert.doesNotReject(() => context.bindings[REPORT_FN]({}, 2), 'a late report must not throw either');
  } finally {
    delete process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
    delete process.env.FLAKEPROOF_TEMPORAL_MS;
    delete process.env.FLAKEPROOF_TEMPORAL_ACK;
  }
});
