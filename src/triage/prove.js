// Proves selector candidates against the proving mutation catalog in a real
// browser: mark the target, apply one mutation, then check that a candidate
// still resolves to exactly the marked element.
import { chromium } from 'playwright';
import { provingMutations } from '../probe/catalogs/proving.js';

// Runs inside the page. Self-contained.
/* eslint-disable no-undef */
function markTarget(path) {
  let el = document.documentElement;
  for (const i of path) {
    el = el.children[i];
    if (!el) return false;
  }
  el.setAttribute('data-fp-target', '1');
  return true;
}

/* eslint-enable no-undef */

// Checks one candidate against the live page: it must resolve to exactly one
// element, and that element must be the marked target. page.locator
// understands css and Playwright engines (text=, role=) alike; an
// unparsable selector counts as a miss, never as an error.
async function candidateHits(page, selector) {
  try {
    const locator = page.locator(selector);
    if ((await locator.count()) !== 1) return false;

    return await locator.first().evaluate((el) => el.getAttribute('data-fp-target') === '1');

  } catch {
    return false;
  }
}

export async function proveCandidates(url, anchorPath, candidates, { mutations = provingMutations } = {}) {
  const browser = await chromium.launch();
  try {
    const results = candidates.map((c) => ({ ...c, uniqueInCurrent: false, survived: 0, applied: 0, outcomes: [] }));

    const withPage = async (fn) => {
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const marked = await page.evaluate(markTarget, anchorPath);
        if (!marked) throw new Error(`anchor path [${anchorPath}] does not resolve on ${url}`);
        return await fn(page);
      } finally {
        await page.close();
      }
    };

    // Uniqueness on the unmutated current page.
    await withPage(async (page) => {
      for (const r of results) {
        r.uniqueInCurrent = await candidateHits(page, r.selector);
      }
    });

    for (const mutation of mutations) {
      await withPage(async (page) => {
        const applied = await page.evaluate(mutation.apply, '[data-fp-target]');
        if (!applied) return; // not applicable to this element; excluded from `applied`
        for (const r of results) {
          r.applied += 1;
          const hit = await candidateHits(page, r.selector);
          if (hit) r.survived += 1;
          r.outcomes.push({ id: mutation.id, survived: hit });
        }
      });
    }

    return results.sort(
      (x, y) => Number(y.uniqueInCurrent) - Number(x.uniqueInCurrent) || y.survived - x.survived,
    );
  } finally {
    await browser.close();
  }
}
