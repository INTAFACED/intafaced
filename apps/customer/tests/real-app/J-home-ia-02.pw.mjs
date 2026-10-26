import { test, expect } from '@playwright/test';
import { signIn, signUp } from './desk.mjs';
import { ORIGIN } from './stack.mjs';

// J-home-ia-02, in the running app (docs/roadmap/journeys.json): I find any room I need. Tests titled "J-home-ia-02 #<n>"
// prove a whole step. One TEST person, signed up once; the signed-out step uses a fresh browser.
const J = 'J-home-ia-02';

test.describe.configure({ mode: 'serial' });

let who;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await browser.newPage();
  who = await signUp(page, 'nav');
  await page.close();
});

const mainNav = (page) => page.getByRole('navigation', { name: 'Main navigation' });

/** The rows of one top-bar door's dropdown, as { href, group } (group is the Advanced heading when the row sits under it). */
async function dropdown(page, door) {
  const item = mainNav(page)
    .getByTestId('tb-item')
    .filter({ has: page.locator('[data-testid="tb-tab"]', { hasText: new RegExp(`^${door}$`) }) });
  await item.hover();
  const menu = item.getByRole('group', { name: door });
  await expect(menu).toBeVisible();
  return menu
    .locator('a')
    .evaluateAll((links) =>
      links.map((link) => ({ href: link.getAttribute('href'), advanced: Boolean(link.closest('ul[aria-label="Advanced"]')) })),
    );
}

/** Type into the header search and return its open results panel. */
async function search(page, words) {
  const box = page.getByRole('combobox', { name: 'Search markets' });
  await box.fill(words);
  const panel = page.getByTestId('tb-search-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** Pick Simple or Pro in Settings (a choice kept on this device). */
async function chooseLayout(page, mode) {
  await page.goto('/view');
  const option = page.getByRole('group', { name: 'Default view' }).getByRole('button', { name: mode, exact: true });
  await option.click();
  await expect(option).toHaveAttribute('aria-pressed', 'true');
  await page.goto('/home');
}

test(`${J} #1 the top bar has five doors with full dropdowns, the same five on the phone bar; /bank is its own room; Simple groups Advanced, Pro lists every row`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page, who);
  await chooseLayout(page, 'Pro');
  // Five doors (owner decision 2026-10-26, "One Money door"): Assets and Bank are one Money door.
  await expect(mainNav(page).getByTestId('tb-tab')).toHaveText(['Home', 'Money', 'Trade', 'Pay', 'More']);

  // Every door's rows open live rooms; Money holds the holdings and the bank's rooms alike.
  const money = await dropdown(page, 'Money');
  expect(money[0].href).toBe('/money');
  expect(money.map((row) => row.href)).toEqual(
    expect.arrayContaining(['/uc/recharge', '/uc/withdraw', '/bank/spaces', '/bank/earn', '/bank/loans', '/bank/cards']),
  );
  for (const door of ['Pay', 'More']) expect((await dropdown(page, door)).length).toBeGreaterThan(2);

  // Pro: every Trade row is listed flat.
  const pro = await dropdown(page, 'Trade');
  expect(pro.some((row) => row.advanced)).toBe(false);
  expect(pro.map((row) => row.href)).toEqual(expect.arrayContaining(['/trade/futures', '/trade/options', '/quant']));

  // /bank opens the Bank's own overview and stays there.
  await page.goto('/bank');
  await expect(page).toHaveURL(/\/bank$/);
  await expect(page.locator('main h1').first()).toHaveText('Bank');

  // Simple: the same rows, the advanced ones under their own heading; each is still reachable by address and by search.
  await chooseLayout(page, 'Simple');
  const simple = await dropdown(page, 'Trade');
  expect(simple.map((row) => row.href).sort()).toEqual(pro.map((row) => row.href).sort());
  const advanced = simple.filter((row) => row.advanced).map((row) => row.href);
  expect(advanced).toEqual(expect.arrayContaining(['/trade/futures', '/trade/options']));
  await page.goto('/trade/futures');
  await expect(page).toHaveURL(/\/trade\/futures/);
  await expect(page.locator('main')).not.toBeEmpty();
  await page.goto('/home');
  const panel = await search(page, 'futures');
  await expect(panel.getByRole('option', { name: /Futures/ }).first()).toBeVisible();
  // Simple: Money's rarely used rows sit under Advanced too.
  const moneySimple = await dropdown(page, 'Money');
  expect(moneySimple.filter((row) => row.advanced).map((row) => row.href)).toEqual(expect.arrayContaining(['/money/pnl', '/bank/ramps']));

  // On a phone the same five doors sit in the bottom bar, in the same order, More included.
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneBar = page.getByRole('navigation', { name: 'Customer doors on phone' });
  await expect(phoneBar.getByRole('link')).toHaveText(['Home', 'Money', 'Trade', 'Pay', 'More']);
  await phoneBar.getByRole('link', { name: 'More' }).click();
  await expect(page).toHaveURL(/\/more$/);
});

test(`${J} #2 More and All services list every room from the one route table, with the Web3 rooms and their blockers`, async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, who);
  await page.goto('/more');
  const main = page.locator('main');
  // The Web3 section: DEX, Chain and Protocol, each saying what it is and what blocks it.
  for (const [href, name] of [
    ['/dex', 'DEX'],
    ['/chain', 'Chain'],
    ['/protocol', 'Protocol'],
  ]) {
    const tile = main.locator(`a[href="${href}"]`).first();
    await expect(tile).toBeVisible();
    await expect(tile).toContainText(name);
  }
  // All services: a row for each room in the route table, by area; the Web3 rooms are named as rooms, not route slugs.
  const all = main.getByRole('heading', { name: 'All services' });
  await expect(all).toBeVisible();
  for (const name of ['Earn', 'Loans', 'Futures', 'Send globally', 'Merchant home', 'Academy', 'Chain', 'DEX', 'Protocol', 'Help centre'])
    await expect(main.getByRole('link', { name, exact: true }).first()).toBeVisible();
  await expect(main.getByRole('link', { name: 'chain', exact: true })).toHaveCount(0);

  // Every tile opens its room.
  await main.locator('a[href="/chain"]').first().click();
  await expect(page).toHaveURL(/\/chain$/);
  // The room is all there with honest labels: it never calls Base INTACHAIN and says what it cannot show, never "coming soon".
  await expect(page.locator('main h1')).toHaveText('Chain');
  await expect(page.locator('main')).toContainText('Not INTACHAIN · not audited');
  await expect(page.locator('main')).not.toContainText(/coming soon/i);
});

test(`${J} #3 typing "earn" in the header search shows Money > Earn, and Enter opens it`, async ({ page }) => {
  await signIn(page, who);
  await page.goto('/home');
  const panel = await search(page, 'earn');
  const row = panel.getByRole('option').filter({ hasText: 'Money > Earn' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Earn');
  // The first page row is Earn; Enter opens the active row.
  await expect(panel.getByRole('option').first()).toContainText('Earn');
  await page.getByRole('combobox', { name: 'Search markets' }).press('Enter');
  await expect(page).toHaveURL(/\/bank\/earn/);
});

test(`${J} #4 typing "chain" lists the parked room and says it opens to its blockers`, async ({ page }) => {
  await signIn(page, who);
  await page.goto('/home');
  const panel = await search(page, 'chain');
  const row = panel.getByRole('option').filter({ hasText: 'More > Chain' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Opens to its blockers');
  await row.click();
  await expect(page).toHaveURL(/\/chain$/);
});

test(`${J} #8 a deep link while signed out: public rooms open, private rooms ask to sign in and come back to the same room`, async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  // Public rooms open as they are.
  for (const path of ['/help', '/trade']) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByText('Sign in to continue')).toHaveCount(0);
  }
  // A private room, with its query, asks to sign in and then opens exactly that room.
  const target = '/money?asset=BTC';
  await page.goto(target);
  await expect(page.getByText('Sign in to continue')).toBeVisible();
  await page.locator('main').getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(new RegExp(`${target.replace('?', '\\?')}$`));
  await expect(page.getByText('Sign in to continue')).toHaveCount(0);
  await context.close();
});
