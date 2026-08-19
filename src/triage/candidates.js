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
  const stable = node.classes.filter((c) => !HASHED_CLASS.test(c));
  for (const cls of stable) raw.push({ selector: `${node.tag}.${cls}`, kind: 'class' });

  const scopeAncestor = [...ancestorsOf(tree, path)].reverse().find((a) => a.id);
  if (scopeAncestor) {
    raw.push({ selector: `#${scopeAncestor.id} ${node.tag}`, kind: 'scoped' });
    for (const cls of stable) raw.push({ selector: `#${scopeAncestor.id} ${node.tag}.${cls}`, kind: 'scoped' });
    raw.push({
      selector: `#${scopeAncestor.id} ${node.tag}:nth-child(${node.path.at(-1) + 1})`,
      kind: 'positional',
    });
  }

  const seen = new Set();
  return raw.filter((cand) => {
    if (seen.has(cand.selector)) return false;
    seen.add(cand.selector);
    const hits = queryTree(tree, cand.selector);
    return hits !== null && hits.length === 1 && hits[0] === node;
  });
}
