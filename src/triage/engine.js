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
import { temporalProbe } from './temporal-probe.js';
import { temporalTargetFor } from './temporal-target.js';
import { captureSnapshot } from '../snapshot.js';
import { nodeAt } from './tree.js';

const VERDICT_BY_CLASSIFICATION = { cosmetic: 'fragile', semantic: 'real-change', unclear: 'unclear' };

// The baseline was captured while the build was green, before the failing
// selector was known. Resolve it now against the stored html via
// page.locator, which understands Playwright selector syntax.
async function resolveAnchorPath(baseline, selector) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // The serialized tree was captured after script execution; re-running
    // inline scripts against the already-hydrated HTML would mutate the DOM
    // a second time and shift child indices. Script elements are part of
    // the serialized tree, so they must stay in the DOM to keep child
    // indices aligned. Neutralize them instead of removing them: injecting
    // a foreign type as the FIRST attribute wins over any existing type
    // attribute, so the script is never executed again.
    const html = baseline.html.replace(/<script\b/gi, '<script type="application/x-flakeproof-disabled" ');
    await page.setContent(html);
    const locator = page.locator(selector);
    try {
      const count = await locator.count();
      if (count === 0) return { path: null, count };
      /* eslint-disable no-undef */
      const { p, tag, id } = await locator.first().evaluate((el) => {
        const p = [];
        let cur = el;
        while (cur && cur !== document.documentElement) {
          const parent = cur.parentElement;
          if (!parent) break;
          p.unshift([...parent.children].indexOf(cur));
          cur = parent;
        }
        return { p, tag: el.tagName.toLowerCase(), id: el.id || null };
      });
      /* eslint-enable no-undef */
      return { path: p, tag, id, count };
    } catch (err) {
      return { path: null, count: 0, error: err.message };
    }
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
      return { verdict: 'no-anchor', anchor: null, testId, rerun: null, classification: null, recommendation: null, temporal: null, notes: ['no failed test in output.xml'] };
    }
    errorText = failures[0].message;
    testId = failures[0].testId;
    if (failures.length > 1) notes.push(`${failures.length} failed tests in output.xml, triaging the first: ${testId}`);
  }

  const anchor = extractAnchor(errorText ?? '');
  if (!anchor.selector) {
    return {
      verdict: 'no-anchor', anchor, testId, rerun: null, classification: null, recommendation: null, temporal: null,
      notes: [...notes, 'no locator found in the error; cannot triage without an anchor'],
    };
  }

  if (anchor.kind === 'ambiguous') {
    notes.push('the failing locator matched multiple elements (strict mode violation); ambiguity itself is a fragility signal');
  }

  if (opts.temporal && !opts.rerunCommand) notes.push('temporal probing requires a rerun command; probe skipped');

  let rerun = null;
  if (opts.rerunCommand) {
    rerun = await rerunStats(opts.rerunCommand, opts.reruns ?? 3);
    if (rerun.failures === 0 || rerun.nondeterministic) {
      const why = rerun.failures === 0 ? 'test went green on every rerun' : 'test fails intermittently across reruns';
      notes.push(why);
      let temporal = null;
      if (opts.temporal) {
        const target = temporalTargetFor(anchor.selector);
        if (!target) {
          notes.push('temporal probe skipped: no sufficiently specific css target can be derived from the anchor');
        } else {
          if (target !== anchor.selector) {
            notes.push(`temporal delay targets the css base "${target}" derived from the anchor`);
          }
          temporal = await temporalProbe(opts.rerunCommand, target);
          if (temporal.reproduced) {
            notes.push(`fails on every run when "${anchor.selector}" appears ${temporal.delay} ms late; likely a missing wait`);
          } else if (temporal.control && temporal.control.failures > 0) {
            notes.push('temporal probe aborted: the control run without any delay already failed, so the baseline is too unstable to attribute failures to timing');
          } else if (temporal.injected === false) {
            notes.push('the inject wrapper never acknowledged the delay; install withTemporal from flakeproof/inject in the suite before trusting any timing verdict');
          } else {
            notes.push('no reproduction: the delay was injected but the failure did not come back; timing on this anchor is unlikely to be the cause');
          }
        }
      }
      return { verdict: 'nondeterministic', anchor, testId, rerun, temporal, classification: null, recommendation: null, notes };
    }
    notes.push('test failed on every rerun; deterministic failure');
  }

  const baseline = JSON.parse(await readFile(opts.baselinePath, 'utf8'));
  if (!baseline.html || !baseline.tree) {
    return { verdict: 'unclear', anchor, testId, rerun, classification: null, recommendation: null, temporal: null, notes: [...notes, 'baseline snapshot is missing tree or html'] };
  }

  const resolved = await resolveAnchorPath(baseline, anchor.selector);
  if (resolved.error) {
    return { verdict: 'unclear', anchor, testId, rerun, classification: null, recommendation: null, temporal: null, notes: [...notes, 'anchor selector could not be evaluated against the baseline'] };
  }
  if (!resolved.path) {
    return { verdict: 'unclear', anchor, testId, rerun, classification: null, recommendation: null, temporal: null, notes: [...notes, 'anchor selector does not resolve in the baseline snapshot'] };
  }
  if (resolved.count > 1) notes.push(`anchor selector matches ${resolved.count} baseline elements, using the first`);

  const treeNode = nodeAt(baseline.tree, resolved.path);
  if (!treeNode || treeNode.tag !== resolved.tag || (treeNode.id ?? null) !== (resolved.id ?? null)) {
    return { verdict: 'unclear', anchor, testId, rerun, classification: null, recommendation: null, temporal: null, notes: [...notes, 'baseline html and serialized tree disagree at the anchor; cannot triage reliably'] };
  }

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
      try {
        recommendation = await proveCandidates(opts.currentUrl, classification.match.path, candidates);
      } catch (err) {
        recommendation = candidates.map((c) => ({ ...c, uniqueInCurrent: null, survived: null, applied: null }));
        notes.push('could not prove candidates against the current build: ' + err.message);
      }
    } else {
      recommendation = candidates.map((c) => ({ ...c, uniqueInCurrent: null, survived: null, applied: null }));
      notes.push('candidates are uniqueness-checked against the baseline only; text and role uniqueness is approximated, not verified; pass a current URL to prove them against mutations');
    }
  }

  return { verdict, anchor, testId, rerun, classification, recommendation, temporal: null, notes };
}
