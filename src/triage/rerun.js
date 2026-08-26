// Reruns a shell command n times and reports whether the outcome is stable.
// A mixed result is the classic nondeterministic (flaky) signature.
import { spawn } from 'node:child_process';

export async function rerunStats(command, runs = 3, { env = {} } = {}) {
  const exitCodes = [];
  for (let i = 0; i < runs; i += 1) {
    const code = await new Promise((resolve) => {
      const child = spawn(command, { shell: true, stdio: 'ignore', env: { ...process.env, ...env } });
      child.on('error', () => resolve(-1));
      child.on('close', (c) => resolve(c ?? -1));
    });
    exitCodes.push(code);
  }
  const failures = exitCodes.filter((c) => c !== 0).length;
  return { runs, failures, exitCodes, nondeterministic: failures > 0 && failures < runs };
}
