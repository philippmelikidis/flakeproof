import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { failedTestsFromPlaywrightJson } from '../src/runner/read-playwright.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/runner/playwright-results.json', import.meta.url));

test('reads the failed test and extracts its anchor', async () => {
  const failures = await failedTestsFromPlaywrightJson(FIXTURE);
  assert.equal(failures.length, 1);
  assert.match(failures[0].testId, /expect timeout fixture/);
  assert.ok(failures[0].testId.includes('expect.spec.js'), 'the file belongs in the test id');
  assert.equal(failures[0].anchor.selector, '#does-not-exist');
  assert.equal(failures[0].anchor.kind, 'timeout');
});

test('the message is free of ansi escapes', async () => {
  const failures = await failedTestsFromPlaywrightJson(FIXTURE);
  assert.ok(!/\[/.test(failures[0].message), 'ansi escapes must be stripped');
});
