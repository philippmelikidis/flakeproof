// Derives a css target the temporal delay style can address. Playwright-only
// engines cannot be expressed in css, but many real anchors are a css base
// plus an engine suffix (chains, :visible, :has-text). Hiding the css base
// also hides the anchored element, because visibility inherits to
// descendants. Returns null when no sufficiently specific base can be
// derived; delaying a broad target would provoke the wrong thing, so we
// abstain instead of guessing.
//
// All structural scanning below (chain split, comma-list detection, :visible
// stripping, the residual-pseudo check) is quote-aware: it never treats a
// `>>`, `,`, or `:` that lives inside a quoted attribute value as chain,
// list, or pseudo syntax. A selector like `[data-x=">>"]` has `>>` as part
// of the *value*, not a chain separator; naive raw-string surgery (the
// previous implementation) does not know the difference and mangles it into
// `[data-x="`, an invalid rule the browser silently discards. The one
// exception is deliberate: the has-text/text-is family regex below is
// designed to consume its *own* quoted argument (`:has-text("Save")`), so it
// still runs against the raw string - that is correct, not a hole, because
// those quotes belong to the pseudo-function syntax itself, not to
// unrelated attribute-value data.
//
// This module intentionally stays a pure, synchronous, string-only
// function - see isValidCssTarget in this same file for the browser-backed
// validity round trip that catches anything this string surgery cannot
// anticipate (e.g. unbalanced brackets). Keeping the two separate means the
// existing unit tests for the derivation logic stay fast and dependency-free,
// while the call site (engine.js) adds the round-trip check once, right
// before a target is ever used to provoke a real delay.

// Splits `selector` into alternating quoted/unquoted spans so the structural
// checks below can scan for syntax characters without ever looking inside a
// quoted value. An unmatched quote character (an open quote with no closing
// partner) fits neither the quoted-span alternative (which requires a
// closing quote) nor the unquoted-run alternative (which explicitly excludes
// quote characters), so `String.match` silently skips it. `joinSegments`
// then reconstructs a selector missing exactly that character - a
// DIFFERENT, still-valid selector that targets different elements (see Fix 7
// in the review; `[data-x="a]` round-trips to `[data-x=a]`). This is NOT
// caught by the round-trip validation at the call site (isValidCssTarget):
// that check asks a real browser whether the DERIVED string is valid CSS,
// and the mangled string usually is - just the wrong one. Detecting the drop
// here, before it can happen, is `hasUnbalancedQuoting`'s job below; this
// function itself makes no claim about catching malformed input.
function segmentByQuotes(selector) {
  const tokens = selector.match(/"[^"]*"|'[^']*'|[^'"]+/g) || [];
  return tokens.map((text) => ({ text, quoted: text[0] === '"' || text[0] === "'" }));
}

// True when `segmentByQuotes` had to drop at least one character of
// `selector` to produce its tokens - the signature of an unmatched quote.
// Comparing the total length of every matched segment against the original
// string catches this directly, regardless of exactly where the stray quote
// sits.
function hasUnbalancedQuoting(selector) {
  const consumed = segmentByQuotes(selector).reduce((n, s) => n + s.text.length, 0);
  return consumed !== selector.length;
}

function joinSegments(segments) {
  return segments.map((s) => s.text).join('');
}

// Finds the first '>>' that is not inside a quoted value and splits there,
// mirroring the previous `selector.split('>>')[0]` but quote-safe.
function splitChainOutsideQuotes(selector) {
  const segments = segmentByQuotes(selector);
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i].quoted) continue;
    const idx = segments[i].text.indexOf('>>');
    if (idx === -1) continue;
    const before = segments.slice(0, i).concat({ text: segments[i].text.slice(0, idx), quoted: false });
    return joinSegments(before);
  }
  return selector;
}

function hasUnquotedComma(selector) {
  return segmentByQuotes(selector).some((s) => !s.quoted && s.text.includes(','));
}

// Applies `regex` only to the unquoted spans of `selector`, leaving quoted
// attribute values untouched. Used for the bare-keyword pseudo classes
// (:visible, :hidden, ...) which take no argument and so never legitimately
// need to see inside a quote.
function stripOutsideQuotes(selector, regex) {
  return joinSegments(
    segmentByQuotes(selector).map((s) => (s.quoted ? s : { ...s, text: s.text.replace(regex, '') })),
  );
}

function hasUnquotedColonOutsideNth(selector) {
  const stripped = stripOutsideQuotes(selector, /:nth-(?:child|of-type)\(\d+\)/g);
  return segmentByQuotes(stripped).some((s) => !s.quoted && s.text.includes(':'));
}

export function temporalTargetFor(selector) {
  // An unmatched quote means the structural scanning below would be working
  // from a silently mangled copy of the input (see hasUnbalancedQuoting):
  // abstain rather than derive a target for a DIFFERENT selector than the
  // one that actually failed (Fix 7 in the review).
  if (hasUnbalancedQuoting(selector)) return null;
  let base = splitChainOutsideQuotes(selector).trim();
  if (/^[a-z-]+=/i.test(base)) return null; // engine-prefixed: text=, role=, xpath=, id=
  if (base.startsWith('//') || base.startsWith('..')) return null; // bare xpath
  if (hasUnquotedComma(base)) return null; // a selector list would hide every branch, not the anchor
  base = stripOutsideQuotes(base, /:(?:visible|hidden|enabled|disabled)\b/g);
  // has-text/text-is/etc. take a quoted argument that is part of their own
  // syntax, not unrelated attribute data, so this one runs on the raw
  // string and is expected to consume those quotes.
  base = base.replace(/:(?:has-text|text-is|text|near|right-of|left-of|above|below)\((?:[^()"']|"[^"]*"|'[^']*')*\)/g, '');
  base = base.trim();
  if (!base) return null;
  // Anything with residual pseudo syntax we did not explicitly strip is a
  // reason to abstain; plain structural :nth-child/:nth-of-type is fine. A
  // colon living inside a quoted attribute value is data, not syntax, and
  // must never trigger this.
  if (hasUnquotedColonOutsideNth(base)) return null;
  // A bare tag would hide far more than the anchor; require a narrowing token.
  return /[#.[]/.test(base) || /:nth-(?:child|of-type)\(/.test(base) ? base : null;
}

// Validates a derived css target against a real browser via a round trip on
// an empty page. This used to ask `document.querySelector(sel)` whether it
// throws, but `querySelector` is MORE PERMISSIVE than the css stylesheet
// parser: it happily accepts strings like `[data-x` or `#a[href^="/x"` that
// a `<style>` rule silently drops zero rules for (verified against a real
// browser; see the review). `temporalScript` never calls `querySelector` -
// it installs an actual stylesheet rule - so validating with
// `querySelector` was answering a question nobody was asking, in the
// dangerous direction: it said "valid" for strings the real probe would
// install as a no-op. The only oracle that matters is the one the probe
// actually uses: install `selector + ' { visibility: hidden !important; }'`
// into a real stylesheet and check that exactly one rule was accepted
// (`sheet.cssRules.length === 1`). This is deliberately kept separate from
// temporalTargetFor (which stays synchronous) rather than folded in:
// spinning up a browser page is slow and turns every existing pure unit test
// async for no benefit, and the issue this closes is specifically about
// *validating* a candidate, not deriving one. Called once per candidate at
// the call site (engine.js), right before the target is used to provoke a
// real delay. It can only ever narrow what temporalTargetFor already
// proposed, never widen it.
export async function isValidCssTarget(browser, selector) {
  const page = await browser.newPage();
  try {
    /* eslint-disable no-undef */
    return await page.evaluate((sel) => {
      const style = document.createElement('style');
      try {
        style.textContent = sel + ' { visibility: hidden !important; }';
        document.documentElement.appendChild(style);
        return !!style.sheet && style.sheet.cssRules.length === 1;
      } catch {
        return false;
      } finally {
        style.remove();
      }
    }, selector);
    /* eslint-enable no-undef */
  } finally {
    await page.close();
  }
}
