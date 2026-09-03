#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { captureSnapshot } from '../src/snapshot.js';
import { triage } from '../src/triage/engine.js';
import { renderReport } from '../src/report.js';
import { renderHtmlReport } from '../src/report-html.js';
import { loadConfig, DEFAULT_BASELINE } from '../src/config.js';
import { runSuite, READERS } from '../src/runner/index.js';
import { renderSummaryMarkdown, renderSummaryHtml } from '../src/report-summary.js';
import { measureBlindspots } from '../src/blindspots/measure.js';
import { renderBlindspotsMarkdown, renderBlindspotsHtml } from '../src/blindspots/report.js';

const USAGE = `usage:
  flakeproof snapshot <url> [--anchor <selector>] --out <file.json>
  flakeproof triage --baseline <file.json> (--error-file <file> | --robot-xml <output.xml>)
                    (--current-url <url> | --current <file.json>)
                    [--rerun-cmd <command>] [--reruns <n>] [--temporal] [--json] [--out <file.md|file.html>] [--open]
  flakeproof baseline <url> [--out <file.json>]
  flakeproof run [--cmd <command>] [--url <url>] [--results <file>]
                 [--reader playwright|robot|cypress|selenium|puppeteer]
                 [--baseline <file.json>] [--out <file.md|file.html>]
  flakeproof blindspots [--cmd <command>] [--results <file>] [--reader playwright]
                        --selectors <sel1,sel2,...> [--mutations <id1,id2,...>]
                        [--runs <n>] [--budget <n>]
                        [--json] [--out <file.md|file.html>]`;

// `--selectors` uses a bare comma to separate distinct targets (documented
// as "sel1,sel2,..."). A comma immediately followed by whitespace is the
// classic hand-written style for a single COMPOUND css selector list, like
// ".a, .b" meaning "whichever matches first" - flakeproof cannot tell that
// intent apart from "two separate targets" from the string alone, and
// silently guessing wrong would change what the user asked for without
// telling them (Fix 8 in the review). Rejecting it outright, with a message
// that says exactly why, beats silently picking one interpretation.
function splitSelectors(raw) {
  if (/,\s+/.test(raw)) {
    throw new Error(
      `--selectors "${raw}" has a comma followed by a space, which looks like a single compound css selector rather ` +
        'than a list of separate targets - flakeproof cannot tell those apart. If you meant separate targets, remove ' +
        'the space (e.g. "sel1,sel2"); a single selector that itself needs a literal comma is not supported yet.',
    );
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'baseline') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { out: { type: 'string' } } });
    const url = positionals[0];
    if (!url) throw new Error(USAGE);
    const target = resolve(values.out ?? DEFAULT_BASELINE);
    await mkdir(dirname(target), { recursive: true });
    const snap = await captureSnapshot(url);
    await writeFile(target, JSON.stringify(snap), 'utf8');
    console.log(`baseline of ${url} written to ${target}`);
    return;
  }

  if (command === 'run') {
    const { values } = parseArgs({
      args: rest,
      options: {
        cmd: { type: 'string' }, url: { type: 'string' }, results: { type: 'string' },
        reader: { type: 'string' }, baseline: { type: 'string' }, out: { type: 'string' },
      },
    });
    const cfg = await loadConfig();
    const cmd = values.cmd ?? cfg.cmd;
    const url = values.url ?? cfg.url;
    const results = values.results ?? cfg.results ?? 'results.json';
    const reader = values.reader ?? cfg.reader ?? 'playwright';
    const baselinePath = resolve(values.baseline ?? cfg.baseline ?? DEFAULT_BASELINE);
    if (!cmd) throw new Error('run needs a test command, from --cmd or flakeproof.config.json');
    if (!url) throw new Error('run needs a url, from --url or flakeproof.config.json');
    if (!READERS[reader]) throw new Error(`unknown reader "${reader}", expected one of: ${Object.keys(READERS).join(', ')}`);
    if (!existsSync(baselinePath)) {
      throw new Error(`no baseline at ${baselinePath}. Record one first while the build is green: flakeproof baseline <url>`);
    }

    const runResult = await runSuite({ cmd, url, baselinePath, resultsPath: resolve(results), reader });
    const wantsHtml = !!values.out && /\.html?$/i.test(values.out);
    const output = wantsHtml ? renderSummaryHtml(runResult) : renderSummaryMarkdown(runResult);
    if (values.out) {
      await mkdir(dirname(resolve(values.out)), { recursive: true });
      await writeFile(values.out, output, 'utf8');
      console.log(`run report written to ${values.out}`);
    } else {
      console.log(output);
    }
    if (runResult.blind) process.exitCode = 1;
    return;
  }

  if (command === 'blindspots') {
    const { values } = parseArgs({
      args: rest,
      options: {
        cmd: { type: 'string' }, results: { type: 'string' }, reader: { type: 'string' },
        selectors: { type: 'string' }, mutations: { type: 'string' },
        runs: { type: 'string' }, budget: { type: 'string' },
        json: { type: 'boolean', default: false }, out: { type: 'string' },
      },
    });
    const cfg = await loadConfig();
    const bsCfg = cfg.blindspots ?? {};
    const cmd = values.cmd ?? cfg.cmd;
    const results = values.results ?? cfg.results ?? 'results.json';
    const reader = values.reader ?? cfg.reader ?? 'playwright';
    const selectorsRaw = values.selectors ?? (Array.isArray(bsCfg.selectors) ? bsCfg.selectors.join(',') : bsCfg.selectors);
    const selectors = selectorsRaw ? splitSelectors(selectorsRaw) : undefined;
    const mutationsRaw = values.mutations ?? (Array.isArray(bsCfg.mutations) ? bsCfg.mutations.join(',') : bsCfg.mutations);
    const mutations = mutationsRaw ? mutationsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const runsPerRound = Number(values.runs ?? bsCfg.runs ?? 2);
    const budgetRaw = values.budget ?? bsCfg.budget;
    const budget = budgetRaw === undefined ? undefined : Number(budgetRaw);
    if (!cmd) throw new Error('blindspots needs a test command, from --cmd or flakeproof.config.json');
    if (!READERS[reader]) throw new Error(`unknown reader "${reader}", expected one of: ${Object.keys(READERS).join(', ')}`);
    if (!selectors || selectors.length === 0) {
      throw new Error('blindspots needs at least one selector, from --selectors or flakeproof.config.json (blindspots.selectors)');
    }

    const result = await measureBlindspots({ cmd, reader, resultsPath: resolve(results), selectors, mutations, runsPerRound, budget });
    const wantsHtml = !!values.out && /\.html?$/i.test(values.out);
    const output = values.json
      ? JSON.stringify(result, null, 2)
      : wantsHtml
        ? renderBlindspotsHtml(result)
        : renderBlindspotsMarkdown(result);
    if (values.out) {
      await mkdir(dirname(resolve(values.out)), { recursive: true });
      await writeFile(values.out, output, 'utf8');
      console.log(`blindspots report written to ${values.out}`);
    } else {
      console.log(output);
    }
    if (result.abstained) process.exitCode = 1;
    return;
  }

  if (command === 'snapshot') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { anchor: { type: 'string' }, out: { type: 'string' } },
    });
    const url = positionals[0];
    if (!url || !values.out) throw new Error(USAGE);
    const snap = await captureSnapshot(url, { anchorSelector: values.anchor ?? null });
    await writeFile(values.out, JSON.stringify(snap), 'utf8');
    console.log(`snapshot of ${url} written to ${values.out}`);
    return;
  }

  if (command === 'triage') {
    const { values } = parseArgs({
      args: rest,
      options: {
        baseline: { type: 'string' },
        'error-file': { type: 'string' },
        'robot-xml': { type: 'string' },
        'current-url': { type: 'string' },
        current: { type: 'string' },
        'rerun-cmd': { type: 'string' },
        reruns: { type: 'string' },
        temporal: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        out: { type: 'string' },
        open: { type: 'boolean', default: false },
      },
    });
    const currentSources = [values['current-url'], values.current].filter(Boolean).length;
    if (!values.baseline || (!values['error-file'] && !values['robot-xml']) || currentSources !== 1) throw new Error(USAGE);
    const result = await triage({
      errorText: values['error-file'] ? await readFile(values['error-file'], 'utf8') : undefined,
      robotOutputXml: values['robot-xml'],
      baselinePath: values.baseline,
      currentUrl: values['current-url'],
      currentPath: values.current,
      rerunCommand: values['rerun-cmd'],
      reruns: values.reruns ? Number(values.reruns) : undefined,
      temporal: values.temporal,
    });
    const wantsHtml = !!values.out && /\.html?$/i.test(values.out);
    const output = values.json
      ? JSON.stringify(result, null, 2)
      : wantsHtml
        ? renderHtmlReport(result)
        : renderReport(result);
    if (values.out) {
      await writeFile(values.out, output, 'utf8');
      console.log(`triage report written to ${values.out}`);
      if (values.open) {
        // Opening the report is a convenience. If no opener exists (minimal
        // images, CI), the report is still written, so warn and carry on
        // rather than failing a run that produced a verdict.
        const child =
          process.platform === 'win32'
            ? spawn('cmd', ['/c', 'start', '', values.out], { stdio: 'ignore', detached: true })
            : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [values.out], { stdio: 'ignore', detached: true });
        child.on('error', () => console.error(`could not open ${values.out} automatically`));
        child.unref();
      }
    } else {
      if (values.open) console.error('--open needs --out');
      console.log(output);
    }
    return;
  }

  throw new Error(USAGE);
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
