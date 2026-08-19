#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { captureSnapshot } from '../src/snapshot.js';
import { triage } from '../src/triage/engine.js';
import { renderReport } from '../src/report.js';

const USAGE = `usage:
  flakeproof snapshot <url> [--anchor <selector>] --out <file.json>
  flakeproof triage --baseline <file.json> (--error-file <file> | --robot-xml <output.xml>)
                    (--current-url <url> | --current <file.json>)
                    [--rerun-cmd <command>] [--reruns <n>] [--json] [--out <file.md>]`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);

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
        json: { type: 'boolean', default: false },
        out: { type: 'string' },
      },
    });
    if (!values.baseline || (!values['error-file'] && !values['robot-xml'])) throw new Error(USAGE);
    const result = await triage({
      errorText: values['error-file'] ? await readFile(values['error-file'], 'utf8') : undefined,
      robotOutputXml: values['robot-xml'],
      baselinePath: values.baseline,
      currentUrl: values['current-url'],
      currentPath: values.current,
      rerunCommand: values['rerun-cmd'],
      reruns: values.reruns ? Number(values.reruns) : undefined,
    });
    const output = values.json ? JSON.stringify(result, null, 2) : renderReport(result);
    if (values.out) {
      await writeFile(values.out, output, 'utf8');
      console.log(`triage report written to ${values.out}`);
    } else {
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
