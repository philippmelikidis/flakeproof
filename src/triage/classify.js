// Classifies the DOM delta at a failed test's anchor:
//   cosmetic  – the selector broke on a meaning-free coupling (fragile test)
//   semantic  – meaning changed or vanished (probable real regression)
//   unclear   – mixed or missing evidence; never guess.
import { nodeAt } from './tree.js';
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

export function classifyDelta(baseline, current, anchorSelector) {
  const target = baseline.anchorPath ? nodeAt(baseline.tree, baseline.anchorPath) : null;
  if (!target) {
    return { verdict: 'unclear', reasons: ['anchor element not present in baseline snapshot'], match: null };
  }

  const match = findBestMatch(current.tree, target);
  if (!match) {
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

  // Selector-relied classes that vanished from the element.
  for (const cls of feat.classes) {
    if (target.classes.includes(cls) && !b.classes.includes(cls)) {
      const label = HASHED_CLASS.test(cls) ? 'build-generated class' : 'class';
      cosmetic.push(`selector relies on ${label} ".${cls}" which is gone from the element`);
    }
  }

  // Selector-relied ids that vanished.
  for (const id of feat.ids) {
    if (target.id === id && b.id !== id) {
      cosmetic.push(`selector relies on id "#${id}" which is gone from the element`);
    }
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
  if (semantic.length && !cosmetic.length) verdict = 'semantic';
  if (cosmetic.length && !semantic.length) verdict = 'cosmetic';

  return { verdict, reasons: [...semantic, ...cosmetic], match: { score: match.score } };
}
