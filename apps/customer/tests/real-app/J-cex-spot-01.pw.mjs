import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import {
  api,
  bestPrices,
  fromUnits,
  fund,
  journeyState,
  otherTrader,
  signUpInBrowser,
  times,
  toUnits,
  tool,
  signOutBrowser,
} from './stack.mjs';
import { awayBid, confirm, free, held, openDesk, openOrders, previewed, reviewLimit, reviewSheet, signIn } from './desk.mjs';

// J-cex-spot-01, in the running app (docs/roadmap/journeys.json). One test per step, titled "J-cex-spot-01 #<n>", run in
// order on one TEST account. Every number here is a TEST number on the local stack; the ledger is read through the
// customer's own API after each move.
const J = 'J-cex-spot-01';
const DESK = '/trade/spot/BTC-USDT';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

async function desk(page) {
  await openDesk(page, account());
}

/** A number as the room draws it ("65,000.10", "60.12 USDT", "$1.20"), as scaled units, so it compares to the service's. */
function shownUnits(text) {
  const found = /[+−-]?[\d,]+(\.\d+)?/.exec(text.replace(/\$/g, ''));
  if (!found) throw new Error(`no number in "${text}"`);
  return toUnits(found[0].replace(/,/g, '').replace('−', '-').replace('+', ''));
}

/** A decimal the service sent, as scaled units; money on the wire is a decimal string, never a JSON number. */
function wireUnits(value) {
  if (typeof value !== 'string') throw new Error(`not a decimal string on the wire: ${JSON.stringify(value)}`);
  return toUnits(value);
}

/** The value next to a review sheet label (its dt/dd pair). */
function reviewValue(review, label) {
  return review
    .locator('div', { has: review.page().locator('dt', { hasText: label }) })
    .locator('dd')
    .first();
}

/** One order's fills as the service reports them. */
async function fillsOf(who, orderId) {
  const { status, body } = await (await api(who)).get(`/api/v1/orders/${orderId}/trades?symbol=BTC%2FUSDT&limit=50`);
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}

/** One cent above the best bid: the order rests (it does not cross the ask) and is first in line for a crossing sell. */
async function topBid() {
  const { bid, ask } = await bestPrices();
  const price = toUnits(bid) + toUnits('0.01');
  if (price >= toUnits(ask)) throw new Error(`the book has no room between bid ${bid} and ask ${ask}`);
  return fromUnits(price);
}

/** One percent under the best bid, to the cent: a limit sell there still fills at the bids' own prices when the
 * market maker requotes between the read and the order, which a sell at the old best bid would not. */
async function underBid() {
  const { bid } = await bestPrices();
  const cent = toUnits('0.01');
  return fromUnits(((toUnits(bid) * 99n) / 100n / cent) * cent);
}

test(`${J} #1 signs up with an email and a password`, async ({ page }) => {
  const handle = `jt${Date.now().toString(36)}`;
  // A fresh TEST password per run, kept only in the run file (mode 600).
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  // Sign-up is J-identity-01's own journey: details, then the code the stack mails to its outbox file.
  await signUpInBrowser(page, who);
  await expect(page).not.toHaveURL(/\/register/);
  run.reset({ account: who });
  // Signed in, and the way to Verify is shown: Home says it where the total would be (in Simple, where the app opens;
  // Pro says it in its Summary).
  await expect(page.getByRole('main').getByText('Verify your identity first').first()).toBeVisible();
  await expect(
    page
      .getByRole('link', { name: 'Verify now' })
      .or(page.getByRole('button', { name: 'Verify now' }))
      .first(),
  ).toBeVisible();
});

test(`${J} #2 tries a TEST limit buy before verifying and is refused in plain words`, async ({ page }) => {
  await desk(page);
  await page.getByRole('textbox', { name: 'Price' }).first().fill('60000.00');
  await page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001');
  await expect(page.getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  const reason = page.locator('#dk-reason-buy');
  await expect(reason).toContainText('Verify your identity first');
  await expect(reason).toContainText('Verify now');
  await expect(reason).not.toContainText(/[a-z]+\.[a-z_]+_[a-z_]+/); // no raw code like trade.kyc_required
  expect(await openOrders(account())).toHaveLength(0);
  const balances = await (await api(account())).balances();
  expect(held(balances, 'USDT')).toBe(0n);
});

test(`${J} #3 submits verification, two operators approve it, signs in again and the desk accepts orders`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  await page.goto('/verification');
  await page.getByLabel('Level to request').selectOption({ label: 'Full' });
  await page.getByLabel('Country code').fill('DE');
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Submit this request' }).click();
  await expect(page.getByText('Your reviewed request')).toBeVisible();
  // The two TEST operators of the stack approve it through identity's own two-person door.
  tool('local-test-gates.mjs', 'verify');
  const status = tool('local-test-gates.mjs', 'status');
  const accounts = JSON.parse(status.slice(status.indexOf('{'))).accounts;
  expect(accounts.find((a) => a.handle === who.handle)?.tiers).toContain('full');
  await signOutBrowser(page.context());
  await desk(page);
  // The desk accepts orders: a resting limit buy away from the market gets a priced preview, and the only thing
  // that still stops it is money (#4 funds the account), never verification.
  const away = await awayBid(90);
  await previewed(page, async () => {
    await page.getByRole('textbox', { name: 'Price' }).first().fill(away);
    await page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001');
  });
  const reason = page.locator('#dk-reason-buy');
  await expect(reason).toContainText('Not enough USDT');
  await expect(reason).not.toContainText('Verify your identity first');
  await expect(reason).not.toContainText('Verify now');
});

test(`${J} #4 funds TEST 1000 USDT; a replay of the same deposit adds nothing`, async ({ page }) => {
  const who = account();
  const first = fund(who.email, 'USDT', '1000');
  expect(first.tx).toBeTruthy();
  const replay = fund(who.email, 'USDT', '1000', first.ref);
  expect(replay.tx).toBe(first.tx);
  const balances = await (await api(who)).balances();
  expect(balances.USDT).toMatchObject({ free: expect.stringMatching(/^1000(\.0+)?$/), used: expect.stringMatching(/^0(\.0+)?$/) });
  await desk(page);
  await expect(page.getByText('Available').first().locator('..')).toContainText('1,000');
});

test(`${J} #5 opens the spot desk: ticker, book, chart, tape, fees, trading mode and positions`, async ({ page }) => {
  await desk(page);
  await expect(page.getByTestId('dk-pair')).toHaveText('BTC/USDT');
  // The ticker's last price is the service's.
  await expect(async () => {
    const { body } = await (await api(account())).get('/api/v1/ticker/BTC%2FUSDT');
    expect(shownUnits(await page.getByTestId('dk-last').innerText())).toBe(wireUnits(body.last));
  }).toPass({ timeout: 30_000 });
  await expect(page.locator('[role=tab]', { hasText: 'Order book' })).toBeVisible();
  // The book draws real levels on both sides, each at a price the service's book holds.
  await expect(async () => {
    const { body } = await bestPrices();
    for (const [side, levels] of [
      ['bid', body.bids],
      ['ask', body.asks],
    ]) {
      const book = new Set(levels.map(([p]) => toUnits(p)));
      const price = page.locator(`[data-testid=dk-bk-row][data-side=${side}] [data-testid=dk-bk-price]`).first();
      expect(book.has(shownUnits(await price.innerText())), side).toBe(true);
    }
  }).toPass({ timeout: 30_000 });
  // A fresh stack draws its first candle after the TEST market maker's first crossing trade (about a minute).
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 90_000 });
  // The tape draws the service's prints: its newest row's price is among the service's recent trades.
  await page.locator('[role=tab]', { hasText: 'Last trades' }).click();
  await expect(async () => {
    const { body } = await (await api(account())).get('/api/v1/trades/BTC%2FUSDT?limit=50');
    const prices = new Set(body.map((t) => toUnits(String(t.price))));
    const first = page.locator('[data-testid=dk-bk-row--tape] [data-testid=dk-bk-price]').first();
    expect(prices.has(shownUnits(await first.innerText()))).toBe(true);
  }).toPass({ timeout: 60_000 });
  await expect(page.getByText(/Your rates: maker [\d.]+% · taker [\d.]+%/).first()).toBeVisible();
  await expect(page.getByText(/trading mode/i).first()).toBeVisible();
  await page.locator('[role=tab]', { hasText: /^Positions$/ }).click();
  await expect(page.getByText('Not applicable: cash spot holds balances, not positions')).toBeVisible();
});

test(`${J} #6 reviews a TEST limit buy: hold in USDT, maker role and rate, time in force, client id`, async ({ page }) => {
  await desk(page);
  const price = await topBid();
  const review = await reviewLimit(page, 'buy', price, '0.01');
  // The amount set aside is price x amount, in USDT.
  const hold = reviewValue(review, 'set aside');
  await expect(hold).toContainText('USDT');
  expect(shownUnits(await hold.innerText())).toBe(times(price, '0.01'));
  await expect(reviewValue(review, 'Fee role')).toHaveText('Maker: the order rests on the book');
  await expect(reviewValue(review, 'Estimated fee')).toContainText('0.08%');
  await expect(reviewValue(review, 'Time in force')).toHaveText('Good till cancelled');
  await expect(review.getByTestId('client-order-id')).toHaveText(/\S+/);
});

test(`${J} #7 confirms: the order is Open and the USDT hold equals the review`, async ({ page }) => {
  const who = account();
  await desk(page);
  // The book has moved since the review in step 6, so the price is taken again now.
  const price = await topBid();
  const amount = '0.01';
  const review = await reviewLimit(page, 'buy', price, amount);
  const reviewHold = shownUnits(await reviewValue(review, 'set aside').innerText());
  await confirm(page, 'buy');
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
  const row = page.locator('tr', { hasText: Number(price).toLocaleString('en-US', { minimumFractionDigits: 2 }) });
  await expect(row).toBeVisible();
  const orders = await openOrders(who);
  expect(orders).toHaveLength(1);
  expect(orders[0].status).toBe('open');
  run.write({ limitBuy: { price, amount, id: orders[0].id } });
  // The hold equals the review's, on the ledger and in the row's Held cell.
  const balances = await (await api(who)).balances();
  expect(held(balances, 'USDT')).toBe(reviewHold);
  expect(reviewHold).toBe(times(price, amount));
  const heldCol = await row.locator('xpath=ancestor::table//th').allInnerTexts();
  const cells = await row.locator('td').allInnerTexts();
  const heldAt = heldCol.findIndex((h) => h.trim() === 'Held');
  expect(heldAt, heldCol.join(' | ')).toBeGreaterThanOrEqual(0);
  expect(shownUnits(cells[heldAt])).toBe(reviewHold);
});

test(`${J} #8 another TEST trader's crossing sell fills it: fill row with price, amount, fee and maker role`, async ({ page }) => {
  const who = account();
  const { price, amount, id } = run.read().limitBuy ?? {};
  expect(id).toBeTruthy();
  const other = await api(otherTrader());
  // The house market maker may cross it first when it requotes; either way the order fills as maker.
  if ((await openOrders(who)).some((o) => o.id === id)) {
    // An IOC sell takes the best bids first: if the market maker has bid above this order since, sell through those
    // too, so the sell reaches this order at its price.
    const { body } = await bestPrices();
    const ahead = body.bids.filter(([p]) => toUnits(p) > toUnits(price)).reduce((sum, [, size]) => sum + toUnits(size), 0n);
    const sell = await other.post('/api/v1/orders', {
      symbol: 'BTC/USDT',
      type: 'limit',
      side: 'sell',
      amount: fromUnits(ahead + toUnits(amount)),
      price,
      timeInForce: 'IOC',
      clientOrderId: `${J}-8-${id}`,
    });
    expect(sell.status).toBeLessThan(300);
  }
  await expect.poll(async () => (await openOrders(who)).length, { timeout: 20_000 }).toBe(0);
  const after = await (await api(who)).balances();
  const cost = times(price, amount);
  // Funded 1000, nothing else has moved yet: the buyer paid exactly price x amount and holds nothing.
  expect(toUnits('1000') - toUnits(after.USDT.total)).toBe(cost);
  expect(toUnits(after.BTC?.total ?? '0')).toBeGreaterThan(0n);
  expect(held(after, 'USDT')).toBe(0n);
  await desk(page);
  // The order's own fills, from the service: maker, at its price, for its whole amount, with a fee.
  const fills = await fillsOf(who, id);
  expect(fills.length).toBeGreaterThan(0);
  expect(fills.every((f) => f.takerOrMaker === 'maker' && wireUnits(f.price) === toUnits(price))).toBe(true);
  expect(fills.reduce((sum, f) => sum + wireUnits(f.amount), 0n)).toBe(toUnits(amount));
  await page.locator('[role=tab]', { hasText: 'Trade history' }).click();
  // Each fill's row shows its price, amount, fee amount and asset, the fee rate and the maker role.
  const makerRows = page
    .locator('tr', { hasText: 'Maker' })
    .filter({ hasText: Number(price).toLocaleString('en-US', { minimumFractionDigits: 2 }) });
  await expect(makerRows).toHaveCount(fills.length);
  const rows = [];
  for (const row of await makerRows.all()) rows.push((await row.locator('td').allInnerTexts()).map((c) => c.trim()));
  // Each fill is matched to its own row, by amount and fee, and no row is used twice.
  for (const f of fills) {
    const shown = (cells) => cells.some((c) => /^[\d,.]+$/.test(c) && shownUnits(c) === wireUnits(f.amount));
    const feeOf = (cells) => cells.find((c) => c.includes(String(f.fee.currency)) && c.includes('%'));
    const at = rows.findIndex((cells) => shown(cells) && feeOf(cells) && shownUnits(feeOf(cells)) === wireUnits(f.fee.cost));
    expect(at, `${JSON.stringify(f)} in ${JSON.stringify(rows)}`).toBeGreaterThanOrEqual(0);
    const [cells] = rows.splice(at, 1);
    const fee = feeOf(cells);
    expect(fee, cells.join(' | ')).toBeTruthy();
    expect(shownUnits(fee)).toBe(wireUnits(f.fee.cost));
    expect(fee).toContain('0.08%');
  }
});

test(`${J} #9 places a market buy: it fills inside its protection price and leaves no hold`, async ({ page }) => {
  const who = account();
  const before = await (await api(who)).balances();
  await desk(page);
  await page.locator('[role=tab]', { hasText: /^Market$/ }).click();
  await previewed(page, () => page.getByRole('textbox', { name: 'Amount' }).first().fill('0.001'));
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  const review = reviewSheet(page);
  await expect(review).toBeVisible();
  // A requote asks again with a new protection price: the bound is the one on the sheet that was last confirmed.
  let protection;
  for (let i = 0; i < 3 && (await review.count()); i++) {
    protection = shownUnits(await reviewValue(review, 'Price protection').innerText());
    await page.getByRole('button', { name: 'Confirm buy' }).click();
    await page.waitForTimeout(1500);
  }
  await expect(review).toHaveCount(0);
  await expect
    .poll(async () => toUnits((await (await api(who)).balances()).BTC?.total ?? '0') - toUnits(before.BTC?.total ?? '0'), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0n);
  const after = await (await api(who)).balances();
  expect(held(after, 'USDT')).toBe(0n);
  // Every fill of the market buy is inside its protection price.
  const { body: recent } = await (await api(who)).get('/api/v1/orders/closed?symbol=BTC%2FUSDT&limit=5');
  const market = recent.find((o) => o.type === 'market' && o.side === 'buy');
  expect(market, JSON.stringify(recent).slice(0, 300)).toBeTruthy();
  const fills = await fillsOf(who, market.id);
  expect(fills.length).toBeGreaterThan(0);
  for (const f of fills) expect(wireUnits(f.price)).toBeLessThanOrEqual(protection);
});

test(`${J} #10 rests a limit buy away from the market, cancels it, cancels it again`, async ({ page }) => {
  const who = account();
  await desk(page);
  const away = await awayBid(90); // 90% of the bid, whole USDT
  await reviewLimit(page, 'buy', away, '0.001');
  await confirm(page, 'buy');
  const [order] = await openOrders(who);
  expect(order).toBeTruthy();
  await page.locator('[role=tab]', { hasText: 'Open orders' }).click();
  const row = page.locator('tr', { hasText: Number(away).toLocaleString('en-US', { minimumFractionDigits: 2 }) });
  await row.getByRole('button', { name: 'Cancel' }).click();
  // Only a confirm dialog's button: the desk's "Cancel orders…" control also reads "cancel order".
  const sure = page.getByRole('dialog').getByRole('button', { name: /cancel order|yes|confirm/i });
  if (await sure.count()) await sure.first().click();
  await expect(row).toHaveCount(0);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(0n);
  // The repeat is refused with the order's terminal state, and moves nothing.
  const again = await (await api(who)).delete(`/api/v1/orders/${order.id}?symbol=BTC%2FUSDT`);
  expect(again.status).toBe(409);
  expect(JSON.stringify(again.body)).toMatch(/is cancelled/);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(0n);
});

test(`${J} #11 reads the bought lot on Profit and loss, sells it, and reads the realised result`, async ({ page }) => {
  const who = account();
  await signIn(page, who);
  await page.goto('/money/pnl?asset=BTC');
  const main = page.locator('main').first();
  // The bought lots are open at their cost: what is left equals the BTC held, and each has a dollar cost.
  const lots = main.locator('tr[data-lot]');
  await expect(lots.first()).toBeVisible({ timeout: 30_000 });
  const btc = toUnits((await (await api(who)).balances()).BTC?.total ?? '0');
  let left = 0n;
  for (const lot of await lots.all()) {
    left += shownUnits(await lot.locator('td[data-col=left]').innerText());
    await expect(lot.locator('td[data-col=cost]')).toHaveText(/^\$[\d,]+\.\d{2}$/);
  }
  expect(left).toBe(btc);
  await page.goto(DESK);
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  await page
    .getByRole('textbox', { name: 'Price' })
    .nth(1)
    .fill(await underBid());
  // The sell side's Max: every whole step of the BTC held.
  await previewed(page, () => page.getByRole('button', { name: 'Max' }).last().click());
  await page.getByRole('button', { name: 'Sell BTC' }).click();
  await expect(reviewSheet(page)).toBeVisible();
  await confirm(page, 'sell');
  // What is left is below the market's amount step (0.00001 BTC).
  await expect
    .poll(async () => toUnits((await (await api(who)).balances()).BTC?.total ?? '0'), { timeout: 20_000 })
    .toBeLessThan(toUnits('0.00001'));
  await page.goto('/money/pnl');
  await expect(main.getByTestId('money-label').filter({ hasText: 'Realised' }).first()).toBeVisible();
  await expect(main.locator('[data-testid=money-total][data-figure=realised]')).toHaveText(/^[+−]\$[\d,]+\.\d{2}$/);
  await expect(main.locator('[data-testid=money-note][data-indicator=true]')).toContainText('It is not a tax form.');
});

test(`${J} #12 opens Withdraw for TEST 10 USDT and is refused up front with the named blocker; nothing is held`, async ({ page }) => {
  const who = account();
  const before = await (await api(who)).balances();
  await signIn(page, who);
  await page.goto('/uc/withdraw');
  const main = page.locator('main').first();
  // The rail is named before any step-up: no payout rail is connected, so the form refuses up front.
  await expect(main).toContainText('New withdrawal unavailable');
  await expect(main).toContainText(/Sending money out of INTAFACED .* isn.t connected/);
  await page.getByLabel('Amount').fill('10');
  await expect(page.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();
  await expect(main).toContainText('No withdrawals yet');
  const after = await (await api(who)).balances();
  expect(held(after, 'USDT')).toBe(held(before, 'USDT'));
  expect(free(after, 'USDT')).toBe(free(before, 'USDT'));
});
