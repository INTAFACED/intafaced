// garden/no-stale-read on planted files, each a past mistake as it was written: it fires on the code before the fixes of
// J-cex-spot-07 #4 (a screen read once, #8722), J-wallet-04 #4 (a hand-made match after a reload, #8061),
// J-charts-desk-09 #1 (a wait kept across a reload, #7919) and J-merchant-07 (a wait raced against a reload), and names the
// fix; it stays quiet on the fixed code, on waits that end before a navigation, in navigation.mjs and outside the journeys.
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
const RULE = 'garden(no-stale-read)';

/** Each planted file's findings of this rule, as unix-format lines. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-stale-'));
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
const at = (out, file, line) => out.find((l) => l.startsWith(`${file}:${line}:`));
const HELPER_NAMED = 'apps/customer/tests/real-app/navigation.mjs';
const DIR = 'apps/customer/tests/real-app';

// J-cex-spot-07.pw.mjs armFromDesk before #8725 (#8722, and #8680 before it).
const CEX_SPOT_07_BEFORE = [
  'async function armFromDesk(page, box, seconds, owner) {',
  "  const button = box.getByRole('button', { name: /^(Turn on|Refresh now)$/ });",
  '  await button.click();',
  '  const note = box.getByText(ARMED);',
  '  const at = (await schedule(owner)).cancelsAt;',
  '  await expect(note).toHaveText(ARMED, { timeout: 15_000 });',
  '  expect((await note.innerText()).match(ARMED)[1]).toBe(await clock(page, at));',
  '  return at;',
  '}',
].join('\n');
// The same lines after #8725.
const CEX_SPOT_07_AFTER = CEX_SPOT_07_BEFORE.replace(
  '  expect((await note.innerText()).match(ARMED)[1]).toBe(await clock(page, at));',
  [
    '  const shown = await clock(page, at);',
    '  await expect.poll(async () => (await note.innerText()).match(ARMED)?.[1], { timeout: 15_000 }).toBe(shown);',
  ].join('\n'),
);

// navigation.mjs responseAfterNavigation before #8067 (#8061): the hand-made match, as a journey would copy it.
const WALLET_04_BEFORE = [
  'export async function bookOnReload(page, match, { navigate = () => page.reload(), read = (r) => r.json() } = {}) {',
  '  let navigated = false;',
  '  const committed = (frame) => {',
  '    if (frame === page.mainFrame()) navigated = true;',
  '  };',
  "  page.on('framenavigated', committed);",
  '  try {',
  '    const answer = page',
  '      .waitForResponse((r) => navigated && match(r))',
  '      .then(async (r) => ({ status: r.status(), body: await read(r) }));',
  '    const [res, doc] = await Promise.all([answer, navigate()]);',
  '    return { res, doc };',
  '  } finally {',
  "    page.off('framenavigated', committed);",
  '  }',
  '}',
].join('\n');

// J-charts-desk-09.pw.mjs #1 before #7922 (#7919).
const CHARTS_DESK_09_BEFORE = [
  "test('J-charts-desk-09 #1', async ({ page }) => {",
  "  const listed = page.waitForResponse((res) => /notify\\.alerts\\b/.test(res.url()) && res.request().method() === 'GET' && res.ok());",
  '  await page.reload();',
  "  const stored = alertNamed(await (await listed).json(), 'TEST breakout');",
  '});',
].join('\n');

// J-merchant-07.pw.mjs before this rule: the wait raced against the reload in one Promise.all.
const MERCHANT_07_BEFORE = [
  "test('J-merchant-07 #3', async ({ page }) => {",
  '  const [pageRead] = await Promise.all([',
  "    page.waitForResponse((res) => new URL(res.url()).pathname.includes('merchantMetrics.snapshot')),",
  '    page.reload(),',
  '  ]);',
  '});',
].join('\n');

// The one way, as the fixed files read now.
const ONE_WAY = [
  "import { answerAfterNavigation } from './navigation.mjs';",
  "test('J-x-01 #1', async ({ page }) => {",
  "  const listed = await answerAfterNavigation(page, (r) => r.url().includes('alerts'), () => page.reload());",
  "  const reads = page.waitForResponse((r) => r.url().includes('x'));",
  "  await page.getByRole('button', { name: 'Save', exact: true }).click();",
  '  await reads;',
  "  await page.goto('/x');",
  "  const awaited = await page.waitForResponse((r) => r.url().includes('y'));",
  '  await page.reload();',
  "  const [both] = await Promise.all([page.waitForResponse((r) => r.url().includes('z')), page.getByRole('button', { name: 'Go', exact: true }).click()]);",
  "  const label = await page.getByTestId('label').innerText();",
  "  await expect(page.getByTestId('label')).toHaveText('TEST');",
  '});',
].join('\n');

test('the past mistakes fire, each on its own line, and each message names its fix', skip, () => {
  const files = {
    [`${DIR}/J-cex-spot-07.pw.mjs`]: CEX_SPOT_07_BEFORE,
    [`${DIR}/withdraw-addresses.mjs`]: WALLET_04_BEFORE,
    [`${DIR}/J-charts-desk-09.pw.mjs`]: CHARTS_DESK_09_BEFORE,
    [`${DIR}/J-merchant-07.pw.mjs`]: MERCHANT_07_BEFORE,
  };
  const out = findings(files);
  assert.equal(out.length, 4, out.join('\n'));
  const screen = at(out, `${DIR}/J-cex-spot-07.pw.mjs`, 7);
  assert.ok(screen?.includes('reads the screen once') && screen.includes('expect.poll'), out.join('\n'));
  for (const [file, line, how] of [
    ['withdraw-addresses.mjs', 6, 'hand-made `framenavigated` match'],
    ['J-charts-desk-09.pw.mjs', 2, 'kept across'],
    ['J-merchant-07.pw.mjs', 3, 'raced against'],
  ]) {
    const hit = at(out, `${DIR}/${file}`, line);
    assert.ok(
      hit?.includes(how) && hit.includes('answerAfterNavigation') && hit.includes(HELPER_NAMED),
      `${file}:${line}\n${out.join('\n')}`,
    );
  }
});

test('the fixed code, waits that end before a navigation and plain reads pass', skip, () => {
  assert.deepEqual(findings({ [`${DIR}/J-cex-spot-07.pw.mjs`]: CEX_SPOT_07_AFTER, [`${DIR}/J-x-01.pw.mjs`]: ONE_WAY }), []);
});

test('navigation.mjs may hold the shapes, and files outside the journeys are not judged', skip, () => {
  assert.deepEqual(
    findings({
      [HELPER_NAMED]: WALLET_04_BEFORE,
      'apps/customer/src/x.test.mjs': `${CHARTS_DESK_09_BEFORE}\n${CEX_SPOT_07_BEFORE}`,
    }),
    [],
  );
});

test('a copy of the real navigation.mjs outside its own file is refused', skip, () => {
  const helper = readFileSync(join(ROOT, HELPER_NAMED), 'utf8');
  assert.match(helper, /page\.on\('framenavigated'/);
  assert.equal(findings({ [`${DIR}/copied.mjs`]: helper }).length > 0, true, 'a copy of the helper outside its file is refused');
});
