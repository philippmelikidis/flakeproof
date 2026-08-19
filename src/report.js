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
    lines.push('', '## Recommended selectors', '');
    lines.push('| selector | kind | unique | survived mutations |');
    lines.push('|---|---|---|---|');
    for (const c of r.recommendation) {
      const proof = c.survived === null ? 'not proven (no current URL)' : `${c.survived}/${c.applied}`;
      lines.push(`| \`${c.selector}\` | ${c.kind} | ${c.uniqueAtBaseline ? 'yes' : 'no'} | ${proof} |`);
    }
  }
  if (r.notes?.length) {
    lines.push('', '## Notes');
    for (const note of r.notes) lines.push(`- ${note}`);
  }
  lines.push('');
  return lines.join('\n');
}
