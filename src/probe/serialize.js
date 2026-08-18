// Runs INSIDE the page via page.evaluate(). Must be fully self-contained:
// no imports, no references to module scope.
export function serializeDom(anchorSelector) {
  const MAX_TEXT = 120;

  function ownText(el) {
    let t = '';
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
    }
    return t.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT);
  }

  function accessibleName(el) {
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      ''
    ).trim().slice(0, MAX_TEXT);
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
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: [...el.classList].sort(),
      attrs,
      text: ownText(el),
      name: accessibleName(el),
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
