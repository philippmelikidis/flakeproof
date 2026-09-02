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
    temporal: {
      reproduced: true,
      delay: 500,
      // Deliberately different matched counts per round: the report must
      // surface the per-round count (item F), which is exactly the evidence
      // that would expose a bug like "matched N on every round" being
      // claimed when the rounds actually disagreed (item C).
      tried: [
        { delay: 250, failures: 0, runs: 2, matched: 3, ruleLive: true },
        { delay: 500, failures: 2, runs: 2, matched: 5, ruleLive: true },
      ],
    },
    notes: ['test failed on every rerun; deterministic failure'],
  });
  assert.ok(md.includes('**fragile**'));
  assert.ok(md.includes('`li.css-1a2b3c`'));
  assert.ok(md.includes('| `#main-nav li:nth-child(1)` | positional | yes | 4/5 |'));
  assert.ok(md.includes('## Timing provocation'));
  assert.ok(md.includes('- 500 ms: 2/2 runs failed, 5 matched, rule live (reproduces)'));
  assert.ok(md.includes('- 250 ms: 0/2 runs failed, 3 matched, rule live'));
  assert.ok(!md.includes('- 250 ms: 0/2 runs failed, 3 matched, rule live (reproduces)'));
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

// A fake, wrapper-free suite: acknowledges nothing, always green. Enough to
// exercise the CLI's wiring (flags, config fallback, --out formats, exit
// code) without a real browser - the honesty behavior itself is proven
// against a real Playwright run in test/blindspots-e2e.test.js.
async function writeFakeGreenSuite(dir) {
  const script = join(dir, 'suite.cjs');
  await writeFile(script, 'require("fs").writeFileSync(process.env.FP_RESULTS_PATH, JSON.stringify({ suites: [] })); process.exit(0);');
  return script;
}

test('blindspots subcommand refuses to score a suite that never installed the wrapper', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
    const script = await writeFakeGreenSuite(dir);
    const resultsPath = join(dir, 'results.json');
    // An abstained measurement exits 1 (see bin/flakeproof.js), so execFile
    // rejects even though a report was printed; the report is on the
    // rejection's own stdout, same pattern as the missing-baseline test.
    const err = await run(
      'node',
      [
        join(process.cwd(), 'bin/flakeproof.js'), 'blindspots',
        '--cmd', `node ${script}`,
        '--results', 'results.json',
        '--selectors', '#cta',
        '--mutations', 'change-text',
      ],
      { cwd: dir, env: { ...process.env, FP_RESULTS_PATH: resultsPath } },
    ).then(
      () => { throw new Error('expected the CLI to exit 1 on an abstained measurement'); },
      (e) => e,
    );
    assert.ok(err.stdout.includes('No score') || err.stdout.includes('cannot compute a score'));
    assert.ok(err.stdout.includes('withTemporal'));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('blindspots subcommand reads selectors from flakeproof.config.json and writes an html report', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
    const script = await writeFakeGreenSuite(dir);
    const resultsPath = join(dir, 'results.json');
    await writeFile(
      join(dir, 'flakeproof.config.json'),
      JSON.stringify({ cmd: `node ${script}`, results: 'results.json', blindspots: { selectors: ['#cta'], mutations: ['change-text'] } }),
    );
    const outFile = join(dir, 'blindspots.html');
    await run('node', [join(process.cwd(), 'bin/flakeproof.js'), 'blindspots', '--out', outFile], {
      cwd: dir,
      env: { ...process.env, FP_RESULTS_PATH: resultsPath },
    }).catch(() => {}); // abstained measurements exit 1; the file is still written
    const html = await readFile(outFile, 'utf8');
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('No score'), 'the fake suite never installs the wrapper, so this must abstain');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('blindspots subcommand requires at least one selector', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
    await assert.rejects(
      () => run('node', [join(process.cwd(), 'bin/flakeproof.js'), 'blindspots', '--cmd', 'node -e "process.exit(0)"'], { cwd: dir }),
      (err) => /at least one selector/.test(err.stderr ?? String(err)),
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('blindspots subcommand rejects a comma-followed-by-space selector instead of silently splitting it', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
    await assert.rejects(
      () =>
        run('node', [join(process.cwd(), 'bin/flakeproof.js'), 'blindspots', '--cmd', 'node -e "process.exit(0)"', '--selectors', '#a, #b'], {
          cwd: dir,
        }),
      (err) => /compound css selector/.test(err.stderr ?? String(err)),
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('blindspots subcommand rejects the robot reader upfront, before spawning anything', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
    await assert.rejects(
      () =>
        run(
          'node',
          [join(process.cwd(), 'bin/flakeproof.js'), 'blindspots', '--cmd', 'node -e "process.exit(0)"', '--reader', 'robot', '--selectors', '#a'],
          { cwd: dir },
        ),
      (err) => /issue #11/.test(err.stderr ?? String(err)),
    );
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// A fake suite that DOES install the wrapper: it writes its own mutation ack
// directly (standing in for withTemporal actually running in a browser), so
// the CLI can be exercised all the way to a real score without a browser.
// Behavior is controlled by FP_RED ('1' turns the suite red on a mutation
// round) so both a noticed and an unnoticed pairing can be exercised.
async function writeFakeWrappedSuite(dir) {
  const script = join(dir, 'suite.cjs');
  await writeFile(
    script,
    `
const fs = require('fs');
const path = require('path');
const resultsPath = process.env.FP_RESULTS_PATH;
const mutationId = process.env.FLAKEPROOF_MUTATION_ID;
const ackDir = process.env.FLAKEPROOF_MUTATION_ACK;
function writeGreen() { fs.writeFileSync(resultsPath, JSON.stringify({ suites: [] })); }
function writeRed(title) {
  fs.writeFileSync(resultsPath, JSON.stringify({
    suites: [{ specs: [{ file: 'fake.spec.js', title, tests: [{ results: [{ status: 'failed', error: { message: 'boom' } }] }] }] }],
  }));
}
if (!mutationId) { writeGreen(); process.exit(0); }
if (ackDir) {
  fs.mkdirSync(ackDir, { recursive: true });
  fs.writeFileSync(path.join(ackDir, 'a.json'), JSON.stringify({ installed: true, applied: true, survived: true }));
}
if (process.env.FP_RED === '1') { writeRed('caught it'); process.exit(1); }
writeGreen();
process.exit(0);
`,
  );
  return script;
}

test('blindspots subcommand prints a real score when the suite notices the mutation', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
    const script = await writeFakeWrappedSuite(dir);
    const resultsPath = join(dir, 'results.json');
    const { stdout } = await run(
      'node',
      [
        join(process.cwd(), 'bin/flakeproof.js'), 'blindspots',
        '--cmd', `node ${script}`,
        '--results', 'results.json',
        '--selectors', '#header-title',
        '--mutations', 'change-text',
        '--runs', '1',
      ],
      { cwd: dir, env: { ...process.env, FP_RESULTS_PATH: resultsPath, FP_RED: '1' } },
    );
    assert.ok(stdout.includes('The suite notices 1 of 1 changes it was actually tested against.'), stdout);
    assert.ok(stdout.includes('## Noticed'));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('blindspots subcommand --json prints the raw result instead of the rendered report', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
    const script = await writeFakeWrappedSuite(dir);
    const resultsPath = join(dir, 'results.json');
    const { stdout } = await run(
      'node',
      [
        join(process.cwd(), 'bin/flakeproof.js'), 'blindspots',
        '--cmd', `node ${script}`,
        '--results', 'results.json',
        '--selectors', '#header-title',
        '--mutations', 'change-text',
        '--runs', '1',
        '--json',
      ],
      { cwd: dir, env: { ...process.env, FP_RESULTS_PATH: resultsPath } },
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.abstained, null);
    assert.equal(parsed.counts.applied, 1);
    assert.equal(parsed.counts.noticed, 0);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('blindspots subcommand honors --runs and --budget from both flags and config', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
    const script = await writeFakeWrappedSuite(dir);
    const resultsPath = join(dir, 'results.json');
    await writeFile(
      join(dir, 'flakeproof.config.json'),
      JSON.stringify({ cmd: `node ${script}`, results: 'results.json', blindspots: { selectors: ['#header-title'], mutations: ['change-text', 'change-href'], runs: 1, budget: 2 } }),
    );
    const { stdout } = await run('node', [join(process.cwd(), 'bin/flakeproof.js'), 'blindspots', '--json'], {
      cwd: dir,
      env: { ...process.env, FP_RESULTS_PATH: resultsPath },
    });
    const parsed = JSON.parse(stdout);
    // budget 2 = 1 control run + 1 mutation round (runs: 1 each); the second
    // mutation must have been skipped, not silently dropped.
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.skipped.length, 1);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
