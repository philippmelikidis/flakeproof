import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTemporal } from '../src/inject/playwright.js';

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
    async addInitScript(source) {
      this.scripts.push(source);
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

test('injects the temporal script when both env vars are set', async () => {
  process.env.FLAKEPROOF_TEMPORAL_SELECTOR = '#cta';
  process.env.FLAKEPROOF_TEMPORAL_MS = '800';
  try {
    const wrapped = withTemporal(stubBase());
    const context = stubContext();
    const used = await runContextFixture(wrapped, context);
    assert.equal(used, context, 'context must be passed through');
    assert.equal(context.scripts.length, 1);
    assert.ok(context.scripts[0].includes('#cta'));
    assert.ok(context.scripts[0].includes('800'));
  } finally {
    delete process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
    delete process.env.FLAKEPROOF_TEMPORAL_MS;
  }
});

test('does nothing without env vars or with an invalid delay', async () => {
  const wrapped = withTemporal(stubBase());
  const context = stubContext();
  await runContextFixture(wrapped, context);
  assert.equal(context.scripts.length, 0);

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
});
