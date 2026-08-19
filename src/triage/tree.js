export function nodeAt(tree, path) {
  let node = tree;
  for (const i of path) {
    node = node.children[i];
    if (!node) return null;
  }
  return node;
}

export function walk(tree, fn) {
  fn(tree);
  for (const c of tree.children) walk(c, fn);
}

export function findNode(tree, pred) {
  let found = null;
  walk(tree, (n) => { if (!found && pred(n)) found = n; });
  return found;
}

// Ancestor nodes along a path, from the root down to the parent of the node
// at `path` (the node itself is excluded).
export function ancestorsOf(tree, path) {
  const out = [];
  let node = tree;
  for (const i of path) {
    out.push(node);
    node = node.children?.[i];
    if (!node) break;
  }
  return out;
}
