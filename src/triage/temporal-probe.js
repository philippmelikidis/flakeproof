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
// than zero, WITH the delay rule confirmed live in the stylesheet, backs a
// reproduction claim - a selector string can match real elements even when
// the browser silently discarded the css rule built from that same string,
// so a count alone is not enough (see src/probe/temporal.js). The receipt is
// per delay round: the ack is reset before every round so a stale
// acknowledgment from an earlier delay can never validate a later round's
// reproduction claim. A fully failing round must present its own
// acknowledgment.
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rerunStats } from './rerun.js';

// Interprets the raw text of ONE ack payload - either the entire content of
// a legacy single-file ack, or the content of one file inside the current
// ack directory format. Never throws.
//
// Returns `{ installed, count, ruleLive }` where `count` is a number or
// `null` (unknown, never a fabricated zero) and `ruleLive` is `true`,
// `false`, or `null` (unknown - an old-format ack predates this field
// entirely, so `null` here means "no opinion", not "not live").
function parseAckPayload(raw) {
  const trimmed = raw.trim();
  if (trimmed === 'injected') {
    // Old-format ack from a wrapper version that predates match counting.
    // It proves installation and nothing else.
    return { installed: true, count: null, ruleLive: null };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && parsed.installed) {
      return {
        installed: true,
        count: typeof parsed.count === 'number' ? parsed.count : null,
        ruleLive: typeof parsed.ruleLive === 'boolean' ? parsed.ruleLive : null,
      };
    }
  } catch {
    // Malformed ack content still proves the wrapper wrote something; fall
    // through to the same "installed, nothing else known" answer below.
  }
  return { installed: true, count: null, ruleLive: null };
}

// Reads and interprets one round's acknowledgment at `ackPath` - whatever
// value was handed to the wrapper via FLAKEPROOF_TEMPORAL_ACK.
//
// The current wrapper (src/inject/playwright.js) always treats this as a
// DIRECTORY: every acknowledging write - the initial "installed" receipt,
// every page's real report, every iframe's or worker's own report - gets its
// own file inside it, so no single writer can erase another's evidence
// (Fix 1 in the review). This reads every file in the directory and
// aggregates: the count is the MAX of every writer's known count (the
// strongest evidence actually observed), `null` only when NO writer reported
// a known number; `ruleLive` is `true` when AT LEAST ONE writer confirmed
// the rule was live.
//
// A wrapper written before that fix (or a hand-rolled one) may still write
// ackPath directly as a plain FILE. That legacy shape is read exactly as
// before, purely for backward compatibility - it is never what this
// codebase's own wrapper produces going forward.
//
// Returns `{ installed, count, ruleLive, unreadable }`:
//   - `installed`: `true` (the wrapper ran and left a readable receipt),
//     `false` (nothing at ackPath at all), or `null` (something is at
//     ackPath but could not be read - see `unreadable`).
//   - `count`: the strongest known matched-element count, or `null` when not
//     knowable. `null` must never be treated as, or collapse into, a
//     confirmed zero.
//   - `ruleLive`: `true` only when positively confirmed by at least one
//     writer; `false` otherwise (including "unknown"), because a confident
//     claim requires this to be positively established, never assumed.
//   - `unreadable`: `true` when ackPath exists but could not be read (for
//     example, a permissions error). This must be distinguishable from a
//     genuinely missing ack, so the user is never told to install the
//     wrapper when the real problem is filesystem permissions.
async function readAck(ackPath) {
  let info;
  try {
    info = await stat(ackPath);
  } catch {
    return { installed: false, count: null, ruleLive: false, unreadable: false };
  }

  if (info.isDirectory()) {
    let entries;
    try {
      entries = await readdir(ackPath);
    } catch {
      return { installed: null, count: null, ruleLive: false, unreadable: true };
    }
    const payloads = [];
    let anyUnreadable = false;
    for (const entry of entries) {
      try {
        payloads.push(parseAckPayload(await readFile(join(ackPath, entry), 'utf8')));
      } catch {
        anyUnreadable = true;
      }
    }
    if (payloads.length === 0) {
      // Either the directory is empty (no writer has reported yet - not
      // installed), or every entry it did contain failed to read (genuinely
      // unreadable, distinct from "no receipt at all").
      return anyUnreadable
        ? { installed: null, count: null, ruleLive: false, unreadable: true }
        : { installed: false, count: null, ruleLive: false, unreadable: false };
    }
    const counts = payloads.map((p) => p.count).filter((c) => typeof c === 'number');
    return {
      installed: true,
      count: counts.length === 0 ? null : Math.max(...counts),
      ruleLive: payloads.some((p) => p.ruleLive === true),
      unreadable: anyUnreadable,
    };
  }

  // Plain file: legacy single-writer ack format.
  let raw;
  try {
    raw = await readFile(ackPath, 'utf8');
  } catch {
    return { installed: null, count: null, ruleLive: false, unreadable: true };
  }
  const payload = parseAckPayload(raw);
  return { ...payload, ruleLive: payload.ruleLive === true, unreadable: false };
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
    return { reproduced: false, delay: null, tried: [], control, injected: null, matched: null, ruleLive: false, unreadable: false };
  }
  // The inject wrapper acknowledges every injection at this path, along with
  // how many elements the delay rule matched and whether the rule was live.
  // A delay round that fails without an acknowledgment - or with an
  // acknowledgment of zero matches, or a nonzero count but a rule that was
  // never live - proves nothing about timing: either the experiment never
  // ran inside the suite, or it ran but never demonstrably touched the
  // anchor.
  const scratchDir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
  const ackPath = join(scratchDir, 'ack');
  try {
    const tried = [];
    for (const delay of delays) {
      // `recursive: true` clears ackPath whether the previous round (or a
      // stale run) left it as a directory (the current wrapper's format) or
      // a plain file (the legacy format) - either way, the per-round receipt
      // discipline must survive: a stale ack from an earlier delay must
      // never validate a later round's claim.
      await rm(ackPath, { recursive: true, force: true });
      const stats = await rerunStats(command, runsPerDelay, {
        env: {
          FLAKEPROOF_TEMPORAL_SELECTOR: selector,
          FLAKEPROOF_TEMPORAL_MS: String(delay),
          FLAKEPROOF_TEMPORAL_ACK: ackPath,
        },
      });
      const ack = await readAck(ackPath);
      tried.push({
        delay,
        failures: stats.failures,
        runs: stats.runs,
        matched: ack.count,
        ruleLive: ack.ruleLive,
        installed: ack.installed === true,
        unreadable: ack.unreadable,
      });
      if (stats.failures === stats.runs) {
        if (ack.unreadable) {
          // Distinguish "the ack could not be read" from "there was no
          // ack": the former is a filesystem/permissions problem, not proof
          // the wrapper was never installed.
          return { reproduced: false, delay: null, tried, control, injected: null, matched: null, ruleLive: false, unreadable: true };
        }
        if (!ack.installed) {
          return { reproduced: false, delay: null, tried, control, injected: false, matched: null, ruleLive: false, unreadable: false };
        }
        if (ack.count === 0) {
          return { reproduced: false, delay: null, tried, control, injected: true, matched: 0, ruleLive: ack.ruleLive, unreadable: false };
        }
        if (ack.count > 0) {
          if (ack.ruleLive === true) {
            return { reproduced: true, delay, tried, control, injected: true, matched: ack.count, ruleLive: true, unreadable: false };
          }
          // The selector matched real elements, but the delay rule built
          // from that same selector was never confirmed live in the
          // stylesheet - the browser may have silently discarded it
          // (src/probe/temporal.js, Fix 3). A count alone cannot carry a
          // reproduction claim.
          return { reproduced: false, delay: null, tried, control, injected: true, matched: ack.count, ruleLive: false, unreadable: false };
        }
        // ack.count === null: installed, but the count could not be
        // determined for this round (old-format ack, or the page never
        // reported back before the process exited). Not a confirmed zero,
        // not a confirmed match - keep the weakened, honest answer.
        return { reproduced: false, delay: null, tried, control, injected: true, matched: null, ruleLive: ack.ruleLive, unreadable: false };
      }
    }
    // No round both fully failed and reported a usable ack: `injected`,
    // `matched`, `ruleLive` and `unreadable` must all be computed over the
    // SAME scope - every round tried - so they can never contradict each
    // other the way `injected: existsSync(lastRoundsPath)` used to
    // contradict `matched: bestKnownMatch(everyRound)` (Fix, item B in the
    // review: counts [7, no-ack] must report injected: true, matched: 7, not
    // injected: false while matched still says 7).
    return {
      reproduced: false,
      delay: null,
      tried,
      control,
      injected: tried.some((t) => t.installed),
      matched: bestKnownMatch(tried),
      ruleLive: tried.some((t) => t.ruleLive === true),
      unreadable: tried.some((t) => t.unreadable),
    };
  } finally {
    // Best-effort cleanup only: a leftover permissions problem in here (for
    // example, a round left an ack directory that is unreadable on purpose -
    // see the `unreadable` case above) must never override or mask an
    // already-computed, honest result.
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}
