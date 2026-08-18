// Extracts the anchor (the locator a failing test was hanging on) from a
// raw error text. String scanning instead of one big regex: locator strings
// may contain quotes, parentheses and combinators.

function locatorFromLine(line) {
  const start = line.indexOf("locator('");
  if (start === -1) return null;
  const end = line.lastIndexOf("')");
  if (end <= start) return null;
  return line.slice(start + "locator('".length, end);
}

function detectKind(text) {
  if (/strict mode violation/.test(text)) return 'ambiguous';
  // Playwright's own locator actions report "Timeout 1500ms exceeded.";
  // @playwright/test's `expect(...).toBeVisible()` instead reports a
  // "Timeout: 1500ms" line (colon, no "exceeded"). Both mean the same
  // thing for triage purposes, so match both spellings.
  if (/Timeout:? \d+ms/.test(text) || /Timed out \d+ms/.test(text)) return 'timeout';
  if (/net::|NS_ERROR_|ERR_/.test(text)) return 'navigation';
  if (/expect\(|AssertionError|Should (Be|Contain|Not)/i.test(text)) return 'assertion';
  return 'unknown';
}

export function extractAnchor(errorText) {
  const text = String(errorText ?? '');
  const kind = detectKind(text);
  for (const line of text.split('\n')) {
    const selector = locatorFromLine(line);
    if (selector) return { selector, kind };
  }
  return { selector: null, kind };
}
