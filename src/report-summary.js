// Bundles the triage of a whole suite run: one line per failed test for a ci
// log, and a single self-contained html page with every full report for a
// human.
import { renderReport } from './report.js';
import { renderHtmlReport } from './report-html.js';

export function renderSummaryMarkdown(run) {
  if (run.failures === 0) {
    const lines = ['# flakeproof run', '', 'No failed tests to triage.'];
    for (const n of run.notes ?? []) lines.push(`- ${n}`);
    return lines.join('\n') + '\n';
  }
  const lines = ['# flakeproof run', '', `${run.failures} failed tests triaged.`, ''];
  for (const r of run.results) {
    lines.push(`## ${r.testId}`, '', renderReport(r.triage), '');
  }
  for (const n of run.notes ?? []) lines.push(`- ${n}`);
  return lines.join('\n');
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderSummaryHtml(run) {
  const counts = {};
  for (const r of run.results) counts[r.triage.verdict] = (counts[r.triage.verdict] ?? 0) + 1;
  const overview = Object.entries(counts)
    .map(([v, n]) => `<li>${esc(n)} ${esc(v)}</li>`)
    .join('');

  // Each individual report is a full document; take its body so the summary
  // stays one valid page.
  const bodies = run.results
    .map((r) => {
      const doc = renderHtmlReport(r.triage);
      const body = doc.slice(doc.indexOf('<main>'), doc.lastIndexOf('</main>') + 7);
      return `<section class="one"><h2 class="testid">${esc(r.testId)}</h2>${body}</section>`;
    })
    .join('');

  const style = `
    body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           margin: 0; padding: 32px 20px; background: #faf9f7; color: #2b2724; }
    .wrap { max-width: 860px; margin: 0 auto; }
    h1 { font-size: 26px; margin: 0 0 8px; }
    .testid { font-size: 15px; font-family: ui-monospace, Menlo, monospace; color: #7a736c;
              border-top: 1px solid #e6e1db; padding-top: 24px; margin-top: 32px; }
    .one main { max-width: none; padding: 0; }
    ul.counts { list-style: none; display: flex; gap: 14px; padding: 0; margin: 0 0 8px; }
    ul.counts li { background: #fff; border: 1px solid #e6e1db; border-radius: 999px; padding: 3px 12px; font-size: 13px; }
    .notes { color: #7a736c; font-size: 13px; }
  `;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flakeproof run</title>
<style>${style}</style></head>
<body><div class="wrap">
  <h1>${esc(run.failures)} failed tests</h1>
  <ul class="counts">${overview}</ul>
  ${(run.notes ?? []).map((n) => `<p class="notes">${esc(n)}</p>`).join('')}
  ${bodies}
</div></body></html>`;
}
