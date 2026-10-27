import { test, expect } from '@playwright/test';
import { TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun } from './dex.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-14, in the running app (docs/roadmap/journeys.json): borrow against collateral, watch health and repay.
// One test per step, titled "J-dex-protocol-14 #<n>", run in order with one TEST wallet holding TEST token A as
// collateral; TEST token B is the borrowed token. Collateral and debt sit in an isolated lending market under the
// person's own signature; nothing posts to the ledger. owner.decision shows while no market is published; rail.crypto
// while the node is absent.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the Web3 side has no lending room (/dex/lend): no market list, market page, oracle status, position or collateral
//   classes (D-lend-earn-02, -03, -04);
// - the stack publishes no market and has no TEST chain or oracle, so a supply, borrow, price fall or repay has nothing
//   to go to. #1 is the stack's own case; #2 to #8 need a published TEST market.
const J = 'J-dex-protocol-14';
const dex = dexRun(J);
const MARKET = 'TEST Token A / TEST Token B';

test.describe.configure({ mode: 'default' });

const markets = (page) => tableIn(page.getByRole('main'), 'Lending markets');
const position = (page) => page.getByRole('main').getByRole('region', { name: 'Your loan' });

/** Opens the lending room with the run's wallet connected. */
async function openLend(page) {
  const wallet = await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
  await page.goto('/dex/lend');
  await expect(markets(page)).toBeVisible(UNBUILT);
  return wallet;
}

/** Opens the TEST market's page. */
async function openMarket(page) {
  await openLend(page);
  await bodyRows(markets(page)).filter({ hasText: MARKET }).getByRole('link').click(UNBUILT);
  const market = page.getByRole('main').getByRole('region', { name: MARKET });
  await expect(market).toBeVisible();
  return market;
}

/** Signs whatever the open sheet asks for. */
async function sign(page) {
  await page.getByRole('dialog', { name: 'Check before you sign' }).getByRole('button', { name: 'Continue in wallet' }).click();
}

test(`${J} starts: a TEST wallet holding TEST collateral`, async ({ page }) => {
  dex.start();
  await connectWallet(page, dex, { tokens: [TOKEN_A, TOKEN_B] });
});

test(`${J} #1 opens the market list with no market published: "No lending market is published yet." with the owner-decision label, in the full layout`, async ({
  page,
}) => {
  await openLend(page);
  for (const header of ['Market', 'Supply rate', 'Borrow rate', 'Utilisation'])
    await expect(markets(page).getByRole('columnheader', { name: header })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('No lending market is published yet.');
  await expect(page.getByRole('main').getByText('Owner decision', { exact: true })).toBeVisible();
});

test(`${J} #2 opens a TEST market at 40 percent utilisation: its own supply and borrow rates, a two-slope curve with the kink and the reserve view`, async ({
  page,
}) => {
  const market = await openMarket(page);
  await expect(market.getByTestId('utilisation')).toHaveText('40%');
  // The rates on the page are the contract's own view, read as it stores them.
  await expect(market.getByTestId('supply-rate')).toHaveText(/^[\d.]+ ?%$/);
  await expect(market.getByTestId('borrow-rate')).toHaveText(/^[\d.]+ ?%$/);
  const curve = market.getByRole('img', { name: /^Rate curve/ });
  await expect(curve).toHaveAccessibleName(/two slopes, kink at [\d.]+ ?%/);
  await expect(market.getByRole('region', { name: 'Reserve' })).toBeVisible();
});

test(`${J} #3 opens the oracle status: each source with its age and the agreed mark; a stale or disagreeing source is named and borrows pause`, async ({
  page,
}) => {
  const market = await openMarket(page);
  const oracle = tableIn(market, 'Price sources');
  for (const header of ['Source', 'Age', 'Price']) await expect(oracle.getByRole('columnheader', { name: header })).toBeVisible();
  await expect(market.getByTestId('agreed-mark')).toHaveText(/^Agreed mark [\d,.]+$/);
  // The TEST market's second source is stale: it is named, and borrowing pauses until the sources agree again.
  await expect(bodyRows(oracle).filter({ hasText: 'Stale' })).toHaveCount(1);
  await expect(market.getByRole('alert')).toContainText(/Borrowing is paused: .+ is stale/);
});

test(`${J} #4 supplies 10 collateral and borrows 7 where 6 is allowed: refused with the maximum shown; borrowing 5 works`, async ({
  page,
}) => {
  const market = await openMarket(page);
  await market.getByRole('button', { name: 'Supply collateral' }).click();
  await page.getByRole('textbox', { name: /^Amount of TEST Token A/ }).fill('10');
  await page.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  await market.getByRole('button', { name: 'Borrow' }).click();
  const borrow = page.getByRole('form', { name: 'Borrow' });
  await borrow.getByRole('textbox', { name: /^Amount of TEST Token B/ }).fill('7');
  await borrow.getByRole('button', { name: 'Review' }).click();
  await expect(borrow.getByRole('alert')).toContainText('You can borrow at most 6 TEST Token B');
  await borrow.getByRole('textbox', { name: /^Amount of TEST Token B/ }).fill('5');
  await borrow.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  await expect(position(page).getByTestId('debt')).toHaveText(/^5(\.0+)? TEST Token B$/, { timeout: 60_000 });
});

test(`${J} #5 opens the position: collateral, debt, health factor and the price at which it would be liquidated`, async ({ page }) => {
  await openMarket(page);
  for (const term of ['Collateral', 'Debt', 'Health factor', 'Liquidated at'])
    await expect(position(page).getByRole('term').filter({ hasText: term })).toBeVisible();
  await expect(position(page).getByTestId('health-factor')).toHaveText(/^[\d.]+$/);
});

test(`${J} #6 sees the price fall: a health factor under 1 warns; the account is listed as liquidatable`, async ({ page }) => {
  const market = await openMarket(page);
  // The TEST oracle's next mark is lower; the position reads unhealthy and others may liquidate it.
  await expect(position(page).getByRole('alert')).toContainText('Health factor under 1', { timeout: 120_000 });
  const liquidatable = tableIn(market, 'Liquidatable accounts');
  await expect(bodyRows(liquidatable).filter({ hasText: /0x[0-9a-fA-F]{4}/ })).not.toHaveCount(0);
});

test(`${J} #7 repays in full and withdraws collateral: debt zero, collateral back in the wallet`, async ({ page }) => {
  await openMarket(page);
  await position(page).getByRole('button', { name: 'Repay' }).click();
  await page.getByRole('button', { name: 'Repay all' }).click();
  await sign(page);
  await expect(position(page).getByTestId('debt')).toHaveText(/^0(\.0+)? TEST Token B$/, { timeout: 60_000 });
  await position(page).getByRole('button', { name: 'Withdraw collateral' }).click();
  await page.getByRole('button', { name: 'Withdraw all' }).click();
  await sign(page);
  await expect(position(page).getByTestId('collateral')).toHaveText(/^0(\.0+)? TEST Token A$/, { timeout: 60_000 });
});

test(`${J} #8 reads the collateral classes: pegged-asset classes with their redemption-rate sources and the looser liquidation bound or its absence`, async ({
  page,
}) => {
  await openLend(page);
  await page.getByRole('main').getByRole('link', { name: 'Collateral classes' }).click(UNBUILT);
  const classes = tableIn(page.getByRole('main'), 'Collateral classes');
  for (const header of ['Class', 'Redemption rate source', 'Liquidation bound'])
    await expect(classes.getByRole('columnheader', { name: header })).toBeVisible();
  await expect(bodyRows(classes)).not.toHaveCount(0);
  await expect(bodyRows(classes).filter({ hasNotText: /Looser bound [\d.]+ ?%|No looser bound/ })).toHaveCount(0);
});
