// Classifies the DOM delta at a failed test's anchor.
//   cosmetic: the selector broke on a meaning-free coupling (fragile test).
//   semantic: meaning changed or vanished (probable real regression).
//   unclear: mixed or missing evidence, never guess.
import { nodeAt, findNode } from './tree.js';
import { findBestMatch } from './match.js';

const HASHED_CLASS =
  /^(?:css|sc|jsx|svelte)-[a-z0-9]+$|^_?ng(?:content|host)-|^[a-z][\w-]*__[a-z0-9]{5,}$/i;

export function selectorFeatures(selector) {
  return {
    ids: [...selector.matchAll(/#([\w-]+)/g)].map((m) => m[1]),
    classes: [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]),
    texts: [...selector.matchAll(/:(?:text|text-is|has-text)\(["']?(.+?)["']?\)/g)].map((m) => m[1]),
    structural: /[>~+]|:nth-/.test(selector),
  };
}

// Collects the ancestor nodes along a path, excluding the target/matched
// node itself (i.e. root down to the parent of the node at `path`).
function ancestorsOf(tree, path) {
  const out = [];
  let node = tree;
  for (const i of path) {
    out.push(node);
    node = node.children?.[i];
    if (!node) break;
  }
  return out;
}

export function classifyDelta(baseline, current, anchorSelector) {
  const target = baseline.anchorPath ? nodeAt(baseline.tree, baseline.anchorPath) : null;
  if (!target) {
    return { verdict: 'unclear', reasons: ['anchor element not present in baseline snapshot'], match: null };
  }

  const match = findBestMatch(current.tree, target);
  if (!match) {
    // No candidate scored high enough to count as a confident match. If the
    // target has a strong identity of its own (id, own text, accessible
    // name, or href), a failed match is solid evidence of removal: were the
    // element still there with those markers intact, it would have scored
    // well above threshold. But an element whose only identity is tag +
    // classes (no id/text/name/href of its own, e.g. a bare <li> wrapping a
    // link) can *never* clear the confidence threshold on class overlap
    // alone (see src/triage/match.js) - for those, a purely cosmetic change
    // (an added class dilutes overlap, a move changes sibling position)
    // produces the exact same "no match" signal as a real removal. Only
    // hedge to 'unclear' for that weak-identity case, and only when other
    // elements of the same tag still exist to plausibly be it.
    const weakIdentity = !target.id && !target.text && !target.name && !target.attrs.href;
    const sameTagSurvives = weakIdentity && findNode(current.tree, (n) => n.tag === target.tag) !== null;
    if (sameTagSurvives) {
      return {
        verdict: 'unclear',
        reasons: [
          `no element matched <${target.tag}${target.id ? '#' + target.id : ''}> with enough confidence, ` +
            `but other <${target.tag}> elements remain; cannot tell a rename/move from a removal`,
        ],
        match: null,
      };
    }
    return {
      verdict: 'semantic',
      reasons: [`element <${target.tag}${target.id ? '#' + target.id : ''}> no longer exists in current build`],
      match: null,
    };
  }

  const feat = selectorFeatures(anchorSelector);
  const b = match.node;
  const cosmetic = [];
  const semantic = [];
  const ambiguous = [];

  // Selector-relied classes that vanished from the element itself. A
  // build-tool hash going away is almost certainly a rename (cosmetic); any
  // other class loss could just as well be a real state change, so we can't
  // guess - it's ambiguous.
  for (const cls of feat.classes) {
    if (target.classes.includes(cls) && !b.classes.includes(cls)) {
      if (HASHED_CLASS.test(cls)) {
        cosmetic.push(`selector relies on build-generated class ".${cls}" which is gone from the element`);
      } else {
        ambiguous.push(
          `selector relies on class ".${cls}" which is gone; cannot tell a rename from a real state change`,
        );
      }
    }
  }

  // Selector-relied ids that vanished from the element itself. Ids get no
  // hash heuristic, so this is always ambiguous.
  for (const id of feat.ids) {
    if (target.id === id && b.id !== id) {
      ambiguous.push(`selector relies on id "#${id}" which is gone; cannot tell a rename from a real state change`);
    }
  }

  // Selector-relied ids/classes that were never on the target itself but
  // sat on an ancestor. If a baseline ancestor had it and neither the
  // matched node nor any of its current ancestors have it anymore, the
  // selector's ancestor coupling broke.
  const baselineAncestors = ancestorsOf(baseline.tree, baseline.anchorPath);
  const currentAncestors = ancestorsOf(current.tree, match.node.path);

  for (const cls of feat.classes) {
    if (target.classes.includes(cls)) continue; // handled above
    if (!baselineAncestors.some((a) => a.classes.includes(cls))) continue;
    if (b.classes.includes(cls) || currentAncestors.some((a) => a.classes.includes(cls))) continue;
    if (HASHED_CLASS.test(cls)) {
      cosmetic.push(`selector relies on build-generated class ".${cls}" which an ancestor lost`);
    } else {
      ambiguous.push(
        `selector relies on class ".${cls}" which an ancestor lost; cannot tell a rename from a real state change`,
      );
    }
  }

  for (const id of feat.ids) {
    if (target.id === id) continue; // handled above
    if (!baselineAncestors.some((a) => a.id === id)) continue;
    if (b.id === id || currentAncestors.some((a) => a.id === id)) continue;
    ambiguous.push(`selector relies on id "#${id}" which an ancestor lost; cannot tell a rename from a real state change`);
  }

  // Selector-relied text that vanished.
  for (const t of feat.texts) {
    const had = target.text.includes(t) || target.name.includes(t);
    const has = b.text.includes(t) || b.name.includes(t);
    if (had && !has) semantic.push(`text "${t}" the selector matched on is no longer present`);
  }

  // Structural selectors vs. position/ancestry changes.
  if (feat.structural) {
    if (b.path.length !== target.path.length) {
      cosmetic.push('element depth changed (wrapper inserted/removed) and selector depends on structure');
    } else if (String(b.path) !== String(target.path)) {
      cosmetic.push('element position changed and selector depends on structure');
    }
  }

  // Meaning-bearing deltas independent of the selector.
  if (target.text !== b.text && !semantic.length) {
    semantic.push(`own text changed: "${target.text}" -> "${b.text}"`);
  }
  if ((target.attrs.href ?? null) !== (b.attrs.href ?? null)) {
    semantic.push(`href changed: "${target.attrs.href ?? ''}" -> "${b.attrs.href ?? ''}"`);
  }

  let verdict = 'unclear';
  if (!ambiguous.length) {
    if (semantic.length && !cosmetic.length) verdict = 'semantic';
    if (cosmetic.length && !semantic.length) verdict = 'cosmetic';
  }

  return { verdict, reasons: [...semantic, ...cosmetic, ...ambiguous], match: { score: match.score } };
}
