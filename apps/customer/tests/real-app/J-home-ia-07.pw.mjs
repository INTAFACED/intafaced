import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { signIn, signUp, verify } from './desk.mjs';
import { api, ORIGIN } from './stack.mjs';

// J-home-ia-07, in the running app (docs/roadmap/journeys.json): I switch between personal and business, and use my account
// menu. One test per step, titled "J-home-ia-07 #<n>", run in order. Two TEST people: an owner who opens a TEST business
// account at the bank (svc-bank `business.create`), and the person on the journey, verified, who starts with no business, is added
// to it as a viewer, and later removed by the owner (`business.addMember`, `business.removeMember`).
const J = 'J-home-ia-07';
const RUN = Date.now().toString(36);

test.describe.configure({ mode: 'serial' });

let owner;
let person;
let personId;
const accountId = uuidOf(`${J}:business:${RUN}`);
const businessName = `TEST Menu ${RUN}`;

/** A stable uuid for a journey key, so a write sent again in this run names the same record. */
function uuidOf(key) {
  const hex = createHash('sha256').update(key).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A bank write as `who`, which must answer. */
async function bankWrite(who, procedure, input) {
  const res = await (await api(who)).post(`/api/bank/trpc/${procedure}`, input);
  expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
  return res.body.result.data;
}

const menuButton = (page) => page.getByRole('button', { name: 'Account menu' });

/** Opens the account menu on Home and returns it. */
async function openMenu(page) {
  await page.goto('/home');
  await menuButton(page).click();
  const menu = page.getByTestId('account-summary').locator('xpath=ancestor::ul[1]');
  await expect(menu).toBeVisible();
  return menu;
}

/** Type into the header search and return its open results panel. */
async function search(page, words) {
  await page.getByRole('combobox', { name: 'Search markets' }).fill(words);
  const panel = page.getByTestId('tb-search-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await browser.newPage({ baseURL: ORIGIN });
  owner = await signUp(page, 'hm7o');
  await verify(page, owner);
  person = await signUp(page, 'hm7p');
  // Bank reads, the business list among them, answer a verified person.
  await verify(page, person);
  personId = (await api(person)).userId;
  await bankWrite(owner, 'business.create', { accountId, name: businessName, assetId: 'USDT', spendThreshold: '10' });
  await page.close();
});

test(`${J} #1 opens the avatar menu with no business: a profile summary, Personal active, Account, Security, Verification and Display, and "Open a business account"`, async ({
  page,
}) => {
  await signIn(page, person);
  const menu = await openMenu(page);
  const summary = menu.getByTestId('account-summary');
  await expect(summary).toContainText(`@${person.handle}`);
  await expect(summary).toContainText(`Account ID ${personId.slice(0, 8)}…`);
  await expect(summary).toContainText('Verification: Full');
  await expect(menu.getByTestId('profile-personal')).toHaveAttribute('aria-pressed', 'true');
  await expect(menu.getByTestId('profile-business')).toHaveCount(0);
  for (const [name, href] of [
    ['Account', '/uc/account'],
    ['Security', '/uc/safe'],
    ['Verification', '/verification'],
  ]) {
    await expect(menu.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
  }
  // Display: the theme row (IA-SPEC 1.7 names it Theme and shows the theme drawn) opens the Display room.
  const display = menu.getByRole('link', { name: /^Theme (Dark|Light)$/ });
  await expect(display).toHaveAttribute('href', '/view');
  await expect(menu.getByTestId('open-business')).toHaveText('Open a business account');
  await expect(menu.getByTestId('open-business')).toHaveAttribute('href', '/pay/onboarding');
  await display.click();
  await expect(page).toHaveURL((url) => url.pathname === '/view');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Display');
});

test(`${J} #2 picks the business membership: mode becomes Business, search shows business rooms and /pay/merchant opens`, async ({
  page,
}) => {
  await bankWrite(owner, 'business.addMember', { accountId, userId: personId, role: 'viewer' });
  await signIn(page, person);
  // Personal: business rooms are not offered.
  await page.goto('/home');
  const personal = await search(page, 'payouts');
  await expect(personal.getByRole('option', { name: 'Open Help', exact: true })).toBeVisible();
  await expect(personal.getByRole('option', { name: /Payouts/ })).toHaveCount(0);

  const menu = await openMenu(page);
  await expect(menu.getByTestId('open-business')).toHaveCount(0);
  await menu
    .getByTestId('profile-business')
    .filter({ hasText: `${businessName} · Business` })
    .click();
  await expect(page).toHaveURL((url) => url.pathname === '/pay/merchant');
  await expect(page.locator('#main')).toBeVisible();
  // The mode is Business: the chip names it, the menu marks it, and search offers business rooms.
  await page.goto('/home');
  await expect(page.getByText(`Business: ${businessName}`)).toBeVisible();
  const business = await search(page, 'payouts');
  await expect(business.getByRole('option', { name: /Payouts/ }).first()).toBeVisible();
  const again = await openMenu(page);
  await expect(again.getByTestId('profile-business')).toHaveAttribute('aria-pressed', 'true');
  await expect(again.getByTestId('profile-personal')).toHaveAttribute('aria-pressed', 'false');
});

test(`${J} #3 has the membership removed by an owner, then reloads: the app falls back to Personal and says so`, async ({ page }) => {
  await signIn(page, person);
  // Business is in view (kept on this device from #2's choice is not assumed: it is chosen again here).
  let menu = await openMenu(page);
  await menu.getByTestId('profile-business').filter({ hasText: businessName }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/pay/merchant');

  await bankWrite(owner, 'business.removeMember', { accountId, userId: personId, requestId: uuidOf(`${J}:remove:${RUN}`) });
  // A fresh load of Home reads the memberships again.
  await page.goto('/home');
  await expect(page.getByText(`Business: ${businessName}`)).toHaveCount(0);
  menu = await openMenu(page);
  await expect(menu.getByTestId('profile-gone')).toHaveText('That business is not one of your accounts, so Personal is shown.');
  await expect(menu.getByTestId('profile-personal')).toHaveAttribute('aria-pressed', 'true');
  await expect(menu.getByTestId('profile-business')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const personal = await search(page, 'payouts');
  await expect(personal.getByRole('option', { name: 'Open Help', exact: true })).toBeVisible();
  await expect(personal.getByRole('option', { name: /Payouts/ })).toHaveCount(0);
});

test(`${J} #4 signs out from the menu: the session ends and the public home shows`, async ({ page }) => {
  await signIn(page, person);
  const menu = await openMenu(page);
  await menu.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL((url) => url.pathname === '/');
  await expect(menuButton(page)).toHaveCount(0);
  // The public home: its own navigation, a way to sign in and the way to create an account.
  await expect(page.getByRole('navigation', { name: 'Public navigation' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  await expect(page.getByRole('link', { name: 'Create your account' })).toBeVisible();
  // The server ended the session: a fresh load of the public home stays public instead of opening Home.
  await page.reload();
  await expect(page).toHaveURL((url) => url.pathname === '/');
  await expect(page.getByRole('navigation', { name: 'Public navigation' })).toBeVisible();
  // The session is over: a private room asks to sign in again.
  await page.goto('/uc/account');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await expect(menuButton(page)).toHaveCount(0);
});
