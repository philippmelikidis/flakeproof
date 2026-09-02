# Visueller HTML-Report und mehr Empfehlungen: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein visueller, in sich geschlossener HTML-Report, der ohne Vorwissen verständlich macht was passiert ist (Issue #5), plus eine neue Kandidatenart, damit anonyme Elemente mehr als nur einen Positionsselektor angeboten bekommen (Issue #6).

**Architecture:** Die Engine sammelt während des Durchlaufs ein optionales `detail` (Anker vorher/nachher inklusive HTML-Ausschnitt, Schritt-Log). Ein neues Modul `src/report-html.js` rendert daraus eine einzelne HTML-Datei mit inline CSS. Der bestehende Markdown-Report bleibt unverändert und ignoriert `detail`, damit alle 92 Tests grün bleiben.

**Tech Stack:** unverändert, keine neuen Dependencies. Node ≥ 20, ESM, `node:test`, Playwright.

## Global Constraints

- Node ≥ 20, `"type": "module"`, Testrunner `node:test`; **keine neuen Dependencies**
- Sämtliche Repo-Texte auf Englisch, ohne Emojis, ohne em dashes, natürlich geschrieben; nur Spec-/Plan-Dokumente deutsch
- **Commits ohne jede KI-/Claude-Erwähnung**
- Kernregel: **niemals raten** — Kandidaten außerhalb verifizierbarer Formen werden nicht angeboten (fail closed)
- Der HTML-Report ist **self-contained**: CSS inline, keine externen URLs, keine `<script>`-Tags
- Jeder in HTML eingebettete Wert aus Seiteninhalt muss escaped werden (der Report zeigt fremdes HTML an)
- Tests mit Browser/Server/mkdtemp: Aufräumen in `try/finally`
- Merge-Gate: `npm test` und `npx eslint .` grün/sauber nach jedem Task

## File Structure

```
src/triage/candidates.js   MODIFY  container-text Kandidat + Rangfolge
src/triage/engine.js       MODIFY  detail sammeln (Anker vorher/nachher, Schritte)
src/snapshot.js            MODIFY  outerHTML je Knoten optional mitschneiden
src/probe/serialize.js     MODIFY  html-Feld pro Knoten (begrenzt)
src/report-html.js         NEW     renderHtmlReport(result) -> string
bin/flakeproof.js          MODIFY  --out *.html, --open
README.md                  MODIFY  Report-Abschnitt
test/…                     neue und erweiterte Suiten
```

## Nicht Teil dieses Plans

Auto-Runner (#7), CI-Gate (#8), echte Element-Screenshots. Die bleiben eigene Zyklen.

---

### Task 1: container-text Kandidat

Ein anonymes `<li>` bekommt heute nur `#main-nav li:nth-child(1)` angeboten, also ausgerechnet die Form, die der Prover selbst beim Umsortieren scheitern sieht. Ein Container, der über den Text seines Kindes gebunden wird, überlebt sowohl Klassenwechsel als auch Umsortierung.

**Files:**
- Modify: `src/triage/candidates.js`
- Test: `test/candidates.test.js` (erweitern)

**Interfaces:**
- Produces: `candidatesFor` liefert zusätzlich Kandidaten der Art `'container-text'` mit Selektor `#<ancestorId> <tag>:has-text("<text>")`. Rangfolge im raw-Array: id, testid, aria, text, role, **container-text**, class, scoped, positional.

- [ ] **Step 1: Failing Tests schreiben**

In `test/candidates.test.js` anfügen (nutzt die vorhandenen Helfer `n`, `withPaths`):

```js
test('an anonymous element gets a container-text candidate from its unique child text', () => {
  const t = withPaths(
    n('html', {}, [
      n('body', {}, [
        n('nav', { id: 'main-nav' }, [
          n('ul', {}, [
            n('li', { classes: ['css-1a2b3c'] }, [n('a', { text: 'Products', attrs: { href: '/products/' } })]),
            n('li', { classes: ['css-9z8y7x'] }, [n('a', { text: 'Solutions', attrs: { href: '/solutions/' } })]),
          ]),
        ]),
      ]),
    ]),
  );
  const cands = candidatesFor(t, [0, 0, 0, 0]); // body > nav > ul > li(1)
  const ct = cands.find((c) => c.kind === 'container-text');
  assert.ok(ct, 'anonymous li must get a container-text candidate');
  assert.equal(ct.selector, '#main-nav li:has-text("Products")');
});

test('container-text is dropped when the child text is not unique', () => {
  const t = withPaths(
    n('html', {}, [
      n('body', {}, [
        n('nav', { id: 'main-nav' }, [
          n('ul', {}, [
            n('li', {}, [n('a', { text: 'Mehr', attrs: { href: '/a/' } })]),
            n('li', {}, [n('a', { text: 'Mehr', attrs: { href: '/b/' } })]),
          ]),
        ]),
      ]),
    ]),
  );
  const cands = candidatesFor(t, [0, 0, 0, 0]);
  assert.ok(!cands.some((c) => c.kind === 'container-text'), 'ambiguous child text must not become a candidate');
});

test('container-text ranks above positional', () => {
  const t = withPaths(
    n('html', {}, [
      n('body', {}, [
        n('nav', { id: 'main-nav' }, [
          n('ul', {}, [n('li', {}, [n('a', { text: 'Products', attrs: { href: '/products/' } })])]),
        ]),
      ]),
    ]),
  );
  const kinds = candidatesFor(t, [0, 0, 0, 0]).map((c) => c.kind);
  const ct = kinds.indexOf('container-text');
  const pos = kinds.indexOf('positional');
  assert.ok(ct !== -1 && pos !== -1, `expected both kinds, got ${kinds.join(', ')}`);
  assert.ok(ct < pos, 'container-text must rank above positional');
});
```

- [ ] **Step 2: Laufen lassen — FAIL**

Run: `npm test`
Erwartung: die drei neuen Tests scheitern, kein `container-text`-Kandidat.

- [ ] **Step 3: Implementieren**

In `src/triage/candidates.js` einen Zähl-Helfer neben `countByText` ergänzen:

```js
// How many elements in the tree have exactly one child carrying this text.
// Used to approximate the uniqueness of a container-text selector; the
// prover verifies it for real on the live page.
function countByChildText(tree, tag, text) {
  let count = 0;
  walk(tree, (node) => {
    if (node.tag !== tag) return;
    if (node.children.some((c) => c.text === text)) count += 1;
  });
  return count;
}
```

In `candidatesFor` direkt nach dem role-Kandidaten und vor `const stable = ...` einfügen:

```js
  // A container bound by its child's text. For an anonymous element (no id,
  // no own text) this is the only stable alternative to a positional
  // selector: it survives both class churn and reordering.
  const scope = [...ancestorsOf(tree, path)].reverse().find((a) => a.id);
  const childTexts = node.children.map((c) => c.text).filter(Boolean);
  if (!node.text && scope && childTexts.length === 1) {
    const ct = childTexts[0];
    if (ct.length <= 80 && !ct.includes('"')) {
      raw.push({ selector: `#${scope.id} ${node.tag}:has-text("${ct}")`, kind: 'container-text' });
    }
  }
```

Im Uniqueness-Filter am Ende der Funktion vor dem `queryTree`-Zweig ergänzen:

```js
    if (cand.kind === 'container-text') {
      const ct = node.children.map((c) => c.text).filter(Boolean)[0];
      return countByChildText(tree, node.tag, ct) === 1;
    }
```

Hinweis: `scopeAncestor` weiter unten in der Funktion bleibt unverändert bestehen; die neue Konstante heißt bewusst `scope`, um keine Deklaration zu überschreiben.

- [ ] **Step 4: Laufen lassen — PASS**, bestehende Kandidaten-Tests bleiben unverändert grün.

Run: `npm test && npx eslint .`

- [ ] **Step 5: Commit**

```bash
git add src/triage/candidates.js test/candidates.test.js
git commit -m "feat: container-text candidate for anonymous elements"
```

---

### Task 2: HTML-Ausschnitt je Knoten

Der Report soll den HTML-Ausschnitt des Ankers vorher und nachher zeigen. Dafür muss der Serializer pro Knoten ein begrenztes `html` mitschneiden.

**Files:**
- Modify: `src/probe/serialize.js`
- Test: `test/serialize.test.js` (erweitern)

**Interfaces:**
- Produces: Knotenform erweitert um `html: string` — das `outerHTML` des Elements, auf 400 Zeichen begrenzt, bei Überlänge mit ` ...` abgeschnitten.

- [ ] **Step 1: Failing Test schreiben**

In `test/serialize.test.js` anfügen (gleiches try/finally-Muster wie die bestehenden Tests):

```js
test('serializeDom captures a bounded html snippet per node', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(server.url);
    const snap = await page.evaluate(serializeDom, null);
    const cta = findNode(snap.tree, (x) => x.id === 'cta');
    assert.ok(cta.html.startsWith('<a'), `expected an anchor snippet, got ${cta.html}`);
    assert.ok(cta.html.includes('Contact us'));
    assert.ok(cta.html.length <= 404, 'snippet must stay bounded');
  } finally {
    await browser?.close();
    await server?.close();
  }
});
```

- [ ] **Step 2: FAIL** (`cta.html` ist undefined)

Run: `npm test`

- [ ] **Step 3: Implementieren**

In `src/probe/serialize.js` innerhalb von `serializeDom` (self-contained!) eine Konstante und im Rückgabeknoten ein Feld ergänzen. Nach `const MAX_TEXT = 120;`:

```js
  const MAX_HTML = 400;
```

Im Knoten nach `role`:

```js
      html: el.outerHTML.length > MAX_HTML ? el.outerHTML.slice(0, MAX_HTML) + ' ...' : el.outerHTML,
```

- [ ] **Step 4: PASS** (`npm test && npx eslint .`), dann **Step 5: Commit**

```bash
git add src/probe/serialize.js test/serialize.test.js
git commit -m "feat: bounded html snippet per serialized node"
```

---

### Task 3: Engine sammelt detail

**Files:**
- Modify: `src/triage/engine.js`
- Test: `test/engine.test.js` (erweitern)

**Interfaces:**
- Produces: jedes `triage()`-Ergebnis trägt `detail: { anchorBefore, anchorAfter, steps } | null`.
  - `anchorBefore` / `anchorAfter`: der serialisierte Knoten (inklusive `html`) oder `null`
  - `steps`: `Array<{ label: string, outcome: string, ok: boolean }>` in Ausführungsreihenfolge

- [ ] **Step 1: Failing Tests schreiben**

In `test/engine.test.js` anfügen:

```js
test('every result carries a step log', async () => {
  const result = await triage({ errorText: 'AssertionError: Should Be Equal failed: A != B' });
  assert.equal(result.verdict, 'no-anchor');
  assert.ok(result.detail, 'detail must be present');
  assert.ok(result.detail.steps.length >= 1, 'the anchor step must be logged');
  assert.equal(result.detail.steps[0].ok, false);
});

test('a fragile verdict records both anchor states and the proving step', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
  const baselinePath = await baselineOfV1(dir);
  const v2 = await startFixtureServer({ root: join(fixtures, 'page-v2') });
  try {
    const result = await triage({
      errorText: timeoutError('li.css-1a2b3c'),
      baselinePath,
      currentUrl: v2.url,
    });
    assert.equal(result.verdict, 'fragile');
    assert.equal(result.detail.anchorBefore.tag, 'li');
    assert.ok(result.detail.anchorBefore.html.includes('css-1a2b3c'));
    assert.ok(result.detail.anchorAfter, 'the matched element must be recorded');
    const labels = result.detail.steps.map((s) => s.label);
    assert.ok(labels.some((l) => /anchor/i.test(l)), `expected an anchor step, got ${labels.join(' | ')}`);
    assert.ok(labels.some((l) => /prov/i.test(l)), `expected a proving step, got ${labels.join(' | ')}`);
  } finally {
    await v2.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

Hinweis: `baselineOfV1`, `fixtures` und `timeoutError` existieren bereits in `test/e2e-triage.test.js`. Falls sie in `test/engine.test.js` fehlen, dort dieselben Helfer definieren (Baseline der Fixture-Seite v1 aufnehmen und als JSON ablegen) statt sie zu importieren, damit die Suiten unabhängig bleiben.

- [ ] **Step 2: FAIL** (`result.detail` ist undefined)

Run: `npm test`

- [ ] **Step 3: Implementieren**

In `src/triage/engine.js` am Anfang von `triage()` neben `const notes = []` ergänzen:

```js
  const steps = [];
  const step = (label, outcome, ok = true) => { steps.push({ label, outcome, ok }); };
  let anchorBefore = null;
  let anchorAfter = null;
  const detail = () => ({ anchorBefore, anchorAfter, steps });
```

Dann an den bestehenden Stellen protokollieren (die Verdict-Logik bleibt unverändert, es kommen nur `step(...)`-Aufrufe und `detail: detail()` in den Rückgaben dazu):

- nach `extractAnchor`: bei Erfolg `step('Anchor read from the error message', anchor.selector)`, bei `!anchor.selector` `step('Anchor read from the error message', 'no locator found in the error', false)`
- nach `resolveAnchorPath`: Erfolg `step('Anchor located in the baseline', 'found at path ' + resolved.path.join('.'))`, sonst mit `ok: false` und dem Grund
- nach dem Fidelity-Check: `step('Baseline html and tree checked for agreement', 'consistent')` bzw. mit `ok: false`
- nach `classifyDelta`: `anchorBefore = treeNode;` und wenn `classification.match?.path` gesetzt ist `anchorAfter = nodeAt(current.tree, classification.match.path);`, dazu `step('Compared baseline and current build at the anchor', classification.verdict)`
- im Empfehlungszweig nach `proveCandidates`: `step('Proved candidates in a real browser', recommendation.length + ' candidates tested')`; im Fallback-Zweig `step('Candidates checked against the baseline only', candidates.length + ' candidates, not proven', false)`
- im Rerun-Zweig: `step('Reran the failing test', rerun.failures + '/' + rerun.runs + ' runs failed')`, bei Temporal zusätzlich `step('Provoked a delay on the anchor', temporal.reproduced ? 'reproduced at ' + temporal.delay + ' ms' : 'no reproduction', temporal.reproduced)`

**Jedes** `return`-Objekt in `triage()` bekommt zusätzlich `detail: detail()`.

- [ ] **Step 4: PASS** (`npm test && npx eslint .`), dann **Step 5: Commit**

```bash
git add src/triage/engine.js test/engine.test.js
git commit -m "feat: engine records anchor states and a step log"
```

---

### Task 4: HTML-Report

**Files:**
- Create: `src/report-html.js`
- Test: `test/report-html.test.js`

**Interfaces:**
- Consumes: das `triage()`-Ergebnis inklusive `detail`
- Produces: `renderHtmlReport(result) -> string` — vollständiges HTML-Dokument, CSS inline, keine externen Ressourcen, keine Skripte

- [ ] **Step 1: Failing Tests schreiben**

`test/report-html.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHtmlReport } from '../src/report-html.js';

const fragile = {
  verdict: 'fragile',
  testId: 'Menu Test',
  anchor: { selector: 'li.css-1a2b3c', kind: 'timeout' },
  rerun: null,
  temporal: null,
  classification: {
    verdict: 'cosmetic',
    reasons: ['selector relies on build-generated class ".css-1a2b3c" which is gone from the element'],
  },
  recommendation: [
    { selector: '#main-nav li:has-text("Products")', kind: 'container-text', uniqueInCurrent: true, survived: 5, applied: 5 },
    { selector: '#main-nav li:nth-child(1)', kind: 'positional', uniqueInCurrent: true, survived: 4, applied: 5 },
  ],
  notes: ['test failed on every rerun; deterministic failure'],
  detail: {
    anchorBefore: { tag: 'li', id: null, classes: ['css-1a2b3c'], text: '', attrs: {}, html: '<li class="css-1a2b3c"><a href="/products/">Products</a></li>' },
    anchorAfter: { tag: 'li', id: null, classes: ['css-q1w2e3'], text: '', attrs: {}, html: '<li class="css-q1w2e3"><a href="/products/">Products</a></li>' },
    steps: [
      { label: 'Anchor read from the error message', outcome: 'li.css-1a2b3c', ok: true },
      { label: 'Proved candidates in a real browser', outcome: '2 candidates tested', ok: true },
    ],
  },
};

test('the report is a self-contained html document', () => {
  const html = renderHtmlReport(fragile);
  assert.ok(html.startsWith('<!doctype html>'), 'must be a full document');
  assert.ok(html.includes('<style>'), 'css must be inline');
  assert.ok(!/<script/i.test(html), 'no scripts allowed');
  assert.ok(!/https?:\/\//.test(html), 'no external resources allowed');
});

test('the report shows verdict, anchor, evidence and every recommendation', () => {
  const html = renderHtmlReport(fragile);
  assert.ok(html.includes('fragile'));
  assert.ok(html.includes('Menu Test'));
  assert.ok(html.includes('li.css-1a2b3c'));
  assert.ok(html.includes('build-generated class'));
  // both recommendations, not only the first
  assert.ok(html.includes(':has-text(&quot;Products&quot;)') || html.includes(':has-text("Products")'));
  assert.ok(html.includes('nth-child(1)'));
  assert.ok(html.includes('5/5') && html.includes('4/5'));
});

test('the report shows the before and after snippets and the steps', () => {
  const html = renderHtmlReport(fragile);
  assert.ok(html.includes('css-1a2b3c'), 'before snippet');
  assert.ok(html.includes('css-q1w2e3'), 'after snippet');
  assert.ok(html.includes('Anchor read from the error message'));
  assert.ok(html.includes('Proved candidates in a real browser'));
});

test('page content is escaped, never injected as live markup', () => {
  const evil = {
    ...fragile,
    detail: {
      ...fragile.detail,
      anchorBefore: { ...fragile.detail.anchorBefore, html: '<img src=x onerror="alert(1)">' },
    },
  };
  const html = renderHtmlReport(evil);
  assert.ok(!html.includes('<img src=x'), 'raw markup from the page must be escaped');
  assert.ok(html.includes('&lt;img'), 'the snippet is shown as text');
});

test('a verdict without detail still renders every mandatory section', () => {
  const bare = {
    verdict: 'no-anchor',
    testId: null,
    anchor: { selector: null, kind: 'assertion' },
    rerun: null,
    temporal: null,
    classification: null,
    recommendation: null,
    notes: ['no locator found in the error; cannot triage without an anchor'],
    detail: { anchorBefore: null, anchorAfter: null, steps: [{ label: 'Anchor read from the error message', outcome: 'no locator found', ok: false }] },
  };
  const html = renderHtmlReport(bare);
  assert.ok(html.includes('no-anchor'));
  assert.ok(html.includes('cannot triage without an anchor'));
  assert.ok(html.includes('Anchor read from the error message'));
});
```

- [ ] **Step 2: FAIL** (`Cannot find module .../report-html.js`)

Run: `npm test`

- [ ] **Step 3: Implementieren**

`src/report-html.js`:

```js
// Renders a triage result as a single self-contained html file: inline css,
// no external resources, no scripts. Everything taken from the page under
// test is escaped, because the report displays foreign markup as text.

const VERDICT_TEXT = {
  fragile: 'The test is fragile. The page is fine, the test hangs on something that changed without changing meaning.',
  'real-change': 'Something changed for real at this spot. Look at the application, not the test.',
  nondeterministic: 'The test does not fail consistently. Reruns disagree, so this is timing or state, not this commit.',
  unclear: 'The evidence is mixed or missing. flakeproof does not guess, so it says nothing rather than something wrong.',
  'no-anchor': 'The error names no locator, so there is nothing to compare against.',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Describes an element in plain language instead of attribute soup.
function describe(node) {
  if (!node) return 'This element does not exist here.';
  const parts = [`a &lt;${esc(node.tag)}&gt; element`];
  if (node.id) parts.push(`with the id "${esc(node.id)}"`);
  if (node.classes?.length) parts.push(`with the classes ${node.classes.map((c) => `"${esc(c)}"`).join(', ')}`);
  if (node.text) parts.push(`showing the text "${esc(node.text)}"`);
  if (node.attrs?.href) parts.push(`pointing at "${esc(node.attrs.href)}"`);
  return parts.join(', ');
}

// Marks the parts of `b` that differ from `a` word by word, so the reader can
// see what actually changed instead of comparing two blocks by eye.
function markDiff(a, b) {
  const left = String(a ?? '').split(/(\s+)/);
  const right = String(b ?? '').split(/(\s+)/);
  return right
    .map((tok) => (left.includes(tok) ? esc(tok) : `<mark>${esc(tok)}</mark>`))
    .join('');
}

const CSS = `
  :root { color-scheme: light; }
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0; padding: 32px 20px; background: #faf9f7; color: #2b2724; }
  main { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .05em;
       color: #7a736c; margin: 32px 0 10px; }
  .lead { font-size: 16px; color: #4a443f; margin: 0 0 4px; }
  .card { background: #fff; border: 1px solid #e6e1db; border-radius: 10px; padding: 14px 16px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .badge { display: inline-block; border-radius: 999px; padding: 3px 12px; font-weight: 600; font-size: 13px; }
  .fragile { background: #fdf0d5; color: #8a5a00; }
  .real-change { background: #fde2e1; color: #9b2c2c; }
  .nondeterministic { background: #e6e9fd; color: #3b4bab; }
  .unclear, .no-anchor { background: #ecebe9; color: #5b544e; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  pre { background: #f4f2ef; border: 1px solid #e6e1db; border-radius: 8px;
        padding: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; }
  mark { background: #ffe9a8; padding: 0 2px; border-radius: 3px; }
  ul.plain { list-style: none; padding: 0; margin: 0; }
  ul.plain li { padding: 8px 0; border-bottom: 1px solid #efece8; }
  ul.plain li:last-child { border-bottom: none; }
  .step-ok::before { content: "OK"; color: #1f7a4d; font-weight: 700; font-size: 11px; margin-right: 8px; }
  .step-no::before { content: "--"; color: #9b2c2c; font-weight: 700; font-size: 11px; margin-right: 8px; }
  .muted { color: #7a736c; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid #e6e1db; padding: 7px 9px; text-align: left; }
  th { background: #f4f2ef; }
  .rank { font-weight: 600; }
`;

function section(title, body) {
  return `<h2>${esc(title)}</h2>${body}`;
}

function beforeAfter(detail) {
  const before = detail?.anchorBefore;
  const after = detail?.anchorAfter;
  const card = (label, node, other) => `
    <div class="card">
      <div class="muted">${esc(label)}</div>
      <p>${describe(node)}</p>
      ${node ? `<pre>${other ? markDiff(other.html, node.html) : esc(node.html)}</pre>` : ''}
    </div>`;
  return `<div class="grid">
    ${card('Before, in the green build', before, null)}
    ${card('Now, in the current build', after, before)}
  </div>`;
}

function steps(detail) {
  const list = detail?.steps ?? [];
  if (!list.length) return '<p class="muted">No steps were recorded.</p>';
  return `<div class="card"><ul class="plain">${list
    .map(
      (s) =>
        `<li class="${s.ok ? 'step-ok' : 'step-no'}">${esc(s.label)}<br><span class="muted">${esc(s.outcome)}</span></li>`,
    )
    .join('')}</ul></div>`;
}

function recommendations(list) {
  if (!list?.length) return '<p class="muted">No recommendations for this verdict.</p>';
  const shown = list.filter((c) => c.survived === null || c.survived > 0 || c.uniqueInCurrent);
  if (!shown.length) return '<p class="muted">No candidate survived proving, so there is no safe recommendation.</p>';
  const rows = shown
    .map((c, i) => {
      const proof =
        c.survived === null
          ? 'not proven, no current url was given'
          : `survived ${c.survived} of ${c.applied} mutations`;
      const unique = c.uniqueInCurrent === null ? 'unknown' : c.uniqueInCurrent ? 'yes' : 'no';
      return `<tr><td class="rank">${i + 1}</td><td><code>${esc(c.selector)}</code></td><td>${esc(c.kind)}</td><td>${esc(unique)}</td><td>${esc(proof)}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>#</th><th>Selector</th><th>Kind</th><th>Unique</th><th>Proof</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function timing(temporal) {
  if (!temporal?.tried?.length) return '';
  const rows = temporal.tried
    .map(
      (t) =>
        `<tr><td>${esc(t.delay)} ms</td><td>${esc(t.failures)}/${esc(t.runs)} runs failed</td><td>${
          temporal.reproduced && temporal.delay === t.delay ? 'reproduces' : ''
        }</td></tr>`,
    )
    .join('');
  return section(
    'Timing provocation',
    `<table><thead><tr><th>Delay</th><th>Result</th><th></th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

export function renderHtmlReport(r) {
  const evidence = r.classification?.reasons?.length
    ? `<div class="card"><ul class="plain">${r.classification.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`
    : '<p class="muted">No classification evidence for this verdict.</p>';
  const notes = r.notes?.length
    ? section('Notes', `<div class="card"><ul class="plain">${r.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`)
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flakeproof triage</title>
<style>${CSS}</style></head>
<body><main>
  <h1><span class="badge ${esc(r.verdict)}">${esc(r.verdict)}</span></h1>
  <p class="lead">${esc(VERDICT_TEXT[r.verdict] ?? '')}</p>
  ${section(
    'The test',
    `<div class="card">
       <p>${r.testId ? `Test: <strong>${esc(r.testId)}</strong>` : 'The failing test was not named in the input.'}</p>
       <p>${r.anchor?.selector ? `It was waiting for <code>${esc(r.anchor.selector)}</code> (${esc(r.anchor.kind)}).` : 'The error names no locator.'}</p>
     </div>`,
  )}
  ${section('Before and after, at that exact spot', beforeAfter(r.detail))}
  ${section('Why this verdict', evidence)}
  ${section('What flakeproof did', steps(r.detail))}
  ${section('Recommended selectors', recommendations(r.recommendation))}
  ${timing(r.temporal)}
  ${notes}
</main></body></html>`;
}
```

- [ ] **Step 4: PASS** (`npm test && npx eslint .`), dann **Step 5: Commit**

```bash
git add src/report-html.js test/report-html.test.js
git commit -m "feat: self-contained html triage report"
```

---

### Task 5: CLI-Anbindung und README

**Files:**
- Modify: `bin/flakeproof.js`, `README.md`
- Test: `test/cli.test.js` (erweitern)

**Interfaces:**
- CLI: `--out <datei>` erzeugt HTML, wenn der Dateiname auf `.html` oder `.htm` endet, sonst Markdown wie bisher. `--open` öffnet die erzeugte Datei im Standardbrowser (nur zusammen mit `--out`).

- [ ] **Step 1: Failing Test schreiben**

In `test/cli.test.js` anfügen:

```js
test('cli writes a self-contained html report when the output ends in .html', async () => {
  const server = await startFixtureServer();
  const dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
  try {
    const baseline = join(dir, 'baseline.json');
    const errFile = join(dir, 'error.txt');
    const outFile = join(dir, 'report.html');
    await writeFile(errFile, "TimeoutError: locator.waitFor: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('#cta') to be visible");

    await run('node', ['bin/flakeproof.js', 'snapshot', server.url, '--out', baseline]);
    await run('node', ['bin/flakeproof.js', 'triage', '--baseline', baseline, '--error-file', errFile, '--current', baseline, '--out', outFile]);

    const html = await readFile(outFile, 'utf8');
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('What flakeproof did'));
    assert.ok(!/<script/i.test(html));
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

`readFile` und `rm` aus `node:fs/promises` in die Imports der Datei aufnehmen, falls sie fehlen.

- [ ] **Step 2: FAIL** (die Datei enthält Markdown, kein HTML)

Run: `npm test`

- [ ] **Step 3: Implementieren**

In `bin/flakeproof.js` den Import ergänzen:

```js
import { renderHtmlReport } from '../src/report-html.js';
```

Die Options-Map der triage-Unterkommandos um `open` erweitern:

```js
        open: { type: 'boolean', default: false },
```

Die Ausgabe-Auswahl ersetzen:

```js
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
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        spawn(opener, [values.out], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
      }
    } else {
      console.log(output);
    }
```

Dafür oben `import { spawn } from 'node:child_process';` ergänzen.

Die USAGE-Zeile erweitern zu:

```
                    [--rerun-cmd <command>] [--reruns <n>] [--temporal] [--json] [--out <file.md|file.html>] [--open]
```

- [ ] **Step 4: README aktualisieren**

Im Abschnitt "Red triage" nach dem Beispielreport einfügen:

```markdown
### A report you can actually read

The text report above is what lands in a CI log. For a human, ask for html instead:

    node bin/flakeproof.js triage --baseline baseline.json --error-file error.txt --current-url https://your-app.example --out report.html --open

That writes a single self-contained file (inline css, no scripts, no external resources) that spells out what happened: the verdict in plain words, the anchor element before and after with the difference highlighted, the evidence behind the verdict, every step flakeproof took, and all proven selector candidates ranked, not just the first one.
```

- [ ] **Step 5: PASS und Commit**

Run: `npm test && npx eslint . && grep -nP '—|[\x{1F300}-\x{1FAFF}]' README.md || echo "style ok"`

```bash
git add bin/flakeproof.js README.md test/cli.test.js
git commit -m "feat: html report output and open flag in the cli"
```

---

### Task 6: End-to-End-Beleg gegen echte Builds

**Files:**
- Test: `test/e2e-triage.test.js` (erweitern)

- [ ] **Step 1: Test schreiben**

```js
test('the html report of a real fragile run names both the container and the positional candidate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-e2e-'));
  const baselinePath = await baselineOfV1(dir);
  const v2 = await startFixtureServer({ root: join(fixtures, 'page-v2') });
  try {
    const result = await triage({
      errorText: timeoutError('li.css-1a2b3c'),
      baselinePath,
      currentUrl: v2.url,
    });
    assert.equal(result.verdict, 'fragile');
    const html = renderHtmlReport(result);
    assert.ok(html.includes('Before and after'), 'the before/after section must be present');
    assert.ok(html.includes('What flakeproof did'), 'the step log must be present');
    const kinds = result.recommendation.map((c) => c.kind);
    assert.ok(kinds.includes('container-text'), `expected a container-text candidate, got ${kinds.join(', ')}`);
    assert.ok(result.recommendation.length >= 2, 'more than one recommendation must be offered');
  } finally {
    await v2.close();
    await rm(dir, { recursive: true, force: true });
  }
});
```

`renderHtmlReport` in die Imports der Datei aufnehmen.

- [ ] **Step 2: Laufen lassen.** Erwartung: grün. Schlägt die `container-text`-Erwartung fehl, liegt es daran, dass das Fixture-`li` mehr als ein textführendes Kind hat oder der Text im aktuellen Build nicht eindeutig ist: dann die Ursache in `candidates.js` verstehen und dort beheben, nicht die Assertion abschwächen. Lässt sich der Kandidat aus einem echten Grund nicht erzeugen, im Report dokumentieren und DONE_WITH_CONCERNS melden.

Run: `npm test && npx eslint .`

- [ ] **Step 3: Commit**

```bash
git add test/e2e-triage.test.js
git commit -m "test: end-to-end html report and multiple candidates"
```

---

## Self-Review (durchgeführt)

- **Spec-Abdeckung:** Feature 1 (container-text, Rangfolge, alle Überlebenden im Report) → Tasks 1, 4, 6. Feature 2 (Abschnitte 1 bis 7, self-contained, CLI `--out`/`--open`, `detail`-Datenfluss, Fehlerfälle) → Tasks 2, 3, 4, 5. Erfolgskriterium (ohne Vorwissen verständlich) → Klartext-Urteil und `describe()` in Task 4.
- **Typ-Konsistenz:** `detail: { anchorBefore, anchorAfter, steps }` in Task 3 definiert, in Task 4 und 6 konsumiert; `html` je Knoten in Task 2 definiert, in Task 4 (`markDiff`, `pre`) genutzt; Kandidatenart heißt durchgehend `container-text`.
- **Platzhalter:** keine.
- **Sicherheit:** Fremdes Markup wird ausschließlich escaped ausgegeben (`esc` in `describe`, `markDiff`, allen Zellen); dafür gibt es in Task 4 einen expliziten Test.
