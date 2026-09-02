# Design: Visueller HTML-Report und mehrere Empfehlungen

**Datum:** 2026-08-28
**Status:** Design abgestimmt, Umsetzung offen

## Problem

Das Werkzeug funktioniert, aber es erklärt sich nicht. Zwei konkrete Mängel:

1. **Nur eine Empfehlung.** Für ein anonymes Element entsteht heute oft genau ein
   Kandidat (ein positionsbasierter `nth-child`-Selektor), also ausgerechnet die
   fragilste Form. Der Nutzer hat keine Auswahl.
2. **Der Report ist ein Textblock für Technikerinnen.** Er nennt das Urteil und
   eine Zeile Beleg. Was flakeproof tatsächlich getan hat, wie der Zustand vorher
   und nachher aussah und warum das Urteil so lautet, bleibt unsichtbar. Ohne
   diese Transparenz ist das Urteil eine Behauptung, die man glauben muss.

## Ziel

Ein Bericht, den man öffnet und ohne Vorwissen versteht: was war vorher, was ist
jetzt, warum dieses Urteil, welche Schritte wurden ausgeführt, und welche
stabileren Selektoren stehen zur Wahl.

## Abgrenzung

**Nicht Teil dieser Spec:** der Auto-Runner, der eine ganze Testsuite ohne
manuelle Eingaben durchfährt (Baseline, Fehlertext und aktueller Build bleiben
die Eingaben). Das ist der nächste Meilenstein. Ebenfalls nicht dabei: echte
Element-Screenshots.

## Feature 1: Mehrere gerankte Empfehlungen

**Neue Kandidatenart `container-text`.** Ein strukturelles Elternelement wird
über den Text eines Kindes gebunden, zum Beispiel
`#main-nav li:has-text("Products")`. Diese Form überlebt Klassenwechsel und
Umsortierung und gibt anonymen Elementen (`<li>`, `<div>`) eine sinnvolle
Alternative zum Positionsselektor.

- Erzeugt, wenn das Element selbst keinen eigenen Text hat, aber genau ein Kind
  mit eindeutigem Text existiert und ein Vorfahre mit `id` als Anker dient.
- Eindeutigkeit wird tree-seitig approximiert (genau ein Element im Baum mit
  dieser Kombination); die echte Verifikation macht wie bei `text`/`role` der
  Prover über `page.locator`.
- Fail closed: kein Kandidat bei leerem Text, Text über 80 Zeichen oder Text mit
  Anführungszeichen.

**Rangfolge im Raw-Array:** id, testid, aria, text, role, container-text, class,
scoped, positional. Positionsselektoren bleiben letzte Wahl.

**Report zeigt alle Überlebenden.** Der Text-Report zeigt weiterhin die gefilterte
Tabelle; der HTML-Report zeigt jede bewiesene Empfehlung als eigene Karte, nicht
nur die erste.

## Feature 2: HTML-Report

Neues Modul `src/report-html.js` mit `renderHtmlReport(result) -> string`. Erzeugt
**eine einzige, in sich geschlossene HTML-Datei**: CSS inline, keine externen
Ressourcen, keine Skripte, offline lesbar und an einen Pull Request anhängbar.

### Aufbau

1. **Urteil in Klartext.** Große Überschrift plus ein Satz, was das Urteil
   bedeutet ("Der Test ist fragil: die Seite ist in Ordnung, der Test hängt an
   einer Kleinigkeit, die sich geändert hat.").
2. **Der Test.** Testname (falls bekannt) und der Anker, an dem er hing.
3. **Vorher / Nachher am Anker.** Zwei Karten nebeneinander. Je Karte: eine
   Beschreibung in Alltagssprache (Elementart, Text, Ziel) und darunter der
   HTML-Ausschnitt des Elements mit farblich markierter Differenz (entfernte und
   hinzugekommene Teile hervorgehoben). Kein Baseline-Screenshot: das gespeicherte
   HTML wird ohne sein CSS geladen, ein Bild davon wäre irreführend.
4. **Warum dieses Urteil.** Die Belege aus der Klassifikation, in einfacher
   Sprache formuliert.
5. **Was flakeproof getan hat.** Die ausgeführten Schritte als lesbare Zeitleiste:
   Anker aus der Fehlermeldung gelesen, in der Baseline gefunden, Baum und HTML
   auf Übereinstimmung geprüft, mit dem aktuellen Build verglichen, Kandidaten
   erzeugt, im Browser gegen Mutationen bewiesen. Jeder Schritt mit Ergebnis.
6. **Empfehlungen.** Gerankte Karten: Selektor, Art, Eindeutigkeit und der Beweis
   in lesbarer Form ("übersteht: Klasse umbenannt ja, Wrapper ja, verschoben
   nein — 4 von 5").
7. **Timing** (nur bei `nondeterministic`): die geprüften Verzögerungen als
   Tabelle plus der Reproduktionssatz.

### CLI

- `--out <datei.html>` erzeugt den HTML-Report (an der Endung `.html` erkannt),
  jede andere Endung erzeugt weiterhin Markdown.
- `--open` öffnet die erzeugte Datei im Standardbrowser (nur zusammen mit
  `--out`).
- Ohne `--out` bleibt die Textausgabe auf stdout der Default, damit CI-Logs und
  Terminalnutzung unverändert funktionieren.

## Datenfluss

`triage()` liefert zusätzlich ein optionales Feld `detail`:

```
detail: {
  anchorBefore: { tag, id, classes, text, attrs, html },
  anchorAfter:  { tag, id, classes, text, attrs, html } | null,
  steps: Array<{ label: string, outcome: string, ok: boolean }>
}
```

`anchorBefore`/`anchorAfter` sind die serialisierten Knoten plus ein kompakter
HTML-Ausschnitt des Elements. `steps` wird während des Durchlaufs gefüllt.
Der Markdown-Report ignoriert `detail` vollständig, der HTML-Report nutzt es.
Damit bleibt die bestehende Ergebnisform rückwärtskompatibel.

## Fehlerfälle

Jedes Urteil bekommt einen vollständigen HTML-Report, auch `no-anchor`,
`unclear` und `real-change`. Fehlt ein Abschnitt mangels Daten (kein
Nachher-Element, weil entfernt), erklärt der Report das ausdrücklich statt den
Abschnitt wegzulassen. Die Zeitleiste zeigt immer alle versuchten Schritte,
auch die gescheiterten.

## Tests

- `renderHtmlReport` enthält für jedes Urteil die Pflichtabschnitte
- Der HTML-Report ist self-contained: kein `http`-Verweis, kein `<script>`
- Alle bewiesenen Empfehlungen erscheinen, nicht nur die erste
- `container-text`-Kandidat wird für ein anonymes Element mit eindeutigem
  Kindtext erzeugt und bei mehrdeutigem Text verworfen
- E2E: `--out report.html` gegen die Fixture-Builds erzeugt eine Datei mit allen
  Abschnitten
- Die bestehenden 92 Tests bleiben unverändert grün

## Erfolgskriterium

Jemand ohne Vorwissen öffnet die Datei und kann in einer Minute sagen: was war
kaputt, warum sagt das Werkzeug das, was hat es geprüft, und was soll ich jetzt
ändern.
