# Design: Header-Test für testgilde.de

**Datum:** 2026-08-18
**Status:** umgesetzt

## Ziel

Eine Robot-Framework-Suite, die prüft, ob der sichtbare Seiten-Header von
testgilde.de korrekt dargestellt wird.

## Entscheidungen

| Frage | Entscheidung | Begründung |
|-------|--------------|------------|
| Was heißt „Header"? | Sichtbarer Seiten-Header (Logo, Navigation, CTA) | Vom Nutzer bestätigt; HTTP-Response-Header waren nicht gemeint |
| Browser-Library | Browser Library (Playwright) | Auto-Waiting reduziert Flakiness, Browser wird per `rfbrowser init` mitinstalliert, kein separater WebDriver |
| Viewport | 1920×1080 | Unterhalb ~1280px klappt das Menü in einen Burger-Button, die Navigation wäre nicht prüfbar |
| Cookie-Banner | „Ablehnen" im Suite Setup | Datensparsamste Option; der Dialog überdeckt sonst den Header |
| Struktur | Testfälle getrennt von Locators/Keywords | Markup-Änderungen der Website betreffen nur die `.resource`-Datei |

## Struktur

```
requirements.txt                    robotframework, robotframework-browser
resources/testgilde_header.resource Locators, Keywords, erwartete Inhalte
tests/header.robot                  Testfälle
```

Die erwarteten Werte (Menüpunkte, Linkziele, CTA-Beschriftung) liegen als Variablen
im Resource-File und sind ohne Code-Kenntnisse pflegbar.

## Suite Setup

1. Chromium öffnen, Viewport 1920×1080
2. `https://www.testgilde.de/` aufrufen
3. Cookie-Banner ablehnen (`.brlbs-btn-accept-only-essential`), falls vorhanden
4. Warten, bis die Kopfleiste sichtbar ist

Setup läuft einmal pro Suite, nicht pro Test — spart sechs Seitenaufrufe.

## Testfälle

1. **Header Wird Angezeigt** — Kopfleiste vorhanden und sichtbar
2. **Logo Wird Angezeigt Und Verlinkt Auf Die Startseite** — Logo sichtbar, `src`
   enthält `testgilde-logo`, umgebender Link zeigt auf `https://www.testgilde.de/`
3. **Hauptmenü Enthält Alle Punkte In Der Richtigen Reihenfolge** — genau
   Leistungen, Lösungen, Unternehmen, Karriere; Reihenfolge wird mitgeprüft
4. **Hauptmenü Verlinkt Auf Die Richtigen Ziele** — datengetrieben über
   `[Template]`, ein Datensatz pro Menüpunkt
5. **Call-To-Action-Button Wird Angezeigt** — „Jetzt anfragen" sichtbar und korrekt
   beschriftet (der Button öffnet ein Overlay und hat bewusst kein `href`)
6. **Header Bleibt Beim Scrollen Sichtbar** — nach 1200px Scroll steht der Header
   weiterhin < 100px vom oberen Rand

## Erkenntnisse aus der Analyse der Zielseite

Die Seite läuft auf WordPress mit dem Avada-Theme (Fusion Builder). Drei Punkte
haben das Design beeinflusst:

- `.fusion-tb-header` hat selbst die Höhe 0, weil seine Kinder absolut positioniert
  sind. Die sichtbare Kopfleiste ist `.fusion-tb-header .fusion-builder-row-1`.
  Ein Sichtbarkeitstest auf dem äußeren Container würde fehlschlagen.
- Logo und CTA existieren doppelt im DOM (helle/dunkle Variante). Playwright läuft
  im Strict Mode und bricht bei mehrdeutigen Selektoren ab — die Locators filtern
  daher mit `:visible`.
- `ul#menu-main-navigation` ist die von WordPress vergebene Menü-ID und deutlich
  stabiler als die generierten Fusion-Klassen. Sie dient als Anker für die Navigation.

Für den Zugriff auf einzelne Menüpunkte ist Playwrights `:text-is()` ungeeignet: Es
matcht das kleinste Element mit dem Text — hier das innere `<span>`, nicht das `<a>`.
Die Menüpunkte werden deshalb über ihre Position angesprochen.

## Bewusst nicht abgedeckt

Mobile-/Burger-Menü, Untermenü-Interaktion, Suchfunktion, CI-Konfiguration,
HTTP-Response-Header.
