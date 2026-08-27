// Provokes a suspected timing failure on purpose: rerun the failing command
// with the anchor element delayed by escalating amounts (via the env vars
// the flakeproof/inject helper honors) until the failure reproduces on every
// run at one delay. Turns flakiness into a deterministic, reportable finding.
//
// A reproduction claim is only honest if the command is stable without the
// injected delay at the same run count: run a control round first, without
// the env vars. If the control itself fails, the baseline is too unstable to
// attribute anything to timing, and two coin flips could otherwise fake
// causality between an unrelated flake and the delay.
//
// A reproduction claim also requires the inject wrapper to prove the delay
// actually ran inside the suite: the wrapper acknowledges every injection by
// writing to FLAKEPROOF_TEMPORAL_ACK. A delay round that fails on every run
// without that acknowledgment proves nothing about timing, since the
// experiment never happened in-process; it just means the wrapper is not
// installed. The receipt is per delay round: the ack file is reset before
// every round so a stale acknowledgment from an earlier delay can never
// validate a later round's reproduction claim. A fully failing round must
// present its own acknowledgment.
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rerunStats } from './rerun.js';

export async function temporalProbe(command, selector, { delays = [250, 500, 1000, 2000], runsPerDelay = 2 } = {}) {
  const control = await rerunStats(command, runsPerDelay);
  if (control.failures > 0) {
    return { reproduced: false, delay: null, tried: [], control, injected: null };
  }
  // The inject wrapper acknowledges every injection into this file. A delay
  // round that fails without an acknowledgment proves nothing about timing:
  // the experiment never ran inside the suite.
  const ackDir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
  const ackPath = join(ackDir, 'ack');
  try {
    const tried = [];
    for (const delay of delays) {
      await rm(ackPath, { force: true });
      const stats = await rerunStats(command, runsPerDelay, {
        env: {
          FLAKEPROOF_TEMPORAL_SELECTOR: selector,
          FLAKEPROOF_TEMPORAL_MS: String(delay),
          FLAKEPROOF_TEMPORAL_ACK: ackPath,
        },
      });
      tried.push({ delay, failures: stats.failures, runs: stats.runs });
      if (stats.failures === stats.runs) {
        if (!existsSync(ackPath)) {
          return { reproduced: false, delay: null, tried, control, injected: false };
        }
        return { reproduced: true, delay, tried, control, injected: true };
      }
    }
    return { reproduced: false, delay: null, tried, control, injected: existsSync(ackPath) };
  } finally {
    await rm(ackDir, { recursive: true, force: true });
  }
}
