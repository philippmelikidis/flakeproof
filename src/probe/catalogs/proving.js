// The proving catalog: everything a robust selector should survive. It
// extends the cosmetic catalog with perturbations that are outside the
// triage classification contract (the classifier reads a copy tweak as a
// semantic change, correctly) but that separate durable selectors from
// coincidental ones. Used by the prover only; the spike measurement and the
// classifier keep the plain cosmetic catalog.
import { cosmeticMutations } from './cosmetic.js';

// Runs inside the page. Self-contained.
export const copyTweak = {
  id: 'tweak-text-case',
  description: 'Flip the case of the first letter of the element own text',
  apply: (selector) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        const text = node.textContent;
        const i = text.search(/[a-zA-Z]/);
        if (i === -1) return false;
        const ch = text[i];
        const flipped = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
        node.textContent = text.slice(0, i) + flipped + text.slice(i + 1);
        return true;
      }
    }
    return false;
  },
};

export const provingMutations = [...cosmeticMutations, copyTweak];
