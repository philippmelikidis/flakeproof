// Shared stdout marker format for ack receipts.
//
// Every ack the inject wrappers write (src/inject/shared/ack.js,
// src/inject/playwright.js, and the Robot Framework listener) goes to a
// file inside the directory named by FLAKEPROOF_TEMPORAL_ACK /
// FLAKEPROOF_MUTATION_ACK. That directory is on the filesystem of whatever
// process actually ran the suite - and when the suite runs in a container or
// on a remote runner, that filesystem is not the one flakeproof itself can
// see, even though flakeproof is the one that spawned the command. What
// DOES always cross that boundary is the command's stdout/stderr, because
// flakeproof owns the pipe. So every writer ALSO prints its receipt as one
// line on stdout, in this exact format, and every reader merges markers
// recovered from the captured output back in alongside whatever it found on
// disk (src/triage/temporal-probe.js, src/blindspots/ack.js).
//
// Format: one line, an unmistakable prefix, then compact JSON, then the end
// of the line. Nothing else may appear on that line - a marker is written
// with a single process.stdout.write() call carrying the whole line, so on
// any pipe (the normal case for a spawned child) the OS keeps that write
// atomic as long as it stays at or under PIPE_BUF (historically 4096 bytes
// on Linux and macOS): concurrent writers, e.g. parallel test workers
// sharing the same stdout, cannot interleave WITHIN one writer's line, only
// between separate ones. The parser below still fails closed if that
// assumption is ever violated (a line that got corrupted by interleaving is
// simply not valid JSON, or not valid against the schema, so it is dropped,
// never guessed at) - see parseMarkers.
//
//   @@FLAKEPROOF-ACK@@{"id":"1234-abcd...","kind":"temporal","installed":true,"count":3,"ruleLive":true}
//
// Identity: every marker carries an `id` - the SAME id used to name the
// receipt's file on disk (see src/inject/shared/ack.js), so a receipt that
// reaches flakeproof through BOTH channels (a local run, where the
// filesystem is shared) can be recognized as one event, not two, when a
// reader merges the two sources. See mergeById below.
//
// This file is intentionally dependency-free and side-effect-free on import
// (no filesystem, no network) so it can be required from any injection
// context without pulling in Node builtins a bundler cannot process - see
// src/inject/cypress.js's header comment for why that distinction matters
// for the Cypress adapter specifically.
export const MARKER_PREFIX = '@@FLAKEPROOF-ACK@@';

// A line longer than this is never even handed to JSON.parse. Genuine
// markers are small (a handful of short fields); this bound is generous
// enough for any of them while keeping a pathological or hostile line cheap
// to reject.
const MAX_LINE_LENGTH = 4096;

const isBool = (v) => typeof v === 'boolean';
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;
const nullOr = (pred) => (v) => v === null || pred(v);

// One schema per `kind`. Every field listed is REQUIRED (present with a
// value of the stated type, `null` allowed only where the predicate says
// so) - a marker missing a field, or carrying one of the wrong type, or
// carrying an extra field this schema does not name, is rejected outright.
// This is what "fully validate or refuse" means in practice: there is no
// partial credit, and no field is ever defaulted or guessed from absence.
const SCHEMAS = {
  temporal: {
    installed: isBool,
    count: nullOr(isFiniteNumber),
    ruleLive: nullOr(isBool),
    error: nullOr(isNonEmptyString),
  },
  mutation: {
    installed: isBool,
    applied: nullOr(isBool),
    survived: nullOr(isBool),
    frame: nullOr(isNonEmptyString),
    found: nullOr(isBool),
    error: nullOr(isNonEmptyString),
  },
};

// Builds the exact payload every writer must construct: `id` and `kind`
// first, in that order, purely cosmetic (JSON key order is not
// semantically meaningful and the parser never relies on it), so the marker
// line reads the same shape as the schema table above.
export function formatMarker(kind, id, fields) {
  const schema = SCHEMAS[kind];
  if (!schema) throw new Error(`unknown marker kind: ${kind}`);
  if (!isNonEmptyString(id)) throw new Error('formatMarker needs a non-empty string id');
  const payload = { id, kind };
  for (const key of Object.keys(schema)) payload[key] = key in fields ? fields[key] : null;
  // A field this schema requires to be a definite boolean (never null - see
  // `installed` in both schemas) left absent by the caller would otherwise
  // default to `null` here and produce a marker that fails its own reader's
  // validation the moment it is parsed back - a silent, self-defeating bug
  // at the writer, not the reader. Catch it here instead: if this does not
  // validate against the exact schema the reader will apply, throw now
  // rather than emit a marker that can never be recognized as one.
  if (!validate(payload)) {
    throw new Error(`formatMarker built a payload that would not validate: ${JSON.stringify(payload)}`);
  }
  // Leading `\n`: whatever the test runner's own console reporter was
  // printing at this exact moment may not have reached the end of ITS
  // current line yet (observed for real against Robot Framework's own
  // progress printer, which leaves a test's status line open until the
  // keyword finishes - a listener firing mid-keyword writes into the
  // middle of it). Starting our own write with a fresh line guarantees the
  // marker begins its OWN line regardless of what came before, at the cost
  // of one blank line in the suite's console output - a purely cosmetic
  // side effect, never a functional one. The trailing `\n` still ends the
  // line the normal way for whatever the runner prints next.
  return '\n' + MARKER_PREFIX + JSON.stringify(payload) + '\n';
}

// Writes one marker line to stdout. Never throws - exactly like the
// filesystem ack writers this is layered alongside, reporting must never be
// able to break the user's suite (a closed stdout, an EPIPE from a reader
// that already exited, or anything else).
export function writeMarker(kind, id, fields) {
  try {
    process.stdout.write(formatMarker(kind, id, fields));
  } catch {
    // Best-effort only.
  }
}

// Validates one already-JSON-parsed candidate. Returns the normalized
// `{ id, kind, ...fields }` object on success, or `null` when the candidate
// cannot be fully validated against a known schema - including an object
// that validates against the schema's known keys but ALSO carries extra,
// unrecognized ones, which is refused rather than silently stripped: a
// forged or accidental look-alike line must not be rewarded for getting
// part of the shape right.
function validate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const { id, kind } = candidate;
  if (!isNonEmptyString(id)) return null;
  const schema = SCHEMAS[kind];
  if (!schema) return null;
  const allowed = new Set(['id', 'kind', ...Object.keys(schema)]);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) return null;
  }
  const out = { id, kind };
  for (const [key, pred] of Object.entries(schema)) {
    if (!(key in candidate) || !pred(candidate[key])) return null;
    out[key] = candidate[key];
  }
  return out;
}

// Extracts every valid marker from arbitrary text - typically a whole
// command's captured stdout, interleaved with everything else the suite and
// every other worker printed. Returns markers in the order their lines
// appear in `text`; this ordering is the only "recency" signal a caller can
// rely on for state that a writer conceptually overwrites rather than
// accumulates (see src/blindspots/ack.js's handling of `survived`, which
// mirrors how a single always-overwritten file on disk gives the same
// answer there).
//
// Every line is judged independently and never throws: a truncated,
// corrupted, or partially-interleaved line is silently skipped (the
// governing rule is never guess - see
// docs/superpowers/specs/2026-08-18-e2e-triage-gate-design.md), and a line
// that merely CONTAINS the prefix without being one - ordinary test output
// mentioning it, deliberately or by accident - is refused the moment its
// remainder fails to parse as JSON or fails schema validation, so it can
// never fabricate a receipt.
export function parseMarkers(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out = [];
  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith(MARKER_PREFIX)) continue;
    const jsonText = line.slice(MARKER_PREFIX.length);
    if (jsonText.length === 0 || jsonText.length > MAX_LINE_LENGTH) continue;
    let candidate;
    try {
      candidate = JSON.parse(jsonText);
    } catch {
      continue;
    }
    const validated = validate(candidate);
    if (validated) out.push(validated);
  }
  return out;
}

// Deduplicates a list of `{ id, ... }` receipts (regardless of source) by
// `id`, keeping the first occurrence. Used by readers to fold markers
// recovered from stdout in alongside receipts read from disk without
// double-counting a receipt that reached both channels for the same
// underlying write.
export function dedupeById(receipts) {
  const seen = new Map();
  for (const r of receipts) {
    if (!seen.has(r.id)) seen.set(r.id, r);
  }
  return [...seen.values()];
}
