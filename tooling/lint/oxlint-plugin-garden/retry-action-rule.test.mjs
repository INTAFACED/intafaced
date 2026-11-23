// garden/no-action-in-retry on planted Playwright files: a press inside toPass or expect.poll fires and names the settled
// state to wait for; one wait then one press, a retried check with no press, and a vitest file do not.
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
const RULE = 'garden(no-action-in-retry)';

/** Each planted file's findings of this rule, as oxlint's unix lines. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-retry-'));
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

test('the copied Connect loop, in toPass and in expect.poll, fires and names the settled state', skip, () => {
  const out = findings({
    [J]: [
      "test('J-x-01 #2', async ({ page }) => {",
      '  await expect(async () => {',
      '    if (await address.isVisible()) return;',
      '    await connect.click({ timeout: 2_000 });',
      '    await expect(address).toBeVisible({ timeout: 5_000 });',
      '  }).toPass({ timeout: 30_000 });',
      '  await expect',
      '    .poll(',
      '      async () => {',
      '        if (await connected.isVisible().catch(() => false)) return true;',
      '        if (await connect.isVisible().catch(() => false)) await connect.click({ timeout: 2_000 }).catch(() => undefined);',
      '        return false;',
      '      },',
      '      { timeout: 30_000, intervals: [500] },',
      '    )',
      '    .toBe(true);',
      "  await expect(async () => { await page.getByLabel('Amount').fill('1'); }).toPass();",
      '});',
    ].join('\n'),
  });
  assert.equal(out.length, 3, out.join('\n'));
  assert.ok(out[0].startsWith(`${J}:4:`), out[0]);
  assert.ok(out[0].includes('click inside toPass'), out[0]);
  assert.ok(out[0].includes('Connect button or the connected address (connectWhenAsked'), out[0]);
  assert.ok(out[1].startsWith(`${J}:11:`) && out[1].includes('click inside expect.poll'), out[1]);
  assert.ok(out[2].startsWith(`${J}:17:`) && out[2].includes('fill inside toPass'), out[2]);
});

test('one wait for the settled state then one press, a retried check with no press, and other files pass', skip, () => {
  const clean = [
    "test('J-x-01 #2', async ({ page }) => {",
    '  await expect(connect.or(connected).first()).toBeVisible({ timeout: 30_000 });',
    '  if (!(await connected.isVisible())) await connect.click();',
    '  await expect(async () => {',
    '    expect(await read()).toBe(1);',
    '  }).toPass();',
    '  await expect.poll(async () => (await rows.count()) > 0).toBe(true);',
    '  const press = async () => connect.click();',
    '  await expect(async () => press).toPass();',
    '});',
  ].join('\n');
  const vitest = 'await expect.poll(async () => { await button.click(); return 1; }).toBe(1);\n';
  assert.deepEqual(findings({ [J]: clean, 'apps/customer/src/x.test.ts': vitest }), []);
});
