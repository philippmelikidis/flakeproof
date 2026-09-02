// Reads a Playwright json reporter file and returns the failed tests with
// their failure message and extracted anchor, in the same shape as the
// Robot Framework adapter so the runner can treat both alike.
import { readFile } from 'node:fs/promises';
import { extractAnchor } from '../triage/anchor.js';

// The reporter writes colored output, and the escapes hide the locator from
// the anchor extraction.
const ANSI = /\[[0-9;]*m/g;

function collect(suite, out, filePath) {
  const file = suite.file ?? filePath ?? '';
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      for (const r of t.results ?? []) {
        if (r.status !== 'failed' && r.status !== 'timedOut') continue;
        const raw = r.error?.message ?? r.errors?.[0]?.message ?? '';
        out.push({
          testId: `${spec.file ?? file} > ${spec.title}`,
          message: String(raw).replace(ANSI, ''),
        });
      }
    }
  }
  for (const child of suite.suites ?? []) collect(child, out, file);
}

export async function failedTestsFromPlaywrightJson(path) {
  const doc = JSON.parse(await readFile(path, 'utf8'));
  const failures = [];
  for (const suite of doc.suites ?? []) collect(suite, failures, '');
  return failures.map((f) => ({ ...f, anchor: extractAnchor(f.message) }));
}
