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

// A shell's own "could not even find/run this program" message, as opposed
// to whatever the program itself printed. Deliberately narrow (sh/bash/dash/
// zsh's wording, plus cmd.exe's) rather than any message containing "not
// found" - a test suite is free to print its own "not found" text on a
// legitimate failure, and that must not be read as the command being broken.
const SHELL_NOT_FOUND = /(?:^|[:\s])(?:command not found|not found)\s*$|is not recognized as/im;

// Exit code 127 alone is NOT evidence of a broken command: it is the shell's
// own convention when it cannot find the program, but nothing stops a
// legitimately-run test suite from exiting 127 on its own, e.g. a test
// runner that maps "no tests matched" to that code. Claiming "broken" from
// the code alone would then mislabel a real, reproducible suite outcome.
// The only two things this module can say with certainty are: (a) node
// itself could not spawn a process at all (the `error` event - a genuine
// spawn failure, not something the shell reported), or (b) the exit code
// was 127 AND stderr actually carries the shell's own not-found wording -
// i.e. the shell, not the suite, is the one saying the command is missing.
function looksLikeBrokenCommand(code, stderr) {
  if (code === -1) return true;
  if (code === 127 && SHELL_NOT_FOUND.test(stderr)) return true;
  return false;
}

export async function rerunStats(command, runs = 3, { env = {} } = {}) {
  const exitCodes = [];
  const broken = [];
  for (let i = 0; i < runs; i += 1) {
    const { code, stderr } = await new Promise((resolve) => {
      // A user who exported FLAKEPROOF_TEMPORAL_* (or FLAKEPROOF_MUTATION_*,
      // from the other lane) while debugging a probe by hand must not have
      // them leak into an unrelated baseline rerun: strip every one of them
      // from the inherited environment unless this call is itself asking
      // for that specific key.
      const childEnv = { ...process.env, ...env };
      for (const key of FOREIGN_ENV_KEYS) {
        if (!(key in env)) delete childEnv[key];
      }
      let stderr = '';
      const child = spawn(command, { shell: true, stdio: ['ignore', 'ignore', 'pipe'], env: childEnv });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', () => resolve({ code: -1, stderr }));
      child.on('close', (c) => resolve({ code: c ?? -1, stderr }));
    });
    exitCodes.push(code);
    broken.push(looksLikeBrokenCommand(code, stderr));
  }
  const failures = exitCodes.filter((c) => c !== 0).length;
  const commandBroken = broken.length > 0 && broken.every(Boolean);
  return { runs, failures, exitCodes, nondeterministic: failures > 0 && failures < runs, commandBroken };
}
