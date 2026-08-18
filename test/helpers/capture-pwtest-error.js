// Runs the @playwright/test spec with the JSON reporter and extracts the
// real error message of the failing test. Run once; commit the result.
//
// The test runner must be spawned asynchronously: spawnSync would block the
// event loop, starving the in-process fixture server so page.goto() hangs
// until the 30s test timeout.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { startFixtureServer } from './serve.js';

const server = await startFixtureServer();
await new Promise((resolve) => {
  const child = spawn('npx', ['playwright', 'test', '--config', 'test/fixtures/pw/playwright.config.js'], {
    env: { ...process.env, FIXTURE_URL: server.url },
    stdio: 'inherit',
  });
  child.on('close', resolve);
});
await server.close();

// The JSON reporter resolves outputFile relative to the config directory in
// current Playwright versions; older ones used the cwd. Try both.
const results = JSON.parse(
  await readFile('test/fixtures/pw/results.json', 'utf8')
    .catch(() => readFile('results.json', 'utf8')),
);
const message = results.suites[0].specs[0].tests[0].results[0].error.message;
// eslint-disable-next-line no-control-regex -- stripping ANSI escapes requires matching the ESC byte
const clean = message.replace(/\u001b\[[0-9;]*m/g, ''); // strip ANSI escape sequences
await writeFile('test/fixtures/errors/pwtest-expect-timeout.txt', clean, 'utf8');
console.log('captured pwtest-expect-timeout');
