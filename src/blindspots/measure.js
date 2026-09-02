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
// claim otherwise.
function summarize(records) {
  const applied = records.filter((r) => r.applied === true);
  const notApplied = records.filter((r) => r.applied !== true);
  const notSurvived = applied.filter((r) => r.survived === false);
  const judgeable = applied.filter((r) => r.survived !== false);
  const noticed = judgeable.filter((r) => r.noticed === true);
  const unnoticed = judgeable.filter((r) => r.noticed === false);
  const inconclusive = judgeable.filter((r) => r.noticed !== true && r.noticed !== false);
  return {
    attempted: records.length,
    applied: applied.length,
    notApplied: notApplied.length,
    notSurvived: notSurvived.length,
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
    const errored = attempts.find((a) => typeof a.ack.error === 'string');
    return {
      ...base,
      applied: false,
      // Distinguishes "no such element on this page" (never-found) from
      // "the element appeared but this mutation could not touch it, e.g.
      // change-href on a link with no href" (found-not-applicable) from a
      // version mismatch between flakeproof and its own inject wrapper
      // (unknown-mutation-id) - each needs a different fix, and folding them
      // into one generic "check your selectors" message sends the user
      // chasing the wrong problem (Fix 6 in the review).
      applyReason: errored ? 'unknown-mutation-id' : everFound ? 'found-not-applicable' : 'never-found',
      found: everFound,
      survived: null,
      frame: null,
      noticed: null,
      inconclusiveReason: null,
      redTests: [],
    };
  }

  const survivedFlags = attempts.map((a) => a.ack.survived);
  const frame = attempts.map((a) => a.ack.frame).find((f) => typeof f === 'string') ?? null;

  if (survivedFlags.every((s) => s === false)) {
    // The mutation applied on every run, but by the time the wrapper
    // re-checked after the page settled, it was gone on every run too - an
    // ordinary re-render (hydration, client-side i18n) silently undid it
    // before the suite ever got a fair look. This is its own category,
    // never folded into "unnoticed": the suite was never actually tested
    // against this change (Fix 3 in the review).
    return { ...base, applied: true, applyReason: null, found: true, survived: false, frame, noticed: null, inconclusiveReason: null, redTests: [] };
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
    survived: survivedFlags.every((s) => s === true) ? true : null,
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
  if (reader === 'robot') {
    // Rejected upfront, before a single process spawns: there is no Robot
    // Framework injection wrapper yet (see issue #11), so running the
    // control pass at all would waste the user's time on a measurement that
    // can never produce a real ack. Fix 6 in the review.
    throw new Error(
      'blindspots does not support the robot reader yet: no Robot Framework injection wrapper exists (see issue #11); use --reader playwright',
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
            abstained: ack.unreadable ? 'results-unreadable' : 'wrapper-not-installed',
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

      records.push(buildRecord(selector, mutation, attempts));
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
        reason: 'none of the attempted mutations actually applied; check the selectors',
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
      // judged (Fix 1 and Fix 3 in the review).
      const allInconclusive = counts.inconclusive === counts.applied;
      const allNotSurvived = counts.notSurvived === counts.applied;
      const abstained = allInconclusive ? 'all-inconclusive' : allNotSurvived ? 'all-not-survived' : 'no-observations';
      return { abstained, reason: null, control, wrapperInstalled: true, records, counts, skipped, notes };
    }

    return { abstained: null, reason: null, control, wrapperInstalled: true, records, counts, skipped, notes };
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}
