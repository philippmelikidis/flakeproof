import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize, runAndReport, SetupError } from '../action/scripts/run-and-report.js';

test('summarize reports blind runs distinctly from ordinary green runs', () => {
  assert.deepEqual(summarize({ blind: true }), { blind: true, failures: 0, verdictCounts: {}, oneLine: 'flakeproof could not determine which tests failed.' });
});

test('summarize reports a clean run with no failures', () => {
  const s = summarize({ blind: false, failures: 0, results: [] });
  assert.equal(s.oneLine, 'No failed tests to triage.');
});

test('summarize tallies verdicts across every triaged failure', () => {
  const s = summarize({
    blind: false,
    failures: 3,
    results: [{ triage: { verdict: 'fragile' } }, { triage: { verdict: 'fragile' } }, { triage: { verdict: 'real-change' } }],
  });
  assert.deepEqual(s.verdictCounts, { fragile: 2, 'real-change': 1 });
  assert.match(s.oneLine, /3 failed test\(s\) triaged/);
});

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'fp-action-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('runAndReport refuses to invent a baseline and names the exact fix', async () => {
  await withTempDir(async (dir) => {
    process.env.INPUT_TEST_COMMAND = 'true';
    process.env.INPUT_APP_URL = 'https://example.test';
    process.env.INPUT_RESULTS_PATH = '';
    process.env.INPUT_READER = '';
    process.env.INPUT_BASELINE_PATH = '';
    try {
      await assert.rejects(
        () => runAndReport({ cwd: dir, summaryPath: join(dir, 'summary.md'), htmlPath: join(dir, 'report.html') }),
        (err) => {
          assert.ok(err instanceof SetupError);
          assert.match(err.message, /no baseline at/);
          assert.match(err.message, /node bin\/flakeproof\.js baseline/);
          return true;
        },
      );
    } finally {
      delete process.env.INPUT_TEST_COMMAND;
      delete process.env.INPUT_APP_URL;
      delete process.env.INPUT_RESULTS_PATH;
      delete process.env.INPUT_READER;
      delete process.env.INPUT_BASELINE_PATH;
    }
  });
});

test('runAndReport reports a setup problem instead of running when the command is missing', async () => {
  await withTempDir(async (dir) => {
    process.env.INPUT_TEST_COMMAND = '';
    process.env.INPUT_APP_URL = 'https://example.test';
    try {
      await assert.rejects(
        () => runAndReport({ cwd: dir, summaryPath: join(dir, 'summary.md'), htmlPath: join(dir, 'report.html') }),
        (err) => {
          assert.ok(err instanceof SetupError);
          assert.match(err.message, /no test command/);
          return true;
        },
      );
    } finally {
      delete process.env.INPUT_TEST_COMMAND;
      delete process.env.INPUT_APP_URL;
    }
  });
});

test('runAndReport writes both report formats from a single suite run', async () => {
  await withTempDir(async (dir) => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, '.flakeproof'), { recursive: true });
    await writeFile(join(dir, '.flakeproof/baseline.json'), JSON.stringify({ tree: null, html: '<html></html>' }), 'utf8');
    await writeFile(join(dir, 'results.json'), JSON.stringify({ suites: [] }), 'utf8');
    process.env.INPUT_TEST_COMMAND = 'true';
    process.env.INPUT_APP_URL = 'https://example.test';
    try {
      const summaryPath = join(dir, 'summary.md');
      const htmlPath = join(dir, 'report.html');
      const { run, summary } = await runAndReport({ cwd: dir, summaryPath, htmlPath });
      assert.equal(run.blind, false);
      assert.equal(run.failures, 0);
      assert.equal(summary.oneLine, 'No failed tests to triage.');
      const { readFile } = await import('node:fs/promises');
      const md = await readFile(summaryPath, 'utf8');
      const html = await readFile(htmlPath, 'utf8');
      assert.match(md, /No failed tests to triage/);
      assert.match(html, /<!doctype html>/i);
    } finally {
      delete process.env.INPUT_TEST_COMMAND;
      delete process.env.INPUT_APP_URL;
    }
  });
});
