// Reruns a shell command n times and reports whether the outcome is stable.
// A mixed result is the classic nondeterministic (flaky) signature.
import { spawn } from 'node:child_process';

export async function rerunStats(command, runs = 3, { env = {} } = {}) {
  const exitCodes = [];
  for (let i = 0; i < runs; i += 1) {
    const code = await new Promise((resolve) => {
      // A user who exported FLAKEPROOF_TEMPORAL_* while debugging a probe by
      // hand must not have them leak into an unrelated baseline rerun: strip
      // them from the inherited environment unless this call is itself
      // asking for a specific delay.
      const childEnv = { ...process.env, ...env };
      if (!('FLAKEPROOF_TEMPORAL_SELECTOR' in env)) delete childEnv.FLAKEPROOF_TEMPORAL_SELECTOR;
      if (!('FLAKEPROOF_TEMPORAL_MS' in env)) delete childEnv.FLAKEPROOF_TEMPORAL_MS;
      const child = spawn(command, { shell: true, stdio: 'ignore', env: childEnv });
      child.on('error', () => resolve(-1));
      child.on('close', (c) => resolve(c ?? -1));
    });
    exitCodes.push(code);
  }
  const failures = exitCodes.filter((c) => c !== 0).length;
  return { runs, failures, exitCodes, nondeterministic: failures > 0 && failures < runs };
}
