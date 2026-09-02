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
// Returns `{ installed, count, ruleLive }` where `installed` is `true` only
// when the payload positively says so, `false` when it positively says the
// opposite (an explicit `{"installed": false}`), and `null` when the content
// exists but proves nothing either way (empty, garbage, or JSON with no
// usable `installed` field) - a receipt that cannot be interpreted must never
// be silently treated as proof of installation. `count` is a number or
// `null` (unknown, never a fabricated zero) and `ruleLive` is `true`,
// `false`, or `null` (unknown - an old-format ack predates this field
// entirely, so `null` here means "no opinion", not "not live").
function parseAckPayload(raw) {
  const trimmed = raw.trim();
  if (trimmed === '') {
    // Nothing was actually written; a blank file proves nothing.
    return { installed: null, count: null, ruleLive: null };
  }
  if (trimmed === 'injected') {
    // Old-format ack from a wrapper version that predates match counting.
    // It proves installation and nothing else.
    return { installed: true, count: null, ruleLive: null };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && 'installed' in parsed) {
      // Read `installed` as written, including an explicit `false` - it must
      // never be inverted into `true` just because the field was present.
      return {
        installed: parsed.installed === true,
        count: typeof parsed.count === 'number' ? parsed.count : null,
        ruleLive: typeof parsed.ruleLive === 'boolean' ? parsed.ruleLive : null,
      };
    }
  } catch {
    // Malformed JSON: fall through to the same "unreadable content, no
    // opinion" answer below rather than assuming installation.
  }
  return { installed: null, count: null, ruleLive: null };
}

// Reads and interprets one round's acknowledgment at `ackPath` - whatever
// value was handed to the wrapper via FLAKEPROOF_TEMPORAL_ACK.
//
// The current wrapper (src/inject/playwright.js) always treats this as a
// DIRECTORY: every acknowledging write - the initial "installed" receipt,
// every page's real report, every iframe's or worker's own report - gets its
// own file inside it, so no single writer can erase another's evidence
// (Fix 1 in the review). This reads every file in the directory and
// aggregates count and ruleLive from a SINGLE observation: the payload with
// the strongest known count. Two different writers must never be fused into
// a conjunction neither of them actually reported - an iframe reporting
// `{count: 9, ruleLive: false}` alongside a main-page writer reporting
// `{count: 0, ruleLive: true}` must never be read as "matched 9, rule live",
// since no writer observed that pair. When no writer reported a known count
// at all, `ruleLive` has no observation to anchor to and stays `null`.
//
// A wrapper written before that fix (or a hand-rolled one) may still write
// ackPath directly as a plain FILE. That legacy shape is read exactly as
// before, purely for backward compatibility - it is never what this
// codebase's own wrapper produces going forward.
//
// Returns `{ installed, count, ruleLive, unreadable }`:
//   - `installed`: `true` (at least one file positively confirms
//     installation), `false` (nothing at ackPath at all, or every file
//     positively says `installed: false`), or `null` (something is at
//     ackPath but either could not be read - see `unreadable` - or every
//     readable file's content could not be interpreted as a real receipt;
//     unparseable bytes must never be read as proof of installation).
//   - `count`: the strongest known matched-element count, from the single
//     payload that reported it, or `null` when not knowable. `null` must
//     never be treated as, or collapse into, a confirmed zero.
//   - `ruleLive`: `true` or `false` when positively established by the SAME
//     payload the count came from, `null` when unknown. A confident claim
//     requires this to be positively established, never assumed.
//   - `unreadable`: `true` only when NO usable payload could be recovered at
//     all (every entry failed to read, or the directory listing itself
//     failed). One unreadable file alongside a usable payload must never
//     discard that payload's evidence - the reproduction it supports must
//     survive. This must also stay distinguishable from a genuinely missing
//     ack, so the user is never told to install the wrapper when the real
//     problem is filesystem permissions.
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
    let anyFileUnreadable = false;
    for (const entry of entries) {
      try {
        payloads.push(parseAckPayload(await readFile(join(ackPath, entry), 'utf8')));
      } catch {
        anyFileUnreadable = true;
      }
    }
    if (payloads.length === 0) {
      // Either the directory is empty (no writer has reported yet - not
      // installed), or every entry it did contain failed to read (genuinely
      // unreadable, distinct from "no receipt at all").
      return anyFileUnreadable
        ? { installed: null, count: null, ruleLive: false, unreadable: true }
        : { installed: false, count: null, ruleLive: false, unreadable: false };
    }
    // At least one file was read successfully - a genuinely unreadable file
    // elsewhere in the directory must not discard the usable payloads we did
    // recover, so `unreadable` is false from here on regardless of
    // `anyFileUnreadable`.
    const confirmedInstalled = payloads.filter((p) => p.installed === true);
    if (confirmedInstalled.length === 0) {
      // Every readable file's content was unparseable, garbage, or an
      // explicit `{"installed": false}` - a receipt exists but nothing in it
      // proves installation.
      return { installed: null, count: null, ruleLive: null, unreadable: false };
    }
    const known = confirmedInstalled.filter((p) => typeof p.count === 'number');
    let count = null;
    let ruleLive = null;
    if (known.length > 0) {
      // The strongest evidence actually observed, read as ONE observation:
      // count and ruleLive both come from the same payload, never fused
      // independently across different writers (Fix 1).
      const strongest = known.reduce((best, p) => (p.count > best.count ? p : best), known[0]);
      count = strongest.count;
      ruleLive = strongest.ruleLive;
    }
    return { installed: true, count, ruleLive, unreadable: false };
  }

  // Plain file: legacy single-writer ack format.
  let raw;
  try {
    raw = await readFile(ackPath, 'utf8');
  } catch {
    return { installed: null, count: null, ruleLive: false, unreadable: true };
  }
  return { ...parseAckPayload(raw), unreadable: false };
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
        if (ack.installed !== true) {
          // `ack.installed === false` means positively confirmed absent (no
          // ackPath at all, or an explicit `{"installed": false}`); `null`
          // means a receipt exists but its content could not be interpreted
          // as one (empty, garbage, or unparseable) - genuinely unknown, not
          // the same claim as "confirmed never installed" (Fix 7).
          return { reproduced: false, delay: null, tried, control, injected: ack.installed === false ? false : null, matched: null, ruleLive: false, unreadable: false };
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
