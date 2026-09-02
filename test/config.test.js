import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_BASELINE } from '../src/config.js';

test('a missing config file is not an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-cfg-'));
  try {
    assert.deepEqual(await loadConfig(dir), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reads command and url from the config file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-cfg-'));
  try {
    await writeFile(join(dir, 'flakeproof.config.json'), JSON.stringify({ cmd: 'npx playwright test', url: 'https://example.test' }));
    const cfg = await loadConfig(dir);
    assert.equal(cfg.cmd, 'npx playwright test');
    assert.equal(cfg.url, 'https://example.test');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('broken json fails loudly instead of silently falling back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-cfg-'));
  try {
    await writeFile(join(dir, 'flakeproof.config.json'), '{ not json');
    await assert.rejects(() => loadConfig(dir), /flakeproof\.config\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the default baseline location is inside a dot directory', () => {
  assert.equal(DEFAULT_BASELINE, '.flakeproof/baseline.json');
});
