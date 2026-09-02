// Measures whether the user's own suite notices deliberate, meaningful
// changes to the page under test - the second half of flakeproof's original
// idea (see docs/superpowers/specs/2026-08-18-e2e-triage-gate-design.md):
// triage answers "is this red test a real bug or a fragile test", this
// answers "does the suite notice anything at all".
//
// One experiment = one (selector, mutation) pair from the semantic catalog
// (src/probe/catalogs/semantic.js). For each: run the suite once with that
// mutation injected via the shared wrapper (src/inject/playwright.js,
// FLAKEPROOF_MUTATION_*), read the wrapper's ack for whether the mutation
// actually applied, and read the suite's own result file for whether it
// went red. Every number in the aggregate is traceable to one of those two
// observations - never guessed.
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

// Runs the suite once and reads its result file with the given reader.
// `resultsPath` is removed first so a stale file from a previous round can
// never be read as this round's outcome - the same discipline
// temporalProbe applies to the ack path between delay rounds.
async function runAndRead(cmd, { cwd, reader, resultsPath, env } = {}) {
  const read = READERS[reader];
  if (!read) throw new Error(`unknown result reader: ${reader}`);
  await rm(resultsPath, { force: true });
  // A caller may have FLAKEPROOF_MUTATION_* exported in their shell while
  // debugging by hand; a control round (no `env` mutation keys) must never
  // inherit them, the same guard rerunStats applies to the temporal vars.
  const childEnv = { ...(env ?? {}) };
  const run = await runTests(cmd, { cwd, env: childEnv });
  let failures = [];
  let unreadable = false;
  try {
    failures = await read(resultsPath);
  } catch {
    unreadable = true;
  }
  return { exitCode: run.exitCode, failures, unreadable };
}

function summarize(records) {
  const applied = records.filter((r) => r.applied === true);
  const notApplied = records.filter((r) => r.applied !== true);
  const noticed = applied.filter((r) => r.noticed === true);
  const unnoticed = applied.filter((r) => r.noticed === false);
  const inconclusive = applied.filter((r) => r.noticed !== true && r.noticed !== false);
  return {
    attempted: records.length,
    applied: applied.length,
    notApplied: notApplied.length,
    noticed: noticed.length,
    unnoticed: unnoticed.length,
    inconclusive: inconclusive.length,
  };
}

// `opts`:
//   cmd          shell command that runs the wrapped suite (required)
//   cwd          working directory for that command
//   reader       'playwright' | 'robot' (required)
//   resultsPath  where the reader looks for the suite's result file (required)
//   selectors    css selectors to target, user-supplied (required, >= 1)
//   mutations    subset of semantic catalog ids to try (default: all of them)
//
// Returns `{ abstained, reason, control, wrapperInstalled, records, counts }`.
// `abstained` is `null` on a real measurement, or a short machine-readable
// reason ('control-red' | 'wrapper-not-installed' | 'results-unreadable' |
// 'no-mutations-applied') when the honesty rules refuse a score. `records`
// is always populated with whatever was actually observed before an
// abstention, even when empty.
export async function measureBlindspots(opts) {
  const { cmd, cwd, reader, resultsPath, selectors, mutations } = opts;
  if (!cmd) throw new Error('measureBlindspots needs a test command');
  if (!reader || !READERS[reader]) throw new Error(`measureBlindspots needs a known reader, got "${reader}"`);
  if (!resultsPath) throw new Error('measureBlindspots needs a resultsPath');
  if (!selectors || selectors.length === 0) throw new Error('measureBlindspots needs at least one selector');

  const mutationIds = mutations && mutations.length ? mutations : semanticMutations.map((m) => m.id);
  const targets = [];
  for (const selector of selectors) {
    for (const id of mutationIds) {
      const mutation = semanticMutations.find((m) => m.id === id);
      if (!mutation) throw new Error(`unknown mutation id: ${id}`);
      targets.push({ selector, mutation });
    }
  }

  // Control pass: the suite must be green before any mutation is judged by
  // it, exactly like temporalProbe's control round. A suite that is already
  // red cannot have anything attributed to a mutation it never got a fair
  // chance against.
  const control = await runAndRead(cmd, { cwd, reader, resultsPath });
  if (control.unreadable) {
    return { abstained: 'results-unreadable', reason: `could not read the control run's results at ${resultsPath}`, control, wrapperInstalled: null, records: [], counts: null };
  }
  if (control.failures.length > 0) {
    return {
      abstained: 'control-red',
      reason: 'the suite is already red without any mutation; nothing can be attributed to a blindspot',
      control,
      wrapperInstalled: null,
      records: [],
      counts: null,
    };
  }

  const scratchDir = await mkdtemp(join(tmpdir(), 'fp-blindspots-'));
  const ackPath = join(scratchDir, 'ack');
  try {
    const records = [];
    for (const { selector, mutation } of targets) {
      await rm(ackPath, { recursive: true, force: true });
      const run = await runAndRead(cmd, {
        cwd,
        reader,
        resultsPath,
        env: {
          FLAKEPROOF_MUTATION_ID: mutation.id,
          FLAKEPROOF_MUTATION_SELECTOR: selector,
          FLAKEPROOF_MUTATION_ACK: ackPath,
        },
      });
      const ack = await readMutationAck(ackPath);

      if (ack.installed !== true) {
        // The wrapper never acknowledged this round at all: either it is
        // not installed in the suite, or the ack could not be read. Either
        // way a green suite here proves nothing - abstain rather than
        // print a score that looks like "the suite noticed nothing" when
        // really flakeproof never reached the page.
        return {
          abstained: ack.unreadable ? 'results-unreadable' : 'wrapper-not-installed',
          reason: ack.unreadable
            ? 'the mutation acknowledgment could not be read; this is a filesystem problem, not proof the wrapper is missing'
            : 'the inject wrapper never acknowledged this run; install withTemporal from flakeproof/inject in the suite before measuring blindspots',
          control,
          wrapperInstalled: ack.installed === false ? false : null,
          records,
          counts: null,
        };
      }

      records.push({
        id: mutation.id,
        description: mutation.description,
        target: selector,
        applied: ack.applied === true,
        noticed: run.unreadable ? null : run.failures.length > 0,
        redTests: run.failures.map((f) => f.testId),
      });
    }

    const counts = summarize(records);
    if (counts.applied === 0) {
      return {
        abstained: 'no-mutations-applied',
        reason: 'none of the attempted mutations actually applied; check the selectors',
        control,
        wrapperInstalled: true,
        records,
        counts,
      };
    }

    return { abstained: null, reason: null, control, wrapperInstalled: true, records, counts };
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}
