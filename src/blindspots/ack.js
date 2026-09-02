// Reads back the wrapper's acknowledgment of a mutation injection round
// (FLAKEPROOF_MUTATION_ACK). Mirrors src/triage/temporal-probe.js's ack
// reading closely: `applied`, `survived`, `frame` and `found` are each their
// own independent signal, exactly like temporal-probe.js's `count` and
// `ruleLive` - never fused across different writers, and never guessed when
// unknown.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Interprets the raw text of ONE ack payload - either the entire content of
// a plain-file ack, or the content of one file inside the ack directory.
// Never throws. Returns `{ installed, applied, survived, frame, found,
// error }`:
//   - `installed`: `true` only when the payload positively says so.
//   - `applied`, `survived`, `found`: `true`, `false`, or `null` (unknown -
//     never a fabricated result), mirroring parseAckPayload in
//     temporal-probe.js.
//   - `frame`: the frame's own URL (a string) when the mutation ran inside
//     an iframe, `null` for the top-level page or when not reported.
//   - `error`: a short machine string when the wrapper positively knows
//     something went wrong that isn't captured by the booleans above (for
//     example `'unknown-mutation-id'` - the installed wrapper's own catalog
//     does not recognize the id it was asked to inject), `null` otherwise.
function parseAckPayload(raw) {
  const trimmed = raw.trim();
  if (trimmed === '') return { installed: null, applied: null, survived: null, frame: null, found: null, error: null };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && 'installed' in parsed) {
      return {
        installed: parsed.installed === true,
        applied: typeof parsed.applied === 'boolean' ? parsed.applied : null,
        survived: typeof parsed.survived === 'boolean' ? parsed.survived : null,
        frame: typeof parsed.frame === 'string' ? parsed.frame : null,
        found: typeof parsed.found === 'boolean' ? parsed.found : null,
        error: typeof parsed.error === 'string' ? parsed.error : null,
      };
    }
  } catch {
    // Malformed JSON: fall through to the same "unreadable content, no
    // opinion" answer below rather than assuming installation.
  }
  return { installed: null, applied: null, survived: null, frame: null, found: null, error: null };
}

// `true` if any confirmed writer positively reported `true` for `key`,
// `false` if every confirmed writer that had an opinion reported `false`,
// `null` when no writer knew. A sibling frame's genuine `false` must never
// erase a genuine `true` reported by another writer (mirrors Fix 1 in
// temporal-probe.js): a mutation is judged as having happened if ANY writer
// saw it happen.
function pickBoolean(payloads, key) {
  if (payloads.some((p) => p[key] === true)) return true;
  if (payloads.some((p) => p[key] === false)) return false;
  return null;
}

// Reads and interprets one round's acknowledgment at `ackPath` (the value
// handed to the wrapper via FLAKEPROOF_MUTATION_ACK).
//
// Returns `{ installed, applied, survived, frame, found, error, unreadable
// }`:
//   - `installed`: `true` (at least one file positively confirms
//     installation), `false` (nothing at ackPath at all, or every file
//     positively says `installed: false`), or `null` (something is at
//     ackPath but could not be interpreted as a real receipt).
//   - `applied`, `survived`, `found`: the strongest known evidence, per
//     `pickBoolean` above.
//   - `frame`: the frame URL from whichever confirmed writer reported one,
//     preferring a writer that also reported `applied: true` (the frame the
//     mutation actually happened in matters far more than one that merely
//     looked and found nothing) - `null` when no writer reported a frame.
//   - `error`: the first confirmed writer's `error` string, or `null`.
//   - `unreadable`: `true` only when NO usable payload could be recovered at
//     all (every entry failed to read, or the directory listing itself
//     failed) - distinct from a genuinely missing ack, so the user is never
//     told to install the wrapper when the real problem is filesystem
//     permissions.
export async function readMutationAck(ackPath) {
  let info;
  try {
    info = await stat(ackPath);
  } catch {
    return { installed: false, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false };
  }

  if (!info.isDirectory()) {
    // Not the shape the current wrapper produces, but read defensively
    // rather than throwing.
    let raw;
    try {
      raw = await readFile(ackPath, 'utf8');
    } catch {
      return { installed: null, applied: null, survived: null, frame: null, found: null, error: null, unreadable: true };
    }
    return { ...parseAckPayload(raw), unreadable: false };
  }

  let entries;
  try {
    entries = await readdir(ackPath);
  } catch {
    return { installed: null, applied: null, survived: null, frame: null, found: null, error: null, unreadable: true };
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
    return anyFileUnreadable
      ? { installed: null, applied: null, survived: null, frame: null, found: null, error: null, unreadable: true }
      : { installed: false, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false };
  }
  const confirmedInstalled = payloads.filter((p) => p.installed === true);
  if (confirmedInstalled.length === 0) {
    return { installed: null, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false };
  }
  const applied = pickBoolean(confirmedInstalled, 'applied');
  const survived = pickBoolean(confirmedInstalled, 'survived');
  const found = pickBoolean(confirmedInstalled, 'found');
  const framedByApplied = confirmedInstalled.find((p) => p.applied === true && typeof p.frame === 'string');
  const framedByAny = confirmedInstalled.find((p) => typeof p.frame === 'string');
  const frame = (framedByApplied ?? framedByAny)?.frame ?? null;
  const errored = confirmedInstalled.find((p) => typeof p.error === 'string');
  const error = errored?.error ?? null;
  return { installed: true, applied, survived, frame, found, error, unreadable: false };
}
