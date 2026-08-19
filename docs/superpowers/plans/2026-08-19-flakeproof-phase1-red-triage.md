# flakeproof Phase 1 (Red-Triage-MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein nutzbares CLI (`flakeproof snapshot` / `flakeproof triage`), das für einen roten Testlauf beantwortet: echte Regression, fragiler Test oder nichtdeterministisch — und bei Fragilität einen bewiesenen Selektor-Vorschlag liefert. (Issue #2)

**Architecture:** Baut direkt auf den Phase-0-Bausteinen auf (Serializer, Kataloge, Anker-Extraktion, Matcher, Klassifikator). Neu: ein Localitäts-Term im Matcher (behebt den Duplikat-DOM-Befund aus dem Phase-0-Final-Review), ein Kandidaten-Generator mit begrenzter, selbst verifizierbarer Selektor-Grammatik, ein Browser-Prover, der Kandidaten gegen den kosmetischen Katalog beweist, und eine Triage-Engine, die alles orchestriert. Baselines speichern Baum **und** rohes HTML, damit der Anker zur Triage-Zeit mit Playwright-Selektor-Syntax aufgelöst werden kann (zur Capture-Zeit ist der fehlschlagende Selektor noch unbekannt).

**Tech Stack:** unverändert — Node ≥ 20 (ESM, `node:test`), Playwright, `fast-xml-parser`. CLI über `node:util` `parseArgs`, **keine neuen Dependencies**.

## Global Constraints

- Node ≥ 20, `"type": "module"`, Testrunner `node:test` — keine weiteren Test-Frameworks
- **Keine neuen Dependencies.** Vorhanden: `playwright`, `@playwright/test`, `fast-xml-parser` + Lint-Tooling (`eslint`, `@eslint/js`, `globals`), alle dev
- Sämtliche Repo-Texte (Code, Kommentare, Commit-Messages, README, Berichte) auf Englisch, ohne Emojis, ohne em dashes, natürlich geschrieben; nur Spec-/Plan-Dokumente deutsch
- **Commits ohne jede KI-/Claude-Erwähnung** (kein `Co-Authored-By`, keine "Generated with"-Zeile)
- Browser-injizierte Funktionen (`markTarget`, `checkCandidate`, der von `temporalScript` erzeugte Code) müssen self-contained sein: keine Closures über Modul-Scope
- Kernregel aus der Spec: **niemals raten** — gemischte oder fehlende Evidenz ergibt `unclear`; nichts wird stillschweigend weggelassen
- Merge-Gate: `npm test` und `npx eslint .` müssen nach jedem Task grün/sauber sein
- Tests, die Browser oder Server starten, kapseln Aufräumarbeit in `try/finally` (Muster aus `test/serialize.test.js` übernehmen) — ein roter Test darf die Suite nicht hängen lassen

## File Structure

```
src/probe/serialize.js        MODIFY  role-Feld (explizit + implizite Mini-Map)
src/probe/temporal.js         NEW     temporalScript(selector, ms) -> Init-Script-String
src/triage/match.js           MODIFY  role-Gewicht + Localitäts-Term
src/triage/tree.js            MODIFY  ancestorsOf hierher (aus classify.js)
src/triage/classify.js        MODIFY  HASHED_CLASS exportieren, ancestorsOf importieren, match.path zurückgeben
src/triage/candidates.js      NEW     candidatesFor + queryTree (begrenzte Grammatik)
src/triage/prove.js           NEW     proveCandidates (Browser)
src/triage/rerun.js           NEW     rerunStats (Shell-Kommando n-mal)
src/triage/engine.js          NEW     triage() orchestriert alles
src/snapshot.js               NEW     captureSnapshot (tree + html + url)
src/report.js                 NEW     renderReport (Markdown)
bin/flakeproof.js             NEW     CLI (snapshot | triage)
test/fixtures/page-v2/…       NEW     kosmetischer Build (Hashes umbenannt, CTA gewrappt)
test/fixtures/page-v3/…       NEW     semantischer Build (CTA-Text geändert, ein li entfernt)
test/helpers/serve.js         MODIFY  root-Parameter
test/…                        neue Suiten pro Modul
```

## Nicht Teil dieses Plans

Framework-Adapter mit `injectBeforeLoad`-Integration in fremde Testläufe, temporale Provokation im Lauf des Nutzers, CI-Artefakt-Plumbing, Notenvergabe (Phase 2), weitere Framework-Adapter. Das Issue #2 listet dieselbe Abgrenzung.

Hinweis zu Issue-Punkt 9 (Validierung über die Live-Pairs): erledigt Task 1 mit — der Spike-Messlauf über die 12 committeten Live-Pairs wird dort mit dem verbesserten Matcher neu gefahren und der Bericht neu committet.

---

### Task 1: Matcher-Localität und role-Scoring

Behebt den zentralen Phase-0-Carry-Over: Auf Seiten mit duplizierten DOM-Regionen (hell/dunkel-Header) erobert der unversehrte Zwilling den Match und neutralisiert semantische Evidenz. Ein Localitäts-Term (gemeinsames Pfad-Präfix) bevorzugt Elemente derselben Region und hebt zugleich identitätsschwache Elemente (nacktes `<li>`) über die Match-Schwelle.

**Achtung, Localität allein reicht nicht:** Wird ein Element entfernt, rutscht sein Geschwister an dieselbe Position und erbt den vollen Localitäts-Bonus — der Matcher würde den aufgerückten Nachbarn selbstbewusst matchen und die Entfernung als kosmetisch fehlklassifizieren. Deshalb kommt zusätzlich eine **Kind-Signatur** in den Score (Texte/hrefs der direkten Kinder): gleiche Kinder stützen den Match, komplett fremde Kinder bestrafen ihn. Ein `<li>` mit dem Kind "Products" ist dann nicht mit dem Nachbarn mit dem Kind "Solutions" verwechselbar.

**Files:**
- Modify: `src/probe/serialize.js` (role-Feld), `src/triage/match.js` (Gewichte + Localität)
- Test: `test/match.test.js` (erweitern), `test/serialize.test.js` (erweitern)
- Regenerate: `spikes/phase0-report.md` (Messlauf mit neuem Matcher)

**Interfaces:**
- Consumes: bestehende Knotenform `{ tag, id, classes[], attrs{}, text, name, path[], children[] }`
- Produces: Knotenform erweitert um `role: string` (leer wenn keins); `similarity(a, b)` berücksichtigt `role` (Gewicht 1), Localität (max. 3, Anteil gemeinsames Pfad-Präfix) und Kind-Signaturen (max. +3 bei gleichen Kindern, -2 bei komplett fremden Kindern, -1 wenn nur eine Seite Kinder hat); `findBestMatch`-Signatur unverändert

- [x] **Step 1: Failing Tests schreiben**

In `test/match.test.js` den `n()`-Helper um `role: ''` in den Defaults ergänzen und diese Tests anfügen:

```js
test('matching explicit role adds to the score', () => {
  const a = n('div', { role: 'dialog' });
  const b = n('div', { role: 'dialog' });
  const c = n('div', {});
  assert.ok(similarity(a, b) > similarity(a, c));
});

test('locality prefers the element in the same region over a distant twin', () => {
  const target = n('a', { text: 'Products', attrs: { href: '/products/' }, path: [0, 0, 1, 0, 0] });
  const tree = withPaths(
    n('body', {}, [
      n('header', {}, [
        n('div', {}, [
          n('ul', {}, [n('li', {}, [n('a', { text: 'Products', attrs: { href: '/products/' } })])]),
        ]),
      ]),
      n('footer', {}, [
        n('ul', {}, [n('li', {}, [n('a', { text: 'Products', attrs: { href: '/products/' } })])]),
      ]),
    ]),
  );
  const match = findBestMatch(tree, target);
  assert.ok(match, 'must find a match');
  assert.equal(match.node.path[0], 0, 'must pick the header copy, not the footer twin');
});

test('weak-identity element is re-identified via locality', () => {
  // Bare li (tag + classes only) used to cap at score 4 and never match.
  const target = n('li', { classes: ['css-1a2b3c', 'nav-item'], path: [0, 0, 0, 0] });
  const tree = withPaths(
    n('body', {}, [
      n('header', {}, [
        n('nav', {}, [
          n('ul', {}, [
            n('li', { classes: ['css-1a2b3c', 'fp-added', 'nav-item'] }),
            n('li', { classes: ['css-9z8y7x', 'nav-item'] }),
          ]),
        ]),
      ]),
    ]),
  );
  const match = findBestMatch(tree, target);
  assert.ok(match, 'locality must lift the true element above the threshold');
  assert.ok(match.node.classes.includes('fp-added'));
});

test('a sibling sliding into the removed element position is not mistaken for it', () => {
  // Removal scenario: the target li (child "Products") is gone; its sibling
  // (child "Solutions") now sits at the exact same path and would inherit
  // the full locality bonus. The child signature must veto that match.
  const target = n(
    'li',
    { classes: ['css-1a2b3c', 'nav-item'], path: [0, 0, 0, 0] },
    [n('a', { text: 'Products', attrs: { href: '/products/' } })],
  );
  const tree = withPaths(
    n('body', {}, [
      n('header', {}, [
        n('nav', {}, [
          n('ul', {}, [
            n('li', { classes: ['css-9z8y7x', 'nav-item'] }, [
              n('a', { text: 'Solutions', attrs: { href: '/solutions/' } }),
            ]),
            n('li', { classes: ['css-4d5e6f', 'nav-item'] }, [
              n('a', { text: 'Company', attrs: { href: '/company/' } }),
            ]),
          ]),
        ]),
      ]),
    ]),
  );
  assert.equal(findBestMatch(tree, target), null, 'no confident match may exist after removal');
});
```

In `test/serialize.test.js` anfügen (gleiches `try/finally`-Muster wie die bestehenden Tests):

```js
test('serializeDom emits explicit and implicit roles', async () => {
  const server = await startFixtureServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    const snap = await page.evaluate(serializeDom, null);
    const nav = findNode(snap.tree, (x) => x.tag === 'nav');
    assert.equal(nav.role, 'navigation');
    const cta = findNode(snap.tree, (x) => x.id === 'cta');
    assert.equal(cta.role, 'link');
  } finally {
    await browser.close();
    await server.close();
  }
});
```

- [x] **Step 2: Laufen lassen — FAIL** (role undefined, Twin gewinnt, li matcht nicht)

Run: `npm test`

- [x] **Step 3: Implementieren**

`src/probe/serialize.js` — in `serializeDom` (self-contained!) vor `serialize` einfügen und den Rückgabeknoten erweitern:

```js
  const IMPLICIT_ROLES = {
    a: 'link', button: 'button', nav: 'navigation', header: 'banner',
    footer: 'contentinfo', main: 'main', ul: 'list', ol: 'list',
    li: 'listitem', img: 'img', form: 'form', table: 'table',
  };
```

Im Knoten nach `name`:

```js
      role: el.getAttribute('role') || IMPLICIT_ROLES[el.tagName.toLowerCase()] || '',
```

`src/triage/match.js` — Gewichte, Localität und Kind-Signaturen:

```js
const WEIGHTS = { tag: 2, id: 3, text: 3, name: 2, href: 2, classOverlap: 2, role: 1, locality: 3, children: 3 };
const CHILD_MISMATCH_PENALTY = 2;
const CHILD_ONESIDED_PENALTY = 1;
```

Neue Funktionen:

```js
// Shared path prefix as a fraction of the deeper path. Elements in the same
// DOM region share most of their path; a twin in a duplicated region shares
// almost none. This is what keeps duplicated headers from capturing the match.
function localityBonus(aPath, bPath) {
  if (aPath.length === 0 || bPath.length === 0) return 0;
  let shared = 0;
  const limit = Math.min(aPath.length, bPath.length);
  while (shared < limit && aPath[shared] === bPath[shared]) shared += 1;
  return WEIGHTS.locality * (shared / Math.max(aPath.length, bPath.length));
}

// What a node's direct children say about its identity: their text, or
// failing that their href, or failing that their tag. Locality alone cannot
// tell a removed element from the sibling that slid into its position; the
// children can ("Products" vs "Solutions").
function childSignature(node) {
  return node.children.slice(0, 8).map((c) => c.text || c.attrs.href || c.tag);
}

function childrenScore(a, b) {
  const sigA = childSignature(a);
  const sigB = childSignature(b);
  if (sigA.length === 0 && sigB.length === 0) return 0;
  if (sigA.length === 0 || sigB.length === 0) return -CHILD_ONESIDED_PENALTY;
  const j = jaccard(sigA, sigB);
  return j > 0 ? WEIGHTS.children * j : -CHILD_MISMATCH_PENALTY;
}
```

In `similarity` nach der `classOverlap`-Zeile:

```js
  if (a.role && a.role === b.role) score += WEIGHTS.role;
  score += localityBonus(a.path, b.path);
  score += childrenScore(a, b);
```

- [x] **Step 4: Laufen lassen — alle Tests PASS** (bestehende Suiten müssen unverändert grün bleiben; die klassifikator-relevanten Erwartungen ändern sich nicht, weil die drei neuen Punkte nur den Match selbst betreffen)

Run: `npm test && npx eslint .`

- [x] **Step 5: Spike-Messlauf mit neuem Matcher**

Run: `npm run spike`
Expected: Exit 0, **0 Fehlklassifikationen** (hartes Kriterium), unclear-Zahl sinkt gegenüber 25 (der Localitäts-Term identifiziert die schwachen li- und Live-CTA-Fälle jetzt teilweise korrekt). Die Checkpoint-Sektion bleibt erhalten (der Generator bewahrt sie seit dem Phase-0-Fix). Taucht eine Fehlklassifikation auf: STOPP, nicht committen, als BLOCKED eskalieren mit der Konfusionsmatrix.

- [x] **Step 6: Commit**

```bash
git add src/probe/serialize.js src/triage/match.js test/match.test.js test/serialize.test.js spikes/phase0-report.md
git commit -m "feat: locality and role scoring in element matcher"
```

---

### Task 2: Selektor-Kandidaten-Generator mit verifizierbarer Grammatik

**Files:**
- Create: `src/triage/candidates.js`
- Modify: `src/triage/tree.js` (`ancestorsOf` hierher), `src/triage/classify.js` (`HASHED_CLASS` exportieren, `ancestorsOf` importieren statt lokal)
- Test: `test/candidates.test.js`

**Interfaces:**
- Consumes: `nodeAt`, `walk`, neu `ancestorsOf(tree, path) -> node[]` (Wurzel bis Elternknoten, exklusive Ziel)
- Produces: `queryTree(tree, selector) -> node[] | null` (null = Selektor außerhalb der Grammatik); `candidatesFor(tree, path) -> Array<{ selector, kind: 'id'|'testid'|'aria'|'class'|'scoped'|'positional' }>` — nur Kandidaten, die im Baum eindeutig genau das Zielelement treffen
- Grammatik: compound = `[tag][#id][.class …][[attr="value"]][:nth-child(n)]`; Selektor = 1..n compounds mit Descendant-Kombinator (Leerzeichen)

- [x] **Step 1: Failing Tests schreiben**

`test/candidates.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryTree, candidatesFor } from '../src/triage/candidates.js';

function n(tag, props = {}, children = []) {
  return {
    tag, id: null, classes: [], attrs: {}, text: '', name: '', role: '', path: [],
    ...props, children,
  };
}
function withPaths(node, path = []) {
  node.path = path;
  node.children.forEach((c, i) => withPaths(c, path.concat(i)));
  return node;
}

const tree = () =>
  withPaths(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('nav', {}, [
            n('ul', { id: 'main-nav' }, [
              n('li', { classes: ['css-1a2b3c', 'nav-item'] }, [n('a', { text: 'Products', attrs: { href: '/products/' } })]),
              n('li', { classes: ['css-9z8y7x', 'nav-item'] }, [n('a', { text: 'Solutions', attrs: { href: '/solutions/' } })]),
            ]),
          ]),
          n('a', { id: 'cta', classes: ['btn'], text: 'Contact us', attrs: { href: '/contact/', 'data-testid': 'cta-button' } }),
        ]),
      ]),
    ]),
  );

test('queryTree resolves supported selector forms', () => {
  const t = tree();
  assert.equal(queryTree(t, '#cta').length, 1);
  assert.equal(queryTree(t, 'li.nav-item').length, 2);
  assert.equal(queryTree(t, '#main-nav li.nav-item').length, 2);
  assert.equal(queryTree(t, '#main-nav li:nth-child(2)').length, 1);
  assert.equal(queryTree(t, '[data-testid="cta-button"]').length, 1);
  assert.equal(queryTree(t, '#site-header a.btn').length, 1);
  assert.equal(queryTree(t, 'a:hover'), null, 'unsupported syntax must return null, not guess');
});

test('candidatesFor prefers id and testid, drops non-unique candidates', () => {
  const t = tree();
  const ctaPath = [0, 0, 1]; // body > header > a#cta
  const cands = candidatesFor(t, ctaPath);
  const selectors = cands.map((c) => c.selector);
  assert.ok(selectors.includes('#cta'));
  assert.ok(selectors.includes('[data-testid="cta-button"]'));
  assert.ok(selectors.includes('a.btn'));
  assert.ok(!selectors.some((s) => s === '#site-header a'), 'non-unique candidates must be dropped');
  assert.equal(cands[0].kind, 'id', 'id candidate ranks first');
});

test('candidatesFor falls back to a positional candidate for anonymous elements', () => {
  const t = tree();
  const liPath = [0, 0, 0, 0, 0]; // body > header > nav > ul > li(1)
  const cands = candidatesFor(t, liPath);
  assert.deepEqual(cands.map((c) => c.selector), ['#main-nav li:nth-child(1)']);
  assert.equal(cands[0].kind, 'positional');
});
```

- [x] **Step 2: Laufen lassen — FAIL** (`Cannot find module .../candidates.js`)

- [x] **Step 3: Refactor und Implementierung**

`src/triage/tree.js` — anfügen:

```js
// Ancestor nodes along a path, from the root down to the parent of the node
// at `path` (the node itself is excluded).
export function ancestorsOf(tree, path) {
  const out = [];
  let node = tree;
  for (const i of path) {
    out.push(node);
    node = node.children?.[i];
    if (!node) break;
  }
  return out;
}
```

`src/triage/classify.js` — die lokale `ancestorsOf`-Funktion löschen, stattdessen importieren, und `HASHED_CLASS` exportieren:

```js
import { nodeAt, findNode, ancestorsOf } from './tree.js';
```

```js
export const HASHED_CLASS =
  /^(?:css|sc|jsx|svelte)-[a-z0-9]+$|^_?ng(?:content|host)-|^[a-z][\w-]*__[a-z0-9]{5,}$/i;
```

`src/triage/candidates.js`:

```js
// Generates selector candidates for a node in a serialized tree and checks
// them for uniqueness with a deliberately small query grammar. Only what the
// grammar can verify becomes a candidate; everything else is not offered.
import { nodeAt, walk, ancestorsOf } from './tree.js';
import { HASHED_CLASS } from './classify.js';

function parseCompound(part) {
  const c = { tag: null, id: null, classes: [], attr: null, nth: null };
  let rest = part;
  const tag = rest.match(/^[a-z][\w-]*/i);
  if (tag) {
    c.tag = tag[0].toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    let m;
    if ((m = rest.match(/^#([\w-]+)/))) c.id = m[1];
    else if ((m = rest.match(/^\.([\w-]+)/))) c.classes.push(m[1]);
    else if ((m = rest.match(/^\[([\w-]+)="([^"]*)"\]/))) c.attr = { name: m[1], value: m[2] };
    else if ((m = rest.match(/^:nth-child\((\d+)\)/))) c.nth = Number(m[1]);
    else return null; // outside the supported grammar
    rest = rest.slice(m[0].length);
  }
  return c;
}

function matchesCompound(node, c) {
  if (c.tag && node.tag !== c.tag) return false;
  if (c.id && node.id !== c.id) return false;
  for (const cls of c.classes) if (!node.classes.includes(cls)) return false;
  if (c.attr && node.attrs[c.attr.name] !== c.attr.value) return false;
  if (c.nth !== null && node.path.at(-1) !== c.nth - 1) return false;
  return true;
}

export function queryTree(tree, selector) {
  const parts = selector.trim().split(/\s+/).map(parseCompound);
  if (parts.some((p) => p === null)) return null;
  const out = [];
  walk(tree, (node) => {
    if (!matchesCompound(node, parts.at(-1))) return;
    if (parts.length === 1) {
      out.push(node);
      return;
    }
    // Every earlier part must match some ancestor, in document order.
    const ancestors = ancestorsOf(tree, node.path);
    let pi = 0;
    for (const anc of ancestors) {
      if (pi < parts.length - 1 && matchesCompound(anc, parts[pi])) pi += 1;
    }
    if (pi >= parts.length - 1) out.push(node);
  });
  return out;
}

export function candidatesFor(tree, path) {
  const node = nodeAt(tree, path);
  if (!node) return [];
  const raw = [];
  if (node.id) raw.push({ selector: `#${node.id}`, kind: 'id' });
  if (node.attrs['data-testid']) {
    raw.push({ selector: `[data-testid="${node.attrs['data-testid']}"]`, kind: 'testid' });
  }
  if (node.attrs['aria-label']) {
    raw.push({ selector: `${node.tag}[aria-label="${node.attrs['aria-label']}"]`, kind: 'aria' });
  }
  const stable = node.classes.filter((c) => !HASHED_CLASS.test(c));
  for (const cls of stable) raw.push({ selector: `${node.tag}.${cls}`, kind: 'class' });

  const scopeAncestor = [...ancestorsOf(tree, path)].reverse().find((a) => a.id);
  if (scopeAncestor) {
    raw.push({ selector: `#${scopeAncestor.id} ${node.tag}`, kind: 'scoped' });
    for (const cls of stable) raw.push({ selector: `#${scopeAncestor.id} ${node.tag}.${cls}`, kind: 'scoped' });
    raw.push({
      selector: `#${scopeAncestor.id} ${node.tag}:nth-child(${node.path.at(-1) + 1})`,
      kind: 'positional',
    });
  }

  const seen = new Set();
  return raw.filter((cand) => {
    if (seen.has(cand.selector)) return false;
    seen.add(cand.selector);
    const hits = queryTree(tree, cand.selector);
    return hits !== null && hits.length === 1 && hits[0] === node;
  });
}
```

- [x] **Step 4: Laufen lassen — PASS** (inkl. aller bestehenden Suiten: der classify-Refactor darf nichts ändern)

Run: `npm test && npx eslint .`

- [x] **Step 5: Commit**

```bash
git add src/triage/candidates.js src/triage/tree.js src/triage/classify.js test/candidates.test.js
git commit -m "feat: selector candidate generation with tree-verified uniqueness"
```

---

### Task 3: Selektor-Prover im Browser

Beweist Kandidaten statt sie zu behaupten: Jede kosmetische Mutation wird auf das Zielelement angewandt; ein Kandidat überlebt, wenn er danach noch genau das markierte Element trifft.

**Files:**
- Create: `src/triage/prove.js`
- Test: `test/prove.test.js`

**Interfaces:**
- Consumes: `cosmeticMutations` (Katalog), `candidatesFor`, `serializeDom`, `startFixtureServer`
- Produces: `proveCandidates(url, anchorPath, candidates, { mutations = cosmeticMutations } = {}) -> Promise<Array<{ selector, kind, uniqueAtBaseline: boolean, survived: number, applied: number }>>`, absteigend sortiert nach (uniqueAtBaseline, survived). Nicht anwendbare Mutationen zählen nicht in `applied` (nichts wird stillschweigend verrechnet — `applied` weist die echte Basis aus)

- [x] **Step 1: Failing Test schreiben**

`test/prove.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { serializeDom } from '../src/probe/serialize.js';
import { candidatesFor } from '../src/triage/candidates.js';
import { proveCandidates } from '../src/triage/prove.js';

async function anchorPathFor(url, selector) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url);
    return await page.evaluate(serializeDom, selector);
  } finally {
    await browser.close();
  }
}

test('id candidate survives every applicable cosmetic mutation', async () => {
  const server = await startFixtureServer();
  try {
    const snap = await anchorPathFor(server.url, '#cta');
    const candidates = candidatesFor(snap.tree, snap.anchorPath);
    const proven = await proveCandidates(server.url, snap.anchorPath, candidates);
    const top = proven[0];
    assert.equal(top.selector, '#cta');
    assert.equal(top.uniqueAtBaseline, true);
    assert.ok(top.applied >= 3, `expected at least 3 applicable mutations, got ${top.applied}`);
    assert.equal(top.survived, top.applied);
  } finally {
    await server.close();
  }
});

test('positional candidate survives renames but not reordering', async () => {
  const server = await startFixtureServer();
  try {
    const snap = await anchorPathFor(server.url, 'li.css-1a2b3c');
    const candidates = candidatesFor(snap.tree, snap.anchorPath);
    const proven = await proveCandidates(server.url, snap.anchorPath, candidates);
    const positional = proven.find((c) => c.selector === '#main-nav li:nth-child(1)');
    assert.ok(positional, 'positional candidate must exist for the anonymous li');
    assert.equal(positional.applied, 5);
    assert.equal(positional.survived, 4, 'move-to-end must defeat the positional candidate');
  } finally {
    await server.close();
  }
});
```

- [x] **Step 2: Laufen lassen — FAIL** (`Cannot find module .../prove.js`)

- [x] **Step 3: Implementieren**

`src/triage/prove.js`:

```js
// Proves selector candidates against the cosmetic mutation catalog in a real
// browser: mark the target, apply one mutation, then check that a candidate
// still resolves to exactly the marked element.
import { chromium } from 'playwright';
import { cosmeticMutations } from '../probe/catalogs/cosmetic.js';

// Runs inside the page. Self-contained.
function markTarget(path) {
  let el = document.documentElement;
  for (const i of path) {
    el = el.children[i];
    if (!el) return false;
  }
  el.setAttribute('data-fp-target', '1');
  return true;
}

// Runs inside the page. Self-contained.
function checkCandidate(selector) {
  let els;
  try {
    els = [...document.querySelectorAll(selector)];
  } catch {
    return { hit: false };
  }
  return { hit: els.length === 1 && els[0].getAttribute('data-fp-target') === '1' };
}

export async function proveCandidates(url, anchorPath, candidates, { mutations = cosmeticMutations } = {}) {
  const browser = await chromium.launch();
  try {
    const results = candidates.map((c) => ({ ...c, uniqueAtBaseline: false, survived: 0, applied: 0 }));

    const withPage = async (fn) => {
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const marked = await page.evaluate(markTarget, anchorPath);
        if (!marked) throw new Error(`anchor path [${anchorPath}] does not resolve on ${url}`);
        return await fn(page);
      } finally {
        await page.close();
      }
    };

    // Uniqueness on the unmutated page.
    await withPage(async (page) => {
      for (const r of results) {
        const { hit } = await page.evaluate(checkCandidate, r.selector);
        r.uniqueAtBaseline = hit;
      }
    });

    for (const mutation of mutations) {
      await withPage(async (page) => {
        const applied = await page.evaluate(mutation.apply, '[data-fp-target]');
        if (!applied) return; // not applicable to this element; excluded from `applied`
        for (const r of results) {
          const { hit } = await page.evaluate(checkCandidate, r.selector);
          r.applied += 1;
          if (hit) r.survived += 1;
        }
      });
    }

    return results.sort(
      (x, y) => Number(y.uniqueAtBaseline) - Number(x.uniqueAtBaseline) || y.survived - x.survived,
    );
  } finally {
    await browser.close();
  }
}
```

- [x] **Step 4: Laufen lassen — PASS.** Weichen die erwarteten Zahlen (z. B. `applied`) von der Realität ab: erst verstehen, welche Mutation auf dem Element greift, dann die Assertion an die Realität anpassen und die Abweichung im Report dokumentieren — nie den Prover verbiegen.

Run: `npm test && npx eslint .`

- [x] **Step 5: Commit**

```bash
git add src/triage/prove.js test/prove.test.js
git commit -m "feat: selector prover against cosmetic mutations"
```

---

### Task 4: Temporales Delay-Script und Rerun-Probe

Zwei kleine Bausteine für Nichtdeterminismus: `temporalScript` erzeugt ein Init-Script, das Elemente für n Millisekunden versteckt (Grundstein für spätere Provokation in Framework-Läufen), `rerunStats` fährt ein Shell-Kommando mehrfach und meldet, ob der Fehler stabil ist.

**Files:**
- Create: `src/probe/temporal.js`, `src/triage/rerun.js`
- Test: `test/temporal.test.js`, `test/rerun.test.js`

**Interfaces:**
- Produces: `temporalScript(selector, ms) -> string` (self-contained Init-Script-Quelltext für `context.addInitScript`)
- Produces: `rerunStats(command, runs = 3) -> Promise<{ runs, failures, exitCodes: number[], nondeterministic: boolean }>` — `nondeterministic` ist wahr bei gemischten Ergebnissen (0 < failures < runs)

- [x] **Step 1: Failing Tests schreiben**

`test/temporal.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { temporalScript } from '../src/probe/temporal.js';

test('temporalScript hides the element and releases it after the delay', async () => {
  const server = await startFixtureServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.addInitScript(temporalScript('#cta', 800));
    const page = await context.newPage();
    const t0 = Date.now();
    await page.goto(server.url);
    assert.equal(await page.locator('#cta').isVisible(), false, 'must start hidden');
    await page.locator('#cta').waitFor({ state: 'visible', timeout: 5000 });
    assert.ok(Date.now() - t0 >= 400, 'must stay hidden for a meaningful part of the delay');
  } finally {
    await browser.close();
    await server.close();
  }
});
```

`test/rerun.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rerunStats } from '../src/triage/rerun.js';

test('stable green and stable red are not nondeterministic', async () => {
  const green = await rerunStats('node -e "process.exit(0)"', 2);
  assert.deepEqual({ failures: green.failures, nondeterministic: green.nondeterministic }, { failures: 0, nondeterministic: false });
  const red = await rerunStats('node -e "process.exit(1)"', 2);
  assert.deepEqual({ failures: red.failures, nondeterministic: red.nondeterministic }, { failures: 2, nondeterministic: false });
});

test('mixed outcomes are nondeterministic', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-rerun-'));
  const script = join(dir, 'flaky.cjs');
  const marker = join(dir, 'marker');
  await writeFile(
    script,
    `const fs=require('fs');if(fs.existsSync(${JSON.stringify(marker)})){process.exit(0)}fs.writeFileSync(${JSON.stringify(marker)},'');process.exit(1);`,
  );
  const stats = await rerunStats(`node ${script}`, 2);
  assert.deepEqual(stats.exitCodes, [1, 0]);
  assert.equal(stats.nondeterministic, true);
});
```

- [x] **Step 2: Laufen lassen — FAIL** (Module fehlen)

- [x] **Step 3: Implementieren**

`src/probe/temporal.js`:

```js
// Builds a self-contained init script (source string) that hides all
// elements matching `selector` for `ms` milliseconds after document start.
// Building block for provoking timing-dependent test failures.
export function temporalScript(selector, ms) {
  const delay = Number(ms);
  return `(() => {
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(selector)} + ' { visibility: hidden !important; }';
    const attach = () => {
      if (document.documentElement) {
        document.documentElement.appendChild(style);
        return true;
      }
      return false;
    };
    if (!attach()) {
      new MutationObserver((records, observer) => {
        if (attach()) observer.disconnect();
      }).observe(document, { childList: true });
    }
    setTimeout(() => style.remove(), ${delay});
  })();`;
}
```

`src/triage/rerun.js`:

```js
// Reruns a shell command n times and reports whether the outcome is stable.
// A mixed result is the classic nondeterministic (flaky) signature.
import { spawn } from 'node:child_process';

export async function rerunStats(command, runs = 3) {
  const exitCodes = [];
  for (let i = 0; i < runs; i += 1) {
    const code = await new Promise((resolve) => {
      const child = spawn(command, { shell: true, stdio: 'ignore' });
      child.on('error', () => resolve(-1));
      child.on('close', (c) => resolve(c ?? -1));
    });
    exitCodes.push(code);
  }
  const failures = exitCodes.filter((c) => c !== 0).length;
  return { runs, failures, exitCodes, nondeterministic: failures > 0 && failures < runs };
}
```

- [x] **Step 4: Laufen lassen — PASS**, dann **Commit**

```bash
git add src/probe/temporal.js src/triage/rerun.js test/temporal.test.js test/rerun.test.js
git commit -m "feat: temporal delay script and rerun-based nondeterminism probe"
```

---

### Task 5: Baseline-Snapshot-Capture

**Files:**
- Create: `src/snapshot.js`
- Test: `test/snapshot.test.js`

**Interfaces:**
- Consumes: `serializeDom`
- Produces: `captureSnapshot(url, { anchorSelector = null, viewport = { width: 1920, height: 1080 } } = {}) -> Promise<{ tree, anchorPath, html, url }>` — `html` ist das rohe `outerHTML` des Dokuments; es erlaubt der Engine, den Anker zur Triage-Zeit mit Playwright-Selektor-Syntax aufzulösen (zur Capture-Zeit ist der fehlschlagende Selektor unbekannt)

- [x] **Step 1: Failing Test schreiben**

`test/snapshot.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { nodeAt } from '../src/triage/tree.js';

test('captureSnapshot returns tree, html and resolved anchor', async () => {
  const server = await startFixtureServer();
  try {
    const snap = await captureSnapshot(server.url, { anchorSelector: '#cta' });
    assert.equal(snap.tree.tag, 'html');
    assert.ok(snap.html.startsWith('<html'), 'raw html must be captured');
    assert.equal(snap.url, server.url);
    assert.equal(nodeAt(snap.tree, snap.anchorPath).id, 'cta');
  } finally {
    await server.close();
  }
});
```

- [x] **Step 2: FAIL**, dann **Step 3: Implementieren**

`src/snapshot.js`:

```js
// Captures a page as a baseline: serialized tree for classification, raw
// html for late anchor resolution, and the source url for the record.
import { chromium } from 'playwright';
import { serializeDom } from './probe/serialize.js';

export async function captureSnapshot(url, { anchorSelector = null, viewport = { width: 1920, height: 1080 } } = {}) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const snap = await page.evaluate(serializeDom, anchorSelector);
    snap.html = await page.evaluate(() => document.documentElement.outerHTML);
    snap.url = url;
    return snap;
  } finally {
    await browser.close();
  }
}
```

- [x] **Step 4: PASS**, dann **Step 5: Commit**

```bash
git add src/snapshot.js test/snapshot.test.js
git commit -m "feat: baseline snapshot capture with tree and raw html"
```

---

### Task 6: Triage-Engine

Orchestriert den Triage-Algorithmus aus der Spec: Anker aus dem Fehler, optional Reruns, Klassifikation gegen die Baseline, bei Fragilität bewiesene Selektor-Empfehlung.

**Files:**
- Create: `src/triage/engine.js`
- Modify: `src/triage/classify.js` (eine Zeile: `match` um `path` erweitern)
- Test: `test/engine.test.js`

**Interfaces:**
- Consumes: `extractAnchor`, `failedTestsFromOutputXml`, `classifyDelta`, `candidatesFor`, `proveCandidates`, `rerunStats`, `captureSnapshot`
- Produces: `triage(opts) -> Promise<result>` mit `opts = { errorText?, robotOutputXml?, baselinePath, currentUrl?, currentPath?, rerunCommand?, reruns? }` und `result = { verdict: 'real-change'|'fragile'|'nondeterministic'|'unclear'|'no-anchor', anchor, testId, rerun, classification, recommendation, notes: string[] }`
- Modifiziert: `classifyDelta` gibt bei Match `match: { score, path }` zurück (Pfad des gematchten Elements im aktuellen Baum; die Engine braucht ihn, um dem Prover das Ziel zu zeigen)

- [x] **Step 1: classify.js-Änderung + failing Tests**

In `src/triage/classify.js` die letzte Return-Zeile ändern zu:

```js
  return { verdict, reasons: [...semantic, ...cosmetic, ...ambiguous], match: { score: match.score, path: b.path } };
```

`test/engine.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { triage } from '../src/triage/engine.js';

const timeoutError = (selector) =>
  `TimeoutError: locator.waitFor: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('${selector}') to be visible`;

test('no locator in the error yields no-anchor', async () => {
  const result = await triage({ errorText: 'AssertionError: Should Be Equal failed: A != B' });
  assert.equal(result.verdict, 'no-anchor');
});

test('all-green reruns yield nondeterministic without touching the baseline', async () => {
  const result = await triage({
    errorText: timeoutError('#cta'),
    rerunCommand: 'node -e "process.exit(0)"',
    reruns: 2,
  });
  assert.equal(result.verdict, 'nondeterministic');
  assert.equal(result.rerun.failures, 0);
});

test('identical baseline and current yield unclear, never a guess', async () => {
  const server = await startFixtureServer();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'fp-engine-'));
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(server.url)));
    const result = await triage({
      errorText: timeoutError('#cta'),
      baselinePath,
      currentUrl: server.url,
    });
    assert.equal(result.verdict, 'unclear');
  } finally {
    await server.close();
  }
});
```

- [x] **Step 2: FAIL**, dann **Step 3: Implementieren**

`src/triage/engine.js`:

```js
// The red-triage pipeline: anchor from the failure, optional reruns for
// nondeterminism, classification against the green baseline, and a proven
// selector recommendation when the test turns out to be fragile.
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { extractAnchor } from './anchor.js';
import { failedTestsFromOutputXml } from '../adapters/robot.js';
import { classifyDelta } from './classify.js';
import { candidatesFor } from './candidates.js';
import { proveCandidates } from './prove.js';
import { rerunStats } from './rerun.js';
import { captureSnapshot } from '../snapshot.js';

const VERDICT_BY_CLASSIFICATION = { cosmetic: 'fragile', semantic: 'real-change', unclear: 'unclear' };

// The baseline was captured while the build was green, before the failing
// selector was known. Resolve it now against the stored html via
// page.locator, which understands Playwright selector syntax.
async function resolveAnchorPath(baseline, selector) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(baseline.html);
    const locator = page.locator(selector);
    const count = await locator.count();
    if (count === 0) return { path: null, count };
    const path = await locator.first().evaluate((el) => {
      const p = [];
      let cur = el;
      while (cur && cur !== document.documentElement) {
        const parent = cur.parentElement;
        if (!parent) break;
        p.unshift([...parent.children].indexOf(cur));
        cur = parent;
      }
      return p;
    });
    return { path, count };
  } finally {
    await browser.close();
  }
}

export async function triage(opts) {
  const notes = [];
  let errorText = opts.errorText ?? null;
  let testId = null;

  if (!errorText && opts.robotOutputXml) {
    const failures = await failedTestsFromOutputXml(opts.robotOutputXml);
    if (failures.length === 0) {
      return { verdict: 'no-anchor', anchor: null, testId, rerun: null, classification: null, recommendation: null, notes: ['no failed test in output.xml'] };
    }
    errorText = failures[0].message;
    testId = failures[0].testId;
    if (failures.length > 1) notes.push(`${failures.length} failed tests in output.xml, triaging the first: ${testId}`);
  }

  const anchor = extractAnchor(errorText ?? '');
  if (!anchor.selector) {
    return {
      verdict: 'no-anchor', anchor, testId, rerun: null, classification: null, recommendation: null,
      notes: [...notes, 'no locator found in the error; cannot triage without an anchor'],
    };
  }

  let rerun = null;
  if (opts.rerunCommand) {
    rerun = await rerunStats(opts.rerunCommand, opts.reruns ?? 3);
    if (rerun.failures === 0 || rerun.nondeterministic) {
      const why = rerun.failures === 0 ? 'test went green on every rerun' : 'test fails intermittently across reruns';
      return { verdict: 'nondeterministic', anchor, testId, rerun, classification: null, recommendation: null, notes: [...notes, why] };
    }
    notes.push('test failed on every rerun; deterministic failure');
  }

  const baseline = JSON.parse(await readFile(opts.baselinePath, 'utf8'));
  if (!baseline.html || !baseline.tree) {
    return { verdict: 'unclear', anchor, testId, rerun, classification: null, recommendation: null, notes: [...notes, 'baseline snapshot is missing tree or html'] };
  }

  const resolved = await resolveAnchorPath(baseline, anchor.selector);
  if (!resolved.path) {
    return { verdict: 'unclear', anchor, testId, rerun, classification: null, recommendation: null, notes: [...notes, 'anchor selector does not resolve in the baseline snapshot'] };
  }
  if (resolved.count > 1) notes.push(`anchor selector matches ${resolved.count} baseline elements, using the first`);

  const current = opts.currentPath
    ? JSON.parse(await readFile(opts.currentPath, 'utf8'))
    : await captureSnapshot(opts.currentUrl);

  const classification = classifyDelta({ tree: baseline.tree, anchorPath: resolved.path }, current, anchor.selector);
  const verdict = VERDICT_BY_CLASSIFICATION[classification.verdict];

  let recommendation = null;
  if (verdict === 'fragile') {
    const candidates = candidatesFor(baseline.tree, resolved.path);
    if (candidates.length === 0) {
      notes.push('no provable selector candidates found for the anchor element');
    } else if (opts.currentUrl && classification.match?.path) {
      recommendation = await proveCandidates(opts.currentUrl, classification.match.path, candidates);
    } else {
      recommendation = candidates.map((c) => ({ ...c, uniqueAtBaseline: true, survived: null, applied: null }));
      notes.push('candidates are uniqueness-checked against the baseline only; pass a current URL to prove them against mutations');
    }
  }

  return { verdict, anchor, testId, rerun, classification, recommendation, notes };
}
```

- [x] **Step 4: Laufen lassen — PASS** (alle Suiten; die classify-Änderung darf keine bestehenden Tests brechen)

Run: `npm test && npx eslint .`

- [x] **Step 5: Commit**

```bash
git add src/triage/engine.js src/triage/classify.js test/engine.test.js
git commit -m "feat: red triage engine"
```

---

### Task 7: Report-Renderer und CLI

**Files:**
- Create: `src/report.js`, `bin/flakeproof.js`
- Modify: `package.json` (bin-Eintrag)
- Test: `test/cli.test.js`

**Interfaces:**
- Consumes: `triage`, `captureSnapshot`
- Produces: `renderReport(result) -> string` (Markdown); CLI-Kommandos `flakeproof snapshot <url> [--anchor <sel>] --out <file>` und `flakeproof triage --baseline <file> (--error-file <f> | --robot-xml <f>) (--current-url <url> | --current <file>) [--rerun-cmd <cmd>] [--reruns <n>] [--json] [--out <file>]`. Exit 0 wenn ein Verdict produziert wurde (auch `unclear`/`no-anchor`), Exit 1 bei Bedienungs-/Laufzeitfehler

- [x] **Step 1: Failing Tests schreiben**

`test/cli.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer } from './helpers/serve.js';
import { renderReport } from '../src/report.js';

const run = promisify(execFile);

test('renderReport shows verdict, evidence and recommendation table', () => {
  const md = renderReport({
    verdict: 'fragile',
    testId: 'Menu Test',
    anchor: { selector: 'li.css-1a2b3c', kind: 'timeout' },
    rerun: { runs: 3, failures: 3, exitCodes: [1, 1, 1] },
    classification: { verdict: 'cosmetic', reasons: ['selector relies on build-generated class ".css-1a2b3c" which is gone from the element'] },
    recommendation: [{ selector: '#main-nav li:nth-child(1)', kind: 'positional', uniqueAtBaseline: true, survived: 4, applied: 5 }],
    notes: ['test failed on every rerun; deterministic failure'],
  });
  assert.ok(md.includes('**fragile**'));
  assert.ok(md.includes('`li.css-1a2b3c`'));
  assert.ok(md.includes('| `#main-nav li:nth-child(1)` | positional | yes | 4/5 |'));
});

test('cli snapshot and triage round-trip on the fixture page', async () => {
  const server = await startFixtureServer();
  try {
    const dir = await mkdtemp(join(tmpdir(), 'fp-cli-'));
    const baseline = join(dir, 'baseline.json');
    const errFile = join(dir, 'error.txt');
    await writeFile(errFile, "TimeoutError: locator.waitFor: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('#cta') to be visible");

    await run('node', ['bin/flakeproof.js', 'snapshot', server.url, '--out', baseline]);
    const { stdout } = await run('node', [
      'bin/flakeproof.js', 'triage',
      '--baseline', baseline,
      '--error-file', errFile,
      '--current', baseline,
      '--json',
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.verdict, 'unclear');
    assert.equal(result.anchor.selector, '#cta');
  } finally {
    await server.close();
  }
});
```

- [x] **Step 2: FAIL**, dann **Step 3: Implementieren**

`src/report.js`:

```js
// Renders a triage result as a short markdown report for humans and PR
// comments. Plain text, no emojis.
export function renderReport(r) {
  const lines = ['# flakeproof triage', ''];
  lines.push(`Verdict: **${r.verdict}**`);
  if (r.testId) lines.push(`Test: ${r.testId}`);
  if (r.anchor?.selector) lines.push(`Anchor: \`${r.anchor.selector}\` (${r.anchor.kind})`);
  if (r.rerun) lines.push(`Reruns: ${r.rerun.failures}/${r.rerun.runs} failed (exit codes: ${r.rerun.exitCodes.join(', ')})`);
  if (r.classification?.reasons?.length) {
    lines.push('', '## Evidence');
    for (const reason of r.classification.reasons) lines.push(`- ${reason}`);
  }
  if (r.recommendation?.length) {
    lines.push('', '## Recommended selectors', '');
    lines.push('| selector | kind | unique | survived mutations |');
    lines.push('|---|---|---|---|');
    for (const c of r.recommendation) {
      const proof = c.survived === null ? 'not proven (no current URL)' : `${c.survived}/${c.applied}`;
      lines.push(`| \`${c.selector}\` | ${c.kind} | ${c.uniqueAtBaseline ? 'yes' : 'no'} | ${proof} |`);
    }
  }
  if (r.notes?.length) {
    lines.push('', '## Notes');
    for (const note of r.notes) lines.push(`- ${note}`);
  }
  lines.push('');
  return lines.join('\n');
}
```

`bin/flakeproof.js` (danach `chmod +x bin/flakeproof.js`):

```js
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
```

`package.json` ergänzen:

```json
  "bin": { "flakeproof": "bin/flakeproof.js" },
```

- [x] **Step 4: PASS** (`npm test && npx eslint .`), dann **Step 5: Commit**

```bash
git add src/report.js bin/flakeproof.js package.json test/cli.test.js
git commit -m "feat: flakeproof CLI with snapshot and triage commands"
```

---

### Task 8: Fixture-Build-Varianten und End-to-End-Triage

Der Beweis, dass das MVP sein Versprechen hält: drei Szenarien gegen echte, unterschiedliche "Builds" der Fixture-Seite.

**Files:**
- Create: `test/fixtures/page-v2/index.html`, `test/fixtures/page-v2/logo.svg`, `test/fixtures/page-v3/index.html`, `test/fixtures/page-v3/logo.svg`
- Modify: `test/helpers/serve.js` (root-Parameter)
- Test: `test/e2e-triage.test.js`

**Interfaces:**
- Modifiziert: `startFixtureServer({ port = 0, root } = {})` — `root` ist ein absoluter Verzeichnispfad, Default bleibt die bisherige Fixture-Seite; CLI-Modus unverändert

- [x] **Step 1: serve.js erweitern**

In `test/helpers/serve.js` die Signatur und die Pfadauflösung ändern:

```js
const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'page');

export function startFixtureServer({ port = 0, root = defaultRoot } = {}) {
```

Im Handler `join(root, file)` statt der Modulkonstante verwenden (die Konstante `root` oben in `defaultRoot` umbenennen, damit nichts kollidiert).

- [x] **Step 2: Varianten anlegen**

`test/fixtures/page-v2/index.html` — der kosmetische Build. Kopie von `test/fixtures/page/index.html` mit exakt diesen Änderungen: alle vier Hash-Klassen umbenannt (`css-1a2b3c` zu `css-q1w2e3`, `css-9z8y7x` zu `css-r4t5z6`, `css-4d5e6f` zu `css-u7i8o9`, `css-7g8h9i` zu `css-p0a1s2`) und der CTA-Link in einen Wrapper gelegt:

```html
    <div class="header-actions"><a id="cta" class="btn btn-primary" href="/contact/">Contact us</a></div>
```

`test/fixtures/page-v3/index.html` — der semantische Build. Kopie von v1 mit exakt diesen Änderungen: CTA-Text `Contact us` ersetzt durch `Get a quote`, und das komplette Solutions-`<li>` (`css-9z8y7x`) entfernt.

`logo.svg` in beide Varianten-Ordner kopieren (identischer Inhalt wie v1).

- [x] **Step 3: Failing E2E-Tests schreiben**

`test/e2e-triage.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from './helpers/serve.js';
import { captureSnapshot } from '../src/snapshot.js';
import { triage } from '../src/triage/engine.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const timeoutError = (selector) =>
  `TimeoutError: locator.waitFor: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('${selector}') to be visible`;

async function baselineOfV1(dir) {
  const v1 = await startFixtureServer();
  try {
    const baselinePath = join(dir, 'baseline.json');
    await writeFile(baselinePath, JSON.stringify(await captureSnapshot(v1.url)));
    return baselinePath;
  } finally {
    await v1.close();
  }
}

test('hashed-class selector against the cosmetic build is fragile, with a proven recommendation', async () => {
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
    assert.ok(result.recommendation?.length, 'must recommend selectors');
    const top = result.recommendation[0];
    assert.equal(top.selector, '#main-nav li:nth-child(1)');
    assert.ok(top.survived >= 3, `recommendation must be proven, got ${top.survived}/${top.applied}`);
  } finally {
    await v2.close();
  }
});

test('changed text against the semantic build is a real change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-e2e-'));
  const baselinePath = await baselineOfV1(dir);
  const v3 = await startFixtureServer({ root: join(fixtures, 'page-v3') });
  try {
    const result = await triage({
      errorText: timeoutError('#cta'),
      baselinePath,
      currentUrl: v3.url,
    });
    assert.equal(result.verdict, 'real-change');
  } finally {
    await v3.close();
  }
});

test('removed weak-identity element yields an honest unclear', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fp-e2e-'));
  const baselinePath = await baselineOfV1(dir);
  const v3 = await startFixtureServer({ root: join(fixtures, 'page-v3') });
  try {
    const result = await triage({
      errorText: timeoutError('li.css-9z8y7x'),
      baselinePath,
      currentUrl: v3.url,
    });
    assert.equal(result.verdict, 'unclear');
  } finally {
    await v3.close();
  }
});
```

- [x] **Step 4: Laufen lassen.** Erwartung: alle drei Szenarien wie asserted. Weicht ein Verdict ab, liegt ein echter Integrationsfehler vor — die Ursache in Engine/Matcher/Klassifikator verstehen und dort beheben; niemals die Fixture oder die Assertion passend biegen, ohne die Abweichung zu verstehen und im Report zu dokumentieren.

Run: `npm test && npx eslint .`

- [x] **Step 5: Commit**

```bash
git add test/fixtures/page-v2/ test/fixtures/page-v3/ test/helpers/serve.js test/e2e-triage.test.js
git commit -m "feat: fixture build variants and end-to-end triage tests"
```

---

### Task 9: README-Nutzungsdoku

**Files:**
- Modify: `README.md`

- [x] **Step 1: Usage-Abschnitt einfügen** (nach "## Status", vor "## Development"; englisch, keine em dashes, keine Emojis):

```markdown
## Usage

Capture a baseline while the build is green:

    npx flakeproof snapshot https://your-app.example --out baseline.json

When CI goes red, feed flakeproof the failure and the current build:

    npx flakeproof triage --baseline baseline.json --robot-xml output.xml --current-url https://your-app.example
    npx flakeproof triage --baseline baseline.json --error-file error.txt --current-url https://your-app.example --rerun-cmd "npx playwright test -g checkout"

The verdict is one of: real-change (probable regression), fragile (selector coupling broke, comes with proven selector recommendations), nondeterministic (reruns disagree), unclear (evidence is mixed or missing, flakeproof does not guess), no-anchor (the error names no locator).
```

- [x] **Step 2: Status-Absatz aktualisieren** auf: Phase 0 complete, phase 1 red triage MVP in progress (issue #2). Nach dem Merge passt der Controller den Status final an.

- [x] **Step 3: Prüfen und Commit**

Run: `npx eslint . && grep -n "npx flakeproof" README.md`

```bash
git add README.md
git commit -m "docs: usage documentation for the triage CLI"
```

---

## Self-Review (durchgeführt)

- **Spec-Abdeckung Phase 1 (MVP-Zuschnitt):** Triage-Algorithmus Schritt 1 (Nachfahren) → Task 4+6 (rerunStats); Schritt 3 (DOM-Diff am Anker) → Task 6 via classifyDelta; Schritt 4/5 (Klassifikation + bewiesener Gegenvorschlag) → Tasks 2, 3, 6; Baseline-Artefakt → Task 5 (tree+html statt Neubauen des Vorgänger-Builds, wie in der Spec entschieden); Carry-Over 1 und 2 aus dem Phase-0-Checkpoint → Task 1; temporaler Katalog als Baustein → Task 4. Bewusst nicht drin (siehe "Nicht Teil dieses Plans"): Framework-Injektion, PR-Kommentar-Integration.
- **Typ-Konsistenz:** Knotenform inkl. `role` in Task 1 definiert, von Tasks 2, 3, 6 konsumiert; `candidatesFor`-Rückgabe `{ selector, kind }` fließt unverändert durch `proveCandidates` (ergänzt `uniqueAtBaseline`, `survived`, `applied`) in `renderReport`s Tabelle; `classifyDelta.match.path` in Task 6 eingeführt und dort konsumiert; `startFixtureServer({ root })` in Task 8 eingeführt und nur dort gebraucht.
- **Platzhalter:** keine. Jeder Step enthält vollständigen Code oder exakte Kommandos und erwartete Ergebnisse.
- **Bekannte Grenze, absichtlich:** Bei entferntem Element in duplizierten DOM-Regionen bleibt das Verdict `unclear` (der Zwilling matcht weiterhin, Ambiguous-Gate fängt es) — dokumentiert im Phase-0-Checkpoint, Lösung jenseits des Localitäts-Terms ist Phase-2-Material.
