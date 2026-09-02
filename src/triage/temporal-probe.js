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
// actually ran inside the suite AND actually matched the anchor element: the
// wrapper acknowledges every injection by writing to FLAKEPROOF_TEMPORAL_ACK,
// including how many elements the delay rule matched (see
// src/inject/playwright.js and src/probe/temporal.js). A delay round that
// fails on every run without that acknowledgment proves nothing about
// timing, since the experiment never happened in-process; it just means the
// wrapper is not installed. A round that fails on every run WITH an
// acknowledgment reporting zero matched elements proves even less: the delay
// style was live, but it never touched anything, so the failure cannot be
// attributed to the injected timing at all. Only a matched count greater
// than zero backs a reproduction claim. The receipt is per delay round: the
// ack file is reset before every round so a stale acknowledgment from an
// earlier delay can never validate a later round's reproduction claim. A
// fully failing round must present its own acknowledgment.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rerunStats } from './rerun.js';

// Reads and interprets the ack file for one round.
//
// Returns `{ installed, count }`:
//   - `installed` is whether the wrapper ran at all this round (the file
//     exists, in any format).
//   - `count` is the number of elements the delay rule matched: a number
//     when known, or `null` when it is not knowable - either because an
//     older wrapper wrote the bare-string ack format that carries no count,
//     or because the page never reported back before the round's process
//     exited. `null` must never be treated as, or confused with, a
//     confirmed zero.
async function readAck(ackPath) {
  if (!existsSync(ackPath)) return { installed: false, count: null };
  let raw;
  try {
    raw = await readFile(ackPath, 'utf8');
  } catch {
    return { installed: false, count: null };
  }
  const trimmed = raw.trim();
  if (trimmed === 'injected') {
    // Old-format ack from a wrapper version that predates match counting.
    // It proves installation and nothing else.
    return { installed: true, count: null };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && parsed.installed) {
      return { installed: true, count: typeof parsed.count === 'number' ? parsed.count : null };
    }
  } catch {
    // Malformed ack content still proves the wrapper wrote something; fall
    // through to the same "installed, count unknown" answer below.
  }
  return { installed: true, count: null };
}

// The strongest count actually observed across every round tried, used only
// when no single round both fully failed and reported a count - i.e. when
// the loop never returns early. `null` unless at least one round produced a
// known number.
function bestKnownMatch(tried) {
  const counts = tried.map((t) => t.matched).filter((m) => typeof m === 'number');
  return counts.length === 0 ? null : Math.max(...counts);
}

export async function temporalProbe(command, selector, { delays = [250, 500, 1000, 2000], runsPerDelay = 2 } = {}) {
  const control = await rerunStats(command, runsPerDelay);
  if (control.failures > 0) {
    return { reproduced: false, delay: null, tried: [], control, injected: null, matched: null };
  }
  // The inject wrapper acknowledges every injection into this file, along
  // with how many elements the delay rule matched. A delay round that fails
  // without an acknowledgment - or with an acknowledgment of zero matches -
  // proves nothing about timing: either the experiment never ran inside the
  // suite, or it ran but never touched the anchor.
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
      const ack = await readAck(ackPath);
      tried.push({ delay, failures: stats.failures, runs: stats.runs, matched: ack.count });
      if (stats.failures === stats.runs) {
        if (!ack.installed) {
          return { reproduced: false, delay: null, tried, control, injected: false, matched: null };
        }
        if (ack.count === 0) {
          return { reproduced: false, delay: null, tried, control, injected: true, matched: 0 };
        }
        if (ack.count > 0) {
          return { reproduced: true, delay, tried, control, injected: true, matched: ack.count };
        }
        // ack.count === null: installed, but the count could not be
        // determined for this round (old-format ack, or the page never
        // reported back before the process exited). Not a confirmed zero,
        // not a confirmed match - keep the weakened, honest answer.
        return { reproduced: false, delay: null, tried, control, injected: true, matched: null };
      }
    }
    return {
      reproduced: false,
      delay: null,
      tried,
      control,
      injected: existsSync(ackPath),
      matched: bestKnownMatch(tried),
    };
  } finally {
    await rm(ackDir, { recursive: true, force: true });
  }
}
