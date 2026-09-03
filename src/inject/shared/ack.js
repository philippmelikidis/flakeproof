// Shared ack-writing helper for the non-Playwright temporal injection
// adapters (Puppeteer, Selenium). Mirrors the directory-based,
// one-file-per-writer scheme src/inject/playwright.js established and
// src/triage/temporal-probe.js reads back: every acknowledging write gets its
// own uniquely named file, so no writer can silently erase another's
// evidence, and a failure to write must never break the user's suite.
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export async function writeTemporalAck(ackDir, fields) {
  if (!ackDir) return;
  const file = join(ackDir, `${process.pid}-${randomUUID()}.json`);
  const payload = JSON.stringify({ installed: true, count: null, ruleLive: null, ...fields });
  await mkdir(ackDir, { recursive: true })
    .then(() => writeFile(file, payload))
    .catch(() => {});
}
