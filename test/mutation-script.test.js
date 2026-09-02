import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startFixtureServer } from './helpers/serve.js';
import { mutationScript } from '../src/probe/mutation-script.js';
import { semanticMutations } from '../src/probe/catalogs/semantic.js';

const here = dirname(fileURLToPath(import.meta.url));
const blindspotsPageRoot = join(here, 'fixtures', 'blindspots-page');

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
    // The selector is given a bounded chance (MAX_WAIT_MS = 1000, see
    // src/probe/mutation-script.js) to appear before this is reported as a
    // confirmed absence rather than a premature guess; wait past that
    // window before asserting.
    await page.waitForTimeout(1300);
    assert.equal(calls.at(-1), false, 'the report after the real navigation must confirm the mutation did not apply');
  } finally {
    await browser?.close();
    await server?.close();
  }
});

test('mutationScript gives a client-rendered element a bounded chance to appear', async () => {
  // #cta does not exist at DOMContentLoaded on this fixture; a real SPA
  // inserts it 300ms after load (see test/fixtures/page/spa.html). The
  // bounded wait (MAX_WAIT_MS = 1000, see src/probe/mutation-script.js) must
  // catch it rather than reporting a premature, false "no such element".
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const context = await browser.newContext();
    const calls = [];
    await context.exposeFunction('__flakeproofMutationApplied', (applied, survived, frame, found) => calls.push({ applied, survived, frame, found }));
    await context.addInitScript(mutationScript(changeText, '#cta'));
    const page = await context.newPage();
    await page.goto(`${server.url}spa.html`);
    await page.waitForTimeout(1300);
    const last = calls.at(-1);
    assert.equal(last.applied, true, 'the late-inserted element must still be found and mutated');
    assert.equal(last.found, true);
  } finally {
    await browser?.close();
    await server?.close();
  }
});

test('mutationScript reports survived true when the mutation is still in place at settle time', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer({ root: blindspotsPageRoot });
    browser = await chromium.launch();
    const context = await browser.newContext();
    const calls = [];
    await context.exposeFunction('__flakeproofMutationApplied', (applied, survived, frame, found) => calls.push({ applied, survived, frame, found }));
    await context.addInitScript(mutationScript(changeText, '#header-title'));
    const page = await context.newPage();
    await page.goto(server.url);
    // Past the settle buffer (SETTLE_MS = 300) so the second, later report
    // has definitely landed.
    await page.waitForTimeout(700);
    const settled = calls.filter((c) => c.survived !== null);
    assert.ok(settled.length > 0, 'a settle report must have fired');
    assert.equal(settled.at(-1).survived, true, 'nothing on this page undoes the mutation, so it must still hold');
  } finally {
    await browser?.close();
    await server?.close();
  }
});

test('mutationScript reports survived false when the page rewrites the mutated node afterwards (hydration)', async () => {
  // This is the exact scenario the review reproduced: an ordinary
  // client-side re-render 50ms after DOMContentLoaded silently undoes the
  // mutation before any suite assertion would run. Reporting `applied: true`
  // alone (as the previous version did) would let this be scored as a false
  // blind spot; `survived: false` is the honest, separate signal.
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer({ root: blindspotsPageRoot });
    browser = await chromium.launch();
    const context = await browser.newContext();
    const calls = [];
    await context.exposeFunction('__flakeproofMutationApplied', (applied, survived, frame, found) => calls.push({ applied, survived, frame, found }));
    await context.addInitScript(mutationScript(changeText, '#header-title'));
    const page = await context.newPage();
    await page.goto(`${server.url}hydrate.html`);
    await page.waitForTimeout(700);
    const settled = calls.filter((c) => c.survived !== null);
    assert.ok(settled.length > 0, 'a settle report must have fired');
    assert.equal(settled.at(-1).applied, true, 'the mutation did genuinely apply at DOMContentLoaded');
    assert.equal(settled.at(-1).survived, false, 'the page rewrote the node before settle time');
    assert.equal(await page.locator('#header-title').textContent(), 'Welcome to Acme', 'the page really did revert it');
  } finally {
    await browser?.close();
    await server?.close();
  }
});

test('mutationScript attributes a report to the frame it actually ran in', async () => {
  let server = null;
  let browser = null;
  try {
    server = await startFixtureServer();
    browser = await chromium.launch();
    const context = await browser.newContext();
    const calls = [];
    await context.exposeFunction('__flakeproofMutationApplied', (applied, survived, frame, found) => calls.push({ applied, survived, frame, found }));
    // #inner-link only exists inside the iframe, never on the outer page.
    await context.addInitScript(mutationScript(changeHref, '#inner-link'));
    const page = await context.newPage();
    await page.goto(`${server.url}iframe-outer.html`);
    // The outer page never has #inner-link either, so its own copy of this
    // script polls for the full bounded window before giving up - wait past
    // that so its "never found" report has actually landed.
    await page.waitForTimeout(1300);
    const appliedCall = calls.find((c) => c.applied === true);
    assert.ok(appliedCall, 'the mutation must have applied inside the iframe');
    assert.ok(appliedCall.frame, 'a mutation that only applied inside an iframe must name that frame');
    assert.match(appliedCall.frame, /iframe-inner\.html$/);
    const outerCall = calls.find((c) => c.frame === null && c.found === false);
    assert.ok(outerCall, 'the main page never had #inner-link and must honestly report it as never found');
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
