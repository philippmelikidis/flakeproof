// Mutations that change meaning. A sensitive test must go red under these.
// Phase 0 uses them only to generate labeled DOM pairs for the classifier spike.
//
// Each mutation also carries a `verify(selector)`, embedded into the page the
// same way `apply` is (see src/probe/mutation-script.js): a boolean check of
// whether the mutated state still holds. `apply` only proves the edit
// happened once, at the moment it ran; a page that re-renders afterwards
// (ordinary hydration) can silently undo it before the suite's own
// assertions run, and blaming the suite for "not noticing" a change that was
// no longer there would be exactly the false blindness verdict this tool
// must never produce (see the blindspots measurement's survival check).
export const semanticMutations = [
  {
    id: 'change-text',
    description: 'Replace the visible text of the target',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.textContent = 'FLAKEPROOF-CHANGED';
      return true;
    },
    verify: (selector) => {
      const el = document.querySelector(selector);
      return !!el && el.textContent === 'FLAKEPROOF-CHANGED';
    },
  },
  {
    id: 'change-href',
    description: 'Point the target link somewhere else',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el || !el.hasAttribute('href')) return false;
      el.setAttribute('href', '/fp-changed/');
      return true;
    },
    verify: (selector) => {
      const el = document.querySelector(selector);
      return !!el && el.getAttribute('href') === '/fp-changed/';
    },
  },
  {
    id: 'remove-element',
    description: 'Remove the target entirely',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.remove();
      return true;
    },
    verify: (selector) => !document.querySelector(selector),
  },
];
