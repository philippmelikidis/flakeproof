// Shared ack-writing helper for the non-Playwright temporal injection
// adapters (Puppeteer, Selenium, Cypress via inject/cypress-node.js).
// Mirrors the directory-based, one-file-per-writer scheme
// src/inject/playwright.js established and src/triage/temporal-probe.js
// reads back: every acknowledging write gets its own uniquely named file, so
// no writer can silently erase another's evidence, and a failure to write
// must never break the user's suite.
//
// Since issue #21, every write here also prints the SAME receipt as a
// marker line on stdout (src/inject/shared/marker.js), in addition to the
// file: stdout crosses a container/remote-runner boundary the ack directory
// cannot, because flakeproof is the one spawning the command and always
// sees what it prints. The file and the marker share one `id`, generated
// once below and used as both the file's name and the marker's identity -
// this is what lets a reader that recovers the SAME receipt from both
// channels (a local run, where the filesystem is shared) count it once, not
// twice (see dedupeById in marker.js).
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeMarker } from './marker.js';

export async function writeTemporalAck(ackDir, fields) {
  const id = `${process.pid}-${randomUUID()}`;
  const merged = { installed: true, count: null, ruleLive: null, ...fields };
  // The marker goes out regardless of whether ackDir is usable (or even
  // set): it is the channel that survives a filesystem boundary the
  // directory write cannot cross, so it must not be gated on that write's
  // own precondition.
  writeMarker('temporal', id, merged);
  if (!ackDir) return;
  const file = join(ackDir, `${id}.json`);
  const payload = JSON.stringify(merged);
  await mkdir(ackDir, { recursive: true })
    .then(() => writeFile(file, payload))
    .catch(() => {});
}
