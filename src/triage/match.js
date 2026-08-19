// Re-identifies "the same" element in a changed DOM tree via weighted
// similarity. Weights are phase-0 starting values; the spike report
// documents how they held up.
import { walk } from './tree.js';

const WEIGHTS = { tag: 2, id: 3, text: 3, name: 2, href: 2, classOverlap: 2, role: 1, locality: 3, children: 3 };
const SIBLING_PENALTY_MAX = 2;
const CHILD_MISMATCH_PENALTY = 2;
const CHILD_ONESIDED_PENALTY = 1;

function jaccard(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// Shared path prefix as a fraction of the deeper path. Elements in the same
// DOM region share most of their path; a twin in a duplicated region shares
// almost none. This is what keeps duplicated headers from capturing the match.
function localityBonus(aPath, bPath) {
  if (aPath.length === 0 || bPath.length === 0) return 0;
  let shared = 0;
  const limit = Math.min(aPath.length, bPath.length);
  while (shared < limit && aPath[shared] === bPath[shared]) shared += 1;
  return WEIGHTS.locality * (shared / Math.max(aPath.length, bPath.length));
}

// What a node's direct children say about its identity: their text, or
// failing that their href, or failing that their tag. Locality alone cannot
// tell a removed element from the sibling that slid into its position; the
// children can ("Products" vs "Solutions").
function childSignature(node) {
  return node.children.slice(0, 8).map((c) => c.text || c.attrs.href || c.tag);
}

function childrenScore(a, b) {
  const sigA = childSignature(a);
  const sigB = childSignature(b);
  if (sigA.length === 0 && sigB.length === 0) return 0;
  if (sigA.length === 0 || sigB.length === 0) return -CHILD_ONESIDED_PENALTY;
  const j = jaccard(sigA, sigB);
  return j > 0 ? WEIGHTS.children * j : -CHILD_MISMATCH_PENALTY;
}

export function similarity(a, b) {
  if (a.tag !== b.tag) return 0;
  let score = WEIGHTS.tag;
  if (a.id && a.id === b.id) score += WEIGHTS.id;
  if (a.text && a.text === b.text) score += WEIGHTS.text;
  if (a.name && a.name === b.name) score += WEIGHTS.name;
  if (a.attrs.href && a.attrs.href === b.attrs.href) score += WEIGHTS.href;
  score += WEIGHTS.classOverlap * jaccard(a.classes, b.classes);
  if (a.role && a.role === b.role) score += WEIGHTS.role;
  score += localityBonus(a.path, b.path);
  score += childrenScore(a, b);
  if (a.path.length > 0 && b.path.length > 0) {
    const posDelta = Math.abs(a.path.at(-1) - b.path.at(-1));
    score -= Math.min(SIBLING_PENALTY_MAX, posDelta * 0.5);
  }
  return score;
}

export function findBestMatch(tree, target, threshold = 5) {
  let best = null;
  let bestScore = -Infinity;
  walk(tree, (node) => {
    const s = similarity(target, node);
    if (s > bestScore) {
      best = node;
      bestScore = s;
    }
  });
  return bestScore >= threshold ? { node: best, score: bestScore } : null;
}
