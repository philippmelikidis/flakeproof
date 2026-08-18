// Re-identifies "the same" element in a changed DOM tree via weighted
// similarity. Weights are phase-0 starting values; the spike report
// documents how they held up.
import { walk } from './tree.js';

const WEIGHTS = { tag: 2, id: 3, text: 3, name: 2, href: 2, classOverlap: 2 };
const SIBLING_PENALTY_MAX = 2;

function jaccard(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export function similarity(a, b) {
  if (a.tag !== b.tag) return 0;
  let score = WEIGHTS.tag;
  if (a.id && a.id === b.id) score += WEIGHTS.id;
  if (a.text && a.text === b.text) score += WEIGHTS.text;
  if (a.name && a.name === b.name) score += WEIGHTS.name;
  if (a.attrs.href && a.attrs.href === b.attrs.href) score += WEIGHTS.href;
  score += WEIGHTS.classOverlap * jaccard(a.classes, b.classes);
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
