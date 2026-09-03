import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { runSuite } from '../src/runner/index.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('a green run with readable empty results reports no failures and no note', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-run-'));
    const resultsPath = join(dir, 'results.json');
    await writeFile(resultsPath, JSON.stringify({ suites: [] }));
    const result = await runSuite({
      cmd: 'node -e "process.exit(0)"',
      resultsPath,
      reader: 'playwright',
      cwd: dir,
    });
    assert.equal(result.ran, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.failures, 0);
    assert.equal(result.results.length, 0);
    assert.equal(result.blind, false);
    assert.deepEqual(result.notes, [], 'a genuinely green run needs no explanation');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a green run whose result file is missing still says so', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-run-'));
    const result = await runSuite({
      cmd: 'node -e "process.exit(0)"',
      resultsPath: join(dir, 'missing.json'),
      reader: 'playwright',
      cwd: dir,
    });
    assert.equal(result.failures, 0);
    assert.equal(result.blind, true);
    assert.ok(result.notes.some((n) => /could not read/i.test(n)), 'a missing file is never silently green');
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
    assert.equal(result.blind, true);
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

test('one bad failure does not discard the rest of the triage run', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-run-'));
    const resultsPath = join(dir, 'results.json');
    await copyFile(join(fixtures, 'runner', 'playwright-results.json'), resultsPath);
    const baselinePath = join(dir, 'does-not-exist.json');

    const result = await runSuite({
      cmd: 'node -e "process.exit(1)"',
      url: 'http://127.0.0.1:1',
      baselinePath,
      resultsPath,
      reader: 'playwright',
      cwd: dir,
    });
    assert.equal(result.failures, 1);
    assert.equal(result.results.length, 0);
    assert.ok(result.notes.some((n) => /could not triage/i.test(n)), JSON.stringify(result.notes));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a stale results file is flagged when the command succeeded but failures are listed', async () => {
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
      cmd: 'node -e "process.exit(0)"',
      url: server.url,
      baselinePath,
      resultsPath,
      reader: 'playwright',
      cwd: dir,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.failures, 1);
    assert.equal(result.results.length, 1);
    assert.ok(
      result.notes.some((n) => /may be stale/i.test(n)),
      JSON.stringify(result.notes),
    );
  } finally {
    if (server) await server.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown reader name fails upfront, listing the valid ones, before the test command spawns', async () => {
  // If this ever spawned the command first, this "command" would leave
  // proof (a file) that the assertion below can catch.
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-run-'));
    const marker = join(dir, 'spawned');
    await assert.rejects(
      () =>
        runSuite({
          cmd: `node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`,
          resultsPath: join(dir, 'results.json'),
          reader: 'nonexistent-framework',
          cwd: dir,
        }),
      /unknown result reader "nonexistent-framework".*playwright.*robot.*cypress.*selenium.*puppeteer/s,
    );
    assert.equal(existsSync(marker), false, 'the test command must never spawn for an unknown reader');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
