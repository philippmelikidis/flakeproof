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
  // eslint-disable-next-line no-control-regex -- asserting the escapes are gone requires naming the byte
  assert.ok(!/\u001b/.test(failures[0].message), 'no escape byte may survive');
  assert.ok(!/\[[0-9;]*m/.test(failures[0].message), 'no color code may survive');
});
