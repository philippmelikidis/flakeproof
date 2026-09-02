// Runs the user's test suite exactly once and renders both report formats
// from that single run: a markdown summary for the pull request comment and
// a self-contained html page for the uploaded artifact. Running the suite
// only once matters here more than almost anywhere else in this project -
// flakeproof exists because reruns can disagree, so triaging two separate
// runs against each other under the hood would undermine the exact thing
// the gate is supposed to report honestly.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { runSuite } from '../../src/runner/index.js';
import { renderSummaryMarkdown, renderSummaryHtml } from '../../src/report-summary.js';
import { resolveInputs } from './resolve-inputs.js';

// A distinct type for "the gate is misconfigured" (bad inputs, no baseline)
// as opposed to "flakeproof ran and could not reach a verdict". The two must
// not share an exit code: a missing baseline is not a triage opinion the
// "blocking" input is meant to soften, it is a broken gate that the action
// always surfaces, in every mode.
export class SetupError extends Error {}

export function summarize(run) {
  if (run.blind) return { blind: true, failures: 0, verdictCounts: {}, oneLine: 'flakeproof could not determine which tests failed.' };
  if (run.failures === 0) return { blind: false, failures: 0, verdictCounts: {}, oneLine: 'No failed tests to triage.' };
  const verdictCounts = {};
  for (const r of run.results) verdictCounts[r.triage.verdict] = (verdictCounts[r.triage.verdict] ?? 0) + 1;
  const parts = Object.entries(verdictCounts).map(([v, n]) => `${n} ${v}`);
  return { blind: false, failures: run.failures, verdictCounts, oneLine: `${run.failures} failed test(s) triaged: ${parts.join(', ')}` };
}

export async function runAndReport({ cwd, summaryPath, htmlPath }) {
  const config = await loadConfig(cwd);
  const inputs = {
    testCommand: process.env.INPUT_TEST_COMMAND ?? '',
    appUrl: process.env.INPUT_APP_URL ?? '',
    resultsPath: process.env.INPUT_RESULTS_PATH ?? '',
    reader: process.env.INPUT_READER ?? '',
    baselinePath: process.env.INPUT_BASELINE_PATH ?? '',
  };
  const resolved = resolveInputs({ inputs, config, cwd });
  if (resolved.problems.length) {
    throw new SetupError(resolved.problems.join('; '));
  }
  if (!existsSync(resolved.baselinePath)) {
    // Same actionable message the CLI gives for the identical situation
    // (bin/flakeproof.js "run"): never invent a baseline, fail plainly.
    throw new SetupError(
      `no baseline at ${resolved.baselinePath}. Record one first while the build is green, either committed to the ` +
        `repo or restored from a prior CI artifact via the "baseline-artifact-name" input: ` +
        `node bin/flakeproof.js baseline ${resolved.url} --out ${resolved.baselinePath}`,
    );
  }

  const run = await runSuite({
    cmd: resolved.cmd,
    url: resolved.url,
    baselinePath: resolved.baselinePath,
    resultsPath: resolved.resultsPath,
    reader: resolved.reader,
    cwd,
  });

  const markdown = renderSummaryMarkdown(run);
  const html = renderSummaryHtml(run);
  await mkdir(dirname(resolvePath(summaryPath)), { recursive: true });
  await mkdir(dirname(resolvePath(htmlPath)), { recursive: true });
  await writeFile(summaryPath, markdown, 'utf8');
  await writeFile(htmlPath, html, 'utf8');

  return { run, summary: summarize(run), markdown, html };
}

async function main() {
  const cwd = process.env.FLAKEPROOF_WORKDIR ? resolvePath(process.env.FLAKEPROOF_WORKDIR) : process.cwd();
  const summaryPath = resolvePath(process.env.FLAKEPROOF_SUMMARY_PATH ?? 'flakeproof-summary.md');
  const htmlPath = resolvePath(process.env.FLAKEPROOF_HTML_PATH ?? 'flakeproof-report.html');

  const { run, summary } = await runAndReport({ cwd, summaryPath, htmlPath });

  // Mirrors bin/flakeproof.js's own "run" exit-code policy exactly (exit 1
  // only when flakeproof could not tell which tests failed at all). Whether
  // that exit code fails the job is the composite action's "blocking" input,
  // handled by the calling step, not here - this script only ever reports
  // what happened, honestly, at its own exit code.
  const exitCode = run.blind ? 1 : 0;

  const outputPath = process.env.GITHUB_OUTPUT;
  const lines = [
    `summary=${summary.oneLine}`,
    `exit-code=${exitCode}`,
    `blind=${summary.blind}`,
    `failures=${summary.failures}`,
    `verdict-counts=${JSON.stringify(summary.verdictCounts)}`,
  ];
  if (outputPath) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(outputPath, lines.map((l) => l + '\n').join(''));
  } else {
    console.log(lines.join('\n'));
  }
  console.log(summary.oneLine);
  process.exitCode = exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    // 2 = gate misconfiguration (bad inputs, missing baseline): always an
    // error, in every "blocking" mode. 1 = an unexpected crash; runSuite is
    // designed to turn ordinary failure modes into a "blind" result instead
    // of throwing, so reaching this branch at all is itself a bug report.
    process.exit(err instanceof SetupError ? 2 : 1);
  });
}
