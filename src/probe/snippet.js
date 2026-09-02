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

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

// Matches, in order of preference: html comments (skipped entirely - they
// are not elements and must not perturb child indices), closing tags, and
// opening tags. An opening tag's attribute soup is consumed by
// `(?:"[^"]*"|'[^']*'|[^'">])*` so a quoted attribute value containing `>`
// does not terminate the tag early.
const TAG_RE = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;

function tokenizeTags(html) {
  const tokens = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {
      tokens.push({ type: 'close', tag: m[1].toLowerCase(), start: m.index, end: TAG_RE.lastIndex });
    } else {
      const tag = m[2].toLowerCase();
      const attrs = m[3] || '';
      const selfClosing = /\/\s*$/.test(attrs) || VOID_ELEMENTS.has(tag);
      tokens.push({ type: selfClosing ? 'selfclose' : 'open', tag, start: m.index, end: TAG_RE.lastIndex });
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
export function nodeHtmlAtPath(html, path, maxLen = 400) {
  if (typeof html !== 'string' || !html) return null;
  const bound = (s) => (s.length > maxLen ? s.slice(0, maxLen) + ' ...' : s);
  if (!path || path.length === 0) return bound(html);

  const tokens = tokenizeTags(html);
  if (!tokens.length || tokens[0].type !== 'open') return null;
  let span = elementSpan(tokens, 0);
  if (!span) return null;
  for (const idx of path) {
    const childIdx = nthChildElement(tokens, span.childLo, span.childHi, idx);
    if (childIdx === -1) return null;
    span = elementSpan(tokens, childIdx);
    if (!span) return null;
  }
  return bound(html.slice(span.start, span.end));
}
