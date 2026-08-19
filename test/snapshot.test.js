import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { nodeAt } from '../src/triage/tree.js';

test('captureSnapshot returns tree, html and resolved anchor', async () => {
  const server = await startFixtureServer();
  try {
    const snap = await captureSnapshot(server.url, { anchorSelector: '#cta' });
    assert.equal(snap.tree.tag, 'html');
    assert.ok(snap.html.startsWith('<html'), 'raw html must be captured');
    assert.equal(snap.url, server.url);
    assert.equal(nodeAt(snap.tree, snap.anchorPath).id, 'cta');
  } finally {
    await server.close();
  }
});
