// Captures a page as a baseline: serialized tree for classification, raw
// html for late anchor resolution, and the source url for the record.
import { chromium } from 'playwright';
import { serializeDom } from './probe/serialize.js';

// `browser` lets a caller that already holds a launched Chromium instance
// (see src/triage/engine.js#triage, which shares one instance across an
// entire triage run instead of launching one per step) reuse it here. When
// omitted, a browser is launched and closed just for this call, exactly as
// before - every existing caller (the CLI, tests) keeps working unchanged.
export async function captureSnapshot(url, { anchorSelector = null, viewport = { width: 1920, height: 1080 }, browser = null } = {}) {
  const ownBrowser = !browser;
  const activeBrowser = browser ?? (await chromium.launch());
  try {
    const page = await activeBrowser.newPage({ viewport });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const snap = await page.evaluate(serializeDom, anchorSelector);
      /* eslint-disable no-undef */
      snap.html = await page.evaluate(() => document.documentElement.outerHTML);
      /* eslint-enable no-undef */
      snap.url = url;
      return snap;
    } finally {
      await page.close();
    }
  } finally {
    if (ownBrowser) await activeBrowser.close();
  }
}
