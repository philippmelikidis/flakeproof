import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveInputs } from '../action/scripts/resolve-inputs.js';

const cwd = '/repo';

test('inputs win over config, which wins over the built-in defaults', () => {
  const r = resolveInputs({
    inputs: { testCommand: 'npx playwright test', appUrl: 'https://from-input.test', resultsPath: '', reader: '', baselinePath: '' },
    config: { cmd: 'npx playwright test --from-config', url: 'https://from-config.test', results: 'from-config.json', reader: 'robot', baseline: 'from-config-baseline.json' },
    cwd,
  });
  assert.equal(r.cmd, 'npx playwright test');
  assert.equal(r.url, 'https://from-input.test');
  assert.equal(r.resultsPath, resolve(cwd, 'from-config.json'));
  assert.equal(r.reader, 'robot');
  assert.equal(r.baselinePath, resolve(cwd, 'from-config-baseline.json'));
  assert.deepEqual(r.problems, []);
});

test('falls back to config when an input is not set', () => {
  const r = resolveInputs({
    inputs: { testCommand: '', appUrl: '', resultsPath: '', reader: '', baselinePath: '' },
    config: { cmd: 'npx playwright test', url: 'https://from-config.test' },
    cwd,
  });
  assert.equal(r.cmd, 'npx playwright test');
  assert.equal(r.url, 'https://from-config.test');
  assert.equal(r.resultsPath, resolve(cwd, 'results.json'));
  assert.equal(r.reader, 'playwright');
  assert.equal(r.baselinePath, resolve(cwd, '.flakeproof/baseline.json'));
});

test('reports a problem instead of guessing when there is no command anywhere', () => {
  const r = resolveInputs({ inputs: { testCommand: '', appUrl: 'https://x.test', resultsPath: '', reader: '', baselinePath: '' }, config: {}, cwd });
  assert.ok(r.problems.some((p) => p.includes('no test command')));
});

test('reports a problem instead of guessing when there is no url anywhere', () => {
  const r = resolveInputs({ inputs: { testCommand: 'npx playwright test', appUrl: '', resultsPath: '', reader: '', baselinePath: '' }, config: {}, cwd });
  assert.ok(r.problems.some((p) => p.includes('no app url')));
});

test('rejects a reader that is neither playwright nor robot', () => {
  const r = resolveInputs({
    inputs: { testCommand: 'npx playwright test', appUrl: 'https://x.test', resultsPath: '', reader: 'cypress', baselinePath: '' },
    config: {},
    cwd,
  });
  assert.ok(r.problems.some((p) => p.includes('unknown reader "cypress"')));
});

test('baseline-dir is the directory that would hold an artifact-restored baseline', () => {
  const r = resolveInputs({
    inputs: { testCommand: 'x', appUrl: 'https://x.test', resultsPath: '', reader: '', baselinePath: 'artifacts/baseline.json' },
    config: {},
    cwd,
  });
  assert.equal(r.baselineDir, resolve(cwd, 'artifacts'));
});
