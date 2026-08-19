// Mutations that change meaning. A sensitive test must go red under these.
// Phase 0 uses them only to generate labeled DOM pairs for the classifier spike.
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
  },
];
