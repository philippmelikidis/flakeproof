// Reads back the wrapper's acknowledgment of a mutation injection round
// (FLAKEPROOF_MUTATION_ACK). Mirrors src/triage/temporal-probe.js's ack
// reading closely: `applied`, `survived`, `frame` and `found` are each their
// own independent signal, exactly like temporal-probe.js's `count` and
// `ruleLive` - never guessed when unknown. `applied`/`found`/`frame` are
// combined across every writer (any confirmed `true` wins - a sibling
// frame's `false` must never erase it). `survived` is different: it
// describes an evolving state, not an independent per-writer fact, so it is
// read from whichever report landed most recently instead (see
// `MUTATION_SURVIVED_FILE` below).
//
// Since issue #21, every write src/inject/playwright.js makes here also
// prints the same receipt as a marker line on stdout
// (src/inject/shared/marker.js), because stdout crosses a container/remote-
// runner boundary the ack directory cannot. `readMutationAck` merges
// markers recovered from the round's captured stdout in alongside whatever
// it found on disk, deduplicating a receipt that reached both channels by
// the stable id every writer gives it (see dedupeById), and reports
// `stdoutOnly` so a caller can tell "installed, proven by a file" apart
// from "installed, proven ONLY by a stdout marker" - see its use in
// src/blindspots/measure.js.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarkers, dedupeById } from '../inject/shared/marker.js';

// The one ack file name src/inject/playwright.js overwrites (never
// randomly-named like every other ack file) so that reading it back always
// yields the wrapper's LATEST knowledge of whether the mutation survived,
// regardless of how many earlier reports said something different. See the
// `survived` handling in `readMutationAck` below.
export const MUTATION_SURVIVED_FILE = 'survived.json';

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

// Turns every `kind: 'mutation'` marker recovered from a round's captured
// stdout into the same shape a file-derived payload has, carrying its `id`
// along for dedup - preserving the order markers appeared on stdout, which
// is the only "recency" signal available for `survived` on this channel
// (see the fallback below; there is no equivalent of overwriting a single
// file). A `kind: 'temporal'` marker sharing the same stdout, from the
// OTHER probe lane, is never mistaken for mutation evidence.
function markerPayloads(stdout) {
  return parseMarkers(stdout)
    .filter((m) => m.kind === 'mutation')
    .map((m) => ({ id: m.id, installed: m.installed === true, applied: m.applied, survived: m.survived, frame: m.frame, found: m.found, error: m.error }));
}

// Reads and interprets one round's acknowledgment: whatever `ackPath` (the
// value handed to the wrapper via FLAKEPROOF_MUTATION_ACK) holds on disk,
// merged with whatever `stdout` (that round's captured command output)
// carries as markers - see the module header comment on why both exist.
//
// Returns `{ installed, applied, survived, frame, found, error, unreadable,
// stdoutOnly }`:
//   - `installed`: `true` (at least one payload, from either source,
//     positively confirms installation), `false` (nothing at ackPath at all
//     AND no marker on stdout either, or every payload positively says
//     `installed: false`), or `null` (something exists but could not be
//     interpreted as a real receipt).
//   - `applied`, `survived`, `found`: the strongest known evidence, per
//     `pickBoolean` above, computed over the MERGED and deduplicated list.
//   - `frame`: the frame URL from whichever confirmed writer reported one,
//     preferring a writer that also reported `applied: true` (the frame the
//     mutation actually happened in matters far more than one that merely
//     looked and found nothing) - `null` when no writer reported a frame.
//   - `error`: the first confirmed writer's `error` string, or `null`.
//   - `unreadable`: `true` only when NO usable payload could be recovered
//     from EITHER source - distinct from a genuinely missing ack, so the
//     user is never told to install the wrapper when the real problem is
//     filesystem permissions, and a usable stdout marker must never be
//     discarded just because the ack directory itself was unreadable.
//   - `stdoutOnly`: `true` only when `installed` is `true` but every bit of
//     that evidence came from stdout markers, never from a single file on
//     disk - the wrapper genuinely IS installed and the suite ran somewhere
//     this process cannot see the filesystem of (issue #21).
export async function readMutationAck(ackPath, stdout = '') {
  const stdoutPayloads = markerPayloads(stdout);
  const stdoutEvidence = stdoutPayloads.length > 0;

  let filePayloads = [];
  let fileUnreadable = false;
  let survivedFilePayload = null;

  let info;
  try {
    info = await stat(ackPath);
  } catch {
    info = null;
  }

  if (info && info.isDirectory()) {
    let entries;
    try {
      entries = await readdir(ackPath);
    } catch {
      fileUnreadable = true;
      entries = null;
    }
    if (entries) {
      let anyFileUnreadable = false;
      for (const entry of entries) {
        let raw;
        try {
          raw = await readFile(join(ackPath, entry), 'utf8');
        } catch {
          anyFileUnreadable = true;
          continue;
        }
        const parsed = parseAckPayload(raw);
        filePayloads.push({ id: entry.replace(/\.json$/, ''), ...parsed });
        if (entry === MUTATION_SURVIVED_FILE) survivedFilePayload = parsed;
      }
      fileUnreadable = anyFileUnreadable && filePayloads.length === 0;
    }
  } else if (info) {
    // Not the shape the current wrapper produces, but read defensively
    // rather than throwing.
    try {
      const raw = await readFile(ackPath, 'utf8');
      filePayloads = [{ id: `legacy:${ackPath}`, ...parseAckPayload(raw) }];
    } catch {
      fileUnreadable = true;
    }
  }
  const fileEvidence = filePayloads.length > 0;

  const merged = dedupeById([...filePayloads, ...stdoutPayloads]);

  if (merged.length === 0) {
    return fileUnreadable
      ? { installed: null, applied: null, survived: null, frame: null, found: null, error: null, unreadable: true, stdoutOnly: false }
      : { installed: false, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false, stdoutOnly: false };
  }
  const confirmedInstalled = merged.filter((p) => p.installed === true);
  if (confirmedInstalled.length === 0) {
    return { installed: null, applied: null, survived: null, frame: null, found: null, error: null, unreadable: false, stdoutOnly: false };
  }
  const applied = pickBoolean(confirmedInstalled, 'applied');
  // `survived` describes an evolving state, not an independent fact each
  // writer contributes the way `applied`/`found` do - a stale "still true"
  // reading must never outrank a later, genuinely observed revert, and a
  // later correction (an async re-parent healing itself) must never be
  // discarded either.
  //
  // On the file channel, src/inject/playwright.js keeps exactly one file
  // (`MUTATION_SURVIVED_FILE`) that gets overwritten on every update, so
  // whichever report landed most recently is read back here as-is - only
  // recency decides, never a fixed true/false priority (audit Fix 1 and
  // Fix 5). When no such file exists at all - most importantly, the exact
  // scenario issue #21 addresses, where the ack DIRECTORY is not visible
  // from here at all - the stdout channel has no "overwritten file" to
  // read, but it does not need one: markers appear on stdout in the order
  // they were printed, so the LAST mutation marker that reported a
  // definitive `survived` value plays the identical role recency-wise,
  // without needing its own dedicated marker or a second write. Only when
  // NEITHER of those exists does this fall back to the old cross-payload
  // combination (for example an ack written by hand, or a version of the
  // wrapper that predates this file).
  let survived;
  if (survivedFilePayload?.installed === true) {
    survived = survivedFilePayload.survived;
  } else {
    const lastStdoutSurvived = [...stdoutPayloads].reverse().find((p) => p.installed === true && (p.survived === true || p.survived === false));
    survived = lastStdoutSurvived ? lastStdoutSurvived.survived : pickBoolean(confirmedInstalled, 'survived');
  }
  const found = pickBoolean(confirmedInstalled, 'found');
  const framedByApplied = confirmedInstalled.find((p) => p.applied === true && typeof p.frame === 'string');
  const framedByAny = confirmedInstalled.find((p) => typeof p.frame === 'string');
  const frame = (framedByApplied ?? framedByAny)?.frame ?? null;
  const errored = confirmedInstalled.find((p) => typeof p.error === 'string');
  const error = errored?.error ?? null;
  return {
    installed: true,
    applied,
    survived,
    frame,
    found,
    error,
    unreadable: false,
    stdoutOnly: !fileEvidence && stdoutEvidence,
  };
}
