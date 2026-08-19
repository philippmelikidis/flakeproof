# flakeproof

A CI tool that checks end-to-end test suites for two blind spots that nobody measures today:

- Blind tests. Something real breaks on the page, but the test stays green because it never actually checked it.
- Fragile tests. A class name changes, a wrapper div appears, an element loads a second later, and the test goes red although nothing is broken. Everyone calls this flaky.

Both problems have the same root cause: how tightly a test is coupled to the DOM. flakeproof measures this by mutating the page under test on purpose, in three controlled ways:

| Mutation type | Example | The test must |
|---|---|---|
| Semantic | button text changed, link target changed, element removed | go red |
| Cosmetic | class renamed, wrapper div added, element moved | stay green |
| Temporal (planned) | element appears 800 ms later | stay green |

A test that reacts wrongly is caught: green under semantic changes means blind, red under cosmetic or timing changes means fragile.

Phase 1 is red triage. When CI goes red, flakeproof answers the question a human answers by hand today: real bug or fragile test? If the test is fragile, it also proposes a more robust selector and proves the proposal by running it against the cosmetic mutation catalog, instead of guessing.

The mutations run inside the browser, not inside the test runner, so the core is framework agnostic. Each test framework (Playwright, Robot Framework, Cypress, Selenium, Puppeteer) only needs a small adapter.

## Status

Phase 0 complete, phase 1 red triage MVP in progress (issue #2).

## Usage

Capture a baseline while the build is green:

    npx flakeproof snapshot https://your-app.example --out baseline.json

When CI goes red, feed flakeproof the failure and the current build:

    npx flakeproof triage --baseline baseline.json --robot-xml output.xml --current-url https://your-app.example
    npx flakeproof triage --baseline baseline.json --error-file error.txt --current-url https://your-app.example --rerun-cmd "npx playwright test -g checkout"

The verdict is one of: real-change (probable regression), fragile (selector coupling broke, comes with proven selector recommendations), nondeterministic (reruns disagree), unclear (evidence is mixed or missing, flakeproof does not guess), no-anchor (the error names no locator).

## Development

```
npm install
npx playwright install chromium
npm test
npm run lint
```

Tests run against a local fixture page, no network needed. The `examples/robotframework-testgilde/` folder contains a Robot Framework suite against a real website that serves as the phase 0 validation target (see its own README).

## Repository layout

```
src/probe/      code injected into the page: DOM serializer, mutation catalogs
src/triage/     anchor extraction, element matching, delta classification
src/adapters/   one small adapter per test framework
test/           node:test suites, fixture page, captured real error fixtures
spikes/         phase 0 measurement scripts and report
```
