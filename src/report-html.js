// Renders a triage result as a single self-contained html file: inline css,
// no external resources, no scripts. Everything taken from the page under
// test is escaped, because the report displays foreign markup as text.

const VERDICT_TEXT = {
  fragile: 'The test is fragile. The page is fine, the test hangs on something that changed without changing meaning.',
  'real-change': 'Something changed for real at this spot. Look at the application, not the test.',
  nondeterministic: 'The test does not fail consistently. Reruns disagree, so this is timing or state, not this commit.',
  unclear: 'The evidence is mixed or missing. flakeproof does not guess, so it says nothing rather than something wrong.',
  'no-anchor': 'The error names no locator, so there is nothing to compare against.',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Describes an element in plain language instead of attribute soup.
function describe(node, missingText) {
  if (!node) return missingText;
  const parts = [`a &lt;${esc(node.tag)}&gt; element`];
  if (node.id) parts.push(`with the id "${esc(node.id)}"`);
  if (node.classes?.length) parts.push(`with the classes ${node.classes.map((c) => `"${esc(c)}"`).join(', ')}`);
  if (node.text) parts.push(`showing the text "${esc(node.text)}"`);
  if (node.attrs?.href) parts.push(`pointing at "${esc(node.attrs.href)}"`);
  return parts.join(', ');
}

// Marks the parts of `b` that differ from `a` word by word, so the reader can
// see what actually changed instead of comparing two blocks by eye.
function markDiff(a, b) {
  const left = String(a ?? '').split(/(\s+)/);
  const right = String(b ?? '').split(/(\s+)/);
  return right
    .map((tok) => (left.includes(tok) ? esc(tok) : `<mark>${esc(tok)}</mark>`))
    .join('');
}

const CSS = `
  :root { color-scheme: light; }
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; padding: 32px 20px; background: #faf9f7; color: #2b2724; }
  main { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .05em;
       color: #7a736c; margin: 32px 0 10px; }
  .lead { font-size: 16px; color: #4a443f; margin: 0 0 4px; }
  .card { background: #fff; border: 1px solid #e6e1db; border-radius: 10px; padding: 14px 16px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .badge { display: inline-block; border-radius: 999px; padding: 3px 12px; font-weight: 600; font-size: 13px; }
  .fragile { background: #fdf0d5; color: #8a5a00; }
  .real-change { background: #fde2e1; color: #9b2c2c; }
  .nondeterministic { background: #e6e9fd; color: #3b4bab; }
  .unclear, .no-anchor { background: #ecebe9; color: #5b544e; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  pre { background: #f4f2ef; border: 1px solid #e6e1db; border-radius: 8px;
        padding: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; }
  mark { background: #ffe9a8; padding: 0 2px; border-radius: 3px; }
  ul.plain { list-style: none; padding: 0; margin: 0; }
  ul.plain li { padding: 8px 0; border-bottom: 1px solid #efece8; }
  ul.plain li:last-child { border-bottom: none; }
  .step-ok::before { content: "OK"; color: #1f7a4d; font-weight: 700; font-size: 11px; margin-right: 8px; }
  .step-no::before { content: "--"; color: #9b2c2c; font-weight: 700; font-size: 11px; margin-right: 8px; }
  .muted { color: #7a736c; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid #e6e1db; padding: 7px 9px; text-align: left; }
  th { background: #f4f2ef; }
  .rank { font-weight: 600; }
`;

function section(title, body) {
  return `<h2>${esc(title)}</h2>${body}`;
}

// A baseline captured before this feature existed (or a snapshot taken
// without html capture) has no `html` field. Diffing against a missing
// snippet would mark the entire other side as "changed", which is not true;
// say so instead, and only diff when both sides actually have a snippet.
function snippet(node, other) {
  if (!node.html) {
    return '<p class="muted">No html snippet in this snapshot. Capture a fresh baseline to see the difference highlighted.</p>';
  }
  if (!other?.html) {
    return `<pre>${esc(node.html)}</pre>`;
  }
  return `<pre>${markDiff(other.html, node.html)}</pre>`;
}

function beforeAfter(detail) {
  const before = detail?.anchorBefore;
  const after = detail?.anchorAfter;
  const card = (label, node, other, missingText) => `
    <div class="card">
      <div class="muted">${esc(label)}</div>
      <p>${describe(node, missingText)}</p>
      ${node ? snippet(node, other) : ''}
    </div>`;
  return `<div class="grid">
    ${card('Before, in the green build', before, null, 'flakeproof did not look at any element here.')}
    ${card('Now, in the current build', after, before, 'No element matched here in the current build.')}
  </div>`;
}

function steps(detail) {
  const list = detail?.steps ?? [];
  if (!list.length) return '<p class="muted">No steps were recorded.</p>';
  return `<div class="card"><ul class="plain">${list
    .map(
      (s) =>
        `<li class="${s.ok ? 'step-ok' : 'step-no'}">${esc(s.label)}<br><span class="muted">${esc(s.outcome)}</span></li>`,
    )
    .join('')}</ul></div>`;
}

// `survived === null` means the candidate was never proven, but that can
// happen for two different reasons: no current url was given at all, or
// proving was attempted and threw. Render the reason that actually
// happened instead of always blaming the missing url.
function proofText(c) {
  if (c.survived === null) {
    return c.unproven === 'failed' ? 'not proven, proving failed' : 'not proven, no current url was given';
  }
  const base = `survived ${c.survived}/${c.applied} mutations`;
  if (c.outcomes?.length) {
    const names = c.outcomes.map((o) => `${o.id} ${o.survived ? 'yes' : 'no'}`).join(', ');
    return `${base} (${names})`;
  }
  return base;
}

function recommendations(list) {
  if (!list?.length) return '<p class="muted">No recommendations for this verdict.</p>';
  const shown = list.filter((c) => c.survived === null || c.survived > 0 || c.uniqueInCurrent);
  if (!shown.length) return '<p class="muted">No candidate survived proving, so there is no safe recommendation.</p>';
  const rows = shown
    .map((c, i) => {
      const proof = proofText(c);
      const unique = c.uniqueInCurrent === null ? 'unknown' : c.uniqueInCurrent ? 'yes' : 'no';
      return `<tr><td class="rank">${i + 1}</td><td><code>${esc(c.selector)}</code></td><td>${esc(c.kind)}</td><td>${esc(unique)}</td><td>${esc(proof)}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>#</th><th>Selector</th><th>Kind</th><th>Unique</th><th>Proof</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function timing(temporal) {
  if (!temporal?.tried?.length) return '';
  const rows = temporal.tried
    .map(
      (t) =>
        `<tr><td>${esc(t.delay)} ms</td><td>${esc(t.failures)}/${esc(t.runs)} runs failed</td><td>${
          temporal.reproduced && temporal.delay === t.delay ? 'reproduces' : ''
        }</td></tr>`,
    )
    .join('');
  return section(
    'Timing provocation',
    `<table><thead><tr><th>Delay</th><th>Result</th><th></th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

export function renderHtmlReport(r) {
  const evidence = r.classification?.reasons?.length
    ? `<div class="card"><ul class="plain">${r.classification.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
    : '<p class="muted">No classification evidence for this verdict.</p>';
  const notes = r.notes?.length
    ? section('Notes', `<div class="card"><ul class="plain">${r.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`)
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flakeproof triage</title>
<style>${CSS}</style></head>
<body><main>
  <h1><span class="badge ${esc(r.verdict)}">${esc(r.verdict)}</span></h1>
  <p class="lead">${esc(VERDICT_TEXT[r.verdict] ?? '')}</p>
  ${section(
    'The test',
    `<div class="card">
       <p>${r.testId ? `Test: <strong>${esc(r.testId)}</strong>` : 'The failing test was not named in the input.'}</p>
       <p>${r.anchor?.selector ? `It was waiting for <code>${esc(r.anchor.selector)}</code> (${esc(r.anchor.kind)}).` : 'The error names no locator.'}</p>
     </div>`,
  )}
  ${section('Before and after, at that exact spot', beforeAfter(r.detail))}
  ${section('Why this verdict', evidence)}
  ${section('What flakeproof did', steps(r.detail))}
  ${section('Recommended selectors', recommendations(r.recommendation))}
  ${timing(r.temporal)}
  ${notes}
</main></body></html>`;
}
