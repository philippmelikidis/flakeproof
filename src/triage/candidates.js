// Generates selector candidates for a node in a serialized tree and checks
// them for uniqueness with a deliberately small query grammar. Only what the
// grammar can verify becomes a candidate; everything else is not offered.
import { nodeAt, walk, ancestorsOf } from './tree.js';
import { HASHED_CLASS } from './classify.js';

function parseCompound(part) {
  const c = { tag: null, id: null, classes: [], attr: null, nth: null };
  let rest = part;
  const tag = rest.match(/^[a-z][\w-]*/i);
  if (tag) {
    c.tag = tag[0].toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    let m;
    if ((m = rest.match(/^#([\w-]+)/))) c.id = m[1];
    else if ((m = rest.match(/^\.([\w-]+)/))) c.classes.push(m[1]);
    else if ((m = rest.match(/^\[([\w-]+)="([^"]*)"\]/))) c.attr = { name: m[1], value: m[2] };
    else if ((m = rest.match(/^:nth-child\((\d+)\)/))) c.nth = Number(m[1]);
    else return null; // outside the supported grammar
    rest = rest.slice(m[0].length);
  }
  return c;
}

function matchesCompound(node, c) {
  if (c.tag && node.tag !== c.tag) return false;
  if (c.id && node.id !== c.id) return false;
  for (const cls of c.classes) if (!node.classes.includes(cls)) return false;
  if (c.attr && node.attrs[c.attr.name] !== c.attr.value) return false;
  if (c.nth !== null && node.path.at(-1) !== c.nth - 1) return false;
  return true;
}

function countByText(tree, text) {
  let count = 0;
  walk(tree, (node) => {
    if (node.text === text) count += 1;
  });
  return count;
}

// How many elements of this tag contain the text anywhere in their subtree,
// case-insensitively. This mirrors Playwright's :has-text(), which is a
// substring match over the whole subtree, so the tree-side gate can never
// claim more uniqueness than the emitted selector actually has.
function subtreeText(node) {
  let out = node.text || '';
  for (const c of node.children) out += ' ' + subtreeText(c);
  return out;
}

function countByChildText(tree, tag, text) {
  const needle = text.toLowerCase();
  let count = 0;
  walk(tree, (node) => {
    if (node.tag !== tag) return;
    if (subtreeText(node).toLowerCase().includes(needle)) count += 1;
  });
  return count;
}

function countByRoleName(tree, role, name) {
  let count = 0;
  walk(tree, (node) => {
    if (node.role === role && (node.name || node.text) === name) count += 1;
  });
  return count;
}

export function queryTree(tree, selector) {
  if (!selector || !selector.trim()) return null;
  const parts = selector.trim().split(/\s+/).map(parseCompound);
  if (parts.some((p) => p === null)) return null;
  const out = [];
  walk(tree, (node) => {
    if (!matchesCompound(node, parts.at(-1))) return;
    if (parts.length === 1) {
      out.push(node);
      return;
    }
    // Every earlier part must match some ancestor, in document order.
    const ancestors = ancestorsOf(tree, node.path);
    let pi = 0;
    for (const anc of ancestors) {
      if (pi < parts.length - 1 && matchesCompound(anc, parts[pi])) pi += 1;
    }
    if (pi >= parts.length - 1) out.push(node);
  });
  return out;
}

export function candidatesFor(tree, path) {
  const node = nodeAt(tree, path);
  if (!node) return [];
  const raw = [];
  if (node.id) raw.push({ selector: `#${node.id}`, kind: 'id' });
  if (node.attrs['data-testid']) {
    raw.push({ selector: `[data-testid="${node.attrs['data-testid']}"]`, kind: 'testid' });
  }
  if (node.attrs['aria-label']) {
    raw.push({ selector: `${node.tag}[aria-label="${node.attrs['aria-label']}"]`, kind: 'aria' });
  }
  // Playwright-syntax candidates. queryTree's css grammar cannot verify
  // these; uniqueness is approximated tree-side (exact own-text match,
  // role + accessible-name match) and finally verified by the prover on the
  // live page. Fail closed on empty, long or quote-bearing text.
  const ownText = node.text;
  if (ownText && ownText.length <= 80 && !ownText.includes('"')) {
    raw.push({ selector: `text="${ownText}"`, kind: 'text' });
  }
  // Playwright computes the accessible name from the full subtree; when the
  // node has element children but no explicit name, the tree-side
  // approximation (own text) cannot model that computation, so skip the
  // role candidate rather than guess.
  const roleName = node.name || node.text;
  const nameApproximable = node.name || node.children.length === 0;
  if (node.role && roleName && nameApproximable && roleName.length <= 80 && !roleName.includes('"')) {
    raw.push({ selector: `role=${node.role}[name="${roleName}"]`, kind: 'role' });
  }
  // A container bound by its child's text. For an anonymous element (no id,
  // no own text) this is the only stable alternative to a positional
  // selector: it survives both class churn and reordering.
  const scope = [...ancestorsOf(tree, path)].reverse().find((a) => a.id);
  const childTexts = node.children.map((c) => c.text).filter(Boolean);
  if (!node.text && scope && childTexts.length === 1) {
    const ct = childTexts[0];
    if (ct.length <= 80 && !ct.includes('"') && !ct.includes('\\')) {
      raw.push({ selector: `#${scope.id} ${node.tag}:has-text("${ct}")`, kind: 'container-text' });
    }
  }
  const stable = node.classes.filter((c) => !HASHED_CLASS.test(c));
  for (const cls of stable) raw.push({ selector: `${node.tag}.${cls}`, kind: 'class' });

  if (scope) {
    raw.push({ selector: `#${scope.id} ${node.tag}`, kind: 'scoped' });
    for (const cls of stable) raw.push({ selector: `#${scope.id} ${node.tag}.${cls}`, kind: 'scoped' });
    raw.push({
      selector: `#${scope.id} ${node.tag}:nth-child(${node.path.at(-1) + 1})`,
      kind: 'positional',
    });
  }

  const seen = new Set();
  return raw.filter((cand) => {
    if (seen.has(cand.selector)) return false;
    seen.add(cand.selector);
    if (cand.kind === 'text') return countByText(tree, node.text) === 1;
    if (cand.kind === 'role') return countByRoleName(tree, node.role, node.name || node.text) === 1;
    if (cand.kind === 'container-text') {
      const ct = childTexts[0];
      return countByChildText(tree, node.tag, ct) === 1;
    }
    const hits = queryTree(tree, cand.selector);
    return hits !== null && hits.length === 1 && hits[0] === node;
  });
}
