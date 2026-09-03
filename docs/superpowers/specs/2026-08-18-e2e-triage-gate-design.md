# Design: flakeproof — E2E-Triage-Gate

**Datum:** 2026-08-18
**Status:** Design abgestimmt, Umsetzung offen

## Problem

Eine E2E-Suite kann auf zwei Arten kaputt sein, und beide Arten sieht heute niemand:

- **Blind** — der Test merkt eine echte Änderung nicht und bleibt grün.
- **Fragil** — der Test fällt bei einer belanglosen Änderung um und wird rot. Das nennt
  man dann „flaky".

Beides hat dieselbe Ursache: wie eng der Test am DOM hängt. `div > div:nth-child(3) > span`
ist gleichzeitig fragil und blind. Mutation Testing misst nur die erste Richtung, und für
E2E-Suites ist es ohnehin nicht verbreitet. Die zweite Richtung misst niemand systematisch —
obwohl sie in der Praxis mehr Zeit kostet.

Der teuerste Einzelposten im Alltag ist dabei nicht die Analyse, sondern eine simple Frage,
die jeden Morgen ein Mensch von Hand beantwortet: **Die Suite ist rot — echter Fehler oder
fragiler Test?**

## Ziel

Ein CI-Werkzeug, das diese Frage automatisch beantwortet, framework-übergreifend
(Playwright, Robot Framework, Cypress, Selenium, Puppeteer), und bei Fragilität gleich
einen belastbaren Gegenvorschlag liefert.

## Kernkonzept

Eine Injektions-Engine, vier Mutationskataloge mit unterschiedlicher Erwartung:

| Katalog | Beispiele | Erwartung | Misst |
|---|---|---|---|
| **Semantisch** | Text ändern, `href` verbiegen, Element entfernen, Reihenfolge tauschen | Test **muss** rot werden | Sensitivität |
| **Kosmetisch** | Wrapper-`<div>`, Klasse ändern, Attributreihenfolge, Whitespace, generierte Hash-Klassen, Element im Baum verschieben | Test **muss** grün bleiben | DOM-Robustheit |
| **Temporal** | Element erscheint 800 ms später, Request antwortet langsam, Animation dauert länger | Test **muss** grün bleiben | Warte-Strategie |
| **Proving** | Alles aus dem kosmetischen Katalog, zusätzlich ein Copy-Tweak (Gross-/Kleinschreibung des ersten Buchstabens kippen) | Der vorgeschlagene Selektor **muss** weiter genau das ursprüngliche Element treffen | Selektor-Robustheit |

Der temporale Katalog macht Flakiness deterministisch: Statt die Suite 500-mal laufen zu
lassen und auf einen Zufallstreffer zu hoffen, wird die Bedingung gezielt provoziert.

Der Proving-Katalog ist kein Katalog über die Suite, sondern über einen
**Selektor-Kandidaten**: Schritt 5 des Triage-Algorithmus (unten) muss den
Gegenvorschlag beweisen, nicht nur gegen den kosmetischen Katalog, der die
Suite selbst prüft. Der Copy-Tweak deckt eine Schwäche ab, die der kosmetische
Katalog gar nicht sieht - ein Textanker, der zufällig auf eine Umformulierung
trifft, die nur die Gross-/Kleinschreibung ändert. Deshalb lebt dieser Katalog
separat (`src/probe/catalogs/proving.js`) und wird ausschliesslich vom Prover
(`src/triage/prove.js`) verwendet; die Klassifikation der Suite selbst und die
Phase-0-Messung bleiben beim reinen kosmetischen Katalog.

Die Mutation passiert **im Browser, nicht im Test-Runner**. Damit ist der Kern
frameworkfrei.

## Abgrenzung des Werkzeugs

Erfasst wird Flakiness aus DOM-Kopplung und Timing. **Nicht** erfasst: Abhängigkeiten
zwischen Tests, Testdaten-Zustand, echter Server-Nichtdeterminismus. Das ist ein großer
Teil des Problems, nicht das ganze. Die Kommunikation nach außen muss das sauber
abgrenzen, sonst entsteht eine Erwartung, die das Werkzeug nicht einlösen kann.

## Zuschnitt Phase 1: Rot-Triage

Phase 1 ist bewusst **kein** Gate mit Schwellwerten, sondern ein Ratgeber bei rotem Build.
Begründung siehe „Rollout".

Von den drei Katalogen braucht Phase 1 nur den **kosmetischen** (für den Selektor-Gegenvorschlag)
und den **temporalen** (für die Nicht-Determinismus-Analyse). Der semantische Katalog kommt
erst in Phase 2 mit der Notenvergabe zum Einsatz; die Katalogstruktur wird aber von Anfang an
so angelegt, dass er sich einhängen lässt.

### Der Triage-Algorithmus

Test X ist rot:

1. **Anker bestimmen.** Der Fehler nennt ihn: `waiting for locator('#submit')`. Jeder
   Adapter extrahiert aus dem Framework-Fehler `{ selektor, fehlerart }`.
2. **Unverändert nachfahren.** Wird der Test grün → nicht-deterministisch. Dann temporalen
   Katalog fahren, bis der Auslöser reproduzierbar ist → Befund: fehlender Wait, mit
   Angabe des Elements und der Verzögerung, ab der es kippt.
3. **Bleibt er rot** → DOM des letzten grünen Laufs aus dem Baseline-Artefakt laden und
   mit dem aktuellen DOM am Ankerpunkt vergleichen.
4. **Delta klassifizieren:**
   - Klassenwert geändert, Wrapper-Element dazugekommen, Element im Baum verschoben,
     generierter Hash-Klassenname (`css-1a2b3c`, `_ngcontent-*`) → **Fragilität**
   - Text, `href`, Rolle geändert, Element fachlich verschwunden → **echter Fund**
5. **Bei Fragilität Gegenvorschlag erzeugen:** Kandidaten aufzählen (`id`, `data-testid`,
   `aria-label`, Rolle+Name, stabile Klasse, Textanker, kurzer Pfad), jeden gegen den
   kosmetischen Katalog fahren, den empfehlen, der die meisten Mutationen überlebt **und**
   eindeutig bleibt. Der Vorschlag wird also bewiesen, nicht geraten.

### Warum dieser Zuschnitt zuerst

Rot-Triage benötigt **keine Berührungskarte** — der Anker steht in der Fehlermeldung. Damit
fällt das größte technische Risiko des Gesamtkonzepts aus Phase 1 heraus und betrifft erst
Phase 2 (Notenvergabe). Zusätzlich erfordert Triage keine Verhaltensänderung im Team und
erzeugt keine Schwellwert-Debatten.

## Baseline-Haltung

Der Vergleich in Schritt 3 braucht den DOM des letzten grünen Laufs. Dieser wird **als
CI-Artefakt abgelegt**, nicht durch Neubauen des Vorgänger-Builds beschafft — Letzteres ist
in den meisten Pipelines zu teuer oder gar nicht möglich.

Für Phase 1 wird der vollständige serialisierte DOM zum Zeitpunkt der relevanten Schritte
gespeichert. Beschnitt auf die berührten Teilbäume ist eine spätere Optimierung und hängt
an der Berührungskarte.

## Architektur

```
core/
  catalogs/      semantisch | kosmetisch | temporal | proving, als reine DOM-Operationen
  probe.js       vor Page-Load injiziert: mutiert, snapshottet, zeichnet auf
  orchestrator/  Auswahl unter Budget, Parallelisierung, Cache
  triage/        Anker-Extraktion, DOM-Diff, Klassifikation, Selektor-Empfehlung
  report/        PR-Kommentar, Exit-Code, HTML
adapters/        playwright | robot | cypress | selenium | puppeteer
```

### Adapter-Schnittstelle

Die zentrale Wette des Projekts: Wer diese zwei Methoden bedienen kann, wird unterstützt.

```
injectBeforeLoad(script)                  Skript vor jedem Seitenaufbau ausführen
runSuite(filter?) -> [{ testId, status, durationMs, error? }]
```

Phase 1 braucht zusätzlich pro Adapter eine kleine, framework-spezifische Funktion:

```
extractAnchor(error) -> { selektor, fehlerart }
```

| Framework | `injectBeforeLoad` | Aufwand |
|---|---|---|
| Playwright | `page.addInitScript()` | trivial |
| RF Browser Library | dieselbe Playwright-Basis | trivial |
| Puppeteer | `page.evaluateOnNewDocument()` | trivial |
| Cypress | Support-File-Hook | klein |
| Selenium 4 | CDP `Page.addScriptToEvaluateOnNewDocument` | klein |

## Laufzeit

Phase 1 läuft nur bei rotem Build und nur für die fehlgeschlagenen Tests — der
Laufzeitdruck ist damit gering. Die Mechanismen werden trotzdem von Anfang an eingebaut,
weil Phase 2 sie zwingend braucht:

1. Nur betroffene Tests (Git-Diff bzw. Fehlerliste)
2. Nur relevante Mutationen
3. Cache über `(Test-Fingerprint, Mutations-ID, Build-Hash)`
4. Hartes Zeitbudget (`--budget`), Mutationen nach Informationsgewinn priorisiert
5. Disjunkte Mutationen bündeln, parallelisieren

**Ein abgeschnittener Lauf muss ausweisen, was ungeprüft blieb.** Ein Gate, das stillschweigend
kürzt, lügt.

## Rollout und Anti-Noise

Nicht verhandelbar — daran sterben Qualitätswerkzeuge, nicht an der Technik:

- **Dreistufig:** erst reiner PR-Kommentar ohne Einfluss auf den Build → dann Ratchet →
  dann hartes Gate. Jede Stufe erst, wenn die vorige unstrittig ist.
- **Jeder Befund lokal reproduzierbar** mit einem Kommando, das im Kommentar steht.
- **Nur melden, was reproduziert wurde.** Lieber ein Befund weniger als ein falscher.
- **Kein Befund ohne Vorschlag.** „Selektor ist fragil" ist wertlos; „nimm
  `#menu-main-navigation`, überlebt 14 von 14 kosmetischen Mutationen" ist eine
  Handlungsanweisung.

## Offene Risiken

| Risiko | Betrifft | Umgang |
|---|---|---|
| Klassifikation kosmetisch vs. semantisch trifft daneben | Phase 1, zentral | Spike an echten DOM-Paaren; im Zweifel „unklar" melden statt falsch zu klassifizieren |
| Anker-Extraktion aus Fehlermeldungen pro Framework brüchig | Phase 1 | Pro Adapter klein und einzeln testbar; Fehlschlag degradiert zu „keine Aussage" |
| Wiederfinden desselben Elements im geänderten DOM | Phase 1 | Ähnlichkeitsmaß über Tag, Rolle, zugänglichen Namen, Text, `href`, Geschwisterposition |
| Berührungskarte frameworkagnostisch erfassbar? | Phase 2 | Eigener Spike vor Phase 2; In-Page-Hooks auf Lese-APIs plus `MutationObserver` |
| Baseline-Artefakte werden groß | Phase 1 | Vorerst hinnehmen, Beschnitt ist Phase-2-Optimierung |

## Phase 0: Spike vor der Umsetzung

Zwei Fragen, die das Design kippen können, wenn sie schlecht ausgehen:

1. **Klassifikator:** An echten DOM-Paaren zweier Builds prüfen, ob kosmetische und
   semantische Deltas verlässlich unterscheidbar sind. Genügt die Trefferquote nicht,
   muss Phase 1 anders zugeschnitten werden.
2. **Anker-Extraktion:** Für Playwright und Robot Framework Browser Library nachweisen,
   dass sich Selektor und Fehlerart robust aus dem Fehler ziehen lassen.

Demo-Objekt ist die bestehende Header-Suite in diesem Repository.

## Erfolgskriterien Phase 1

- Für einen rot gewordenen Test liefert das Werkzeug eine Klassifikation mit Begründung
- Bei Fragilität einen Selektor-Vorschlag, dessen Robustheit belegt ist
- Bei Nicht-Determinismus die Bedingung, unter der der Test reproduzierbar umfällt
- Läuft gegen mindestens zwei Frameworks über dieselbe Kern-Engine
- Keine falsch-positive Klassifikation in der Erprobung; „unklar" ist ein zulässiges Ergebnis

## Bewusst nicht in Phase 1

Notenvergabe für neue Tests, Ratchet, hartes Gate, Berührungskarte, Beschnitt der
Baseline-Artefakte, Adapter jenseits von Playwright und Robot Framework.

## Name

**flakeproof** — npm, PyPI und GitHub-Suche waren zum Zeitpunkt der Entscheidung frei
(0 Namenskollisionen auf GitHub). Doppelsinn aus *proof* (Beweis — das Werkzeug beweist
seine Befunde) und *-proof* (geschützt gegen Flakes).
