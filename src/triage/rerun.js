// Reruns a shell command n times and reports whether the outcome is stable.
// A mixed result is the classic nondeterministic (flaky) signature.
import { spawn } from 'node:child_process';

// Every FLAKEPROOF_* env var either probe lane reads. A control or delay
// round for ONE lane must never inherit a leftover var from the OTHER lane
// either: a user who ran (or is debugging) a blindspots mutation in the same
// shell must not have FLAKEPROOF_MUTATION_* silently turn this rerun into an
// unrequested mutation round, corrupting the temporal probe's own baseline
// for a reason that has nothing to do with timing (verified live - see the
// review).
const FOREIGN_ENV_KEYS = [
  'FLAKEPROOF_TEMPORAL_SELECTOR',
  'FLAKEPROOF_TEMPORAL_MS',
  'FLAKEPROOF_TEMPORAL_ACK',
  'FLAKEPROOF_MUTATION_ID',
  'FLAKEPROOF_MUTATION_SELECTOR',
  'FLAKEPROOF_MUTATION_ACK',
];

export async function rerunStats(command, runs = 3, { env = {} } = {}) {
  const exitCodes = [];
  for (let i = 0; i < runs; i += 1) {
    const code = await new Promise((resolve) => {
      // A user who exported FLAKEPROOF_TEMPORAL_* (or FLAKEPROOF_MUTATION_*,
      // from the other lane) while debugging a probe by hand must not have
      // them leak into an unrelated baseline rerun: strip every one of them
      // from the inherited environment unless this call is itself asking
      // for that specific key.
      const childEnv = { ...process.env, ...env };
      for (const key of FOREIGN_ENV_KEYS) {
        if (!(key in env)) delete childEnv[key];
      }
      const child = spawn(command, { shell: true, stdio: 'ignore', env: childEnv });
      child.on('error', () => resolve(-1));
      child.on('close', (c) => resolve(c ?? -1));
    });
    exitCodes.push(code);
  }
  const failures = exitCodes.filter((c) => c !== 0).length;
  const commandBroken = exitCodes.length > 0 && exitCodes.every((c) => c === -1 || c === 127);
  return { runs, failures, exitCodes, nondeterministic: failures > 0 && failures < runs, commandBroken };
}
