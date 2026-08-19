// Proves selector candidates against the cosmetic mutation catalog in a real
// browser: mark the target, apply one mutation, then check that a candidate
// still resolves to exactly the marked element.
import { chromium } from 'playwright';
import { cosmeticMutations } from '../probe/catalogs/cosmetic.js';

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

// Runs inside the page. Self-contained.
function checkCandidate(selector) {
  let els;
  try {
    els = [...document.querySelectorAll(selector)];
  } catch {
    return { hit: false };
  }
  return { hit: els.length === 1 && els[0].getAttribute('data-fp-target') === '1' };
}
/* eslint-enable no-undef */

export async function proveCandidates(url, anchorPath, candidates, { mutations = cosmeticMutations } = {}) {
  const browser = await chromium.launch();
  try {
    const results = candidates.map((c) => ({ ...c, uniqueInCurrent: false, survived: 0, applied: 0 }));

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
        const { hit } = await page.evaluate(checkCandidate, r.selector);
        r.uniqueInCurrent = hit;
      }
    });

    for (const mutation of mutations) {
      await withPage(async (page) => {
        const applied = await page.evaluate(mutation.apply, '[data-fp-target]');
        if (!applied) return; // not applicable to this element; excluded from `applied`
        for (const r of results) {
          const { hit } = await page.evaluate(checkCandidate, r.selector);
          r.applied += 1;
          if (hit) r.survived += 1;
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
