import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTests } from '../src/runner/run-tests.js';

test('captures output and exit code of a passing command', async () => {
  const r = await runTests('node -e "console.log(\'hallo\')"');
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hallo/);
});

test('a failing command is reported, not thrown', async () => {
  const r = await runTests('node -e "process.exit(3)"');
  assert.equal(r.exitCode, 3);
});

test('a command that cannot start is reported, not thrown', async () => {
  const r = await runTests('definitely-not-a-command-fp-runner');
  assert.ok(r.exitCode !== 0, 'must not look successful');
});

test('extra env vars reach the child process without discarding the inherited environment', async () => {
  const r = await runTests('node -e "process.stdout.write(process.env.FP_TEST_VAR + \'|\' + typeof process.env.PATH)"', {
    env: { FP_TEST_VAR: 'hello' },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'hello|string');
});
