import { test, expect } from '@playwright/test';
import { signIn, signUp } from './desk.mjs';
import { expectServiceOff } from './service-off.mjs';
import { ORIGIN } from './stack.mjs';

// J-home-ia-08, in the running app (docs/roadmap/journeys.json): I move between the Exchange and the Web3 shell. Tests titled
// "J-home-ia-08 #<n>" prove a whole step.
const J = 'J-home-ia-08';

test.describe.configure({ mode: 'serial' });

let who;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await browser.newPage({ baseURL: ORIGIN });
  who = await signUp(page, 'hmx');
  await page.context().close();
});

/** A device of its own (nothing remembered), signed in as the person. */
async function device(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, who);
  await page.goto('/home');
  return page;
}

const switcher = (page) => page.getByRole('navigation', { name: 'Switch between the Exchange and Web3' });

/** The Web3 frame: its own bar, its own navigation, none of the Exchange's. */
async function expectWeb3(page) {
  await expect(page.locator('[data-shell="web3"]')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Web3 navigation' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
  await expect(page.getByText('Not INTACHAIN · not audited').first()).toBeVisible();
  await expect(switcher(page).getByRole('link', { name: 'Web3' })).toHaveAttribute('aria-current', 'page');
}

async function expectExchange(page) {
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(page.locator('[data-shell="web3"]')).toHaveCount(0);
  await expect(switcher(page).getByRole('link', { name: 'Exchange' })).toHaveAttribute('aria-current', 'page');
}

test(`${J} #1 the Exchange and Web3 switch opens /dex, then the last Web3 room, in a different top bar and navigation`, async ({
  browser,
}) => {
  const page = await device(browser);
  await expectExchange(page);
  await switcher(page).getByRole('link', { name: 'Web3' }).click();
  await expect(page).toHaveURL(/\/dex$/);
  await expectWeb3(page);
  await page.getByRole('navigation', { name: 'Web3 navigation' }).getByRole('link', { name: 'Pools' }).click();
  await expect(page).toHaveURL(/\/dex\/pools$/);
  await switcher(page).getByRole('link', { name: 'Exchange' }).click();
  await expectExchange(page);
  await switcher(page).getByRole('link', { name: 'Web3' }).click();
  await expect(page).toHaveURL(/\/dex\/pools$/);
  await expectWeb3(page);

  // Narrower than 1280 px the signed-in bar has no room for the switch, so the account menu carries it.
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto('/money');
  await expect(switcher(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await switcher(page).getByRole('link', { name: 'Web3' }).click();
  await expect(page).toHaveURL(/\/dex\/pools$/);

  // On a phone the bottom bar differs too: Web3 has its own sections, never the Exchange's doors, and back again.
  await page.setViewportSize({ width: 390, height: 844 });
  const web3Bar = page.getByRole('navigation', { name: 'Web3 sections on phone' });
  const exchangeBar = page.getByRole('navigation', { name: 'Customer doors on phone' });
  await expect(web3Bar).toBeVisible();
  expect(await web3Bar.getByRole('link').allInnerTexts()).toEqual(['Swap', 'Pools', 'Wallet', 'Explorer', 'All']);
  await expect(web3Bar.getByRole('link', { name: 'Pools' })).toHaveAttribute('aria-current', 'page');
  await expect(exchangeBar).toHaveCount(0);
  await page.goto('/money');
  await expect(exchangeBar).toBeVisible();
  await expect(web3Bar).toHaveCount(0);
  await page.context().close();
});

test(`${J} #2 a room with no indexer or no wallet keeps its layout and names the blocker; a malformed id says not found`, async ({
  browser,
}) => {
  const page = await device(browser);
  // Every indexer room is built now (the pool page since #6880), so the room still waiting is the wallet one: its full
  // layout, the blocker named, and the way back.
  await page.goto('/dex/pools/new');
  await expectWeb3(page);
  await expect(page.getByText('Blocked by')).toBeVisible();
  await expect(page.getByText('Wallet connection is not built in this build, so there is nothing to sign with or read.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to DEX' })).toBeVisible();

  // A malformed pool id is not found, with no lookup and no blocker: the page says so in words.
  await page.goto('/dex/pools/TEST-pool');
  await expectWeb3(page);
  await expect(page.locator('[data-code="protocol.not_found"]')).toBeVisible();
  await expect(page.getByText('Not found on this network').first()).toBeVisible();
  await expect(page.getByText('Blocked by')).toHaveCount(0);

  await page.goto('/chain/tx/not-a-hash');
  await expectWeb3(page);
  await expect(page.getByText('Not found on this network')).toBeVisible();
  await expect(page.getByText('The indexer reader for this page is not built in this build.')).toHaveCount(0);
  await page.context().close();
});

test(`${J} #3 a blocked action names its blocker: an outside one is the shared service-off notice with its code, our own gap never has a code`, async ({
  browser,
}) => {
  const page = await device(browser);
  // Staking waits on the INTACHAIN launch go-ahead, an outside gate on the allowlist (chain.go).
  await page.goto('/chain/validators');
  await expectWeb3(page);
  for (const [action, label] of [
    ['stake', 'Stake'],
    ['unstake', 'Unstake'],
  ]) {
    const row = page.locator(`[data-action="${action}"]`);
    await expect(row.getByRole('button', { name: label })).toBeDisabled();
    await expectServiceOff(row.locator('[data-not-connected]'), 'chain.go', label);
  }
  // Swapping is blocked by our own Protocol service not answering on this stack: it says so, with no allowlist code.
  await page.goto('/dex');
  await expectWeb3(page);
  const swap = page.locator('[data-action="swap"]');
  await expect(swap.getByRole('button', { name: 'Swap' })).toBeDisabled();
  await expect(swap.getByRole('note')).toHaveText(/^Blocked: .+/);
  await expect(page.locator('[data-not-connected]')).toHaveCount(0);
  await page.context().close();
});

test(`${J} #4 switching back returns the last Exchange room; a device with no history gets the defaults`, async ({ browser }) => {
  const page = await device(browser);
  await page.goto('/money');
  await expectExchange(page);
  await switcher(page).getByRole('link', { name: 'Web3' }).click();
  await expect(page).toHaveURL(/\/dex$/);
  await switcher(page).getByRole('link', { name: 'Exchange' }).click();
  await expect(page).toHaveURL(/\/money$/);
  await expectExchange(page);
  await page.context().close();

  // A device with no history (here signed out, so nothing was opened before): Exchange opens the start page.
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  const fresh = await context.newPage();
  await fresh.goto('/chain');
  await expectWeb3(fresh);
  await expect(switcher(fresh).getByRole('link', { name: 'Exchange' })).toHaveAttribute('href', '/');
  await switcher(fresh).getByRole('link', { name: 'Exchange' }).click();
  await expect(fresh).toHaveURL(new RegExp(`^${ORIGIN}/?$`));
  await context.close();

  // Signed out on a phone there is no account menu, so the Exchange bar keeps the switch itself.
  const phone = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 390, height: 844 } });
  const visitor = await phone.newPage();
  await visitor.goto('/trade');
  await expect(switcher(visitor).getByRole('link', { name: 'Exchange' })).toHaveAttribute('aria-current', 'page');
  await switcher(visitor).getByRole('link', { name: 'Web3' }).click();
  await expect(visitor).toHaveURL(/\/dex$/);
  await expect(visitor.locator('[data-shell="web3"]')).toBeVisible();
  await expect(switcher(visitor).getByRole('link', { name: 'Web3' })).toHaveAttribute('aria-current', 'page');
  expect(await visitor.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await phone.close();
});

test(`${J} #5 /dex signed out is the public read-only view with a prompt to sign in`, async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto('/dex');
  await expectWeb3(page);
  await expect(page.getByText('Read only · nothing here moves money').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'DEX', exact: true })).toBeVisible();
  await expect(page.getByText('No wallet connected')).toBeVisible();
  const logIn = page.getByRole('banner').getByRole('link', { name: 'Log in' });
  await expect(logIn).toBeVisible();
  await expect(page.getByRole('banner').getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/register');
  await logIn.click();
  await expect(page).toHaveURL(/\/login/);
  await context.close();
});
