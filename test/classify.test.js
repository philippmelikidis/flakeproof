import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDelta, selectorFeatures } from '../src/triage/classify.js';

function n(tag, props = {}, children = []) {
  return {
    tag, id: null, classes: [], attrs: {}, text: '', name: '', path: [],
    ...props, children,
  };
}
function withPaths(node, path = []) {
  node.path = path;
  node.children.forEach((c, i) => withPaths(c, path.concat(i)));
  return node;
}
function snap(tree, anchorPath) {
  return { tree: withPaths(tree), anchorPath };
}

const baselineTree = () =>
  n('html', {}, [
    n('body', {}, [
      n('header', { id: 'site-header' }, [
        n('a', { id: 'cta', classes: ['btn', 'css-1a2b3c'], text: 'Contact us', attrs: { href: '/contact/' } }),
      ]),
    ]),
  ]);
// anchor path to #cta in baselineTree: [0, 0, 0]  (body > header > a)

test('selectorFeatures parses ids, classes, text and structure', () => {
  const f = selectorFeatures('ul#main-nav > li.css-1a2b3c > a:text-is("Products")');
  assert.deepEqual(f.ids, ['main-nav']);
  assert.deepEqual(f.classes, ['css-1a2b3c']);
  assert.deepEqual(f.texts, ['Products']);
  assert.equal(f.structural, true);
});

test('element removed -> semantic', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [n('body', {}, [n('header', { id: 'site-header' })])]),
    null,
  );
  const r = classifyDelta(before, after, '#cta');
  assert.equal(r.verdict, 'semantic');
});

test('an icon-only li with no intrinsic markers hedges to unclear when gone, rather than claiming removal', () => {
  // The weakIdentity -> unclear hedge (sameTagSurvives branch) had its only
  // integration coverage lost when test/e2e-triage.test.js was updated. An
  // icon-only <li> - no text, no id, no href, no aria-label - has no
  // intrinsic identity of its own to distinguish "this exact element was
  // removed" from "the matcher simply could not re-identify it". When it
  // disappears from the current build but other <li> elements of the same
  // tag remain, the honest answer is 'unclear', not a confident claim of
  // removal.
  const before = snap(
    n('html', {}, [
      n('body', {}, [
        n('ul', {}, [
          n('li', { classes: ['icon-li'] }), // the anchor: no text/id/href/aria-label
          n('li', { classes: ['nav-item'] }, [n('a', { text: 'Solutions', attrs: { href: '/solutions/' } })]),
        ]),
      ]),
    ]),
    [0, 0, 0], // body > ul > li(icon-only)
  );
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('ul', {}, [
          // The icon-only li is gone; the other li survives.
          n('li', { classes: ['nav-item'] }, [n('a', { text: 'Solutions', attrs: { href: '/solutions/' } })]),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'li.icon-li');
  assert.equal(r.verdict, 'unclear');
  assert.ok(
    !r.reasons.some((msg) => msg.includes('no longer exists in current build')),
    `must hedge rather than claim removal, got: ${JSON.stringify(r.reasons)}`,
  );
});

test('hashed class renamed, selector relied on it -> cosmetic', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('a', { id: 'cta', classes: ['btn', 'css-zz99xx'], text: 'Contact us', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'a.css-1a2b3c');
  assert.equal(r.verdict, 'cosmetic');
});

test('new wrapper broke a structural selector -> cosmetic', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('div', {}, [
            n('a', { id: 'cta', classes: ['btn', 'css-1a2b3c'], text: 'Contact us', attrs: { href: '/contact/' } }),
          ]),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'header > a.btn');
  assert.equal(r.verdict, 'cosmetic');
});

test('text the selector matched on has changed -> semantic', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('a', { id: 'cta', classes: ['btn', 'css-1a2b3c'], text: 'Get a quote', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'a:text-is("Contact us")');
  assert.equal(r.verdict, 'semantic');
});

test('mixed signals -> unclear', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('a', { id: 'cta', classes: ['btn', 'css-zz99xx'], text: 'Get a quote', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'a.css-1a2b3c:text-is("Contact us")');
  assert.equal(r.verdict, 'unclear');
});

test('no explaining delta -> unclear', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(baselineTree(), null);
  const r = classifyDelta(before, after, '#cta');
  assert.equal(r.verdict, 'unclear');
});

test('anchor missing in baseline -> unclear', () => {
  const before = snap(baselineTree(), null);
  const after = snap(baselineTree(), null);
  const r = classifyDelta(before, after, '#never-existed');
  assert.equal(r.verdict, 'unclear');
});

test('meaningful class lost from the element, selector relies on it -> unclear', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'site-header' }, [
          n('a', { id: 'cta', classes: ['css-1a2b3c'], text: 'Contact us', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'a.btn');
  assert.equal(r.verdict, 'unclear');
});

test('ancestor hashed class renamed, selector relies on it -> cosmetic', () => {
  const ancestorTree = () =>
    n('html', {}, [
      n('body', {}, [
        n('li', { classes: ['css-1a2b3c'] }, [
          n('a', { id: 'cta', classes: ['btn'], text: 'Contact us', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]);
  // anchor path to the `a` element: [0, 0, 0]  (body > li > a)
  const before = snap(ancestorTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('li', { classes: ['css-zz99xx'] }, [
          n('a', { id: 'cta', classes: ['btn'], text: 'Contact us', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'li.css-1a2b3c > a');
  assert.equal(r.verdict, 'cosmetic');
});

test('weak-identity element (no id/text/href of its own) is now re-identified via locality', () => {
  // A bare <li> whose only identity is tag + classes (its text lives in the
  // child <a>) is now lifted above the match threshold by locality bonus in
  // phase 1. The locality term and child signature let it match despite weak
  // identity. The match is found, but the selector 'li.css-1a2b3c' provides
  // no signal about what changed (the class is still present), so verdict is
  // unclear. This prevents false semantic classification.
  const navTree = () =>
    n('html', {}, [
      n('body', {}, [
        n('ul', { id: 'main-nav' }, [
          n('li', { classes: ['css-1a2b3c', 'nav-item'] }, [
            n('a', { text: 'Products', attrs: { href: '/products/' } }),
          ]),
          n('li', { classes: ['css-9z8y7x', 'nav-item'] }, [
            n('a', { text: 'Solutions', attrs: { href: '/solutions/' } }),
          ]),
        ]),
      ]),
    ]);
  // anchor path to the first `li`: [0, 0, 0]  (body > ul > li)
  const before = snap(navTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('ul', { id: 'main-nav' }, [
          n('li', { classes: ['css-1a2b3c', 'fp-added-class', 'nav-item'] }, [
            n('a', { text: 'Products', attrs: { href: '/products/' } }),
          ]),
          n('li', { classes: ['css-9z8y7x', 'nav-item'] }, [
            n('a', { text: 'Solutions', attrs: { href: '/solutions/' } }),
          ]),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'li.css-1a2b3c');
  assert.equal(r.verdict, 'unclear');
  assert.ok(r.match, 'locality must now enable matching of bare li');
});

test('a weak-identity element whose name is nowhere in the current build is confidently reported as removed', () => {
  // Same shape as the "other <li> elements survive" hedge case, but this
  // time the removed element's name ("Solutions") does not show up
  // anywhere in the current tree - not on any node's own computed name,
  // not in any node's own text. That is real evidence the element itself,
  // not just its class or position, is gone: were it merely renamed or
  // moved, some node in the current build would still carry that content.
  // The weak-identity hedge exists to cover a rename/move that this exact
  // check can now rule out, so the verdict should be a confident 'semantic'
  // (real-change), not 'unclear'.
  const before = snap(
    n('html', {}, [
      n('body', {}, [
        n('ul', { id: 'main-nav' }, [
          n('li', { classes: ['css-1a2b3c', 'nav-item'] }, [
            n('a', { text: 'Products', attrs: { href: '/products/' } }),
          ]),
          n('li', { classes: ['css-9z8y7x', 'nav-item'], name: 'Solutions' }, [
            n('a', { text: 'Solutions', attrs: { href: '/solutions/' } }),
          ]),
        ]),
      ]),
    ]),
    [0, 0, 1], // body > ul > li(Solutions)
  );
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('ul', { id: 'main-nav' }, [
          n('li', { classes: ['css-1a2b3c', 'nav-item'] }, [
            n('a', { text: 'Products', attrs: { href: '/products/' } }),
          ]),
          n('li', { classes: ['css-4d5e6f', 'nav-item'] }, [
            n('a', { text: 'Company', attrs: { href: '/company/' } }),
          ]),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'li.css-9z8y7x');
  assert.equal(r.verdict, 'semantic');
  assert.ok(
    r.reasons.some((msg) => msg.includes('no longer exists in current build')),
    `expected a confident removal reason, got: ${JSON.stringify(r.reasons)}`,
  );
});

test('a bare li whose child text was merely reworded is not falsely reported as removed', () => {
  // Reproduces a false positive: the accessible `name` on a node is now
  // derived from the whole subtree (see src/probe/serialize.js), so it is
  // NOT an intrinsic marker of the element itself - it changes whenever any
  // descendant's text changes. A bare <li> (no id, no own text, no href, no
  // aria-label) whose only identity used to be tag + classes now also has a
  // `name` ("Solutions") purely because its child <a> has that text.
  //
  // Between builds the child link is reworded ("Solutions" -> "Our
  // Solutions") and the build tool rotates the hashed class as it always
  // does. Both push the match score for this <li> below the confidence
  // threshold (subtree text changed -> children signature no longer
  // overlaps; hashed class rotated -> class overlap drops to one shared
  // class out of three), so findBestMatch legitimately fails to match it
  // confidently. The element is still right there in the current build,
  // just no longer confidently re-identified.
  //
  // If weakIdentity used `!target.name` (the old, buggy check), the now
  // non-empty subtree-derived name would make weakIdentity false, skip the
  // 'unclear' hedge, and directly report the element as removed - which is
  // false. Using only intrinsic markers must hedge to 'unclear' instead.
  const before = snap(
    n('html', {}, [
      n('body', {}, [
        n('ul', { id: 'main-nav' }, [
          n('li', { classes: ['css-1a2b3c', 'nav-item'], name: 'Solutions' }, [
            n('a', { text: 'Solutions', attrs: { href: '/solutions/' } }),
          ]),
        ]),
      ]),
    ]),
    [0, 0, 0], // body > ul > li
  );
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('ul', { id: 'main-nav' }, [
          n('li', { classes: ['css-q1w2e3', 'nav-item'], name: 'Our Solutions' }, [
            n('a', { text: 'Our Solutions', attrs: { href: '/solutions/' } }),
          ]),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'li.css-1a2b3c');
  assert.equal(r.verdict, 'unclear');
  assert.ok(
    !r.reasons.some((msg) => msg.includes('no longer exists in current build')),
    `must not falsely claim removal for an element that is still present, got: ${JSON.stringify(r.reasons)}`,
  );
});

test('sibling slide-in with equal text next to cosmetic evidence -> unclear', () => {
  // Two <a class="css-*">Learn more</a> siblings in the baseline; the anchor
  // is the first (css-1a2b3c). In "current" only the second sibling
  // (css-9z8y7x) remains, at the same position the anchor used to occupy.
  // The class-rename evidence alone would say cosmetic, but the shrunken
  // sibling set means this is indistinguishable from the anchor having been
  // removed and its sibling sliding into place.
  const before = snap(
    n('html', {}, [
      n('body', {}, [
        n('div', {}, [
          n('a', { classes: ['css-1a2b3c'], text: 'Learn more' }),
          n('a', { classes: ['css-9z8y7x'], text: 'Learn more' }),
        ]),
      ]),
    ]),
    [0, 0, 0],
  );
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('div', {}, [
          n('a', { classes: ['css-9z8y7x'], text: 'Learn more' }),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'a.css-1a2b3c');
  assert.equal(r.verdict, 'unclear');
});

// The removal check used to be a raw case-sensitive substring test
// (`current.name.includes(target.name)`), which turned a mere copy edit
// into a confident (and wrong) 'semantic' verdict for every row below
// except the first. This mirrors the exact shape of "a weak-identity
// element whose name is nowhere in the current build is confidently
// reported as removed" above: the anchor is a bare <li> (no id/own-text/
// href/aria-label) whose only identity signal is its subtree-computed
// `name`, "Solutions"; findBestMatch fails to clear the confidence
// threshold (class churn plus a changed child text/href), so the removal
// check is what decides the verdict. Only the SURVIVING li's name/text
// varies per row.
function survivalCase(currentName) {
  const navTree = () =>
    n('html', {}, [
      n('body', {}, [
        n('ul', { id: 'main-nav' }, [
          n('li', { classes: ['css-1a2b3c', 'nav-item'] }, [n('a', { text: 'Products', attrs: { href: '/products/' } })]),
          n('li', { classes: ['css-9z8y7x', 'nav-item'], name: 'Solutions' }, [
            n('a', { text: 'Solutions', attrs: { href: '/solutions/' } }),
          ]),
        ]),
      ]),
    ]);
  const before = snap(navTree(), [0, 0, 1]); // body > ul > li(Solutions)
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('ul', { id: 'main-nav' }, [
          n('li', { classes: ['css-1a2b3c', 'nav-item'] }, [n('a', { text: 'Products', attrs: { href: '/products/' } })]),
          n('li', { classes: ['css-4d5e6f', 'nav-item'], name: currentName }, [
            n('a', { text: currentName, attrs: { href: '/company/' } }),
          ]),
        ]),
      ]),
    ]),
    null,
  );
  return classifyDelta(before, after, 'li.css-9z8y7x');
}

const survivalTable = [
  ['Our Solutions', 'unclear'],
  ['solutions', 'unclear'],
  ['SOLUTIONS', 'unclear'],
  ['Solution', 'unclear'],
  ['Sol utions', 'unclear'],
];

for (const [currentName, expected] of survivalTable) {
  test(`removal check: current name "${currentName}" -> ${expected} (not a confident removal)`, () => {
    const r = survivalCase(currentName);
    assert.equal(r.verdict, expected);
    assert.ok(
      !r.reasons.some((msg) => msg.includes('no longer exists in current build')),
      `"${currentName}" is a near-miss of the target name and must not be reported as removed, got: ${JSON.stringify(r.reasons)}`,
    );
  });
}

test('removal check: a name found nowhere at all is still a confident removal', () => {
  const r = survivalCase('Company');
  assert.equal(r.verdict, 'semantic');
  assert.ok(r.reasons.some((msg) => msg.includes('no longer exists in current build')));
});

test('removal check: a truncated target name (at the MAX_TEXT cap) cannot support a confident removal', () => {
  // serialize.js caps name/text at MAX_TEXT (120 chars). A name landing
  // exactly on that cap may have been silently truncated, so failing to
  // find the truncated prefix elsewhere proves nothing about the real,
  // untruncated name - hedge instead of claiming removal.
  const truncatedName = 'S'.repeat(120);
  const before = snap(
    n('html', {}, [
      n('body', {}, [
        n('ul', { id: 'main-nav' }, [
          n('li', { classes: ['css-1a2b3c', 'nav-item'] }, [n('a', { text: 'Products', attrs: { href: '/products/' } })]),
          n('li', { classes: ['css-9z8y7x', 'nav-item'], name: truncatedName }, [
            n('a', { text: truncatedName, attrs: { href: '/x/' } }),
          ]),
        ]),
      ]),
    ]),
    [0, 0, 1],
  );
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('ul', { id: 'main-nav' }, [
          n('li', { classes: ['css-1a2b3c', 'nav-item'] }, [n('a', { text: 'Products', attrs: { href: '/products/' } })]),
          n('li', { classes: ['css-4d5e6f', 'nav-item'], name: 'Company' }, [n('a', { text: 'Company', attrs: { href: '/company/' } })]),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'li.css-9z8y7x');
  assert.equal(r.verdict, 'unclear');
  assert.ok(!r.reasons.some((msg) => msg.includes('no longer exists in current build')));
});

test('removal check: an inexact target name (nameInexact) cannot support a confident removal', () => {
  // nameInexact means accessibleName's textContent shortcut already
  // disagreed with the real accname algorithm at capture time (see
  // serialize.js#subtreeNameIsExact); searching for a name that might not
  // even be the element's real name cannot support a confident conclusion
  // either way, even when that exact string is nowhere in the current tree.
  const before = snap(
    n('html', {}, [
      n('body', {}, [
        n('ul', { id: 'main-nav' }, [
          n('li', { classes: ['css-1a2b3c', 'nav-item'] }, [n('a', { text: 'Products', attrs: { href: '/products/' } })]),
          n('li', { classes: ['css-9z8y7x', 'nav-item'], name: 'Solutions', nameInexact: true }, [
            n('a', { text: 'Solutions', attrs: { href: '/solutions/' } }),
          ]),
        ]),
      ]),
    ]),
    [0, 0, 1],
  );
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('ul', { id: 'main-nav' }, [
          n('li', { classes: ['css-1a2b3c', 'nav-item'] }, [n('a', { text: 'Products', attrs: { href: '/products/' } })]),
          n('li', { classes: ['css-4d5e6f', 'nav-item'], name: 'Company' }, [n('a', { text: 'Company', attrs: { href: '/company/' } })]),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, 'li.css-9z8y7x');
  assert.equal(r.verdict, 'unclear');
  assert.ok(!r.reasons.some((msg) => msg.includes('no longer exists in current build')));
});

test('ancestor id renamed, selector relies on it -> unclear', () => {
  const before = snap(baselineTree(), [0, 0, 0]);
  const after = snap(
    n('html', {}, [
      n('body', {}, [
        n('header', { id: 'page-header' }, [
          n('a', { id: 'cta', classes: ['btn', 'css-1a2b3c'], text: 'Contact us', attrs: { href: '/contact/' } }),
        ]),
      ]),
    ]),
    null,
  );
  const r = classifyDelta(before, after, '#site-header a');
  assert.equal(r.verdict, 'unclear');
});
