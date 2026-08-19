// Captures a page as a baseline: serialized tree for classification, raw
// html for late anchor resolution, and the source url for the record.
import { chromium } from 'playwright';
import { serializeDom } from './probe/serialize.js';

export async function captureSnapshot(url, { anchorSelector = null, viewport = { width: 1920, height: 1080 } } = {}) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const snap = await page.evaluate(serializeDom, anchorSelector);
    /* eslint-disable no-undef */
    snap.html = await page.evaluate(() => document.documentElement.outerHTML);
    /* eslint-enable no-undef */
    snap.url = url;
    return snap;
  } finally {
    await browser.close();
  }
}
