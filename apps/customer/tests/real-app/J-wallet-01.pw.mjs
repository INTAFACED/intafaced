import { test, expect } from '@playwright/test';
import { api, fund, journeyState, toUnits } from './stack.mjs';
import { awayBid, chosePro, confirm, deskPath, free, held, openDesk, openOrders, reviewLimit, signIn, signUp, verify } from './desk.mjs';

// J-wallet-01, in the running app (docs/roadmap/journeys.json): I see what I hold and what I can actually withdraw.
// One test per step, titled "J-wallet-01 #<n>", run in order on one verified TEST account funded with TEST 500 USDT.
// Every figure on screen is checked against the ledger through the customer's own API. #4 holds TEST gold (XAU): the
// stack lists it only against USD, and a coin is priced only against USDT or USDC, so no price is published for it.
// #5 reads the ledger's asset registry, which the stack's founders publish (`local-test-gates.mjs assets`): TEST USDT and
// USDC, and TESTRETIRED, a TEST asset published retired, which the account is credited so its history has a line.
const J = 'J-wallet-01';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
// Available, In orders and Locked are the Pro columns of Money; the app opens in Simple, so this person chose Pro.
test.beforeEach(({ page }) => chosePro(page));

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

const balances = async () => (await api(account())).balances();
/** The ledger's decimal as the Money table prints it: thousands grouped, no trailing zeros (no float near money). */
const shown = (decimal) => {
  const [whole, frac] = decimal.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac && /[1-9]/.test(frac) ? `.${frac.replace(/0+$/, '')}` : ''}`;
};
const usdtRow = (page) => page.locator('tr', { has: page.locator('[data-col="available"]') }).filter({ hasText: 'Tether' });

/** The USDT row on Money shows Available, In orders and Locked as the ledger holds them, and they add up to its total. */
async function moneyAgreesWithLedger(page) {
  const usdt = (await balances()).USDT;
  await page.goto('/money');
  // A pointer left on the top bar keeps its hover menu open over the page; move it off, as a person would.
  await page.mouse.move(0, 600);
  const row = usdtRow(page);
  await expect(row.locator('[data-col="available"]')).toHaveText(shown(usdt.free));
  await expect(row.locator('[data-col="in-orders"]')).toHaveText(shown(usdt.used));
  await expect(row.locator('[data-col="locked"]')).toHaveText('0');
  await expect(row).toContainText(`${shown(usdt.total)} USDT`);
  expect(toUnits(usdt.free) + toUnits(usdt.used)).toBe(toUnits(usdt.total));
  return usdt;
}

test(`${J} #1 opens Assets: available, in orders and locked add up to the ledger total`, async ({ page }) => {
  const who = await signUp(page, 'jw');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '500').tx).toBeTruthy();
  run.reset({ account: who });
  await signIn(page, who);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Money' }).click();
  await expect(page).toHaveURL(/\/money(\?|$)/);
  const usdt = await moneyAgreesWithLedger(page);
  expect(usdt).toMatchObject({ free: expect.stringMatching(/^500(\.0+)?$/), total: expect.stringMatching(/^500(\.0+)?$/) });
  // Grouped by kind of wallet place: what can be spent and what is locked.
  await page.getByRole('button', { name: 'Place' }).click();
  await expect(page.getByText('Spendable').first()).toBeVisible();
});

test(`${J} #2 places an order: its hold names the order, and cancelling it returns the amount to available`, async ({ page }) => {
  const who = account();
  await openDesk(page, who);
  await reviewLimit(page, 'buy', await awayBid(90), '0.002');
  await confirm(page, 'buy');
  const [order] = await openOrders(who);
  expect(order?.id).toBeTruthy();
  const short = order.id.slice(0, 8);

  // Money: the hold is In orders, and the cell names the order behind it.
  const usdt = await moneyAgreesWithLedger(page);
  expect(toUnits(usdt.used)).toBeGreaterThan(0n);
  await expect(usdtRow(page).locator('[data-col="in-orders"]')).toHaveAttribute('title', `Open order ${short}: ${usdt.used}`);

  // The coin's balance page lists the hold as its own line, by the order, and adds everything back to the balance.
  await page.goto('/money/balance/USDT');
  const lines = page.getByTestId('set-aside');
  await expect(lines.locator('tr', { hasText: `Open order ${short}` })).toContainText(`${shown(usdt.used)} USDT`);
  await expect(lines.locator('td', { hasText: `Open order ${short}` })).toHaveAttribute('title', order.id);
  await expect(page.getByTestId('set-aside-sum')).toHaveText(
    `Available ${shown(usdt.free)} + set aside ${shown(usdt.used)} = ${shown(usdt.total)} USDT, all the USDT in your main account.`,
  );

  // Cancel on the desk (still signed in): the hold goes back to available, once.
  await page.goto(deskPath());
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
  await page.locator('tr', { hasText: 'Cancel' }).first().getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(async () => (await openOrders(who)).length).toBe(0);
  const after = await moneyAgreesWithLedger(page);
  expect(held(await balances(), 'USDT')).toBe(0n);
  expect(after.free).toBe(after.total);
  await page.goto('/money/balance/USDT');
  await expect(page.getByText('Nothing of your USDT is set aside right now.')).toBeVisible();
});

test(`${J} #3 opens Withdraw: it offers only what is available, and a card or bank purchase is refused with its blocker`, async ({
  page,
}) => {
  const who = account();
  // A resting order holds part of the balance again, so Withdraw must leave it out.
  await openDesk(page, who);
  await reviewLimit(page, 'buy', await awayBid(90), '0.002');
  await confirm(page, 'buy');
  const before = await balances();
  expect(held(before, 'USDT')).toBeGreaterThan(0n);
  await page.goto('/uc/withdraw');
  await expect(page.getByText(`Available: ${shown(before.USDT.free)} USDT`)).toBeVisible();
  // Card and bank purchases need a payment partner; the page says so and nothing is held for them.
  await page.goto('/uc/recharge');
  const main = page.locator('main').first();
  await expect(main).toContainText('Needs a payment partner, which is not connected.');
  const after = await balances();
  expect(free(after, 'USDT')).toBe(free(before, 'USDT'));
  expect(held(after, 'USDT')).toBe(held(before, 'USDT'));
});

test(`${J} #4 holds an asset with no published price: its value says so, never zero, and the total leaves it out`, async ({ page }) => {
  const who = account();
  // One business ref per account, so a re-run of this step alone credits nothing more.
  expect(fund(who.email, 'XAU', '1', `jw01-xau-${who.email.split('@')[0].replace(/[^A-Za-z0-9-]/g, '')}`.slice(0, 64)).out).toMatch(
    /TEST FUNDS credited/,
  );
  const before = await balances();
  expect(before.XAU).toMatchObject({ total: expect.stringMatching(/^1(\.0+)?$/) });
  await signIn(page, who);
  await page.goto('/money');
  await page.mouse.move(0, 600);
  const gold = page.locator('tr[data-testid="money-row"][data-asset="XAU"]');
  await expect(gold).toBeVisible();
  await expect(gold).toContainText('1 XAU');
  const value = gold.locator('td[data-testid="money-cell--value"]');
  await expect(value).toHaveText('—');
  await expect(value).toHaveAttribute('title', 'No price published');
  await expect(gold.locator('td[data-testid="money-cell--today"]')).toHaveText('—');
  await expect(gold).not.toContainText('$0');
  // The total counts only what has a price, and says which coin it leaves out.
  const note = page.getByTestId('money-note').filter({ hasText: 'Excludes' });
  await expect(note).toContainText('Excludes 1 coin (no USD price)');
  await expect(note).toContainText('Not counted: XAU');
});

const RETIRED = 'TESTRETIRED';

test(`${J} #5 opens the asset and network list: the rows Deposit and Withdraw use, and a retired asset stays listed with its history`, async ({
  page,
}) => {
  const who = account();
  const credit = fund(who.email, RETIRED, '5', `jw01-ret-${who.email.split('@')[0].replace(/[^A-Za-z0-9-]/g, '')}`.slice(0, 64));
  expect(credit.out).toMatch(/TEST FUNDS credited/);
  const customer = await api(who);
  const read = async (procedure) => {
    const { status, body } = await customer.get(`/api/bank/trpc/${procedure}`);
    expect(status, `${procedure}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
    return body.result.data;
  };
  const { assets: listed } = await read('assets.list');
  const withdrawable = await read('ramps.destinations.networks');
  const deposits = await read('deposits.assets');
  const row = (id) => listed.find((asset) => asset.assetId === id);

  // Withdraw's address book offers exactly the listed rows that are active and allow withdrawals, at the same precision.
  expect(withdrawable).toEqual(
    listed
      .filter((asset) => asset.state === 'active' && asset.allowedActions.includes('withdraw') && asset.networks.length > 0)
      .map(({ assetId, precision, networks, defaultNetworkId }) => ({ assetId, precision, networks, defaultNetworkId })),
  );
  // Deposit offers only pairs the list allows for deposits; the retired asset takes none.
  expect(deposits.assets.length).toBeGreaterThan(0);
  for (const asset of deposits.assets) {
    expect(row(asset.assetId)).toMatchObject({ state: 'active', allowedActions: expect.arrayContaining(['deposit']) });
    for (const network of asset.networks) expect(row(asset.assetId).networks.map((n) => n.networkId)).toContain(network.id);
  }
  expect(deposits.assets.map((asset) => asset.assetId)).not.toContain(RETIRED);
  expect(row(RETIRED)).toMatchObject({ state: 'retired', allowedActions: [] });

  // The page: from Deposit, every listed row with its precision and networks, the retired one marked and linked to its history.
  await signIn(page, who);
  await page.goto('/uc/recharge');
  await page.mouse.move(0, 600);
  await page.getByRole('link', { name: 'Supported assets and networks' }).click();
  await expect(page).toHaveURL(/\/uc\/assets$/);
  await expect(page.getByRole('heading', { name: 'Supported assets and networks', level: 1 })).toBeVisible();
  const table = page.getByTestId('supported-assets');
  await expect(table.locator('tbody tr')).toHaveCount(listed.length);
  for (const asset of listed) {
    const tr = table.locator(`tr[data-asset="${asset.assetId}"]`);
    await expect(tr.locator('[data-col="precision"]')).toHaveText(String(asset.precision));
    await expect(tr.locator('[data-col="networks"] li')).toHaveText(
      asset.networks.map((n) => (n.networkId === asset.defaultNetworkId ? `${n.label} (default)` : n.label)),
    );
    await expect(tr).toHaveAttribute('data-state', asset.state);
  }
  const usdt = table.locator('tr[data-asset="USDT"]');
  await expect(usdt.locator('[data-col="actions"]')).toContainText('Deposit');
  await expect(usdt.locator('[data-col="actions"]')).toContainText('Withdraw');
  const retired = table.locator(`tr[data-asset="${RETIRED}"]`);
  await expect(retired.locator('[data-col="state"]')).toContainText('Retired');
  await expect(retired.locator('[data-col="state"]')).toContainText('What you hold and your history with it stay.');
  await expect(retired.locator('[data-col="actions"]')).toHaveText('Nothing new');
  await retired.getByRole('link', { name: `Your ${RETIRED} history` }).click();
  await expect(page).toHaveURL(new RegExp(`/money/balance/${RETIRED}$`));
  await expect(page.getByRole('region', { name: `${RETIRED} balance, entry by entry` })).toContainText(credit.tx);

  // Withdraw links the same list.
  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  await expect(page.getByRole('link', { name: 'Supported assets and networks' })).toHaveAttribute('href', '/uc/assets');
});

test(`${J} #6 opens membership on Account: with no tier published, it says membership is not offered`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  await page.goto('/uc/account');
  const panel = page.getByTestId('membership');
  await expect(panel).toHaveAttribute('data-state', 'not-offered');
  await expect(panel).toContainText('Membership is not offered');
  await expect(panel).toContainText('No membership tier is published, so there is nothing to join and nothing is charged.');
  // No tier, price or join control in its place.
  await expect(page.locator('#membership').getByRole('button')).toHaveCount(0);
  await expect(page.locator('#membership [data-tier]')).toHaveCount(0);
});
