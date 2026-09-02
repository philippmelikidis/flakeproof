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
import { temporalTargetFor, isValidCssTarget } from './temporal-target.js';
import { captureSnapshot } from '../snapshot.js';
import { nodeAt } from './tree.js';
import { nodeHtmlAtPath } from '../probe/snippet.js';

// The tree no longer carries a per-node `html` snippet (see
// src/probe/serialize.js). Reconstruct it on demand for exactly the node a
// report needs, from the snapshot's own full-page `html` plus the node's
// path - a plain string walk, so this also works for a snapshot loaded from
// `--current <file>` with no browser involved. `fullHtml` can legitimately
// be absent (a stripped or hand-built snapshot, e.g. an old-format baseline)
// - that is the ONLY case the report should describe as "no html snippet in
// this snapshot". When `fullHtml` IS present but the scanner still could not
// resolve `node.path` (malformed markup, or a shape mismatch it caught via
// the leading-tag self-check in nodeHtmlAtPath), that is a different,
// honest failure: the snapshot does carry html, it just could not be walked
// to this element. Marking the node with `htmlUnresolved` lets the report
// say exactly that instead of falsely claiming the snapshot has no html at
// all - and a note is pushed so the failure also reaches the Notes section
// and the markdown report, not just the html one.
//
// Exported only so a unit test can call it directly (same convention as
// fragileCandidateSource below): reproducing a genuine scanner failure
// end-to-end through a real browser capture is hard on purpose, because
// browsers normalize markup before ever handing back outerHTML, so a direct
// test is the reliable way to pin this function's own note/flag behavior.
export function withHtmlSnippet(node, fullHtml, label, notes) {
  if (!node) return node;
  const html = nodeHtmlAtPath(fullHtml, node.path, node.tag);
  if (html) return { ...node, html };
  if (fullHtml) {
    notes.push(
      `the stored page html could not be walked to the ${label} anchor element; the snippet is omitted rather than guessed`,
    );
    return { ...node, htmlUnresolved: true };
  }
  return node;
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
          // The derivation is string surgery; validate it against a real
          // browser before ever using it to provoke a delay. A target that
          // is not valid css would be silently discarded by the browser,
          // making the whole experiment a no-op that still looks installed
          // - exactly the false-confidence issue #10 exists to close.
          const validationBrowser = await chromium.launch();
          let targetIsValid;
          try {
            targetIsValid = await isValidCssTarget(validationBrowser, target);
          } finally {
            await validationBrowser.close();
          }
          if (!targetIsValid) {
            notes.push(
              `temporal probe skipped: the derived css target "${target}" is not valid css; abstaining rather than ` +
                'risking a rule the browser would silently discard',
            );
          } else {
            if (target !== anchor.selector) {
              notes.push(`temporal delay targets the css base "${target}" derived from the anchor`);
            }
            temporal = await temporalProbe(opts.rerunCommand, target);
            // Fix 6: a step claiming a delay was provoked must not be
            // recorded when no delay round ever actually ran - which happens
            // when the control run itself already failed and the probe
            // aborted before trying a single delay (`temporal.tried` is
            // empty in that case). The report renders every step under
            // "What flakeproof did"; recording this one unconditionally
            // would tell the user a round happened that never did.
            if (temporal.tried.length > 0) {
              step('Provoked a delay on the anchor', temporal.reproduced ? 'reproduced at ' + temporal.delay + ' ms' : 'no reproduction', temporal.reproduced);
            }
            // Every branch below must be defensible from exactly what
            // temporalProbe observed - never phrase a stronger claim than
            // the evidence supports, and never a weaker one either. The
            // reproduction note names the DERIVED TARGET that was actually
            // delayed (`target`), not the raw anchor selector, since those
            // two can differ (a chain/suffix anchor is delayed via its css
            // base - see temporal-target.js).
            if (temporal.reproduced) {
              const n = temporal.matched;
              const reproducingRound = temporal.tried.find((t) => t.delay === temporal.delay);
              const runsPhrase = reproducingRound ? `every one of ${reproducingRound.runs} run(s)` : 'every run';
              notes.push(
                `fails on ${runsPhrase} when "${target}" appears ${temporal.delay} ms late (the delay rule ` +
                  `matched ${n} element${n === 1 ? '' : 's'}, confirmed live in the stylesheet); likely a missing wait`,
              );
            } else if (temporal.control && temporal.control.failures > 0) {
              notes.push('temporal probe aborted: the control run without any delay already failed, so the baseline is too unstable to attribute failures to timing');
            } else if (temporal.unreadable) {
              // Distinct from "never acknowledged": the wrapper may well be
              // installed, but its receipt could not be read (e.g. a
              // permissions error). Telling the user to install the wrapper
              // here would be a false, misleading claim.
              notes.push(
                'the inject wrapper\'s acknowledgment could not be read (a filesystem or permissions error), not ' +
                  'that it was never installed; the timing verdict is unverified, not negative',
              );
            } else if (temporal.injected === false) {
              notes.push('the inject wrapper never acknowledged the delay; install withTemporal from flakeproof/inject in the suite before trusting any timing verdict');
            } else if (temporal.matched === 0) {
              // The aggregate can be a confirmed zero even when only ONE
              // round actually reported a count and the rest are unknown
              // (Fix 7); only claim "on every round" when every round tried
              // actually agrees.
              const everyRoundZero = temporal.tried.length > 0 && temporal.tried.every((t) => t.matched === 0);
              if (everyRoundZero) {
                notes.push(
                  `the delay rule matched no element for "${target}" on every round tried; timing was never ` +
                    'actually tested, so this is not evidence against a timing cause',
                );
              } else {
                const perRound = temporal.tried.map((t) => (typeof t.matched === 'number' ? String(t.matched) : 'unknown')).join(', ');
                notes.push(
                  `the delay rule matched no element for "${target}" in the only round that reported a count ` +
                    `(the rest are unknown: ${perRound}); timing was never confirmed tested, so this is not ` +
                    'evidence against a timing cause',
                );
              }
            } else if (temporal.matched > 0 && !temporal.ruleLive) {
              // The selector matched real elements, but the delay rule built
              // from that same selector was never confirmed live in the
              // stylesheet (item D): the browser may have silently discarded
              // it, so the experiment may never have actually run. A count
              // alone cannot carry a confident claim in either direction.
              notes.push(
                `the delay rule matched ${temporal.matched} element(s) for "${target}", but the rule itself was ` +
                  'never confirmed live in the stylesheet; the browser may have silently discarded it, so this is ' +
                  'not evidence against a timing cause',
              );
            } else if (temporal.matched > 0) {
              // A confident negative ("timing is unlikely to be the cause")
              // additionally requires that EVERY round tried actually
              // demonstrated BOTH a nonzero match AND a rule confirmed live
              // (Fix 2) - not just the strongest count seen across rounds
              // (item C), and not a rule that was only ever confirmed live
              // on a DIFFERENT round than the one with a nonzero count
              // (Fix 1/2: count and rule-live must agree per round, not just
              // in aggregate). If any round disagrees on either axis, the
              // "on every round" wording would overstate what was actually
              // observed; hedge instead and show the reader what varied.
              const everyRoundConfirmed =
                temporal.tried.length > 0 &&
                temporal.tried.every((t) => typeof t.matched === 'number' && t.matched > 0 && t.ruleLive === true);
              if (everyRoundConfirmed) {
                notes.push(
                  `no reproduction: the delay rule matched ${temporal.matched} element(s) on every round, ` +
                    'confirmed live in the stylesheet each time, but the test still passed; timing is unlikely to be the cause',
                );
              } else {
                const perRound = temporal.tried
                  .map((t) => {
                    const m = typeof t.matched === 'number' ? String(t.matched) : 'unknown';
                    const live = t.ruleLive === true ? 'live' : t.ruleLive === false ? 'not live' : 'live: unknown';
                    return `${m} matched, rule ${live}`;
                  })
                  .join('; ');
                notes.push(
                  `no reproduction: the delay rule's evidence varied across rounds (${perRound}); ` +
                    'at least one round did not confirm both a nonzero match and a live rule, so timing is not confidently ruled out',
                );
              }
            } else {
              // temporal.matched === null: installed somewhere, but no round
              // both fully failed and reported a usable count, OR a round
              // did fully fail with an unreadable count (old-format ack).
              // These two situations must not share the same wording (Fix
              // 3): a round that failed on every one of its runs but could
              // not report a count is weak evidence FOR timing, not against
              // it, and must never be described as "unlikely".
              const anyRoundFullyFailed = temporal.tried.some((t) => t.runs > 0 && t.failures === t.runs);
              const everyRoundInstalled = temporal.tried.length > 0 && temporal.tried.every((t) => t.installed);
              if (anyRoundFullyFailed) {
                notes.push(
                  'a delay round failed on every run but its match count could not be determined (an old-format ' +
                    'or incomplete acknowledgment); this is an unverified possible reproduction, not evidence against timing',
                );
              } else if (everyRoundInstalled) {
                notes.push('no reproduction: the delay style was installed on every round, but whether it affected the anchor is unverified; timing remains unlikely but not excluded');
              } else {
                // Fix 4: the aggregate `injected` flag is true as soon as ANY
                // round installed - it must never be read as "every round
                // installed" when most did not.
                const perRound = temporal.tried.map((t) => (t.installed ? 'installed' : 'not acknowledged')).join(', ');
                notes.push(
                  `no reproduction: the delay style was only acknowledged on some rounds (${perRound}); check ` +
                    'that the inject wrapper runs on every path exercised by the reruns before trusting this as a negative timing verdict',
                );
              }
            }
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
  anchorBefore = withHtmlSnippet(treeNode, baseline.html, 'before (baseline)', notes);
  if (classification.match?.path) {
    anchorAfter = withHtmlSnippet(nodeAt(current.tree, classification.match.path), current.html, 'after (current)', notes);
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
