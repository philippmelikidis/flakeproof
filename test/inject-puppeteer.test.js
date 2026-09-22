import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTemporal } from '../src/inject/puppeteer.js';
import { captureStdout } from './helpers/capture-stdout.js';

async function readAcks(ackDir) {
  if (!existsSync(ackDir)) return [];
  const entries = await readdir(ackDir);
  return Promise.all(entries.map((entry) => readFile(join(ackDir, entry), 'utf8').then((raw) => JSON.parse(raw))));
}

function stubPage() {
  return {
    scripts: [],
    bindings: {},
    async evaluateOnNewDocument(source) {
      this.scripts.push(source);
    },
    async exposeFunction(name, fn) {
      this.bindings[name] = fn;
    },
  };
}

test('installs the temporal script and acknowledges installation before any count is known', async () => {
  const ackDir = await mkdtemp(join(tmpdir(), 'fp-pptr-ack-'));
  try {
    const page = stubPage();
    const installed = await installTemporal(page, {
      env: { FLAKEPROOF_TEMPORAL_SELECTOR: '#cta', FLAKEPROOF_TEMPORAL_MS: '800', FLAKEPROOF_TEMPORAL_ACK: ackDir },
    });
    assert.equal(installed, true);
    assert.equal(page.scripts.length, 1);
    assert.ok(page.scripts[0].includes('#cta'));
    assert.equal(typeof page.bindings.__flakeproofTemporalMatchCount, 'function');

    const afterInstall = await readAcks(ackDir);
    assert.equal(afterInstall.length, 1);
    assert.deepEqual(afterInstall[0], { installed: true, count: null, ruleLive: null });

    await page.bindings.__flakeproofTemporalMatchCount(2, true);
    const afterReport = await readAcks(ackDir);
    assert.equal(afterReport.length, 2, 'the real report lands in its own file');
    assert.ok(afterReport.some((a) => a.count === 2 && a.ruleLive === true));
  } finally {
    await rm(ackDir, { recursive: true, force: true });
  }
});

// Issue #21: every ack write also goes out as a marker on stdout, so
// temporalProbe can recover it even when the ack directory this file uses
// turns out to be on a filesystem flakeproof cannot see (a container or a
// remote runner). One receipt (the initial "installed" ack) is enough to
// prove the writer emits a valid marker; the ack-file test above already
// proves the second report lands in the file channel too.
test('also acknowledges installation as a stdout marker, with the same id the file uses', async () => {
  const ackDir = await mkdtemp(join(tmpdir(), 'fp-pptr-ack-'));
  try {
    const page = stubPage();
    const { markers } = await captureStdout(() =>
      installTemporal(page, {
        env: { FLAKEPROOF_TEMPORAL_SELECTOR: '#cta', FLAKEPROOF_TEMPORAL_MS: '800', FLAKEPROOF_TEMPORAL_ACK: ackDir },
      }),
    );
    assert.equal(markers.length, 1);
    assert.equal(markers[0].kind, 'temporal');
    assert.deepEqual(
      { installed: markers[0].installed, count: markers[0].count, ruleLive: markers[0].ruleLive },
      { installed: true, count: null, ruleLive: null },
    );
    const [fileEntry] = await readdir(ackDir);
    assert.equal(markers[0].id, fileEntry.replace(/\.json$/, ''), 'the marker and the file must share one id');
  } finally {
    await rm(ackDir, { recursive: true, force: true });
  }
});

test('does nothing without env vars', async () => {
  const page = stubPage();
  const installed = await installTemporal(page, { env: {} });
  assert.equal(installed, false);
  assert.equal(page.scripts.length, 0);
  assert.equal(Object.keys(page.bindings).length, 0);
});

test('does nothing with an invalid delay', async () => {
  const page = stubPage();
  const installed = await installTemporal(page, {
    env: { FLAKEPROOF_TEMPORAL_SELECTOR: '#cta', FLAKEPROOF_TEMPORAL_MS: 'not-a-number' },
  });
  assert.equal(installed, false);
  assert.equal(page.scripts.length, 0);
});
