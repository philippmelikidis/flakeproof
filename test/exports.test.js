import { test } from 'node:test';
import assert from 'node:assert/strict';
// Self-referencing imports resolve through the package.json exports map,
// which is exactly what the README tells users to copy. This locks that
// contract.
import { withTemporal } from 'flakeproof/inject';
import { triage } from 'flakeproof';

test('the documented package entry points resolve', () => {
  assert.equal(typeof withTemporal, 'function');
  assert.equal(typeof triage, 'function');
});
