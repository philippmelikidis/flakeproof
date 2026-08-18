# flakeproof Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die zwei Machbarkeits-Spikes aus der Spec beantworten — (1) Anker-Extraktion aus Playwright- und Robot-Framework-Fehlern, (2) verlässliche Unterscheidung kosmetischer von semantischen DOM-Deltas — und dabei die wiederverwendbaren Kernbausteine (Serializer, Kataloge, Matcher, Klassifikator) anlegen.

**Architecture:** Reines Node.js-Projekt (ESM). Alles, was im Browser läuft (Serializer, Mutationen), sind in sich geschlossene Funktionen ohne Modul-Referenzen, die Playwright per `page.evaluate()` injiziert. Alles, was klassifiziert (Matcher, Klassifikator), arbeitet auf serialisierten JSON-Bäumen und ist ohne Browser unit-testbar. Eine lokale Fixture-Seite macht alle Tests deterministisch; die Live-Seite testgilde.de dient nur einem manuellen Validierungslauf.

**Tech Stack:** Node ≥ 20 (ESM, `node:test`), Playwright (Library-Modus als Treiber), `@playwright/test` (nur zur Erzeugung echter Fehlermeldungs-Fixtures), `fast-xml-parser` (RF `output.xml`). Robot Framework läuft über das bestehende `.venv` im Repo-Root.

## Global Constraints

- Node ≥ 20, `"type": "module"`, Testrunner ist `node:test` — keine weiteren Test-Frameworks
- Dependencies ausschließlich: `playwright`, `@playwright/test`, `fast-xml-parser` (alle dev) — plus Lint-Tooling `eslint`, `@eslint/js`, `globals` (dev, Merge-Gate: `npm run lint`)
- Sämtliche Repo-Texte (Code, Kommentare, Commit-Messages, README, generierte Berichte, Issues) auf Englisch, ohne Emojis, ohne em dashes (—), natürlich geschrieben; nur die internen Spec-/Plan-Dokumente bleiben deutsch
- **Commits ohne jede KI-/Claude-Erwähnung** (kein `Co-Authored-By`, keine "Generated with"-Zeile)
- Browser-injizierte Funktionen (`serializeDom`, alle `apply`-Funktionen) müssen self-contained sein: keine Closures über Modul-Scope, keine Imports — Playwright serialisiert nur den Funktionsquelltext
- Robot-Framework-Läufe nutzen das bestehende `.venv/` im Repo-Root (robotframework + Browser Library sind dort installiert)
- Erfolgskriterium des Klassifikator-Spikes (aus der Spec): **0 Fehlklassifikationen** (kosmetisch↔semantisch verwechselt); `unclear` ist zulässig und wird gezählt, aber nicht bestraft
- Übersprungene oder nicht anwendbare Fälle werden im Bericht ausgewiesen — nichts wird stillschweigend weggelassen

## File Structure

```
package.json                          Projekt-Manifest (neu)
src/probe/serialize.js                In-Page DOM-Serializer → JSON-Baum
src/probe/catalogs/cosmetic.js        Kosmetische Mutationen (in-page)
src/probe/catalogs/semantic.js        Semantische Mutationen, minimal (Fixture-Generator)
src/triage/tree.js                    Baum-Helfer: nodeAt, walk, findNode
src/triage/match.js                   Element-Wiederfinden per Ähnlichkeits-Score
src/triage/anchor.js                  {selector, kind} aus Fehlertexten
src/triage/classify.js                Delta-Klassifikation: cosmetic | semantic | unclear
src/adapters/robot.js                 Fehlgeschlagene Tests aus RF output.xml
test/fixtures/page/index.html         Deterministische lokale Testseite
test/fixtures/page/logo.svg           Platzhalter-Logo
test/fixtures/errors/*.txt            Echte, eingefangene Fehlermeldungen (committed)
test/fixtures/rf/broken.robot         RF-Suite, die absichtlich mit Locator-Timeout scheitert
test/fixtures/rf/output-fail.xml      Echtes RF-Fehlerartefakt (committed)
test/fixtures/pw/expect.spec.js       @playwright/test-Spec für expect-Timeout-Fixture
test/fixtures/pw/playwright.config.js Config mit JSON-Reporter
test/helpers/serve.js                 Statischer Fixture-Server (auch als CLI)
test/helpers/capture-errors.js        Erzeugt die Playwright-Fehler-Fixtures
test/helpers/capture-pwtest-error.js  Erzeugt die @playwright/test-Fehler-Fixture
test/*.test.js                        node:test-Suiten
spikes/run-phase0.js                  Spike-Messlauf → Konfusionsmatrix + Bericht
spikes/capture-live.js                Manuell: DOM-Paare von testgilde.de einfangen
spikes/phase0-report.md               Generierter Bericht (committed)
```

## Nicht Teil dieses Plans

Phase 1 (Triage-Orchestrierung, Baseline-Artefakte, Selektor-Empfehlung, PR-Report), temporaler Katalog, Cypress/Selenium/Puppeteer-Adapter. Phase 1 wird nach dem Checkpoint (Task 8) separat geplant — die Spike-Ergebnisse bestimmen den Zuschnitt.

---

### Task 1: Projektgerüst, Fixture-Seite, DOM-Serializer

**Files:**
- Create: `package.json`, `.gitignore` (erweitern), `test/fixtures/page/index.html`, `test/fixtures/page/logo.svg`, `test/helpers/serve.js`, `src/probe/serialize.js`, `src/triage/tree.js`
- Test: `test/serialize.test.js`

**Interfaces:**
- Produces: `serializeDom(anchorSelector?) -> { tree, anchorPath }` (in-page); Knoten: `{ tag, id, classes[], attrs{}, text, name, path[], children[] }`
- Produces: `nodeAt(tree, path) -> node|null`, `walk(tree, fn)`, `findNode(tree, pred) -> node|null` (`src/triage/tree.js`)
- Produces: `startFixtureServer({ port = 0 } = {}) -> Promise<{ url, close() }>`

- [ ] **Step 1: package.json anlegen und Dependencies installieren**

```json
{
  "name": "flakeproof",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test test/*.test.js",
    "spike": "node spikes/run-phase0.js"
  }
}
```

Run: `npm install --save-dev playwright @playwright/test fast-xml-parser && npx playwright install chromium`

`.gitignore` ergänzen um:

```
node_modules/
test/fixtures/pw/results.json
results.json
test-results/
```

- [ ] **Step 2: Fixture-Seite anlegen**

`test/fixtures/page/index.html`:

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>flakeproof fixture</title></head>
<body>
  <header id="site-header">
    <a id="logo-link" href="/"><img id="logo" src="logo.svg" alt="Acme"></a>
    <nav aria-label="Main">
      <ul id="main-nav">
        <li class="nav-item css-1a2b3c"><a href="/products/">Products</a></li>
        <li class="nav-item css-9z8y7x"><a href="/solutions/">Solutions</a></li>
        <li class="nav-item css-4d5e6f"><a href="/company/">Company</a></li>
        <li class="nav-item css-7g8h9i"><a href="/careers/">Careers</a></li>
      </ul>
    </nav>
    <a id="cta" class="btn btn-primary" href="/contact/">Contact us</a>
  </header>
  <main id="content"><h1>Fixture</h1></main>
</body>
</html>
```

`test/fixtures/page/logo.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>
```

- [ ] **Step 3: Fixture-Server schreiben**

`test/helpers/serve.js`:

```js
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'page');
const MIME = { '.html': 'text/html', '.svg': 'image/svg+xml' };

export function startFixtureServer({ port = 0 } = {}) {
  const server = createServer(async (req, res) => {
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    try {
      const body = await readFile(join(root, file));
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// CLI mode: node test/helpers/serve.js 8123
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 0);
  startFixtureServer({ port }).then(({ url }) => console.log(`fixture server: ${url}`));
}
```

- [ ] **Step 4: Failing Test für den Serializer schreiben**

`test/serialize.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { serializeDom } from '../src/probe/serialize.js';
import { nodeAt, findNode } from '../src/triage/tree.js';

test('serializeDom captures the fixture header', async () => {
  const server = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(server.url);

  const snap = await page.evaluate(serializeDom, '#cta');

  assert.equal(snap.tree.tag, 'html');
  const nav = findNode(snap.tree, (n) => n.id === 'main-nav');
  assert.equal(nav.children.length, 4);
  assert.deepEqual(nav.children[0].classes, ['css-1a2b3c', 'nav-item']); // sorted

  assert.ok(snap.anchorPath, 'anchorPath must be set');
  const anchor = nodeAt(snap.tree, snap.anchorPath);
  assert.equal(anchor.id, 'cta');
  assert.equal(anchor.text, 'Contact us');
  assert.equal(anchor.attrs.href, '/contact/');

  await browser.close();
  await server.close();
});

test('serializeDom returns null anchorPath for unmatched selector', async () => {
  const server = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(server.url);

  const snap = await page.evaluate(serializeDom, '#does-not-exist');
  assert.equal(snap.anchorPath, null);

  await browser.close();
  await server.close();
});
```

- [ ] **Step 5: Test laufen lassen — muss fehlschlagen**

Run: `npm test`
Expected: FAIL — `Cannot find module .../src/probe/serialize.js`

- [ ] **Step 6: Serializer und Baum-Helfer implementieren**

`src/probe/serialize.js`:

```js
// Runs INSIDE the page via page.evaluate(). Must be fully self-contained:
// no imports, no references to module scope.
export function serializeDom(anchorSelector) {
  const MAX_TEXT = 120;

  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
    }
    return t.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT);
  }

  function accessibleName(el) {
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      ''
    ).trim().slice(0, MAX_TEXT);
  }

  function serialize(el, path) {
    const attrs = {};
    for (const a of el.attributes) {
      if (a.name === 'class' || a.name === 'style') continue;
      attrs[a.name] = a.value.slice(0, MAX_TEXT);
    }
    const children = [];
    let i = 0;
    for (const c of el.children) {
      children.push(serialize(c, path.concat(i)));
      i += 1;
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: [...el.classList].sort(),
      attrs,
      text: ownText(el),
      name: accessibleName(el),
      path,
      children,
    };
  }

  let anchorPath = null;
  if (anchorSelector) {
    let target = null;
    try { target = document.querySelector(anchorSelector); } catch { /* invalid selector */ }
    if (target) {
      const path = [];
      let el = target;
      while (el && el !== document.documentElement) {
        const parent = el.parentElement;
        if (!parent) break;
        path.unshift([...parent.children].indexOf(el));
        el = parent;
      }
      anchorPath = path;
    }
  }

  return { tree: serialize(document.documentElement, []), anchorPath };
}
```

`src/triage/tree.js`:

```js
export function nodeAt(tree, path) {
  let node = tree;
  for (const i of path) {
    node = node.children[i];
    if (!node) return null;
  }
  return node;
}

export function walk(tree, fn) {
  fn(tree);
  for (const c of tree.children) walk(c, fn);
}

export function findNode(tree, pred) {
  let found = null;
  walk(tree, (n) => { if (!found && pred(n)) found = n; });
  return found;
}
```

- [ ] **Step 7: Tests laufen lassen — müssen bestehen**

Run: `npm test`
Expected: PASS (2 Tests)

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore test/ src/
git commit -m "feat: project scaffold, fixture page, in-page DOM serializer"
```

---

### Task 2: Kosmetischer Mutationskatalog

**Files:**
- Create: `src/probe/catalogs/cosmetic.js`
- Test: `test/cosmetic.test.js`

**Interfaces:**
- Produces: `cosmeticMutations: Array<{ id, description, apply(selector) -> boolean }>` — `apply` läuft in-page, gibt `false` zurück, wenn nicht anwendbar

- [ ] **Step 1: Failing Test schreiben**

`test/cosmetic.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { serializeDom } from '../src/probe/serialize.js';
import { findNode } from '../src/triage/tree.js';
import { cosmeticMutations } from '../src/probe/catalogs/cosmetic.js';

function byId(id) { return (n) => n.id === id; }

test('every cosmetic mutation applies to a suitable target and changes the DOM', async () => {
  const server = await startFixtureServer();
  const browser = await chromium.launch();

  // Suitable target per mutation: rename-hashed-class needs a hashed class.
  const targets = {
    'wrap-element': '#cta',
    'add-class': '#cta',
    'rename-hashed-class': 'li.css-1a2b3c',
    'add-framework-attr': '#cta',
    'move-to-end': '#logo-link',
  };

  for (const m of cosmeticMutations) {
    const page = await browser.newPage();
    await page.goto(server.url);
    const before = await page.evaluate(serializeDom, targets[m.id]);
    const applied = await page.evaluate(m.apply, targets[m.id]);
    assert.equal(applied, true, `${m.id} must apply to ${targets[m.id]}`);
    const after = await page.evaluate(serializeDom, targets[m.id]);
    assert.notDeepEqual(after.tree, before.tree, `${m.id} must change the serialized DOM`);
    await page.close();
  }

  assert.equal(Object.keys(targets).length, cosmeticMutations.length);
  await browser.close();
  await server.close();
});

test('wrap-element inserts one extra ancestor level', async () => {
  const server = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(server.url);

  const before = await page.evaluate(serializeDom, '#cta');
  const wrap = cosmeticMutations.find((m) => m.id === 'wrap-element');
  await page.evaluate(wrap.apply, '#cta');
  const after = await page.evaluate(serializeDom, '#cta');

  const beforeCta = findNode(before.tree, byId('cta'));
  const afterCta = findNode(after.tree, byId('cta'));
  assert.equal(afterCta.path.length, beforeCta.path.length + 1);

  await browser.close();
  await server.close();
});
```

- [ ] **Step 2: Laufen lassen — FAIL** (`Cannot find module .../cosmetic.js`)

Run: `npm test`

- [ ] **Step 3: Katalog implementieren**

`src/probe/catalogs/cosmetic.js`:

```js
// Mutations that change the DOM without changing meaning.
// A robust test must stay green under every one of these.
// Each apply() runs inside the page and must be self-contained.
export const cosmeticMutations = [
  {
    id: 'wrap-element',
    description: 'Wrap the target in an extra <div>',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el || !el.parentElement) return false;
      const wrapper = document.createElement('div');
      el.parentElement.insertBefore(wrapper, el);
      wrapper.appendChild(el);
      return true;
    },
  },
  {
    id: 'add-class',
    description: 'Add an unrelated class to the target',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.classList.add('fp-added-class');
      return true;
    },
  },
  {
    id: 'rename-hashed-class',
    description: 'Change the suffix of a build-generated (hashed) class',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const hashed = [...el.classList].find((c) => /^(?:css|sc|jsx|svelte)-[a-z0-9]+$/i.test(c));
      if (!hashed) return false;
      el.classList.replace(hashed, hashed.replace(/[a-z0-9]+$/i, 'zz99xx'));
      return true;
    },
  },
  {
    id: 'add-framework-attr',
    description: 'Add a framework-style scoping attribute',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.setAttribute('data-v-fp0001', '');
      return true;
    },
  },
  {
    id: 'move-to-end',
    description: 'Move the target to the end of its siblings',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el || !el.parentElement || el.parentElement.lastElementChild === el) return false;
      el.parentElement.appendChild(el);
      return true;
    },
  },
];
```

- [ ] **Step 4: Laufen lassen — PASS**

Run: `npm test`

- [ ] **Step 5: Commit**

```bash
git add src/probe/catalogs/cosmetic.js test/cosmetic.test.js
git commit -m "feat: cosmetic mutation catalog"
```

---

### Task 3: Semantischer Mini-Katalog

**Files:**
- Create: `src/probe/catalogs/semantic.js`
- Test: `test/semantic.test.js`

**Interfaces:**
- Produces: `semanticMutations: Array<{ id, description, apply(selector) -> boolean }>` — gleiche Form wie `cosmeticMutations`

Bewusst minimal (3 Mutationen): In Phase 0 dient dieser Katalog nur der Erzeugung gelabelter DOM-Paare für den Klassifikator-Spike. Der volle semantische Katalog ist Phase 2 (Notenvergabe).

- [ ] **Step 1: Failing Test schreiben**

`test/semantic.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { serializeDom } from '../src/probe/serialize.js';
import { findNode } from '../src/triage/tree.js';
import { semanticMutations } from '../src/probe/catalogs/semantic.js';

test('semantic mutations change meaning-bearing properties', async () => {
  const server = await startFixtureServer();
  const browser = await chromium.launch();

  const checks = {
    'change-text': async (page) => {
      const snap = await page.evaluate(serializeDom, null);
      const cta = findNode(snap.tree, (n) => n.id === 'cta');
      assert.equal(cta.text, 'FLAKEPROOF-CHANGED');
    },
    'change-href': async (page) => {
      const snap = await page.evaluate(serializeDom, null);
      const cta = findNode(snap.tree, (n) => n.id === 'cta');
      assert.equal(cta.attrs.href, '/fp-changed/');
    },
    'remove-element': async (page) => {
      const snap = await page.evaluate(serializeDom, null);
      assert.equal(findNode(snap.tree, (n) => n.id === 'cta'), null);
    },
  };

  for (const m of semanticMutations) {
    const page = await browser.newPage();
    await page.goto(server.url);
    const applied = await page.evaluate(m.apply, '#cta');
    assert.equal(applied, true, `${m.id} must apply`);
    await checks[m.id](page);
    await page.close();
  }

  assert.equal(Object.keys(checks).length, semanticMutations.length);
  await browser.close();
  await server.close();
});
```

- [ ] **Step 2: Laufen lassen — FAIL** (`Cannot find module .../semantic.js`)

Run: `npm test`

- [ ] **Step 3: Implementieren**

`src/probe/catalogs/semantic.js`:

```js
// Mutations that change meaning. A sensitive test must go red under these.
// Phase 0 uses them only to generate labeled DOM pairs for the classifier spike.
export const semanticMutations = [
  {
    id: 'change-text',
    description: 'Replace the visible text of the target',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.textContent = 'FLAKEPROOF-CHANGED';
      return true;
    },
  },
  {
    id: 'change-href',
    description: 'Point the target link somewhere else',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el || !el.hasAttribute('href')) return false;
      el.setAttribute('href', '/fp-changed/');
      return true;
    },
  },
  {
    id: 'remove-element',
    description: 'Remove the target entirely',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.remove();
      return true;
    },
  },
];
```

- [ ] **Step 4: Laufen lassen — PASS**, dann **Commit**

```bash
git add src/probe/catalogs/semantic.js test/semantic.test.js
git commit -m "feat: minimal semantic mutation catalog for classifier fixtures"
```

---

### Task 4: Anker-Extraktion aus Playwright-Fehlertexten (Spike 1a)

**Files:**
- Create: `src/triage/anchor.js`, `test/helpers/capture-errors.js`, `test/helpers/capture-pwtest-error.js`, `test/fixtures/pw/expect.spec.js`, `test/fixtures/pw/playwright.config.js`
- Create (generiert, committed): `test/fixtures/errors/pw-waitfor-timeout.txt`, `pw-click-timeout.txt`, `pw-strict-violation.txt`, `pwtest-expect-timeout.txt`
- Test: `test/anchor.test.js`

**Interfaces:**
- Produces: `extractAnchor(errorText) -> { selector: string|null, kind: 'timeout'|'ambiguous'|'assertion'|'navigation'|'unknown' }`

Die Fixtures sind **echte, eingefangene** Fehlermeldungen — nicht von Hand geschrieben. So testet der Spike gegen die Realität, nicht gegen unsere Vermutung über Playwrights Format.

- [ ] **Step 1: Capture-Skript für Library-Fehler schreiben**

`test/helpers/capture-errors.js`:

```js
// Provokes real Playwright errors against the fixture page and stores
// their messages as fixtures. Run once; commit the results.
import { writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startFixtureServer } from './serve.js';

const OUT = new URL('../fixtures/errors/', import.meta.url);
await mkdir(OUT, { recursive: true });

async function capture(name, fn) {
  try {
    await fn();
    throw new Error(`expected ${name} to fail`);
  } catch (err) {
    await writeFile(new URL(`${name}.txt`, OUT), err.message, 'utf8');
    console.log(`captured ${name}`);
  }
}

const server = await startFixtureServer();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(server.url);

await capture('pw-waitfor-timeout', () =>
  page.locator('#does-not-exist').waitFor({ state: 'visible', timeout: 1500 }));
await capture('pw-click-timeout', () =>
  page.locator('#also-missing').click({ timeout: 1500 }));
await capture('pw-strict-violation', () =>
  page.locator('.nav-item').click({ timeout: 1500 }));

await browser.close();
await server.close();
```

- [ ] **Step 2: @playwright/test-Fixture erzeugen**

`test/fixtures/pw/playwright.config.js`:

```js
export default {
  testDir: '.',
  reporter: [['json', { outputFile: 'results.json' }]],
  use: { headless: true },
};
```

`test/fixtures/pw/expect.spec.js`:

```js
import { test, expect } from '@playwright/test';

test('expect timeout fixture', async ({ page }) => {
  await page.goto(process.env.FIXTURE_URL);
  await expect(page.locator('#does-not-exist')).toBeVisible({ timeout: 1500 });
});
```

`test/helpers/capture-pwtest-error.js`:

```js
// Runs the @playwright/test spec with the JSON reporter and extracts the
// real error message of the failing test. Run once; commit the result.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { startFixtureServer } from './serve.js';

const server = await startFixtureServer();
spawnSync('npx', ['playwright', 'test', '--config', 'test/fixtures/pw/playwright.config.js'], {
  env: { ...process.env, FIXTURE_URL: server.url },
  stdio: 'inherit',
});
await server.close();

// The JSON reporter resolves outputFile relative to the config directory in
// current Playwright versions; older ones used the cwd. Try both.
const results = JSON.parse(
  await readFile('test/fixtures/pw/results.json', 'utf8')
    .catch(() => readFile('results.json', 'utf8')),
);
const message = results.suites[0].specs[0].tests[0].results[0].error.message;
const clean = message.replace(/\[[0-9;]*m/g, ''); // strip ANSI colors
await writeFile('test/fixtures/errors/pwtest-expect-timeout.txt', clean, 'utf8');
console.log('captured pwtest-expect-timeout');
```

- [ ] **Step 3: Beide Capture-Skripte ausführen und Fixtures prüfen**

Run: `node test/helpers/capture-errors.js && node test/helpers/capture-pwtest-error.js`
Expected: 4 Dateien unter `test/fixtures/errors/`. Sichtprüfung: `pw-waitfor-timeout.txt` enthält `waiting for locator('#does-not-exist')`; `pw-strict-violation.txt` enthält `strict mode violation`. Weicht das Format ab, werden die Assertions in Step 4 an die **echten** Inhalte angepasst — die Fixtures sind die Wahrheit, nicht der Plan.

- [ ] **Step 4: Failing Test gegen die echten Fixtures schreiben**

`test/anchor.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractAnchor } from '../src/triage/anchor.js';

async function fixture(name) {
  return readFile(new URL(`./fixtures/errors/${name}.txt`, import.meta.url), 'utf8');
}

test('waitFor timeout: selector and kind', async () => {
  const a = extractAnchor(await fixture('pw-waitfor-timeout'));
  assert.equal(a.selector, '#does-not-exist');
  assert.equal(a.kind, 'timeout');
});

test('click timeout: selector and kind', async () => {
  const a = extractAnchor(await fixture('pw-click-timeout'));
  assert.equal(a.selector, '#also-missing');
  assert.equal(a.kind, 'timeout');
});

test('strict mode violation: selector and kind', async () => {
  const a = extractAnchor(await fixture('pw-strict-violation'));
  assert.equal(a.selector, '.nav-item');
  assert.equal(a.kind, 'ambiguous');
});

test('@playwright/test expect timeout: selector and kind', async () => {
  const a = extractAnchor(await fixture('pwtest-expect-timeout'));
  assert.equal(a.selector, '#does-not-exist');
  assert.equal(a.kind, 'timeout');
});

test('selector containing quotes survives extraction', () => {
  const text = `TimeoutError: locator.waitFor: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('ul#menu-main-navigation > li > a:text-is("Leistungen")') to be visible`;
  const a = extractAnchor(text);
  assert.equal(a.selector, 'ul#menu-main-navigation > li > a:text-is("Leistungen")');
  assert.equal(a.kind, 'timeout');
});

test('no locator present: assertion failure', () => {
  const a = extractAnchor('AssertionError: Should Be Equal failed: A != B');
  assert.equal(a.selector, null);
  assert.equal(a.kind, 'assertion');
});

test('empty input', () => {
  assert.deepEqual(extractAnchor(''), { selector: null, kind: 'unknown' });
});
```

- [ ] **Step 5: Laufen lassen — FAIL** (`Cannot find module .../anchor.js`)

Run: `npm test`

- [ ] **Step 6: Extraktor implementieren**

`src/triage/anchor.js`:

```js
// Extracts the anchor (the locator a failing test was hanging on) from a
// raw error text. String scanning instead of one big regex: locator strings
// may contain quotes, parentheses and combinators.

function locatorFromLine(line) {
  const start = line.indexOf("locator('");
  if (start === -1) return null;
  const end = line.lastIndexOf("')");
  if (end <= start) return null;
  return line.slice(start + "locator('".length, end);
}

function detectKind(text) {
  if (/strict mode violation/.test(text)) return 'ambiguous';
  if (/Timeout \d+ms exceeded/.test(text) || /Timed out \d+ms/.test(text)) return 'timeout';
  if (/net::|NS_ERROR_|ERR_/.test(text)) return 'navigation';
  if (/expect\(|AssertionError|Should (Be|Contain|Not)/i.test(text)) return 'assertion';
  return 'unknown';
}

export function extractAnchor(errorText) {
  const text = String(errorText ?? '');
  const kind = detectKind(text);
  for (const line of text.split('\n')) {
    const selector = locatorFromLine(line);
    if (selector) return { selector, kind };
  }
  return { selector: null, kind };
}
```

- [ ] **Step 7: Laufen lassen — PASS.** Schlägt ein Fixture-Test fehl, weil das echte Format abweicht: Extraktor anpassen (nicht das Fixture).

Run: `npm test`

- [ ] **Step 8: Commit**

```bash
git add src/triage/anchor.js test/anchor.test.js test/helpers/capture-errors.js \
  test/helpers/capture-pwtest-error.js test/fixtures/pw/ test/fixtures/errors/
git commit -m "feat: anchor extraction from real Playwright error messages"
```

---

### Task 5: Anker-Extraktion aus Robot-Framework-output.xml (Spike 1b)

**Files:**
- Create: `src/adapters/robot.js`, `test/fixtures/rf/broken.robot`
- Create (generiert, committed): `test/fixtures/rf/output-fail.xml`
- Test: `test/robot-adapter.test.js`

**Interfaces:**
- Consumes: `extractAnchor` aus Task 4
- Produces: `failedTestsFromOutputXml(path) -> Promise<Array<{ testId, message, anchor }>>`

- [ ] **Step 1: Absichtlich scheiternde RF-Suite schreiben**

`test/fixtures/rf/broken.robot`:

```robotframework
*** Settings ***
Library    Browser

*** Test Cases ***
Fails With Locator Timeout
    New Browser    chromium    headless=${True}
    New Page    http://127.0.0.1:8123/
    Wait For Elements State    css=#does-not-exist    visible    timeout=2s
```

- [ ] **Step 2: Echtes Fehlerartefakt erzeugen**

```bash
node test/helpers/serve.js 8123 &
SERVER_PID=$!
sleep 1
.venv/bin/robot --outputdir test/fixtures/rf --output output-fail.xml \
  --log NONE --report NONE test/fixtures/rf/broken.robot || true
kill $SERVER_PID
```

Expected: `1 test, 0 passed, 1 failed`; `test/fixtures/rf/output-fail.xml` existiert. Sichtprüfung: Die FAIL-Message enthält `waiting for locator`.

- [ ] **Step 3: Failing Test schreiben**

`test/robot-adapter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { failedTestsFromOutputXml } from '../src/adapters/robot.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/rf/output-fail.xml', import.meta.url));

test('finds the failed RF test and extracts its anchor', async () => {
  const failures = await failedTestsFromOutputXml(FIXTURE);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].testId, 'Fails With Locator Timeout');
  assert.ok(failures[0].anchor.selector.includes('#does-not-exist'),
    `selector was: ${failures[0].anchor.selector}`);
  assert.equal(failures[0].anchor.kind, 'timeout');
});
```

- [ ] **Step 4: Laufen lassen — FAIL** (`Cannot find module .../robot.js`)

Run: `npm test`

- [ ] **Step 5: Adapter implementieren**

`src/adapters/robot.js`:

```js
// Reads a Robot Framework output.xml and returns the failed tests with
// their failure message and extracted anchor.
import { readFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { extractAnchor } from '../triage/anchor.js';

function asArray(x) {
  return x == null ? [] : Array.isArray(x) ? x : [x];
}

function statusText(status) {
  if (typeof status === 'string') return status;
  return status?.['#text'] ?? '';
}

function collectFailures(suite, out) {
  for (const s of asArray(suite?.suite)) collectFailures(s, out);
  for (const t of asArray(suite?.test)) {
    if (t.status?.['@_status'] === 'FAIL') {
      out.push({ testId: t['@_name'], message: statusText(t.status) });
    }
  }
}

export async function failedTestsFromOutputXml(path) {
  const xml = await readFile(path, 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xml);
  const failures = [];
  collectFailures(doc.robot?.suite, failures);
  return failures.map((f) => ({ ...f, anchor: extractAnchor(f.message) }));
}
```

- [ ] **Step 6: Laufen lassen — PASS.** Weicht die echte XML-Struktur ab (RF-Version!), Adapter an die Realität anpassen.

Run: `npm test`

- [ ] **Step 7: Commit**

```bash
git add src/adapters/robot.js test/fixtures/rf/ test/robot-adapter.test.js
git commit -m "feat: Robot Framework adapter extracts anchors from output.xml"
```

---

### Task 6: Element-Matching — dasselbe Element im geänderten DOM wiederfinden

**Files:**
- Create: `src/triage/match.js`
- Test: `test/match.test.js`

**Interfaces:**
- Consumes: `walk` aus `src/triage/tree.js`
- Produces: `similarity(a, b) -> number`, `findBestMatch(tree, target, threshold = 5) -> { node, score } | null`

- [ ] **Step 1: Failing Test schreiben**

`test/match.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarity, findBestMatch } from '../src/triage/match.js';

// Compact node builder matching the serializer's shape.
function n(tag, props = {}, children = []) {
  return {
    tag, id: null, classes: [], attrs: {}, text: '', name: '', path: [],
    ...props, children,
  };
}

// Assign paths the way the serializer does.
function withPaths(node, path = []) {
  node.path = path;
  node.children.forEach((c, i) => withPaths(c, path.concat(i)));
  return node;
}

test('identical nodes score high, unrelated nodes score low', () => {
  const a = n('a', { id: 'cta', text: 'Contact us', attrs: { href: '/contact/' } });
  const b = n('a', { id: 'cta', text: 'Contact us', attrs: { href: '/contact/' } });
  const c = n('a', { text: 'Careers', attrs: { href: '/careers/' } });
  assert.ok(similarity(a, b) >= 10);
  assert.ok(similarity(a, c) < 5);
});

test('different tag never matches', () => {
  const a = n('a', { text: 'Contact us' });
  const b = n('div', { text: 'Contact us' });
  assert.equal(similarity(a, b), 0);
});

test('finds the moved element despite a new wrapper', () => {
  const target = n('a', { id: 'cta', text: 'Contact us', attrs: { href: '/contact/' }, path: [1, 2] });
  const tree = withPaths(
    n('body', {}, [
      n('header', {}, [
        n('nav', {}, [n('a', { text: 'Products', attrs: { href: '/products/' } })]),
        n('div', {}, [ // new wrapper
          n('a', { id: 'cta', text: 'Contact us', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
  );
  const match = findBestMatch(tree, target);
  assert.ok(match, 'must find a match');
  assert.equal(match.node.id, 'cta');
});

test('returns null when nothing is similar enough', () => {
  const target = n('a', { id: 'cta', text: 'Contact us' });
  const tree = withPaths(n('body', {}, [n('main', {}, [n('h1', { text: 'Fixture' })])]));
  assert.equal(findBestMatch(tree, target), null);
});
```

- [ ] **Step 2: Laufen lassen — FAIL** (`Cannot find module .../match.js`)

Run: `npm test`

- [ ] **Step 3: Implementieren**

`src/triage/match.js`:

```js
// Re-identifies "the same" element in a changed DOM tree via weighted
// similarity. Weights are phase-0 starting values; the spike report
// documents how they held up.
import { walk } from './tree.js';

const WEIGHTS = { tag: 2, id: 3, text: 3, name: 2, href: 2, classOverlap: 2 };
const SIBLING_PENALTY_MAX = 2;

function jaccard(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export function similarity(a, b) {
  if (a.tag !== b.tag) return 0;
  let score = WEIGHTS.tag;
  if (a.id && a.id === b.id) score += WEIGHTS.id;
  if (a.text && a.text === b.text) score += WEIGHTS.text;
  if (a.name && a.name === b.name) score += WEIGHTS.name;
  if (a.attrs.href && a.attrs.href === b.attrs.href) score += WEIGHTS.href;
  score += WEIGHTS.classOverlap * jaccard(a.classes, b.classes);
  if (a.path.length > 0 && b.path.length > 0) {
    const posDelta = Math.abs(a.path.at(-1) - b.path.at(-1));
    score -= Math.min(SIBLING_PENALTY_MAX, posDelta * 0.5);
  }
  return score;
}

export function findBestMatch(tree, target, threshold = 5) {
  let best = null;
  let bestScore = -Infinity;
  walk(tree, (node) => {
    const s = similarity(target, node);
    if (s > bestScore) {
      best = node;
      bestScore = s;
    }
  });
  return bestScore >= threshold ? { node: best, score: bestScore } : null;
}
```

- [ ] **Step 4: Laufen lassen — PASS**, dann **Commit**

```bash
git add src/triage/match.js test/match.test.js
git commit -m "feat: element re-identification via weighted similarity"
```

---

### Task 7: Delta-Klassifikator (Spike 2, Kernlogik)

**Files:**
- Create: `src/triage/classify.js`
- Test: `test/classify.test.js`

**Interfaces:**
- Consumes: `nodeAt` (tree.js), `findBestMatch` (match.js)
- Produces: `classifyDelta(baselineSnap, currentSnap, anchorSelector) -> { verdict: 'cosmetic'|'semantic'|'unclear', reasons: string[], match: { score }|null }`
- Produces: `selectorFeatures(selector) -> { ids: string[], classes: string[], texts: string[], structural: boolean }`

Kernidee: Nicht jede DOM-Änderung zählt gleich — entscheidend ist, **worauf der Selektor sich verlässt**. Bricht der Selektor an einer bedeutungsfreien Kopplung (gehashte Klasse, Wrapper, Position) → `cosmetic`. Ist Bedeutung verschwunden (Text, Ziel, Element selbst) → `semantic`. Gemischte oder fehlende Signale → `unclear`, niemals raten.

- [ ] **Step 1: Failing Test schreiben**

`test/classify.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDelta, selectorFeatures } from '../src/triage/classify.js';

function n(tag, props = {}, children = []) {
  return {
    tag, id: null, classes: [], attrs: {}, text: '', name: '', path: [],
    ...props, children,
  };
}
function withPaths(node, path = []) {
  node.path = path;
  node.children.forEach((c, i) => withPaths(c, path.concat(i)));
  return node;
}
function snap(tree, anchorPath) {
  return { tree: withPaths(tree), anchorPath };
}

const baselineTree = () =>
  n('html', {}, [
    n('body', {}, [
      n('header', { id: 'site-header' }, [
        n('a', { id: 'cta', classes: ['btn', 'css-1a2b3c'], text: 'Contact us', attrs: { href: '/contact/' } }),
      ]),
    ]),
  ]);
// anchor path to #cta in baselineTree: [0, 0, 0]  (body > header > a)

test('selectorFeatures parses ids, classes, text and structure', () => {
  const f = selectorFeatures('ul#main-nav > li.css-1a2b3c > a:text-is("Products")');
  assert.deepEqual(f.ids, ['main-nav']);
  assert.deepEqual(f.classes, ['css-1a2b3c']);
  assert.deepEqual(f.texts, ['Products']);
  assert.equal(f.structural, true);
});

test('element removed -> semantic', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [n('body', {}, [n('header', { id: 'site-header' })])]),
    null,
  );
  const r = classifyDelta(before, after, '#cta');
  assert.equal(r.verdict, 'semantic');
});

test('hashed class renamed, selector relied on it -> cosmetic', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('a', { id: 'cta', classes: ['btn', 'css-zz99xx'], text: 'Contact us', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'a.css-1a2b3c');
  assert.equal(r.verdict, 'cosmetic');
});

test('new wrapper broke a structural selector -> cosmetic', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('div', {}, [
            n('a', { id: 'cta', classes: ['btn', 'css-1a2b3c'], text: 'Contact us', attrs: { href: '/contact/' } }),
          ]),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'header > a.btn');
  assert.equal(r.verdict, 'cosmetic');
});

test('text the selector matched on has changed -> semantic', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('a', { id: 'cta', classes: ['btn', 'css-1a2b3c'], text: 'Get a quote', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'a:text-is("Contact us")');
  assert.equal(r.verdict, 'semantic');
});

test('mixed signals -> unclear', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('a', { id: 'cta', classes: ['btn', 'css-zz99xx'], text: 'Get a quote', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'a.css-1a2b3c:text-is("Contact us")');
  assert.equal(r.verdict, 'unclear');
});

test('no explaining delta -> unclear', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(baselineTree(), null);
  const r = classifyDelta(before, after, '#cta');
  assert.equal(r.verdict, 'unclear');
});

test('anchor missing in baseline -> unclear', () => {
  const before = snap(baselineTree(), null);
  const after = snap(baselineTree(), null);
  const r = classifyDelta(before, after, '#never-existed');
  assert.equal(r.verdict, 'unclear');
});
```

- [ ] **Step 2: Laufen lassen — FAIL** (`Cannot find module .../classify.js`)

Run: `npm test`

- [ ] **Step 3: Implementieren**

`src/triage/classify.js`:

```js
// Classifies the DOM delta at a failed test's anchor:
//   cosmetic  – the selector broke on a meaning-free coupling (fragile test)
//   semantic  – meaning changed or vanished (probable real regression)
//   unclear   – mixed or missing evidence; never guess.
import { nodeAt } from './tree.js';
import { findBestMatch } from './match.js';

const HASHED_CLASS =
  /^(?:css|sc|jsx|svelte)-[a-z0-9]+$|^_?ng(?:content|host)-|^[a-z][\w-]*__[a-z0-9]{5,}$/i;

export function selectorFeatures(selector) {
  return {
    ids: [...selector.matchAll(/#([\w-]+)/g)].map((m) => m[1]),
    classes: [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]),
    texts: [...selector.matchAll(/:(?:text|text-is|has-text)\(["']?(.+?)["']?\)/g)].map((m) => m[1]),
    structural: /[>~+]|:nth-/.test(selector),
  };
}

export function classifyDelta(baseline, current, anchorSelector) {
  const target = baseline.anchorPath ? nodeAt(baseline.tree, baseline.anchorPath) : null;
  if (!target) {
    return { verdict: 'unclear', reasons: ['anchor element not present in baseline snapshot'], match: null };
  }

  const match = findBestMatch(current.tree, target);
  if (!match) {
    return {
      verdict: 'semantic',
      reasons: [`element <${target.tag}${target.id ? '#' + target.id : ''}> no longer exists in current build`],
      match: null,
    };
  }

  const feat = selectorFeatures(anchorSelector);
  const b = match.node;
  const cosmetic = [];
  const semantic = [];

  // Selector-relied classes that vanished from the element.
  for (const cls of feat.classes) {
    if (target.classes.includes(cls) && !b.classes.includes(cls)) {
      const label = HASHED_CLASS.test(cls) ? 'build-generated class' : 'class';
      cosmetic.push(`selector relies on ${label} ".${cls}" which is gone from the element`);
    }
  }

  // Selector-relied ids that vanished.
  for (const id of feat.ids) {
    if (target.id === id && b.id !== id) {
      cosmetic.push(`selector relies on id "#${id}" which is gone from the element`);
    }
  }

  // Selector-relied text that vanished.
  for (const t of feat.texts) {
    const had = target.text.includes(t) || target.name.includes(t);
    const has = b.text.includes(t) || b.name.includes(t);
    if (had && !has) semantic.push(`text "${t}" the selector matched on is no longer present`);
  }

  // Structural selectors vs. position/ancestry changes.
  if (feat.structural) {
    if (b.path.length !== target.path.length) {
      cosmetic.push('element depth changed (wrapper inserted/removed) and selector depends on structure');
    } else if (String(b.path) !== String(target.path)) {
      cosmetic.push('element position changed and selector depends on structure');
    }
  }

  // Meaning-bearing deltas independent of the selector.
  if (target.text !== b.text && !semantic.length) {
    semantic.push(`own text changed: "${target.text}" -> "${b.text}"`);
  }
  if ((target.attrs.href ?? null) !== (b.attrs.href ?? null)) {
    semantic.push(`href changed: "${target.attrs.href ?? ''}" -> "${b.attrs.href ?? ''}"`);
  }

  let verdict = 'unclear';
  if (semantic.length && !cosmetic.length) verdict = 'semantic';
  if (cosmetic.length && !semantic.length) verdict = 'cosmetic';

  return { verdict, reasons: [...semantic, ...cosmetic], match: { score: match.score } };
}
```

- [ ] **Step 4: Laufen lassen — PASS**, dann **Commit**

```bash
git add src/triage/classify.js test/classify.test.js
git commit -m "feat: selector-aware delta classifier (cosmetic/semantic/unclear)"
```

---

### Task 8: Spike-Messlauf, Live-Validierung, Phase-0-Bericht und Checkpoint

**Files:**
- Create: `spikes/run-phase0.js`, `spikes/capture-live.js`
- Create (generiert, committed): `spikes/phase0-report.md`, `spikes/live-pairs/*.json`

**Interfaces:**
- Consumes: alles aus Task 1–7
- Produces: `spikes/phase0-report.md` mit Konfusionsmatrix und Go/No-Go-Bewertung; Exit-Code 1 bei Fehlklassifikationen

- [ ] **Step 1: Messlauf-Skript schreiben**

`spikes/run-phase0.js`:

```js
// Phase-0 measurement: apply every catalog mutation to every anchor on the
// fixture page, classify the delta, and compare against the known label.
// Also classifies any committed live pairs from spikes/live-pairs/.
import { writeFile, readdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startFixtureServer } from '../test/helpers/serve.js';
import { serializeDom } from '../src/probe/serialize.js';
import { cosmeticMutations } from '../src/probe/catalogs/cosmetic.js';
import { semanticMutations } from '../src/probe/catalogs/semantic.js';
import { classifyDelta } from '../src/triage/classify.js';

// Note: Playwright-only pseudo-selectors (:text-is etc.) are not resolvable
// via document.querySelector, so serializeDom cannot anchor on them in
// phase 0. The text-selector classification path is covered by unit tests
// in test/classify.test.js instead.
const ANCHORS = [
  '#cta',                             // robust id selector
  'header > a.btn',                   // structural + class
  '#main-nav > li:nth-child(2) > a',  // deeply structural
  'li.css-1a2b3c',                    // relies on a hashed class
];

const catalogs = [
  ['cosmetic', cosmeticMutations],
  ['semantic', semanticMutations],
];

const rows = [];
const skipped = [];

const server = await startFixtureServer();
const browser = await chromium.launch();

for (const [label, catalog] of catalogs) {
  for (const mutation of catalog) {
    for (const selector of ANCHORS) {
      const page = await browser.newPage();
      await page.goto(server.url);
      const baseline = await page.evaluate(serializeDom, selector);
      if (!baseline.anchorPath) {
        skipped.push({ mutationId: mutation.id, selector, why: 'anchor not on page' });
        await page.close();
        continue;
      }
      // Mutate the anchor element itself.
      const applied = await page.evaluate(mutation.apply, selector);
      if (!applied) {
        skipped.push({ mutationId: mutation.id, selector, why: 'mutation not applicable' });
        await page.close();
        continue;
      }
      const current = await page.evaluate(serializeDom, null);
      const { verdict, reasons } = classifyDelta(baseline, current, selector);
      rows.push({ source: 'fixture', label, mutationId: mutation.id, selector, verdict, reasons });
      await page.close();
    }
  }
}

await browser.close();
await server.close();

// Committed live pairs (created manually via spikes/capture-live.js).
try {
  for (const file of await readdir(new URL('./live-pairs/', import.meta.url))) {
    if (!file.endsWith('.json')) continue;
    const pair = JSON.parse(await readFile(new URL(`./live-pairs/${file}`, import.meta.url), 'utf8'));
    const { verdict, reasons } = classifyDelta(pair.baseline, pair.current, pair.selector);
    rows.push({ source: 'live', label: pair.label, mutationId: pair.mutationId, selector: pair.selector, verdict, reasons });
  }
} catch { /* no live pairs yet */ }

const misclassified = rows.filter(
  (r) => (r.label === 'cosmetic' && r.verdict === 'semantic')
      || (r.label === 'semantic' && r.verdict === 'cosmetic'),
);
const unclear = rows.filter((r) => r.verdict === 'unclear');
const count = (label, verdict) => rows.filter((r) => r.label === label && r.verdict === verdict).length;

const report = `# flakeproof phase 0 report

Generated by \`spikes/run-phase0.js\`.

## Confusion matrix

| label \\ verdict | cosmetic | semantic | unclear |
|---|---|---|---|
| cosmetic | ${count('cosmetic', 'cosmetic')} | ${count('cosmetic', 'semantic')} | ${count('cosmetic', 'unclear')} |
| semantic | ${count('semantic', 'cosmetic')} | ${count('semantic', 'semantic')} | ${count('semantic', 'unclear')} |

Total cases: ${rows.length} (live: ${rows.filter((r) => r.source === 'live').length}), skipped: ${skipped.length}

## Misclassifications (success criterion: 0)

${misclassified.length === 0 ? 'None.' : misclassified.map((r) => `- ${r.mutationId} at \`${r.selector}\` judged ${r.verdict}: ${r.reasons.join('; ')}`).join('\n')}

## Unclear cases

${unclear.length === 0 ? 'None.' : unclear.map((r) => `- ${r.mutationId} at \`${r.selector}\` (${r.label}): ${r.reasons.join('; ') || 'no signals'}`).join('\n')}

## Skipped

${skipped.length === 0 ? 'None.' : skipped.map((s) => `- ${s.mutationId} at \`${s.selector}\`: ${s.why}`).join('\n')}
`;

await writeFile(new URL('./phase0-report.md', import.meta.url), report, 'utf8');
console.log(report);
process.exit(misclassified.length > 0 ? 1 : 0);
```

- [ ] **Step 2: Live-Capture-Skript schreiben** (manuell auszuführen, nicht Teil von `npm test`)

`spikes/capture-live.js`:

```js
// Manual validation against the real testgilde.de header. Captures labeled
// DOM pairs into spikes/live-pairs/ for run-phase0.js to classify.
// Run manually: node spikes/capture-live.js
import { writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serializeDom } from '../src/probe/serialize.js';
import { cosmeticMutations } from '../src/probe/catalogs/cosmetic.js';
import { semanticMutations } from '../src/probe/catalogs/semantic.js';

const URL_LIVE = 'https://www.testgilde.de/';
// Anchors taken from the example suite (examples/robotframework-testgilde).
const ANCHORS = [
  'ul#menu-main-navigation > li:nth-child(1) > a',
  '.fusion-tb-header .fusion-builder-row-1 a.fusion-button.open-contact',
];

const OUT = new URL('./live-pairs/', import.meta.url);
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
let n = 0;

for (const [label, catalog] of [['cosmetic', cosmeticMutations], ['semantic', semanticMutations]]) {
  for (const mutation of catalog) {
    for (const selector of ANCHORS) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await page.goto(URL_LIVE, { waitUntil: 'domcontentloaded' });
      const baseline = await page.evaluate(serializeDom, selector);
      if (!baseline.anchorPath) { await page.close(); continue; }
      const applied = await page.evaluate(mutation.apply, selector);
      if (!applied) { await page.close(); continue; }
      const current = await page.evaluate(serializeDom, null);
      n += 1;
      const name = `${String(n).padStart(2, '0')}-${label}-${mutation.id}.json`;
      await writeFile(new URL(name, OUT),
        JSON.stringify({ label, mutationId: mutation.id, selector, baseline, current }), 'utf8');
      console.log(`captured ${name}`);
      await page.close();
    }
  }
}

await browser.close();
console.log(`${n} live pairs captured`);
```

- [ ] **Step 3: Messlauf auf der Fixture-Seite ausführen**

Run: `npm run spike`
Expected: Konfusionsmatrix auf stdout, `spikes/phase0-report.md` geschrieben, Exit-Code 0. Bei Exit-Code 1: jede Fehlklassifikation einzeln ansehen — Fix gehört in `classify.js`/`match.js`, danach Messlauf wiederholen. Erwartbar ist ein nennenswerter `unclear`-Anteil bei positionsbezogenen Mutationen (`move-to-end` ohne strukturellen Selektor) — das ist per Design in Ordnung.

- [ ] **Step 4: Live-Paare einfangen und erneut messen**

Run: `node spikes/capture-live.js && npm run spike`
Expected: Live-Paare erscheinen im Bericht (`davon live: > 0`), weiterhin 0 Fehlklassifikationen. Hinweis: hängt von der Erreichbarkeit von testgilde.de ab; schlägt der Capture fehl, wird das im Checkpoint vermerkt und mit den Fixture-Zahlen entschieden.

- [ ] **Step 5: Bericht um Go/No-Go-Abschnitt ergänzen**

In `spikes/phase0-report.md` von Hand unten anfügen (Ergebnis des Checkpoints, ehrlich ausfüllen):

```markdown
## Checkpoint-Bewertung (von Hand ausgefüllt)

- [ ] Spike 1 (Anker): Extraktion aus allen 4 Playwright-Fixture-Formaten + RF output.xml? (Task 4/5 grün)
- [ ] Spike 2 (Klassifikator): 0 Fehlklassifikationen über Fixture- und Live-Paare?
- [ ] Unclear-Quote dokumentiert und erklärbar?

**Entscheidung:** GO / NO-GO für Phase 1 (Begründung in 2–3 Sätzen)
```

- [ ] **Step 6: Commit und Push**

```bash
git add spikes/
git commit -m "feat: phase-0 measurement run, live capture, report"
git push
```

- [ ] **Step 7: Checkpoint** — Bei GO: Phase-1-Plan schreiben (eigenes Plandokument, auf Basis der Spike-Erkenntnisse). Bei NO-GO: Spec-Abschnitt „Offene Risiken" aktualisieren und Zuschnitt neu entscheiden. In beiden Fällen ist das eine neue Planungsrunde, kein Task in diesem Plan.

---

## Self-Review (durchgeführt)

- **Spec-Abdeckung Phase 0:** Spike 1 (Anker) → Tasks 4+5; Spike 2 (Klassifikator) → Tasks 6+7+8; Demo-Objekt Header-Suite → Live-Anker in Task 8 stammen aus der Example-Suite. ✓
- **Typ-Konsistenz:** `serializeDom`-Knotenform wird von `tree.js`, `match.js`, `classify.js` und beiden Spike-Skripten identisch verwendet; `extractAnchor`-Rückgabe in Task 4 definiert, in Task 5 konsumiert. ✓
- **Platzhalter:** keine. Jeder Step enthält vollständigen Code oder exakte Kommandos. ✓
```
