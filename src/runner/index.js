// Runs a test suite, finds the tests that failed, and triages each of them.
// This is the path that removes the manual assembly of baseline, error file
// and url for every single failure.
import { runTests } from './run-tests.js';
import { failedTestsFromPlaywrightJson } from './read-playwright.js';
import { failedTestsFromOutputXml } from '../adapters/robot.js';
import { failedTestsFromCypressJson } from '../adapters/cypress.js';
import { failedTestsFromSeleniumJson } from '../adapters/selenium.js';
import { failedTestsFromPuppeteerJson } from '../adapters/puppeteer.js';
import { triage } from '../triage/engine.js';

export const READERS = {
  playwright: failedTestsFromPlaywrightJson,
  robot: failedTestsFromOutputXml,
  cypress: failedTestsFromCypressJson,
  selenium: failedTestsFromSeleniumJson,
  puppeteer: failedTestsFromPuppeteerJson,
};

export async function runSuite(opts) {
  // Checked before the (possibly slow) test command ever spawns: a typo'd
  // reader name should fail fast with the list of valid ones, not silently
  // degrade into a "blind" run after wasting a full suite invocation.
  const read = READERS[opts.reader];
  if (!read) {
    throw new Error(`unknown result reader "${opts.reader}"; expected one of: ${Object.keys(READERS).join(', ')}`);
  }

  const notes = [];
  const run = await runTests(opts.cmd, { cwd: opts.cwd });

  let failures;
  try {
    failures = await read(opts.resultsPath);
  } catch (err) {
    // Never treat an unreadable result file as a green run: that would turn
    // a broken setup into a silent all-clear.
    notes.push(`could not read the test results at ${opts.resultsPath}: ${err.message}`);
    return { ran: true, exitCode: run.exitCode, failures: 0, results: [], blind: true, notes };
  }

  if (failures.length === 0) {
    if (run.exitCode !== 0) {
      notes.push('the test command failed but the result file lists no failed test; check the reporter configuration');
    }
    return { ran: true, exitCode: run.exitCode, failures: 0, results: [], blind: false, notes };
  }

  if (run.exitCode === 0) {
    notes.push('the test command succeeded but the result file lists failed tests; it may be stale');
  }

  const results = [];
  for (const f of failures) {
    try {
      const t = await triage({
        errorText: f.message,
        baselinePath: opts.baselinePath,
        currentUrl: opts.url,
      });
      results.push({ testId: f.testId, triage: t });
    } catch (err) {
      notes.push(`could not triage ${f.testId}: ${err.message}`);
    }
  }
  return { ran: true, exitCode: run.exitCode, failures: failures.length, results, blind: false, notes };
}
