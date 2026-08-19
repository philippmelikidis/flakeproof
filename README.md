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
| Temporal (building block, not wired yet) | element appears 800 ms later | stay green |

Green under semantic changes means blind. Red under cosmetic or timing changes means fragile. Think of a smoke detector tester that produces both smoke and toast: a good detector beeps at one and ignores the other.

The mutations run inside the browser, not inside the test runner, so the core is framework agnostic. Playwright and Robot Framework are supported today; Cypress, Selenium and Puppeteer only need the same two small adapter hooks.

## Red triage

The first shipped workflow. While the build is green, capture a baseline:

    npx flakeproof snapshot https://your-app.example --out baseline.json

When CI goes red, hand flakeproof the failure and the current build:

    npx flakeproof triage --baseline baseline.json --robot-xml output.xml --current-url https://your-app.example
    npx flakeproof triage --baseline baseline.json --error-file error.txt --current-url https://your-app.example --rerun-cmd "npx playwright test -g checkout"

flakeproof extracts the anchor (the locator the test was hanging on) from the real error message, optionally reruns the test to catch nondeterminism, compares the baseline DOM against the current build at exactly that anchor, and answers with one of five verdicts:

| Verdict | Meaning |
|---|---|
| `real-change` | meaning changed at the anchor: probable regression, go look at the app |
| `fragile` | the selector broke on a meaning-free coupling: fix the test, suggestions included |
| `nondeterministic` | reruns disagree: timing or state, not this commit |
| `unclear` | evidence is mixed or missing: flakeproof does not guess |
| `no-anchor` | the error names no locator, nothing to triage against |

For fragile tests the report includes selector recommendations that are proven, not guessed: every candidate is run against the cosmetic mutation catalog in a real browser, and only survivors are ranked.

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

Honesty is a design rule here: `unclear` is a first-class verdict, abstaining beats asserting, and a recommendation that failed proving is never shown as safe.

### CLI reference

    flakeproof snapshot <url> [--anchor <selector>] --out <file.json>
    flakeproof triage --baseline <file.json>
                      (--error-file <file> | --robot-xml <output.xml>)
                      (--current-url <url> | --current <file.json>)
                      [--rerun-cmd <command>] [--reruns <n>] [--json] [--out <file.md>]

Exit code 0 whenever a verdict was produced (including `unclear`), 1 on usage or runtime errors.

## Status

Phase 1 (red triage MVP) is complete. Phase 0 established the measurement foundation: across 37 mutated fixture and live-site cases the classifier produced 0 misclassifications, with every abstention documented. Full numbers in `spikes/phase0-report.md`, reproducible via `npm run spike`.

On the roadmap: proving candidates inside the user's own test run (framework injection), temporal provocation as a triage lane, text- and role-based selector candidates, and grading new tests before they enter the suite.

## Development

```
npm install
npx playwright install chromium
npm test
npm run lint
```

Tests run against a local fixture page, no network needed. The suite includes end-to-end triage runs against deliberately built cosmetic and semantic variants of that page. The `examples/robotframework-testgilde/` folder contains a Robot Framework suite against a real website that served as the phase 0 validation target (see its own README).

## Repository layout

```
bin/flakeproof.js   CLI entry point (snapshot, triage)
src/probe/          code injected into the page: DOM serializer, mutation catalogs, temporal delay
src/triage/         anchor extraction, element matching, classification, candidates, proving, engine
src/adapters/       one small adapter per test framework (Robot Framework today)
src/snapshot.js     baseline capture (serialized tree plus raw html)
src/report.js       markdown report renderer
test/               node:test suites, fixture page and build variants, captured real error fixtures
spikes/             phase 0 measurement scripts and report
examples/           Robot Framework suite against a real website
docs/superpowers/   design spec and implementation plans
```
