// Derives a css target the temporal delay style can address. Playwright-only
// engines cannot be expressed in css, but many real anchors are a css base
// plus an engine suffix (chains, :visible, :has-text). Hiding the css base
// also hides the anchored element, because visibility inherits to
// descendants. Returns null when no sufficiently specific base can be
// derived; delaying a broad target would provoke the wrong thing, so we
// abstain instead of guessing.
export function temporalTargetFor(selector) {
  let base = selector.split('>>')[0].trim();
  if (/^[a-z-]+=/i.test(base)) return null; // engine-prefixed: text=, role=, xpath=, id=
  if (base.startsWith('//') || base.startsWith('..')) return null; // bare xpath
  base = base.replace(/:(?:visible|hidden|enabled|disabled)\b/g, '');
  base = base.replace(/:(?:has-text|text-is|text|near|right-of|left-of|above|below)\((?:[^()"']|"[^"]*"|'[^']*')*\)/g, '');
  base = base.trim();
  if (!base) return null;
  // Anything with residual pseudo syntax we did not explicitly strip is a
  // reason to abstain; plain structural :nth-child/:nth-of-type is fine.
  if (base.replace(/:nth-(?:child|of-type)\(\d+\)/g, '').includes(':')) return null;
  // A bare tag would hide far more than the anchor; require a narrowing token.
  return /[#.[]/.test(base) || /:nth-(?:child|of-type)\(/.test(base) ? base : null;
}
