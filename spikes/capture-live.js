// Manual validation against the real testgilde.de header. Captures labeled
// DOM pairs into spikes/live-pairs/ for run-phase0.js to classify.
// Run manually: node spikes/capture-live.js
import { writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serializeDom } from '../src/probe/serialize.js';
import { cosmeticMutations } from '../src/probe/catalogs/cosmetic.js';
import { semanticMutations } from '../src/probe/catalogs/semantic.js';

const URL_LIVE = 'https://www.testgilde.de/';
// Anchors taken from the example suite (examples/robotframework-testgilde).
const ANCHORS = [
  'ul#menu-main-navigation > li:nth-child(1) > a',
  '.fusion-tb-header .fusion-builder-row-1 a.fusion-button.open-contact',
];

const OUT = new URL('./live-pairs/', import.meta.url);
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
let n = 0;
const skips = [];

for (const [label, catalog] of [['cosmetic', cosmeticMutations], ['semantic', semanticMutations]]) {
  for (const mutation of catalog) {
    for (const selector of ANCHORS) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await page.goto(URL_LIVE, { waitUntil: 'domcontentloaded' });
      const baseline = await page.evaluate(serializeDom, selector);
      if (!baseline.anchorPath) {
        skips.push({ label, mutationId: mutation.id, selector, why: 'anchor not on page' });
        await page.close();
        continue;
      }
      const applied = await page.evaluate(mutation.apply, selector);
      if (!applied) {
        skips.push({ label, mutationId: mutation.id, selector, why: 'mutation not applicable' });
        await page.close();
        continue;
      }
      const current = await page.evaluate(serializeDom, null);
      n += 1;
      const name = `${String(n).padStart(2, '0')}-${label}-${mutation.id}.json`;
      await writeFile(new URL(name, OUT),
        JSON.stringify({ label, mutationId: mutation.id, selector, baseline, current }), 'utf8');
      console.log(`captured ${name}`);
      await page.close();
    }
  }
}

await browser.close();
await writeFile(new URL('_skips.json', OUT), JSON.stringify(skips), 'utf8');
console.log(`${n} live pairs captured, ${skips.length} skipped`);
