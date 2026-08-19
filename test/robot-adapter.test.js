import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { failedTestsFromOutputXml } from '../src/adapters/robot.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/rf/output-fail.xml', import.meta.url));

test('finds the failed RF test and extracts its anchor', async () => {
  const failures = await failedTestsFromOutputXml(FIXTURE);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].testId, 'Fails With Locator Timeout');
  assert.ok(failures[0].anchor.selector.includes('#does-not-exist'),
    `selector was: ${failures[0].anchor.selector}`);
  assert.equal(failures[0].anchor.kind, 'timeout');
});
