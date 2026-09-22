// Unit tests for the shared stdout marker format (issue #21). This is the
// mechanism every injection wrapper uses to acknowledge an ack receipt over
// stdout, in addition to the ack-directory file - see the header comment in
// src/inject/shared/marker.js for why both exist. These tests focus on the
// module in isolation: format/parse round-tripping, and - per the governing
// rule (docs/superpowers/specs/2026-08-18-e2e-triage-gate-design.md: NEVER
// GUESS) - that a corrupt, truncated, interleaved, or merely look-alike line
// can never be parsed into a fabricated receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKER_PREFIX, formatMarker, parseMarkers, dedupeById } from '../src/inject/shared/marker.js';

test('formatMarker produces one line starting with the prefix, ending in a newline', () => {
  const line = formatMarker('temporal', 'abc-1', { installed: true, count: 3, ruleLive: true });
  // A leading newline is deliberate (see formatMarker's own comment: it
  // guarantees the marker starts its own line even if the runner's console
  // printer had a line open) - strip it before checking the marker itself.
  const withoutLeading = line.startsWith('\n') ? line.slice(1) : line;
  assert.ok(withoutLeading.startsWith(MARKER_PREFIX));
  assert.ok(line.endsWith('\n'));
  assert.equal((line.match(/\n/g) ?? []).length, 2, 'exactly one leading and one trailing newline - never a multi-line payload');
});

test('formatMarker defaults an absent nullable field to null, never omits it', () => {
  // `installed` is required (never nullable - see the schema table), so a
  // real caller always supplies it explicitly; `ruleLive` and `error` are
  // nullable and may be safely left out.
  const line = formatMarker('temporal', 'abc-2', { installed: true, count: 5 });
  const [marker] = parseMarkers(line);
  assert.deepEqual(marker, { id: 'abc-2', kind: 'temporal', installed: true, count: 5, ruleLive: null, error: null });
});

test('formatMarker throws rather than emit a marker that would fail its own reader\'s validation', () => {
  // `installed` is a required boolean, never nullable; omitting it would
  // otherwise silently default to null and produce an unparseable marker.
  assert.throws(() => formatMarker('temporal', 'abc-3', { count: 5 }));
  assert.throws(() => formatMarker('temporal', 'abc-4', { installed: 'yes', count: 5 }), /would not validate/);
});

test('parseMarkers round-trips every field for both kinds', () => {
  const temporalLine = formatMarker('temporal', 't-1', { installed: true, count: 2, ruleLive: false, error: null });
  const mutationLine = formatMarker('mutation', 'm-1', {
    installed: true,
    applied: true,
    survived: false,
    frame: 'https://example.com/f.html',
    found: true,
    error: null,
  });
  const [t] = parseMarkers(temporalLine);
  assert.deepEqual(t, { id: 't-1', kind: 'temporal', installed: true, count: 2, ruleLive: false, error: null });
  const [m] = parseMarkers(mutationLine);
  assert.deepEqual(m, {
    id: 'm-1',
    kind: 'mutation',
    installed: true,
    applied: true,
    survived: false,
    frame: 'https://example.com/f.html',
    found: true,
    error: null,
  });
});

test('parseMarkers recovers every marker out of arbitrary interleaved test output', () => {
  const text = [
    'running suite...',
    formatMarker('temporal', 'r-1', { installed: true, count: 1, ruleLive: true }).trim(),
    'test 1 passed',
    'test 2 failed: expected true, got false',
    formatMarker('mutation', 'r-2', { installed: true, applied: true }).trim(),
    'suite finished',
  ].join('\n');
  const markers = parseMarkers(text);
  assert.deepEqual(markers.map((m) => m.id), ['r-1', 'r-2']);
});

test('parseMarkers ignores an empty string and non-string input', () => {
  assert.deepEqual(parseMarkers(''), []);
  assert.deepEqual(parseMarkers(undefined), []);
  assert.deepEqual(parseMarkers(null), []);
});

test('a truncated marker line (JSON cut off mid-object) is ignored, never guessed', () => {
  const full = formatMarker('temporal', 't-2', { installed: true, count: 4, ruleLive: true });
  const truncated = full.slice(0, full.length - 10); // cut off before the closing brace/newline
  assert.deepEqual(parseMarkers(truncated), []);
});

test('a corrupted marker line (garbage after the prefix) is ignored', () => {
  const text = MARKER_PREFIX + 'not json at all\n';
  assert.deepEqual(parseMarkers(text), []);
});

test('a marker line missing a required schema field is refused, not defaulted at parse time', () => {
  // formatMarker always fills in every field; this simulates a hand-crafted
  // or corrupted line that skips one, which must be refused outright rather
  // than silently treated as though the field were null.
  const text = MARKER_PREFIX + JSON.stringify({ id: 'x', kind: 'temporal', installed: true, count: 1 }) + '\n';
  assert.deepEqual(parseMarkers(text), [], 'missing `ruleLive` (and `error`) must refuse the whole line');
});

test('a marker line with an extra, unrecognized field is refused rather than stripped and accepted', () => {
  const text =
    MARKER_PREFIX +
    JSON.stringify({ id: 'x', kind: 'temporal', installed: true, count: 1, ruleLive: true, error: null, extra: 'nope' }) +
    '\n';
  assert.deepEqual(parseMarkers(text), [], 'an unrecognized field must not be silently dropped and the rest accepted');
});

test('a marker line whose id is missing, empty, or the wrong type is refused', () => {
  const noId = MARKER_PREFIX + JSON.stringify({ kind: 'temporal', installed: true, count: 1, ruleLive: true, error: null }) + '\n';
  const emptyId = MARKER_PREFIX + JSON.stringify({ id: '', kind: 'temporal', installed: true, count: 1, ruleLive: true, error: null }) + '\n';
  const numericId = MARKER_PREFIX + JSON.stringify({ id: 123, kind: 'temporal', installed: true, count: 1, ruleLive: true, error: null }) + '\n';
  assert.deepEqual(parseMarkers(noId), []);
  assert.deepEqual(parseMarkers(emptyId), []);
  assert.deepEqual(parseMarkers(numericId), []);
});

test('an unknown kind is refused', () => {
  const text = MARKER_PREFIX + JSON.stringify({ id: 'x', kind: 'not-a-real-kind', installed: true }) + '\n';
  assert.deepEqual(parseMarkers(text), []);
});

test('a field of the wrong type is refused, not coerced', () => {
  const text = MARKER_PREFIX + JSON.stringify({ id: 'x', kind: 'temporal', installed: 'yes', count: 1, ruleLive: true, error: null }) + '\n';
  assert.deepEqual(parseMarkers(text), [], '`installed` as a string, not a boolean, must be refused');
});

// Fix/requirement: a real writer's line always starts at column 0 (a single
// atomic process.stdout.write call carrying the whole line). A byte-level
// interleaving between two concurrent writers - the scenario parallel test
// workers sharing one stdout can produce if a line ever exceeded the pipe's
// atomic-write guarantee - corrupts BOTH resulting fragments; neither may be
// read as a marker for either writer's actual receipt.
test('a marker line corrupted by interleaving with unrelated output is ignored, not partially recovered', () => {
  const real = formatMarker('temporal', 'interleaved-1', { installed: true, count: 7, ruleLive: true }).trim();
  // Simulate another process's output landing in the middle of the line
  // before the trailing newline ever arrives.
  const corrupted = real.slice(0, 40) + 'UNRELATED OUTPUT FROM ANOTHER WORKER' + real.slice(40) + '\n';
  assert.deepEqual(parseMarkers(corrupted), [], 'a spliced line must never be salvaged into a partial or wrong receipt');
});

// Requirement 5: a hostile or merely unlucky line of ordinary test output
// that contains the prefix as a substring - not as a genuine marker - must
// never be able to fabricate a receipt. This covers what a test fixture (or
// an attacker controlling test output) could realistically print.
test('a hostile line merely mentioning the marker prefix cannot fabricate a receipt', () => {
  const attempts = [
    // The prefix appears, but not at the start of the line.
    'console.log: saw a marker once, ' + MARKER_PREFIX + JSON.stringify({ id: 'x', kind: 'temporal', installed: true, count: 999, ruleLive: true, error: null }),
    // The prefix at the start, but followed by prose instead of JSON.
    MARKER_PREFIX + 'the wrapper is definitely installed, trust me',
    // The prefix at the start, valid-looking JSON, but missing the
    // required `id` a real writer always includes.
    MARKER_PREFIX + JSON.stringify({ kind: 'temporal', installed: true, count: 999, ruleLive: true, error: null }),
    // A test asserting on its OWN output printing the prefix as a plain
    // string, with no JSON at all.
    MARKER_PREFIX,
  ];
  for (const line of attempts) {
    assert.deepEqual(parseMarkers(line + '\n'), [], `must refuse: ${line}`);
  }
});

test('an oversized line is refused without ever being handed to JSON.parse', () => {
  const hugeId = 'x'.repeat(5000);
  const text = MARKER_PREFIX + JSON.stringify({ id: hugeId, kind: 'temporal', installed: true, count: 1, ruleLive: true, error: null }) + '\n';
  assert.deepEqual(parseMarkers(text), []);
});

test('dedupeById keeps exactly one entry per id, preferring the first occurrence', () => {
  const a = { id: 'x', count: 1 };
  const b = { id: 'x', count: 999 }; // a conflicting duplicate, which should never occur for a genuine receipt
  const c = { id: 'y', count: 2 };
  const result = dedupeById([a, b, c]);
  assert.deepEqual(result, [a, c], 'the first occurrence of a duplicate id wins, the duplicate is dropped entirely');
});

test('dedupeById is a no-op when every id is already distinct', () => {
  const list = [{ id: '1' }, { id: '2' }, { id: '3' }];
  assert.deepEqual(dedupeById(list), list);
});
