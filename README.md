# flakeproof

**When CI goes red, flakeproof tells you whether it is a real bug, a fragile test, or plain flakiness. And when the test is fragile, it proves a better selector instead of guessing one.**

## The problem

An end-to-end test suite can be broken in two ways, and nobody measures either:

- **Blind tests** stay green while something real breaks, because they never actually checked it.
- **Fragile tests** go red over nothing: a class name changes, a wrapper div appears, an element loads a second later. Everyone calls this flaky, files it away, and pays for it every morning.

Both have the same root cause: how tightly a test is coupled to the DOM. A selector like `div > div:nth-child(3) > span` is fragile and blind at the same time. Today the only instrument for telling a real failure from a fragile one is a human with coffee.

## How it works

flakeproof mutates the page under test on purpose, in controlled ways, and watches how tests and selectors react:

| Mutation type | Example | A good test must |
|---|---|---|
| Semantic | button text changed, link target changed, element removed | go red |
| Cosmetic | class renamed, wrapper div added, element moved | stay green |
| Temporal | element appears 800 ms later | stay green |

Green under semantic changes means blind. Red under cosmetic or timing changes means fragile. Think of a smoke detector tester that produces both smoke and toast: a good detector beeps at one and ignores the other.

The mutations run inside the browser, not inside the test runner, so the core is framework agnostic. Playwright, Robot Framework, Cypress, Selenium and Puppeteer all have an anchor-extraction reader today; the temporal injection point (the piece that lets flakeproof provoke a delay inside your own suite) ships for Playwright, Robot Framework, Cypress, Selenium and Puppeteer as well - see "Catching missing waits" below for each framework's setup and its honest limits.

## Installation

flakeproof is not published to npm yet (see `docs/publishing.md` for what that would take), so `npx flakeproof` does not work today. Clone the repository and run it straight from the checkout instead:

    git clone https://github.com/philippmelikidis/flakeproof.git
    cd flakeproof
    npm install
    npx playwright install chromium
    node bin/flakeproof.js

The last command prints usage and exits with a non-zero status (there is no dedicated `--help` flag yet); that is expected and confirms the CLI is reachable.

Every command below is written as `node bin/flakeproof.js <command>` for that reason. If you scripted an older example that used `npx flakeproof`, replace it with `node bin/flakeproof.js` (from the repository root, or an absolute/relative path to `bin/flakeproof.js` from elsewhere).

## Red triage

The first shipped workflow. While the build is green, capture a baseline:

    node bin/flakeproof.js snapshot https://your-app.example --out baseline.json

When CI goes red, hand flakeproof the failure and the current build:

    node bin/flakeproof.js triage --baseline baseline.json --robot-xml output.xml --current-url https://your-app.example
    node bin/flakeproof.js triage --baseline baseline.json --error-file error.txt --current-url https://your-app.example --rerun-cmd "npx playwright test -g checkout"

flakeproof extracts the anchor (the locator the test was hanging on) from the real error message, optionally reruns the test to catch nondeterminism, compares the baseline DOM against the current build at exactly that anchor, and answers with one of five verdicts:

| Verdict | Meaning |
|---|---|
| `real-change` | meaning changed at the anchor: probable regression, go look at the app |
| `fragile` | the selector broke on a meaning-free coupling: fix the test, suggestions included |
| `nondeterministic` | reruns disagree; with --temporal the missing wait is pinpointed by provoked delays |
| `unclear` | evidence is mixed or missing: flakeproof does not guess |
| `no-anchor` | the error names no locator, nothing to triage against |

For fragile tests the report includes selector recommendations that are proven, not guessed: every candidate is run against the proving catalog in a real browser (the cosmetic mutations plus a copy tweak, so text based candidates cannot win by construction), and only survivors are ranked.

```
# flakeproof triage

Verdict: **fragile**
Anchor: `li.css-1a2b3c` (timeout)

## Evidence
- selector relies on build-generated class ".css-1a2b3c" which is gone from the element

## Recommended selectors

| selector | kind | unique | survived mutations |
|---|---|---|---|
| `#main-nav li:nth-child(1)` | positional | yes | 4/5 |
```

### One command instead of three paths

Assembling a baseline, an error file and a url by hand for every failure gets old fast. Record a baseline once while the build is green:

    node bin/flakeproof.js baseline https://your-app.example

Then, whenever the suite goes red, let flakeproof drive it:

    node bin/flakeproof.js run --cmd "npx playwright test" --url https://your-app.example --out run.html

It runs your command, reads which tests failed straight from the reporter output, triages each one, and writes a single page with a verdict per test. Put the repeated values in `flakeproof.config.json` and the command shrinks to `node bin/flakeproof.js run`:

    { "cmd": "npx playwright test", "url": "https://your-app.example", "results": "results.json" }

Robot Framework works the same way with `--reader robot --results output.xml`. Cypress, Selenium and Puppeteer suites work the same way too, with `--reader cypress|selenium|puppeteer` (see "Framework adapters" below for what result file each one expects and their honesty limits on anchor extraction). An unrecognized `--reader` name fails immediately with the list of valid ones, before your test command ever runs.

### A report you can actually read

The text report above is what lands in a CI log. For a human, ask for html instead:

    node bin/flakeproof.js triage --baseline baseline.json --error-file error.txt --current-url https://your-app.example --out report.html --open

That writes a single self-contained file (inline css, no scripts, no external resources) that spells out what happened: the verdict in plain words, the anchor element before and after with the difference highlighted, the evidence behind the verdict, every step flakeproof took, and all proven selector candidates ranked, not just the first one.

Honesty is a design rule here: `unclear` is a first-class verdict, abstaining beats asserting, and a recommendation that failed proving is never shown as safe.

### CLI reference

`flakeproof` below stands for `node bin/flakeproof.js` (see "Installation" above).

    flakeproof snapshot <url> [--anchor <selector>] --out <file.json>
    flakeproof triage --baseline <file.json>
                      (--error-file <file> | --robot-xml <output.xml>)
                      (--current-url <url> | --current <file.json>)
                      [--rerun-cmd <command>] [--reruns <n>] [--temporal] [--json] [--out <file.md|file.html>] [--open]
    flakeproof baseline <url> [--out <file.json>]
    flakeproof run [--cmd <command>] [--url <url>] [--results <file>] [--reader playwright|robot]
                   [--baseline <file.json>] [--out <file.md|file.html>]
    flakeproof blindspots [--cmd <command>] [--results <file>] [--reader playwright]
                          --selectors <sel1,sel2,...> [--mutations <id1,id2,...>]
                          [--runs <n>] [--budget <n>]
                          [--json] [--out <file.md|file.html>]

Exit code 0 whenever a verdict was produced (including `unclear`), 1 on usage or runtime errors. For run, the exit code is 0 when the suite was triaged, whether or not tests failed, and 1 when the setup was unusable or a flag was missing. For blindspots, the exit code is 1 whenever the honesty rules make it abstain (see below), and 0 whenever a score was actually printed.

### Catching missing waits

Flaky tests usually mean a missing wait, but nobody can point at it. With the temporal lane flakeproof finds it: pass `--temporal` together with `--rerun-cmd`, and when reruns disagree, flakeproof reruns the test with the anchor element deliberately delayed by increasing amounts until the failure reproduces on every run. The report then says: `fails on every run when "#submit" appears 500 ms late; likely a missing wait`.

Two guards keep that claim honest: a control run without any delay must pass first (a baseline that already fails on its own aborts the probe instead of blaming timing), and the inject wrapper acknowledges every injection, so a missing setup is reported as exactly that rather than being mistaken for proof that timing is fine. `--rerun-cmd` is just a shell command, so this works the same way regardless of which framework's reader you use - the setup below is what makes that command's own run honor the delay.

This needs a one-time, permanently inert setup, different per framework:

**Playwright** - wrap your base test once:

    // fixtures.js
    import { test as base } from '@playwright/test';
    import { withTemporal } from 'flakeproof/inject';
    export const test = withTemporal(base);

**Robot Framework** - attach the listener on the command line, no `.robot` file changes:

    robot --listener /path/to/node_modules/flakeproof/rf/FlakeproofTemporalListener.py suite.robot

The listener reacts right after `New Page`/`Go To` (Browser library) finishes, installing the same hiding rule and writing the same ack receipts `temporalProbe` already reads - no changes needed on the reading side. It cannot delay a page's very first paint the way a true init script would (Browser library has no such hook to begin with - see the listener's own docstring, `rf/FlakeproofTemporalListener.py`, for exactly what was checked and ruled out), only what the very next keyword goes on to observe, and it only covers the page open at injection time, not iframes. Requires Robot Framework >= 7.0 (the listener v3 API used here is new in that release).

**Cypress** - two small additions, because a support-file hook runs inside the browser and has no direct way to write a file; see `src/inject/cypress.js`'s header comment for the full two-file example (`cypress.config.js` registers the `cy.task` that does the writing, the support file calls `installTemporal()`).

**Selenium 4** - one call before your first navigation, using the CDP escape hatch (Chromium only):

    import { installTemporal } from 'flakeproof/inject-selenium';
    const driver = await new Builder().forBrowser('chrome').build();
    await installTemporal(driver);
    await driver.get(url);

**Puppeteer** - one call per page, before its first navigation:

    import { installTemporal } from 'flakeproof/inject-puppeteer';
    const page = await browser.newPage();
    await installTemporal(page);
    await page.goto(url);

All four non-Playwright hooks were verified against this repo's own fixture page with a real browser session each (a real element's visibility measurably delayed by the requested amount, with matching ack receipts) - see this project's cycle reports under `.superpowers/sdd/` for the exact captures.

### Framework adapters

Every reader turns a framework's own result file into the same `{ testId, message, anchor }` shape, and every anchor extractor is built from real captured failures (`test/fixtures/errors/`), not invented ones - see the adapter source files for exactly what was captured and how. Locator syntaxes differ across frameworks, and not every one can be expressed as a css selector flakeproof's DOM matcher can resolve; when it can't, the adapter abstains (`selector: null`) instead of guessing:

| Reader | Result file | Cannot resolve (abstains) |
|---|---|---|
| `playwright` | `@playwright/test`'s json reporter | - |
| `robot` | Robot Framework's `output.xml` | - |
| `cypress` | Mocha JSON reporter (`cypress run --reporter json > file.json`) | `cy.contains(...)` - text content, not a selector |
| `selenium` | Mocha JSON reporter (`mocha --reporter json <spec> > file.json`) | `By.xpath`, `By.linkText`, `By.partialLinkText` |
| `puppeteer` | Jest JSON reporter (`jest --json --outputFile=file.json`) | `::-p-xpath`/`::-p-text` compiled selectors, the Locator API's timeout (names no selector at all) |

## Blindspots: does the suite notice anything at all?

Red triage answers "is this red test a real bug or a fragile test". It says nothing about a green suite. A green test today means either "nothing is broken" or "the test is blind", and nobody can tell which. Unit tests have mutation testing for this; E2E suites have had nothing, until now.

`flakeproof blindspots` injects one semantic mutation at a time from the catalog (change an element's text, bend its `href`, remove it) into a real run of your suite, and reports which changes went unnoticed:

    The suite notices 1 of 2 changes it was actually tested against.

    ## Unnoticed

    - `#cta`: Point the target link somewhere else

Usage:

    node bin/flakeproof.js blindspots --cmd "npx playwright test" --results results.json \
                          --selectors "#header-title,#cta" [--mutations change-text,change-href] \
                          [--out report.html]

or config-backed, in `flakeproof.config.json`:

    { "cmd": "npx playwright test", "results": "results.json",
      "blindspots": { "selectors": ["#header-title", "#cta"] } }

Selectors are supplied by you, not guessed from a baseline or inferred as "interesting" - predictable input, and a report that can always name the exact element (in your own words) each mutation targeted, beats a heuristic that might silently target the wrong thing. Every `(selector, mutation)` pair from the catalog is one experiment. A compound css selector list like `".a, .b"` is not supported as a single target yet: a comma followed by a space is rejected outright rather than silently guessed as two separate targets, since flakeproof cannot tell the two intents apart from the string alone. Write `--selectors ".a,.b"` (no space) if you meant two targets.

The same `withTemporal` wrapper used for the Playwright temporal lane is the injection point here too (it now reacts to a second, independent set of `FLAKEPROOF_MUTATION_*` env vars); nothing new to wire up if you already use it. Blindspots is playwright-only for now: Robot Framework has no injection wrapper at all for the semantic-mutation catalog (its temporal lane is covered separately, see "Catching missing waits"), and Cypress, Selenium and Puppeteer only got a temporal injection point in this cycle, not a mutation one - `--reader` anything other than `playwright` is rejected upfront rather than running a control pass that could never produce a real acknowledgment.

By default every control run and every mutation round runs twice (`--runs`, default 2) and a round only counts as noticed when the suite is red on **every** run - a suite that is merely flaky for unrelated reasons cannot fabricate a perfect score just because one unlucky run happened to fail. A round whose runs disagree is reported as inconclusive, not unnoticed. `--budget <n>` caps the total number of suite invocations across the whole measurement; when the budget cuts the mutation list short, the report says exactly which experiments were skipped rather than looking like full coverage.

Honesty rules this command will not bend on:

- **A mutation that never actually touched the page does not count as unnoticed.** If the selector matched nothing (even after giving a client-rendered element a bounded chance to appear), the element had no `href` to change, the installed wrapper does not recognize the mutation id (a version mismatch), or the page never reported back at all (for example the suite crashed), that experiment did not happen or could not be confirmed. It is reported under "Not applied", with its own specific reason, and excluded from the score entirely - the denominator is always the number of mutations that were both applied AND actually judged, never the number attempted.
- **A mutation that applied but did not survive to the suite's own assertions does not count as unnoticed either.** Ordinary hydration (React, Vue, Svelte, client-side i18n) can silently rewrite the mutated node shortly after it was applied. flakeproof watches the page for as long as it lives - not a fixed window - and reports a confirmed revert under "Reverted before assertions" instead: the suite never got a fair look at that change, so scoring it as blind would be dishonest. Watching for the page's whole lifetime is not the same as watching forever: a revert that happens after the page has already finished tearing down, with no further DOM change for the wrapper to react to, cannot be observed.
- **Silence about survival is not proof of anything.** When the page closes (or the process ends) before the wrapper can confirm one way or the other whether the mutation held, that round is reported under "Could not confirm survival" and excluded from the score - never quietly counted as "noticed" or "unnoticed" just because nothing said otherwise.
- **A round the suite disagreed with itself across is inconclusive, not scored either way.** Two coin flips must never fake causality: a mutation is only "noticed" when every run of that round was red, and the specific test named as the catcher must have been red on every one of those runs too. In the other direction, a single run that positively observed the mutation being reverted is enough on its own to exclude the round - a second run simply failing to observe the same revert never overrides it.
- **A mutation that never touched the page still going red is proof against every other score in the measurement.** If a round is confirmed not-applied and the suite is red anyway, something other than the injected mutations is causing failures - a backend dependency, an unrelated regression, or the mutation wrapper itself breaking the suite. flakeproof abstains for the whole measurement rather than let any other round's redness be scored as "noticed".
- **If the wrapper never acknowledges a run, flakeproof refuses to print a score.** A suite that stays green because flakeproof never reached the page is not a blind suite, it is an unmeasured one. The report tells you exactly how to install the wrapper instead.
- **A suite that is already red, or unreliable, before any mutation cannot be measured.** Every control run must pass, and none may exit non-zero while its own result file claims zero failures (a reporter misconfiguration); either aborts the measurement instead of attributing anything to a mutation.

What this tool cannot tell you: whether your assertions are *correct*, only whether they would notice a specific catalog of meaningful changes. A suite can score well here and still assert the wrong thing; blindspots only rules out one specific, common way of being wrong.

## GitHub Action: the red-run gate

`action.yml` at the repository root wraps `node bin/flakeproof.js run` as a reusable composite action: it runs your test command, triages whichever tests failed, posts (or updates) a markdown summary as a pull request comment, and uploads the full HTML report as a workflow artifact. This is the "Rollout" stage described in `docs/superpowers/specs/2026-08-18-e2e-triage-gate-design.md`: a PR comment first, no influence on the merge decision, before anything stricter is even considered.

**Exit-code policy: the gate comments, it does not block, by default.** `blocking` defaults to `"false"`: whatever flakeproof concludes, the job stays green and the comment is the only signal. A gate that can block a merge on a wrong verdict is worse than no gate, and the design spec calls for adopting each rollout stage only once the previous one is unanimously trusted. Set `blocking: "true"` only once your team has actually built that trust. A genuinely broken setup (no test command, no baseline found anywhere) is different from a triage opinion and always fails the job, in every mode - flakeproof does not invent a baseline to work around a missing one.

Minimal usage, with a baseline already committed to the repository at `.flakeproof/baseline.json`:

```yaml
name: flakeproof gate
on: pull_request

permissions:
  pull-requests: write   # required so the action can post/update the PR comment
  contents: read

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: philippmelikidis/flakeproof@main
        with:
          test-command: npx playwright test
          app-url: https://staging.your-app.example
```

If your baseline is produced by an earlier job and uploaded as a workflow artifact instead of committed to the repo, restore it by name:

```yaml
      - uses: philippmelikidis/flakeproof@main
        with:
          test-command: npx playwright test
          app-url: https://staging.your-app.example
          baseline-artifact-name: flakeproof-baseline
```

If neither a committed file nor a matching artifact provides a baseline at `baseline-path`, the action fails the step with the same actionable message the CLI gives for a missing baseline (see `run-and-report.js`'s `SetupError`), rather than guessing one.

Inputs mirror `flakeproof.config.json` so a project that already has one passes almost nothing: `test-command`/`app-url`/`results-path`/`reader`/`baseline-path` all fall back to the config file's `cmd`/`url`/`results`/`reader`/`baseline` keys, and then to the same defaults the CLI uses. Other inputs: `working-directory`, `install-command` (default `npm ci`), `install-playwright-browsers` (default `true`), `node-version` (default `20`), `comment` (default `true`), `artifact-name` (default `flakeproof-report`), `blocking` (default `false`), `github-token` (default `github.token`).

The comment is updated in place on every push to the pull request (matched by a hidden marker in the comment body), rather than piling up a new one each time, and it says plainly when flakeproof abstained - either because it could not tell which tests failed at all, or because individual verdicts came back `unclear`, `no-anchor` or `nondeterministic` - instead of letting silence read as a clean bill of health.

### Verified locally vs. not verified

This action has not been run on GitHub's own infrastructure as part of this change (that requires a live PR and a running app to gate). What was checked without that:

- `action/scripts/resolve-inputs.js`, `run-and-report.js` and `post-comment.js` are unit-tested directly (`test/action-resolve-inputs.test.js`, `test/action-run-and-report.test.js`, `test/action-post-comment.test.js`), including the GitHub REST calls in `post-comment.js` against an injected fake `fetch`.
- `test/action-yaml.test.js` structurally validates `action.yml`: required composite-action keys are present, every `${{ inputs.X }}` and `${{ steps.ID.outputs.Y }}` expression resolves to something actually declared, every `run:` step declares `shell:`, every `uses:` is pinned to a tag, and every script path the action invokes exists on disk. This is a purpose-built scanner for this file's shape, not a general yaml/schema validator.

Not verified: the actual GitHub Actions runtime behaviour (composite `if:` conditions, `actions/download-artifact` and `actions/upload-artifact` outputs like `artifact-url`, how `working-directory` interacts with `github.action_path` when this action is consumed from a different repository, and the pull-request comment round-trip against the real GitHub API).

## Status

Phase 1 (red triage MVP) and phase 2 (temporal lane, blindspots sensitivity scoring) are complete. Phase 0 established the measurement foundation: across 37 mutated fixture and live-site cases the classifier produced 0 misclassifications, with every abstention documented. Full numbers in `spikes/phase0-report.md`, reproducible via `npm run spike`.

Anchor extraction and a temporal injection point now exist for Cypress, Selenium and Puppeteer alongside Playwright and Robot Framework - five frameworks share the same triage core. Robot Framework's temporal lane (issue #11) is also done: a listener gives an RF Browser Library suite the same provoked-delay reproduction Playwright users get, without touching the suite's own `.robot` files.

On the roadmap: blindspots' semantic-mutation injection for Robot Framework, Cypress, Selenium and Puppeteer (today it is playwright-only), proving candidates inside the user's own test run, and grading new tests before they enter the suite.

## Development

```
npm install
npx playwright install chromium
npm test
npm run lint
```

Tests run against a local fixture page, no network needed. The suite includes end-to-end triage runs against deliberately built cosmetic and semantic variants of that page. The `examples/robotframework-testgilde/` folder contains a Robot Framework suite against a real website that served as the phase 0 validation target (see its own README).

`test/rf-temporal-e2e.test.js` runs a real Robot Framework suite through `rf/FlakeproofTemporalListener.py` and needs a Python virtualenv with Robot Framework and the Browser library (`pip install robotframework robotframework-browser && rfbrowser init`) at `.venv/` in the repository root; it skips itself with a clear message when that virtualenv is not present, so `npm test` stays green on a checkout that only set up the Node side.

## Repository layout

```
bin/flakeproof.js     CLI entry point (snapshot, triage, run, blindspots)
src/probe/            code injected into the page: DOM serializer, mutation catalogs, temporal delay, mutation script
src/triage/           anchor extraction, element matching, classification, candidates, proving, engine
src/adapters/         one small adapter per test framework (Robot Framework, Cypress, Selenium, Puppeteer)
src/inject/           opt-in helpers for user test suites (Playwright temporal + mutation injection, plus a temporal-only injection point for Cypress/Selenium/Puppeteer)
rf/                   Robot Framework listener for temporal injection (issue #11) - Python, attached via `robot --listener`
src/runner/           runs the user's suite and reads its result file (Playwright json, Robot output.xml, Cypress/Selenium Mocha json, Puppeteer Jest json)
src/blindspots/       blindspots orchestration: mutation ack reading, scoring, report rendering
src/snapshot.js       baseline capture (serialized tree plus raw html)
src/report.js         markdown report renderer
action.yml            composite GitHub Action wrapping "flakeproof run" as a PR-comment gate
action/scripts/       scripts the action calls: resolve inputs, run once and render both reports, upsert the PR comment
.github/workflows/    this repository's own CI (lint + test)
test/                 node:test suites, fixture page and build variants, captured real error fixtures
spikes/               phase 0 measurement scripts and report
examples/             Robot Framework suite against a real website
docs/superpowers/     design spec and implementation plans
docs/publishing.md    checklist for publishing to npm (not done yet, see "Installation")
```
