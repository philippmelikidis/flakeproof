// Runs INSIDE the page via page.evaluate(). Must be fully self-contained:
// no imports, no references to module scope.
export function serializeDom(anchorSelector) {
  const MAX_TEXT = 120;
  // Bumped whenever the meaning of a per-node field changes in a way that
  // would make an older snapshot silently mislead a newer reader (e.g. the
  // exactness gate below). Keep in sync with CURRENT_SNAPSHOT_VERSION in
  // src/triage/candidates.js - that module cannot import this one (this
  // function is stringified into the page), so the two are hand-synced.
  // Bumped to 2 when the per-node `html` field was removed (see below):
  // every node used to carry a bounded outerHTML snippet, which on the
  // 21-node fixture more than doubled the snapshot's size and, since every
  // ancestor serializes its whole subtree first via outerHTML, is reasoned
  // (not measured) to grow superlinearly with nesting depth on large pages.
  // Only two nodes per report (the anchor
  // before and after) ever consumed it. Report time now reconstructs those
  // two snippets on demand from the snapshot's top-level `html` (the full
  // page, stored once) plus the node's `path`, via
  // src/probe/snippet.js#nodeHtmlAtPath - a plain string walk that needs no
  // browser, so it also works for the "unproven" `--current <file>` path.
  const SNAPSHOT_VERSION = 2;

  // header/footer are unconditional landmarks only at the page level; inside
  // sectioning content they are scoped to that section and have no implicit
  // role (HTML-AAM). th's role depends on its scope attribute / thead
  // ancestry. Both are handled separately from the flat map below because
  // the answer depends on ancestry or attributes, not just the tag name.
  const IMPLICIT_ROLES = {
    a: 'link', button: 'button', nav: 'navigation',
    main: 'main', ul: 'list', ol: 'list',
    li: 'listitem', img: 'img', form: 'form', table: 'table',
    h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading',
    td: 'cell', tr: 'row',
  };
  const SECTIONING_ANCESTORS = 'article, section, main, nav, aside';

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'header' || tag === 'footer') {
      if (el.closest(SECTIONING_ANCESTORS)) return '';
      return tag === 'header' ? 'banner' : 'contentinfo';
    }
    if (tag === 'th') {
      // scope is an explicit, unambiguous author declaration - trust it
      // outright; live-verified to reliably expose columnheader/rowheader.
      // A thead-ancestry heuristic (no scope, but inside <thead>) was tried
      // and dropped: it resolves to columnheader live for a table that also
      // has a body row, but a table with only a header row and no data
      // collapses in Chromium's accessibility tree and exposes no
      // columnheader at all - live count 0. That table shape is not
      // decidable from this element alone, so a <th> with no scope is left
      // unmapped rather than risk it.
      const scope = (el.getAttribute('scope') || '').toLowerCase();
      if (scope === 'col' || scope === 'colgroup') return 'columnheader';
      if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
      return '';
    }
    return IMPLICIT_ROLES[tag] || '';
  }

  // Returns the element's own text (direct text-node children only, matching
  // the existing contract) plus whether a direct <br> child was seen. A <br>
  // between two direct text nodes renders as a line break, so naively
  // concatenating "Line" and "break" into "Linebreak" fabricates a string
  // nothing on the page actually contains - not in the DOM text, and not in
  // whatever normalized form the browser (or Playwright's text engine)
  // exposes for matching. Track it here, where the text is already being
  // walked, instead of re-querying the element later.
  function ownText(el) {
    let t = '';
    let hasLineBreak = false;
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
      else if (n.nodeType === Node.ELEMENT_NODE && n.tagName.toLowerCase() === 'br') hasLineBreak = true;
    }
    return { text: t.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT), hasLineBreak };
  }

  // Mirrors the parts of the accname spec that matter for triage: an
  // explicit aria-label wins outright; img/area fall back to alt (they have
  // no meaningful subtree); everything else is named from its whole
  // subtree's text, matching how Playwright computes the accessible name
  // for elements like `<a>Contact <b>us</b></a>` ("Contact us", not
  // "Contact"). aria-labelledby is intentionally not handled here: it names
  // an element from a DIFFERENT element's content, which this per-element
  // function cannot resolve. Callers that need to know accessible name
  // cannot suppress that case by checking for the attribute. Unlike the real
  // accname algorithm, there is no `title` attribute fallback: when the
  // subtree has no text and no aria-label, this returns '' where Playwright
  // could still fall back to `title`. That is a narrower name, not a wrong
  // one, so callers that require a name simply get none rather than a value
  // that might disagree with the prover.
  function accessibleName(el) {
    const ariaLabel = (el.getAttribute('aria-label') || '').trim();
    if (ariaLabel) return { name: ariaLabel.slice(0, MAX_TEXT), exact: true };
    const tag = el.tagName.toLowerCase();
    if (tag === 'img' || tag === 'area') {
      return { name: (el.getAttribute('alt') || '').trim().slice(0, MAX_TEXT), exact: true };
    }
    const name = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT);
    return { name, exact: subtreeNameIsExact(el) };
  }

  // Whether accessibleName's subtree-text branch actually agrees with the
  // real accessible name algorithm for this element. It disagrees when:
  // - a descendant is hidden (aria-hidden="true", the hidden attribute, or a
  //   computed display:none/visibility:hidden) - excluded from the real name
  //   but still counted by textContent;
  // - a descendant img/area has non-empty alt text - contributed to the real
  //   name but invisible to textContent entirely;
  // - a descendant carries aria-label or aria-labelledby - the real accname
  //   algorithm recurses using THAT descendant's own accessible name (its
  //   authored label), replacing its text, while textContent still counts
  //   the descendant's literal text content;
  // - a descendant is an embedded control (input, textarea, select) - the
  //   real algorithm includes the control's VALUE, which textContent never
  //   sees (and usually cannot match anyway, since it is not the control's
  //   text content);
  // - a descendant is a <br> - it renders as a word boundary the real name
  //   preserves, but textContent silently drops it, concatenating the
  //   surrounding text with no separator at all.
  // Any of these makes textContent an unreliable stand-in for the accessible
  // name, so callers must not treat the resulting `name` as trustworthy.
  function subtreeNameIsExact(el) {
    for (const child of el.querySelectorAll('*')) {
      if (child.hidden || child.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(child);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const childTag = child.tagName.toLowerCase();
      if ((childTag === 'img' || childTag === 'area') && (child.getAttribute('alt') || '').trim()) return false;
      if (child.hasAttribute('aria-label') || child.hasAttribute('aria-labelledby')) return false;
      if (childTag === 'input' || childTag === 'textarea' || childTag === 'select') return false;
      if (childTag === 'br') return false;
    }
    return true;
  }

  function serialize(el, path) {
    const attrs = {};
    for (const a of el.attributes) {
      if (a.name === 'class' || a.name === 'style') continue;
      attrs[a.name] = a.value.slice(0, MAX_TEXT);
    }
    const children = [];
    let i = 0;
    for (const c of el.children) {
      children.push(serialize(c, path.concat(i)));
      i += 1;
    }
    const acc = accessibleName(el);
    const own = ownText(el);
    const node = {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: [...el.classList].sort(),
      attrs,
      text: own.text,
      name: acc.name,
      role: el.getAttribute('role') || implicitRole(el) || '',
      path,
      children,
    };
    // Written only in the "untrustworthy" case, and omitted otherwise, so a
    // reader can never mistake an absent key for "verified exact" - unlike
    // the old always-present boolean, where `undefined === false` silently
    // read as exact on any snapshot that predates this field. It also keeps
    // the common case out of the JSON: most nodes are exact.
    if (!acc.exact) node.nameInexact = true;
    if (own.hasLineBreak) node.textHasLineBreak = true;
    return node;
  }

  let anchorPath = null;
  if (anchorSelector) {
    let target = null;
    try { target = document.querySelector(anchorSelector); } catch { /* invalid selector */ }
    if (target) {
      const path = [];
      let el = target;
      while (el && el !== document.documentElement) {
        const parent = el.parentElement;
        if (!parent) break;
        path.unshift([...parent.children].indexOf(el));
        el = parent;
      }
      anchorPath = path;
    }
  }

  return { tree: serialize(document.documentElement, []), anchorPath, snapshotVersion: SNAPSHOT_VERSION };
}
