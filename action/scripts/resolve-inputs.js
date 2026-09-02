// Turns the action's raw string inputs (everything from action.yml arrives
// as a string, including "" for "not set") plus flakeproof.config.json into
// the concrete values run-and-report.js needs. Kept as a pure function so it
// can be unit-tested without a GitHub Actions runtime: resolveInputs() takes
// plain objects in and returns a plain object out, no filesystem or env
// access here. The thin CLI wrapper at the bottom does the I/O.
import { dirname, resolve as resolvePath } from 'node:path';
import { loadConfig, DEFAULT_BASELINE } from '../../src/config.js';

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function resolveInputs({ inputs, config, cwd = process.cwd() }) {
  const cmd = firstNonEmpty(inputs.testCommand, config.cmd);
  const url = firstNonEmpty(inputs.appUrl, config.url);
  const results = firstNonEmpty(inputs.resultsPath, config.results, 'results.json');
  const reader = firstNonEmpty(inputs.reader, config.reader, 'playwright');
  const baselineRel = firstNonEmpty(inputs.baselinePath, config.baseline, DEFAULT_BASELINE);
  const baselinePath = resolvePath(cwd, baselineRel);
  const baselineDir = dirname(baselinePath);

  const problems = [];
  if (!cmd) problems.push('no test command: set the "test-command" input or "cmd" in flakeproof.config.json');
  if (!url) problems.push('no app url: set the "app-url" input or "url" in flakeproof.config.json');
  if (!['playwright', 'robot'].includes(reader)) problems.push(`unknown reader "${reader}", expected playwright or robot`);

  return {
    cmd,
    url,
    resultsPath: resolvePath(cwd, results),
    reader,
    baselinePath,
    baselineDir,
    problems,
  };
}

async function main() {
  const cwd = process.env.FLAKEPROOF_WORKDIR ? resolvePath(process.env.FLAKEPROOF_WORKDIR) : process.cwd();
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
    for (const p of resolved.problems) console.error(`flakeproof action: ${p}`);
    process.exit(1);
  }

  const outputPath = process.env.GITHUB_OUTPUT;
  const lines = [
    `cmd=${resolved.cmd}`,
    `url=${resolved.url}`,
    `results-path=${resolved.resultsPath}`,
    `reader=${resolved.reader}`,
    `baseline-path=${resolved.baselinePath}`,
    `baseline-dir=${resolved.baselineDir}`,
  ];
  if (outputPath) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(outputPath, lines.map((l) => l + '\n').join(''));
  } else {
    console.log(lines.join('\n'));
  }
}

// Only run the CLI entry point when this file is executed directly, not
// when it is imported for its resolveInputs() export (by tests, or by
// run-and-report.js, which needs the exact same resolution logic).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
