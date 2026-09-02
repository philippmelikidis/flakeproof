import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { mutationScript } from '../src/probe/mutation-script.js';
import { semanticMutations } from '../src/probe/catalogs/semantic.js';

// `context.newPage()` first navigates to about:blank, which also gets the
// init script (addInitScript runs on every document) and, since about:blank
// is never "loading" by the time the script checks, runs immediately and
// reports its own (always false, since about:blank has no elements) result.
// That is a harmless, pre-existing property of this run-at-DOMContentLoaded
// pattern (temporalScript has the same shape - see test/temporal.test.js's
// `calls.length >= 2` tolerance), so assertions here check the LAST report,
// the one after the real navigation, rather than the full call list.
const changeText = semanticMutations.find((m) => m.id === 'change-text');
const changeHref = semanticMutations.find((m) => m.id === 'change-href');
const removeElement = semanticMutations.find((m) => m.id === 'remove-element');

test('mutationScript applies change-text to a real element and reports true', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const context = await browser.newContext();
    const calls = [];
    await context.exposeFunction('__flakeproofMutationApplied', (applied) => calls.push(applied));
    await context.addInitScript(mutationScript(changeText, '#cta'));
    const page = await context.newPage();
    await page.goto(server.url);
    await page.waitForTimeout(200);
    assert.equal(calls.at(-1), true, 'the report after the real navigation must confirm the mutation applied');
    assert.equal(await page.locator('#cta').textContent(), 'FLAKEPROOF-CHANGED');
  } finally {
    await browser?.close();
    await server?.close();
  }
});

test('mutationScript applies change-href and reports true', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const context = await browser.newContext();
    const calls = [];
    await context.exposeFunction('__flakeproofMutationApplied', (applied) => calls.push(applied));
    await context.addInitScript(mutationScript(changeHref, '#cta'));
    const page = await context.newPage();
    await page.goto(server.url);
    await page.waitForTimeout(200);
    assert.equal(calls.at(-1), true, 'the report after the real navigation must confirm the mutation applied');
    assert.equal(await page.locator('#cta').getAttribute('href'), '/fp-changed/');
  } finally {
    await browser?.close();
    await server?.close();
  }
});

test('mutationScript applies remove-element and reports true', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const context = await browser.newContext();
    const calls = [];
    await context.exposeFunction('__flakeproofMutationApplied', (applied) => calls.push(applied));
    await context.addInitScript(mutationScript(removeElement, '#cta'));
    const page = await context.newPage();
    await page.goto(server.url);
    await page.waitForTimeout(200);
    assert.equal(calls.at(-1), true, 'the report after the real navigation must confirm the mutation applied');
    assert.equal(await page.locator('#cta').count(), 0);
  } finally {
    await browser?.close();
    await server?.close();
  }
});

test('mutationScript against a selector that matches nothing reports false, never a guessed true', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const context = await browser.newContext();
    const calls = [];
    await context.exposeFunction('__flakeproofMutationApplied', (applied) => calls.push(applied));
    await context.addInitScript(mutationScript(changeText, '#does-not-exist'));
    const page = await context.newPage();
    await page.goto(server.url);
    await page.waitForTimeout(200);
    assert.equal(calls.at(-1), false, 'the report after the real navigation must confirm the mutation did not apply');
  } finally {
    await browser?.close();
    await server?.close();
  }
});

test('mutationScript against change-href on an element with no href reports false', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const context = await browser.newContext();
    const calls = [];
    await context.exposeFunction('__flakeproofMutationApplied', (applied) => calls.push(applied));
    // #site-header exists but carries no href attribute at all.
    await context.addInitScript(mutationScript(changeHref, '#site-header'));
    const page = await context.newPage();
    await page.goto(server.url);
    await page.waitForTimeout(200);
    assert.equal(calls.at(-1), false, 'the report after the real navigation must confirm the mutation did not apply');
  } finally {
    await browser?.close();
    await server?.close();
  }
});
