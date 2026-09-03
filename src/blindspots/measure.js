// Measures whether the user's own suite notices deliberate, meaningful
// changes to the page under test - the second half of flakeproof's original
// idea (see docs/superpowers/specs/2026-08-18-e2e-triage-gate-design.md):
// triage answers "is this red test a real bug or a fragile test", this
// answers "does the suite notice anything at all".
//
// One experiment = one (selector, mutation) pair from the semantic catalog
// (src/probe/catalogs/semantic.js). For each: run the suite with that
// mutation injected via the shared wrapper (src/inject/playwright.js,
// FLAKEPROOF_MUTATION_*), read the wrapper's ack for whether the mutation
// actually applied and survived to the moment the suite ran its assertions,
// and read the suite's own result file for whether it went red. Every number
// in the aggregate is traceable to one of those observations - never
// guessed. This file was hardened against the exact failure shapes
// src/triage/temporal-probe.js was hardened against over three review
// rounds; that file's header comment and its per-round evidence handling are
// the model this one follows.
//
// Selectors are user-supplied (opts.selectors), not inferred from a
// baseline or "interesting element" heuristic: predictable input, and a
// report that can always say exactly which element (in the user's own
// words) each mutation targeted, is worth more than a clever guess that
// might target the wrong thing silently.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTests } from '../runner/run-tests.js';
import { READERS } from '../runner/index.js';
import { semanticMutations } from '../probe/catalogs/semantic.js';
import { readMutationAck } from './ack.js';

const DEFAULT_RUNS_PER_ROUND = 2;

// Every FLAKEPROOF_* env var either probe lane reads. A round in THIS lane
// must never inherit a leftover var from the OTHER lane (a temporal probe
// left running in the same shell), nor a stale mutation var from a previous,
// unrelated hand run: only the keys this call explicitly asks for are
// allowed through. This mirrors the same guard src/triage/rerun.js applies
// for the temporal lane (Fix 5 in the review: previously this comment
// claimed a guard that the code did not actually implement - `runTests`
// spreads `{ ...process.env, ...env }`, so anything left exported in the
// calling shell really was inherited).
const FOREIGN_ENV_KEYS = [
  'FLAKEPROOF_MUTATION_ID',
  'FLAKEPROOF_MUTATION_SELECTOR',
  'FLAKEPROOF_MUTATION_ACK',
  'FLAKEPROOF_TEMPORAL_SELECTOR',
  'FLAKEPROOF_TEMPORAL_MS',
  'FLAKEPROOF_TEMPORAL_ACK',
];

// Node's child_process implementation drops any env entry whose value is
// `undefined` before handing the environment to the OS, so setting a key to
// `undefined` here reliably blocks it from reaching the child even though
// `runTests` unconditionally spreads `process.env` on top of whatever this
// returns - the explicit `undefined` in the object literal wins over the
// inherited string value at the spread, and is then dropped entirely rather
// than becoming the literal string "undefined".
function isolatedEnv(env) {
  const out = { ...(env ?? {}) };
  for (const key of FOREIGN_ENV_KEYS) {
    if (!(key in out)) out[key] = undefined;
  }
  return out;
}

// Runs the suite once and reads its result file with the given reader.
// `resultsPath` is removed first so a stale file from a previous round can
// never be read as this round's outcome - the same discipline
// temporalProbe applies to the ack path between delay rounds.
async function runAndRead(cmd, { cwd, reader, resultsPath, env } = {}) {
  const read = READERS[reader];
  if (!read) throw new Error(`unknown result reader: ${reader}`);
  await rm(resultsPath, { force: true });
  const run = await runTests(cmd, { cwd, env: isolatedEnv(env) });
  let failures = [];
  let unreadable = false;
  try {
    failures = await read(resultsPath);
  } catch {
    unreadable = true;
  }
  // src/runner/index.js treats "the process exited non-zero but the result
  // file lists no failed test" as a reporter misconfiguration worth a note.
  // Here the stakes are worse than a note: a round that looks clean this way
  // is exactly what "the suite notices nothing" looks like, so a suite that
  // never actually ran its assertions must never be silently scored as a
  // green pass (Fix 4 in the review).
  const reporterMismatch = !unreadable && run.exitCode !== 0 && failures.length === 0;
  return { exitCode: run.exitCode, failures, unreadable, reporterMismatch };
}

// Every mutation that genuinely applied is excluded from the score's
// denominator unless it was also actually judged: an inconclusive round
// (Fix 1) or a round the mutation did not survive to (Fix 3) both mean zero
// observations exist for that round, and the headline sentence must never
// claim otherwise. A round whose survival could not be confirmed at all
// (`survivalUnknown`, audit Fix 4) is its own bucket too - the page's whole
// lifetime never produced a positive "still held" reading, so silence must
// not be counted as if it were one.
function summarize(records) {
  const applied = records.filter((r) => r.applied === true);
  const notApplied = records.filter((r) => r.applied !== true);
  const notSurvived = applied.filter((r) => r.survived === false);
  const survivalUnknown = applied.filter((r) => r.survivalUnknown === true);
  // Only a round positively confirmed to have survived the page's whole
  // lifetime (`survived === true`) is a real observation - `null` (unknown)
  // is excluded here too, never treated as "tested against" (audit Fix 4).
  const judgeable = applied.filter((r) => r.survived === true);
  const noticed = judgeable.filter((r) => r.noticed === true);
  const unnoticed = judgeable.filter((r) => r.noticed === false);
  const inconclusive = judgeable.filter((r) => r.noticed !== true && r.noticed !== false);
  return {
    attempted: records.length,
    applied: applied.length,
    notApplied: notApplied.length,
    notSurvived: notSurvived.length,
    survivalUnknown: survivalUnknown.length,
    judged: noticed.length + unnoticed.length,
    noticed: noticed.length,
    unnoticed: unnoticed.length,
    inconclusive: inconclusive.length,
  };
}

// Turns the `runsPerRound` attempts of one (selector, mutation) round into a
// single record. Every attempt has already been confirmed installed by the
// caller before this runs.
function buildRecord(selector, mutation, attempts) {
  const base = { id: mutation.id, description: mutation.description, target: selector };

  const appliedFlags = attempts.map((a) => a.ack.applied);
  const applied = appliedFlags.every((a) => a === true);
  if (!applied) {
    const everFound = attempts.some((a) => a.ack.found === true);
    const everConfirmedAbsent = attempts.some((a) => a.ack.found === false);
    const errored = attempts.find((a) => typeof a.ack.error === 'string');
    // Distinguishes "no such element on this page" (never-found, a
    // confirmed absence) from "the element appeared but this mutation could
    // not touch it, e.g. change-href on a link with no href"
    // (found-not-applicable) from a version mismatch between flakeproof and
    // its own inject wrapper (unknown-mutation-id) from "the page never
    // reported back at all" (unknown - not a confirmed absence, audit
    // Fix 4b: this used to be folded into never-found, which states a
    // confirmed absence the wrapper never actually established) - each
    // needs a different fix, and folding them into one generic "check your
    // selectors" message sends the user chasing the wrong problem (Fix 6 in
    // the earlier review).
    let applyReason;
    if (errored) applyReason = 'unknown-mutation-id';
    else if (everFound) applyReason = 'found-not-applicable';
    else if (everConfirmedAbsent) applyReason = 'never-found';
    else applyReason = 'unknown';

    // The run outcome for a not-applied round used to be thrown away
    // entirely (`redTests: []` unconditionally). That discarded the tool's
    // own counter-evidence: a round where the mutation definitely never
    // touched the page going red anyway is direct proof that the redness
    // has nothing to do with any mutation - a constant unrelated cause (a
    // backend that went down, the injection itself breaking the suite)
    // makes every round red regardless of what was mutated. That proof must
    // survive into the record so the caller can refuse to score anything as
    // "noticed" once it exists (audit Fix 2).
    const runReds = attempts.map((a) => (a.run.unreadable || a.run.reporterMismatch ? null : a.run.failures.length > 0));
    const redWithoutApplying = runReds.some((r) => r === true);
    const redTests = redWithoutApplying
      ? [...new Set(attempts.filter((a, i) => runReds[i] === true).flatMap((a) => a.run.failures.map((f) => f.testId)))]
      : [];

    return {
      ...base,
      applied: false,
      applyReason,
      found: everFound ? true : everConfirmedAbsent ? false : null,
      survived: null,
      frame: null,
      noticed: null,
      inconclusiveReason: null,
      redTests,
      redWithoutApplying,
    };
  }

  const survivedFlags = attempts.map((a) => a.ack.survived);
  const frame = attempts.map((a) => a.ack.frame).find((f) => typeof f === 'string') ?? null;

  if (survivedFlags.some((s) => s === false)) {
    // ANY run that positively observed the mutation being reverted before
    // the suite's own assertions is definite, unretractable proof this
    // round was never fairly tested - an ordinary re-render (hydration,
    // client-side i18n) undid it before the suite could react. Every other
    // signal in this file demands unanimity to make a POSITIVE claim
    // (noticed, a shared red test); this is the one place unanimity must
    // run the other way: a second run that failed to observe the same
    // revert (a slower browser, a race that happened not to trigger it)
    // must never erase what another run directly saw (audit Fix 3 - the
    // previous version required EVERY run to agree it reverted via
    // `.every`, so one run's silence overrode another run's positive
    // observation).
    return { ...base, applied: true, applyReason: null, found: true, survived: false, frame, noticed: null, inconclusiveReason: null, redTests: [] };
  }

  if (!survivedFlags.every((s) => s === true)) {
    // Nothing positively confirmed the mutation held for the page's whole
    // lifetime - some run's survival is simply unknown (for example the
    // page closed before the wrapper could report a final state; the
    // flagship "asserts nothing meaningful" fixture hits exactly this on a
    // real run). Silence must never read as confirmation: this is its own
    // category, excluded from the score, never folded into "unnoticed"
    // (audit Fix 4).
    return { ...base, applied: true, applyReason: null, found: true, survived: null, frame, noticed: null, inconclusiveReason: null, survivalUnknown: true, redTests: [] };
  }

  // A reporter-mismatch run cannot be trusted either way; its "noticed"
  // reading is unknown, never a confirmed green (Fix 4).
  const noticedFlags = attempts.map((a) => (a.run.unreadable || a.run.reporterMismatch ? null : a.run.failures.length > 0));
  const allKnown = noticedFlags.every((n) => n !== null);
  const allRed = allKnown && noticedFlags.every((n) => n === true);
  const allGreen = allKnown && noticedFlags.every((n) => n === false);

  let noticed = null;
  let inconclusiveReason = null;
  let redTests = [];
  if (allRed) {
    noticed = true;
    // Only name a test as the catcher when it was red on every single run -
    // two coin flips must never fake a shared cause (Fix 2 in the review,
    // the same discipline temporalProbe applies to its delay rounds).
    const failureSets = attempts.map((a) => new Set(a.run.failures.map((f) => f.testId)));
    redTests = [...failureSets[0]].filter((id) => failureSets.every((s) => s.has(id)));
  } else if (allGreen) {
    noticed = false;
  } else if (!allKnown) {
    inconclusiveReason = attempts.some((a) => a.run.reporterMismatch) ? 'reporter-mismatch' : 'results-unreadable';
  } else {
    // The runs disagreed (red on some, green on others) with no reporter
    // problem to explain it: the suite itself is unstable under this
    // mutation, so nothing can be attributed to it either way - the same
    // reasoning that keeps an unrelated flake from fabricating a perfect
    // score (Fix 2).
    inconclusiveReason = 'unstable-across-runs';
  }

  return {
    ...base,
    applied: true,
    applyReason: null,
    found: true,
    survived: true,
    frame,
    noticed,
    inconclusiveReason,
    redTests,
  };
}

const WRAPPER_NOT_INSTALLED_REASON =
  'the inject wrapper never acknowledged this run; install withTemporal from flakeproof/inject in the suite before measuring blindspots';

// `opts`:
//   cmd          shell command that runs the wrapped suite (required)
//   cwd          working directory for that command
//   reader       'playwright' (required; 'robot' is rejected, see below)
//   resultsPath  where the reader looks for the suite's result file (required)
//   selectors    css selectors to target, user-supplied (required, >= 1)
//   mutations    subset of semantic catalog ids to try (default: all of them)
//   runsPerRound how many times to run the control and each mutation round
//                (default 2). A round only counts as noticed when the suite
//                is red on EVERY run, and control/round runs use the same
//                count, so a suite that is merely flaky for unrelated
//                reasons cannot fabricate a perfect score (Fix 2).
//   budget       maximum number of suite invocations to spend in total
//                (default: unlimited). When the budget cannot cover even the
//                control pass, or runs out partway through the mutation
//                list, the shortfall is reported rather than silently
//                truncating the work (Fix 7).
//
// Returns `{ abstained, reason, control, wrapperInstalled, records, counts,
// skipped, notes }`. `abstained` is `null` on a real measurement, or a short
// machine-readable reason when the honesty rules refuse a score. `records`
// is always populated with whatever was actually observed before an
// abstention, even when empty.
export async function measureBlindspots(opts) {
  const { cmd, cwd, reader, resultsPath, selectors, mutations } = opts;
  if (!cmd) throw new Error('measureBlindspots needs a test command');
  if (!reader || !READERS[reader]) throw new Error(`measureBlindspots needs a known reader, got "${reader}"`);
  if (reader !== 'playwright') {
    // Rejected upfront, before a single process spawns: only the Playwright
    // wrapper (src/inject/playwright.js) understands FLAKEPROOF_MUTATION_*,
    // so running the control pass at all would waste the user's time on a
    // measurement that can never produce a real ack. Robot Framework has no
    // injection wrapper at all (issue #11 covers its temporal lane only);
    // Cypress, Selenium and Puppeteer got a temporal injection point (issue
    // #13) but not a semantic-mutation one, so blindspots stays
    // playwright-only for now. Fix 6 in the review.
    const seeIssue = reader === 'robot' ? ' (see issue #11)' : '';
    throw new Error(
      `blindspots does not support the ${reader} reader yet: only the playwright reader has a mutation injection wrapper${seeIssue}; use --reader playwright`,
    );
  }
  if (!resultsPath) throw new Error('measureBlindspots needs a resultsPath');
  if (!selectors || selectors.length === 0) throw new Error('measureBlindspots needs at least one selector');
  const runsPerRound = opts.runsPerRound ?? DEFAULT_RUNS_PER_ROUND;
  if (!Number.isInteger(runsPerRound) || runsPerRound < 1) {
    throw new Error(`measureBlindspots needs runsPerRound to be a positive integer, got ${runsPerRound}`);
  }
  const budget = Number.isFinite(opts.budget) ? opts.budget : Infinity;
  if (budget < 1) throw new Error('measureBlindspots needs a budget of at least 1 suite run');

  const mutationIds = mutations && mutations.length ? mutations : semanticMutations.map((m) => m.id);
  const targets = [];
  for (const selector of selectors) {
    for (const id of mutationIds) {
      const mutation = semanticMutations.find((m) => m.id === id);
      if (!mutation) throw new Error(`unknown mutation id: ${id}`);
      targets.push({ selector, mutation });
    }
  }

  let used = 0;
  const canAfford = (n) => used + n <= budget;

  if (!canAfford(runsPerRound)) {
    return {
      abstained: 'budget-too-low',
      reason: `the run budget (${budget}) is smaller than runsPerRound (${runsPerRound}); not even the control could be measured honestly`,
      control: null,
      wrapperInstalled: null,
      records: [],
      counts: null,
      skipped: targets.map((t) => ({ target: t.selector, mutation: t.mutation.id, description: t.mutation.description })),
      notes: [],
    };
  }

  // Control pass: the suite must be green on EVERY run before any mutation
  // is judged by it, run the same number of times as every mutation round
  // (Fix 2) so an unrelated flake in the suite cannot be mistaken for a
  // clean baseline, and free of any reporter/exit-code disagreement
  // (Fix 4).
  const controlAttempts = [];
  for (let i = 0; i < runsPerRound; i += 1) {
    controlAttempts.push(await runAndRead(cmd, { cwd, reader, resultsPath }));
    used += 1;
  }
  const control = { runs: runsPerRound, attempts: controlAttempts };

  if (controlAttempts.some((a) => a.unreadable)) {
    return {
      abstained: 'results-unreadable',
      reason: `could not read the control run's results at ${resultsPath}`,
      control,
      wrapperInstalled: null,
      records: [],
      counts: null,
      skipped: [],
      notes: [],
    };
  }
  if (controlAttempts.some((a) => a.failures.length > 0)) {
    return {
      abstained: 'control-red',
      reason: 'the suite is not reliably green without any mutation (at least one control run failed); nothing can be attributed to a blind spot',
      control,
      wrapperInstalled: null,
      records: [],
      counts: null,
      skipped: [],
      notes: [],
    };
  }
  if (controlAttempts.some((a) => a.reporterMismatch)) {
    return {
      abstained: 'control-unreliable',
      reason:
        'a control run exited with a failure code while its result file listed no failed test; check the reporter configuration before trusting any score',
      control,
      wrapperInstalled: null,
      records: [],
      counts: null,
      skipped: [],
      notes: [],
    };
  }

  const scratchDir = await mkdtemp(join(tmpdir(), 'fp-blindspots-'));
  const ackPath = join(scratchDir, 'ack');
  try {
    const records = [];
    const skipped = [];
    for (let i = 0; i < targets.length; i += 1) {
      const { selector, mutation } = targets[i];
      if (!canAfford(runsPerRound)) {
        skipped.push(...targets.slice(i).map((t) => ({ target: t.selector, mutation: t.mutation.id, description: t.mutation.description })));
        break;
      }

      const attempts = [];
      let abort = null;
      for (let run = 0; run < runsPerRound; run += 1) {
        await rm(ackPath, { recursive: true, force: true });
        const result = await runAndRead(cmd, {
          cwd,
          reader,
          resultsPath,
          env: {
            FLAKEPROOF_MUTATION_ID: mutation.id,
            FLAKEPROOF_MUTATION_SELECTOR: selector,
            FLAKEPROOF_MUTATION_ACK: ackPath,
          },
        });
        used += 1;
        const ack = await readMutationAck(ackPath);
        if (ack.installed !== true) {
          // The wrapper never acknowledged this run at all: either it is not
          // installed in the suite, or the ack could not be read. Either way
          // a green suite here proves nothing, and every later round would
          // hit the exact same problem - abstain now rather than burn the
          // rest of the budget re-discovering it (Fix 7 and honesty both
          // point the same way).
          abort = {
            // A file at the ACK path that could not be read is a filesystem
            // problem, not the same thing as an unreadable TEST RESULT file
            // (the `results-unreadable` abstention used above for the
            // control pass) - reusing that key here let the renderer's
            // generic "check the reporter configuration" text win over the
            // real, more specific reason this file already builds below,
            // sending the user to fix the wrong thing entirely (audit
            // Fix 4c). This has its own key so its own text can be shown.
            abstained: ack.unreadable ? 'mutation-ack-unreadable' : 'wrapper-not-installed',
            reason: ack.unreadable
              ? 'the mutation acknowledgment could not be read; this is a filesystem problem, not proof the wrapper is missing'
              : WRAPPER_NOT_INSTALLED_REASON,
            control,
            wrapperInstalled: ack.installed === false ? false : null,
            records,
            counts: null,
            skipped,
            notes: [],
          };
          break;
        }
        attempts.push({ run: result, ack });
      }
      if (abort) return abort;

      const record = buildRecord(selector, mutation, attempts);
      records.push(record);

      if (record.redWithoutApplying) {
        // A round where the mutation definitely never touched the page
        // still went red: proof that whatever is causing the redness has
        // nothing to do with any mutation (a backend dependency going down,
        // the injection wrapper itself breaking the suite, an unrelated
        // regression). Once this exists, no round anywhere in this
        // measurement may be scored "noticed" - every other red round is
        // equally suspect, and the score sentence would be a guess, not a
        // fact. Stop spending the rest of the budget on a suite that is
        // already known to be red for a reason no mutation caused (audit
        // Fix 2).
        const remaining = targets.slice(i + 1).map((t) => ({ target: t.selector, mutation: t.mutation.id, description: t.mutation.description }));
        skipped.push(...remaining);
        return {
          abstained: 'red-unrelated-to-mutations',
          reason:
            `the suite went red on \`${record.target}\` / ${record.id} even though that mutation never touched the page` +
            (record.redTests.length ? ` (red test(s): ${record.redTests.join(', ')})` : '') +
            '; something other than the injected mutations is causing failures (a backend dependency, an unrelated regression, or the mutation wrapper itself breaking the suite). No score can be trusted until the suite is reliably green whenever a mutation does not touch the page.',
          control,
          wrapperInstalled: true,
          records,
          counts: summarize(records),
          skipped,
          notes: [],
        };
      }
    }

    const counts = summarize(records);
    const notes = [];
    if (skipped.length) {
      notes.push(
        `the run budget (${budget}) was reached; ${skipped.length} of ${targets.length} experiment(s) were skipped: ` +
          skipped.map((s) => `${s.target} / ${s.mutation}`).join(', '),
      );
    }

    if (counts.applied === 0) {
      return {
        abstained: 'no-mutations-applied',
        reason: 'none of the attempted mutations were confirmed to touch the page; see the records below for exactly why each one did not apply',
        control,
        wrapperInstalled: true,
        records,
        counts,
        skipped,
        notes,
      };
    }

    if (counts.judged === 0) {
      // Every mutation that applied produced zero usable observations.
      // Never guess a score over nothing: say exactly why nothing could be
      // judged (Fix 1, Fix 3 and Fix 4 in the review).
      const allInconclusive = counts.inconclusive === counts.applied;
      const allNotSurvived = counts.notSurvived === counts.applied;
      const allSurvivalUnknown = counts.survivalUnknown === counts.applied;
      const abstained = allInconclusive
        ? 'all-inconclusive'
        : allNotSurvived
          ? 'all-not-survived'
          : allSurvivalUnknown
            ? 'all-survival-unknown'
            : 'no-observations';
      return { abstained, reason: null, control, wrapperInstalled: true, records, counts, skipped, notes };
    }

    // Second, weaker signal for the same confound Fix 2 guards against: the
    // exact same test named as the catcher for every "noticed" mutation,
    // across structurally different mutations, can be a legitimately broad
    // assertion (a header test that genuinely reacts to text, href AND
    // removal) or a sign that the redness is not really caused by each
    // individual mutation. Unlike the not-applied proof above, this alone
    // cannot distinguish the two cases, so it is surfaced as a note for a
    // human to look at, never used to override or discard a score outright.
    const noticedRecords = records.filter((r) => r.noticed === true);
    if (noticedRecords.length > 1) {
      const catcherSets = noticedRecords.map((r) => new Set(r.redTests));
      const commonCatchers = [...catcherSets[0]].filter((t) => catcherSets.every((s) => s.has(t)));
      const distinctMutationIds = new Set(noticedRecords.map((r) => r.id));
      if (commonCatchers.length > 0 && distinctMutationIds.size > 1) {
        notes.push(
          `the same test (${commonCatchers.join(', ')}) was named as the catcher for ${distinctMutationIds.size} structurally different mutations; ` +
            'this can be a legitimately broad assertion, or a sign that the redness is not really caused by each individual mutation. Worth a manual look before trusting the noticed count.',
        );
      }
    }

    return { abstained: null, reason: null, control, wrapperInstalled: true, records, counts, skipped, notes };
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}
