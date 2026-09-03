import { test } from 'node:test';
import assert from 'node:assert/strict';
// Self-referencing imports resolve through the package.json exports map,
// which is exactly what the README tells users to copy. This locks that
// contract.
import { withTemporal } from 'flakeproof/inject';
import { triage } from 'flakeproof';
import { installTemporal as installCypressTemporal } from 'flakeproof/inject-cypress';
import { registerTemporalTask } from 'flakeproof/inject-cypress-node';
import { installTemporal as installSeleniumTemporal } from 'flakeproof/inject-selenium';
import { installTemporal as installPuppeteerTemporal } from 'flakeproof/inject-puppeteer';

test('the documented package entry points resolve', () => {
  assert.equal(typeof withTemporal, 'function');
  assert.equal(typeof triage, 'function');
  assert.equal(typeof installCypressTemporal, 'function');
  assert.equal(typeof registerTemporalTask, 'function');
  assert.equal(typeof installSeleniumTemporal, 'function');
  assert.equal(typeof installPuppeteerTemporal, 'function');
});
