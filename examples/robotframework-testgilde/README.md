# TestGilde Header-Tests

Robot-Framework-Suite, die den sichtbaren Seiten-Header von
[testgilde.de](https://www.testgilde.de/) prüft: Logo, Hauptnavigation,
Call-to-Action-Button und Sticky-Verhalten.

## Einrichtung

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/rfbrowser init
```

`rfbrowser init` lädt Node.js und den Playwright-Chromium herunter (einige hundert MB,
läuft ein paar Minuten). Das ist nur einmal nötig.

## Tests ausführen

```bash
.venv/bin/robot --outputdir results tests/header.robot
```

Ergebnisse landen in `results/` — `report.html` für die Übersicht, `log.html` für
die Details inklusive automatischer Screenshots bei Fehlern.

Mit sichtbarem Browser statt headless:

```bash
.venv/bin/robot --outputdir results --variable HEADLESS:False tests/header.robot
```

## Aufbau

```
tests/header.robot                  Testfälle — beschreiben nur das erwartete Verhalten
resources/testgilde_header.resource Locators, Keywords und erwartete Inhalte
```

Diese Trennung sorgt dafür, dass bei einer Markup-Änderung der Website nur die
`.resource`-Datei angefasst werden muss. Die erwarteten Menüpunkte, Linkziele und
Beschriftungen stehen als Variablen am Anfang dieser Datei und lassen sich dort
ohne Code-Kenntnisse pflegen.

## Testfälle

| Test | Prüft |
|------|-------|
| Header Wird Angezeigt | Die Kopfleiste ist vorhanden und sichtbar |
| Logo Wird Angezeigt Und Verlinkt Auf Die Startseite | Logo sichtbar, richtige Grafik, Link auf `/` |
| Hauptmenü Enthält Alle Punkte In Der Richtigen Reihenfolge | Genau Leistungen, Lösungen, Unternehmen, Karriere |
| Hauptmenü Verlinkt Auf Die Richtigen Ziele | Jeder Menüpunkt zeigt auf seine Seite |
| Call-To-Action-Button Wird Angezeigt | „Jetzt anfragen" sichtbar und korrekt beschriftet |
| Header Bleibt Beim Scrollen Sichtbar | Header klebt nach dem Scrollen weiter oben |

## Wissenswertes zur Zielseite

Drei Eigenheiten von testgilde.de, die das Testdesign bestimmt haben:

- **Viewport-Breite ist relevant.** Unterhalb von ca. 1280px klappt das Hauptmenü in
  einen Burger-Button. Die Suite fährt deshalb 1920×1080, sonst wäre die Navigation
  gar nicht sichtbar.
- **Cookie-Banner.** Borlabs Cookie legt beim ersten Aufruf einen Dialog über die Seite.
  Das Suite Setup klickt „Ablehnen" (nur technisch notwendige Cookies). Fehlt der
  Banner, läuft der Test trotzdem durch.
- **Elemente existieren doppelt im DOM.** Logo und CTA-Button sind je zweimal angelegt
  (helle und dunkle Variante). Die Locators filtern mit `:visible` auf das jeweils
  gezeigte Element — ohne diesen Filter bricht Playwright im Strict Mode ab.

## Grenzen

Die Suite testet gegen die **Live-Website**. Sie schlägt fehl, wenn die Seite nicht
erreichbar ist, und sie prüft den Header nur auf der Startseite in Desktop-Breite.
Mobile Ansicht, Untermenüs und die Suchfunktion sind bewusst nicht abgedeckt.
