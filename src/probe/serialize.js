// Runs INSIDE the page via page.evaluate(). Must be fully self-contained:
// no imports, no references to module scope.
export function serializeDom(anchorSelector) {
  const MAX_TEXT = 120;
  const MAX_HTML = 400;

  // header/footer are unconditional landmarks only at the page level; inside
  // sectioning content they are scoped to that section and have no implicit
  // role (HTML-AAM). Handled separately from the flat map below because the
  // answer depends on ancestry, not just the tag name.
  const IMPLICIT_ROLES = {
    a: 'link', button: 'button', nav: 'navigation',
    main: 'main', ul: 'list', ol: 'list',
    li: 'listitem', img: 'img', form: 'form', table: 'table',
  };
  const SECTIONING_ANCESTORS = 'article, section, main, nav, aside';

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'header' || tag === 'footer') {
      if (el.closest(SECTIONING_ANCESTORS)) return '';
      return tag === 'header' ? 'banner' : 'contentinfo';
    }
    return IMPLICIT_ROLES[tag] || '';
  }

  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
    }
    return t.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT);
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
  // real accessible name algorithm for this element. It disagrees when a
  // descendant is hidden (aria-hidden="true", the hidden attribute, or a
  // computed display:none/visibility:hidden) - excluded from the real name
  // but still counted by textContent - or when a descendant img/area has
  // non-empty alt text - contributed to the real name but invisible to
  // textContent entirely. Either case makes textContent an unreliable
  // stand-in for the accessible name, so callers must not treat the
  // resulting `name` as trustworthy.
  function subtreeNameIsExact(el) {
    for (const child of el.querySelectorAll('*')) {
      if (child.hidden || child.getAttribute('aria-hidden') === 'true') return false;
      const style = getComputedStyle(child);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const childTag = child.tagName.toLowerCase();
      if ((childTag === 'img' || childTag === 'area') && (child.getAttribute('alt') || '').trim()) return false;
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
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: [...el.classList].sort(),
      attrs,
      text: ownText(el),
      name: acc.name,
      nameFromSubtreeIsExact: acc.exact,
      role: el.getAttribute('role') || implicitRole(el) || '',
      html: el.outerHTML.length > MAX_HTML ? el.outerHTML.slice(0, MAX_HTML) + ' ...' : el.outerHTML,
      path,
      children,
    };
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

  return { tree: serialize(document.documentElement, []), anchorPath };
}
