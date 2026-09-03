import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTemporal } from '../src/inject/selenium.js';

async function readAcks(ackDir) {
  if (!existsSync(ackDir)) return [];
  const entries = await readdir(ackDir);
  return Promise.all(entries.map((entry) => readFile(join(ackDir, entry), 'utf8').then((raw) => JSON.parse(raw))));
}

// Mirrors selenium-webdriver's CDPConnection closely enough for
// installTemporal: `send(method, params)` records the call and resolves, and
// `_wsConnection` is a plain EventEmitter installTemporal listens on for
// Runtime.bindingCalled - see src/inject/selenium.js's header comment for why
// that internal property is what is actually used.
function stubConnection() {
  const calls = [];
  return {
    calls,
    _wsConnection: new EventEmitter(),
    async send(method, params) {
      calls.push({ method, params });
      return { id: calls.length, result: {} };
    },
    emitBindingCalled(name, payload) {
      this._wsConnection.emit(
        'message',
        Buffer.from(JSON.stringify({ method: 'Runtime.bindingCalled', params: { name, payload } })),
      );
    },
  };
}

function stubDriver(connection) {
  return { async createCDPConnection() { return connection; } };
}

test('installs the script via CDP and acknowledges installation before any count is known', async () => {
  const ackDir = await mkdtemp(join(tmpdir(), 'fp-sel-ack-'));
  try {
    const connection = stubConnection();
    const driver = stubDriver(connection);
    const installed = await installTemporal(driver, {
      env: { FLAKEPROOF_TEMPORAL_SELECTOR: '#cta', FLAKEPROOF_TEMPORAL_MS: '800', FLAKEPROOF_TEMPORAL_ACK: ackDir },
    });
    assert.equal(installed, true);

    const methods = connection.calls.map((c) => c.method);
    assert.ok(methods.includes('Page.enable'));
    assert.ok(methods.includes('Runtime.enable'));
    assert.ok(methods.includes('Runtime.addBinding'));
    const addScript = connection.calls.find((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument');
    assert.ok(addScript, 'the init script must be registered');
    assert.ok(addScript.params.source.includes('#cta'));

    const afterInstall = await readAcks(ackDir);
    assert.equal(afterInstall.length, 1);
    assert.deepEqual(afterInstall[0], { installed: true, count: null, ruleLive: null });

    connection.emitBindingCalled('__flakeproofTemporalMatchCount', JSON.stringify({ count: 1, ruleLive: true }));
    // the listener writes asynchronously (fire-and-forget inside an event
    // handler); give it a tick to land.
    await new Promise((r) => setTimeout(r, 20));
    const afterReport = await readAcks(ackDir);
    assert.equal(afterReport.length, 2);
    assert.ok(afterReport.some((a) => a.count === 1 && a.ruleLive === true));
  } finally {
    await rm(ackDir, { recursive: true, force: true });
  }
});

test('does nothing without env vars', async () => {
  const connection = stubConnection();
  const driver = stubDriver(connection);
  const installed = await installTemporal(driver, { env: {} });
  assert.equal(installed, false);
  assert.equal(connection.calls.length, 0);
});

test('an unparseable binding payload is ignored rather than fabricating a count', async () => {
  const ackDir = await mkdtemp(join(tmpdir(), 'fp-sel-ack-'));
  try {
    const connection = stubConnection();
    const driver = stubDriver(connection);
    await installTemporal(driver, {
      env: { FLAKEPROOF_TEMPORAL_SELECTOR: '#cta', FLAKEPROOF_TEMPORAL_MS: '800', FLAKEPROOF_TEMPORAL_ACK: ackDir },
    });
    connection.emitBindingCalled('__flakeproofTemporalMatchCount', 'not json');
    await new Promise((r) => setTimeout(r, 20));
    const acks = await readAcks(ackDir);
    assert.equal(acks.length, 1, 'only the initial installation receipt - the garbage payload wrote nothing');
  } finally {
    await rm(ackDir, { recursive: true, force: true });
  }
});

test('no CDP connection available reports not installed instead of throwing', async () => {
  const driver = { async createCDPConnection() { throw new Error('no CDP endpoint'); } };
  const installed = await installTemporal(driver, {
    env: { FLAKEPROOF_TEMPORAL_SELECTOR: '#cta', FLAKEPROOF_TEMPORAL_MS: '800' },
  });
  assert.equal(installed, false);
});
