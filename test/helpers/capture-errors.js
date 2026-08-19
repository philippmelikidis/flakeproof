// Provokes real Playwright errors against the fixture page and stores
// their messages as fixtures. Run once; commit the results.
import { writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startFixtureServer } from './serve.js';

const OUT = new URL('../fixtures/errors/', import.meta.url);
await mkdir(OUT, { recursive: true });

async function capture(name, fn) {
  try {
    await fn();
    throw new Error(`expected ${name} to fail`);
  } catch (err) {
    await writeFile(new URL(`${name}.txt`, OUT), err.message, 'utf8');
    console.log(`captured ${name}`);
  }
}

const server = await startFixtureServer();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(server.url);

await capture('pw-waitfor-timeout', () =>
  page.locator('#does-not-exist').waitFor({ state: 'visible', timeout: 1500 }));
await capture('pw-click-timeout', () =>
  page.locator('#also-missing').click({ timeout: 1500 }));
await capture('pw-strict-violation', () =>
  page.locator('.nav-item').click({ timeout: 1500 }));

await browser.close();
await server.close();
