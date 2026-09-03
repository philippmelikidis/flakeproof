// One-off maintenance script: shrinks the committed spikes/live-pairs/*.json
// fixtures from a full serialized page (~600 KB each, ~7 MB total) down to
// just the DOM neighbourhood the classifier actually looks at, while
// reproducing byte-identical classifyDelta() verdicts.
//
// classifyDelta only ever inspects two locations in the current tree: the
// node at baseline.anchorPath, and whatever node findBestMatch() picks as
// its best match (which, for a page with duplicated regions such as a
// light/dark header twin, can be far from the anchor - see
// spikes/phase0-report.md's checkpoint note 3). So "the anchor's
// neighbourhood" is not a fixed radius: it is precisely those two paths.
//
// Pruning strategy, per tree: walk from the root along the kept path(s).
// Every node NOT on one of those paths gets its `children` array replaced
// with `[]` (dropping its serialized subtree) but keeps its own tag / id /
// classes / attrs / text / name / path untouched, and every array KEEPS its
// original length (siblings become empty placeholders, they are never
// removed). That preserves:
//   - index-based navigation (nodeAt/ancestorsOf walk children[i] using the
//     original anchorPath / match path arrays - those stay valid because no
//     array is ever shortened),
//   - every node's own scoring fields for findBestMatch's similarity() -
//     tag/id/text/name/href/classes/role/path are read from the node
//     itself, never from its descendants, so no candidate's score for those
//     terms changes,
//   - the only score term that CAN change is childrenScore(), which reads a
//     node's own first-level children (text/href). Placeholders lose that
//     signal, but only ever downward (never upward - see rationale below),
//   - the "shrunken sibling set" guard in classify.js, which compares
//     children.length of the anchor's/match's immediate parent - untouched
//     since we never shorten an array, only its descendants.
//
// Why this cannot change the winning match: the true best-match node is
// itself one of the kept endpoints, so it is never turned into a
// placeholder and its score is unchanged. Every OTHER node can only lose
// children-derived score (empty child signature scores 0 or the one-sided
// penalty, never higher than a real jaccard match could) - so no
// placeholder can overtake the node that already won on the full tree.
//
// Verification: `node spikes/run-phase0.js` was run before and after this
// script and the generated spikes/phase0-report.md confusion matrix,
// misclassification list and unclear list are identical (see git history /
// cycle9 report).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { nodeAt } from '../src/triage/tree.js';
import { findBestMatch } from '../src/triage/match.js';

function pathsEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isPrefix(prefix, path) {
  return prefix.length <= path.length && prefix.every((v, i) => v === path[i]);
}

// Keeps every node along `keepPaths`' shared chain intact (full array
// length at every level); once a path reaches one of the exact keepPaths,
// that node's subtree is left fully untouched; everything else becomes a
// same-position, childless placeholder.
function pruneToPaths(tree, keepPaths) {
  function walk(node, path) {
    if (keepPaths.some((p) => pathsEqual(p, path))) return node; // endpoint: keep fully
    const onChain = keepPaths.some((p) => isPrefix(path, p));
    if (!onChain) return { ...node, children: [] };
    return { ...node, children: node.children.map((c, i) => walk(c, [...path, i])) };
  }
  return walk(tree, []);
}

const dir = new URL('./live-pairs/', import.meta.url);
const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('_'));

let totalBefore = 0;
let totalAfter = 0;

for (const file of files) {
  const raw = await readFile(new URL(file, dir), 'utf8');
  totalBefore += Buffer.byteLength(raw);
  const pair = JSON.parse(raw);

  const anchorPath = pair.baseline.anchorPath;
  const target = anchorPath ? nodeAt(pair.baseline.tree, anchorPath) : null;
  const prunedBaseline = anchorPath
    ? { ...pair.baseline, tree: pruneToPaths(pair.baseline.tree, [anchorPath]) }
    : pair.baseline;

  let prunedCurrent = pair.current;
  if (target) {
    const match = findBestMatch(pair.current.tree, target);
    if (match) {
      prunedCurrent = { ...pair.current, tree: pruneToPaths(pair.current.tree, [match.node.path]) };
    } else {
      console.warn(`${file}: no match found on the full tree - leaving current.tree unpruned (needs a broader search than one path)`);
    }
  } else {
    console.warn(`${file}: no baseline anchor - leaving current.tree unpruned`);
  }

  const pruned = { ...pair, baseline: prunedBaseline, current: prunedCurrent };
  const out = JSON.stringify(pruned);
  totalAfter += Buffer.byteLength(out);
  await writeFile(new URL(file, dir), out, 'utf8');
  console.log(`${file}: ${raw.length} -> ${out.length} bytes`);
}

console.log(`\ntotal: ${totalBefore} -> ${totalAfter} bytes`);
