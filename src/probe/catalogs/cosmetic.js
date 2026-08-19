// Mutations that change the DOM without changing meaning.
// A robust test must stay green under every one of these.
// Each apply() runs inside the page and must be self-contained.
export const cosmeticMutations = [
  {
    id: 'wrap-element',
    description: 'Wrap the target in an extra <div>',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el || !el.parentElement) return false;
      const wrapper = document.createElement('div');
      el.parentElement.insertBefore(wrapper, el);
      wrapper.appendChild(el);
      return true;
    },
  },
  {
    id: 'add-class',
    description: 'Add an unrelated class to the target',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.classList.add('fp-added-class');
      return true;
    },
  },
  {
    id: 'rename-hashed-class',
    description: 'Change the suffix of a build-generated (hashed) class',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const hashed = [...el.classList].find((c) => /^(?:css|sc|jsx|svelte)-[a-z0-9]+$/i.test(c));
      if (!hashed) return false;
      el.classList.replace(hashed, hashed.replace(/[a-z0-9]+$/i, 'zz99xx'));
      return true;
    },
  },
  {
    id: 'add-framework-attr',
    description: 'Add a framework-style scoping attribute',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.setAttribute('data-v-fp0001', '');
      return true;
    },
  },
  {
    id: 'move-to-end',
    description: 'Move the target to the end of its siblings',
    apply: (selector) => {
      const el = document.querySelector(selector);
      if (!el || !el.parentElement || el.parentElement.lastElementChild === el) return false;
      el.parentElement.appendChild(el);
      return true;
    },
  },
];
