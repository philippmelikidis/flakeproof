import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { runSuite } from '../src/runner/index.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('a green run reports no failures and does not triage', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-run-'));
    const result = await runSuite({
      cmd: 'node -e "process.exit(0)"',
      resultsPath: join(dir, 'missing.json'),
      reader: 'playwright',
      cwd: dir,
    });
    assert.equal(result.ran, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.failures, 0);
    assert.equal(result.results.length, 0);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a red run without a readable result file says so instead of claiming success', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-run-'));
    const result = await runSuite({
      cmd: 'node -e "process.exit(1)"',
      resultsPath: join(dir, 'missing.json'),
      reader: 'playwright',
      cwd: dir,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.failures, 0);
    assert.ok(result.notes.some((n) => /could not read/i.test(n)), JSON.stringify(result.notes));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a red run triages every failed test it finds', async () => {
  let dir = null;
  let server = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-run-'));
    server = await startFixtureServer();
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(server.url)));
    const resultsPath = join(dir, 'results.json');
    await copyFile(join(fixtures, 'runner', 'playwright-results.json'), resultsPath);

    const result = await runSuite({
      cmd: 'node -e "process.exit(1)"',
      url: server.url,
      baselinePath,
      resultsPath,
      reader: 'playwright',
      cwd: dir,
    });
    assert.equal(result.failures, 1);
    assert.equal(result.results.length, 1);
    assert.ok(result.results[0].triage.verdict, 'each failure carries a verdict');
    assert.match(result.results[0].testId, /expect timeout fixture/);
  } finally {
    if (server) await server.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
