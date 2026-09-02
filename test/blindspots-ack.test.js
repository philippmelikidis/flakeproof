import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMutationAck } from '../src/blindspots/ack.js';

test('a missing ack path reads as not installed', async () => {
  const result = await readMutationAck(join(tmpdir(), 'fp-does-not-exist-' + Date.now()));
  assert.deepEqual(result, { installed: false, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false });
});

test('an empty ack directory reads as not installed, not unreadable', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    const result = await readMutationAck(dir);
    assert.deepEqual(result, { installed: false, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('the initial installation receipt (applied unknown) reads installed true, applied null', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    await writeFile(join(dir, 'a.json'), JSON.stringify({ installed: true, applied: null }));
    const result = await readMutationAck(dir);
    assert.deepEqual(result, { installed: true, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a confirmed applied:true receipt reads through', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    await writeFile(join(dir, 'a.json'), JSON.stringify({ installed: true, applied: null }));
    await writeFile(join(dir, 'b.json'), JSON.stringify({ installed: true, applied: true }));
    const result = await readMutationAck(dir);
    assert.deepEqual(result, { installed: true, applied: true, survived: null, frame: null, found: null, error: null, unreadable: false });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a sibling frame reporting false must never erase a genuine true reported by another writer', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    await writeFile(join(dir, 'main.json'), JSON.stringify({ installed: true, applied: true }));
    await writeFile(join(dir, 'iframe.json'), JSON.stringify({ installed: true, applied: false }));
    const result = await readMutationAck(dir);
    assert.equal(result.applied, true, 'true from any writer must win over false from another');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a confirmed applied:false receipt (no true anywhere) reads as a confirmed false, never null', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    await writeFile(join(dir, 'a.json'), JSON.stringify({ installed: true, applied: null }));
    await writeFile(join(dir, 'b.json'), JSON.stringify({ installed: true, applied: false }));
    const result = await readMutationAck(dir);
    assert.deepEqual(result, { installed: true, applied: false, survived: null, frame: null, found: null, error: null, unreadable: false });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('an explicit {"installed": false} ack is read as not installed, never inverted to true', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    await writeFile(join(dir, 'a.json'), JSON.stringify({ installed: false }));
    const result = await readMutationAck(dir);
    assert.deepEqual(result, { installed: null, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('garbage ack content is not silently read as proof of installation', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    await writeFile(join(dir, 'a.json'), '{not json at all');
    const result = await readMutationAck(dir);
    assert.deepEqual(result, { installed: null, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a legacy plain-file ack (not a directory) is still read correctly', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    const ackPath = join(dir, 'ack');
    await writeFile(ackPath, JSON.stringify({ installed: true, applied: true }));
    const result = await readMutationAck(ackPath);
    assert.deepEqual(result, { installed: true, applied: true, survived: null, frame: null, found: null, error: null, unreadable: false });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('an unreadable ack directory is distinguished from a missing one', async () => {
  let dir = null;
  let ackPath = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    ackPath = join(dir, 'ack');
    await mkdir(ackPath);
    await writeFile(join(ackPath, 'a.json'), JSON.stringify({ installed: true, applied: true }));
    await chmod(ackPath, 0o000);
    const result = await readMutationAck(ackPath);
    assert.deepEqual(result, { installed: null, applied: null, survived: null, frame: null, found: null, error: null, unreadable: true });
  } finally {
    if (ackPath) await chmod(ackPath, 0o755).catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('survived is read as its own signal, never fused with applied', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    await writeFile(join(dir, 'initial.json'), JSON.stringify({ installed: true, applied: true, survived: null }));
    await writeFile(join(dir, 'settle.json'), JSON.stringify({ installed: true, applied: true, survived: false }));
    const result = await readMutationAck(dir);
    assert.equal(result.applied, true, 'the mutation did apply');
    assert.equal(result.survived, false, 'but it did not survive to the settle check');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a frame is attributed from the writer that actually reported applied: true', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    await writeFile(join(dir, 'main.json'), JSON.stringify({ installed: true, applied: false, found: false, frame: null }));
    await writeFile(join(dir, 'iframe.json'), JSON.stringify({ installed: true, applied: true, found: true, frame: 'https://example.com/widget.html' }));
    const result = await readMutationAck(dir);
    assert.equal(result.applied, true);
    assert.equal(result.frame, 'https://example.com/widget.html', 'the mutation only applied inside the iframe, and that must be named');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown-mutation-id error is surfaced rather than read as a plain not-applied', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    await writeFile(join(dir, 'a.json'), JSON.stringify({ installed: true, applied: false, error: 'unknown-mutation-id' }));
    const result = await readMutationAck(dir);
    assert.equal(result.installed, true);
    assert.equal(result.applied, false);
    assert.equal(result.error, 'unknown-mutation-id');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('one unreadable file alongside a usable payload does not discard the usable payload', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    await writeFile(join(dir, 'good.json'), JSON.stringify({ installed: true, applied: true }));
    const bad = join(dir, 'bad.json');
    await writeFile(bad, 'unreadable-on-purpose');
    await chmod(bad, 0o000);
    const result = await readMutationAck(dir);
    assert.deepEqual(result, { installed: true, applied: true, survived: null, frame: null, found: null, error: null, unreadable: false });
  } finally {
    if (dir) {
      await chmod(join(dir, 'bad.json'), 0o644).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }
});
