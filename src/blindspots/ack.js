// Reads back the wrapper's acknowledgment of a mutation injection round
// (FLAKEPROOF_MUTATION_ACK). Mirrors src/triage/temporal-probe.js's ack
// reading closely, simplified to a boolean "applied" instead of a match
// count: a semantic mutation either edited the page or it did not, there is
// no escalating-delay dimension the way the temporal lane has.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

// Interprets the raw text of ONE ack payload - either the entire content of
// a plain-file ack, or the content of one file inside the ack directory.
// Never throws. Returns `{ installed, applied }` where `installed` is
// `true` only when the payload positively says so, and `applied` is `true`,
// `false`, or `null` (unknown - never a fabricated result) mirroring
// parseAckPayload in temporal-probe.js.
function parseAckPayload(raw) {
  const trimmed = raw.trim();
  if (trimmed === '') return { installed: null, applied: null };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && 'installed' in parsed) {
      return {
        installed: parsed.installed === true,
        applied: typeof parsed.applied === 'boolean' ? parsed.applied : null,
      };
    }
  } catch {
    // Malformed JSON: fall through to the same "unreadable content, no
    // opinion" answer below rather than assuming installation.
  }
  return { installed: null, applied: null };
}

// Reads and interprets one round's acknowledgment at `ackPath` (the value
// handed to the wrapper via FLAKEPROOF_MUTATION_ACK).
//
// Returns `{ installed, applied, unreadable }`:
//   - `installed`: `true` (at least one file positively confirms
//     installation), `false` (nothing at ackPath at all, or every file
//     positively says `installed: false`), or `null` (something is at
//     ackPath but could not be interpreted as a real receipt).
//   - `applied`: the strongest known evidence: `true` if any confirmed
//     writer reported the mutation applying, `false` if every confirmed
//     writer reported it did not, `null` when not knowable. A sibling
//     frame's genuine `false` must never erase a genuine `true` reported by
//     another writer in the same round (mirrors Fix 1 in temporal-probe.js).
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
    return { installed: false, applied: null, unreadable: false };
  }

  if (!info.isDirectory()) {
    // Not the shape the current wrapper produces, but read defensively
    // rather than throwing.
    let raw;
    try {
      raw = await readFile(ackPath, 'utf8');
    } catch {
      return { installed: null, applied: null, unreadable: true };
    }
    return { ...parseAckPayload(raw), unreadable: false };
  }

  let entries;
  try {
    entries = await readdir(ackPath);
  } catch {
    return { installed: null, applied: null, unreadable: true };
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
      ? { installed: null, applied: null, unreadable: true }
      : { installed: false, applied: null, unreadable: false };
  }
  const confirmedInstalled = payloads.filter((p) => p.installed === true);
  if (confirmedInstalled.length === 0) {
    return { installed: null, applied: null, unreadable: false };
  }
  let applied = null;
  if (confirmedInstalled.some((p) => p.applied === true)) applied = true;
  else if (confirmedInstalled.some((p) => p.applied === false)) applied = false;
  return { installed: true, applied, unreadable: false };
}
