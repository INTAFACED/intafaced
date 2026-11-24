// garden/count-zero-needs-shown on planted journey files: a count of 0 right after a navigation fires and names absentIn;
// one after a shown check, an action, a toPass that shows, a helper of the file, or absentIn itself does not.
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
const RULE = 'garden(count-zero-needs-shown)';

/** Each planted file's findings of this rule, as `file:line`. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-absent-'));
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'unix', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return out.split('\n').filter((l) => l.includes(RULE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const J = 'apps/customer/tests/real-app/J-x-01.pw.mjs';

const step = (...lines) => ["test('J-x-01 #3', async ({ page }) => {", ...lines.map((l) => `  ${l}`), '});'].join('\n');

test('a count of 0 right after goto or reload fires and names absentIn', skip, () => {
  const out = findings({
    [J]: step(
      "await page.goto('/campaigns/1');",
      "await expect(page.getByTestId('campaign-budget-left')).toHaveCount(0);",
      "await expect(page.getByTestId('campaign-detail')).toBeVisible();",
      'await page.reload();',
      "if (x) { await expect(page.getByTestId('row')).toHaveCount(0); }",
    ),
  });
  assert.deepEqual(
    out.map((l) => l.split(':')[1]),
    ['3', '6'],
    out.join('\n'),
  );
  assert.ok(out[0].includes('absentIn(container, locator)'), out[0]);
});

test('a count of 0 after something shown, an action, a toPass, a helper, or with no navigation passes', skip, () => {
  const out = findings({
    [J]: step(
      "await page.goto('/campaigns/1');",
      "await expect(page.getByTestId('campaign-detail')).toBeVisible();",
      "await expect(page.getByTestId('campaign-budget-left')).toHaveCount(0);",
      'await page.reload();',
      "await dialog.getByRole('button', { name: 'Save' }).click();",
      'await expect(dialog).toHaveCount(0);',
      'await page.reload();',
      "await expect(async () => { await expect(page.getByRole('heading')).toBeVisible(); }).toPass();",
      "await expect(page.getByTestId('x')).toHaveCount(0);",
      'await page.reload();',
      'await openRoom(page);',
      "await expect(page.getByTestId('y')).toHaveCount(0);",
      'await page.reload();',
      "await absentIn(page.getByTestId('detail'), '[data-testid=\"budget\"]');",
      "await expect(page.getByTestId('z')).toHaveCount(2);",
    ),
    'apps/customer/tests/real-app/J-x-02.pw.mjs':
      "test('J-x-02 #1', async ({ page }) => {\n  await expect(page.getByTestId('a')).toHaveCount(0);\n});\n",
    'apps/customer/src/x.test.ts': "await page.goto('/');\nawait expect(page.getByTestId('a')).toHaveCount(0);\n",
  });
  assert.deepEqual(out, []);
});
