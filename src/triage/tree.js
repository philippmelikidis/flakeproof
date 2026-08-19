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
