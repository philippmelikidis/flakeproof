import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rerunStats } from '../src/triage/rerun.js';

test('stable green and stable red are not nondeterministic', async () => {
  const green = await rerunStats('node -e "process.exit(0)"', 2);
  assert.deepEqual({ failures: green.failures, nondeterministic: green.nondeterministic }, { failures: 0, nondeterministic: false });
  const red = await rerunStats('node -e "process.exit(1)"', 2);
  assert.deepEqual({ failures: red.failures, nondeterministic: red.nondeterministic }, { failures: 2, nondeterministic: false });
});

test('mixed outcomes are nondeterministic', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-rerun-'));
    const script = join(dir, 'flaky.cjs');
    const marker = join(dir, 'marker');
    await writeFile(
      script,
      `const fs=require('fs');if(fs.existsSync(${JSON.stringify(marker)})){process.exit(0)}fs.writeFileSync(${JSON.stringify(marker)},'');process.exit(1);`,
    );
    const stats = await rerunStats(`node ${script}`, 2);
    assert.deepEqual(stats.exitCodes, [1, 0]);
    assert.equal(stats.nondeterministic, true);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('stale FLAKEPROOF_TEMPORAL_MS from the parent environment is not inherited', async () => {
  let dir = null;
  process.env.FLAKEPROOF_TEMPORAL_MS = '999';
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-rerun-'));
    const script = join(dir, 'sensitive.cjs');
    await writeFile(script, 'process.exit(process.env.FLAKEPROOF_TEMPORAL_MS ? 1 : 0);');
    const stats = await rerunStats(`node ${script}`, 1);
    assert.equal(stats.failures, 0);
  } finally {
    delete process.env.FLAKEPROOF_TEMPORAL_MS;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('stale FLAKEPROOF_MUTATION_ID from the parent environment (the other probe lane) is not inherited either', async () => {
  // Fix 5 in the review: rerunStats previously stripped only its own
  // FLAKEPROOF_TEMPORAL_* family, so a blindspots mutation left exported in
  // the same shell would leak into a temporal control round and turn its
  // baseline red for a reason that has nothing to do with timing, silently
  // losing the temporal finding.
  let dir = null;
  process.env.FLAKEPROOF_MUTATION_ID = 'change-text';
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-rerun-'));
    const script = join(dir, 'sensitive.cjs');
    await writeFile(script, 'process.exit(process.env.FLAKEPROOF_MUTATION_ID ? 1 : 0);');
    const stats = await rerunStats(`node ${script}`, 1);
    assert.equal(stats.failures, 0);
  } finally {
    delete process.env.FLAKEPROOF_MUTATION_ID;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a command that cannot run at all is flagged as broken', async () => {
  const stats = await rerunStats('definitely-not-a-command-fp-2b', 2);
  assert.equal(stats.failures, 2);
  assert.equal(stats.commandBroken, true);
});

test('a genuinely failing test is not flagged as broken', async () => {
  const stats = await rerunStats('node -e "process.exit(1)"', 2);
  assert.equal(stats.commandBroken, false);
});

// Exit code 127 is the shell's OWN convention for "command not found", but
// nothing stops a real, legitimately-run suite from exiting 127 on its own
// (e.g. a runner that maps "no tests matched" to that code). Before this
// fix, commandBroken read 127 alone as proof the command was broken - this
// suite genuinely ran (node did start and execute the -e script) and simply
// chose to exit 127, so it must not be mislabeled the same as a shell that
// never found the program at all.
test('a suite that legitimately exits 127 on its own is not flagged as broken', async () => {
  const stats = await rerunStats('node -e "process.exit(127)"', 2);
  assert.deepEqual(stats.exitCodes, [127, 127]);
  assert.equal(stats.commandBroken, false);
});
