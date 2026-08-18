// Runs the @playwright/test spec with the JSON reporter and extracts the
// real error message of the failing test. Run once; commit the result.
//
// @playwright/test runs each spec in a forked worker process, which launches
// its own browser process (a grandchild of this script). In some sandboxed
// execution environments that process tree cannot reach a loopback HTTP
// server opened by this script (confirmed by reproducing the same timeout
// with a plain `http.get` from a nested child process, while the same
// server is reachable from a browser launched directly by this process, as
// in capture-errors.js). To keep this capture script portable, FIXTURE_URL
// points at a self-contained `data:` URL built from the real fixture page
// instead of a live server — the produced error text (call log, locator,
// timeout) is unaffected, since the target locator never exists either way.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const fixtureHtml = await readFile(new URL('../fixtures/page/index.html', import.meta.url), 'utf8');
const fixtureUrl = `data:text/html,${encodeURIComponent(fixtureHtml)}`;

spawnSync('npx', ['playwright', 'test', '--config', 'test/fixtures/pw/playwright.config.js'], {
  env: { ...process.env, FIXTURE_URL: fixtureUrl },
  stdio: 'inherit',
});

// The JSON reporter resolves outputFile relative to the config directory in
// current Playwright versions; older ones used the cwd. Try both.
const results = JSON.parse(
  await readFile('test/fixtures/pw/results.json', 'utf8')
    .catch(() => readFile('results.json', 'utf8')),
);
const message = results.suites[0].specs[0].tests[0].results[0].error.message;
const clean = message.replace(/\[[0-9;]*m/g, ''); // strip ANSI colors
await writeFile('test/fixtures/errors/pwtest-expect-timeout.txt', clean, 'utf8');
console.log('captured pwtest-expect-timeout');
