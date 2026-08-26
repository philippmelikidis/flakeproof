# flakeproof Phase 2b (Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Ehrlichkeits- und Abdeckungslücken aus dem Phase-2a-Final-Review schließen (Issue #4): Ack-Handshake für die Temporal-Injektion, konservative CSS-Basis-Ableitung für mehr probbare Anker, eine Copy-Tweak-Mutation, damit text=/role=-Kandidaten ihre Scores verdienen, plus Konsistenz-, Coverage- und Infra-Batch.

**Architecture:** Drei kleine Mechanismen: (1) Der Inject-Wrapper quittiert jede Injektion in eine Ack-Datei, deren Pfad die Probe per Env-Variable vorgibt; ohne Quittung wird kein Reproduktions-Claim erhoben und ein fehlendes Setup beim Namen genannt. (2) Ein Ableitungs-Helfer extrahiert aus Playwright-Ankern (`#a >> text=...`, `a:visible`) eine hinreichend spezifische CSS-Basis (Verstecken vererbt sich auf Nachfahren) und abstiniert bei allem Mehrdeutigen. (3) Der Prover bekommt einen eigenen Katalog (kosmetisch + Copy-Tweak); der Spike-Messlauf und der Klassifikator bleiben unberührt.

**Tech Stack:** unverändert, keine neuen Dependencies.

## Global Constraints

- Node ≥ 20, `"type": "module"`, Testrunner `node:test`; **keine neuen Dependencies**
- Sämtliche Repo-Texte auf Englisch, ohne Emojis, ohne em dashes, natürlich geschrieben; nur Spec-/Plan-Dokumente deutsch
- **Commits ohne jede KI-/Claude-Erwähnung**
- Kernregel: **niemals raten** — ein Reproduktions-Claim ohne Injektions-Quittung ist keiner; eine nicht ableitbare CSS-Basis führt zur Abstention mit Note
- Tests mit Browser/Server/Subprozessen: Aufräumen in `try/finally` (inkl. mkdtemp-Verzeichnisse); Env-Variablen im `finally` entfernen
- Der Spike-Messlauf (`npm run spike`) und der Klassifikator-Kontrakt bleiben von der neuen Proving-Mutation unberührt
- Merge-Gate: `npm test` und `npx eslint .` grün/sauber nach jedem Task

## File Structure

```
src/probe/catalogs/proving.js   NEW     provingMutations = cosmetic + copyTweak
src/triage/prove.js             MODIFY  Default-Katalog = provingMutations
src/triage/temporal-probe.js    MODIFY  Ack-Handshake (injected-Feld, Claim-Rückzug)
src/inject/playwright.js        MODIFY  Ack-Datei schreiben
src/triage/temporal-target.js   NEW     temporalTargetFor(selector) -> css|null
src/triage/engine.js            MODIFY  Target-Ableitung, Ack-Notes, temporal: null überall
src/triage/rerun.js             MODIFY  commandBroken-Erkennung, ACK-Scrub
src/report.js                   MODIFY  reproduzierende Delay-Zeile markieren
README.md                       MODIFY  Kontrolllauf- und Ack-Klausel
test/…                          neue/erweiterte Suiten, Teardown-Härtung
```

## Nicht Teil dieses Plans

RF-Temporal-Injektion, Accessible-Name-Berechnung tree-seitig, Kandidaten aus dem Current-Tree, Browser-Pooling, Snapshot-Pruning, Notenvergabe.

---

### Task 1: Proving-Katalog mit Copy-Tweak

text=/role=-Kandidaten überleben den kosmetischen Katalog per Konstruktion (keine Mutation verändert Text). Ein Case-Flip des Element-Texts ist die charakteristische Schwäche von Text-Selektoren und gehört in den **Prover**, nicht in den Spike (der Klassifikator wertet Textänderung zu Recht als semantisch).

**Files:**
- Create: `src/probe/catalogs/proving.js`
- Modify: `src/triage/prove.js` (Default-Katalog)
- Test: `test/prove.test.js` (erweitern/anpassen)

**Interfaces:**
- Produces: `copyTweak` (Mutation `{ id: 'tweak-text-case', description, apply(selector) -> boolean }`, in-page, self-contained) und `provingMutations = [...cosmeticMutations, copyTweak]`
- `proveCandidates`-Default wechselt von `cosmeticMutations` auf `provingMutations`; Signatur unverändert

- [ ] **Step 1: Failing Test schreiben**

In `test/prove.test.js` die Assertions des Tests `text candidate survives every cosmetic mutation on the nav link` anpassen (der Copy-Tweak MUSS den Text-Kandidaten jetzt schlagen) und den Testnamen ehrlich machen:

```js
test('text candidate survives cosmetic mutations but not the copy tweak', async () => {
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
    assert.equal(top.survived, top.applied - 1, 'the copy tweak must defeat the text candidate; that is its honest weakness');
    assert.ok(top.applied >= 4, `expected at least 4 applicable mutations, got ${top.applied}`);
  } finally {
    await server.close();
  }
});
```

Und einen neuen Test anfügen, der zeigt, dass die id den Tweak überlebt und deshalb verdient oben steht:

```js
test('id candidate outranks text after the copy tweak', async () => {
  const server = await startFixtureServer();
  try {
    const snap = await anchorPathFor(server.url, '#cta');
    const candidates = candidatesFor(snap.tree, snap.anchorPath);
    const proven = await proveCandidates(server.url, snap.anchorPath, candidates);
    assert.equal(proven[0].selector, '#cta');
    assert.equal(proven[0].survived, proven[0].applied, 'the id must survive the copy tweak');
    const text = proven.find((c) => c.kind === 'text');
    assert.ok(text, 'cta must still get a text candidate');
    assert.equal(text.survived, text.applied - 1);
  } finally {
    await server.close();
  }
});
```

Hinweis: der bestehende Test `positional candidate survives renames but not reordering` bleibt unverändert gültig, weil das anonyme `li` keinen eigenen Text hat und der Tweak dort nicht anwendbar ist (`applied` bleibt 5).

- [ ] **Step 2: Laufen lassen — FAIL** (`survived === applied` noch, Katalog fehlt)

Run: `npm test`

- [ ] **Step 3: Implementieren**

`src/probe/catalogs/proving.js`:

```js
// The proving catalog: everything a robust selector should survive. It
// extends the cosmetic catalog with perturbations that are outside the
// triage classification contract (the classifier reads a copy tweak as a
// semantic change, correctly) but that separate durable selectors from
// coincidental ones. Used by the prover only; the spike measurement and the
// classifier keep the plain cosmetic catalog.
import { cosmeticMutations } from './cosmetic.js';

// Runs inside the page. Self-contained.
export const copyTweak = {
  id: 'tweak-text-case',
  description: 'Flip the case of the first letter of the element own text',
  apply: (selector) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        const text = node.textContent;
        const i = text.search(/[a-zA-Z]/);
        if (i === -1) return false;
        const ch = text[i];
        const flipped = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
        node.textContent = text.slice(0, i) + flipped + text.slice(i + 1);
        return true;
      }
    }
    return false;
  },
};

export const provingMutations = [...cosmeticMutations, copyTweak];
```

`src/triage/prove.js`: Import und Default tauschen:

```js
import { provingMutations } from '../probe/catalogs/proving.js';
```

```js
export async function proveCandidates(url, anchorPath, candidates, { mutations = provingMutations } = {}) {
```

Datei-Header-Kommentar des Provers auf "proving catalog" anpassen. eslint: `proving.js` liegt unter `src/probe/**` und hat damit Browser-Globals.

- [ ] **Step 4: Laufen lassen — PASS.** Auch `npm run spike` einmal fahren: Exit 0, Zahlen unverändert (der Spike nutzt weiter `cosmeticMutations` direkt).

Run: `npm test && npx eslint . && npm run spike`

- [ ] **Step 5: Commit**

```bash
git add src/probe/catalogs/proving.js src/triage/prove.js test/prove.test.js
git commit -m "feat: copy tweak in a dedicated proving catalog"
```

---

### Task 2: Ack-Handshake zwischen Probe und Inject-Wrapper

**Files:**
- Modify: `src/triage/temporal-probe.js`, `src/inject/playwright.js`, `src/triage/rerun.js` (ACK-Scrub), `src/triage/engine.js` (Notes)
- Test: `test/temporal-probe.test.js`, `test/inject.test.js`, `test/engine.test.js`, `test/temporal-e2e.test.js` (jeweils erweitern/anpassen)

**Interfaces:**
- `temporalProbe`-Rückgabe erweitert um `injected: boolean|null` (null = kein Delayed-Run gelaufen, z. B. Control-Abbruch). Ein voll fehlschlagender Delay OHNE Quittung erzeugt KEINEN Reproduktions-Claim: Rückgabe `{ reproduced: false, delay: null, tried, control, injected: false }`.
- Wrapper: wenn `FLAKEPROOF_TEMPORAL_ACK` gesetzt ist und injiziert wird, schreibt er die Datei (Fehler beim Schreiben dürfen den Nutzer-Test nie brechen).
- `rerunStats` scrubbt zusätzlich `FLAKEPROOF_TEMPORAL_ACK` aus der geerbten Env, sofern nicht explizit übergeben.

- [ ] **Step 1: Failing Tests schreiben**

`test/temporal-probe.test.js` — das Helfer-Skript quittiert jetzt wie der echte Wrapper; zusätzlich ein Nicht-Quittierungs-Fall:

```js
// Mimics a suite with the inject wrapper installed: acknowledges the
// injection, then fails when the delay is at least 500 ms.
async function ackedTimingScript() {
  const dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
  const script = join(dir, 'timing.cjs');
  await writeFile(
    script,
    'const fs=require("fs");const ms=Number(process.env.FLAKEPROOF_TEMPORAL_MS||0);' +
      'const ack=process.env.FLAKEPROOF_TEMPORAL_ACK;' +
      'if(ms>0&&ack)fs.writeFileSync(ack,"injected");' +
      'process.exit(ms>=500?1:0);',
  );
  return script;
}
```

Bestehenden Test `finds the smallest delay that reproduces the failure` auf `ackedTimingScript()` umstellen und ergänzen: `assert.equal(result.injected, true);`

Neuer Test:

```js
test('a fully failing delay without an acknowledgment is not a reproduction claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-probe-'));
  const script = join(dir, 'silent.cjs');
  await writeFile(
    script,
    'const ms = Number(process.env.FLAKEPROOF_TEMPORAL_MS || 0); process.exit(ms >= 500 ? 1 : 0);',
  );
  const result = await temporalProbe(`node ${script}`, '#cta', { delays: [250, 500], runsPerDelay: 2 });
  assert.equal(result.reproduced, false, 'no ack means no experiment, means no claim');
  assert.equal(result.injected, false);
  assert.equal(result.delay, null);
  assert.equal(result.tried.at(-1).failures, 2, 'the failing delay round must still be recorded');
});
```

`test/inject.test.js` — im Injektions-Test zusätzlich Ack prüfen (Imports `mkdtemp`, `readFile`, `rm`, `tmpdir`, `join` ergänzen):

```js
    const ackDir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
    const ackPath = join(ackDir, 'ack');
    process.env.FLAKEPROOF_TEMPORAL_ACK = ackPath;
```

nach dem bestehenden Assert:

```js
    assert.equal(await readFile(ackPath, 'utf8'), 'injected', 'the wrapper must acknowledge the injection');
```

und im `finally` zusätzlich `delete process.env.FLAKEPROOF_TEMPORAL_ACK;` sowie `await rm(ackDir, { recursive: true, force: true });`. Der Inert-Test bekommt einen Zusatz-Assert: ohne Selector/MS wird auch bei gesetztem ACK-Pfad nichts geschrieben (Datei existiert nicht; `existsSync` aus `node:fs` importieren oder per readFile-catch prüfen).

`test/engine.test.js` — den bestehenden Temporal-Test auf ein quittierendes Skript umstellen (gleicher Skript-Inhalt wie `ackedTimingScript`) und ergänzen: `assert.equal(result.temporal.injected, true);`. Neuer Test für die Nicht-Installiert-Note:

```js
test('a missing inject wrapper is named instead of blaming timing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
  const script = join(dir, 'silent.cjs');
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
  assert.equal(result.temporal.injected, false);
  assert.ok(result.notes.some((note) => note.includes('never acknowledged')), JSON.stringify(result.notes));
});
```

`test/temporal-e2e.test.js` — nach dem Probe-Assert ergänzen: `assert.equal(result.injected, true, 'the real wrapper must acknowledge');`

- [ ] **Step 2: Laufen lassen — FAIL**

Run: `npm test`

- [ ] **Step 3: Implementieren**

`src/inject/playwright.js` — Import und Ack-Schreiben:

```js
import { writeFile } from 'node:fs/promises';
import { temporalScript } from '../probe/temporal.js';

export function withTemporal(base) {
  return base.extend({
    context: async ({ context }, use) => {
      const selector = process.env.FLAKEPROOF_TEMPORAL_SELECTOR;
      const ms = Number(process.env.FLAKEPROOF_TEMPORAL_MS);
      if (selector && Number.isFinite(ms) && ms > 0) {
        await context.addInitScript(temporalScript(selector, ms));
        const ack = process.env.FLAKEPROOF_TEMPORAL_ACK;
        // The acknowledgment lets the probe distinguish "delay never
        // happened" from "timing is not the cause". Failing to write it must
        // never break the user's test run.
        if (ack) await writeFile(ack, 'injected').catch(() => {});
      }
      await use(context);
    },
  });
}
```

`src/triage/rerun.js` — dritte Scrub-Zeile:

```js
      if (!('FLAKEPROOF_TEMPORAL_ACK' in env)) delete childEnv.FLAKEPROOF_TEMPORAL_ACK;
```

`src/triage/temporal-probe.js`:

```js
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rerunStats } from './rerun.js';

export async function temporalProbe(command, selector, { delays = [250, 500, 1000, 2000], runsPerDelay = 2 } = {}) {
  const control = await rerunStats(command, runsPerDelay);
  if (control.failures > 0) {
    return { reproduced: false, delay: null, tried: [], control, injected: null };
  }
  // The inject wrapper acknowledges every injection into this file. A delay
  // round that fails without an acknowledgment proves nothing about timing:
  // the experiment never ran inside the suite.
  const ackDir = await mkdtemp(join(tmpdir(), 'fp-ack-'));
  const ackPath = join(ackDir, 'ack');
  try {
    const tried = [];
    for (const delay of delays) {
      const stats = await rerunStats(command, runsPerDelay, {
        env: {
          FLAKEPROOF_TEMPORAL_SELECTOR: selector,
          FLAKEPROOF_TEMPORAL_MS: String(delay),
          FLAKEPROOF_TEMPORAL_ACK: ackPath,
        },
      });
      tried.push({ delay, failures: stats.failures, runs: stats.runs });
      if (stats.failures === stats.runs) {
        if (!existsSync(ackPath)) {
          return { reproduced: false, delay: null, tried, control, injected: false };
        }
        return { reproduced: true, delay, tried, control, injected: true };
      }
    }
    return { reproduced: false, delay: null, tried, control, injected: existsSync(ackPath) };
  } finally {
    await rm(ackDir, { recursive: true, force: true });
  }
}
```

Modul-Kommentar oben um den Handshake-Satz ergänzen.

`src/triage/engine.js` — die Note-Verzweigung im Temporal-Block wird vierstufig:

```js
          if (temporal.reproduced) {
            notes.push(`fails on every run when "${anchor.selector}" appears ${temporal.delay} ms late; likely a missing wait`);
          } else if (temporal.control && temporal.control.failures > 0) {
            notes.push('temporal probe aborted: the control run without any delay already failed, so the baseline is too unstable to attribute failures to timing');
          } else if (temporal.injected === false) {
            notes.push('the inject wrapper never acknowledged the delay; install withTemporal from flakeproof/inject in the suite before trusting any timing verdict');
          } else {
            notes.push('no reproduction: the delay was injected but the failure did not come back; timing on this anchor is unlikely to be the cause');
          }
```

Die alte Formulierung `no reproduction; note this requires the flakeproof/inject wrapper ...` entfällt; nach dem Ack darf der Negativbefund stärker formuliert sein, weil das Experiment nachweislich lief.

- [ ] **Step 4: Laufen lassen — PASS** (`npm test && npx eslint .`)

- [ ] **Step 5: Commit**

```bash
git add src/triage/temporal-probe.js src/inject/playwright.js src/triage/rerun.js src/triage/engine.js test/temporal-probe.test.js test/inject.test.js test/engine.test.js test/temporal-e2e.test.js
git commit -m "feat: injection acknowledgment gates every timing claim"
```

---

### Task 3: CSS-Basis-Ableitung für Temporal-Targets

**Files:**
- Create: `src/triage/temporal-target.js`
- Modify: `src/triage/engine.js` (ersetzt `isCssAnchor`)
- Test: `test/temporal-target.test.js`, `test/engine.test.js` (Skip-Note-Wortlaut, falls asserted)

**Interfaces:**
- Produces: `temporalTargetFor(selector) -> string | null` — liefert eine CSS-Basis, auf die die Delay-Regel zielen kann (Verstecken vererbt sich auf Nachfahren), oder null, wenn keine hinreichend spezifische Basis ableitbar ist (bare Tags, Engine-only-Anker, unbekannte Pseudo-Syntax). Niemals raten: lieber null als eine zu breite Basis.

- [ ] **Step 1: Failing Tests schreiben**

`test/temporal-target.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temporalTargetFor } from '../src/triage/temporal-target.js';

test('plain css selectors pass through unchanged', () => {
  assert.equal(temporalTargetFor('#cta'), '#cta');
  assert.equal(temporalTargetFor('li.css-1a2b3c > a'), 'li.css-1a2b3c > a');
  assert.equal(temporalTargetFor('[data-testid="cta-button"]'), '[data-testid="cta-button"]');
  assert.equal(temporalTargetFor('#main-nav li:nth-child(1)'), '#main-nav li:nth-child(1)');
});

test('a css base is derived from chained and suffixed anchors', () => {
  assert.equal(temporalTargetFor('#a >> text=Save'), '#a');
  assert.equal(temporalTargetFor('#a >> nth=0'), '#a');
  assert.equal(temporalTargetFor('.card:has-text("Save")'), '.card');
  assert.equal(temporalTargetFor('a.btn:visible'), 'a.btn');
});

test('anchors without a specific css base are refused', () => {
  assert.equal(temporalTargetFor('text=Save'), null, 'engine-only anchor');
  assert.equal(temporalTargetFor('role=link[name="Save"]'), null);
  assert.equal(temporalTargetFor('a:visible'), null, 'bare tag after stripping');
  assert.equal(temporalTargetFor('div:near(#a)'), null, 'bare tag after stripping');
  assert.equal(temporalTargetFor('//div[@id="x"]'), null, 'bare xpath');
  assert.equal(temporalTargetFor('a:hover'), null, 'unknown pseudo syntax');
});
```

- [ ] **Step 2: FAIL**, dann **Step 3: Implementieren**

`src/triage/temporal-target.js`:

```js
// Derives a css target the temporal delay style can address. Playwright-only
// engines cannot be expressed in css, but many real anchors are a css base
// plus an engine suffix (chains, :visible, :has-text). Hiding the css base
// also hides the anchored element, because visibility inherits to
// descendants. Returns null when no sufficiently specific base can be
// derived; delaying a broad target would provoke the wrong thing, so we
// abstain instead of guessing.
export function temporalTargetFor(selector) {
  let base = selector.split('>>')[0].trim();
  if (/^[a-z-]+=/i.test(base)) return null; // engine-prefixed: text=, role=, xpath=, id=
  if (base.startsWith('//') || base.startsWith('..')) return null; // bare xpath
  base = base.replace(/:(?:visible|hidden|enabled|disabled)\b/g, '');
  base = base.replace(/:(?:has-text|text-is|text|near|right-of|left-of|above|below)\((?:[^()"']|"[^"]*"|'[^']*')*\)/g, '');
  base = base.trim();
  if (!base) return null;
  // Anything with residual pseudo syntax we did not explicitly strip is a
  // reason to abstain; plain structural :nth-child/:nth-of-type is fine.
  if (base.replace(/:nth-(?:child|of-type)\(\d+\)/g, '').includes(':')) return null;
  // A bare tag would hide far more than the anchor; require a narrowing token.
  return /[#.[]/.test(base) || /:nth-(?:child|of-type)\(/.test(base) ? base : null;
}
```

`src/triage/engine.js` — `isCssAnchor` (Funktion und Aufruf) ersetzen:

```js
import { temporalTargetFor } from './temporal-target.js';
```

Im Temporal-Block:

```js
      let temporal = null;
      if (opts.temporal) {
        const target = temporalTargetFor(anchor.selector);
        if (!target) {
          notes.push('temporal probe skipped: no sufficiently specific css target can be derived from the anchor');
        } else {
          if (target !== anchor.selector) {
            notes.push(`temporal delay targets the css base "${target}" derived from the anchor`);
          }
          temporal = await temporalProbe(opts.rerunCommand, target);
          ...
```

(Note-Verzweigung aus Task 2 bleibt unverändert dahinter.) Die alte `isCssAnchor`-Definition löschen. Falls ein Test den alten Skip-Wortlaut (`the anchor is not a plain css selector`) asserted, auf den neuen Wortlaut umstellen (mit `grep -rn "plain css selector" test/` prüfen).

- [ ] **Step 4: PASS** (`npm test && npx eslint .`), dann **Step 5: Commit**

```bash
git add src/triage/temporal-target.js src/triage/engine.js test/temporal-target.test.js test/engine.test.js
git commit -m "feat: derive a css base so chained anchors can be probed"
```

---

### Task 4: Result-Konsistenz, Report-Marker, Unproven-Coverage, README

**Files:**
- Modify: `src/triage/engine.js` (temporal: null überall), `src/report.js` (Marker), `README.md` (Guard-Klausel)
- Test: `test/engine.test.js`, `test/cli.test.js`, `test/e2e-triage.test.js` (erweitern)

- [ ] **Step 1: Failing Tests schreiben**

`test/engine.test.js` — Shape-Konsistenz:

```js
test('every triage result carries a temporal field', async () => {
  const result = await triage({ errorText: 'AssertionError: Should Be Equal failed: A != B' });
  assert.equal(result.verdict, 'no-anchor');
  assert.ok('temporal' in result, 'json consumers need a stable shape');
  assert.equal(result.temporal, null);
});
```

`test/cli.test.js` — renderReport-Test: im bestehenden temporal-Testobjekt `reproduced: true, delay: 500` belassen und die Assertion verschärfen:

```js
  assert.ok(md.includes('- 500 ms: 2/2 runs failed (reproduces)'));
  assert.ok(!md.includes('- 250 ms: 0/2 runs failed (reproduces)'));
```

`test/e2e-triage.test.js` — Unproven-Pfad (Baseline als Current-Datei, kein currentUrl):

```js
test('fragile with a current file yields unproven candidates, honestly labeled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-e2e-'));
  const baselinePath = await baselineOfV1(dir);
  const v2 = await startFixtureServer({ root: join(fixtures, 'page-v2') });
  try {
    const currentPath = join(dir, 'current.json');
    await writeFile(currentPath, JSON.stringify(await captureSnapshot(v2.url)));
    const result = await triage({
      errorText: timeoutError('li.css-1a2b3c'),
      baselinePath,
      currentPath,
    });
    assert.equal(result.verdict, 'fragile');
    assert.ok(result.recommendation?.length, 'unproven candidates must still be offered');
    assert.equal(result.recommendation[0].survived, null);
    assert.ok(result.notes.some((n) => n.includes('approximated, not verified')));
    const md = renderReport(result);
    assert.ok(md.includes('| unknown |'), 'unproven rows must render with unknown uniqueness');
    assert.ok(!md.includes('No candidate survived proving'));
  } finally {
    await v2.close();
  }
});
```

(`renderReport` in die Imports der Datei aufnehmen.)

- [ ] **Step 2: FAIL**, dann **Step 3: Implementieren**

1. `src/triage/engine.js`: jedem Return-Objekt, das das Feld noch nicht trägt (no-anchor x2, alle unclear-Frühausstiege, das finale Return), `temporal: null` hinzufügen; im nondeterministic-Return bleibt die Variable.
2. `src/report.js` — Marker in der Timing-Zeile:

```js
    for (const t of r.temporal.tried) {
      const marker = r.temporal.reproduced && r.temporal.delay === t.delay ? ' (reproduces)' : '';
      lines.push(`- ${t.delay} ms: ${t.failures}/${t.runs} runs failed${marker}`);
    }
```

3. `README.md`, Abschnitt "Catching missing waits", nach dem Satz mit `likely a missing wait` einfügen:

```markdown
Two guards keep that claim honest: a control run without any delay must pass first (a baseline that already fails on its own aborts the probe instead of blaming timing), and the inject wrapper acknowledges every injection, so a missing setup is reported as exactly that rather than being mistaken for proof that timing is fine.
```

- [ ] **Step 4: PASS** (`npm test && npx eslint .`; README mit `grep -nP '—|[\x{1F300}-\x{1FAFF}]' README.md` stilprüfen), dann **Step 5: Commit**

```bash
git add src/triage/engine.js src/report.js README.md test/engine.test.js test/cli.test.js test/e2e-triage.test.js
git commit -m "fix: stable result shape, marked reproduction, unproven-path coverage"
```

---

### Task 5: Infra — exports-Test, Broken-Command-Erkennung, Test-Teardown-Härtung

**Files:**
- Create: `test/exports.test.js`
- Modify: `src/triage/rerun.js` (commandBroken), `src/triage/engine.js` (Note), Test-Teardown in `test/serialize.test.js`, `test/cosmetic.test.js`, `test/semantic.test.js`, `test/temporal.test.js`; mkdtemp-Cleanup in `test/rerun.test.js`, `test/temporal-probe.test.js`, `test/engine.test.js`, `test/cli.test.js`, `test/e2e-triage.test.js`, `test/inject.test.js`
- Test: `test/rerun.test.js` (commandBroken), `test/engine.test.js` (Broken-Note)

**Interfaces:**
- `rerunStats`-Rückgabe erweitert um `commandBroken: boolean` (wahr, wenn JEDER Lauf mit Spawn-Fehler (-1) oder command-not-found (127) endete)
- Engine: nach einem deterministisch roten Rerun mit `commandBroken` kommt die Note `every rerun exited with a spawn error or command-not-found; the rerun command itself looks broken and the rerun statistics are not meaningful`

- [ ] **Step 1: Failing Tests schreiben**

`test/exports.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Self-referencing imports resolve through the package.json exports map,
// which is exactly what the README tells users to copy. This locks that
// contract.
import { withTemporal } from 'flakeproof/inject';
import { triage } from 'flakeproof';

test('the documented package entry points resolve', () => {
  assert.equal(typeof withTemporal, 'function');
  assert.equal(typeof triage, 'function');
});
```

`test/rerun.test.js`:

```js
test('a command that cannot run at all is flagged as broken', async () => {
  const stats = await rerunStats('definitely-not-a-command-fp-2b', 2);
  assert.equal(stats.failures, 2);
  assert.equal(stats.commandBroken, true);
});

test('a genuinely failing test is not flagged as broken', async () => {
  const stats = await rerunStats('node -e "process.exit(1)"', 2);
  assert.equal(stats.commandBroken, false);
});
```

`test/engine.test.js`:

```js
test('a broken rerun command is named instead of trusted', async () => {
  const server = await startFixtureServer();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(server.url)));
    const result = await triage({
      errorText: timeoutError('#cta'),
      baselinePath,
      currentPath: baselinePath,
      rerunCommand: 'definitely-not-a-command-fp-2b',
      reruns: 2,
    });
    assert.ok(result.notes.some((n) => n.includes('looks broken')), JSON.stringify(result.notes));
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: FAIL**, dann **Step 3: Implementieren**

`src/triage/rerun.js` — vor dem Return:

```js
  const commandBroken = exitCodes.length > 0 && exitCodes.every((c) => c === -1 || c === 127);
  return { runs, failures, exitCodes, nondeterministic: failures > 0 && failures < runs, commandBroken };
```

`src/triage/engine.js` — die Deterministic-Note erweitern:

```js
    if (rerun.commandBroken) {
      notes.push('every rerun exited with a spawn error or command-not-found; the rerun command itself looks broken and the rerun statistics are not meaningful');
    } else {
      notes.push('test failed on every rerun; deterministic failure');
    }
```

**Teardown-Härtung** (gleicher Umbau in `test/serialize.test.js`, `test/cosmetic.test.js`, `test/semantic.test.js`, `test/temporal.test.js`): überall dort, wo `startFixtureServer()`/`chromium.launch()` VOR dem `try` stehen, so umbauen, dass ein Fehlschlag des zweiten Aufrufs den ersten nicht leaken kann:

```js
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    ...
  } finally {
    await browser?.close();
    await server?.close();
  }
```

**mkdtemp-Cleanup**: in allen Tests der genannten Dateien, die `mkdtemp` nutzen, das Verzeichnis in einer Variablen halten und im `finally` mit `await rm(dir, { recursive: true, force: true });` entfernen (`rm` aus `node:fs/promises` importieren). Wo ein Test bisher gar kein `try/finally` hat (reine Skript-Tests in rerun/temporal-probe), eines um den Testkörper legen.

- [ ] **Step 4: PASS** — volle Suite ZWEIMAL fahren (Teardown-Umbauten sind flakiness-sensibel), Lint sauber.

Run: `npm test && npm test && npx eslint .`

- [ ] **Step 5: Commit**

```bash
git add test/exports.test.js src/triage/rerun.js src/triage/engine.js test/rerun.test.js test/engine.test.js test/serialize.test.js test/cosmetic.test.js test/semantic.test.js test/temporal.test.js test/temporal-probe.test.js test/cli.test.js test/e2e-triage.test.js test/inject.test.js
git commit -m "chore: exports contract test, broken-command detection, test teardown hardening"
```

---

## Self-Review (durchgeführt)

- **Issue-#4-Abdeckung:** Scope 1 → Task 1; 2 → Task 2; 3 → Task 3; 4 → Task 4; 5 → Task 5. ✓
- **Typ-Konsistenz:** `temporalProbe`-Rückgabe `{ reproduced, delay, tried, control, injected }` konsistent in Task 2 (Probe, Engine, Tests) und im e2e; `temporalTargetFor` nur von Engine konsumiert; `commandBroken` in rerun+engine+Tests deckungsgleich; `provingMutations`-Default ändert keine `proveCandidates`-Signatur. ✓
- **Wechselwirkungen geprüft:** Task 2 (Ack) und Task 3 (Target-Ableitung) berühren denselben Engine-Block — Task 3 baut auf dem Task-2-Stand auf (Note-Verzweigung bleibt, nur der Guard davor wechselt). Der ACK-Scrub in rerunStats greift nicht für die Probe-Aufrufe, weil die Probe den Pfad explizit in `env` übergibt. Der Spike bleibt unberührt (Task 1 Step 4 verifiziert das ausdrücklich). ✓
- **Platzhalter:** keine (das eine `...` in Task 3 markiert bewusst den unveränderten Task-2-Block, dessen Code dort vollständig steht). ✓
