# flakeproof Phase 2a (Temporal-Lane + Text/Role-Kandidaten) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zwei Triage-Upgrades aus dem Phase-1-Backlog (Issue #3): Flakiness wird per gezielter Verzögerung im echten @playwright/test-Lauf deterministisch reproduziert, und die Selektor-Empfehlungen bekommen Text- und Role-Kandidaten, damit nicht ausgerechnet `nth-child` die Top-Empfehlung ist.

**Architecture:** Der Prover wechselt von `querySelectorAll` auf `page.locator`, wodurch alle Kandidaten-Arten (CSS, `text=`, `role=`) identisch bewiesen werden. Die Temporal-Lane besteht aus drei kleinen Teilen: dem bestehenden `temporalScript` (Phase 1), einem Opt-in-Wrapper `withTemporal(base)` für @playwright/test, der zwei Env-Variablen honoriert, und einer Probe, die den Rerun-Befehl mit eskalierenden Delays fährt, bis der Fehler auf jedem Lauf reproduziert.

**Tech Stack:** unverändert, keine neuen Dependencies.

## Global Constraints

- Node ≥ 20, `"type": "module"`, Testrunner `node:test` — keine weiteren Test-Frameworks
- **Keine neuen Dependencies**
- Sämtliche Repo-Texte auf Englisch, ohne Emojis, ohne em dashes, natürlich geschrieben; nur Spec-/Plan-Dokumente deutsch
- **Commits ohne jede KI-/Claude-Erwähnung**
- Kernregel: **niemals raten** — Kandidaten außerhalb verifizierbarer Formen werden nicht angeboten (fail closed), unklare Evidenz bleibt `unclear`
- Tests mit Browser/Server/Subprozessen: Aufräumen in `try/finally`; Env-Variablen, die ein Test setzt, im `finally` wieder entfernen
- Merge-Gate: `npm test` und `npx eslint .` grün/sauber nach jedem Task

## File Structure

```
src/triage/candidates.js      MODIFY  text=/role=-Kandidaten + Tree-seitige Eindeutigkeit
src/triage/prove.js           MODIFY  Kandidaten-Check über page.locator statt querySelectorAll
src/triage/engine.js          MODIFY  ambiguous-Note; temporal-Option + Probe-Aufruf
src/triage/rerun.js           MODIFY  optionaler env-Parameter
src/triage/temporal-probe.js  NEW     temporalProbe(command, selector, opts)
src/inject/playwright.js      NEW     withTemporal(base) für @playwright/test
src/report.js                 MODIFY  Timing-Provocation-Sektion
bin/flakeproof.js             MODIFY  --temporal Flag
package.json                  MODIFY  exports-Map (./inject)
test/fixtures/pw-temporal/    NEW     echte flaky Spec + Config
test/…                        neue/erweiterte Suiten
```

## Nicht Teil dieses Plans

Robot-Framework-Temporal-Injektion (kein Init-Script-Hook ohne Suite-Umbau; wird im README als Limitation dokumentiert), CI-Artefakt-Plumbing, Notenvergabe.

---

### Task 1: Text- und Role-Kandidaten im Generator

**Files:**
- Modify: `src/triage/candidates.js`
- Test: `test/candidates.test.js` (erweitern)

**Interfaces:**
- Produces: `candidatesFor` liefert zusätzlich Kandidaten der Kinds `'text'` (`text="..."`) und `'role'` (`role=<role>[name="..."]`) in Playwright-Selektor-Syntax. Rangfolge im Raw-Array: id, testid, aria, text, role, class, scoped, positional. Eindeutigkeit wird Tree-seitig approximiert (exakter Text-Match bzw. role+name-Match); die echte Verifikation macht der Prover. Fail closed: kein Kandidat bei leerem Text, Text > 80 Zeichen oder Text mit `"`.

- [ ] **Step 1: Failing Tests schreiben**

In `test/candidates.test.js` anfügen (nutzt die bestehenden Helper `n`, `withPaths`, `tree`):

```js
test('text and role candidates are generated for text-bearing elements', () => {
  const t = tree();
  const ctaPath = [0, 0, 1];
  const selectors = candidatesFor(t, ctaPath).map((c) => c.selector);
  assert.ok(selectors.includes('text="Contact us"'));
  assert.ok(selectors.includes('role=link[name="Contact us"]'));
});

test('text candidate is dropped when the text is not unique in the tree', () => {
  const t = withPaths(
    n('html', {}, [
      n('body', {}, [
        n('a', { text: 'Read more', attrs: { href: '/a/' } }),
        n('a', { text: 'Read more', attrs: { href: '/b/' } }),
      ]),
    ]),
  );
  const cands = candidatesFor(t, [0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'text'), 'duplicate text must not become a candidate');
});

test('text containing a double quote is not offered (fail closed)', () => {
  const t = withPaths(
    n('html', {}, [n('body', {}, [n('a', { text: 'say "hi"', attrs: { href: '/x/' } })])]),
  );
  const cands = candidatesFor(t, [0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'text' || c.kind === 'role'));
});
```

Hinweis: der `n()`-Helper in dieser Testdatei hat bereits `role: ''` als Default; für die Role-Kandidaten der neuen Tests braucht der `a`-Knoten eine Rolle. Im bestehenden `tree()`-Helper haben die Knoten kein `role`-Feld gesetzt — der cta-Knoten dort muss `role: 'link'` bekommen (eine Zeile im Helper ergänzen), die neuen Inline-Bäume setzen `role` nicht und erwarten deshalb auch keinen role-Kandidaten.

- [ ] **Step 2: Laufen lassen — FAIL**

Run: `npm test`

- [ ] **Step 3: Implementieren**

In `src/triage/candidates.js` zwei Zähl-Helfer vor `candidatesFor` ergänzen:

```js
function countByText(tree, text) {
  let count = 0;
  walk(tree, (node) => {
    if (node.text === text) count += 1;
  });
  return count;
}

function countByRoleName(tree, role, name) {
  let count = 0;
  walk(tree, (node) => {
    if (node.role === role && (node.name || node.text) === name) count += 1;
  });
  return count;
}
```

In `candidatesFor` nach dem aria-Kandidaten und vor den class-Kandidaten einfügen:

```js
  // Playwright-syntax candidates. queryTree's css grammar cannot verify
  // these; uniqueness is approximated tree-side (exact own-text match,
  // role + accessible-name match) and finally verified by the prover on the
  // live page. Fail closed on empty, long or quote-bearing text.
  const ownText = node.text;
  if (ownText && ownText.length <= 80 && !ownText.includes('"')) {
    raw.push({ selector: `text="${ownText}"`, kind: 'text' });
  }
  const roleName = node.name || node.text;
  if (node.role && roleName && roleName.length <= 80 && !roleName.includes('"')) {
    raw.push({ selector: `role=${node.role}[name="${roleName}"]`, kind: 'role' });
  }
```

Im Uniqueness-Filter am Ende der Funktion die beiden neuen Kinds vor dem `queryTree`-Zweig behandeln:

```js
  const seen = new Set();
  return raw.filter((cand) => {
    if (seen.has(cand.selector)) return false;
    seen.add(cand.selector);
    if (cand.kind === 'text') return countByText(tree, node.text) === 1;
    if (cand.kind === 'role') return countByRoleName(tree, node.role, node.name || node.text) === 1;
    const hits = queryTree(tree, cand.selector);
    return hits !== null && hits.length === 1 && hits[0] === node;
  });
```

- [ ] **Step 4: Laufen lassen — PASS.** Die bestehenden candidates-Tests müssen unverändert grün bleiben (die anonymen li-Fälle bekommen keine neuen Kandidaten, weil ihr eigener Text leer ist).

Run: `npm test && npx eslint .`

- [ ] **Step 5: Commit**

```bash
git add src/triage/candidates.js test/candidates.test.js
git commit -m "feat: text and role selector candidates"
```

---

### Task 2: Prover über page.locator

**Files:**
- Modify: `src/triage/prove.js`
- Test: `test/prove.test.js` (erweitern)

**Interfaces:**
- `proveCandidates`-Signatur und Rückgabeform unverändert. Intern prüft der Kandidaten-Check jetzt über `page.locator(selector)` (versteht CSS und Playwright-Engines gleichermaßen); ein nicht parsebarer Selektor zählt als nicht getroffen (fail closed), nie als Fehler.

- [ ] **Step 1: Failing Test schreiben**

In `test/prove.test.js` anfügen:

```js
test('text candidate survives every cosmetic mutation on the nav link', async () => {
  const server = await startFixtureServer();
  try {
    const snap = await anchorPathFor(server.url, 'li.css-1a2b3c > a');
    const candidates = candidatesFor(snap.tree, snap.anchorPath);
    const textCand = candidates.find((c) => c.kind === 'text');
    assert.ok(textCand, 'nav link must get a text candidate');
    assert.equal(textCand.selector, 'text="Products"');

    const proven = await proveCandidates(server.url, snap.anchorPath, candidates);
    const top = proven[0];
    assert.ok(top.kind === 'text' || top.kind === 'role', `expected a text/role candidate on top, got ${top.selector}`);
    assert.equal(top.uniqueInCurrent, true);
    assert.equal(top.survived, top.applied);
    assert.ok(top.applied >= 3, `expected at least 3 applicable mutations, got ${top.applied}`);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Laufen lassen — FAIL** (der aktuelle `checkCandidate` läuft über `querySelectorAll`, das `text=` nicht versteht; der Kandidat fällt durch)

Run: `npm test`

- [ ] **Step 3: Implementieren**

In `src/triage/prove.js` die in-page Funktion `checkCandidate` ersetzen durch einen node-seitigen Locator-Check und beide Aufrufstellen umstellen:

```js
// Checks one candidate against the live page: it must resolve to exactly one
// element, and that element must be the marked target. page.locator
// understands css and Playwright engines (text=, role=) alike; an
// unparsable selector counts as a miss, never as an error.
async function candidateHits(page, selector) {
  try {
    const locator = page.locator(selector);
    if ((await locator.count()) !== 1) return false;
    /* eslint-disable no-undef */
    return await locator.first().evaluate((el) => el.getAttribute('data-fp-target') === '1');
    /* eslint-enable no-undef */
  } catch {
    return false;
  }
}
```

Die Uniqueness-Schleife wird zu:

```js
    await withPage(async (page) => {
      for (const r of results) {
        r.uniqueInCurrent = await candidateHits(page, r.selector);
      }
    });
```

Die Mutations-Schleife entsprechend:

```js
        for (const r of results) {
          r.applied += 1;
          if (await candidateHits(page, r.selector)) r.survived += 1;
        }
```

`markTarget` bleibt unverändert in-page; die alte `checkCandidate`-Funktion wird gelöscht.

- [ ] **Step 4: Laufen lassen — PASS** (alle bestehenden prove- und e2e-Tests müssen unverändert grün bleiben; CSS-Kandidaten laufen über dieselbe Locator-Logik)

Run: `npm test && npx eslint .`

- [ ] **Step 5: Commit**

```bash
git add src/triage/prove.js test/prove.test.js
git commit -m "feat: prove candidates via page.locator for all selector kinds"
```

---

### Task 3: Strict-Mode-Ambiguität als Evidenz-Note

**Files:**
- Modify: `src/triage/engine.js`
- Test: `test/engine.test.js` (erweitern)

**Interfaces:**
- Verhalten: wenn `anchor.kind === 'ambiguous'`, enthält `notes` die Zeile `the failing locator matched multiple elements (strict mode violation); ambiguity itself is a fragility signal`. Verdict-Logik unverändert (niemals raten).

- [ ] **Step 1: Failing Test schreiben**

In `test/engine.test.js` anfügen (nutzt die bestehenden Imports und Helfer der Datei):

```js
test('a strict mode violation is surfaced as a fragility note', async () => {
  const server = await startFixtureServer();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(server.url)));
    const errorText = await readFile(new URL('./fixtures/errors/pw-strict-violation.txt', import.meta.url), 'utf8');
    const result = await triage({ errorText, baselinePath, currentPath: baselinePath });
    assert.equal(result.anchor.kind, 'ambiguous');
    assert.ok(result.notes.some((note) => note.includes('strict mode violation')));
  } finally {
    await server.close();
  }
});
```

`readFile` aus `node:fs/promises` zum Import der Testdatei ergänzen, falls noch nicht importiert.

- [ ] **Step 2: FAIL**, dann **Step 3: Implementieren**

In `src/triage/engine.js` direkt nach dem `no-anchor`-Frühausstieg einfügen:

```js
  if (anchor.kind === 'ambiguous') {
    notes.push('the failing locator matched multiple elements (strict mode violation); ambiguity itself is a fragility signal');
  }
```

- [ ] **Step 4: PASS** (`npm test && npx eslint .`), dann **Step 5: Commit**

```bash
git add src/triage/engine.js test/engine.test.js
git commit -m "feat: surface strict mode ambiguity as a fragility note"
```

---

### Task 4: Injektions-Helfer für @playwright/test

**Files:**
- Create: `src/inject/playwright.js`
- Modify: `package.json` (exports-Map)
- Test: `test/inject.test.js`

**Interfaces:**
- Produces: `withTemporal(base) -> test` — wrappt ein @playwright/test-`test`-Objekt via `base.extend`, so dass jeder Context ein Init-Script erhält, wenn die Env-Variablen `FLAKEPROOF_TEMPORAL_SELECTOR` und `FLAKEPROOF_TEMPORAL_MS` (positive Zahl) gesetzt sind. Ohne Env-Variablen verhält sich der Wrapper neutral.
- `package.json` erhält eine exports-Map: `"."` zeigt auf die Engine, `"./inject"` auf den Helfer.

- [ ] **Step 1: Failing Test schreiben**

`test/inject.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTemporal } from '../src/inject/playwright.js';

// withTemporal only needs base.extend; a stub keeps the test independent of
// the @playwright/test runner, which cannot be instantiated outside itself.
function stubBase() {
  return {
    extend(fixtures) {
      return { fixtures };
    },
  };
}

function stubContext() {
  return {
    scripts: [],
    async addInitScript(source) {
      this.scripts.push(source);
    },
  };
}

async function runContextFixture(wrapped, context) {
  let used = null;
  await wrapped.fixtures.context({ context }, async (c) => {
    used = c;
  });
  return used;
}

test('injects the temporal script when both env vars are set', async () => {
  process.env.FLAKEPROOF_TEMPORAL_SELECTOR = '#cta';
  process.env.FLAKEPROOF_TEMPORAL_MS = '800';
  try {
    const wrapped = withTemporal(stubBase());
    const context = stubContext();
    const used = await runContextFixture(wrapped, context);
    assert.equal(used, context, 'context must be passed through');
    assert.equal(context.scripts.length, 1);
    assert.ok(context.scripts[0].includes('#cta'));
    assert.ok(context.scripts[0].includes('800'));
  } finally {
    delete process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
    delete process.env.FLAKEPROOF_TEMPORAL_MS;
  }
});

test('does nothing without env vars or with an invalid delay', async () => {
  const wrapped = withTemporal(stubBase());
  const context = stubContext();
  await runContextFixture(wrapped, context);
  assert.equal(context.scripts.length, 0);

  process.env.FLAKEPROOF_TEMPORAL_SELECTOR = '#cta';
  process.env.FLAKEPROOF_TEMPORAL_MS = 'not-a-number';
  try {
    const context2 = stubContext();
    await runContextFixture(withTemporal(stubBase()), context2);
    assert.equal(context2.scripts.length, 0);
  } finally {
    delete process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
    delete process.env.FLAKEPROOF_TEMPORAL_MS;
  }
});
```

- [ ] **Step 2: FAIL**, dann **Step 3: Implementieren**

`src/inject/playwright.js`:

```js
// Opt-in temporal injection for @playwright/test users. Wrap your base test
// once and every browser context it creates honors the FLAKEPROOF_TEMPORAL_*
// environment variables that `flakeproof triage --temporal` sets:
//
//   import { test as base } from '@playwright/test';
//   import { withTemporal } from 'flakeproof/inject';
//   export const test = withTemporal(base);
//
// Without the env vars the wrapper is inert, so it can stay in place
// permanently.
import { temporalScript } from '../probe/temporal.js';

export function withTemporal(base) {
  return base.extend({
    context: async ({ context }, use) => {
      const selector = process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
      const ms = Number(process.env.FLAKEPROOF_TEMPORAL_MS);
      if (selector && Number.isFinite(ms) && ms > 0) {
        await context.addInitScript(temporalScript(selector, ms));
      }
      await use(context);
    },
  });
}
```

`package.json` nach dem `"bin"`-Eintrag ergänzen:

```json
  "exports": {
    ".": "./src/triage/engine.js",
    "./inject": "./src/inject/playwright.js"
  },
```

- [ ] **Step 4: PASS** (`npm test && npx eslint .` — die relative-Import-Tests bleiben von der exports-Map unberührt), dann **Step 5: Commit**

```bash
git add src/inject/playwright.js package.json test/inject.test.js
git commit -m "feat: temporal injection helper for playwright test suites"
```

---

### Task 5: Temporal-Probe, Engine-Verdrahtung und CLI-Flag

**Files:**
- Create: `src/triage/temporal-probe.js`
- Modify: `src/triage/rerun.js` (env-Parameter), `src/triage/engine.js` (temporal-Option), `src/report.js` (Timing-Sektion), `bin/flakeproof.js` (`--temporal`)
- Test: `test/temporal-probe.test.js`, `test/engine.test.js` (erweitern), `test/cli.test.js` (renderReport erweitern)

**Interfaces:**
- Modifiziert: `rerunStats(command, runs = 3, { env = {} } = {})` — `env` wird über `process.env` gemergt; bestehende Aufrufer unverändert
- Produces: `temporalProbe(command, selector, { delays = [250, 500, 1000, 2000], runsPerDelay = 2 } = {}) -> Promise<{ reproduced: boolean, delay: number|null, tried: Array<{ delay, failures, runs }> }>` — reproduziert, wenn bei einem Delay ALLE Läufe fehlschlagen; bricht beim ersten reproduzierenden Delay ab
- Modifiziert: `triage(opts)` akzeptiert `temporal: boolean`; im nondeterministic-Zweig läuft die Probe (nur mit `rerunCommand`), Ergebnis landet als `temporal`-Feld im Result plus Note; alle anderen Zweige tragen `temporal: null`? Nein: nur der nondeterministic-Zweig trägt das Feld, alle übrigen Rückgaben bleiben unverändert (dokumentiert)
- Modifiziert: `renderReport` rendert bei vorhandenem `r.temporal` eine Sektion `## Timing provocation` mit einer Zeile pro versuchtem Delay
- CLI: `--temporal` (boolean, nur sinnvoll mit `--rerun-cmd`; USAGE aktualisieren)

- [ ] **Step 1: Failing Tests schreiben**

`test/temporal-probe.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { temporalProbe } from '../src/triage/temporal-probe.js';

// Fails exactly when the injected delay is at least 500 ms, mimicking a test
// with a 400 ms implicit wait budget.
async function timingSensitiveScript() {
  const dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
  const script = join(dir, 'timing.cjs');
  await writeFile(
    script,
    'const ms = Number(process.env.FLAKEPROOF_TEMPORAL_MS || 0); process.exit(ms >= 500 ? 1 : 0);',
  );
  return script;
}

test('finds the smallest delay that reproduces the failure', async () => {
  const script = await timingSensitiveScript();
  const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500, 1000], runsPerDelay: 2 });
  assert.equal(result.reproduced, true);
  assert.equal(result.delay, 500);
  assert.deepEqual(result.tried.map((t) => t.delay), [250, 500], 'must stop at the first reproducing delay');
  assert.deepEqual(result.tried.map((t) => t.failures), [0, 2]);
});

test('reports honestly when no delay reproduces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
  const script = join(dir, 'stable.cjs');
  await writeFile(script, 'process.exit(0);');
  const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500], runsPerDelay: 2 });
  assert.equal(result.reproduced, false);
  assert.equal(result.delay, null);
  assert.equal(result.tried.length, 2);
});
```

In `test/engine.test.js` anfügen:

```js
test('temporal probe turns a green-on-rerun failure into a reproducible finding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
  const script = join(dir, 'timing.cjs');
  await writeFile(
    script,
    'const ms = Number(process.env.FLAKEPROOF_TEMPORAL_MS || 0); process.exit(ms >= 500 ? 1 : 0);',
  );
  const result = await triage({
    errorText: timeoutError('#cta'),
    rerunCommand: `node ${script}`,
    reruns: 2,
    temporal: true,
  });
  assert.equal(result.verdict, 'nondeterministic');
  assert.equal(result.temporal.reproduced, true);
  assert.equal(result.temporal.delay, 500);
  assert.ok(result.notes.some((note) => note.includes('likely a missing wait')));
});
```

In `test/cli.test.js` den renderReport-Test um das temporal-Feld erweitern (im bestehenden Testobjekt ergänzen und eine Assertion anfügen):

```js
    temporal: { reproduced: true, delay: 500, tried: [{ delay: 250, failures: 0, runs: 2 }, { delay: 500, failures: 2, runs: 2 }] },
```

```js
  assert.ok(md.includes('## Timing provocation'));
  assert.ok(md.includes('- 500 ms: 2/2 runs failed'));
```

- [ ] **Step 2: Laufen lassen — FAIL**

Run: `npm test`

- [ ] **Step 3: Implementieren**

`src/triage/rerun.js` — Signatur erweitern:

```js
export async function rerunStats(command, runs = 3, { env = {} } = {}) {
  const exitCodes = [];
  for (let i = 0; i < runs; i += 1) {
    const code = await new Promise((resolve) => {
      const child = spawn(command, { shell: true, stdio: 'ignore', env: { ...process.env, ...env } });
      child.on('error', () => resolve(-1));
      child.on('close', (c) => resolve(c ?? -1));
    });
    exitCodes.push(code);
  }
  const failures = exitCodes.filter((c) => c !== 0).length;
  return { runs, failures, exitCodes, nondeterministic: failures > 0 && failures < runs };
}
```

`src/triage/temporal-probe.js`:

```js
// Provokes a suspected timing failure on purpose: rerun the failing command
// with the anchor element delayed by escalating amounts (via the env vars
// the flakeproof/inject helper honors) until the failure reproduces on every
// run at one delay. Turns flakiness into a deterministic, reportable finding.
import { rerunStats } from './rerun.js';

export async function temporalProbe(command, selector, { delays = [250, 500, 1000, 2000], runsPerDelay = 2 } = {}) {
  const tried = [];
  for (const delay of delays) {
    const stats = await rerunStats(command, runsPerDelay, {
      env: { FLAKEPROOF_TEMPORAL_SELECTOR: selector, FLAKEPROOF_TEMPORAL_MS: String(delay) },
    });
    tried.push({ delay, failures: stats.failures, runs: stats.runs });
    if (stats.failures === stats.runs) return { reproduced: true, delay, tried };
  }
  return { reproduced: false, delay: null, tried };
}
```

`src/triage/engine.js` — Import ergänzen und den nondeterministic-Zweig erweitern:

```js
import { temporalProbe } from './temporal-probe.js';
```

```js
    if (rerun.failures === 0 || rerun.nondeterministic) {
      const why = rerun.failures === 0 ? 'test went green on every rerun' : 'test fails intermittently across reruns';
      notes.push(why);
      let temporal = null;
      if (opts.temporal) {
        temporal = await temporalProbe(opts.rerunCommand, anchor.selector);
        notes.push(temporal.reproduced
          ? `fails on every run when "${anchor.selector}" appears ${temporal.delay} ms late; likely a missing wait`
          : 'timing provocation on the anchor did not reproduce the failure');
      }
      return { verdict: 'nondeterministic', anchor, testId, rerun, temporal, classification: null, recommendation: null, notes };
    }
```

`src/report.js` — vor der Notes-Sektion einfügen:

```js
  if (r.temporal) {
    lines.push('', '## Timing provocation');
    for (const t of r.temporal.tried) lines.push(`- ${t.delay} ms: ${t.failures}/${t.runs} runs failed`);
  }
```

`bin/flakeproof.js` — Option `temporal: { type: 'boolean', default: false }` in der triage-parseArgs-Options-Map ergänzen, `temporal: values.temporal` an `triage()` durchreichen, und in der USAGE-Zeile `[--rerun-cmd <command>] [--reruns <n>]` erweitern zu `[--rerun-cmd <command>] [--reruns <n>] [--temporal]`.

- [ ] **Step 4: Laufen lassen — PASS**

Run: `npm test && npx eslint .`

- [ ] **Step 5: Commit**

```bash
git add src/triage/temporal-probe.js src/triage/rerun.js src/triage/engine.js src/report.js bin/flakeproof.js test/temporal-probe.test.js test/engine.test.js test/cli.test.js
git commit -m "feat: temporal probe wires flaky provocation into triage"
```

---

### Task 6: Echte Reproduktion im @playwright/test-Lauf

Der Beweis, dass die Lane end-to-end funktioniert: eine echte Spec mit `withTemporal`, die ohne Delay grün ist und mit 1000 ms Delay deterministisch scheitert.

**Files:**
- Create: `test/fixtures/pw-temporal/playwright.config.js`, `test/fixtures/pw-temporal/flaky.spec.js`
- Test: `test/temporal-e2e.test.js`

- [ ] **Step 1: Fixture-Spec und Config anlegen**

`test/fixtures/pw-temporal/playwright.config.js`:

```js
export default {
  testDir: '.',
  reporter: [['list']],
  workers: 1,
  use: { headless: true },
};
```

`test/fixtures/pw-temporal/flaky.spec.js`:

```js
import { test as base, expect } from '@playwright/test';
import { withTemporal } from '../../../src/inject/playwright.js';

const test = withTemporal(base);

test('cta appears quickly', async ({ page }) => {
  await page.goto(process.env.FIXTURE_URL);
  await expect(page.locator('#cta')).toBeVisible({ timeout: 400 });
});
```

- [ ] **Step 2: E2E-Test schreiben**

`test/temporal-e2e.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './helpers/serve.js';
import { rerunStats } from '../src/triage/rerun.js';
import { temporalProbe } from '../src/triage/temporal-probe.js';

const COMMAND = 'npx playwright test --config test/fixtures/pw-temporal/playwright.config.js';

test('temporal probe reproduces a timing failure in a real playwright run', async () => {
  const server = await startFixtureServer();
  process.env.FIXTURE_URL = server.url;
  try {
    const clean = await rerunStats(COMMAND, 1);
    assert.equal(clean.failures, 0, 'spec must pass without temporal delay');

    const result = await temporalProbe(COMMAND, '#cta', { delays: [1000], runsPerDelay: 1 });
    assert.equal(result.reproduced, true, 'a 1000 ms delay against a 400 ms budget must fail deterministically');
    assert.equal(result.delay, 1000);
  } finally {
    delete process.env.FIXTURE_URL;
    await server.close();
  }
});
```

- [ ] **Step 3: Laufen lassen — PASS.** Der Test spawnt zwei echte @playwright/test-Kindläufe und dauert einige Sekunden; das ist beabsichtigt. Schlägt der Clean-Lauf fehl, stimmt etwas an Config/Spec/Env — nicht die Assertion lockern, sondern die Ursache finden.

Run: `npm test && npx eslint .`

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/pw-temporal/ test/temporal-e2e.test.js
git commit -m "test: end-to-end temporal reproduction in a real playwright run"
```

---

### Task 7: README-Update

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Temporal-Sektion einfügen** (nach dem CLI-reference-Block, vor "## Status"):

```markdown
### Catching missing waits

Flaky tests usually mean a missing wait, but nobody can point at it. With the temporal lane flakeproof finds it: pass `--temporal` together with `--rerun-cmd`, and when reruns disagree, flakeproof reruns the test with the anchor element deliberately delayed by increasing amounts until the failure reproduces on every run. The report then says: fails on every run when `#submit` appears 500 ms late, likely a missing wait.

This needs a one-time, permanently inert setup in your Playwright suite:

    // fixtures.js
    import { test as base } from '@playwright/test';
    import { withTemporal } from 'flakeproof/inject';
    export const test = withTemporal(base);

Robot Framework suites cannot be injected this way yet; the rerun statistics still work there, only the provocation step is Playwright-only for now.
```

- [ ] **Step 2: Bestand aktualisieren**
  - Mutation-Tabelle: Zeile `| Temporal (building block, not wired yet) | ... |` ersetzen durch `| Temporal | element appears 800 ms later | stay green |`
  - CLI-reference: `[--rerun-cmd <command>] [--reruns <n>]` erweitern um `[--temporal]`
  - Verdict-Tabelle, Zeile nondeterministic: `reruns disagree: timing or state, not this commit` ersetzen durch `reruns disagree; with --temporal the missing wait is pinpointed by provoked delays`
  - Roadmap-Absatz in "## Status": die Punkte "temporal provocation as a triage lane" und "text- and role-based selector candidates" entfernen (jetzt geliefert), stattdessen: `On the roadmap: temporal injection for Robot Framework suites, proving candidates inside the user's own test run, and grading new tests before they enter the suite.`
  - Repository layout: nach `src/adapters/` die Zeile `src/inject/          opt-in helpers for user test suites (Playwright temporal injection)` einfügen

- [ ] **Step 3: Style-Check und Commit**

Run: `grep -nP '—|[\x{1F300}-\x{1FAFF}]' README.md; npx eslint .`
Expected: keine Treffer, Lint sauber.

```bash
git add README.md
git commit -m "docs: temporal lane and candidate upgrades in the README"
```

---

## Self-Review (durchgeführt)

- **Issue-#3-Abdeckung:** Scope-Punkt 1 → Task 1; 2 → Task 2; 3 → Task 3; 4 → Task 4; 5 → Task 5; 6 → Tasks 5 (synthetisch) + 6 (echt); 7 → Task 7. RF-Limitation dokumentiert in Task 7. ✓
- **Typ-Konsistenz:** `temporalProbe`-Rückgabe `{ reproduced, delay, tried }` identisch in Task 5 (Definition, Engine, Report, Tests) und Task 6; `rerunStats`-env-Parameter rückwärtskompatibel; Kandidaten-Kinds `'text'`/`'role'` fließen unverändert durch Prover und Report (kind-Spalte existiert bereits). ✓
- **Platzhalter:** keine. ✓
- **Bewusste Grenze:** `temporal` erscheint nur im nondeterministic-Result (dokumentiert in Task 5); die Delay-Eskalation findet den kleinsten reproduzierenden Delay aus der Liste, keine Bisektion (YAGNI, Liste ist konfigurierbar).
