// garden/no-deep-entry on planted journey files: a `goto` of a detail route, an alias, a business page or a path built
// from values is refused and names the fix; the front page, Home, a menu row, a listed room, an emailed-link room,
// another app's address and the crawl itself are quiet. That the list matches the app: tooling/lint/deep-entries.test.mjs.
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
const RULE = 'garden(no-deep-entry)';
const DIR = 'apps/customer/tests/real-app';

function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-entry-'));
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

const journey = [
  "await page.goto('/trade/copy/abc');", // 1: a detail route
  "await page.goto('/exchange');", // 2: an alias
  'await page.goto(`/trade/spot/${pair}`);', // 3: built from values
  "await page.goto('/pay/onboarding/business');", // 4: a business page
  "await page.goto('/');",
  "await page.goto('/home');",
  "await page.goto('/money/activity?tab=orders');", // a menu row, with its query
  "await page.goto('/trade/spot/BTC-USDT');", // the Spot menu row
  "await page.goto('/wallet');", // listed in All services
  "await page.goto('/login');",
  "await page.goto('/completePasswordReset');", // an emailed link's room
  'await page.goto(stackUrl("admin"));', // another app
  "await page.goto('https://example.test/x');",
].join('\n');

test('refuses a deep entry and names the fix; quiet on the doors, the menus, the listed rooms and other apps', { skip }, () => {
  const out = findings({ [`${DIR}/J-x-01.pw.mjs`]: journey });
  assert.deepEqual(
    out.map((l) => Number(l.split(':')[1])),
    [1, 2, 3, 4],
    out.join('\n'),
  );
  assert.match(out[0], /goto\('\/trade\/copy\/abc'\)/);
  assert.match(out[0], /then click to the screen/);
  assert.match(out[2], /built from values/);
});

test('quiet outside the journeys and in the crawl', { skip }, () => {
  const text = "await page.goto('/trade/copy/abc');";
  assert.deepEqual(findings({ 'apps/customer/src/x.mjs': text, [`${DIR}/menu-reach.pw.mjs`]: text }), []);
});
