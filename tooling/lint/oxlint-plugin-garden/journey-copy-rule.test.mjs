// garden/no-copied-journey-function on planted journey folders: a spec function copied from another spec fires in both and
// says to move it into a helper; a copy of a helper's export names the import; a copy that differs only in comments,
// whitespace or `export` still fires; a different body, a one-line function, a copy outside the journey folder and a
// helper module do not. With GARDEN_TREE set (the lint ratchet), the copy is found in that tree, not beside the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = !existsSync(OXLINT) && 'no node_modules';
const RULE = 'garden(no-copied-journey-function)';
const D = 'apps/customer/tests/real-app';

/** Plants `files` in a tree, lints `lint` (default: every planted file); returns this rule's unix lines. */
function findings(files, { lint = Object.keys(files), tree } = {}) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-copy-'));
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    const env = { ...process.env };
    delete env.GARDEN_TREE;
    if (tree) env.GARDEN_TREE = tree;
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'unix', ...lint], { cwd: dir, encoding: 'utf8', env });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return out.split('\n').filter((l) => l.includes(RULE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const signIn = (extra = '') =>
  [
    "import { test } from '@playwright/test';",
    '',
    'async function signIn(page, email) {',
    "  await page.goto('/login');",
    "  await page.getByLabel('Email').fill(email);",
    "  await page.getByRole('button', { name: 'Continue' }).click();",
    '}',
    extra,
    "test('J-x #1', async ({ page }) => { await signIn(page, 'a@test.invalid'); });",
  ].join('\n');

test('a set-up function copied from another spec fires in both and says to move it into a helper', skip, () => {
  const out = findings({ [`${D}/J-a-01.pw.mjs`]: signIn(), [`${D}/J-b-01.pw.mjs`]: signIn() });
  assert.equal(out.length, 2, out.join('\n'));
  assert.ok(
    out.some((l) => l.startsWith(`${D}/J-a-01.pw.mjs:3:`) && l.includes('J-b-01.pw.mjs (signIn)')),
    out.join('\n'),
  );
  assert.ok(
    out.some((l) => l.startsWith(`${D}/J-b-01.pw.mjs:3:`) && l.includes('J-a-01.pw.mjs (signIn)')),
    out.join('\n'),
  );
  assert.ok(out[0].includes('`signIn` is a copy of a function in') && out[0].includes('move it into a journey helper module'), out[0]);
});

test("a copy of a helper's export names the import, even with a comment and other spacing, and no export", skip, () => {
  const helper = signIn().replace('async function signIn', 'export async function signIn');
  const copy = signIn().replace("  await page.goto('/login');", "  // open the sign-in page\n    await   page.goto('/login');");
  const out = findings({ [`${D}/session.mjs`]: helper, [`${D}/J-c-01.pw.mjs`]: copy });
  assert.equal(out.length, 1, out.join('\n'));
  assert.ok(out[0].startsWith(`${D}/J-c-01.pw.mjs:3:`), out[0]);
  assert.ok(out[0].includes("import { signIn } from './session.mjs' instead"), out[0]);
});

test('a different body, a one-line function, a copy outside the folder and the helper itself stay quiet', skip, () => {
  const other = signIn().replace("name: 'Continue'", "name: 'Sign in'");
  const oneLine = (n) => `function id${n}() { return 1; }\nfunction same() { return 2; }\n`;
  const out = findings({
    [`${D}/J-a-01.pw.mjs`]: signIn(),
    [`${D}/J-b-01.pw.mjs`]: other,
    [`${D}/J-d-01.pw.mjs`]: oneLine(1),
    [`${D}/J-e-01.pw.mjs`]: oneLine(2),
    [`apps/customer/tests/other/J-f-01.pw.mjs`]: signIn(),
    [`${D}/helper.mjs`]: signIn(),
  });
  // J-a-01 matches helper.mjs (an unexported copy, so no import to name); helper.mjs and the file outside are not judged.
  assert.equal(out.length, 1, out.join('\n'));
  assert.ok(out[0].startsWith(`${D}/J-a-01.pw.mjs:3:`) && out[0].includes('helper.mjs (signIn)'), out[0]);
  assert.ok(out[0].includes('move it into a journey helper module'), out[0]);
});

test('with GARDEN_TREE, a lone touched file is compared with the untouched files of that tree', skip, () => {
  const tree = mkdtempSync(join(tmpdir(), 'garden-tree-'));
  try {
    mkdirSync(join(tree, D), { recursive: true });
    writeFileSync(join(tree, D, 'J-a-01.pw.mjs'), signIn());
    const alone = { [`${D}/J-new-01.pw.mjs`]: signIn() };
    assert.equal(findings(alone).length, 0, 'beside nothing, nothing is a copy');
    const out = findings(alone, { tree });
    assert.equal(out.length, 1, out.join('\n'));
    assert.ok(out[0].startsWith(`${D}/J-new-01.pw.mjs:3:`) && out[0].includes('J-a-01.pw.mjs (signIn)'), out[0]);
    writeFileSync(join(tree, D, 'J-new-01.pw.mjs'), signIn());
    assert.equal(findings(alone, { tree }).length, 1, "the tree's own copy of the linted file is not a second file");
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});
