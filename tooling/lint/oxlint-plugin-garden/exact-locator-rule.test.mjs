// garden/exact-locator on planted files: a locator named by a plain string fires and names `{ exact: true }`; an exact
// name, a regex, an explicit `exact: false`, options held in a variable and a file outside the journeys do not.
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
const RULE = 'garden(exact-locator)';

/** Each planted file's findings of this rule, as unix-format lines. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-exact-'));
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
const HELPER = 'apps/customer/tests/real-app/desk.mjs';

test('a locator named by a plain string fires, in a journey and in its helpers, and names the fix', skip, () => {
  const out = findings({
    [J]: [
      "test('J-x-01 #5', async ({ page }) => {",
      "  await form.getByLabel('Why').fill('TEST: a launch week');",
      "  await expect(page.getByRole('region', { name: 'Ticket', exact: true }).getByRole('region', { name: 'Customer' })).toBeVisible();",
      '  await page.getByText(`Paid ${amount} USDT`).click();',
      "  await page.getByPlaceholder('Search').fill('x');",
      '});',
    ].join('\n'),
    [HELPER]: "export const buy = (page) => page.getByRole('button', { name: 'Buy BTC' });\n",
  });
  assert.equal(out.length, 5, out.join('\n'));
  const why = out.find((l) => l.startsWith(`${J}:2:`));
  assert.ok(why?.includes("`getByLabel('Why')`") && why.includes('add `{ exact: true }`'), out.join('\n'));
  assert.ok(
    out.some((l) => l.startsWith(`${J}:3:`) && l.includes("{ name: 'Customer' }")),
    out.join('\n'),
  );
  assert.ok(
    out.some((l) => l.startsWith(`${HELPER}:1:`)),
    out.join('\n'),
  );
});

test('an exact name, a regex, an explicit exact: false, variable options and files outside the journeys pass', skip, () => {
  const clean = [
    "test('J-x-01 #5', async ({ page }) => {",
    "  await form.getByLabel('Why', { exact: true }).fill('TEST');",
    "  await page.getByRole('region', { name: 'Customer', exact: true });",
    "  await page.getByRole('button', { name: /^Buy / });",
    '  await page.getByText(/Order filled/);',
    "  await page.getByText('Order filled', { exact: false });",
    "  await page.getByRole('button', opts);",
    "  await page.getByRole('main');",
    "  await page.getByTestId('customer-card');",
    '  await page.getByLabel(label, { exact: true });',
    '});',
  ].join('\n');
  const out = findings({
    [J]: clean,
    'apps/customer/src/screens/x.tsx': "export const f = (s) => s.getByLabel('Why');\n",
    'apps/customer/tests/unit/x.test.mjs': "screen.getByLabel('Why');\n",
  });
  assert.deepEqual(out, []);
});
