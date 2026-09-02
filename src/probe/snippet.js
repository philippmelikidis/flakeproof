// Reconstructs a single element's outerHTML from the full serialized page
// html plus a child-index path, instead of storing a per-node html snippet
// at capture time (see src/probe/serialize.js). The full-page html is
// already stored once per snapshot (captureSnapshot's top-level `html`
// field); walking it on demand at report time, for exactly the two nodes a
// report ever needs (the before and after anchor), is the same string the
// browser already produced and costs nothing until someone actually asks
// for a snippet.
//
// This module does not run in a browser: it operates on the raw html
// string alone with a small hand-rolled tag scanner, so it works for the
// "unproven" path too (a serialized `--current <file>` with no live page).
// A hand-rolled scanner can never be as authoritative as the browser that
// actually parsed this markup - see the self-check at the bottom of
// nodeHtmlAtPath, which exists specifically to turn a scanner mistake into
// an honest null instead of a confidently wrong snippet.

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

// Elements whose body is raw text (script) or escapable raw text
// (everything else here): per the HTML parsing spec, NOTHING inside them is
// markup except the exact matching close tag - not `<`, not `</div>`, not a
// `<` comparison operator in a script. Scanning their body with the general
// tag grammar is exactly the bug this set exists to prevent: a `<` or `</`
// that is just JS/CSS/text content gets consumed as a real tag, corrupting
// every subsequent child index for the rest of the document.
const RAWTEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes']);

// Matches, in order of preference: html comments (skipped entirely - they
// are not elements and must not perturb child indices), closing tags, and
// opening tags. An opening tag's attribute soup is consumed by
// `(?:"[^"]*"|'[^']*'|[^'">])*` so a quoted attribute value containing `>`
// does not terminate the tag early.
const TAG_RE = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;

// Locates the literal close tag for a raw-text element starting the search
// at `fromIndex` (right after the open tag). Case-insensitive, optional
// whitespace before `>`, matching how browsers recognize `</script>`,
// `</SCRIPT>` and `</script >` alike. Returns null when no close tag exists
// anywhere in the rest of the document - truncated or malformed markup that
// this scanner must not guess through.
function findRawTextClose(html, tag, fromIndex) {
  const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
  const m = closeRe.exec(html.slice(fromIndex));
  if (!m) return null;
  return { start: fromIndex + m.index, end: fromIndex + m.index + m[0].length };
}

// Tokenizes the whole document into open/close/selfclose tag markers.
// Returns null - never a partial token list - when a raw-text element (a
// <script> or <style> with no matching close tag anywhere after it) cannot
// be resolved: everything past that point is genuinely unknown, and letting
// the scan continue as if the raw-text body were ordinary markup is exactly
// how a `<` inside a script silently corrupts every sibling that follows.
function tokenizeTags(html) {
  const tokens = [];
  let index = 0;
  while (index <= html.length) {
    TAG_RE.lastIndex = index;
    const m = TAG_RE.exec(html);
    if (!m) break;
    if (m[0].startsWith('<!--')) {
      index = TAG_RE.lastIndex;
      continue;
    }
    if (m[1]) {
      tokens.push({ type: 'close', tag: m[1].toLowerCase(), start: m.index, end: TAG_RE.lastIndex });
      index = TAG_RE.lastIndex;
      continue;
    }
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    const selfClosing = /\/\s*$/.test(attrs) || VOID_ELEMENTS.has(tag);
    tokens.push({ type: selfClosing ? 'selfclose' : 'open', tag, start: m.index, end: TAG_RE.lastIndex });
    index = TAG_RE.lastIndex;
    if (!selfClosing && RAWTEXT_TAGS.has(tag)) {
      const close = findRawTextClose(html, tag, index);
      if (!close) return null; // unterminated raw-text element: fail closed, never a partial result
      tokens.push({ type: 'close', tag, start: close.start, end: close.end });
      index = close.end;
    }
  }
  return tokens;
}

// Finds the token index of the close tag matching the open tag at
// `openIdx`, accounting for same-tag nesting. Returns -1 for malformed or
// truncated markup (an open tag with no matching close anywhere after it).
function findMatchingClose(tokens, openIdx) {
  const tag = tokens[openIdx].tag;
  let depth = 1;
  for (let i = openIdx + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.tag !== tag) continue;
    if (t.type === 'open') depth += 1;
    else if (t.type === 'close') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The span of one element: its [start, end) region in the original string,
// and the [childLo, childHi) token range holding its direct children
// (element children only, mirroring how serializeDom indexes `el.children`
// - text and comments are invisible to both).
function elementSpan(tokens, openIdx) {
  const t = tokens[openIdx];
  if (t.type === 'selfclose') return { start: t.start, end: t.end, childLo: openIdx + 1, childHi: openIdx + 1 };
  const closeIdx = findMatchingClose(tokens, openIdx);
  if (closeIdx === -1) return null; // malformed markup: cannot trust child boundaries either
  return { start: t.start, end: tokens[closeIdx].end, childLo: openIdx + 1, childHi: closeIdx };
}

// The token index of the nth direct child element (0-indexed, elements
// only) within the [lo, hi) token range, or -1 if there is no such child.
function nthChildElement(tokens, lo, hi, n) {
  let count = -1;
  let depth = 0;
  for (let i = lo; i < hi; i += 1) {
    const t = tokens[i];
    if (depth === 0 && (t.type === 'open' || t.type === 'selfclose')) {
      count += 1;
      if (count === n) return i;
    }
    if (t.type === 'open') depth += 1;
    else if (t.type === 'close') depth -= 1;
  }
  return -1;
}

// The tag name the reconstructed snippet actually starts with, or null if
// it does not even look like a tag.
function leadingTag(s) {
  const m = /^<([a-zA-Z][\w:-]*)/.exec(s);
  return m ? m[1].toLowerCase() : null;
}

// Returns the outerHTML of the element at `path` within `html` (a
// child-element-index path exactly like the ones serializeDom records),
// bounded to `maxLen` characters the same way the old per-node snippet was.
// Returns null when the path cannot be walked - a shape mismatch between
// the stored tree and the stored html, or markup too malformed for this
// scanner - rather than guessing at a substring. `path: []` names the root
// element itself, which is by construction the entire `html` string
// (serializeDom's root is document.documentElement, and the snapshot's
// `html` field is exactly document.documentElement.outerHTML), so it is
// returned directly without running the scanner at all.
//
// `expectedTag` is the tag name the CALLER already knows this path should
// resolve to (the same node's `tag` field from the serialized tree). This
// scanner is a hand-rolled approximation of HTML parsing, not a real
// parser, so it can never be as authoritative as the browser that produced
// this markup: a bug in this file, or a shape mismatch between the tree and
// the html it was paired with, must never surface as a confidently wrong
// snippet for a DIFFERENT element. Verifying that the reconstructed
// snippet's own leading tag matches what the caller expected turns that
// failure mode into an honest null instead - fail loudly, never guess.
export function nodeHtmlAtPath(html, path, expectedTag, maxLen = 400) {
  if (typeof html !== 'string' || !html) return null;
  const bound = (s) => (s.length > maxLen ? s.slice(0, maxLen) + ' ...' : s);
  const verify = (s) => {
    if (s === null) return null;
    if (expectedTag && leadingTag(s) !== String(expectedTag).toLowerCase()) return null;
    return s;
  };
  if (!path || path.length === 0) return verify(bound(html));

  const tokens = tokenizeTags(html);
  if (!tokens || !tokens.length || tokens[0].type !== 'open') return null;
  let span = elementSpan(tokens, 0);
  if (!span) return null;
  for (const idx of path) {
    const childIdx = nthChildElement(tokens, span.childLo, span.childHi, idx);
    if (childIdx === -1) return null;
    span = elementSpan(tokens, childIdx);
    if (!span) return null;
  }
  return verify(bound(html.slice(span.start, span.end)));
}
