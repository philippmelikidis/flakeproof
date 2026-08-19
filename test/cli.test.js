import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
    notes: ['test failed on every rerun; deterministic failure'],
  });
  assert.ok(md.includes('**fragile**'));
  assert.ok(md.includes('`li.css-1a2b3c`'));
  assert.ok(md.includes('| `#main-nav li:nth-child(1)` | positional | yes | 4/5 |'));
});

test('cli snapshot and triage round-trip on the fixture page', async () => {
  const server = await startFixtureServer();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
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
    await server.close();
  }
});
