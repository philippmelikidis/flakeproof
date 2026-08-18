# flakeproof

Ein CI-Werkzeug, das E2E-Testsuiten auf ihre zwei blinden Flecken prüft:

- **Blinde Tests** — bleiben grün, obwohl etwas Echtes kaputt ist.
- **Zickige Tests** — werden rot, obwohl sich nur Kosmetik oder Timing geändert hat („flaky").

Dazu verändert es die getestete Seite absichtlich und kontrolliert — echte Änderungen
(Test muss rot werden), kosmetische Änderungen und Timing-Verzögerungen (Test muss grün
bleiben) — und misst, ob die Suite richtig reagiert.

**Phase 1** ist die **Rot-Triage**: Bei rotem Build beantwortet das Werkzeug automatisch,
ob ein echter Fehler vorliegt oder ein fragiler Test — und schlägt bei Fragilität einen
nachweislich robusteren Selektor vor.

Framework-agnostisch: Die Mutation läuft im Browser, pro Test-Framework (Playwright,
Robot Framework, Cypress, Selenium, Puppeteer) genügt ein Mini-Adapter.

## Stand

Design abgestimmt, Umsetzung beginnt mit Phase 0 (zwei Machbarkeits-Spikes).
Vollständige Spec: [docs/superpowers/specs/2026-08-18-e2e-triage-gate-design.md](docs/superpowers/specs/2026-08-18-e2e-triage-gate-design.md)

## Struktur

```
docs/superpowers/specs/            Design-Dokumente
examples/robotframework-testgilde/ Robot-Framework-Suite gegen testgilde.de —
                                   dient als Testobjekt für Phase 0
```
