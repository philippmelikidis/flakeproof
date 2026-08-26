// Renders a triage result as a short markdown report for humans and PR
// comments. Plain text, no emojis.
export function renderReport(r) {
  const lines = ['# flakeproof triage', ''];
  lines.push(`Verdict: **${r.verdict}**`);
  if (r.testId) lines.push(`Test: ${r.testId}`);
  if (r.anchor?.selector) lines.push(`Anchor: \`${r.anchor.selector}\` (${r.anchor.kind})`);
  if (r.rerun) lines.push(`Reruns: ${r.rerun.failures}/${r.rerun.runs} failed (exit codes: ${r.rerun.exitCodes.join(', ')})`);
  if (r.classification?.reasons?.length) {
    lines.push('', '## Evidence');
    for (const reason of r.classification.reasons) lines.push(`- ${reason}`);
  }
  if (r.recommendation?.length) {
    const shown = r.recommendation.filter((c) => c.survived === null || c.survived > 0 || c.uniqueInCurrent);
    if (shown.length === 0) {
      lines.push('', 'No candidate survived proving; no safe recommendation.');
    } else {
      lines.push('', '## Recommended selectors', '');
      lines.push('| selector | kind | unique | survived mutations |');
      lines.push('|---|---|---|---|');
      for (const c of shown) {
        const proof = c.survived === null ? 'not proven (no current URL)' : `${c.survived}/${c.applied}`;
        const unique = c.uniqueInCurrent === null ? 'unknown' : c.uniqueInCurrent ? 'yes' : 'no';
        lines.push(`| \`${c.selector}\` | ${c.kind} | ${unique} | ${proof} |`);
      }
    }
  }
  if (r.temporal && r.temporal.tried.length) {
    lines.push('', '## Timing provocation');
    for (const t of r.temporal.tried) lines.push(`- ${t.delay} ms: ${t.failures}/${t.runs} runs failed`);
  }
  if (r.notes?.length) {
    lines.push('', '## Notes');
    for (const note of r.notes) lines.push(`- ${note}`);
  }
  lines.push('');
  return lines.join('\n');
}
