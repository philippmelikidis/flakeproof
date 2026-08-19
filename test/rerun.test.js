import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
  const dir = await mkdtemp(join(tmpdir(), 'fp-rerun-'));
  const script = join(dir, 'flaky.cjs');
  const marker = join(dir, 'marker');
  await writeFile(
    script,
    `const fs=require('fs');if(fs.existsSync(${JSON.stringify(marker)})){process.exit(0)}fs.writeFileSync(${JSON.stringify(marker)},'');process.exit(1);`,
  );
  const stats = await rerunStats(`node ${script}`, 2);
  assert.deepEqual(stats.exitCodes, [1, 0]);
  assert.equal(stats.nondeterministic, true);
});
