// The red-triage pipeline: anchor from the failure, optional reruns for
// nondeterminism, classification against the green baseline, and a proven
// selector recommendation when the test turns out to be fragile.
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { extractAnchor } from './anchor.js';
import { failedTestsFromOutputXml } from '../adapters/robot.js';
import { classifyDelta } from './classify.js';
import { candidatesFor, CURRENT_SNAPSHOT_VERSION } from './candidates.js';
import { proveCandidates } from './prove.js';
import { rerunStats } from './rerun.js';
import { temporalProbe } from './temporal-probe.js';
import { temporalTargetFor } from './temporal-target.js';
import { captureSnapshot } from '../snapshot.js';
import { nodeAt } from './tree.js';
import { nodeHtmlAtPath } from '../probe/snippet.js';

// The tree no longer carries a per-node `html` snippet (see
// src/probe/serialize.js). Reconstruct it on demand for exactly the node a
// report needs, from the snapshot's own full-page `html` plus the node's
// path - a plain string walk, so this also works for a snapshot loaded from
// `--current <file>` with no browser involved. `fullHtml` can legitimately
// be absent (a stripped or hand-built snapshot); nodeHtmlAtPath already
// degrades to null rather than guessing, and the report renders an honest
// "no html snippet" message for a node with no `html` field instead of a
// blank card.
function withHtmlSnippet(node, fullHtml) {
  if (!node) return node;
  const html = nodeHtmlAtPath(fullHtml, node.path);
  return html ? { ...node, html } : node;
}

const VERDICT_BY_CLASSIFICATION = { cosmetic: 'fragile', semantic: 'real-change', unclear: 'unclear' };

// A recommendation is for the FUTURE build, so selector candidates must be
// built from the CURRENT tree, at the anchor's current-build location. That
// location only exists when classifyDelta found a confident match; without
// one there is nothing current to build from. classifyDelta's own contract
// happens to guarantee a match whenever its verdict is 'cosmetic' (the
// no-match branch only ever returns 'semantic' or 'unclear'), so in
// practice this never falls through to null today - but that is an
// invariant of another module, not of this one, so it is checked here
// explicitly rather than assumed. Never silently substitute the baseline
// tree here: a candidate built from an element that may no longer exist in
// the current build is exactly the staleness this function exists to avoid.
// Internal: exported only so a unit test can call it directly. It is
// reachable as public API through the package's "exports" map (this module
// is the "." export), so treat any signature change as a breaking change.
// The return shape changed from `{ tree, path }` to `{ snapshot, path }`:
// candidatesFor now needs the whole current-build snapshot (tree plus
// snapshotVersion), not just its tree, to know whether it can trust the
// per-node accessible-name exactness flags at all - see candidates.js.
export function fragileCandidateSource(classification, current) {
  if (!classification?.match?.path) return null;
  return { snapshot: current, path: classification.match.path };
}

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
  const steps = [];
  const step = (label, outcome, ok = true) => { steps.push({ label, outcome, ok }); };
  let anchorBefore = null;
  let anchorAfter = null;
  const detail = () => ({ anchorBefore, anchorAfter, steps });
  let errorText = opts.errorText ?? null;
  let testId = null;

  if (!errorText && opts.robotOutputXml) {
    const failures = await failedTestsFromOutputXml(opts.robotOutputXml);
    if (failures.length === 0) {
      return { verdict: 'no-anchor', anchor: null, testId, rerun: null, classification: null, recommendation: null, temporal: null, notes: ['no failed test in output.xml'], detail: detail() };
    }
    errorText = failures[0].message;
    testId = failures[0].testId;
    if (failures.length > 1) notes.push(`${failures.length} failed tests in output.xml, triaging the first: ${testId}`);
  }

  const anchor = extractAnchor(errorText ?? '');
  if (!anchor.selector) {
    step('Anchor read from the error message', 'no locator found in the error', false);
    return {
      verdict: 'no-anchor', anchor, testId, rerun: null, classification: null, recommendation: null, temporal: null,
      notes: [...notes, 'no locator found in the error; cannot triage without an anchor'],
      detail: detail(),
    };
  }
  step('Anchor read from the error message', anchor.selector);

  if (anchor.kind === 'ambiguous') {
    notes.push('the failing locator matched multiple elements (strict mode violation); ambiguity itself is a fragility signal');
  }

  if (opts.temporal && !opts.rerunCommand) notes.push('temporal probing requires a rerun command; probe skipped');

  let rerun = null;
  if (opts.rerunCommand) {
    rerun = await rerunStats(opts.rerunCommand, opts.reruns ?? 3);
    step('Reran the failing test', rerun.failures + '/' + rerun.runs + ' runs failed');
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
          step('Provoked a delay on the anchor', temporal.reproduced ? 'reproduced at ' + temporal.delay + ' ms' : 'no reproduction', temporal.reproduced);
          if (temporal.reproduced) {
            notes.push(`fails on every run when "${anchor.selector}" appears ${temporal.delay} ms late; likely a missing wait`);
          } else if (temporal.control && temporal.control.failures > 0) {
            notes.push('temporal probe aborted: the control run without any delay already failed, so the baseline is too unstable to attribute failures to timing');
          } else if (temporal.injected === false) {
            notes.push('the inject wrapper never acknowledged the delay; install withTemporal from flakeproof/inject in the suite before trusting any timing verdict');
          } else {
            notes.push('no reproduction: the delay style was installed on every round, but whether it affected the anchor is unverified; timing remains unlikely but not excluded');
          }
        }
      }
      return { verdict: 'nondeterministic', anchor, testId, rerun, temporal, classification: null, recommendation: null, notes, detail: detail() };
    }
    if (rerun.commandBroken) {
      notes.push('every rerun exited with a spawn error or command-not-found; the rerun command itself looks broken and the rerun statistics are not meaningful');
    } else {
      notes.push('test failed on every rerun; deterministic failure');
    }
    if (opts.temporal) {
      notes.push('temporal probe skipped: the test fails on every rerun, so there is no intermittency for a delay to explain');
    }
  }

  const baseline = JSON.parse(await readFile(opts.baselinePath, 'utf8'));
  if (!baseline.html || !baseline.tree) {
    return { verdict: 'unclear', anchor, testId, rerun, classification: null, recommendation: null, temporal: null, notes: [...notes, 'baseline snapshot is missing tree or html'], detail: detail() };
  }

  const resolved = await resolveAnchorPath(baseline, anchor.selector);
  if (resolved.error) {
    step('Anchor located in the baseline', 'anchor selector could not be evaluated against the baseline', false);
    return { verdict: 'unclear', anchor, testId, rerun, classification: null, recommendation: null, temporal: null, notes: [...notes, 'anchor selector could not be evaluated against the baseline'], detail: detail() };
  }
  if (!resolved.path) {
    step('Anchor located in the baseline', 'anchor selector does not resolve in the baseline snapshot', false);
    return { verdict: 'unclear', anchor, testId, rerun, classification: null, recommendation: null, temporal: null, notes: [...notes, 'anchor selector does not resolve in the baseline snapshot'], detail: detail() };
  }
  if (resolved.count > 1) notes.push(`anchor selector matches ${resolved.count} baseline elements, using the first`);
  step('Anchor located in the baseline', 'found at path ' + resolved.path.join('.'));

  const treeNode = nodeAt(baseline.tree, resolved.path);
  if (!treeNode || treeNode.tag !== resolved.tag || (treeNode.id ?? null) !== (resolved.id ?? null)) {
    step('Baseline html and tree checked for agreement', 'baseline html and serialized tree disagree at the anchor', false);
    return { verdict: 'unclear', anchor, testId, rerun, classification: null, recommendation: null, temporal: null, notes: [...notes, 'baseline html and serialized tree disagree at the anchor; cannot triage reliably'], detail: detail() };
  }
  step('Baseline html and tree checked for agreement', 'consistent');

  const current = opts.currentPath
    ? JSON.parse(await readFile(opts.currentPath, 'utf8'))
    : await captureSnapshot(opts.currentUrl);

  const classification = classifyDelta({ tree: baseline.tree, anchorPath: resolved.path }, current, anchor.selector);
  const verdict = VERDICT_BY_CLASSIFICATION[classification.verdict];
  anchorBefore = withHtmlSnippet(treeNode, baseline.html);
  if (classification.match?.path) {
    anchorAfter = withHtmlSnippet(nodeAt(current.tree, classification.match.path), current.html);
  }
  step('Compared baseline and current build at the anchor', classification.verdict);

  let recommendation = null;
  if (verdict === 'fragile') {
    const source = fragileCandidateSource(classification, current);
    if (!source) {
      notes.push(
        'no candidates generated: the anchor element could not be re-identified in the current build, so ' +
          'building candidates from the stale baseline would repeat exactly the staleness this check exists to avoid',
      );
      step('Generated selector candidates', 'skipped: no matching element found in the current build', false);
    } else {
      const candidates = candidatesFor(source.snapshot, source.path);
      if (source.snapshot.snapshotVersion !== CURRENT_SNAPSHOT_VERSION) {
        notes.push(
          "the current build's snapshot has no recognized snapshotVersion (captured by an older flakeproof, " +
            'or the field was stripped); role candidates cannot be trusted from it and are suppressed rather than guessed',
        );
      }
      if (candidates.length === 0) {
        notes.push('no provable selector candidates found for the anchor element');
        step('Generated selector candidates from the current tree', 'none could be verified for this element', false);
      } else if (opts.currentUrl) {
        try {
          recommendation = await proveCandidates(opts.currentUrl, source.path, candidates);
          step('Proved candidates from the current tree in a real browser', recommendation.length + ' candidates tested');
        } catch (err) {
          recommendation = candidates.map((c) => ({ ...c, uniqueInCurrent: null, survived: null, applied: null, unproven: 'failed' }));
          notes.push('could not prove candidates against the current build: ' + err.message);
          step('Proved candidates from the current tree in a real browser', 'failed: ' + err.message, false);
        }
      } else {
        recommendation = candidates.map((c) => ({ ...c, uniqueInCurrent: null, survived: null, applied: null, unproven: 'no-url' }));
        notes.push(
          "candidates were built from the current build's tree; text and role uniqueness is approximated, not " +
            'verified; pass a current URL to prove them against mutations',
        );
        step('Generated selector candidates from the current tree', candidates.length + ' candidates, not proven', false);
      }
    }
  }

  return { verdict, anchor, testId, rerun, classification, recommendation, temporal: null, notes, detail: detail() };
}
