import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTemporal, TEMPORAL_ACK_TASK } from '../src/inject/cypress.js';
import { registerTemporalTask } from '../src/inject/cypress-node.js';

async function readAcks(ackDir) {
  if (!existsSync(ackDir)) return [];
  const entries = await readdir(ackDir);
  return Promise.all(entries.map((entry) => readFile(join(ackDir, entry), 'utf8').then((raw) => JSON.parse(raw))));
}

function stubCypress(env) {
  return {
    env: (key) => env[key],
    handlers: {},
    on(event, fn) {
      this.handlers[event] = fn;
    },
  };
}

function stubCy() {
  return {
    tasks: [],
    task(name, payload) {
      this.tasks.push({ name, payload });
    },
    windowValue: null,
    window() {
      return Promise.resolve(this.windowValue);
    },
  };
}

function stubWindow() {
  const listeners = {};
  return {
    document: {
      readyState: 'complete',
      documentElement: {
        appendChild() {},
      },
      createElement: () => ({ textContent: '', sheet: undefined, remove() {} }),
      querySelectorAll: () => [{}],
      addEventListener(name, fn) {
        listeners[name] = fn;
      },
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
}

// registerTemporalTask is Node-side glue; exercise it directly against the
// same on('task', {...}) shape Cypress calls it with.
test('registerTemporalTask writes the ack file the browser-side hook hands it', async () => {
  const ackDir = await mkdtemp(join(tmpdir(), 'fp-cy-ack-'));
  process.env.FLAKEPROOF_TEMPORAL_ACK = ackDir;
  try {
    let handler;
    registerTemporalTask((event, handlers) => {
      assert.equal(event, 'task');
      handler = handlers[TEMPORAL_ACK_TASK];
    });
    assert.equal(typeof handler, 'function');
    const result = await handler({ count: 1, ruleLive: true });
    assert.equal(result, null, 'cy.task rejects an undefined resolution, so this must resolve to null');
    const acks = await readAcks(ackDir);
    assert.equal(acks.length, 1);
    assert.deepEqual(acks[0], { installed: true, count: 1, ruleLive: true });
  } finally {
    delete process.env.FLAKEPROOF_TEMPORAL_ACK;
    await rm(ackDir, { recursive: true, force: true });
  }
});

test('installTemporal is inert without env vars', () => {
  const Cypress = stubCypress({});
  const cy = stubCy();
  const beforeEachCalls = [];
  const afterEachCalls = [];
  installTemporal(Cypress, cy, { beforeEachFn: (fn) => beforeEachCalls.push(fn), afterEachFn: (fn) => afterEachCalls.push(fn) });
  assert.equal(typeof Cypress.handlers['window:before:load'], 'function');
  Cypress.handlers['window:before:load'](stubWindow());
  beforeEachCalls[0]();
  assert.equal(cy.tasks.length, 0, 'no selector/ms means no task call at all');
});

test('installTemporal injects the hiding style and reports back through cy.task', async () => {
  const Cypress = stubCypress({ FLAKEPROOF_TEMPORAL_SELECTOR: '#cta', FLAKEPROOF_TEMPORAL_MS: '50' });
  const cy = stubCy();
  const beforeEachCalls = [];
  const afterEachCalls = [];
  installTemporal(Cypress, cy, { beforeEachFn: (fn) => beforeEachCalls.push(fn), afterEachFn: (fn) => afterEachCalls.push(fn) });

  beforeEachCalls[0]();
  assert.equal(cy.tasks.length, 1);
  assert.deepEqual(cy.tasks[0], { name: TEMPORAL_ACK_TASK, payload: { count: null, ruleLive: null } });

  const win = stubWindow();
  Cypress.handlers['window:before:load'](win);
  // report() runs synchronously since document.readyState is 'complete'
  assert.deepEqual(win.__flakeproofTemporalResult, { count: 1, ruleLive: false });

  cy.windowValue = win;
  await afterEachCalls[0]();
  assert.equal(cy.tasks.length, 2);
  assert.deepEqual(cy.tasks[1], { name: TEMPORAL_ACK_TASK, payload: { count: 1, ruleLive: false } });
});

test('installTemporal throws outside a Cypress support file', () => {
  assert.throws(() => installTemporal(undefined, undefined), /Cypress support file/);
});
