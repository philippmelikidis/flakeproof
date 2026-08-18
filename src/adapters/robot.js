// Reads a Robot Framework output.xml and returns the failed tests with
// their failure message and extracted anchor.
import { readFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { extractAnchor } from '../triage/anchor.js';

function asArray(x) {
  return x == null ? [] : Array.isArray(x) ? x : [x];
}

function statusText(status) {
  if (typeof status === 'string') return status;
  return status?.['#text'] ?? '';
}

function collectFailures(suite, out) {
  for (const s of asArray(suite?.suite)) collectFailures(s, out);
  for (const t of asArray(suite?.test)) {
    if (t.status?.['@_status'] === 'FAIL') {
      out.push({ testId: t['@_name'], message: statusText(t.status) });
    }
  }
}

export async function failedTestsFromOutputXml(path) {
  const xml = await readFile(path, 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xml);
  const failures = [];
  for (const s of asArray(doc.robot?.suite)) collectFailures(s, failures);
  return failures.map((f) => ({ ...f, anchor: extractAnchor(f.message) }));
}
