// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { closedMinute, utcDay } from './clock.mjs';
import { ownSpotMarket, venueListingWrite } from './own-market.mjs';
import { api, fromUnits, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  openVenueDesk,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
  venueRunState,
  walletDoorAct,
} from './venue.mjs';
import { fmtLotUsd, fundedCounterparty, placeVenueLimit, restVenueLimit, venueFillsOf } from './venue-lots.mjs';

// J-portfolio-04, in the running app against the stack's TEST venue simulator (docs/roadmap/journeys.json): "I control
// how my cost basis is worked out". At launch a person trades, deposits and stakes in their own venue account, never on
// our own book, so every trade, arrival and staking reward here is on the person's own venue account, and every expected
// figure is a hand count from the venue's own record (`venueRecord`, `venueBalance`, `testVenue`), never from the lot
// book itself. One test per step, titled "J-portfolio-04 #<n>", run in order on one TEST account and wallet; #2 (moving
// 1 TEST BTC to a venue sub-account) is J-portfolio-04-venue.pw.mjs's. The door is on for this file only.
const J = 'J-portfolio-04';
const FUNDS = '5000';
/**
 * TEST buys on this file's own spot market: older lot at 80 (5 coins) and newer lot at 50 (6 coins), so FIFO and HIFO
 * draw from the older lot while LIFO draws from the newer lot, and AVERAGE sits between them. Two sales of 2 coins in #4
 * and #5 fit inside the older lot (4.99825 after the 3.5 bps coin fee), so neither spills across lots under any method.
 */
const BUY_1 = { amount: '5', price: '80' };
const BUY_2 = { amount: '6', price: '50' };
const SALE_1 = { amount: '2', price: '100' };
const SALE_2 = { amount: '2', price: '110' };
const DEPOSIT_QTY = '4';
const SALE_3 = { amount: '8', price: '95' };
const HYPE = 'HYPE';
const HYPE_BUY = { amount: '10', price: '25' };
const HYPE_REWARD = '0.2';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ONE = toUnits('1');

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

/** What a venue buy paid: price times amount, rounded up as the venue settles it, plus any fee in USDC. */
function buyCostOf(f) {
  const notional = (toUnits(f.price) * toUnits(f.amount) + ONE - 1n) / ONE;
  return notional + (f.feeAsset === 'USDC' ? toUnits(f.venueFee) + toUnits(f.builderFee) : 0n);
}
/** What a venue buy brought in: the amount less any fee the venue took in the coin received. */
const buyQtyOf = (f, base) => toUnits(f.amount) - (f.feeAsset === base ? toUnits(f.venueFee) + toUnits(f.builderFee) : 0n);
/** What a venue sale paid: price times amount, rounded up as the venue settles it, less any fee in USDC. */
function sellProceedsOf(f) {
  const notional = (toUnits(f.price) * toUnits(f.amount) + ONE - 1n) / ONE;
  return notional - (f.feeAsset === 'USDC' ? toUnits(f.venueFee) + toUnits(f.builderFee) : 0n);
}

/** A lot's acquired time as the lots list writes a date and time on this device (Pnl.tsx `stamp`). */
const writtenTime = (page, iso) =>
  page.evaluate((at) => {
    const text = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
      .format(Date.parse(at))
      .replace(',', '');
    return `${text.slice(0, text.lastIndexOf(' '))}, ${text.slice(text.lastIndexOf(' ') + 1)}`;
  }, iso);

async function lotsPage(page, asset) {
  await page.goto('/money/pnl');
  const lots = page.getByRole('region', { name: 'Lots', exact: true });
  await expect(lots).toBeVisible({ timeout: 30_000 });
  const picker = lots.getByLabel('Coin for lots', { exact: true });
  if ((await picker.inputValue()) !== asset) {
    await picker.selectOption(asset);
    await expect(page).toHaveURL(new RegExp(`asset=${asset}`));
  }
  return lots;
}

/** The lot engine's share: cost * take / qty, cut at the ledger's 18 places; the whole lot when all of it is taken. */
const share = (cost, qty, take) => (take === qty ? cost : (cost * take) / qty);

/** What one sale of `take` costs under each method, from two open lots [{ cost, qty }] (oldest first). */
function costBy(method, lots, take) {
  const [a, b] = lots;
  if (method === 'FIFO') return share(a.cost, a.qty, take);
  if (method === 'LIFO') return share(b.cost, b.qty, take);
  if (method === 'HIFO') return a.cost * b.qty >= b.cost * a.qty ? share(a.cost, a.qty, take) : share(b.cost, b.qty, take);
  return share(a.cost + b.cost, a.qty + b.qty, take); // AVERAGE
}

/** FIFO by hand, as the lot engine draws it: each sale takes the oldest lot's share, then the next. Returns the lots left. */
function fifoLeft(lots, takes) {
  const open = lots.map((lot) => ({ ...lot }));
  for (let take of takes) {
    while (take > 0n && open.length > 0) {
      const lot = open[0];
      const part = take < lot.qty ? take : lot.qty;
      const cost = share(lot.cost, lot.qty, part);
      lot.cost -= cost;
      lot.qty -= part;
      take -= part;
      if (lot.qty === 0n) open.shift();
    }
  }
  return open;
}

/** The venue's own last 1-minute candle that opened at or before `arrivedAt`, read straight from the TEST venue. */
async function venueCandleAt(owner, symbol, arrivedAt) {
  const at = Date.parse(arrivedAt);
  const candles = (await venueRecord(owner, '/candles', { symbol, interval: '1m', limit: 50 })).value;
  const candle = candles.filter((c) => Date.parse(c.openAt) <= at).at(-1);
  expect(candle, `a 1m venue candle on ${symbol} at or before ${arrivedAt}`).toBeTruthy();
  return candle;
}

/**
 * TEST setup, not a journey step: one verified account, this run's TEST wallet key, TEST USDC in its venue account, and
 * a fresh TEST spot market of this file's own.
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account && run.read().symbol) return;
  test.setTimeout(360_000);
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'pf4');
    await verify(page, account);
    const walletKey = testWalletKey();
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', FUNDS, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    expect(toUnits((await venueBalance(owner, 'USDC')).free)).toBe(toUnits(FUNDS));
    const { symbol, base } = await ownSpotMarket(J, 'PF4', 'A');
    run.reset({ account, walletKey, symbol, base });
  } finally {
    await page.close();
  }
});

test(`${J} #1 opens the lots list for an asset: each lot with acquired date, quantity, basis and source`, async ({ page, stepPicture }) => {
  test.setTimeout(420_000);
  const s = venueRunState(run, J);
  const { id: venueId } = await venueInfo();
  const MAIN = `venue:${venueId}:${s.owner}`;
  // Another TEST trader rests two sells at two distinct prices (80 then 50), so each buy opens its own lot at its own price.
  const seller = await fundedCounterparty(J, s.owner, 'ask1', s.base, '20');
  const since = new Date(Date.now() - 1_000).toISOString();
  const wallet = await openVenueDesk(page, s.account, `/trade/spot/${s.symbol}`, s.walletKey);
  expect(wallet.address.toLowerCase()).toBe(s.owner);

  for (const [i, buy] of [BUY_1, BUY_2].entries()) {
    await restVenueLimit(seller, s.symbol, 'sell', buy.amount, buy.price, `pf4-ask-${i}`);
    await placeVenueLimit(page, 'buy', buy.price, buy.amount, s.base);
    await expect.poll(async () => (await venueFillsOf(s.owner, s.symbol, 'buy', since)).length, { timeout: 30_000 }).toBe(i + 1);
  }
  // By hand from the venue's own fills and balances: quantity after the coin fee, dollar cost, and exact fill times.
  const fills = await venueFillsOf(s.owner, s.symbol, 'buy', since);
  expect(fills).toHaveLength(2);
  expect(Date.parse(fills[0].filledAt)).toBeLessThan(Date.parse(fills[1].filledAt));
  const buys = fills.map((f) => ({
    fillId: f.fillId,
    filledAt: f.filledAt,
    qty: buyQtyOf(f, s.base),
    cost: buyCostOf(f),
  }));
  expect(toUnits((await venueBalance(s.owner, s.base)).total)).toBe(buys[0].qty + buys[1].qty);
  run.write({
    buys: buys.map((b) => ({ fillId: b.fillId, filledAt: b.filledAt, cost: fromUnits(b.cost), qty: fromUnits(b.qty) })),
  });

  const lots = await lotsPage(page, s.base);
  const rows = lots.locator('tbody tr');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  for (const [i, b] of buys.entries()) {
    const row = rows.nth(i);
    await expect(row).toHaveAttribute('data-lot', `lot:${MAIN}:${b.fillId}:${s.base}`);
    await expect(row.locator('th')).toHaveText(await writtenTime(page, b.filledAt));
    await expect(row.locator('[data-col="source"]')).toHaveText('Bought');
    await expect(row.locator('[data-col="account"]')).toHaveAttribute('data-venue', MAIN);
    await expect(row.locator('[data-col="qty"]')).toHaveText(fromUnits(b.qty));
    await expect(row.locator('[data-col="left"]')).toHaveText(fromUnits(b.qty));
    await expect(row.locator('[data-col="cost"]')).toHaveText(fmtLotUsd(b.cost));
    await expect(row.locator('[data-col="days"]')).toHaveText('0');
  }
  await expect(lots).toContainText('Short or long term is not shown');
  await stepPicture();
});

// Steps 4 and 5 run before the deposit of step 3, so every lot of `base` they draw on was bought and every method can be
// worked out by hand. Step 5 puts the choices back to FIFO with no pick, which steps 6 and 7 count on.
test(`${J} #4 chooses FIFO, LIFO, HIFO or average cost for an account or an asset: realised and remainder change to the hand-computed figures`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(420_000);
  const s = venueRunState(run, J);
  const { id: venueId } = await venueInfo();
  const MAIN = `venue:${venueId}:${s.owner}`;
  const buys = s.buys.map((b) => ({ cost: toUnits(b.cost), qty: toUnits(b.qty) }));
  const totalCost = buys[0].cost + buys[1].cost;
  const take = toUnits(SALE_1.amount);

  const buyer = await fundedCounterparty(J, s.owner, 'bid4', 'USDC', '5000');
  await restVenueLimit(buyer, s.symbol, 'buy', SALE_1.amount, SALE_1.price, 'pf4-bid-1');
  const beforeBal = toUnits((await venueBalance(s.owner, s.base)).total);
  const since = new Date(Date.now() - 1_000).toISOString();
  await openVenueDesk(page, s.account, `/trade/spot/${s.symbol}`, s.walletKey);
  await placeVenueLimit(page, 'sell', SALE_1.price, SALE_1.amount, s.base);
  await expect.poll(async () => (await venueFillsOf(s.owner, s.symbol, 'sell', since)).length, { timeout: 30_000 }).toBe(1);
  const sells = await venueFillsOf(s.owner, s.symbol, 'sell', since);
  expect(beforeBal - toUnits((await venueBalance(s.owner, s.base)).total)).toBe(take);
  const proceeds = sells.reduce((sum, f) => sum + sellProceedsOf(f), 0n);
  run.write({ sale1: fromUnits(proceeds) });

  const expectMethod = async (method, source) => {
    const cost = costBy(method, buys, take);
    const sale = page.getByRole('region', { name: 'Sales', exact: true }).locator('tr[data-sale]').first();
    await expect(sale.locator('[data-col="method"] [data-method]')).toHaveAttribute('data-method', method);
    await expect(sale.locator('[data-col="method"]')).toContainText(source);
    await expect(sale.locator('td').nth(2)).toHaveText(fmtLotUsd(cost));
    await expect(sale.locator('[data-col="result"]')).toHaveText(fmtLotUsd(proceeds - cost, true));
    await expect(page.locator(`tr[data-asset="${s.base}"][data-venue="${MAIN}"] [data-col="cost"]`)).toHaveText(
      fmtLotUsd(totalCost - cost),
    );
  };

  await lotsPage(page, s.base);
  await expectMethod('FIFO', '(standard)');
  const choices = page.getByRole('region', { name: 'Your matching choices', exact: true });
  await choices.getByRole('combobox', { name: 'Method for all coins', exact: true }).selectOption('LIFO');
  await expect(choices.getByRole('status')).toHaveText('Saved. The figures above use it.');
  await expectMethod('LIFO', '(your method for all coins)');
  const coin = page.getByRole('region', { name: 'Lots', exact: true }).getByRole('combobox', { name: `Method for ${s.base}`, exact: true });
  for (const method of ['HIFO', 'AVERAGE', 'FIFO']) {
    await coin.selectOption(method);
    await expectMethod(method, '(your method for this coin)');
  }
  await page.reload();
  await expectMethod('FIFO', '(your method for this coin)');
  await stepPicture();
  await coin.selectOption('');
  await expectMethod('LIFO', '(your method for all coins)');
});

test(`${J} #5 picks the lot for one sale and overrides a day: that sale uses that lot, the other keeps its method`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(420_000);
  const s = venueRunState(run, J);
  const { id: venueId } = await venueInfo();
  const MAIN = `venue:${venueId}:${s.owner}`;
  const buys = s.buys.map((b) => ({ cost: toUnits(b.cost), qty: toUnits(b.qty) }));
  const proceeds1 = toUnits(s.sale1);
  const take = toUnits(SALE_2.amount);

  const buyer = await fundedCounterparty(J, s.owner, 'bid5', 'USDC', '5000');
  await restVenueLimit(buyer, s.symbol, 'buy', SALE_2.amount, SALE_2.price, 'pf4-bid-2');
  const beforeBal = toUnits((await venueBalance(s.owner, s.base)).total);
  const since = new Date(Date.now() - 1_000).toISOString();
  await openVenueDesk(page, s.account, `/trade/spot/${s.symbol}`, s.walletKey);
  await placeVenueLimit(page, 'sell', SALE_2.price, SALE_2.amount, s.base);
  await expect.poll(async () => (await venueFillsOf(s.owner, s.symbol, 'sell', since)).length, { timeout: 30_000 }).toBe(1);
  const sells = await venueFillsOf(s.owner, s.symbol, 'sell', since);
  expect(beforeBal - toUnits((await venueBalance(s.owner, s.base)).total)).toBe(take);
  const proceeds2 = sells.reduce((sum, f) => sum + sellProceedsOf(f), 0n);
  run.write({ sale2: fromUnits(proceeds2) });

  await lotsPage(page, s.base);
  const sales = page.getByRole('region', { name: 'Sales', exact: true }).locator('tr[data-sale]');
  await expect(sales).toHaveCount(2, { timeout: 30_000 });
  const [newest, oldest] = [sales.nth(0), sales.nth(1)];

  // Pick the older lot (price 80) for the newest sale while the account method is LIFO (price 50).
  const oldLot = await page.getByRole('region', { name: 'Lots', exact: true }).locator('tbody tr').first().getAttribute('data-lot');
  await newest.getByRole('combobox', { name: 'Lot for this sale', exact: true }).selectOption(oldLot);
  const lifoCost = share(buys[1].cost, buys[1].qty, take);
  const pickedCost = share(buys[0].cost, buys[0].qty, take);
  await expect(newest.locator('td').nth(2)).toHaveText(fmtLotUsd(pickedCost));
  await expect(newest.locator('[data-col="result"]')).toHaveText(fmtLotUsd(proceeds2 - pickedCost, true));
  await expect(oldest.locator('[data-col="method"] [data-method]')).toHaveAttribute('data-method', 'LIFO');
  await expect(oldest.locator('[data-col="result"]')).toHaveText(fmtLotUsd(proceeds1 - lifoCost, true));

  // Override today (UTC) to HIFO (price 80): the other sale switches from LIFO to HIFO; the picked sale still uses its lot.
  const choices = page.getByRole('region', { name: 'Your matching choices', exact: true });
  const day = utcDay(Date.now());
  await choices.getByLabel('Day (UTC)', { exact: true }).fill(day);
  await choices.getByRole('combobox', { name: 'Method for that day', exact: true }).selectOption('HIFO');
  await choices.getByRole('button', { name: 'Save day method', exact: true }).click();
  await expect(choices.getByRole('list', { name: 'Saved day methods', exact: true })).toContainText(`${day} · All coins · HIFO`);
  const hifoCost = costBy('HIFO', buys, take);
  await expect(oldest.locator('[data-col="method"] [data-method]')).toHaveAttribute('data-method', 'HIFO');
  await expect(oldest.locator('[data-col="method"]')).toContainText('(your method for that day)');
  await expect(oldest.locator('[data-col="result"]')).toHaveText(fmtLotUsd(proceeds1 - hifoCost, true));
  const left0 = { cost: buys[0].cost - hifoCost, qty: buys[0].qty - take };
  await expect(newest.locator('td').nth(2)).toHaveText(fmtLotUsd(share(left0.cost, left0.qty, take)));
  await stepPicture();

  // Put choices back to FIFO with no pick and no day method, ready for steps 6 and 7.
  await choices.getByRole('list', { name: 'Saved day methods', exact: true }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(choices.getByRole('list', { name: 'Saved day methods', exact: true })).toHaveCount(0);
  await newest.getByRole('combobox', { name: 'Lot for this sale', exact: true }).selectOption('');
  await choices.getByRole('combobox', { name: 'Method for all coins', exact: true }).selectOption('FIFO');
  await expect(choices.getByRole('status')).toHaveText('Saved. The figures above use it.');
  const fifo1 = share(buys[0].cost, buys[0].qty, take);
  await expect(oldest.locator('[data-col="method"] [data-method]')).toHaveAttribute('data-method', 'FIFO');
  await expect(oldest.locator('[data-col="result"]')).toHaveText(fmtLotUsd(proceeds1 - fifo1, true));
  const left = fifoLeft(buys, [take, take]);
  const leftCost = left.reduce((sum, lot) => sum + lot.cost, 0n);
  await expect(newest.locator('[data-col="method"] [data-method]')).toHaveAttribute('data-method', 'FIFO');
  await expect(page.locator(`tr[data-asset="${s.base}"][data-venue="${MAIN}"] [data-col="cost"]`)).toHaveText(fmtLotUsd(leftCost));
});

test(`${J} #3 reads a deposit and a reward: each valued at the time it arrived, with the price source named`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(480_000);
  const s = venueRunState(run, J);
  const { id: venueId } = await venueInfo();
  const MAIN = `venue:${venueId}:${s.owner}`;
  const RUN = process.env.JOURNEY_RUN_ID ?? `local-${Date.now()}`;

  // 1. A deposit of 4 TEST coins into the person's venue account, valued from the venue's own 1-minute spot candles.
  const depRef = `84532:0x${randomBytes(32).toString('hex')}:0`;
  expect(await testDeposit(s.owner, s.base, DEPOSIT_QTY, depRef)).toBe(true);
  const arrivals = (await venueRecord(s.owner, '/arrivals')).value;
  const depArrival = arrivals.find((a) => a.arrivalId === depRef);
  expect(depArrival, JSON.stringify(arrivals)).toMatchObject({ arrivalId: depRef, kind: 'deposit', asset: s.base, amount: DEPOSIT_QTY });
  await closedMinute(page, Date.parse(depArrival.arrivedAt));
  const depCandle = await venueCandleAt(s.owner, s.symbol, depArrival.arrivedAt);
  expect(Date.parse(depCandle.openAt)).toBeLessThanOrEqual(Date.parse(depArrival.arrivedAt));
  const depExpected = fmtLotUsd((toUnits(DEPOSIT_QTY) * toUnits(depCandle.closePrice) + ONE / 2n) / ONE);

  await signIn(page, s.account);
  const lots = await lotsPage(page, s.base);
  const depRow = lots.locator('tbody tr[data-source="deposit"]');
  await expect(depRow).toHaveCount(1, { timeout: 30_000 });
  await expect(depRow.locator('th')).toHaveText(await writtenTime(page, depArrival.arrivedAt));
  await expect(depRow.locator('[data-col="source"]')).toHaveText('Deposit');
  await expect(depRow.locator('[data-col="qty"]')).toHaveText(DEPOSIT_QTY);
  await expect(depRow.locator('[data-col="cost"]')).toHaveText('Cost unknown');
  const depSource = `at the ${s.symbol} price, one-minute candle from ${await writtenTime(page, depCandle.openAt)}`;
  await expect(depRow.locator('[data-col="price-source"]')).toHaveText(depSource);
  await expect(depRow.locator('[data-col="arrival"]')).toHaveText(`${depExpected} ${depSource}`);
  await expect(lots.locator('tbody tr[data-source="trade"] [data-col="cost"]').first()).not.toHaveText('Cost unknown');
  await expect(page.locator(`tr[data-asset="${s.base}"][data-venue="${MAIN}"] [data-col="cost"]`)).toHaveText('Not known');

  // 2. A staking reward on the venue (HYPE): ensure the venue lists its dollar spot market, print a fill so it has a
  // venue candle, stake and delegate HYPE signed in the person's wallet, and receive a TEST staking reward.
  const hypeSymbol = `${HYPE}-USDC`;
  const listed = (await testVenue('/markets', {})).body.value.some((m) => m.symbol === hypeSymbol);
  if (!listed) {
    const added = await testVenue('/test/market-add', {
      symbol: hypeSymbol,
      baseAsset: HYPE,
      quoteAsset: 'USDC',
      maxOrderQty: null,
      maxOrderNotional: null,
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    await venueListingWrite(
      J,
      hypeSymbol,
      'trade.venue_listing_set',
      'listingSet',
      { opensAt: new Date(Date.now() - 60_000).toISOString() },
      '0',
    );
  }
  const hypeSeller = await fundedCounterparty(J, s.owner, 'hype3', HYPE, HYPE_BUY.amount);
  await restVenueLimit(hypeSeller, hypeSymbol, 'sell', HYPE_BUY.amount, HYPE_BUY.price, 'pf4-hype-ask');
  const hypeSince = new Date(Date.now() - 1_000).toISOString();
  await openVenueDesk(page, s.account, `/trade/spot/${hypeSymbol}`, s.walletKey);
  await placeVenueLimit(page, 'buy', HYPE_BUY.price, HYPE_BUY.amount, HYPE);
  await expect.poll(async () => (await venueFillsOf(s.owner, hypeSymbol, 'buy', hypeSince)).length, { timeout: 30_000 }).toBe(1);
  const hypeBeforeReward = toUnits((await venueBalance(s.owner, HYPE)).total);

  const terms = (await testVenue('/staking', {})).body.value;
  const validator = terms.validators[0];
  expect(validator, JSON.stringify(terms)).toBeTruthy();
  const session = await api(s.account);
  const key = privateKeyToAccount(s.walletKey);
  await walletDoorAct(session, key, {
    intent: { kind: 'staking_transfer', direction: 'to_staking', asset: HYPE, amount: '5', moveKey: `pf4-stake:${RUN}` },
  });
  await walletDoorAct(session, key, {
    intent: {
      kind: 'staking_delegate',
      validator: validator.address,
      direction: 'delegate',
      asset: HYPE,
      amount: '5',
      moveKey: `pf4-delegate:${RUN}`,
    },
  });
  const rewarded = await testVenue('/test/staking', {
    account: await venueAccount(s.owner),
    reward: { validator: validator.address, amount: HYPE_REWARD, rewardRef: `pf4-reward:${RUN}` },
  });
  expect(rewarded.status, JSON.stringify(rewarded.body)).toBe(200);
  const stakingRecord = (await venueRecord(s.owner, '/staking-account')).value;
  expect(toUnits(stakingRecord.rewards.total)).toBe(toUnits(HYPE_REWARD));
  const rewardRec = stakingRecord.rewards.recent[0];
  expect(rewardRec, JSON.stringify(stakingRecord.rewards)).toBeTruthy();
  expect(toUnits((await venueBalance(s.owner, HYPE)).total)).toBe(hypeBeforeReward + toUnits(HYPE_REWARD));
  await closedMinute(page, Date.parse(rewardRec.rewardedAt));
  const rewardCandle = await venueCandleAt(s.owner, hypeSymbol, rewardRec.rewardedAt);
  expect(Date.parse(rewardCandle.openAt)).toBeLessThanOrEqual(Date.parse(rewardRec.rewardedAt));
  const rewardExpected = fmtLotUsd((toUnits(HYPE_REWARD) * toUnits(rewardCandle.closePrice) + ONE / 2n) / ONE);

  const hypeLots = await lotsPage(page, HYPE);
  const rewardRow = hypeLots.locator('tbody tr[data-source="reward"]');
  await expect(rewardRow).toHaveCount(1, { timeout: 30_000 });
  await expect(rewardRow.locator('th')).toHaveText(await writtenTime(page, rewardRec.rewardedAt));
  await expect(rewardRow.locator('[data-col="source"]')).toHaveText('Reward');
  await expect(rewardRow.locator('[data-col="qty"]')).toHaveText(HYPE_REWARD);
  await expect(rewardRow.locator('[data-col="cost"]')).toHaveText('Cost unknown');
  const rewardSource = `at the ${hypeSymbol} price, one-minute candle from ${await writtenTime(page, rewardCandle.openAt)}`;
  await expect(rewardRow.locator('[data-col="price-source"]')).toHaveText(rewardSource);
  await expect(rewardRow.locator('[data-col="arrival"]')).toHaveText(`${rewardExpected} ${rewardSource}`);
  await stepPicture();

  // Enter the arrival price for the HYPE reward lot so the `base` deposit is the one missing-cost lot for steps 6 and 7.
  const rewardLot = await rewardRow.getAttribute('data-lot');
  const item = page.getByRole('region', { name: 'Missing cost', exact: true }).locator(`li[data-missing-lot="${rewardLot}"]`);
  await item.getByRole('button', { name: 'Enter a cost', exact: true }).click();
  const form = item.getByRole('form', { name: 'Enter a cost for this lot', exact: true });
  await form.getByLabel(`Price you paid per ${HYPE}, in USD`, { exact: true }).fill(rewardCandle.closePrice);
  await form.getByLabel('Where this price comes from', { exact: true }).fill('TEST the venue HYPE-USDC price when the reward arrived');
  await form.getByRole('button', { name: 'Save price', exact: true }).click();
  await expect(page.getByTestId('basis-notice')).toHaveText('Price saved. The figures use it, marked customer-entered.');
  await expect(item).toHaveCount(0);
});

test(`${J} #6 sells into a lot with no basis: a warning naming the lot and "unknown share" in the effect row`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(420_000);
  const s = venueRunState(run, J);
  const buys = s.buys.map((b) => ({ cost: toUnits(b.cost), qty: toUnits(b.qty) }));
  const bought = fifoLeft(buys, [toUnits(SALE_1.amount), toUnits(SALE_2.amount)]).reduce((sum, lot) => sum + lot.qty, 0n);
  const part = toUnits(SALE_3.amount) - bought;
  expect(part).toBeGreaterThan(0n);
  expect(part).toBeLessThan(toUnits(DEPOSIT_QTY));

  const buyer = await fundedCounterparty(J, s.owner, 'bid6', 'USDC', '5000');
  await restVenueLimit(buyer, s.symbol, 'buy', SALE_3.amount, SALE_3.price, 'pf4-bid-3');
  const beforeBal = toUnits((await venueBalance(s.owner, s.base)).total);
  const since = new Date(Date.now() - 1_000).toISOString();
  await openVenueDesk(page, s.account, `/trade/spot/${s.symbol}`, s.walletKey);
  await placeVenueLimit(page, 'sell', SALE_3.price, SALE_3.amount, s.base);
  await expect.poll(async () => (await venueFillsOf(s.owner, s.symbol, 'sell', since)).length, { timeout: 30_000 }).toBe(1);
  const sells = await venueFillsOf(s.owner, s.symbol, 'sell', since);
  expect(beforeBal - toUnits((await venueBalance(s.owner, s.base)).total)).toBe(toUnits(SALE_3.amount));
  const proceeds = sells.reduce((sum, f) => sum + sellProceedsOf(f), 0n);
  run.write({ sold: SALE_3.amount, part: fromUnits(part), proceeds: fromUnits(proceeds) });

  const lots = await lotsPage(page, s.base);
  const missing = page.getByRole('region', { name: 'Missing cost', exact: true });
  await expect(missing).toBeVisible({ timeout: 30_000 });
  const depositLot = await lots.locator('tbody tr[data-source="deposit"]').getAttribute('data-lot');
  const item = missing.locator(`li[data-missing-lot="${depositLot}"]`);
  await expect(item).toContainText('Deposit on');
  await expect(item).toContainText(`${fromUnits(toUnits(DEPOSIT_QTY) - part)} ${s.base} with no cost`);
  await expect(item.locator('[data-effect="unknown-share"]')).toHaveText(`Unknown share: ${fromUnits(part)} ${s.base} sold with no cost`);
  const sale = page.getByRole('region', { name: 'Sales', exact: true }).locator('tr[data-sale]').first();
  await expect(sale.locator('td').nth(0)).toHaveText(SALE_3.amount);
  await expect(sale.locator('td').nth(1)).toHaveText(fmtLotUsd(proceeds));
  await expect(sale.locator('[data-col="result"]')).toContainText('Cost unknown');
  await expect(sale.locator('[data-effect="unknown-share"]')).toHaveText(`Unknown share: ${fromUnits(part)} ${s.base} sold with no cost`);
  await stepPicture();
});

test(`${J} #7 enters an entry price for that lot: the result recomputes, marked customer-entered, and the original unknown stays on record`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const s = venueRunState(run, J);
  const { proceeds, part } = s;
  const buys = s.buys.map((b) => ({ cost: toUnits(b.cost), qty: toUnits(b.qty) }));
  const boughtCost = fifoLeft(buys, [toUnits(SALE_1.amount), toUnits(SALE_2.amount)]).reduce((sum, lot) => sum + lot.cost, 0n);
  const PRICE = '61.5';
  const venueBefore = await venueBalance(s.owner, s.base);

  await signIn(page, s.account);
  const lots = await lotsPage(page, s.base);
  const missing = page.getByRole('region', { name: 'Missing cost', exact: true });
  await missing.getByRole('button', { name: 'Enter a cost', exact: true }).click();
  const form = missing.getByRole('form', { name: 'Enter a cost for this lot', exact: true });
  await expect(form).toContainText('Our record: cost unknown.');
  // A blank note is refused before anything is sent.
  await form.getByLabel(`Price you paid per ${s.base}, in USD`, { exact: true }).fill(PRICE);
  await form.getByRole('button', { name: 'Save price', exact: true }).click();
  await expect(form.getByRole('status')).toHaveText('Say where this price comes from, for example the receipt of the purchase.');
  await form.getByLabel('Where this price comes from', { exact: true }).fill('TEST receipt from an earlier purchase');
  await form.getByRole('button', { name: 'Save price', exact: true }).click();
  await expect(page.getByTestId('basis-notice')).toHaveText('Price saved. The figures use it, marked customer-entered.');

  const lot = lots.locator('tbody tr[data-source="deposit"]');
  await expect(lot.locator('[data-col="cost"]')).toContainText(fmtLotUsd((toUnits(DEPOSIT_QTY) * toUnits(PRICE)) / ONE));
  await expect(lot.locator('[data-col="cost"] [data-label="customer-entered"]')).toContainText(
    'Customer-entered · our record: cost unknown',
  );
  const cost = boughtCost + (toUnits(part) * toUnits(PRICE)) / ONE;
  const sale = page.getByRole('region', { name: 'Sales', exact: true }).locator('tr[data-sale]').first();
  await expect(sale.locator('td').nth(2)).toHaveText(fmtLotUsd(cost));
  await expect(sale.locator('[data-col="result"]')).toContainText(fmtLotUsd(toUnits(proceeds) - cost, true));
  await expect(sale.locator('[data-col="result"] [data-label="customer-entered"]')).toHaveText('Customer-entered');
  await expect(page.getByRole('region', { name: 'Missing cost', exact: true })).toHaveCount(0);
  await stepPicture();

  // Taking the price back: the lot's cost is unknown again, the sale's result with it, and the venue's own balance is untouched.
  await lot.getByRole('button', { name: 'Remove my price', exact: true }).click();
  await expect(page.getByTestId('basis-notice')).toHaveText('Price removed. That lot’s cost is unknown again.');
  await expect(lot.locator('[data-col="cost"]')).toHaveText('Cost unknown');
  await expect(sale.locator('[data-col="result"]')).toContainText('Cost unknown');
  await expect(page.getByRole('region', { name: 'Missing cost', exact: true })).toBeVisible();
  expect(await venueBalance(s.owner, s.base)).toEqual(venueBefore);
});

// #2 (a move to the person's own venue sub-account, signed in their wallet) is J-portfolio-04-venue.pw.mjs's: it runs on
// the TEST venue, with the door on for that file only.
