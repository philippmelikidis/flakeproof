import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMutationAck, MUTATION_SURVIVED_FILE } from '../src/blindspots/ack.js';

test('a missing ack path reads as not installed', async () => {
  const result = await readMutationAck(join(tmpdir(), 'fp-does-not-exist-' + Date.now()));
  assert.deepEqual(result, { installed: false, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false, stdoutOnly: false });
});

test('an empty ack directory reads as not installed, not unreadable', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    const result = await readMutationAck(dir);
    assert.deepEqual(result, { installed: false, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false, stdoutOnly: false });
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
    assert.deepEqual(result, { installed: true, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false, stdoutOnly: false });
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
    assert.deepEqual(result, { installed: true, applied: true, survived: null, frame: null, found: null, error: null, unreadable: false, stdoutOnly: false });
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
    assert.deepEqual(result, { installed: true, applied: false, survived: null, frame: null, found: null, error: null, unreadable: false, stdoutOnly: false });
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
    assert.deepEqual(result, { installed: null, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false, stdoutOnly: false });
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
    assert.deepEqual(result, { installed: null, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false, stdoutOnly: false });
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
    assert.deepEqual(result, { installed: true, applied: true, survived: null, frame: null, found: null, error: null, unreadable: false, stdoutOnly: false });
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
    assert.deepEqual(result, { installed: null, applied: null, survived: null, frame: null, found: null, error: null, unreadable: true, stdoutOnly: false });
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

// Issue #21: a marker on the round's captured stdout with no corresponding
// ack file at all (the container/remote-runner scenario) must still count
// as installed, and be recognized as `stdoutOnly` - the wrapper genuinely
// ran, flakeproof just could not see the ack directory it wrote to.
function markerLine(payload) {
  return '\n@@FLAKEPROOF-ACK@@' + JSON.stringify({ kind: 'mutation', ...payload }) + '\n';
}

test('a mutation receipt that only ever reaches stdout still counts as installed, marked stdoutOnly', async () => {
  const missingDir = join(tmpdir(), 'fp-does-not-exist-' + Date.now());
  const stdout = markerLine({ id: 'stdout-1', installed: true, applied: true, survived: true, frame: null, found: true, error: null });
  const result = await readMutationAck(missingDir, stdout);
  assert.equal(result.installed, true);
  assert.equal(result.applied, true);
  assert.equal(result.survived, true);
  assert.equal(result.stdoutOnly, true, 'no ack file exists anywhere, only the marker');
});

test('a mutation receipt on both the file and stdout is not stdoutOnly - the file-based case is unchanged', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    await writeFile(join(dir, 'both-1.json'), JSON.stringify({ installed: true, applied: true }));
    const stdout = markerLine({ id: 'both-1', installed: true, applied: true, survived: null, frame: null, found: true, error: null });
    const result = await readMutationAck(dir, stdout);
    assert.equal(result.installed, true);
    assert.equal(result.applied, true);
    assert.equal(result.stdoutOnly, false, 'file evidence exists, so this stays the unchanged case');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// The `survived` recency fallback (no MUTATION_SURVIVED_FILE on disk):
// markers appear on stdout in the order they were printed, so the LAST one
// reporting a definitive survived value must win - the same "most recent
// report wins" rule the always-overwritten file gives on the file channel.
test('when only stdout carries survived updates, the LAST one in stream order wins', async () => {
  const missingDir = join(tmpdir(), 'fp-does-not-exist-' + Date.now());
  const stdout =
    markerLine({ id: 'a', installed: true, applied: true, survived: true, frame: null, found: true, error: null }) +
    markerLine({ id: 'b', installed: true, applied: true, survived: false, frame: null, found: true, error: null });
  const result = await readMutationAck(missingDir, stdout);
  assert.equal(result.survived, false, 'the later report (b, false) must win over the earlier one (a, true)');
});

test('a file-based MUTATION_SURVIVED_FILE still wins over any stdout marker (unchanged precedence)', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    await writeFile(join(dir, MUTATION_SURVIVED_FILE), JSON.stringify({ installed: true, applied: true, survived: true }));
    // A LATER-looking stdout marker saying false must not override the
    // file, which remains authoritative for the file channel exactly as
    // before issue #21.
    const stdout = markerLine({ id: 'later', installed: true, applied: true, survived: false, frame: null, found: true, error: null });
    const result = await readMutationAck(dir, stdout);
    assert.equal(result.survived, true, 'the dedicated survived file stays authoritative when it exists');
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

// Proves deduplication specifically: the SAME receipt (matching id) present
// on both the file and stdout must never be double-counted. Constructed so
// that double-counting WOULD be observable: `applied` is only `true` here
// because there is exactly one confirmed-true payload; if the same id's
// entry were duplicated by a broken merge, this assertion alone would not
// distinguish it, so this is combined with the "both is not stdoutOnly"
// test above and marker.test.js's direct dedupeById unit tests, which
// together fully cover the merge behavior end to end.
test('the same receipt id from both sources is treated as one entry, not two, for the applied signal', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    await writeFile(join(dir, 'dup-1.json'), JSON.stringify({ installed: true, applied: false, found: false }));
    // Same id as the file, but reports something the file did NOT: this
    // must be recognized as the SAME event (deduplicated, first occurrence
    // - the file entry - kept), never as a second, independent writer whose
    // `applied: true` would flip the OR-based aggregate.
    const stdout = markerLine({ id: 'dup-1', installed: true, applied: true, survived: null, frame: null, found: true, error: null });
    const result = await readMutationAck(dir, stdout);
    assert.equal(result.applied, false, 'the deduplicated (file) entry must be the one used, not a phantom second writer');
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
    assert.deepEqual(result, { installed: true, applied: true, survived: null, frame: null, found: null, error: null, unreadable: false, stdoutOnly: false });
  } finally {
    if (dir) {
      await chmod(join(dir, 'bad.json'), 0o644).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }
});
