import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { startFixtureServer } from './helpers/serve.js';
import { measureBlindspots } from '../src/blindspots/measure.js';

const here = dirname(fileURLToPath(import.meta.url));
const pageRoot = join(here, 'fixtures', 'blindspots-page');
const configPath = join(here, 'fixtures', 'pw-blindspots', 'playwright.config.js');
const resultsPath = join(here, 'fixtures', 'pw-blindspots', 'results.json');
const COMMAND = (spec) => `npx playwright test --config ${configPath} ${spec}`;

// This is the whole point of the feature: prove it against a REAL suite run,
// not a stub of the runner. The fixture page's #header-title is changed by
// the change-text mutation; one suite asserts on exactly that text (must go
// red -> noticed), the other suite only asserts on the page <title> tag,
// which the mutation never touches (must stay green -> unnoticed).

test('a suite that asserts on the mutated text notices change-text', async () => {
  let server = null;
  try {
    server = await startFixtureServer({ root: pageRoot });
    process.env.FIXTURE_URL = server.url;
    const result = await measureBlindspots({
      cmd: COMMAND(join(here, 'fixtures', 'pw-blindspots', 'notices.spec.js')),
      reader: 'playwright',
      resultsPath,
      selectors: ['#header-title'],
      mutations: ['change-text'],
    });
    assert.equal(result.abstained, null, JSON.stringify(result));
    assert.equal(result.counts.attempted, 1);
    assert.equal(result.counts.applied, 1);
    assert.equal(result.counts.noticed, 1, 'a suite asserting on the mutated text must go red');
    assert.equal(result.counts.unnoticed, 0);
    const record = result.records[0];
    assert.equal(record.target, '#header-title');
    assert.equal(record.applied, true);
    assert.equal(record.noticed, true);
    assert.ok(record.redTests.some((t) => /shows the header title/.test(t)), JSON.stringify(record.redTests));
  } finally {
    delete process.env.FIXTURE_URL;
    await server?.close();
    await rm(resultsPath, { force: true });
  }
});

test('a suite that asserts nothing meaningful does not notice change-text', async () => {
  let server = null;
  try {
    server = await startFixtureServer({ root: pageRoot });
    process.env.FIXTURE_URL = server.url;
    const result = await measureBlindspots({
      cmd: COMMAND(join(here, 'fixtures', 'pw-blindspots', 'blind.spec.js')),
      reader: 'playwright',
      resultsPath,
      selectors: ['#header-title'],
      mutations: ['change-text'],
    });
    assert.equal(result.abstained, null, JSON.stringify(result));
    assert.equal(result.counts.attempted, 1);
    assert.equal(result.counts.applied, 1, 'the mutation genuinely reached the page and applied');
    assert.equal(result.counts.noticed, 0, 'this is the whole point: a real blind spot, not a stub');
    assert.equal(result.counts.unnoticed, 1);
    const record = result.records[0];
    assert.equal(record.applied, true);
    assert.equal(record.noticed, false);
    assert.deepEqual(record.redTests, []);
  } finally {
    delete process.env.FIXTURE_URL;
    await server?.close();
    await rm(resultsPath, { force: true });
  }
});
