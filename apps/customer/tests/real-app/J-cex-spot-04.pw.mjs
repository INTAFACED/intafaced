import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, api, bestPrices, fromUnits, fund, journeyState, toUnits, tool } from './stack.mjs';
import { awayBid, fundedTrader, held, openDesk, openOrders, placements, previewed } from './desk.mjs';

// J-cex-spot-04, in the running app (docs/roadmap/journeys.json): a person is told in words what a pair allows. One
// test per step, titled "J-cex-spot-04 #<n>", run in order on one TEST account funded with TEST USDT through the real
// ledger. The band and cap are the stack's LOCAL TEST values, set through the operator pair's two-person door
// (`local-test-gates.mjs limits`); the journey reads them from the public market list and never assumes a number.
// Step 6 takes BTC/USDC's band and cap away through the same door, and puts them back after.
const J = 'J-cex-spot-04';
const SYMBOL = 'BTC/USDT';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const FUNDED = '2000';

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

const buyForm = (page) => page.locator('form[data-testid="dk-form"][data-side="buy"]');
const tab = (page, name) => page.locator('[role=tab]', { hasText: new RegExp(`^${name}$`) });

/** The pair's published rules from the public market list. */
async function rulesOf(symbol = SYMBOL) {
  const res = await fetch(`${EDGE}/api/v1/markets?limit=500`, { headers: { origin: ORIGIN } });
  expect(res.status).toBe(200);
  const body = await res.json();
  const market = (Array.isArray(body) ? body : (body.markets ?? body.items ?? [])).find((m) => m.symbol === symbol);
  expect(market, `${symbol} is listed`).toBeTruthy();
  const rules = market.pairRules ?? market.info?.pairRules;
  expect(rules, `${symbol} publishes its rules`).toBeTruthy();
  return rules;
}

/** An amount on the lot that costs at least `cost` at `price`, so it clears the smallest order value. */
function amountFor(price, lot, cost = '10') {
  const one = toUnits('1');
  const step = toUnits(lot);
  const raw = (toUnits(cost) * one) / toUnits(price);
  return fromUnits(((raw + step - 1n) / step) * step);
}

/** "0.1" as the desk writes it: "10%". */
const percent = (fraction) => `${fromUnits(toUnits(fraction) * 100n)}%`;

test(`${J} #1 opens the order-type menu: the types this market does not take are listed, disabled, with one reason`, async ({ page }) => {
  const who = await fundedTrader(page, 'js4', FUNDED);
  run.reset({ account: who });
  await openDesk(page, who);
  await expect(tab(page, 'Limit')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'Market')).toBeEnabled();
  const sent = placements(page);
  await page.getByRole('button', { name: 'Other order types (not available)' }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  expect(await items.count()).toBeGreaterThan(0);
  for (const item of await items.all()) await expect(item).toHaveAttribute('aria-disabled', 'true');
  await expect(menu).toContainText(/\.\s*$|not take|not available|isn’t|isn't/);
  await page.keyboard.press('Escape');
  await expect(tab(page, 'Limit')).toHaveAttribute('aria-selected', 'true');
  expect(sent).toHaveLength(0);
});

test(`${J} #2 reads the pair's rules on the ticket and in the market's Info: tick, lot, minimums, price band, open-order cap`, async ({
  page,
}) => {
  const who = account();
  const rules = await rulesOf();
  expect(rules.protection.collar).not.toBe('not set');
  expect(rules.protection.openOrdersPerMarket).not.toBe('not set');
  await openDesk(page, who);
  const ticket = page.locator('details[data-testid="dk-rules"]');
  await ticket.locator('summary').click();
  const expected = [
    ['Price step', `${rules.tick} USDT`],
    ['Amount step', `${rules.lot} BTC`],
    ['Smallest amount', `${rules.minQty} BTC`],
    ['Smallest order value', 'USDT'],
    ['Price band', `Within ${percent(rules.protection.collar)} of the middle price`],
    ['Open orders', `Up to ${rules.protection.openOrdersPerMarket} on this market`],
  ];
  for (const [name, value] of expected) {
    const row = ticket.locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${name}$`) }) });
    await expect(row.locator('dd')).toContainText(value);
  }
  await expect(ticket).toContainText(rules.minNotional);
  // The same list in the market's Info tab.
  await page.getByRole('tab', { name: 'Info', exact: true }).click();
  const info = page.getByRole('definition').filter({ hasText: /of the middle price/ });
  await expect(info.first()).toContainText(percent(rules.protection.collar));
  await expect(page.locator('dl[aria-label="Market rules"]').last()).toContainText(`Up to ${rules.protection.openOrdersPerMarket}`);
});

test(`${J} #3 types an order below the smallest value, or finer than the lot or tick: refused in words, nothing sent`, async ({ page }) => {
  const who = account();
  const rules = await rulesOf();
  await openDesk(page, who);
  const sent = placements(page);
  const price = await awayBid(95);
  await tab(page, 'Limit').click();
  await buyForm(page).getByRole('textbox', { name: 'Price' }).fill(price);
  await buyForm(page).getByRole('textbox', { name: 'Amount' }).fill(rules.lot);
  await expect(buyForm(page)).toContainText(`The smallest order is ${rules.minNotional} USDT`);
  await expect(buyForm(page).getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  // Finer digits than the tick or the lot cannot be typed.
  const priceBox = buyForm(page).getByRole('textbox', { name: 'Price' });
  await priceBox.fill('');
  await priceBox.pressSequentially(`${price}.005`);
  await expect(priceBox).toHaveValue(`${price}.00`);
  const amountBox = buyForm(page).getByRole('textbox', { name: 'Amount' });
  await amountBox.fill('');
  await amountBox.pressSequentially(`${rules.lot}5`);
  await expect(amountBox).toHaveValue(rules.lot);
  expect(sent).toHaveLength(0);
});

test(`${J} #4 types a buy price above the band: refused before review with the band's edges named, nothing held`, async ({ page }) => {
  const who = account();
  const rules = await rulesOf();
  const before = held(await (await api(who)).balances(), 'USDT');
  const { ask } = await bestPrices();
  const above = fromUnits(((toUnits(ask) * 3n) / 2n / toUnits('1')) * toUnits('1'));
  await openDesk(page, who);
  const sent = placements(page);
  await tab(page, 'Limit').click();
  await buyForm(page).getByRole('textbox', { name: 'Price' }).fill(above);
  await previewed(page, () => buyForm(page).getByRole('textbox', { name: 'Amount' }).fill(amountFor(above, rules.lot)));
  const note = buyForm(page).getByTestId('dk-note--bad');
  await expect(note).toContainText('Price is outside the allowed range');
  await expect(note).toContainText(/takes buy prices up to [\d,.]+ and sell prices down to [\d,.]+ right now/);
  await expect(note).not.toContainText('trade.');
  // The named edge is the band around the middle of the book, never the typed price.
  const high = /buy prices up to ([\d,.]+)/.exec(await note.innerText())[1].replaceAll(',', '');
  expect(toUnits(high)).toBeLessThan(toUnits(above));
  expect(toUnits(high)).toBeGreaterThan(toUnits(ask));
  await expect(buyForm(page).getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
  expect(sent).toHaveLength(0);
  expect(held(await (await api(who)).balances(), 'USDT')).toBe(before);
});

test(`${J} #5 reaches the open-order cap: the next order is refused with the cap and how many are open, nothing held`, async ({ page }) => {
  const who = account();
  const rules = await rulesOf();
  const cap = Number(rules.protection.openOrdersPerMarket);
  expect(Number.isInteger(cap) && cap > 0).toBe(true);
  const trader = await api(who);
  const price = await awayBid(95);
  const amount = amountFor(price, rules.lot);
  const placed = [];
  try {
    for (let i = (await openOrders(who)).length; i < cap; i++) {
      const res = await trader.post('/api/v1/orders', {
        symbol: SYMBOL,
        type: 'limit',
        side: 'buy',
        amount,
        price,
        timeInForce: 'GTC',
        clientOrderId: `${J}-5-${Date.now()}-${i}`,
      });
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBeLessThan(300);
      placed.push(res.body.id);
    }
    expect(await openOrders(who)).toHaveLength(cap);
    const before = held(await trader.balances(), 'USDT');

    await openDesk(page, who);
    const sent = placements(page);
    await tab(page, 'Limit').click();
    await buyForm(page).getByRole('textbox', { name: 'Price' }).fill(price);
    await previewed(page, () => buyForm(page).getByRole('textbox', { name: 'Amount' }).fill(amount));
    const note = buyForm(page).getByTestId('dk-note--bad');
    await expect(note).toContainText('Too many open orders');
    await expect(note).toContainText(`You have ${cap} open orders here and this market allows ${cap}.`);
    await expect(buyForm(page).getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
    expect(sent).toHaveLength(0);

    // The service refuses the same send on its own, before any hold.
    const refused = await trader.post('/api/v1/orders', {
      symbol: SYMBOL,
      type: 'limit',
      side: 'buy',
      amount,
      price,
      timeInForce: 'GTC',
      clientOrderId: `${J}-5-over-${Date.now()}`,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain('trade.operator_throttle');
    expect(await openOrders(who)).toHaveLength(cap);
    expect(held(await trader.balances(), 'USDT')).toBe(before);
  } finally {
    for (const id of placed) await trader.delete(`/api/v1/orders/${id}?symbol=BTC%2FUSDT`);
  }
  expect(await openOrders(who)).toHaveLength(0);
});

test(`${J} #6 trades a pair whose band or cap the owner has not published: a typed refusal names the missing rule, nothing held`, async ({
  page,
}) => {
  const who = account();
  const pair = 'BTC/USDC';
  const published = (await rulesOf(pair)).protection;
  expect(published.collar).not.toBe('not set');
  expect(published.openOrdersPerMarket).not.toBe('not set');
  expect(fund(who.email, 'USDC', '500').tx).toBeTruthy();
  const trader = await api(who);
  const before = held(await trader.balances(), 'USDC');
  const price = await awayBid(95, pair);
  const amount = amountFor(price, (await rulesOf(pair)).lot);
  const send = (key) =>
    trader.post('/api/v1/orders', {
      symbol: pair,
      type: 'limit',
      side: 'buy',
      amount,
      price,
      timeInForce: 'GTC',
      clientOrderId: `${J}-6-${key}-${Date.now()}`,
    });
  try {
    tool('local-test-gates.mjs', 'risk', pair, 'collar=unset', 'throttle=unset');
    await expect.poll(async () => (await rulesOf(pair)).protection.collar).toBe('not set');

    // The desk shows the rule as not published, and the order check refuses in words before review.
    await openDesk(page, who, pair);
    const sent = placements(page);
    const rules = page.locator('details[data-testid="dk-rules"]');
    await rules.locator('summary').click();
    const row = (name) => rules.locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${name}$`) }) });
    await expect(row('Price band').locator('dd')).toHaveText('Not published');
    await expect(row('Open orders').locator('dd')).toHaveText('Not published');
    await tab(page, 'Limit').click();
    await buyForm(page).getByRole('textbox', { name: 'Price' }).fill(price);
    await previewed(page, () => buyForm(page).getByRole('textbox', { name: 'Amount' }).fill(amount));
    const note = buyForm(page).getByTestId('dk-note--bad');
    await expect(note).toContainText('No price band is published');
    await expect(note).not.toContainText('trade.');
    await expect(buyForm(page).getByRole('button', { name: 'Buy BTC' })).toBeDisabled();
    expect(sent).toHaveLength(0);

    // The service refuses on its own, naming the rule, before any hold.
    const noBand = await send('band');
    expect(noBand.status).toBe(503);
    expect(JSON.stringify(noBand.body)).toContain('trade.price_band_unset');

    // With the band back and the cap still missing, an order that would rest is refused for the cap.
    tool('local-test-gates.mjs', 'risk', pair, `collar=${published.collar}`);
    await expect.poll(async () => (await rulesOf(pair)).protection.collar).toBe(published.collar);
    const noCap = await send('cap');
    expect(noCap.status).toBe(503);
    expect(JSON.stringify(noCap.body)).toContain('trade.open_orders_cap_unset');
    expect(await openOrders(who, pair)).toHaveLength(0);
    expect(held(await trader.balances(), 'USDC')).toBe(before);
  } finally {
    tool('local-test-gates.mjs', 'risk', pair, `collar=${published.collar}`, `throttle=${published.openOrdersPerMarket}`);
  }
  const restored = (await rulesOf(pair)).protection;
  expect([restored.collar, restored.openOrdersPerMarket]).toEqual([published.collar, published.openOrdersPerMarket]);
});

test(`${J} #7 sends an order whose request deadline has passed: refused as expired before any hold`, async () => {
  const who = account();
  const rules = await rulesOf();
  const trader = await api(who);
  const before = held(await trader.balances(), 'USDT');
  const price = await awayBid(95);
  const order = {
    symbol: SYMBOL,
    type: 'limit',
    side: 'buy',
    amount: amountFor(price, rules.lot),
    price,
    timeInForce: 'GTC',
    clientOrderId: `${J}-7-${Date.now()}`,
    requestDeadline: new Date(Date.now() - 60_000).toISOString(),
  };
  const refused = await trader.post('/api/v1/orders', order);
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(refused.status).toBeLessThan(500);
  expect(JSON.stringify(refused.body)).toContain('trade.request_expired');
  expect(await openOrders(who)).toHaveLength(0);
  expect(held(await trader.balances(), 'USDT')).toBe(before);
  // The same order with a deadline still ahead goes through, so the refusal was the deadline and nothing else.
  const ahead = await trader.post('/api/v1/orders', {
    ...order,
    clientOrderId: `${J}-7b-${Date.now()}`,
    requestDeadline: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(ahead.status, JSON.stringify(ahead.body).slice(0, 300)).toBeLessThan(300);
  await trader.delete(`/api/v1/orders/${ahead.body.id}?symbol=BTC%2FUSDT`);
  expect(held(await trader.balances(), 'USDT')).toBe(before);
});
