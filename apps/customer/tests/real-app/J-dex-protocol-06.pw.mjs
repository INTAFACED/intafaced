import { test, expect } from '@playwright/test';
import { TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun, walletSection } from './dex.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-dex-protocol-06, in the running app (docs/roadmap/journeys.json): see my portfolio, profit and loss, and track any
// public address. One test per step, titled "J-dex-protocol-06 #<n>", run in order with one TEST wallet on Base Sepolia
// holding several TEST tokens, one of them with no price. Read-only: nothing is signed and nothing posts to the ledger.
// feed.market shows while a price source is absent.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the wallet room's Overview has no portfolio total, profit and loss view, entry prices or positions dashboard
//   (D-portfolio-wallet-04), and the stack has no indexer or price feed to read holdings from;
// - there is no address tracker (D-portfolio-wallet-04, RC-dex-protocol-17);
// - Accounts lists nothing and has no margin mode or auto-earn (D-portfolio-wallet-05).
const J = 'J-dex-protocol-06';
const dex = dexRun(J);
const account = dexRun(`${J}-account`);
// A public address with history on the TEST network, and one with none.
const TRACKED = '0x52908400098527886E0F7030069857D2E4169EE7';
const EMPTY = '0x000000000000000000000000000000000000dEaD';

test.describe.configure({ mode: 'default' });

const portfolio = (page) => page.getByRole('region', { name: 'Portfolio' });

/** Opens the wallet's Overview with the run's wallet connected. */
async function openPortfolio(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await walletSection(page, 'Overview');
  await expect(portfolio(page)).toBeVisible(UNBUILT);
  return wallet;
}

/** Opens the address tracker. */
async function openTracker(page) {
  await page.goto('/wallet');
  await walletSection(page, 'Track an address');
  const tracker = page.getByRole('form', { name: 'Track an address' });
  await expect(tracker).toBeVisible(UNBUILT);
  return tracker;
}

test(`${J} starts: a TEST wallet holding several TEST tokens, one with no price`, async ({ page }) => {
  dex.start();
  await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
});

test(`${J} #1 opens the wallet portfolio: the total value; tokens with no price are left out and a warning names how many`, async ({
  page,
}) => {
  await openPortfolio(page);
  await expect(portfolio(page).getByTestId('portfolio-total')).toHaveText(/^\$[\d,.]+$/);
  await expect(portfolio(page).getByRole('note')).toHaveText(/^\d+ tokens? (has|have) no price and (is|are) left out of the total\.$/);
});

test(`${J} #2 opens profit and loss after a deposit and a price move: the deposit is excluded; 120 to 90 reads as a 25 percent drawdown; the convention links open`, async ({
  page,
}) => {
  await openPortfolio(page);
  await portfolio(page).getByRole('button', { name: 'Profit and loss', exact: true }).click(UNBUILT);
  const pnl = page.getByRole('region', { name: 'Profit and loss' });
  await expect(pnl.getByTestId('pnl-excludes')).toHaveText('Deposits and withdrawals are not counted as profit or loss.');
  // The stack's TEST price history moves the wallet from 120 to 90.
  await expect(pnl.getByTestId('max-drawdown')).toHaveText('Largest drop 25%');
  const convention = pnl.getByRole('link', { name: 'How we count profit and loss' });
  await convention.click();
  await expect(page.getByRole('heading', { name: 'How we count profit and loss' })).toBeVisible();
});

test(`${J} #3 opens a token that was transferred in: the entry price is the arrival-block price and the row says so`, async ({ page }) => {
  await openPortfolio(page);
  const holdings = portfolio(page).getByRole('region', { name: 'Holdings' }).getByRole('table');
  const row = holdings.getByRole('row').filter({ hasText: TOKEN_A.name });
  await expect(row).toHaveCount(1, UNBUILT);
  await expect(row).toContainText('Entry price: price at the block it arrived');
});

test(`${J} #4 opens the positions dashboard: pool, lending and venue positions in one list with links to each room`, async ({ page }) => {
  await openPortfolio(page);
  await portfolio(page).getByRole('button', { name: 'Positions', exact: true }).click(UNBUILT);
  const positions = page.getByRole('region', { name: 'Positions' });
  for (const [kind, room] of [
    ['Pools', /\/dex\/positions/],
    ['Lending', /\/dex\/lend/],
    ['Venue', /\/dex\/venue/],
  ]) {
    const group = positions.getByRole('group', { name: kind });
    await expect(group).toBeVisible();
    await expect(group.getByRole('link', { name: `Open ${kind}` })).toHaveAttribute('href', room);
  }
});

test(`${J} #5 pastes a public address into the tracker: its holdings and history; an address with no history shows an empty state, not zeros labelled as value`, async ({
  page,
}) => {
  const tracker = await openTracker(page);
  await tracker.getByRole('textbox', { name: /^Address/ }).fill(TRACKED);
  await tracker.getByRole('button', { name: 'Track' }).click();
  const tracked = page.getByRole('region', { name: `Tracked ${TRACKED}` });
  await expect(tracked.getByRole('region', { name: 'Holdings' }).getByRole('table')).toBeVisible();
  await expect(tracked.getByRole('region', { name: 'History' }).getByRole('table')).toBeVisible();
  await tracker.getByRole('textbox', { name: /^Address/ }).fill(EMPTY);
  await tracker.getByRole('button', { name: 'Track' }).click();
  const empty = page.getByRole('region', { name: `Tracked ${EMPTY}` });
  await expect(empty).toContainText('No history for this address on this network.');
  await expect(empty.getByText(/\$0(\.0+)?/)).toHaveCount(0);
});

test(`${J} #6 looks at the tracker request while signed in: no cookie, no authorisation header, no session id; no analytics script; the watchlist cannot be exported`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  let who = account.run.read().who;
  if (!who) {
    who = await fundedTrader(page, 'dex06', '1');
    account.run.reset({ who });
  }
  await signIn(page, who);
  const tracker = await openTracker(page);
  const seen = [];
  page.on('request', (request) => {
    if (/track/i.test(request.url())) seen.push(request);
  });
  await tracker.getByRole('textbox', { name: /^Address/ }).fill(TRACKED);
  await tracker.getByRole('button', { name: 'Track' }).click();
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  for (const request of seen) {
    const headers = await request.allHeaders();
    expect(headers.cookie, request.url()).toBeUndefined();
    expect(headers.authorization, request.url()).toBeUndefined();
    expect(request.url()).not.toMatch(/session/i);
  }
  const scripts = await page.evaluate(() => [...document.scripts].map((s) => s.src).filter(Boolean));
  expect(scripts.filter((src) => /analytics|gtag|segment|mixpanel|posthog/i.test(src))).toEqual([]);
  await expect(page.getByRole('button', { name: /^Export/ })).toHaveCount(0);
});

test(`${J} #7 opens Accounts and asks for portfolio margin: Standard only, with a link, and the typed refusal for portfolio margin`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await walletSection(page, 'Accounts');
  const margin = page.getByRole('radiogroup', { name: 'Margin mode' });
  await expect(margin.getByRole('radio', { name: 'Standard' })).toBeChecked(UNBUILT);
  await expect(page.getByRole('link', { name: 'What Standard means' })).toBeVisible();
  await margin.getByRole('radio', { name: 'Portfolio margin' }).check();
  await expect(page.getByRole('alert')).toContainText('dex.margin.portfolio_unavailable');
  await expect(margin.getByRole('radio', { name: 'Standard' })).toBeChecked();
});

test(`${J} #8 turns on wallet auto-earn: assets chosen by the owner; with the list blank the refusal names it; the key may only supply, never transfer`, async ({
  page,
}) => {
  await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await walletSection(page, 'Accounts');
  await page.getByRole('switch', { name: 'Auto-earn' }).click(UNBUILT);
  // The owner's auto-earn list is blank on the stack: refused by name, nothing is signed.
  await expect(page.getByRole('alert')).toContainText('dex.earn.auto_assets_unset');
  await expect(page.getByRole('switch', { name: 'Auto-earn' })).not.toBeChecked();
  const scope = page.getByRole('region', { name: 'Auto-earn key' });
  await expect(scope).toContainText('Can supply to lending');
  await expect(scope).toContainText('Cannot transfer');
});
