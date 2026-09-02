# Auto-Runner: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Befehl faehrt die eigene Testsuite, findet die roten Tests selbst und triagiert jeden davon, statt dass man Baseline, Fehlerdatei und URL von Hand zusammenpastet (Issue #7).

**Architecture:** Ein neues Modul `src/runner.js` fuehrt den Testbefehl aus und liest die fehlgeschlagenen Tests ueber einen von zwei Ergebnis-Lesern (Playwright JSON, Robot Framework output.xml). Fuer jeden roten Test laeuft die bestehende `triage()`-Pipeline unveraendert. Ein Sammelbericht buendelt die Einzelergebnisse. Eine Konfigurationsdatei ersetzt die langen Flags.

**Tech Stack:** unveraendert, keine neuen Dependencies. Node >= 20, ESM, `node:test`, Playwright, fast-xml-parser.

## Global Constraints

- Node >= 20, `"type": "module"`, Testrunner `node:test`; **keine neuen Dependencies**
- Saemtliche Repo-Texte auf Englisch, ohne Emojis, ohne em dashes, natuerlich geschrieben; nur Spec- und Plan-Dokumente deutsch
- **Commits ohne jede KI- oder Claude-Erwaehnung**
- Kernregel: **niemals raten** — kann der Runner die Ergebnisse nicht lesen, sagt er das, statt einen leeren Lauf als Erfolg zu melden
- Tests mit Browser, Server, Subprozessen oder mkdtemp: Aufraeumen in `try/finally`, temporaere Verzeichnisse mit `rm` entfernen
- Merge-Gate: `npm test` und `npx eslint .` gruen und sauber nach jedem Task

## Verifizierte Vorbedingungen

Die JSON-Struktur des Playwright-Reporters wurde an einem echten Lauf geprueft:

- `suites[].specs[]` mit `title`, `ok`, `file`, `line`, und `tests[].results[]`
- `results[].status` (`failed` bei Fehlschlag), `results[].error.message`, zusaetzlich `results[].errors[]`
- Suites sind verschachtelt (`suites[].suites[]`), Spec-Dateien haengen an der Suite
- **Wichtig:** `error.message` enthaelt ANSI-Escapes. Ohne Strippen findet `extractAnchor` den Locator nicht.

## File Structure

```
src/runner/run-tests.js       NEW  Testbefehl ausfuehren, Ergebnisdatei einsammeln
src/runner/read-playwright.js NEW  failedTestsFromPlaywrightJson
src/runner/index.js           NEW  runSuite: orchestriert Lauf, Leser, Triage
src/report-summary.js         NEW  Sammelbericht (markdown und html)
src/config.js                 NEW  flakeproof.config.json laden
bin/flakeproof.js             MOD  Unterkommandos run und baseline
README.md                     MOD  Runner-Abschnitt
test/...                      neue Suiten
```

## Nicht Teil dieses Plans

CI-Gate und PR-Kommentar (#8), Blindheits-Messung (#12), weitere Adapter (#13).

---

### Task 1: Playwright-Ergebnisse lesen

**Files:**
- Create: `src/runner/read-playwright.js`
- Test: `test/read-playwright.test.js`, Fixture `test/fixtures/runner/playwright-results.json`

**Interfaces:**
- Produces: `failedTestsFromPlaywrightJson(path) -> Promise<Array<{ testId, message, anchor }>>` — dieselbe Form wie `failedTestsFromOutputXml`, damit der Runner beide Leser gleich behandeln kann. `testId` ist `datei > titel`.

- [ ] **Step 1: Fixture aus einem echten Lauf erzeugen**

Der Fixture muss echt sein, nicht ausgedacht. Erzeuge ihn so und committe das Ergebnis:

```bash
python3 -m http.server 8091 --directory test/fixtures/page >/dev/null 2>&1 &
sleep 2
FIXTURE_URL=http://127.0.0.1:8091/ npx playwright test --config test/fixtures/pw/playwright.config.js >/dev/null 2>&1
pkill -f "http.server 8091"
mkdir -p test/fixtures/runner
cp test/fixtures/pw/results.json test/fixtures/runner/playwright-results.json
rm -f test/fixtures/pw/results.json && rm -rf test-results
```

Pruefe danach mit `grep -c "toBeVisible" test/fixtures/runner/playwright-results.json`, dass die Datei den Fehlschlag enthaelt.

- [ ] **Step 2: Failing Test schreiben**

`test/read-playwright.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { failedTestsFromPlaywrightJson } from '../src/runner/read-playwright.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/runner/playwright-results.json', import.meta.url));

test('reads the failed test and extracts its anchor', async () => {
  const failures = await failedTestsFromPlaywrightJson(FIXTURE);
  assert.equal(failures.length, 1);
  assert.match(failures[0].testId, /expect timeout fixture/);
  assert.ok(failures[0].testId.includes('expect.spec.js'), 'the file belongs in the test id');
  assert.equal(failures[0].anchor.selector, '#does-not-exist');
  assert.equal(failures[0].anchor.kind, 'timeout');
});

test('the message is free of ansi escapes', async () => {
  const failures = await failedTestsFromPlaywrightJson(FIXTURE);
  // eslint-disable-next-line no-control-regex -- asserting the escapes are gone requires naming them
  assert.ok(!/\[/.test(failures[0].message), 'ansi escapes must be stripped');
});
```

- [ ] **Step 3: Laufen lassen — FAIL** (Modul fehlt)

Run: `npm test`

- [ ] **Step 4: Implementieren**

`src/runner/read-playwright.js`:

```js
// Reads a Playwright json reporter file and returns the failed tests with
// their failure message and extracted anchor, in the same shape as the
// Robot Framework adapter so the runner can treat both alike.
import { readFile } from 'node:fs/promises';
import { extractAnchor } from '../triage/anchor.js';

// The reporter writes colored output, and the escapes hide the locator from
// the anchor extraction.
// eslint-disable-next-line no-control-regex -- stripping ansi requires matching the escape byte
const ANSI = /\[[0-9;]*m/g;

function collect(suite, out, filePath) {
  const file = suite.file ?? filePath ?? '';
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      for (const r of t.results ?? []) {
        if (r.status !== 'failed' && r.status !== 'timedOut') continue;
        const raw = r.error?.message ?? r.errors?.[0]?.message ?? '';
        out.push({
          testId: `${spec.file ?? file} > ${spec.title}`,
          message: String(raw).replace(ANSI, ''),
        });
      }
    }
  }
  for (const child of suite.suites ?? []) collect(child, out, file);
}

export async function failedTestsFromPlaywrightJson(path) {
  const doc = JSON.parse(await readFile(path, 'utf8'));
  const failures = [];
  for (const suite of doc.suites ?? []) collect(suite, failures, '');
  return failures.map((f) => ({ ...f, anchor: extractAnchor(f.message) }));
}
```

- [ ] **Step 5: PASS**, dann **Commit**

Run: `npm test && npx eslint .`

```bash
git add src/runner/read-playwright.js test/read-playwright.test.js test/fixtures/runner/
git commit -m "feat: read failed tests from a playwright json report"
```

---

### Task 2: Testbefehl ausfuehren

**Files:**
- Create: `src/runner/run-tests.js`
- Test: `test/run-tests.test.js`

**Interfaces:**
- Produces: `runTests(command, { cwd = process.cwd() } = {}) -> Promise<{ exitCode: number, stdout: string, stderr: string }>` — fuehrt den Befehl in einer Shell aus und sammelt die Ausgabe ein. Wirft nie wegen eines Exit-Codes ungleich null; ein Spawn-Fehler ergibt `exitCode: -1` mit der Meldung in `stderr`.

- [ ] **Step 1: Failing Test schreiben**

`test/run-tests.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTests } from '../src/runner/run-tests.js';

test('captures output and exit code of a passing command', async () => {
  const r = await runTests('node -e "console.log(\'hallo\')"');
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hallo/);
});

test('a failing command is reported, not thrown', async () => {
  const r = await runTests('node -e "process.exit(3)"');
  assert.equal(r.exitCode, 3);
});

test('a command that cannot start reports exit code -1 instead of throwing', async () => {
  const r = await runTests('definitely-not-a-command-fp-runner');
  assert.ok(r.exitCode !== 0, 'must not look successful');
});
```

- [ ] **Step 2: FAIL**, dann implementieren

`src/runner/run-tests.js`:

```js
// Runs the user's test command and collects its output. A non-zero exit is a
// normal outcome here (that is why we are running), so it is reported rather
// than thrown; only the caller decides what a failure means.
import { spawn } from 'node:child_process';

export function runTests(command, { cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, { shell: true, cwd });
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ exitCode: -1, stdout, stderr: stderr + err.message }));
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}
```

- [ ] **Step 3: PASS**, dann **Commit**

Run: `npm test && npx eslint .`

```bash
git add src/runner/run-tests.js test/run-tests.test.js
git commit -m "feat: run a test command and collect its outcome"
```

---

### Task 3: Konfigurationsdatei

**Files:**
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `loadConfig(dir = process.cwd()) -> Promise<object>` — liest `flakeproof.config.json` aus `dir`, liefert `{}` wenn die Datei fehlt, wirft mit klarer Meldung bei kaputtem JSON.
- Produces: `DEFAULT_BASELINE = '.flakeproof/baseline.json'`

- [ ] **Step 1: Failing Test schreiben**

`test/config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_BASELINE } from '../src/config.js';

test('a missing config file is not an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-cfg-'));
  try {
    assert.deepEqual(await loadConfig(dir), {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reads command and url from the config file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-cfg-'));
  try {
    await writeFile(join(dir, 'flakeproof.config.json'), JSON.stringify({ cmd: 'npx playwright test', url: 'https://example.test' }));
    const cfg = await loadConfig(dir);
    assert.equal(cfg.cmd, 'npx playwright test');
    assert.equal(cfg.url, 'https://example.test');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('broken json fails loudly instead of silently falling back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-cfg-'));
  try {
    await writeFile(join(dir, 'flakeproof.config.json'), '{ not json');
    await assert.rejects(() => loadConfig(dir), /flakeproof\.config\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the default baseline location is inside a dot directory', () => {
  assert.equal(DEFAULT_BASELINE, '.flakeproof/baseline.json');
});
```

- [ ] **Step 2: FAIL**, dann implementieren

`src/config.js`:

```js
// Optional project configuration so a run does not need long flags. Absent
// config is normal; broken config is not, and is reported rather than
// silently ignored.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_BASELINE = '.flakeproof/baseline.json';

export async function loadConfig(dir = process.cwd()) {
  const path = join(dir, 'flakeproof.config.json');
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`flakeproof.config.json is not valid json: ${err.message}`);
  }
}
```

- [ ] **Step 3: PASS**, dann **Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: optional project configuration file"
```

---

### Task 4: Runner orchestriert

**Files:**
- Create: `src/runner/index.js`
- Test: `test/runner.test.js`

**Interfaces:**
- Consumes: `runTests`, `failedTestsFromPlaywrightJson`, `failedTestsFromOutputXml`, `triage`
- Produces: `runSuite(opts) -> Promise<{ ran: boolean, exitCode: number, failures: number, results: Array<{ testId, triage }>, notes: string[] }>`
  - `opts`: `{ cmd, url, baselinePath, resultsPath, reader, cwd }`; `reader` ist `'playwright'` oder `'robot'`
  - `results[].triage` ist das unveraenderte Ergebnis von `triage()`
  - Kann die Ergebnisdatei nicht gelesen werden, ist `ran` true, `failures` 0 und eine Note nennt das Problem. Ein gruener Lauf ohne Fehlschlaege ist ebenfalls `failures: 0`, aber ohne Note.

- [ ] **Step 1: Failing Test schreiben**

`test/runner.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { runSuite } from '../src/runner/index.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('a green run reports no failures and does not triage', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-run-'));
    const result = await runSuite({
      cmd: 'node -e "process.exit(0)"',
      resultsPath: join(dir, 'missing.json'),
      reader: 'playwright',
      cwd: dir,
    });
    assert.equal(result.ran, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.failures, 0);
    assert.equal(result.results.length, 0);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a red run without a readable result file says so instead of claiming success', async () => {
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-run-'));
    const result = await runSuite({
      cmd: 'node -e "process.exit(1)"',
      resultsPath: join(dir, 'missing.json'),
      reader: 'playwright',
      cwd: dir,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.failures, 0);
    assert.ok(result.notes.some((n) => /could not read/i.test(n)), JSON.stringify(result.notes));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test('a red run triages every failed test it finds', async () => {
  let dir = null;
  let server = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fp-run-'));
    server = await startFixtureServer();
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(server.url)));
    const resultsPath = join(dir, 'results.json');
    await copyFile(join(fixtures, 'runner', 'playwright-results.json'), resultsPath);

    const result = await runSuite({
      cmd: 'node -e "process.exit(1)"',
      url: server.url,
      baselinePath,
      resultsPath,
      reader: 'playwright',
      cwd: dir,
    });
    assert.equal(result.failures, 1);
    assert.equal(result.results.length, 1);
    assert.ok(result.results[0].triage.verdict, 'each failure carries a verdict');
    assert.match(result.results[0].testId, /expect timeout fixture/);
  } finally {
    if (server) await server.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: FAIL**, dann implementieren

`src/runner/index.js`:

```js
// Runs a test suite, finds the tests that failed, and triages each of them.
// This is the path that removes the manual assembly of baseline, error file
// and url for every single failure.
import { runTests } from './run-tests.js';
import { failedTestsFromPlaywrightJson } from './read-playwright.js';
import { failedTestsFromOutputXml } from '../adapters/robot.js';
import { triage } from '../triage/engine.js';

const READERS = {
  playwright: failedTestsFromPlaywrightJson,
  robot: failedTestsFromOutputXml,
};

export async function runSuite(opts) {
  const notes = [];
  const run = await runTests(opts.cmd, { cwd: opts.cwd });

  const read = READERS[opts.reader];
  if (!read) {
    return { ran: true, exitCode: run.exitCode, failures: 0, results: [], notes: [`unknown result reader: ${opts.reader}`] };
  }

  let failures = [];
  try {
    failures = await read(opts.resultsPath);
  } catch (err) {
    // Never treat an unreadable result file as a green run: that would turn
    // a broken setup into a silent all-clear.
    notes.push(`could not read the test results at ${opts.resultsPath}: ${err.message}`);
    return { ran: true, exitCode: run.exitCode, failures: 0, results: [], notes };
  }

  if (failures.length === 0) {
    if (run.exitCode !== 0) {
      notes.push('the test command failed but the result file lists no failed test; check the reporter configuration');
    }
    return { ran: true, exitCode: run.exitCode, failures: 0, results: [], notes };
  }

  const results = [];
  for (const f of failures) {
    const t = await triage({
      errorText: f.message,
      baselinePath: opts.baselinePath,
      currentUrl: opts.url,
    });
    results.push({ testId: f.testId, triage: t });
  }
  return { ran: true, exitCode: run.exitCode, failures: failures.length, results, notes };
}
```

- [ ] **Step 3: PASS**, dann **Commit**

Run: `npm test && npx eslint .`

```bash
git add src/runner/index.js test/runner.test.js
git commit -m "feat: run a suite and triage every failed test"
```

---

### Task 5: Sammelbericht

**Files:**
- Create: `src/report-summary.js`
- Test: `test/report-summary.test.js`

**Interfaces:**
- Consumes: das Ergebnis von `runSuite`, `renderHtmlReport`
- Produces: `renderSummaryMarkdown(runResult) -> string` und `renderSummaryHtml(runResult) -> string`
  - Der Markdown-Bericht listet je Test eine Zeile mit Urteil und Anker
  - Der HTML-Bericht zeigt oben eine Uebersicht (wie viele je Urteil) und darunter die vollstaendigen Einzelberichte hintereinander, self-contained wie der Einzelbericht

- [ ] **Step 1: Failing Test schreiben**

`test/report-summary.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSummaryMarkdown, renderSummaryHtml } from '../src/report-summary.js';

const runResult = {
  ran: true,
  exitCode: 1,
  failures: 2,
  notes: [],
  results: [
    {
      testId: 'nav.spec.js > menu shows products',
      triage: {
        verdict: 'fragile', testId: null, anchor: { selector: 'li.css-1a2b3c', kind: 'timeout' },
        rerun: null, temporal: null,
        classification: { verdict: 'cosmetic', reasons: ['selector relies on build-generated class ".css-1a2b3c" which is gone from the element'] },
        recommendation: [{ selector: '#main-nav li:has-text("Products")', kind: 'container-text', uniqueInCurrent: true, survived: 5, applied: 5 }],
        notes: [], detail: { anchorBefore: null, anchorAfter: null, steps: [] },
      },
    },
    {
      testId: 'cta.spec.js > cta is visible',
      triage: {
        verdict: 'real-change', testId: null, anchor: { selector: '#cta', kind: 'timeout' },
        rerun: null, temporal: null,
        classification: { verdict: 'semantic', reasons: ['own text changed: "Contact us" -> "Get a quote"'] },
        recommendation: null, notes: [], detail: { anchorBefore: null, anchorAfter: null, steps: [] },
      },
    },
  ],
};

test('the markdown summary lists every test with its verdict', () => {
  const md = renderSummaryMarkdown(runResult);
  assert.ok(md.includes('nav.spec.js > menu shows products'));
  assert.ok(md.includes('cta.spec.js > cta is visible'));
  assert.ok(md.includes('fragile'));
  assert.ok(md.includes('real-change'));
});

test('the html summary counts the verdicts and embeds every report', () => {
  const html = renderSummaryHtml(runResult);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('2 failed tests'), 'the overview names the total');
  assert.ok(html.includes('nav.spec.js'));
  assert.ok(html.includes('cta.spec.js'));
  assert.ok(html.includes('Get a quote'), 'the individual evidence is embedded');
  assert.ok(!/<script/i.test(html), 'still self-contained');
});

test('a green run is reported as such', () => {
  const md = renderSummaryMarkdown({ ran: true, exitCode: 0, failures: 0, results: [], notes: [] });
  assert.ok(/no failed tests/i.test(md), md);
});
```

- [ ] **Step 2: FAIL**, dann implementieren

`src/report-summary.js`:

```js
// Bundles the triage of a whole suite run: one line per failed test for a ci
// log, and a single self-contained html page with every full report for a
// human.
import { renderReport } from './report.js';
import { renderHtmlReport } from './report-html.js';

export function renderSummaryMarkdown(run) {
  if (run.failures === 0) {
    const lines = ['# flakeproof run', '', 'No failed tests to triage.'];
    for (const n of run.notes ?? []) lines.push(`- ${n}`);
    return lines.join('\n') + '\n';
  }
  const lines = ['# flakeproof run', '', `${run.failures} failed tests triaged.`, ''];
  for (const r of run.results) {
    lines.push(`## ${r.testId}`, '', renderReport(r.triage), '');
  }
  for (const n of run.notes ?? []) lines.push(`- ${n}`);
  return lines.join('\n');
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderSummaryHtml(run) {
  const counts = {};
  for (const r of run.results) counts[r.triage.verdict] = (counts[r.triage.verdict] ?? 0) + 1;
  const overview = Object.entries(counts)
    .map(([v, n]) => `<li>${esc(n)} ${esc(v)}</li>`)
    .join('');

  // Each individual report is a full document; take its body so the summary
  // stays one valid page.
  const bodies = run.results
    .map((r) => {
      const doc = renderHtmlReport(r.triage);
      const body = doc.slice(doc.indexOf('<main>'), doc.lastIndexOf('</main>') + 7);
      return `<section class="one"><h2 class="testid">${esc(r.testId)}</h2>${body}</section>`;
    })
    .join('');

  const style = `
    body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           margin: 0; padding: 32px 20px; background: #faf9f7; color: #2b2724; }
    .wrap { max-width: 860px; margin: 0 auto; }
    h1 { font-size: 26px; margin: 0 0 8px; }
    .testid { font-size: 15px; font-family: ui-monospace, Menlo, monospace; color: #7a736c;
              border-top: 1px solid #e6e1db; padding-top: 24px; margin-top: 32px; }
    .one main { max-width: none; padding: 0; }
    ul.counts { list-style: none; display: flex; gap: 14px; padding: 0; margin: 0 0 8px; }
    ul.counts li { background: #fff; border: 1px solid #e6e1db; border-radius: 999px; padding: 3px 12px; font-size: 13px; }
    .notes { color: #7a736c; font-size: 13px; }
  `;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flakeproof run</title>
<style>${style}</style></head>
<body><div class="wrap">
  <h1>${esc(run.failures)} failed tests</h1>
  <ul class="counts">${overview}</ul>
  ${(run.notes ?? []).map((n) => `<p class="notes">${esc(n)}</p>`).join('')}
  ${bodies}
</div></body></html>`;
}
```

- [ ] **Step 3: PASS**, dann **Commit**

```bash
git add src/report-summary.js test/report-summary.test.js
git commit -m "feat: summary report for a whole suite run"
```

---

### Task 6: CLI-Unterkommandos run und baseline

**Files:**
- Modify: `bin/flakeproof.js`, `README.md`
- Test: `test/cli.test.js` (erweitern)

**Interfaces:**
- `flakeproof baseline <url> [--out <datei>]` — nimmt die Baseline auf, Standardziel `.flakeproof/baseline.json` (Verzeichnis wird angelegt)
- `flakeproof run [--cmd <befehl>] [--url <url>] [--results <datei>] [--reader playwright|robot] [--baseline <datei>] [--out <datei>]` — fehlende Werte kommen aus `flakeproof.config.json`; ohne `--out` geht der Markdown-Bericht nach stdout, mit `.html`-Endung wird der HTML-Sammelbericht geschrieben
- Exit-Code: 0 sobald ein Bericht erzeugt wurde, 1 nur bei Bedienungs- oder Laufzeitfehlern

- [ ] **Step 1: Failing Test schreiben**

In `test/cli.test.js` anfuegen:

```js
test('baseline subcommand writes to the default location', async () => {
  const server = await startFixtureServer();
  const dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
  try {
    await run('node', [join(process.cwd(), 'bin/flakeproof.js'), 'baseline', server.url], { cwd: dir });
    const snap = JSON.parse(await readFile(join(dir, '.flakeproof', 'baseline.json'), 'utf8'));
    assert.equal(snap.tree.tag, 'html');
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('run subcommand triages a red suite and writes a summary', async () => {
  const server = await startFixtureServer();
  const dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
  try {
    await run('node', [join(process.cwd(), 'bin/flakeproof.js'), 'baseline', server.url], { cwd: dir });
    await copyFile(join(process.cwd(), 'test/fixtures/runner/playwright-results.json'), join(dir, 'results.json'));
    const outFile = join(dir, 'run.html');
    await run('node', [
      join(process.cwd(), 'bin/flakeproof.js'), 'run',
      '--cmd', 'node -e "process.exit(1)"',
      '--url', server.url,
      '--results', 'results.json',
      '--out', outFile,
    ], { cwd: dir });
    const html = await readFile(outFile, 'utf8');
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('failed tests'));
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

`copyFile` aus `node:fs/promises` in die Imports der Datei aufnehmen, falls es fehlt.

- [ ] **Step 2: FAIL**, dann implementieren

In `bin/flakeproof.js` die Imports ergaenzen:

```js
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig, DEFAULT_BASELINE } from '../src/config.js';
import { runSuite } from '../src/runner/index.js';
import { renderSummaryMarkdown, renderSummaryHtml } from '../src/report-summary.js';
```

Die USAGE-Konstante um die beiden Unterkommandos erweitern:

```
  flakeproof baseline <url> [--out <file.json>]
  flakeproof run [--cmd <command>] [--url <url>] [--results <file>] [--reader playwright|robot]
                 [--baseline <file.json>] [--out <file.md|file.html>]
```

Vor dem bestehenden `snapshot`-Zweig einfuegen:

```js
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

    const runResult = await runSuite({ cmd, url, baselinePath, resultsPath: resolve(results), reader });
    const wantsHtml = !!values.out && /\.html?$/i.test(values.out);
    const output = wantsHtml ? renderSummaryHtml(runResult) : renderSummaryMarkdown(runResult);
    if (values.out) {
      await writeFile(values.out, output, 'utf8');
      console.log(`run report written to ${values.out}`);
    } else {
      console.log(output);
    }
    return;
  }
```

- [ ] **Step 3: README-Abschnitt einfuegen**

Im README direkt nach dem Abschnitt "Red triage" (vor "### A report you can actually read") einfuegen:

```markdown
### One command instead of three paths

Assembling a baseline, an error file and a url by hand for every failure gets old fast. Record a baseline once while the build is green:

    node bin/flakeproof.js baseline https://your-app.example

Then, whenever the suite goes red, let flakeproof drive it:

    node bin/flakeproof.js run --cmd "npx playwright test" --url https://your-app.example --out run.html

It runs your command, reads which tests failed straight from the reporter output, triages each one, and writes a single page with a verdict per test. Put the repeated values in `flakeproof.config.json` and the command shrinks to `flakeproof run`:

    { "cmd": "npx playwright test", "url": "https://your-app.example", "results": "results.json" }

Robot Framework works the same way with `--reader robot --results output.xml`.
```

- [ ] **Step 4: PASS und Stilpruefung**

Run: `npm test && npx eslint . && grep -nP '—|[\x{1F300}-\x{1FAFF}]' README.md || echo "style ok"`

- [ ] **Step 5: Commit**

```bash
git add bin/flakeproof.js README.md test/cli.test.js
git commit -m "feat: run and baseline subcommands"
```

---

## Self-Review (durchgefuehrt)

- **Issue-#7-Abdeckung:** Suite fahren (Task 2), rote Tests aus dem Ergebnis lesen (Task 1 Playwright, bestehender RF-Adapter), jeden triagieren (Task 4), Sammelbericht (Task 5), Baseline an konventionellem Ort und Konfigurationsdatei statt langer Flags (Tasks 3 und 6). Verhalten ohne Baseline: `triage()` wirft beim Lesen, was der Runner pro Test als Fehler sichtbar macht.
- **Typ-Konsistenz:** beide Leser liefern `{ testId, message, anchor }`; `runSuite` gibt `{ ran, exitCode, failures, results, notes }`, was Task 5 und 6 unveraendert konsumieren; `renderHtmlReport` und `renderReport` werden nur wiederverwendet, nicht veraendert.
- **Platzhalter:** keine.
- **Risiko benannt:** der Playwright-Reporter faerbt seine Meldungen; das ANSI-Strippen in Task 1 ist Voraussetzung dafuer, dass die Anker-Extraktion ueberhaupt greift, und wird dort getestet.
