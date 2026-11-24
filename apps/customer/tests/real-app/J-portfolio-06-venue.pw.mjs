// World: book, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { DAY } from './clock.mjs';
import { api, fromUnits, journeyState, restartService, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { connectWhenAsked } from './dex.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { pricesPublished, signInWithWallet, signedOnVenue, walletPerson } from './sources.mjs';
import {
  otherTraderKey,
  otherTraderRun,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueRecord,
} from './venue.mjs';

// J-portfolio-06 #1 #3, in the running app on the launch model (docs/roadmap/journeys.json): "I see my allocation,
// pick a display currency and choose which account to view". INTAFACED holds none of this person's money; with
// svc-trade's user-venue door on for this file (venueForThisFile) and svc-ops' labelled TEST valuation price list
// published (`LOCAL_STACK_VALUATION_PRICES=test`: USDC=1, USDT=1), /money shows allocation (by coin, kind and place)
// and holdings change over a period from the venue's own balances, fills and credits, checked here against the TEST
// venue's own record (`venueBalance`, `venueRecord`). Steps #2 #4 #5 #6 stay in J-portfolio-06.pw.mjs.
const J = 'J-portfolio-06';
const SYMBOL = 'BTC-USDC';
const VENUE_USDC = '500';
const VENUE_USDT = '400';
const STAKED_USDT = '50';
const FIRST_BUY = { amount: '0.002', price: '60000' };
const RESTING_BUY = { amount: '0.001', price: '30000' };
const SECOND_BUY = { amount: '0.001', price: '60000' };
const SCALE = 10n ** 18n;
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
test.beforeAll(async () => {
  test.setTimeout(240_000);
  await restartService('ops', { LOCAL_STACK_VALUATION_PRICES: 'test' });
});
test.afterAll(async () => {
  test.setTimeout(240_000);
  await restartService('ops', { LOCAL_STACK_VALUATION_PRICES: null });
});

const state = () => walletPerson(run, J);
const withWallet = (page) => signInWithWallet(page, state());

const sum = (list) => list.reduce((a, b) => a + b, 0n);
const groupedWhole = (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Rounds a non-negative scaled bigint half up to `places` decimal places and formats it fixed. */
function fixedHalfUp(value, places) {
  const step = 10n ** BigInt(18 - places);
  const rounded = ((value + step / 2n) / step) * step;
  const [whole, frac = ''] = fromUnits(rounded).split('.');
  return `${whole}.${frac.padEnd(places, '0').slice(0, places)}`;
}

/** Dollars as /money writes them: grouped thousands, rounded half-up to cents. */
function dollars(value) {
  const [whole, cents] = fixedHalfUp(value, 2).split('.');
  return `$${groupedWhole(whole)}.${cents}`;
}

/** A share ratio (value / total, half-up at 18 places) formatted as the kit's percentage (2 places, half-up). */
function pct(value, total) {
  const share18 = (value * SCALE * 2n + total) / (total * 2n);
  const text = `${fixedHalfUp(share18 * 100n, 2)}%`;
  return share18 > 0n && text === '0.00%' ? '<0.01%' : text;
}

const order = (owner, side, { amount, price }, timeInForce, tag) => ({
  kind: 'place_order',
  symbol: SYMBOL,
  side,
  type: 'limit',
  amount,
  price,
  timeInForce,
  reduceOnly: false,
  clientOrderKey: `order:${owner}:btc-usdc:pf6${tag}${randomBytes(4).toString('hex')}`,
  builderFee: null,
});

/** Opens /money with the wallet connected and waits until the venue source has answered. */
async function openMoney(page, { fresh = true } = {}) {
  const { owner } = state();
  if (fresh) await withWallet(page);
  await page.goto('/money');
  await expect(page.getByTestId('assets-by-source')).toBeVisible({ timeout: 30_000 });
  await connectWhenAsked(page, page.locator(`[data-testid="source-wallet"][data-address="${owner}"]`));
  await expect(page.getByTestId('source-venue').locator('tr[data-asset="USDT"]')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const who = await signUp(page, 'pf6v');
    await verify(page, who);
    const walletKey = testWalletKey();
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    const session = await api(who);

    // Fund TEST USDC and TEST USDT in the venue account, buy 0.002 BTC against another TEST trader, stake 50 USDT
    // (an earn lock on the venue), and rest a far-below-market limit buy locking 30 USDC in open orders.
    expect(await testDeposit(owner, 'USDC', VENUE_USDC, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    expect(await testDeposit(owner, 'USDT', VENUE_USDT, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    const seller = `${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}-${owner.slice(2, 10)}-s1`;
    await testVenue('/test/deposit', {
      account: await venueAccount(otherTraderKey(seller).address),
      asset: 'BTC',
      amount: '1',
      depositRef: `seed:${seller}:BTC`,
    });
    const ask1 = await otherTraderRun(seller, order(otherTraderKey(seller).address.toLowerCase(), 'sell', FIRST_BUY, 'GTC', 'ask1'));
    expect(ask1.definite && ask1.accepted, JSON.stringify(ask1)).toBe(true);
    await signedOnVenue(walletKey, order(owner, 'buy', FIRST_BUY, 'IOC', 'buy1'));
    await expect.poll(async () => (await venueRecord(owner, '/fills', { since: new Date(0).toISOString() })).value.length).toBe(1);

    const staked = await testVenue('/test/stake', {
      account: await venueAccount(owner),
      asset: 'USDT',
      amount: STAKED_USDT,
      stakeRef: `pf6-stake:${owner}:usdt`,
    });
    expect(staked.status, JSON.stringify(staked.body)).toBe(200);
    expect(staked.body.staked).toBe(true);

    await signedOnVenue(walletKey, order(owner, 'buy', RESTING_BUY, 'GTC', 'rest'));
    await expect.poll(async () => (await venueRecord(owner, '/open-orders')).value.length).toBe(1);

    const arrivals = (await venueRecord(owner, '/arrivals')).value;
    const fills = (await venueRecord(owner, '/fills', { since: new Date(0).toISOString() })).value;
    const setupLastAt = Math.max(...arrivals.map((a) => Date.parse(a.arrivedAt)), ...fills.map((f) => Date.parse(f.filledAt)));
    run.reset({ account: who, walletKey, setupLastAt, ledgerStart: await session.balances() });
  } finally {
    await page.close();
  }
});

test(`${J} #1 opens allocation: by coin, kind and place; USDT as dollar coins, staked USDT under earn, spendable and locked; each grouping adds up to the total`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const { account: who, owner, ledgerStart } = state();
  const prices = await pricesPublished();
  expect(prices).toMatchObject({ published: true, test: true, source: 'TEST price list' });
  const price = new Map(prices.prices.map((row) => [row.asset, toUnits(row.usd)]));
  expect(price.get('USDC')).toBe(SCALE);
  expect(price.get('USDT')).toBe(SCALE);
  expect(price.has('BTC')).toBe(false);

  // Read the venue's own balances directly (never from the page) and compute every grouping by hand.
  const allVenue = (await venueRecord(owner, '/balances')).value;
  const usdt = await venueBalance(owner, 'USDT');
  const usdc = await venueBalance(owner, 'USDC');
  const btc = await venueBalance(owner, 'BTC');
  expect(allVenue.map((b) => b.asset).sort()).toEqual(['BTC', 'USDC', 'USDT']);
  expect(toUnits(usdt.total)).toBe(toUnits(VENUE_USDT));
  expect(toUnits(usdt.locked)).toBe(toUnits(STAKED_USDT));
  expect(toUnits(usdt.lockedBy.staked)).toBe(toUnits(STAKED_USDT));
  expect(toUnits(usdt.free)).toBe(toUnits(VENUE_USDT) - toUnits(STAKED_USDT));
  expect(toUnits(usdc.locked)).toBe((toUnits(RESTING_BUY.amount) * toUnits(RESTING_BUY.price)) / SCALE);
  expect(toUnits(usdc.lockedBy.inOrders)).toBe(toUnits(usdc.locked));
  expect(toUnits(btc.total)).toBeGreaterThan(0n);

  const usdcVal = (toUnits(usdc.total) * price.get('USDC')) / SCALE;
  const usdtVal = (toUnits(usdt.total) * price.get('USDT')) / SCALE;
  const total = usdcVal + usdtVal;
  const earnVal = (toUnits(usdt.lockedBy.staked) * price.get('USDT')) / SCALE;
  const stableVal = usdcVal + (usdtVal - earnVal);
  const lockedVal = (toUnits(usdc.locked) * price.get('USDC')) / SCALE + (toUnits(usdt.locked) * price.get('USDT')) / SCALE;
  const availableVal = total - lockedVal;
  expect(earnVal + stableVal).toBe(total);
  expect(availableVal + lockedVal).toBe(total);

  await openMoney(page);
  await expect(page.getByTestId('assets-total').getByTestId('standing-figure')).toHaveAttribute('data-total-usd', fixedHalfUp(total, 2));

  const card = page.getByRole('region', { name: 'Where your money is', exact: true });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveAttribute('data-total-usd', fromUnits(total));

  // By coin: USDC and USDT each show their exact share of the total; BTC is named as unpriced.
  await card.getByRole('group', { name: 'Group by', exact: true }).getByRole('button', { name: 'Coin', exact: true }).click();
  await expect(card.locator('li[data-group]')).toHaveCount(2);
  for (const [asset, val] of [
    ['USDC', usdcVal],
    ['USDT', usdtVal],
  ]) {
    const shareText = pct(val, total);
    const li = card.locator(`li[data-group="${asset}"]`);
    await expect(li).toContainText(asset);
    await expect(li).toContainText(shareText);
    const row = card.locator(`tr[data-group-row="${asset}"]`);
    await expect(row).toHaveAttribute('data-value-usd', fromUnits(val));
    await expect(row.locator('td').first()).toHaveText(shareText);
  }
  await expect(card.getByText('Excludes 1 coin (no USD price)', { exact: true })).toBeVisible();

  // By kind: USDT and USDC as Dollar coins (stablecoin), staked USDT under Earn; groups sum to the total.
  await card.getByRole('group', { name: 'Group by', exact: true }).getByRole('button', { name: 'Kind', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Kind', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('li[data-group="stablecoin"]')).toContainText('Dollar coins');
  await expect(card.locator('li[data-group="stablecoin"]')).toContainText(pct(stableVal, total));
  await expect(card.locator('li[data-group="earn"]')).toContainText('Earn');
  await expect(card.locator('li[data-group="earn"]')).toContainText(pct(earnVal, total));
  const stableRow = card.locator('tr[data-group-row="stablecoin"]');
  const earnRow = card.locator('tr[data-group-row="earn"]');
  await expect(stableRow.locator('td').nth(0)).toHaveText(pct(stableVal, total));
  await expect(stableRow.locator('td').nth(1)).toContainText('USDT');
  await expect(stableRow.locator('td').nth(1)).toContainText('USDC');
  await expect(earnRow.locator('td').nth(0)).toHaveText(pct(earnVal, total));
  await expect(earnRow.locator('td').nth(1)).toContainText('USDT');
  const kindSum = sum(
    await Promise.all([stableRow.getAttribute('data-value-usd').then(toUnits), earnRow.getAttribute('data-value-usd').then(toUnits)]),
  );
  expect(kindSum).toBe(total);
  await card.scrollIntoViewIfNeeded();
  await stepPicture();

  // By place: Spendable (available) and Locked (open order + staked USDT); groups sum to the total.
  await card.getByRole('group', { name: 'Group by', exact: true }).getByRole('button', { name: 'Place', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Place', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('li[data-group="available"]')).toContainText('Spendable');
  await expect(card.locator('li[data-group="available"]')).toContainText(pct(availableVal, total));
  await expect(card.locator('li[data-group="locked"]')).toContainText('Locked');
  await expect(card.locator('li[data-group="locked"]')).toContainText(pct(lockedVal, total));
  const availRow = card.locator('tr[data-group-row="available"]');
  const lockedRow = card.locator('tr[data-group-row="locked"]');
  await expect(availRow).toHaveAttribute('data-value-usd', fromUnits(availableVal));
  await expect(availRow.locator('td').first()).toHaveText(pct(availableVal, total));
  await expect(lockedRow).toHaveAttribute('data-value-usd', fromUnits(lockedVal));
  await expect(lockedRow.locator('td').first()).toHaveText(pct(lockedVal, total));

  // INTAFACED holds none of it: the ledger holds nothing for this person.
  expect(await (await api(who)).balances()).toEqual(ledgerStart);
});

test(`${J} #3 reads holdings change over a period: each coin then and now, what rose and fell, from the venue's own balances, fills and credits`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const { account: who, owner, walletKey, setupLastAt, ledgerStart } = state();

  // Venue balances before the second buy: every coin entered within the last 7 days, so 7 days ago starts at 0.
  const before = {
    BTC: toUnits((await venueBalance(owner, 'BTC')).total),
    USDC: toUnits((await venueBalance(owner, 'USDC')).total),
    USDT: toUnits((await venueBalance(owner, 'USDT')).total),
  };
  const fillsBefore = (await venueRecord(owner, '/fills', { since: new Date(0).toISOString() })).value;
  expect(fillsBefore.length).toBe(1);

  await openMoney(page);
  const card = page.getByRole('region', { name: 'What you hold, then and now', exact: true });
  await card.getByRole('group', { name: 'Compare with', exact: true }).getByRole('button', { name: '7 days ago', exact: true }).click();
  await expect(card.getByRole('button', { name: '7 days ago', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const asset of ['BTC', 'USDC', 'USDT']) {
    const row = card.locator(`tr[data-change-asset="${asset}"]`);
    await expect(row).toHaveAttribute('data-start', '0', { timeout: 30_000 });
    await expect(row).toHaveAttribute('data-end', fromUnits(before[asset]));
    await expect(row).toHaveAttribute('data-change', fromUnits(before[asset]));
    await expect(row.locator('td').nth(0)).toHaveText('No holding yet');
    await expect(row.locator('td').nth(2)).toHaveText(new RegExp(`^\\+[\\d,.]+ ${asset}$`));
    await expect(row.locator('td').nth(3)).toHaveText('—');
    await expect(row.locator('td').nth(4)).toHaveText(asset === 'BTC' ? 'Not priced' : dollars(before[asset]));
  }

  // Second TEST buy of 0.001 BTC with USDC on the venue: BTC rises and USDC falls.
  const seller2 = `${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}-${owner.slice(2, 10)}-s2`;
  await testVenue('/test/deposit', {
    account: await venueAccount(otherTraderKey(seller2).address),
    asset: 'BTC',
    amount: '1',
    depositRef: `seed:${seller2}:BTC`,
  });
  const ask2 = await otherTraderRun(seller2, order(otherTraderKey(seller2).address.toLowerCase(), 'sell', SECOND_BUY, 'GTC', 'ask2'));
  expect(ask2.definite && ask2.accepted, JSON.stringify(ask2)).toBe(true);
  await signedOnVenue(walletKey, order(owner, 'buy', SECOND_BUY, 'IOC', 'buy2'));
  await expect.poll(async () => (await venueRecord(owner, '/fills', { since: new Date(0).toISOString() })).value.length).toBe(2);

  const fillsAfter = (await venueRecord(owner, '/fills', { since: new Date(0).toISOString() })).value;
  const secondFill = fillsAfter.at(-1);
  const secondFillAt = Date.parse(secondFill.filledAt);
  expect(secondFillAt).toBeGreaterThan(setupLastAt);
  const after = {
    BTC: toUnits((await venueBalance(owner, 'BTC')).total),
    USDC: toUnits((await venueBalance(owner, 'USDC')).total),
    USDT: toUnits((await venueBalance(owner, 'USDT')).total),
  };
  const roseBtc = after.BTC - before.BTC;
  const fellUsdc = before.USDC - after.USDC;
  expect(roseBtc).toBe(toUnits(secondFill.amount) - toUnits(secondFill.venueFee) - toUnits(secondFill.builderFee));
  expect(fellUsdc).toBe((toUnits(secondFill.price) * toUnits(secondFill.amount) + SCALE - 1n) / SCALE);
  expect(after.USDT).toBe(before.USDT);

  // Pin the browser's clock (only the browser's: the venue keeps real time) to 24 hours past a moment strictly
  // between setup and the second buy, so "24 hours ago" begins after setup and before the second buy: BTC rose (+),
  // USDC fell (−), and USDT stayed flat.
  const between = setupLastAt + 1;
  expect(between).toBeLessThanOrEqual(secondFillAt);
  await page.clock.setFixedTime(new Date(between + DAY));
  await openMoney(page, { fresh: false });
  const day = page.getByRole('region', { name: 'What you hold, then and now', exact: true });
  await day.getByRole('group', { name: 'Compare with', exact: true }).getByRole('button', { name: '24 hours ago', exact: true }).click();
  await expect(day.getByRole('button', { name: '24 hours ago', exact: true })).toHaveAttribute('aria-pressed', 'true');

  const btcRow = day.locator('tr[data-change-asset="BTC"]');
  await expect(btcRow).toHaveAttribute('data-start', fromUnits(before.BTC), { timeout: 30_000 });
  await expect(btcRow).toHaveAttribute('data-end', fromUnits(after.BTC));
  await expect(btcRow).toHaveAttribute('data-change', fromUnits(roseBtc));
  await expect(btcRow.locator('td').nth(0)).toHaveText(/^[\d,.]+ BTC$/);
  await expect(btcRow.locator('td').nth(2)).toHaveText(/^\+[\d,.]+ BTC$/);
  await expect(btcRow.locator('td').nth(3)).toHaveText('Not priced');
  await expect(btcRow.locator('td').nth(4)).toHaveText('Not priced');

  const usdcRow = day.locator('tr[data-change-asset="USDC"]');
  await expect(usdcRow).toHaveAttribute('data-start', fromUnits(before.USDC));
  await expect(usdcRow).toHaveAttribute('data-end', fromUnits(after.USDC));
  await expect(usdcRow).toHaveAttribute('data-change', fromUnits(-fellUsdc));
  await expect(usdcRow.locator('td').nth(0)).toHaveText(/^[\d,.]+ USDC$/);
  await expect(usdcRow.locator('td').nth(2)).toHaveText(/^−[\d,.]+ USDC$/);
  await expect(usdcRow.locator('td').nth(3)).toHaveText(dollars(before.USDC));
  await expect(usdcRow.locator('td').nth(4)).toHaveText(dollars(after.USDC));

  const usdtRow = day.locator('tr[data-change-asset="USDT"]');
  await expect(usdtRow).toHaveAttribute('data-start', fromUnits(before.USDT));
  await expect(usdtRow).toHaveAttribute('data-end', fromUnits(after.USDT));
  await expect(usdtRow).toHaveAttribute('data-change', '0');
  await expect(usdtRow.locator('td').nth(3)).toHaveText(dollars(before.USDT));
  await expect(usdtRow.locator('td').nth(4)).toHaveText(dollars(after.USDT));

  await day.scrollIntoViewIfNeeded();
  await stepPicture();

  expect(await (await api(who)).balances()).toEqual(ledgerStart);
});
