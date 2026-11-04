# Cycle 8 report: Cypress/Selenium/Puppeteer adapters (#13) + Robot Framework temporal injection (#11)

Branch: `feature/adapters` (from `dev`). All work is committed; working tree is clean.

## Commits

1. `b71dd83` — feat: add anchor extraction and readers for Cypress, Selenium, Puppeteer
2. `1f9a95e` — feat: add temporal injection points for Cypress, Selenium, Puppeteer
3. `c42ab51` — feat: add Robot Framework temporal injection via a listener (closes #11)
4. `6bf3aed` — docs: document Cypress/Selenium/Puppeteer adapters and RF temporal support

## Verification

- `npm test` (`node --test test/*.test.js`), bounded to well under the 30s-per-run expectation for the JS suite alone but the full run (including the real-browser E2E tests) takes ~60s: **404 tests, 404 pass, 0 fail — run twice, both green.** Started the cycle at 374; net +30 tests (17 new adapter unit tests, 11 new inject unit tests, 1 runner "unknown reader" test, 1 real RF temporal e2e test, plus 6 new assertions folded into `test/exports.test.js`, counted by node:test as part of its 1 test).
- `npx eslint .`: clean, 0 problems.
- Working tree is clean after both full-suite runs (no stray `browser/`, `playwright-log.txt`, or other artifacts leak into the repo root — see "RF listener" section below for the fix that ensures this).

## Issue #13: Cypress, Selenium, Puppeteer adapters

Two hooks per framework, as specified: a reader (anchor extraction + result-file parsing) and a temporal injection point.

### Readers / anchor extraction

| Framework | Result format read | Fixture reality |
|---|---|---|
| Cypress | Mocha JSON reporter (`cypress run --reporter json > file.json`; Cypress bundles Mocha, this is Mocha's own reporter, not a Cypress invention) | **REAL.** Captured with `cypress@16.0.0` against this repo's fixture page: `npx cypress run --reporter json` redirected to a file (Cypress writes this reporter to stdout only; `--reporter-options output=` is not honored). See `src/adapters/cypress.js` header comment. Fixture: `test/fixtures/runner/cypress-results.json`. |
| Selenium | Mocha JSON reporter (`mocha --reporter json <spec> > file.json`; plain Mocha is the standard pairing for raw `selenium-webdriver`, not WebdriverIO's own shape) | **REAL.** Captured with `selenium-webdriver` + `chromedriver` + `mocha`, a real headless-Chrome ChromeDriver session against the fixture page: `npx mocha test.spec.js --reporter json > results.json`. Fixture: `test/fixtures/runner/selenium-results.json`. |
| Puppeteer | Jest JSON reporter (`jest --json --outputFile=file.json`; Jest is the most common real-world Puppeteer pairing) | **REAL.** Captured with `puppeteer` + `jest`, a real headless-Chromium session: `NODE_OPTIONS=--experimental-vm-modules npx jest anchor.test.js --json --outputFile=results.json`. Fixture: `test/fixtures/runner/puppeteer-results.json`. |

All three were captured in scratch npm projects outside this repo (to avoid adding Cypress/Selenium/Puppeteer/Jest/Mocha as permanent devDependencies of flakeproof itself, since the project only needs the captured *output*, not a live install, to run its own tests) and copied in verbatim. Raw single-error-text fixtures for `extractAnchor`-level unit tests live at `test/fixtures/errors/{cy,sel,pptr}-*.txt`, each a byte-for-byte real error message from those same sessions.

Mutation checks (an error each adapter must NOT extract an anchor from, confirmed abstaining rather than guessing):

- **Cypress**: `cy.contains('text')` → "Expected to find content: '...' but never did." — text content, not a selector. Abstains (`selector: null`). Test: `cypress-adapter.test.js`.
- **Selenium**: `By.xpath(...)` and `By.linkText(...)` timeouts/NoSuchElementErrors — neither locator strategy has a css equivalent flakeproof's DOM matcher can resolve. Both abstain. Test: `selenium-adapter.test.js`.
- **Puppeteer**: a selector compiled from a non-css query handler (`::-p-xpath(...)`) prints as Puppeteer's internal bracketed combinator JSON, never the original expression or valid css — abstains. The Locator API's own timeout message names no selector at all — also abstains. Test: `puppeteer-adapter.test.js`.

`src/runner/index.js`'s `READERS` registry now has 5 entries (`playwright`, `robot`, `cypress`, `selenium`, `puppeteer`). An unknown `--reader` name (CLI or `runSuite` directly) now throws immediately, before the test command spawns, listing all 5 valid names — verified by a new test that plants a marker file the "test command" would have written if it had ever run, and asserts the marker never appears. `blindspots`'s reader check was generalized from a robot-only special case to "only `playwright` is supported" (with the issue #11 reference preserved for the robot case specifically, so the existing regex-based test for that message still passes).

### Temporal injection points

All three were **verified end to end against a real browser session**, not just unit-tested against stubs: a real element's visibility was measurably delayed by the requested amount, and the resulting ack files matched the exact JSON shape `src/triage/temporal-probe.js` already reads — so the Node-side probe needed zero changes.

- **Puppeteer** (`src/inject/puppeteer.js`): `page.evaluateOnNewDocument()` + `page.exposeFunction()`, reusing `src/probe/temporal.js`'s existing script unchanged. Real capture: `#cta` hidden for 800ms became visible at 842–846ms.
- **Selenium 4** (`src/inject/selenium.js`): the CDP escape hatch named in the issue, `Page.addScriptToEvaluateOnNewDocument`, via `driver.createCDPConnection('page')`. Two things make this its own implementation rather than a thin wrapper: (1) CDP's raw `Runtime.addBinding` delivers exactly one string argument per call, so the injected script serializes `{count, ruleLive}` into JSON rather than calling the report function with two positional arguments; (2) `selenium-webdriver`'s `CDPConnection` has no public event-subscription API for async protocol notifications like `Runtime.bindingCalled` — this listens on the connection's internal `_wsConnection` websocket directly, documented and guarded (falls back to "not installed" rather than throwing if that shape ever changes). Also discovered empirically that `Page.enable` must be called before `Runtime.bindingCalled` events are actually delivered for a script installed via `addScriptToEvaluateOnNewDocument` — undocumented in the CDP spec as far as I could tell, found by direct experimentation. Real capture: `#cta` hidden for 800ms became visible at 866–868ms, with the same two-report pattern (`ruleLive: false` at the immediate DOMContentLoaded-time report, `ruleLive: true` at the end-of-window recount) that `src/probe/temporal.js`'s own header comment documents for Playwright.
- **Cypress** (`src/inject/cypress.js` + `src/inject/cypress-node.js`): `Cypress.on('window:before:load', ...)`, Cypress's documented support-file equivalent of an init script. Split across two files because Cypress webpacks the support file for the *browser*, and the Node-only ack-writer import (`node:fs/promises` etc.) broke that bundling in practice (`UnhandledSchemeError`) when both were in one file — `cypress.js` is pure browser-side code, `cypress-node.js` registers the `cy.task()` handler that does the actual file write (a support-file callback running inside the AUT's window has no other way to reach the filesystem). This is the "two things the user genuinely has to add" the issue anticipated as a legitimate outcome when a zero-touch hook doesn't exist. Also handles a real, unexpected discovery: Cypress 16.0.0 (the version that installed) removed `Cypress.env()` access from support-file callbacks in favor of a new `Cypress.expose()` API; the code tries `expose()` first and falls back to `env()`, so it works on both sides of that version split. Real capture: `#cta` hidden for 800ms, test passed at 906–927ms.

New `package.json` exports: `flakeproof/inject-cypress`, `flakeproof/inject-cypress-node`, `flakeproof/inject-selenium`, `flakeproof/inject-puppeteer`. `files` now includes `rf/` so the Robot Framework listener actually ships.

## Issue #11: Robot Framework temporal injection

**Outcome: DONE**, with an honestly-scoped mechanism (a listener, not a zero-touch hook — investigated and no zero-touch hook exists).

### What was ruled out, and how

Read `src/inject/playwright.js`, `src/triage/temporal-probe.js`, and the installed `robotframework-browser` (Browser library) source directly (`.venv/lib/python3.14/site-packages/Browser/`):

- `New Context`'s full keyword signature (`playwright_state.py`) has no init-script-style parameter at all.
- `Evaluate JavaScript` and `Add Style Tag` (`evaluation.py`) both act on the *current* page, after it has already navigated and loaded — confirmed by tracing the grpc call into the Node wrapper (`page.evaluate(script, arg)` when no selector is given), which is a live-page call, not a pre-navigation hook.
- A Browser Library "plugin" only composes new Python-side keywords from that same keyword surface; it cannot add a new primitive to the library's own bundled Node/Playwright wrapper without patching that vendored dependency.
- The CDP escape hatch used for the Selenium adapter in this same cycle is not available here either: the Browser library owns the actual Playwright connection inside its own Node subprocess and does not expose a raw CDP session to the Python side.

Given that, a **listener** reacting right after `New Page`/`Go To` finishes is the closest available approximation, chosen over a keyword library specifically because it requires **zero changes to the user's `.robot` files** — only a `--listener` flag on the `robot` command line, matching the spirit of `withTemporal`'s "one opt-in, then inert" contract.

### What it can and cannot do (documented plainly, including in the module's own docstring)

- It cannot delay a page's very first paint — by the time `New Page` returns, the page has already fully loaded. What it *can* do, and what actually matters for provoking a "missing wait" failure, is install the hiding rule before the suite's very next keyword gets a chance to observe the anchor element. **Proven empirically, not asserted**: a `Wait For Elements State ... visible` called immediately after measurably waits for the requested delay, because the browser applies a freshly-added CSS rule immediately regardless of when it was added.
- Only the page open at injection time is covered — an iframe, or a page opened without an intervening `New Page`/`Go To` call, would need its own injection point this listener does not reach.
- Requires Robot Framework ≥ 7.0: the listener v3 `end_keyword(data, result)` signature (real `robot.result.model.Keyword` objects with `.name`/`.owner`/`.status`) is new in that release and replaces the older `(name, attrs)` dict-based signature. Verified against the installed Robot Framework 7.4.2; not tested against, and not claimed to work on, earlier versions.

### Evidence contract

Writes into `FLAKEPROOF_TEMPORAL_ACK` with the exact JSON shape `temporal-probe.js` already reads (`{"installed": true, "count": N|null, "ruleLive": true|false|null}`), one uniquely-named file per write — zero changes needed on the Node reading side. Two reports per injection, mirroring `src/probe/temporal.js`'s own two-report pattern: an immediate one at injection time, and a later one read back via a background `threading.Timer` once the delay window has closed (Robot's main thread is busy running the suite's next keywords while the delay is live). A failure anywhere in the listener is caught and swallowed — it must never break the user's suite, matching the same guarantee `src/inject/playwright.js` gives.

### The real run

`test/rf-temporal-e2e.test.js` drives an actual `robot` process (`.venv/bin/robot`, Robot Framework 7.4.2 + Browser library) against a real timing-sensitive suite (`test/fixtures/rf-temporal/flaky.robot`: waits 2500ms for `#cta` to be visible) through the **existing, unmodified** `temporalProbe()`:

- Control round (no injection): passes.
- Delay round (6500ms delay, listener attached via `--listener`): fails deterministically with `TimeoutError: locator.waitFor: Timeout 2500ms exceeded ... locator resolved to hidden <a id="cta" ...>` — the exact "missing wait" signature, matched by `temporalProbe`'s own `reproduced: true` / `matched: 1` / `ruleLive: true` result.

This is the same success criterion already met for Playwright, driven through the identical Node-side machinery.

One test-infrastructure wrinkle worth flagging: the first version of this test reused one fixed `--outputdir` across the several `robot` invocations `temporalProbe` makes back-to-back, and running the whole `npm test` suite in parallel (dozens of concurrent real browsers from the Playwright/Puppeteer/Selenium tests) intermittently made Robot Framework itself exit 252 ("invalid data or command line options") on that shared path — not a timing-margin problem, confirmed by raising the margin from 400ms to a 4-second gap with no change. Fixed with `test/fixtures/rf-temporal/run-isolated.sh`, which gives every single invocation its own fresh `--outputdir` via `mktemp -d` and deletes it afterward. Two full `npm test` runs since that fix are clean.

## Concerns

- `src/inject/selenium.js` relies on `selenium-webdriver`'s `CDPConnection._wsConnection` — an internal, undocumented property, not part of that package's public API. It is guarded (optional chaining, try/catch, falls back to "not installed" rather than throwing) so a future `selenium-webdriver` release that renames or removes it degrades safely, but it could silently stop delivering reports if that happens.
- The Cypress hook is a genuine two-file setup (a support-file call plus a `setupNodeEvents` task registration), not a single line — this was unavoidable given Cypress's browser/Node process split, and is documented as such rather than glossed over.
- `blindspots` (the semantic-mutation lane) remains playwright-only; this cycle only extended the *temporal* lane to the other four frameworks. The README and the `measureBlindspots` rejection message now say this generically rather than singling out `robot`.
- The RF listener's `--listener` mechanism and the Cypress `Cypress.expose()`/`Cypress.env()` compatibility shim were both verified against exactly one installed version each (Robot Framework 7.4.2, Cypress 16.0.0 — the latter released essentially concurrently with this work). Older-version behavior is reasoned about from documentation and API diffs, not independently verified against an actual older install.
