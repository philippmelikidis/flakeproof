// Renders a measureBlindspots result in plain language: what was changed,
// on which element, whether the suite noticed. A reader with no context
// should understand what the number means and what to do about it - so an
// abstention explains itself as clearly as a score does.
import { REPORT_CSS } from '../report-html.js';

const ABSTAIN_TEXT = {
  'control-red':
    'The suite was already red before any mutation was tried, so nothing can be attributed to a blind spot. Fix the suite (or the page) until a plain run is green, then measure again.',
  'control-unreliable':
    'A control run exited with a failure code while its result file listed no failed test - a reporter misconfiguration, not a clean baseline. A suite in this state cannot be trusted to prove anything either way. Check the reporter configuration, then measure again.',
  'wrapper-not-installed':
    'The inject wrapper never acknowledged a single run, so flakeproof cannot tell whether the mutations reached the page at all. A suite that stays green under those conditions is not a "blind" suite - it is an unmeasured one. Wrap your base test once:\n\n    import { test as base } from \'@playwright/test\';\n    import { withTemporal } from \'flakeproof/inject\';\n    export const test = withTemporal(base);\n\nthen run flakeproof blindspots again.',
  'results-unreadable':
    'The suite\'s result file could not be read, so flakeproof cannot tell what the suite actually did. Check the reporter configuration and the --results path, then try again.',
  'mutation-ack-unreadable':
    'The mutation acknowledgment file could not be read on at least one run - a filesystem problem, not proof that the inject wrapper is missing. Check that the ack directory flakeproof creates is writable, and that nothing else is deleting or locking it mid-run, then measure again.',
  'no-mutations-applied':
    'None of the attempted mutations were confirmed to touch the page. See the records below for exactly why each one did not apply - a selector that matched nothing, an element that cannot take that mutation, an inject wrapper that does not recognize the mutation id (a version mismatch between flakeproof and flakeproof/inject), or a page that never reported back at all. No score is meaningful when no experiment actually ran.',
  'all-inconclusive':
    'Every mutation that applied could not be judged: the suite\'s result file was unreadable, or its exit code disagreed with that file, on every round. No score is meaningful when there are zero real observations to compute it from.',
  'all-not-survived':
    'Every mutation that applied was undone before the suite could have asserted on it - most likely an ordinary re-render (hydration, client-side i18n) rewrote the page shortly after the mutation ran. The suite was never actually tested against these changes, so scoring it as blind would be dishonest. Try again against a build where the mutated content is not re-rendered, or target a different element.',
  'all-survival-unknown':
    'Every mutation that applied could not be confirmed to survive the page\'s whole lifetime - most likely the page closed before flakeproof\'s wrapper got a chance to report a final state. Silence is not proof either way, so no score is printed. Try again against a suite whose pages stay open a little longer, or target a different element.',
  'no-observations':
    'Every mutation that applied ended up either unjudgeable, overwritten before the suite could react to it, or of unconfirmed survival, so there are zero real observations to score. See the sections below for exactly which happened to which mutation.',
  'budget-too-low':
    'The run budget is smaller than the number of runs a single round needs, so not even the control could be measured honestly. Raise --budget or lower --runs.',
  // Deliberately absent: 'red-unrelated-to-mutations'. The whole point of
  // that abstention is which specific test/mutation proved the suite is red
  // for a reason no mutation caused - a generic paragraph here would bury
  // that evidence. `result.reason` (built per-measurement in measure.js)
  // already carries it, and the fallback below shows it directly.
};

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function scoreLine(counts) {
  return `The suite notices ${counts.noticed} of ${counts.judged} changes it was actually tested against.`;
}

function notAppliedReasonText(r) {
  if (r.applyReason === 'unknown-mutation-id') {
    return 'the installed inject wrapper does not recognize this mutation id - check that flakeproof and flakeproof/inject are the same version';
  }
  if (r.applyReason === 'found-not-applicable') {
    return 'the element was found, but this mutation could not be applied to it (for example, change-href on an element with no href)';
  }
  if (r.applyReason === 'unknown') {
    // Distinct from "never-found": flakeproof never received a report back
    // from the page at all (for example the suite crashed, or the page
    // never reached DOMContentLoaded) - an unknown, not a confirmed absence.
    // Rendering this as "no element matched this selector" would state a
    // confirmed absence the wrapper never actually established (audit
    // Fix 4b).
    return 'flakeproof never received a report back from the page for this mutation (for example, the suite crashed, or the page never finished loading) - this is unknown, not a confirmed absence; check the suite output for the real cause before assuming the selector is wrong';
  }
  return 'no element matched this selector, even after giving it a bounded chance to appear - check the --selectors list';
}

function inconclusiveReasonText(r) {
  if (r.inconclusiveReason === 'reporter-mismatch') return 'the suite exited with a failure code while its result file listed no failed test on at least one run';
  if (r.inconclusiveReason === 'unstable-across-runs') return 'the suite disagreed with itself across runs of the same round; nothing can be attributed to this mutation';
  return "the suite's result file was unreadable for at least one run";
}

function frameSuffix(r) {
  return r.frame ? ` (frame: ${r.frame})` : '';
}

function appliedStatusText(r) {
  return r.applied ? 'applied' : 'did not apply';
}

// Shared by both renderers so they can never drift apart on which record
// goes in which section (report.js used to compute these filters twice,
// independently, and renderBlindspotsHtml simply never grew a branch for
// `survivalUnknown` records at all - audit Fix 6).
function classifyRecords(records) {
  return {
    unnoticed: records.filter((r) => r.applied && r.survived === true && r.noticed === false),
    noticed: records.filter((r) => r.applied && r.survived === true && r.noticed === true),
    inconclusive: records.filter((r) => r.applied && r.survived === true && r.noticed !== true && r.noticed !== false),
    notSurvived: records.filter((r) => r.applied && r.survived === false),
    survivalUnknown: records.filter((r) => r.applied && r.survivalUnknown === true),
    notApplied: records.filter((r) => !r.applied),
  };
}

export function renderBlindspotsMarkdown(result) {
  const lines = ['# flakeproof blindspots', ''];
  if (result.abstained) {
    lines.push('flakeproof cannot compute a score here.', '', ABSTAIN_TEXT[result.abstained] ?? result.reason ?? result.abstained, '');
    if (result.records?.length) {
      lines.push('## What was attempted before abstaining', '');
      for (const r of result.records) {
        lines.push(`- \`${r.target}\`: ${r.description} - ${appliedStatusText(r)}`);
      }
      lines.push('');
    }
    if (result.skipped?.length) {
      lines.push(`${plural(result.skipped.length, 'experiment')} never ran because the run budget was exhausted first.`, '');
    }
    return lines.join('\n');
  }

  lines.push(scoreLine(result.counts), '');
  lines.push(
    `${plural(result.counts.attempted, 'mutation')} attempted: ` +
      `${result.counts.applied} applied, ${result.counts.notApplied} not applied.`,
  );
  if (result.counts.notSurvived) {
    lines.push(`${plural(result.counts.notSurvived, 'mutation')} applied but did not survive to the suite's own assertions (see "Reverted before assertions" below).`);
  }
  if (result.counts.survivalUnknown) {
    lines.push(`${plural(result.counts.survivalUnknown, 'mutation')} applied but could not be confirmed to survive the page's whole lifetime (see "Could not confirm survival" below).`);
  }
  if (result.counts.inconclusive) {
    lines.push(`${plural(result.counts.inconclusive, 'mutation')} could not be judged (see "Inconclusive" below).`);
  }
  if (result.notes?.length) {
    for (const n of result.notes) lines.push(n);
  }
  lines.push('');

  const { unnoticed, noticed, inconclusive, notSurvived, survivalUnknown, notApplied } = classifyRecords(result.records);

  if (unnoticed.length) {
    lines.push('## Unnoticed', '');
    for (const r of unnoticed) lines.push(`- \`${r.target}\`: ${r.description}${frameSuffix(r)}`);
    lines.push('');
  }

  if (noticed.length) {
    lines.push('## Noticed', '');
    for (const r of noticed) lines.push(`- \`${r.target}\`: ${r.description}${frameSuffix(r)} (red: ${r.redTests.join(', ') || 'unnamed test'})`);
    lines.push('');
  }

  if (inconclusive.length) {
    lines.push('## Inconclusive', '', 'These applied, but nothing can be said about whether the suite noticed them.', '');
    for (const r of inconclusive) lines.push(`- \`${r.target}\`: ${r.description} - ${inconclusiveReasonText(r)}`);
    lines.push('');
  }

  if (notSurvived.length) {
    lines.push(
      '## Reverted before assertions',
      '',
      'These mutations applied, but the page rewrote the target before the suite could have asserted on it (most likely a client-side re-render). Excluded from the score above; the suite was never actually tested against them.',
      '',
    );
    for (const r of notSurvived) lines.push(`- \`${r.target}\`: ${r.description}${frameSuffix(r)}`);
    lines.push('');
  }

  if (survivalUnknown.length) {
    lines.push(
      '## Could not confirm survival',
      '',
      "These mutations applied, but nothing ever confirmed they held for the page's whole lifetime (most likely the page closed before flakeproof could report a final state). Excluded from the score above; silence is not proof either way.",
      '',
    );
    for (const r of survivalUnknown) lines.push(`- \`${r.target}\`: ${r.description}${frameSuffix(r)}`);
    lines.push('');
  }

  if (notApplied.length) {
    lines.push('## Not applied', '', 'These never touched the page, so they are excluded from the score above rather than counted as either noticed or unnoticed.', '');
    for (const r of notApplied) lines.push(`- \`${r.target}\`: ${r.description} - ${notAppliedReasonText(r)}`);
    lines.push('');
  }

  if (result.skipped?.length) {
    lines.push(
      '## Skipped (run budget)',
      '',
      `${plural(result.skipped.length, 'experiment')} never ran because the run budget was exhausted first; this is not full coverage.`,
      '',
    );
    for (const s of result.skipped) lines.push(`- \`${s.target}\`: ${s.description}`);
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

// `showRed` controls whether a record's `redTests` are rendered - this must
// only ever be true for genuinely noticed records. Showing "(red: ...)" next
// to a not-applied or inconclusive record would imply a mutation that never
// happened (or was never actually judged) caused a failure it had nothing to
// do with (Fix 8 in the review: this used to happen unconditionally in the
// abstain branch's "what was attempted" list). `showApplied` renders the
// applied/did-not-apply status the markdown renderer's abstain list already
// carries, so the two renderers never drift on what facts they show for the
// same result (audit Fix 6).
function list(records, { showRed = false, showReason = null, showApplied = false } = {}) {
  return `<div class="card"><ul class="plain">${records
    .map((r) => {
      const red = showRed && r.redTests?.length ? ` <span class="muted">(red: ${esc(r.redTests.join(', '))})</span>` : '';
      const frame = r.frame ? ` <span class="muted">(frame: ${esc(r.frame)})</span>` : '';
      const reason = showReason ? ` <span class="muted">- ${esc(showReason(r))}</span>` : '';
      const applied = showApplied ? ` <span class="muted">- ${esc(appliedStatusText(r))}</span>` : '';
      return `<li><code>${esc(r.target)}</code>: ${esc(r.description)}${red}${frame}${reason}${applied}</li>`;
    })
    .join('')}</ul></div>`;
}

function notesHtml(notes) {
  if (!notes?.length) return '';
  return `<ul class="plain">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
}

export function renderBlindspotsHtml(result) {
  if (result.abstained) {
    const text = ABSTAIN_TEXT[result.abstained] ?? result.reason ?? result.abstained;
    const attempted = result.records?.length
      ? section('What was attempted before abstaining', list(result.records, { showApplied: true }))
      : '';
    const skipped = result.skipped?.length
      ? section('Skipped (run budget)', `<p class="muted">${esc(plural(result.skipped.length, 'experiment'))} never ran because the run budget was exhausted first.</p>${list(result.skipped)}`)
      : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flakeproof blindspots</title>
<style>${REPORT_CSS}${style()}</style></head>
<body><div class="wrap">
  <h1>No score</h1>
  <pre>${esc(text)}</pre>
  ${notesHtml(result.notes)}
  ${attempted}
  ${skipped}
</div></body></html>`;
  }

  const { unnoticed, noticed, inconclusive, notSurvived, survivalUnknown, notApplied } = classifyRecords(result.records);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flakeproof blindspots</title>
<style>${REPORT_CSS}${style()}</style></head>
<body><div class="wrap">
  <h1>flakeproof blindspots</h1>
  <p class="score">${esc(scoreLine(result.counts))}</p>
  <p class="muted">${esc(plural(result.counts.attempted, 'mutation'))} attempted: ${result.counts.applied} applied, ${result.counts.notApplied} not applied.
  ${result.counts.notSurvived ? esc(`${result.counts.notSurvived} did not survive to the suite's assertions.`) : ''}
  ${result.counts.survivalUnknown ? esc(`${result.counts.survivalUnknown} could not be confirmed to survive the page's whole lifetime.`) : ''}
  ${result.counts.inconclusive ? esc(`${result.counts.inconclusive} could not be judged.`) : ''}</p>
  ${notesHtml(result.notes)}
  ${unnoticed.length ? section('Unnoticed', list(unnoticed)) : ''}
  ${noticed.length ? section('Noticed', list(noticed, { showRed: true })) : ''}
  ${inconclusive.length ? section('Inconclusive', `<p class="muted">These applied, but nothing can be said about whether the suite noticed them.</p>${list(inconclusive, { showReason: inconclusiveReasonText })}`) : ''}
  ${notSurvived.length ? section('Reverted before assertions', `<p class="muted">Excluded from the score above; the page rewrote the target before the suite could have asserted on it.</p>${list(notSurvived)}`) : ''}
  ${survivalUnknown.length ? section('Could not confirm survival', `<p class="muted">Excluded from the score above; nothing ever confirmed these held for the page's whole lifetime.</p>${list(survivalUnknown)}`) : ''}
  ${notApplied.length ? section('Not applied', `<p class="muted">Excluded from the score above; these never touched the page.</p>${list(notApplied, { showReason: notAppliedReasonText })}`) : ''}
  ${result.skipped?.length ? section('Skipped (run budget)', `<p class="muted">${esc(plural(result.skipped.length, 'experiment'))} never ran because the run budget was exhausted first; this is not full coverage.</p>${list(result.skipped)}`) : ''}
</div></body></html>`;
}
