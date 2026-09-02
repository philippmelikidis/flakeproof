// Classifies the DOM delta at a failed test's anchor.
//   cosmetic: the selector broke on a meaning-free coupling (fragile test).
//   semantic: meaning changed or vanished (probable real regression).
//   unclear: mixed or missing evidence, never guess.
import { nodeAt, findNode, ancestorsOf } from './tree.js';
import { findBestMatch } from './match.js';

export const HASHED_CLASS =
  /^(?:css|sc|jsx|svelte)-[a-z0-9]+$|^_?ng(?:content|host)-|^[a-z][\w-]*__[a-z0-9]{5,}$/i;

export function selectorFeatures(selector) {
  return {
    ids: [...selector.matchAll(/#([\w-]+)/g)].map((m) => m[1]),
    classes: [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]),
    texts: [...selector.matchAll(/:(?:text|text-is|has-text)\(["']?(.+?)["']?\)/g)].map((m) => m[1]),
    structural: /[>~+]|:nth-/.test(selector),
  };
}

export function classifyDelta(baseline, current, anchorSelector) {
  const target = baseline.anchorPath ? nodeAt(baseline.tree, baseline.anchorPath) : null;
  if (!target) {
    return { verdict: 'unclear', reasons: ['anchor element not present in baseline snapshot'], match: null };
  }

  const match = findBestMatch(current.tree, target);
  if (!match) {
    // No candidate scored high enough to count as a confident match. If the
    // target has a strong intrinsic identity of its own (id, own text, href,
    // or an explicit aria-label), a failed match is solid evidence of
    // removal: were the element still there with those markers intact, it
    // would have scored well above threshold. But an element whose only
    // identity is tag + classes (no id/text/href/aria-label of its own, e.g.
    // a bare <li> wrapping a link) can *never* clear the confidence
    // threshold on class overlap alone (see src/triage/match.js) - for
    // those, a purely cosmetic change (an added class dilutes overlap, a
    // move changes sibling position) produces the exact same "no match"
    // signal as a real removal. Only hedge to 'unclear' for that
    // weak-identity case, and only when other elements of the same tag
    // still exist to plausibly be it.
    // Intrinsic markers only: id, the element's OWN text, href, and an
    // explicit aria-label. `name` is no longer intrinsic to the element - it
    // is the accessible name computed from the whole subtree (see
    // src/probe/serialize.js), so it changes whenever any descendant's text
    // changes even though the element itself is untouched and still
    // present. Using it here would report a merely-reworded descendant as
    // "no longer exists in current build", which is false: the element is
    // still there, just no longer confidently re-identified by this weaker
    // signal set.
    const weakIdentity =
      !target.id && !target.text && !target.attrs.href && !target.attrs['aria-label'];
    const sameTagSurvives = weakIdentity && findNode(current.tree, (n) => n.tag === target.tag) !== null;
    if (sameTagSurvives) {
      // The weak-identity hedge exists because a bare element (no id/text/
      // href/aria-label of its own) cannot be told apart from a rename or a
      // move using its own markers alone. But there is stronger evidence
      // available: `target.name`, the accessible name computed from the
      // element's whole subtree at capture time (see src/probe/serialize.js).
      // It is not an intrinsic marker of the element itself - a rename of a
      // DIFFERENT element could coincidentally produce the same name - but
      // its total ABSENCE from the current build is real evidence: if the
      // element had merely been renamed or moved, the content that used to
      // name it would still be sitting on some node in the current tree
      // (either the same node reworded, or a different node it was merged
      // into). Match by substring, not exact equality, and check the target
      // name against every current node's OWN name and text: a reword like
      // "Solutions" -> "Our Solutions" keeps "Solutions" as a substring of
      // the new name, and must still hedge (the element is still there,
      // just reworded) - only a name that does not survive at all supports
      // a confident removal. An empty target name (e.g. an icon-only
      // element with no text anywhere in its subtree) has nothing to search
      // for and must not be treated as "not found"; keep the old hedge.
      const targetName = (target.name || '').trim();
      const nameSurvives =
        !targetName ||
        findNode(current.tree, (n) => (n.name || '').includes(targetName) || (n.text || '').includes(targetName)) !==
          null;
      if (!nameSurvives) {
        return {
          verdict: 'semantic',
          reasons: [
            `element <${target.tag}${target.id ? '#' + target.id : ''}> no longer exists in current build ` +
              `(its name "${target.name}" is not found anywhere in the current build)`,
          ],
          match: null,
        };
      }
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

  // A shrunken sibling set next to cosmetic-only evidence is indistinguishable
  // from the anchor itself having been removed and a sibling sliding into its
  // place, so it must not settle on a cosmetic verdict.
  // After a wrapper insertion the "parent" at the matched path is a
  // different node (the wrapper itself), so comparing its child count
  // against the baseline parent's is meaningless. Only run this guard when
  // the anchor's depth is unchanged, so wrapper-insertion cases (a purely
  // cosmetic depth change) are excluded and fall through to a cosmetic
  // verdict instead of being hedged to ambiguous.
  if (cosmetic.length && b.path.length === target.path.length) {
    const baselineParent = baseline.anchorPath.length > 0 ? nodeAt(baseline.tree, baseline.anchorPath.slice(0, -1)) : null;
    const currentParent = b.path.length > 0 ? nodeAt(current.tree, b.path.slice(0, -1)) : null;
    if (baselineParent && currentParent && currentParent.children.length < baselineParent.children.length) {
      ambiguous.push('a sibling of the anchor disappeared; cannot tell a rename from a removal');
    }
  }

  let verdict = 'unclear';
  if (!ambiguous.length) {
    if (semantic.length && !cosmetic.length) verdict = 'semantic';
    if (cosmetic.length && !semantic.length) verdict = 'cosmetic';
  }

  return { verdict, reasons: [...semantic, ...cosmetic, ...ambiguous], match: { score: match.score, path: b.path } };
}
