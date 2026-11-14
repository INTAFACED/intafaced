// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { fromUnits, journeyState, toUnits } from './stack.mjs';
import { confirm, reviewSheet, signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  otherTraderKey,
  otherTraderRun,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueRecord,
} from './venue.mjs';

// J-portfolio-02 #6 on the person's own venue account (docs/roadmap/journeys.json; project-state operation-zero/modules/
// portfolio/acceptance/journeys.md), in the running app against the stack's TEST venue simulator: "Sells coins that
// arrived from outside" / "The lot's cost is unknown unless the person enters it, never zero; until then its result is
// unknown and the realised total stays blank". At launch coins arrive in the person's own venue account, never in our
// ledger, so the coins here arrive there, by the TEST venue's deposit control. The other steps are J-portfolio-02.pw.mjs's.
// Every figure is TEST, and every expected figure is a hand count from the venue's own record, never from the lot book.
// The door is on for this file only.
const J = 'J-portfolio-02';
const DESK = '/trade/spot/BTC-USDC';
const SYMBOL = 'BTC-USDC';
/** TEST: 0.05 BTC arrives from outside; 0.02 of it is sold, so 0.03 stays. */
const ARRIVED = '0.05';
const SOLD = '0.02';
const LEFT = '0.03';
/** TEST: the price per BTC the person enters for the arrived coins. */
const ENTERED = '50000';
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ONE = toUnits('1');

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J}'s TEST setup made no account and wallet, so this step has no one to act as`);
  return s;
}

/** The screen's dollar text for an exact amount (fmtUsd): under 1 dollar at up to 4 places, else cents, half-up. */
function usd(units, signed = false) {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const places = abs < ONE ? 4 : 2;
  const step = 10n ** BigInt(18 - places);
  const rounded = (abs + step / 2n) / step;
  let frac = (rounded % 10n ** BigInt(places)).toString().padStart(places, '0');
  if (places === 4) frac = frac.replace(/0{1,2}$/, '');
  const whole = (rounded / 10n ** BigInt(places)).toLocaleString('en-US');
  const sign = rounded === 0n ? '' : negative ? '−' : signed ? '+' : '';
  return `${sign}$${whole}.${frac}`;
}

/**
 * What a venue sale paid, by hand from the venue's own fill: price times amount, rounded up as the venue settles it, less
 * everything the venue charged in USDC (its fee and our builder fee).
 */
function proceedsOf(f) {
  const product = toUnits(f.price) * toUnits(f.amount);
  const notional = (product + ONE - 1n) / ONE;
  return notional - (f.feeAsset === 'USDC' ? toUnits(f.venueFee) + toUnits(f.builderFee) : 0n);
}

async function pnl(page, query = '') {
  await page.goto(`/money/pnl${query}`);
  const main = page.locator('main').first();
  await expect(main.getByRole('heading', { name: 'Profit and loss', level: 1 })).toBeVisible();
  return main;
}

/** TEST setup, not a journey step: a verified account and this run's TEST wallet key. */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'pf2v');
    await verify(page, account);
    run.reset({ account, walletKey: testWalletKey() });
  } finally {
    await page.close();
  }
});

test(`${J} #6 sells coins that arrived from outside: the lot's cost is unknown unless the person enters it, never zero, and until then the result is unknown and the realised total blank`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const s = state();
  const owner = privateKeyToAccount(s.walletKey).address.toLowerCase();

  // TEST 0.05 BTC arrives in the person's own venue account from outside, by the TEST venue's deposit control (keyed by
  // a chain-transfer-shaped reference, so a replay credits nothing): no trade, so no cost is known.
  const ref = `84532:0x${randomBytes(32).toString('hex')}:0`;
  expect(await testDeposit(owner, 'BTC', ARRIVED, ref)).toBe(true);
  expect(toUnits((await venueBalance(owner, 'BTC')).total)).toBe(toUnits(ARRIVED));
  // The venue's own record of it: one credit from outside, 0.05 BTC.
  const arrivals = (await venueRecord(owner, '/arrivals')).value;
  expect(arrivals).toEqual([expect.objectContaining({ arrivalId: ref, kind: 'deposit', asset: 'BTC', amount: ARRIVED })]);

  // Another TEST trader rests a buy of 0.02 BTC one tick over the venue's best bid, so the sale below meets it at once.
  const { body: markets } = await testVenue('/markets', {});
  const market = markets.value.find((m) => m.symbol === SYMBOL);
  expect(market, JSON.stringify(markets).slice(0, 300)).toBeTruthy();
  const tick = toUnits(market.tickSize);
  // The venue's own best bid and ask, read straight from the TEST venue.
  const best = await testVenue('/best-prices', { symbol: SYMBOL });
  expect(best.status, JSON.stringify(best.body)).toBe(200);
  expect(best.body.value.bid && best.body.value.ask, `the TEST venue has a two-sided book on ${SYMBOL}`).toBeTruthy();
  const bid = toUnits(best.body.value.bid);
  const ask = toUnits(best.body.value.ask);
  const price = bid + tick < ask ? bid + tick : bid;
  const buyer = `${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}-${owner.slice(2, 10)}`;
  await testVenue('/test/deposit', {
    account: await venueAccount(otherTraderKey(buyer).address),
    asset: 'USDC',
    amount: '10000',
    depositRef: `seed:${buyer}:USDC`,
  });
  const rested = await otherTraderRun(buyer, {
    kind: 'place_order',
    symbol: SYMBOL,
    side: 'buy',
    type: 'limit',
    amount: SOLD,
    price: fromUnits(price),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${buyer}:pf2-bid`,
    builderFee: null,
  });
  expect(rested.definite && rested.accepted, JSON.stringify(rested)).toBe(true);

  // The person sells 0.02 of those coins on the venue desk, a limit sell at that bid, signed in their own wallet.
  const since = new Date(Date.now() - 1_000).toISOString();
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  expect(wallet.address.toLowerCase()).toBe(owner);
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  await page.getByRole('textbox', { name: 'Price' }).nth(1).fill(fromUnits(price));
  const preview = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await page.getByRole('textbox', { name: 'Amount' }).nth(1).fill(SOLD);
  expect((await preview).status()).toBe(200);
  await page.getByRole('button', { name: 'Sell BTC' }).click();
  const sheet = reviewSheet(page);
  await expect(sheet).toBeVisible();
  // A sell carries our builder fee: the wallet approves it first, then Confirm sell signs the order.
  const approve = sheet.getByRole('button', { name: 'Approve our builder fee in your wallet' });
  if (await approve.isVisible()) {
    await approve.click();
    await continueInWallet(page);
    await expect(sheet.getByRole('button', { name: 'Confirm sell' })).toBeEnabled({ timeout: 20_000 });
  }
  await confirm(page, 'sell');
  await continueInWallet(page);
  const sells = async () => (await venueRecord(owner, '/fills', { since })).value.filter((f) => f.symbol === SYMBOL && f.side === 'sell');
  await expect.poll(async () => fromUnits((await sells()).reduce((sum, f) => sum + toUnits(f.amount), 0n)), { timeout: 30_000 }).toBe(SOLD);
  // The venue's own record: 0.03 BTC left, and what the sale paid.
  await expect.poll(async () => fromUnits(toUnits((await venueBalance(owner, 'BTC')).total)), { timeout: 15_000 }).toBe(LEFT);
  const proceeds = (await sells()).reduce((sum, f) => sum + proceedsOf(f), 0n);
  expect(proceeds).toBeGreaterThan(0n);

  // Profit and loss: the sale drew on the coins that arrived, whose cost is unknown, so its result is unknown and the
  // whole 0.02 is named as sold with no cost (Missing cost, PF-cost-basis-04).
  const main = await pnl(page);
  const sale = main.locator('tr[data-sale]').filter({ hasText: 'BTC' }).first();
  await expect(sale).toBeVisible({ timeout: 30_000 });
  await expect(sale.locator('td').nth(0)).toHaveText(SOLD);
  await expect(sale.locator('td').nth(1)).toHaveText(usd(proceeds));
  await expect(sale.locator('td').nth(2)).toHaveText('Not known');
  await expect(sale.locator('[data-col="result"]')).toHaveText(`Cost unknown Unknown share: ${SOLD} BTC sold with no cost`);
  await expect(sale.locator('[data-col="result"] [data-effect="unknown-share"]')).toHaveCount(1);
  // Never a made-up cost: the realised total is blank while one sale's result is unknown.
  await expect(main.locator('[data-figure="realised"]')).toHaveText('Not known');
  await expect(main.getByRole('list', { name: 'Why some figures are not known' })).toBeVisible();
  // The 0.03 BTC still held has no recorded cost either: unknown, never zero.
  const btc = main.locator('tr[data-asset="BTC"]');
  await expect(btc).toHaveCount(1);
  await expect(btc.locator('td').first()).toHaveText(LEFT);
  await expect(btc.locator('[data-col="cost"]')).toHaveText('Not known');

  // Unless the person enters it: a TEST price of 50000 per BTC for the coins that arrived. The sale then has a cost (0.02
  // at 50000 = $1,000.00) and a result (what the sale paid less that), both labelled customer-entered; the 0.03 still
  // held costs $1,500.00; and the realised total is no longer blank: it is that one result.
  const costSold = (toUnits(SOLD) * toUnits(ENTERED)) / ONE;
  const result = proceeds - costSold;
  const missingCard = main.getByRole('region', { name: 'Missing cost' });
  await missingCard.getByRole('button', { name: 'Enter a cost' }).click();
  const form = missingCard.getByRole('form', { name: 'Enter a cost for this lot' });
  await form.getByLabel('Price you paid per BTC, in USD').fill(ENTERED);
  await form.getByLabel('Where this price comes from').fill('TEST receipt');
  await form.getByRole('button', { name: 'Save price' }).click();
  await expect(page.getByTestId('basis-notice')).toHaveText('Price saved. The figures use it, marked customer-entered.');
  await expect(sale.locator('td').nth(1)).toHaveText(usd(proceeds));
  await expect(sale.locator('td').nth(2)).toHaveText(usd(costSold));
  await expect(sale.locator('[data-col="result"]')).toContainText(usd(result, true));
  await expect(sale.locator('[data-col="result"] [data-label="customer-entered"]')).toHaveText('Customer-entered');
  await expect(btc.locator('[data-col="cost"]')).toHaveText(usd((toUnits(LEFT) * toUnits(ENTERED)) / ONE));
  await expect(main.locator('[data-figure="realised"]')).toHaveText(usd(result, true));

  // Taking the price back, on the lot it was entered for, makes the cost unknown again and the total blank again.
  const btcBook = await pnl(page, '?asset=BTC');
  const pricedLot = btcBook
    .getByRole('region', { name: 'Lots' })
    .locator('tbody tr')
    .filter({ has: page.locator('[data-label="customer-entered"]') });
  await expect(pricedLot).toHaveCount(1);
  await pricedLot.getByRole('button', { name: 'Remove my price' }).click();
  await expect(page.getByTestId('basis-notice')).toHaveText('Price removed. That lot’s cost is unknown again.');
  await expect(pricedLot).toHaveCount(0);
  await pnl(page);
  await expect(sale.locator('td').nth(2)).toHaveText('Not known');
  await expect(sale.locator('[data-col="result"]')).toHaveText(`Cost unknown Unknown share: ${SOLD} BTC sold with no cost`);
  await expect(main.locator('[data-figure="realised"]')).toHaveText('Not known');
  await expect(btc.locator('[data-col="cost"]')).toHaveText('Not known');

  // With balances hidden (the eye, the account's own choice) the quantity inside that sentence is masked too, as every
  // figure on the page is. The eye is pressed on Home, where a venue account's wallet stays connected (as
  // J-home-ia-01-venue does); on Money with the venue door on it was redrawn under the click (run 43613224113).
  const eye = async (name) => {
    await page.goto('/');
    const button = page.getByRole('button', { name }).first();
    await expect(button).toBeVisible({ timeout: 30_000 });
    const written = page.waitForResponse((res) => res.url().includes('preferences.set') && res.request().method() === 'POST', {
      timeout: 30_000,
    });
    await button.click({ timeout: 30_000 });
    expect((await written).status()).toBe(200);
  };
  await eye('Hide balances');
  try {
    const hidden = await pnl(page);
    await expect(hidden.locator('tr[data-sale]').filter({ hasText: 'BTC' }).first().locator('[data-effect="unknown-share"]')).toHaveText(
      'Unknown share: •••• BTC sold with no cost',
    );
  } finally {
    await eye('Show balances');
  }

  // The venue's own record is untouched by any of it: the price is the person's note in the indicator, nothing moved.
  expect(fromUnits(toUnits((await venueBalance(owner, 'BTC')).total))).toBe(LEFT);
});
