// garden/step-picture-before-leaving on planted files: the step tests whose end picture showed the page they went on to
// (J-algo-dev-15 #3 and #5, J-derivatives-01 #7, J-portfolio-01 #1, as main had them before this rule) fire and name
// `stepPicture()`; the same tests with the picture taken at the state pass, and so do a test that checks the screen it
// went to (itself or through a helper), a download link, and a test whose last action stays on the screen.
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
const RULE = 'garden(step-picture-before-leaving)';

/** Each planted file's findings of this rule, as oxlint's unix lines. */
function findings(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-step-picture-'));
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
const at = (name) => `apps/customer/tests/real-app/${name}.pw.mjs`;
const lines = (...l) => l.join('\n');
const HEAD = "import { test, expect } from './journey.mjs';";

// J-algo-dev-15 #3 before this rule: the refusal checked, then the sandbox link clicked, its URL and heading checked.
const ALGO_15_3 = (picture) =>
  lines(
    HEAD,
    'test(`J-algo-dev-15 #3 presses Compile`, async ({ page, stepPicture }) => {',
    "  await page.goto('/quant/editor');",
    "  await expect(page.getByTestId('compile-result')).toHaveCount(0);",
    picture ? '  await stepPicture();' : '',
    "  await page.getByRole('link', { name: 'Open the working sandbox' }).click();",
    '  await expect(page).toHaveURL(/\\/quant$/);',
    "  await expect(page.getByRole('heading', { name: 'Algo dev', level: 1 })).toBeVisible();",
    '});',
  );
// J-algo-dev-15 #5 (planted after #3 in one file): the refusal checked inside a helper, then the backtest link.
const ALGO_15_5 = lines(
  'test(`J-algo-dev-15 #5 presses Start`, async ({ page }) => {',
  "  await refused(page, page.getByRole('button', { name: 'Start' }), { room: 'tester' });",
  "  await page.getByRole('link', { name: 'Run a real backtest' }).click();",
  '  await expect(page).toHaveURL(/\\/quant\\/backtest$/);',
  '});',
);
// J-derivatives-01 #7: the menu of types not offered checked, then closed.
const DERIV_7 = lines(
  HEAD,
  'test(`J-derivatives-01 #7 looks at the order types`, async ({ page }) => {',
  "  await page.getByRole('button', { name: 'Order types not offered' }).click();",
  "  const menu = page.getByRole('menu');",
  '  await expect(menu).toBeVisible();',
  "  await page.keyboard.press('Escape');",
  '  expect(sent).toEqual([]);',
  '});',
);
// J-portfolio-01 #1: the quick actions checked, then "Fund your venue account" followed, and the ledger read by API.
const PORTFOLIO_1 = lines(
  HEAD,
  'test(`J-portfolio-01 #1 opens /money`, async ({ page }) => {',
  "  const actions = page.getByTestId('assets-actions');",
  "  await expect(actions.locator('a').first()).toHaveAttribute('href', '/trade');",
  "  await actions.locator('a').filter({ hasText: /^Fund your venue account$/ }).click();",
  '  await expect(page).toHaveURL(/\\/wallet\\/venue$/);',
  '  expect(await (await api(who)).balances()).toEqual(ledgerStart);',
  '});',
);

test('the four past steps fire, each naming stepPicture() and the fixture file', skip, () => {
  const got = findings({
    [at('J-algo-dev-15')]: `${ALGO_15_3(false)}\n${ALGO_15_5}`,
    [at('J-derivatives-01')]: DERIV_7,
    [at('J-portfolio-01-venue')]: PORTFOLIO_1,
  });
  assert.equal(got.length, 4, got.join('\n'));
  for (const [file, line, how] of [
    ['J-algo-dev-15', 6, 'a click on a link'],
    ['J-algo-dev-15', 12, 'a click on a link'],
    ['J-derivatives-01', 6, 'pressing Escape'],
    ['J-portfolio-01-venue', 5, 'a click on a link'],
  ]) {
    const f = got.find((l) => l.startsWith(`${at(file)}:${line}:`));
    assert.ok(f, `${file}:${line} in\n${got.join('\n')}`);
    assert.ok(f.includes(`last action, ${how}, leaves the screen it checked`), f);
    assert.ok(f.includes('`await stepPicture()` before this line (apps/customer/tests/real-app/journey.mjs)'), f);
  }
});

test('with the picture taken at the state it passes', skip, () => {
  assert.deepEqual(findings({ [at('J-algo-dev-15')]: ALGO_15_3(true) }), []);
});

test('a test that checks the screen it went to passes, itself or through a helper handed the page', skip, () => {
  const checks = lines(
    HEAD,
    'test(`J-x-01 #1 opens the pool`, async ({ page }) => {',
    "  await expect(page.getByTestId('pools')).toBeVisible();",
    "  await page.getByRole('link', { name: 'Open pool' }).click();",
    "  await expect(page.getByTestId('earn-rate-history')).toHaveAttribute('data-steps', '3');",
    '});',
    'test(`J-x-01 #2 opens the editor from the menu`, async ({ page }) => {',
    "  await page.getByTestId('tb-menu').getByRole('link', { name: /Algo editor/ }).click();",
    '  await editorRoom(page);',
    '});',
  );
  assert.deepEqual(findings({ [at('J-x-01')]: checks }), []);
});

test('a download link, a goto, and a last action that stays on the screen pass', skip, () => {
  const stays = lines(
    HEAD,
    'test(`J-x-02 #1 downloads the report`, async ({ page }) => {',
    "  await expect(page.getByRole('table')).toBeVisible();",
    "  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download' }).click()]);",
    "  expect(file.suggestedFilename()).toBe('r.csv');",
    '});',
    'test(`J-x-02 #2 comes back to the link`, async ({ page }) => {',
    "  await expect(page.getByLabel('Your link')).toHaveValue('x');",
    "  await page.goto('/waitlist?code=1');",
    "  await expect(page.getByRole('heading', { name: 'Your place' })).toBeVisible();",
    '});',
    'test(`J-x-02 #3 presses Pause`, async ({ page }) => {',
    "  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();",
    "  await page.getByRole('button', { name: 'Pause' }).click();",
    '});',
  );
  assert.deepEqual(findings({ [at('J-x-02')]: stays }), []);
});

test('a file outside the journeys is not judged', skip, () => {
  assert.deepEqual(findings({ 'apps/customer/src/x.test.mjs': ALGO_15_3(false) }), []);
});

// [no-page]: J-agents-21 #4 as main has it: an API call and its refusal, with no page and no picture.
const AGENTS_21_4 = (fixtures, extra = '') =>
  lines(
    HEAD,
    "const J = 'J-agents-21';",
    `test(\`\${J} #4 Funds 100 more: refused agents.account_cap_exceeded; nothing moves\`, async (${fixtures}) => {`,
    '  const { session } = await person();',
    "  const res = refused(await session.post(`${BASE}/a/fund`, { amount: '100' }), 422, 'agents.account_cap_exceeded');",
    "  expect(res.message).toContain('50 USDC of room');",
    extra,
    '});',
  );

test('a step test with no page and no stepPicture fires [no-page], naming the fix', skip, () => {
  const got = findings({
    [at('J-agents-21')]: AGENTS_21_4(''),
    [at('J-x-03')]: lines(HEAD, "test('J-x-03 #2 reads the list by API', async () => {", '  expect(await list()).toEqual([]);', '});'),
  });
  assert.equal(got.length, 2, got.join('\n'));
  const f = got.find((l) => l.startsWith(`${at('J-agents-21')}:3:`));
  assert.ok(f, got.join('\n'));
  assert.ok(f.includes("[no-page] this step's test takes no page and never calls `stepPicture`"), f);
  assert.ok(f.includes('`await stepPicture()` once that screen is checked'), f);
  assert.ok(
    got.some((l) => l.startsWith(`${at('J-x-03')}:2:`)),
    got.join('\n'),
  );
});

test('a step test taking a page, or calling stepPicture on a page it got elsewhere, passes', skip, () => {
  const ok = {
    [at('J-agents-21')]: AGENTS_21_4('{ page }', "  await expect(page.getByText('50 USDC of room')).toBeVisible();"),
    [at('J-x-04')]: AGENTS_21_4('{ stepPicture }', '  const otherPage = await openAs(who);\n  await stepPicture(otherPage);'),
    [at('J-x-05')]: AGENTS_21_4('{ browser }', '  const p = await (await browser.newContext()).newPage();\n  await p.goto("/agents");'),
  };
  assert.deepEqual(findings(ok), []);
});

test('a setup test, and a file whose steps share one page opened in a hook, are not judged by [no-page]', skip, () => {
  const setup = lines(HEAD, 'test(`${J} starts: a verified TEST account`, async () => {', '  await seed();', '});');
  const shared = lines(
    HEAD,
    'let page;',
    'test.beforeAll(async ({ browser }) => {',
    '  page = await (await browser.newContext()).newPage();',
    '});',
    "const notes = () => page.getByTestId('notes');",
    'test(`${J} #2 turns on push: the notice names it`, async () => {',
    "  await expect(notes()).toContainText('push');",
    '});',
  );
  assert.deepEqual(findings({ [at('J-x-06')]: setup, [at('J-x-07')]: shared }), []);
});
