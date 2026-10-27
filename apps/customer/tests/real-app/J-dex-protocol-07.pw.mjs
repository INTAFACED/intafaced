import { test, expect } from '@playwright/test';
import { signIn, signUp } from './desk.mjs';
import { toUnits } from './stack.mjs';
import { installTestWallet } from './test-wallet.mjs';
import { tableIn, bodyRows } from './tables.mjs';

// J-dex-protocol-07, in the running app (docs/roadmap/journeys.json): find a token, read its page and judge how much to
// trust it. One test per step, titled "J-dex-protocol-07 #<n>". Signed out unless a step says otherwise; a quick trade is a
// wallet-signed TEST swap (J-dex-protocol-02) and nothing posts to the ledger. Step 10 (a real-world asset blocked by
// region) waits for launch prep (owner decision 2026-10-27) and has no test.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - The Web3 nav has no Tokens room: no Trending, New listings, Top traded, brief, screeners or watchlist
//   (D-portfolio-wallet-06, -07, D-launch-listing-02, -04), and the stack publishes no node or indexer for token data.
// - A token page (/dex/tokens/:address) names its indexer blocker and shows no price, trust tier, tabs or quick ticket.
const J = 'J-dex-protocol-07';
const UNBUILT = { timeout: 5_000 };
const TOKEN = '0x4200000000000000000000000000000000000006';

test.describe.configure({ mode: 'default' });

async function openTokens(page) {
  await page.goto('/dex');
  await page.getByRole('navigation').getByRole('link', { name: 'Tokens', exact: true }).click(UNBUILT);
  await expect(page.getByRole('heading', { name: 'Tokens', level: 1 })).toBeVisible();
}

const tokenRows = (page) => bodyRows(tableIn(page, 'Tokens'));

test(`${J} #1 opens Tokens and the Trending tab: rows by growth for the window with the formula link; a saved filter survives reload; blocked storage still works`, async ({
  page,
  browser,
}) => {
  await openTokens(page);
  await page.getByRole('tab', { name: 'Trending' }).click();
  await expect(page.getByRole('link', { name: 'How trending is worked out' })).toBeVisible();
  const growth = await tableIn(page, 'Tokens').getByTestId('token-growth').allInnerTexts();
  const values = growth.map((text) => Number(text.replace(/[^\d.-]/g, '')));
  expect(values).toEqual([...values].sort((a, b) => b - a));
  await page.getByRole('combobox', { name: 'Window' }).selectOption('24h');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Window' })).toHaveValue('24h');

  const blocked = await browser.newContext();
  await blocked.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
  });
  const other = await blocked.newPage();
  await openTokens(other);
  await expect(other.getByRole('tab', { name: 'Trending' })).toBeVisible();
  await blocked.close();
});

test(`${J} #2 opens New listings and Top traded: Top traded by volume, New by listing time; an address search finds a token with no symbol`, async ({
  page,
}) => {
  await openTokens(page);
  await page.getByRole('tab', { name: 'Top traded' }).click();
  const volumes = (await tableIn(page, 'Tokens').getByTestId('token-volume').allInnerTexts()).map((t) => Number(t.replace(/[^\d.]/g, '')));
  expect(volumes).toEqual([...volumes].sort((a, b) => b - a));
  await page.getByRole('tab', { name: 'New listings' }).click();
  const listed = await tableIn(page, 'Tokens')
    .getByTestId('token-listed-at')
    .evaluateAll((items) => items.map((t) => t.getAttribute('datetime')));
  expect(listed).toEqual([...listed].sort().reverse());
  await page.getByRole('searchbox', { name: 'Search tokens' }).fill(TOKEN);
  await expect(tokenRows(page).first()).toContainText(TOKEN.slice(0, 6));
});

test(`${J} #3 opens the market brief and the stablecoin screener: a brief or "No brief today"; a blank stablecoin list shows its refusal; the leaderboard equals realised trades`, async ({
  page,
}) => {
  await openTokens(page);
  await page.getByRole('tab', { name: 'Market brief' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Market brief' })).toContainText(/No brief today|Brief for /);
  await page.getByRole('tab', { name: 'Stablecoins' }).click();
  // The owner has listed no stablecoins on the stack, so the screener refuses with that reason.
  await expect(page.getByRole('tabpanel', { name: 'Stablecoins' })).toContainText('The stablecoin list is not set');
  await page.getByRole('tab', { name: 'Leaderboard' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Leaderboard' }).getByRole('columnheader', { name: /Realised/ })).toBeVisible();
});

test(`${J} #4 opens a token page: price, liquidity in token amounts, fees and growth; market cap "Not available" with no supply source; a USD price with its as-of time`, async ({
  page,
}) => {
  await page.goto(`/dex/tokens/${TOKEN}`);
  const facts = page.getByRole('region', { name: 'Token facts' });
  await expect(facts).toBeVisible(UNBUILT);
  await expect(facts).toContainText(/\$[\d,.]+/);
  await expect(facts).toContainText(/as of \d{1,2}:\d{2}/);
  await expect(facts).toContainText(/Liquidity/);
  await expect(facts).toContainText(/Fees/);
  await expect(facts).toContainText(/Market cap\s*(Not available|\$[\d,.]+)/);
});

test(`${J} #5 reads the trust tier and the organic score: "unknown" with a note with no history, "Not scored" while inputs are blank, suspicious flags, and a lookalike name masked`, async ({
  page,
}) => {
  await page.goto(`/dex/tokens/${TOKEN}`);
  const trust = page.getByRole('region', { name: 'Trust' });
  await expect(trust).toBeVisible(UNBUILT);
  await expect(trust.getByTestId('token-trust-tier')).toHaveText(/unknown|low|medium|high/i);
  await expect(trust.getByTestId('token-organic-score')).toHaveText(/Not scored|\d+/);
});

test(`${J} #6 opens the pairs, holders and trades tabs: candles at the swap times, volume equal to the swaps, holders summing to supply less burned`, async ({
  page,
}) => {
  await page.goto(`/dex/tokens/${TOKEN}`);
  for (const tab of ['Pairs', 'Holders', 'Trades']) {
    await page.getByRole('tab', { name: tab }).click(UNBUILT);
    await expect(page.getByRole('tabpanel', { name: tab })).toBeVisible();
  }
  await page.getByRole('tab', { name: 'Pairs' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Pairs' }).getByRole('img', { name: /Price chart/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Holders' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Holders' })).toContainText(/supply less burned/i);
});

test(`${J} #7 creates a watchlist while signed out, then signs in: it persists in the browser and is offered for import on sign-in`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto(`/dex/tokens/${TOKEN}`);
  await page.getByRole('button', { name: 'Add to watchlist' }).click(UNBUILT);
  await page.reload();
  await expect(page.getByRole('button', { name: 'On your watchlist' })).toBeVisible();
  const who = await signUp(page, 'tw');
  await signIn(page, who);
  await openTokens(page);
  await expect(page.getByRole('dialog', { name: /Import your watchlist/ })).toBeVisible();
});

test(`${J} #8 opens the stocks screener with no asset registered: an empty state with its blocker, not a made-up list`, async ({
  page,
}) => {
  await openTokens(page);
  await page.getByRole('tab', { name: 'Stocks' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Stocks' });
  await expect(panel).toContainText(/No stock is registered/);
  await expect(panel).toContainText(/Blocked:/);
  await expect(panel.getByRole('row')).toHaveCount(0);
});

test(`${J} #9 uses the 50 percent shortcut in the quick ticket: the amount is half the balance and Review opens the swap sheet`, async ({
  page,
}) => {
  await installTestWallet(page, { chainId: 84532 });
  await page.goto(`/dex/tokens/${TOKEN}`);
  const ticket = page.getByRole('form', { name: 'Quick trade' });
  await expect(ticket).toBeVisible(UNBUILT);
  await ticket.getByRole('button', { name: /^Connect TEST Wallet/ }).click();
  const balance = toUnits(((await ticket.getByTestId('quick-balance').textContent()) ?? '').replace(/[^\d.]/g, ''));
  await ticket.getByRole('button', { name: '50%' }).click();
  expect(toUnits(await ticket.getByRole('textbox', { name: 'Amount' }).inputValue())).toBe(balance / 2n);
  await ticket.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByRole('dialog', { name: /Review the swap/ })).toBeVisible();
});
