// The red-triage pipeline: anchor from the failure, optional reruns for
// nondeterminism, classification against the green baseline, and a proven
// selector recommendation when the test turns out to be fragile.
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { extractAnchor } from './anchor.js';
import { failedTestsFromOutputXml } from '../adapters/robot.js';
import { classifyDelta } from './classify.js';
import { candidatesFor } from './candidates.js';
import { proveCandidates } from './prove.js';
import { rerunStats } from './rerun.js';
import { captureSnapshot } from '../snapshot.js';

const VERDICT_BY_CLASSIFICATION = { cosmetic: 'fragile', semantic: 'real-change', unclear: 'unclear' };

// The baseline was captured while the build was green, before the failing
// selector was known. Resolve it now against the stored html via
// page.locator, which understands Playwright selector syntax.
async function resolveAnchorPath(baseline, selector) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(baseline.html);
    const locator = page.locator(selector);
    const count = await locator.count();
    if (count === 0) return { path: null, count };
    /* eslint-disable no-undef */
    const path = await locator.first().evaluate((el) => {
      const p = [];
      let cur = el;
      while (cur && cur !== document.documentElement) {
        const parent = cur.parentElement;
        if (!parent) break;
        p.unshift([...parent.children].indexOf(cur));
        cur = parent;
      }
      return p;
    });
    /* eslint-enable no-undef */
    return { path, count };
  } finally {
    await browser.close();
  }
}

export async function triage(opts) {
  const notes = [];
  let errorText = opts.errorText ?? null;
  let testId = null;

  if (!errorText && opts.robotOutputXml) {
    const failures = await failedTestsFromOutputXml(opts.robotOutputXml);
    if (failures.length === 0) {
      return { verdict: 'no-anchor', anchor: null, testId, rerun: null, classification: null, recommendation: null, notes: ['no failed test in output.xml'] };
    }
    errorText = failures[0].message;
    testId = failures[0].testId;
    if (failures.length > 1) notes.push(`${failures.length} failed tests in output.xml, triaging the first: ${testId}`);
  }

  const anchor = extractAnchor(errorText ?? '');
  if (!anchor.selector) {
    return {
      verdict: 'no-anchor', anchor, testId, rerun: null, classification: null, recommendation: null,
      notes: [...notes, 'no locator found in the error; cannot triage without an anchor'],
    };
  }

  let rerun = null;
  if (opts.rerunCommand) {
    rerun = await rerunStats(opts.rerunCommand, opts.reruns ?? 3);
    if (rerun.failures === 0 || rerun.nondeterministic) {
      const why = rerun.failures === 0 ? 'test went green on every rerun' : 'test fails intermittently across reruns';
      return { verdict: 'nondeterministic', anchor, testId, rerun, classification: null, recommendation: null, notes: [...notes, why] };
    }
    notes.push('test failed on every rerun; deterministic failure');
  }

  const baseline = JSON.parse(await readFile(opts.baselinePath, 'utf8'));
  if (!baseline.html || !baseline.tree) {
    return { verdict: 'unclear', anchor, testId, rerun, classification: null, recommendation: null, notes: [...notes, 'baseline snapshot is missing tree or html'] };
  }

  const resolved = await resolveAnchorPath(baseline, anchor.selector);
  if (!resolved.path) {
    return { verdict: 'unclear', anchor, testId, rerun, classification: null, recommendation: null, notes: [...notes, 'anchor selector does not resolve in the baseline snapshot'] };
  }
  if (resolved.count > 1) notes.push(`anchor selector matches ${resolved.count} baseline elements, using the first`);

  const current = opts.currentPath
    ? JSON.parse(await readFile(opts.currentPath, 'utf8'))
    : await captureSnapshot(opts.currentUrl);

  const classification = classifyDelta({ tree: baseline.tree, anchorPath: resolved.path }, current, anchor.selector);
  const verdict = VERDICT_BY_CLASSIFICATION[classification.verdict];

  let recommendation = null;
  if (verdict === 'fragile') {
    const candidates = candidatesFor(baseline.tree, resolved.path);
    if (candidates.length === 0) {
      notes.push('no provable selector candidates found for the anchor element');
    } else if (opts.currentUrl && classification.match?.path) {
      recommendation = await proveCandidates(opts.currentUrl, classification.match.path, candidates);
    } else {
      recommendation = candidates.map((c) => ({ ...c, uniqueAtBaseline: true, survived: null, applied: null }));
      notes.push('candidates are uniqueness-checked against the baseline only; pass a current URL to prove them against mutations');
    }
  }

  return { verdict, anchor, testId, rerun, classification, recommendation, notes };
}
