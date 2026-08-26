// Provokes a suspected timing failure on purpose: rerun the failing command
// with the anchor element delayed by escalating amounts (via the env vars
// the flakeproof/inject helper honors) until the failure reproduces on every
// run at one delay. Turns flakiness into a deterministic, reportable finding.
import { rerunStats } from './rerun.js';

export async function temporalProbe(command, selector, { delays = [250, 500, 1000, 2000], runsPerDelay = 2 } = {}) {
  const tried = [];
  for (const delay of delays) {
    const stats = await rerunStats(command, runsPerDelay, {
      env: { FLAKEPROOF_TEMPORAL_SELECTOR: selector, FLAKEPROOF_TEMPORAL_MS: String(delay) },
    });
    tried.push({ delay, failures: stats.failures, runs: stats.runs });
    if (stats.failures === stats.runs) return { reproduced: true, delay, tried };
  }
  return { reproduced: false, delay: null, tried };
}
