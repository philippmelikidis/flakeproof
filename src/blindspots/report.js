// Renders a measureBlindspots result in plain language: what was changed,
// on which element, whether the suite noticed. A reader with no context
// should understand what the number means and what to do about it - so an
// abstention explains itself as clearly as a score does.
import { REPORT_CSS } from '../report-html.js';

const ABSTAIN_TEXT = {
  'control-red':
    'The suite was already red before any mutation was tried, so nothing can be attributed to a blind spot. Fix the suite (or the page) until a plain run is green, then measure again.',
  'wrapper-not-installed':
    'The inject wrapper never acknowledged a single run, so flakeproof cannot tell whether the mutations reached the page at all. A suite that stays green under those conditions is not a "blind" suite - it is an unmeasured one. Wrap your base test once:\n\n    import { test as base } from \'@playwright/test\';\n    import { withTemporal } from \'flakeproof/inject\';\n    export const test = withTemporal(base);\n\nthen run flakeproof blindspots again.',
  'results-unreadable':
    'The suite\'s result file could not be read, so flakeproof cannot tell what the suite actually did. Check the reporter configuration and the --results path, then try again.',
  'no-mutations-applied':
    'None of the attempted mutations actually touched the page - every selector matched nothing, or nothing eligible for that mutation. Check the --selectors list against the page under test; no score is meaningful when no experiment actually ran.',
};

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function scoreLine(counts) {
  return `The suite notices ${counts.noticed} of ${counts.applied} changes it was actually tested against.`;
}

export function renderBlindspotsMarkdown(result) {
  const lines = ['# flakeproof blindspots', ''];
  if (result.abstained) {
    lines.push('flakeproof cannot compute a score here.', '', ABSTAIN_TEXT[result.abstained] ?? result.reason ?? result.abstained, '');
    if (result.records.length) {
      lines.push('## What was attempted before abstaining', '');
      for (const r of result.records) {
        lines.push(`- \`${r.target}\`: ${r.description} - ${r.applied ? 'applied' : 'did not apply'}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  lines.push(scoreLine(result.counts), '');
  lines.push(
    `${plural(result.counts.attempted, 'mutation')} attempted: ` +
      `${result.counts.applied} applied, ${result.counts.notApplied} not applied.`,
  );
  if (result.counts.inconclusive) {
    lines.push(`${plural(result.counts.inconclusive, 'mutation')} could not be judged (the suite's result file was unreadable for that run).`);
  }
  lines.push('');

  const unnoticed = result.records.filter((r) => r.applied && r.noticed === false);
  if (unnoticed.length) {
    lines.push('## Unnoticed', '');
    for (const r of unnoticed) lines.push(`- \`${r.target}\`: ${r.description}`);
    lines.push('');
  }

  const noticed = result.records.filter((r) => r.applied && r.noticed === true);
  if (noticed.length) {
    lines.push('## Noticed', '');
    for (const r of noticed) lines.push(`- \`${r.target}\`: ${r.description} (red: ${r.redTests.join(', ') || 'unnamed test'})`);
    lines.push('');
  }

  const notApplied = result.records.filter((r) => !r.applied);
  if (notApplied.length) {
    lines.push('## Not applied', '', 'These never touched the page, so they are excluded from the score above rather than counted as either noticed or unnoticed.', '');
    for (const r of notApplied) lines.push(`- \`${r.target}\`: ${r.description}`);
    lines.push('');
  }

  return lines.join('\n');
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function style() {
  return `
    body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           margin: 0; padding: 32px 20px; background: #faf9f7; color: #2b2724; }
    .wrap { max-width: 820px; margin: 0 auto; }
    h1 { font-size: 26px; margin: 0 0 8px; }
    .score { font-size: 20px; margin: 0 0 4px; }
    .muted { color: #7a736c; font-size: 13px; }
    ul.plain { list-style: none; padding: 0; margin: 0; }
    ul.plain li { padding: 8px 0; border-bottom: 1px solid #efece8; }
    ul.plain li:last-child { border-bottom: none; }
    pre { background: #f4f2ef; border: 1px solid #e6e1db; border-radius: 8px;
          padding: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  `;
}

function section(title, body) {
  return `<h2>${esc(title)}</h2>${body}`;
}

function list(records) {
  return `<div class="card"><ul class="plain">${records
    .map((r) => `<li><code>${esc(r.target)}</code>: ${esc(r.description)}${r.redTests?.length ? ` <span class="muted">(red: ${esc(r.redTests.join(', '))})</span>` : ''}</li>`)
    .join('')}</ul></div>`;
}

export function renderBlindspotsHtml(result) {
  if (result.abstained) {
    const text = ABSTAIN_TEXT[result.abstained] ?? result.reason ?? result.abstained;
    const attempted = result.records.length
      ? section('What was attempted before abstaining', list(result.records))
      : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flakeproof blindspots</title>
<style>${REPORT_CSS}${style()}</style></head>
<body><div class="wrap">
  <h1>No score</h1>
  <pre>${esc(text)}</pre>
  ${attempted}
</div></body></html>`;
  }

  const unnoticed = result.records.filter((r) => r.applied && r.noticed === false);
  const noticed = result.records.filter((r) => r.applied && r.noticed === true);
  const notApplied = result.records.filter((r) => !r.applied);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flakeproof blindspots</title>
<style>${REPORT_CSS}${style()}</style></head>
<body><div class="wrap">
  <h1>flakeproof blindspots</h1>
  <p class="score">${esc(scoreLine(result.counts))}</p>
  <p class="muted">${esc(plural(result.counts.attempted, 'mutation'))} attempted: ${result.counts.applied} applied, ${result.counts.notApplied} not applied.</p>
  ${unnoticed.length ? section('Unnoticed', list(unnoticed)) : ''}
  ${noticed.length ? section('Noticed', list(noticed)) : ''}
  ${notApplied.length ? section('Not applied', `<p class="muted">Excluded from the score above; these never touched the page.</p>${list(notApplied)}`) : ''}
</div></body></html>`;
}
