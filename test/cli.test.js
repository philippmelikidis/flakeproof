import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from './helpers/serve.js';
import { renderReport } from '../src/report.js';

const run = promisify(execFile);

test('renderReport shows verdict, evidence and recommendation table', () => {
  const md = renderReport({
    verdict: 'fragile',
    testId: 'Menu Test',
    anchor: { selector: 'li.css-1a2b3c', kind: 'timeout' },
    rerun: { runs: 3, failures: 3, exitCodes: [1, 1, 1] },
    classification: { verdict: 'cosmetic', reasons: ['selector relies on build-generated class ".css-1a2b3c" which is gone from the element'] },
    recommendation: [{ selector: '#main-nav li:nth-child(1)', kind: 'positional', uniqueInCurrent: true, survived: 4, applied: 5 }],
    temporal: { reproduced: true, delay: 500, tried: [{ delay: 250, failures: 0, runs: 2 }, { delay: 500, failures: 2, runs: 2 }] },
    notes: ['test failed on every rerun; deterministic failure'],
  });
  assert.ok(md.includes('**fragile**'));
  assert.ok(md.includes('`li.css-1a2b3c`'));
  assert.ok(md.includes('| `#main-nav li:nth-child(1)` | positional | yes | 4/5 |'));
  assert.ok(md.includes('## Timing provocation'));
  assert.ok(md.includes('- 500 ms: 2/2 runs failed (reproduces)'));
  assert.ok(!md.includes('- 250 ms: 0/2 runs failed (reproduces)'));
});

test('renderReport does not show empty Timing provocation section', () => {
  const md = renderReport({
    verdict: 'nondeterministic',
    temporal: { reproduced: false, delay: null, tried: [], control: { failures: 2, runs: 2 } },
  });
  assert.ok(!md.includes('## Timing provocation'), 'empty tried array should not render the section');
});

test('cli snapshot and triage round-trip on the fixture page', async () => {
  let server = null;
  let dir = null;
  try {
    server = await startFixtureServer();
    dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
    const baseline = join(dir, 'baseline.json');
    const errFile = join(dir, 'error.txt');
    await writeFile(errFile, "TimeoutError: locator.waitFor: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('#cta') to be visible");

    await run('node', ['bin/flakeproof.js', 'snapshot', server.url, '--out', baseline]);
    const { stdout } = await run('node', [
      'bin/flakeproof.js', 'triage',
      '--baseline', baseline,
      '--error-file', errFile,
      '--current', baseline,
      '--json',
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.verdict, 'unclear');
    assert.equal(result.anchor.selector, '#cta');
  } finally {
    await server?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('cli writes a self-contained html report when the output ends in .html', async () => {
  const server = await startFixtureServer();
  const dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
  try {
    const baseline = join(dir, 'baseline.json');
    const errFile = join(dir, 'error.txt');
    const outFile = join(dir, 'report.html');
    await writeFile(errFile, "TimeoutError: locator.waitFor: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('#cta') to be visible");

    await run('node', ['bin/flakeproof.js', 'snapshot', server.url, '--out', baseline]);
    await run('node', ['bin/flakeproof.js', 'triage', '--baseline', baseline, '--error-file', errFile, '--current', baseline, '--out', outFile]);

    const html = await readFile(outFile, 'utf8');
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('What flakeproof did'));
    assert.ok(!/<script/i.test(html));
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing desktop opener does not fail a run that produced a verdict', async () => {
  const server = await startFixtureServer();
  const dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
  try {
    const baseline = join(dir, 'baseline.json');
    const errFile = join(dir, 'error.txt');
    const outFile = join(dir, 'report.html');
    await writeFile(errFile, "TimeoutError: locator.waitFor: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('#cta') to be visible");
    await run(process.execPath, ['bin/flakeproof.js', 'snapshot', server.url, '--out', baseline]);
    await run(process.execPath, ['bin/flakeproof.js', 'triage', '--baseline', baseline, '--error-file', errFile, '--current', baseline, '--out', outFile, '--open'], { env: { ...process.env, PATH: '' } });
    const html = await readFile(outFile, 'utf8');
    assert.ok(html.startsWith('<!doctype html>'), 'the report is still written');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('baseline subcommand writes to the default location', async () => {
  let server = null;
  let dir = null;
  try {
    server = await startFixtureServer();
    dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
    await run('node', [join(process.cwd(), 'bin/flakeproof.js'), 'baseline', server.url], { cwd: dir });
    const snap = JSON.parse(await readFile(join(dir, '.flakeproof', 'baseline.json'), 'utf8'));
    assert.equal(snap.tree.tag, 'html');
  } finally {
    if (server) await server.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('run subcommand triages a red suite and writes a summary', async () => {
  let server = null;
  let dir = null;
  try {
    server = await startFixtureServer();
    dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
    await run('node', [join(process.cwd(), 'bin/flakeproof.js'), 'baseline', server.url], { cwd: dir });
    await copyFile(join(process.cwd(), 'test/fixtures/runner/playwright-results.json'), join(dir, 'results.json'));
    const outFile = join(dir, 'run.html');
    await run('node', [
      join(process.cwd(), 'bin/flakeproof.js'), 'run',
      '--cmd', 'node -e "process.exit(1)"',
      '--url', server.url,
      '--results', 'results.json',
      '--out', outFile,
    ], { cwd: dir });
    const html = await readFile(outFile, 'utf8');
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(/\d+ failed tests?/.test(html), html);
  } finally {
    if (server) await server.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a missing baseline is named with the command that fixes it', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
    await assert.rejects(
      () => run('node', [join(process.cwd(), 'bin/flakeproof.js'), 'run', '--cmd', 'node -e "process.exit(0)"', '--url', 'http://127.0.0.1:1', '--results', 'r.json'], { cwd: dir }),
      (err) => /flakeproof baseline/.test(err.stderr ?? String(err)),
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
