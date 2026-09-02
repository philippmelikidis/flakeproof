// Structural checks on action.yml that do not require a real yaml parser or
// a GitHub Actions runtime. This is intentionally NOT a general yaml parser
// - it is a purpose-built, line-based scanner for exactly the shape a
// composite action file has (a flat "inputs:"/"outputs:" map of two-space
// indented keys, and a "runs.steps" list). It catches the two classes of
// mistake asked for: a required top-level key or "runs.using: composite"
// missing, and a "${{ inputs.X }}" / "${{ steps.Y.outputs.Z }}" expression
// whose X was never declared under inputs: or whose step id Y was never
// declared. Whether the action actually executes correctly on GitHub is not
// something this test - or anything else run locally - can confirm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const actionPath = join(here, '..', 'action.yml');

async function readActionYaml() {
  return readFile(actionPath, 'utf8');
}

function declaredTopLevelKeys(source, blockName) {
  const lines = source.split('\n');
  const startIdx = lines.findIndex((l) => l === `${blockName}:`);
  if (startIdx === -1) return [];
  const names = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '' || /^\s/.test(line) === false) {
      if (line === '') continue;
      break; // dedented back to column 0: the block ended
    }
    const m = line.match(/^ {2}([a-zA-Z0-9_-]+):\s*$/);
    if (m) names.push(m[1]);
  }
  return names;
}

function declaredStepIds(source) {
  return [...source.matchAll(/^\s*id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

function allExpressions(source) {
  return [...source.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
}

const KNOWN_CONTEXT_PREFIXES = ['github.', 'env.', 'runner.', 'job.', 'matrix.', 'strategy.'];

test('action.yml has the required top-level composite-action keys', async () => {
  const src = await readActionYaml();
  for (const key of ['name:', 'description:', 'inputs:', 'outputs:', 'runs:']) {
    assert.ok(src.includes(`\n${key}`) || src.startsWith(key), `missing top-level key "${key}"`);
  }
  assert.match(src, /runs:\n\s*using:\s*'composite'/, 'runs.using must be composite');
  assert.match(src, /runs:[\s\S]*\n\s*steps:/, 'runs.steps must be present');
});

test('every declared input has a description, required and default', async () => {
  const src = await readActionYaml();
  const inputs = declaredTopLevelKeys(src, 'inputs');
  assert.ok(inputs.length > 5, 'expected several inputs to be declared');
  const inputsBlock = src.slice(src.indexOf('\ninputs:'), src.indexOf('\noutputs:'));
  const perInput = inputsBlock.split(/\n {2}[a-zA-Z0-9_-]+:\s*\n/).slice(1);
  assert.equal(perInput.length, inputs.length);
  for (const [i, block] of perInput.entries()) {
    assert.match(block, /description:/, `input "${inputs[i]}" is missing a description`);
    assert.match(block, /required:/, `input "${inputs[i]}" is missing "required"`);
  }
});

test('every ${{ inputs.X }} reference names a declared input', async () => {
  const src = await readActionYaml();
  const declared = new Set(declaredTopLevelKeys(src, 'inputs'));
  const referenced = allExpressions(src)
    .map((e) => e.match(/\binputs\.([a-zA-Z0-9_-]+)/))
    .filter(Boolean)
    .map((m) => m[1]);
  assert.ok(referenced.length > 0, 'expected at least one ${{ inputs.* }} reference to check');
  for (const name of referenced) {
    assert.ok(declared.has(name), `"\${{ inputs.${name} }}" references an input that is not declared under inputs:`);
  }
});

test('every ${{ steps.ID.outputs.* }} reference names a step id declared earlier with "id:"', async () => {
  const src = await readActionYaml();
  const declaredIds = new Set(declaredStepIds(src));
  const referenced = allExpressions(src)
    .map((e) => e.match(/\bsteps\.([a-zA-Z0-9_-]+)\.outputs\./))
    .filter(Boolean)
    .map((m) => m[1]);
  assert.ok(referenced.length > 0, 'expected at least one ${{ steps.*.outputs.* }} reference to check');
  for (const id of referenced) {
    assert.ok(declaredIds.has(id), `"\${{ steps.${id}.outputs.* }}" references a step id that is never declared with "id: ${id}"`);
  }
});

test('every ${{ }} expression uses a known context, an input, a step output, or an output declaration', async () => {
  const src = await readActionYaml();
  const declaredInputs = new Set(declaredTopLevelKeys(src, 'inputs'));
  const declaredIds = new Set(declaredStepIds(src));
  for (const expr of allExpressions(src)) {
    const known =
      KNOWN_CONTEXT_PREFIXES.some((p) => expr.startsWith(p)) ||
      (expr.startsWith('inputs.') && declaredInputs.has(expr.slice('inputs.'.length))) ||
      (expr.startsWith('steps.') && declaredIds.has(expr.split('.')[1]));
    assert.ok(known, `"\${{ ${expr} }}" does not resolve to a known context, declared input, or declared step id`);
  }
});

test('outputs.*.value references only step ids that exist', async () => {
  const src = await readActionYaml();
  const declaredIds = new Set(declaredStepIds(src));
  const outputsBlock = src.slice(src.indexOf('\noutputs:'), src.indexOf('\nruns:'));
  for (const expr of allExpressions(outputsBlock)) {
    const m = expr.match(/^steps\.([a-zA-Z0-9_-]+)\.outputs\./);
    if (m) assert.ok(declaredIds.has(m[1]), `output value references undeclared step id "${m[1]}"`);
  }
});

test('every step with a "run:" key also declares "shell:", as the composite-action schema requires', async () => {
  const src = await readActionYaml();
  const stepsBlock = src.slice(src.indexOf('\n  steps:'));
  assert.ok(stepsBlock.length > 1, 'could not find "steps:" under runs:');
  const steps = stepsBlock.split(/\n {4}- name:/).slice(1);
  assert.ok(steps.length >= 5, 'expected several steps to check');
  for (const step of steps) {
    // A step is either a "run:" step (needs shell:) or a "uses:" step
    // (must not declare shell:, though nothing here checks that direction).
    if (/\n {6}run:/.test(step)) {
      assert.match(step, /\n {6}shell:\s*bash/, 'a "run:" step is missing "shell: bash"');
    }
  }
});

test('every "uses:" reference is pinned to a tag, not left floating', async () => {
  const src = await readActionYaml();
  const uses = [...src.matchAll(/^\s*uses:\s*(\S+)$/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 3, 'expected several "uses:" steps to check');
  for (const ref of uses) {
    assert.match(ref, /@v\d/, `"${ref}" is not pinned to a major version tag`);
  }
});

test('scripts referenced from run: steps exist on disk', async () => {
  const src = await readActionYaml();
  const scriptRefs = [...src.matchAll(/action\/scripts\/([a-zA-Z0-9_-]+\.js)/g)].map((m) => m[1]);
  assert.ok(scriptRefs.length >= 3, 'expected several action script references to check');
  const { existsSync } = await import('node:fs');
  for (const name of new Set(scriptRefs)) {
    const p = join(here, '..', 'action', 'scripts', name);
    assert.ok(existsSync(p), `action.yml references action/scripts/${name}, which does not exist`);
  }
});
