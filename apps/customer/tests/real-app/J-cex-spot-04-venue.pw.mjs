// World: book, gates, restart, stack
import { createHash, randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext, twoPerson } from '../../../../tooling/scripts/local-test-gates.mjs';
import { api, journeyState, tool } from './stack.mjs';
import { reviewSheet, signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  openVenueDesk,
  sameDecimal,
  testDeposit,
  testVenue,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-cex-spot-04 #2 and #6, in the running app (docs/roadmap/journeys.json), on the stack's outside TEST venue: at launch a
// pair's rules are the venue's own (CUSTODY-DELTA: "Rules now come from the venue"), so the person reads them as the
// venue publishes them, with the venue named; a rule the venue does not publish is shown as not published and left to
// the venue without defaulting, and a protection the owner has left blank refuses by name. One test per step, titled "J-cex-spot-04 #<n>". J-cex-spot-04.pw.mjs
// holds every step on today's desk, #2 and #6 included (its market Info list and the owner's blank band and cap), so
// both tests count for those two steps.
//
// Each step trades a TEST spot market of its own: a fresh symbol the TEST venue lists by its `/test/market-add` control
// with the rules the step needs, listed for INTAFACED by svc-trade's two-person door as setup (as J-cex-spot-16 does),
// so no step touches the BTC markets other venue journeys trade. Every figure the desk shows is compared with the
// venue's own record, read straight from the TEST venue (venueRecord), never through our door. A customer whose own TEST
// wallet signs is made once for the file and funded by the TEST venue's deposit control. Every figure is TEST. The
// user-venue door is on for this file only.
const J = 'J-cex-spot-04';
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const LISTING_SET = 'trade.venue_listing_set';
const POLICY = 'trade-venue-markets-v1';
/** The rules step 2's market publishes, and its largest order. TEST figures. */
const RULES = { minOrderNotional: '10', priceBandBps: '1000', maxOpenOrders: 3, maxOrderQty: '100', maxOrderNotional: '10000' };

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

// ── setup, not steps ──

let operators;
async function ops() {
  if (!operators) {
    const ctx = await makeContext({ log: () => undefined });
    operators = { ctx, sessions: await approverSessions(ctx) };
  }
  return operators;
}

/** Keys sorted, no spaces: the canonical form svc-trade hashes (services/svc-trade/src/admin/common.ts payloadHash). */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
const hashOf = (body) => `sha256:${createHash('sha256').update(canonical(body)).digest('hex')}`;
const trpcData = (res) => res.json?.result?.data?.json ?? res.json?.result?.data;

/** A fresh TEST spot market on the TEST venue with the rules given (null: the venue publishes none). */
async function freshMarket(tag, rules) {
  const base = `T04${tag}${randomBytes(3).toString('hex').toUpperCase()}`;
  const symbol = `${base}-USDC`;
  const added = await testVenue('/test/market-add', { symbol, baseAsset: base, quoteAsset: 'USDC', ...rules });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  expect(added.body.label).toBe('TEST');
  return { symbol, base };
}

/** Two operators list `symbol` through svc-trade's own two-person door, open from a minute ago (J-cex-spot-16's setup). */
async function listByApi(symbol) {
  const { ctx, sessions } = await ops();
  const venueId = (await venueInfo()).id;
  const opensAt = new Date(Date.now() - 60_000).toISOString();
  const reason = `LOCAL TEST ${J}: list ${symbol} for this step`;
  const ids = await twoPerson(ctx, sessions, {
    actionType: LISTING_SET,
    targetService: 'svc-trade',
    targetId: `venue-listing:${venueId}:${symbol}`,
    expectedVersion: '0',
    payloadHash: hashOf({ actionType: LISTING_SET, venueId, symbol, opensAt, expectedVersion: '0', reason }),
    policyVersion: POLICY,
  });
  const res = await ctx.edge.mutate(
    'trade',
    'admin.venueMarkets.listingSet',
    { symbol, opensAt, expectedVersion: '0', reason, ...ids },
    await sessions.a.tradeOpsToken(),
  );
  expect(trpcData(res)?.listing?.version, res.text.slice(0, 300)).toBe(1);
}

/** The made-once customer: a verified account, its TEST wallet key, and that wallet's venue address. */
function customer() {
  const s = run.read();
  if (!s.account) throw new Error(`${J} venue setup made no customer, so this step has no one to act as`);
  const wallet = privateKeyToAccount(s.walletKey);
  return { ...s, owner: wallet.address.toLowerCase() };
}

/**
 * TEST setup, not a journey step: a verified customer, this run's TEST wallet key, and TEST 1000 USDC in its venue
 * account by the TEST venue's deposit control (keyed by a chain-transfer-shaped reference, so a replay credits nothing).
 */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'v04');
    await verify(page, account);
    const walletKey = testWalletKey();
    run.reset({ account, walletKey });
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
  } finally {
    await page.close();
  }
});

/** The venue's own record of `symbol` in its market list, read straight from the TEST venue. */
async function venueMarket(owner, symbol) {
  const list = await venueRecord(owner, '/markets');
  const market = list.value.find((m) => m.symbol === symbol);
  expect(market, `${symbol} is on the TEST venue's own market list`).toBeTruthy();
  return market;
}

/** A row of the desk's rules panel by its rule. */
const ruleRow = (page, rule) => page.getByTestId('venue-rules').locator(`[data-rule="${rule}"]`);
const buyForm = (page) => page.locator('form[data-testid="dk-form"][data-side="buy"]');

/** A limit buy through our door, as the API places it. */
const limitBuy = (owner, symbol, amount, price, tag) => ({
  kind: 'place_order',
  symbol,
  side: 'buy',
  type: 'limit',
  amount,
  price,
  timeInForce: 'GTC',
  reduceOnly: false,
  clientOrderKey: `order:${owner}:${symbol.toLowerCase()}:${tag}`,
  builderFee: null,
});

/** The venue's own open orders and USDC lock for `owner` on `symbol`, read straight from the TEST venue. */
async function venueOwn(owner, symbol) {
  const open = (await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === symbol);
  return { open, locked: (await venueBalance(owner, 'USDC')).locked };
}

/** Restarts trade with the door still on and `settings` set for this restart only. */
function restartTrade(settings) {
  const before = {};
  for (const [k, v] of Object.entries(settings)) {
    before[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── the steps ──

test(`${J} #2 reads the market's rules on the ticket and in the market list: tick, size step, smallest order value, price band and open-order cap as the venue publishes them, with the venue named`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const c = customer();
  const { symbol, base } = await freshMarket('R', RULES);
  await listByApi(symbol);
  const venue = await venueInfo();
  const own = await venueMarket(c.owner, symbol);
  // The venue publishes each rule: these are the figures the desk must show, never ours.
  expect(sameDecimal(own.minOrderNotional, RULES.minOrderNotional)).toBe(true);
  expect(sameDecimal(own.priceBandBps, RULES.priceBandBps)).toBe(true);
  expect(own.maxOpenOrders).toBe(RULES.maxOpenOrders);

  await openVenueDesk(page, c.account, `/trade/spot/${symbol}`, c.walletKey);
  const panel = page.getByTestId('venue-rules');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('venue-rules-source')).toHaveText(`As ${venue.displayName} publishes them`);
  const shown = async (rule) => (await ruleRow(page, rule).locator('dd').innerText()).replace(/,/g, '');
  const figure = (text) => /[\d.]+/.exec(text)?.[0];
  expect(await shown('tick')).toMatch(/ USDC$/);
  expect(sameDecimal(figure(await shown('tick')), own.tickSize)).toBe(true);
  expect(await shown('lot')).toMatch(new RegExp(` ${base}$`));
  expect(sameDecimal(figure(await shown('lot')), own.lotSize)).toBe(true);
  expect(await shown('min')).toMatch(/ USDC$/);
  expect(sameDecimal(figure(await shown('min')), own.minOrderNotional)).toBe(true);
  // The band in the venue's bps, shown as a percent of the middle of its book: 1000 bps is 10%.
  const percent = (await shown('band')).match(/within ([\d.]+)% of the middle of the venue’s book/)?.[1];
  expect(percent, await shown('band')).toBeTruthy();
  expect(sameDecimal(percent, String(Number(own.priceBandBps) / 100))).toBe(true);
  expect(await shown('cap')).toBe(`Up to ${own.maxOpenOrders} open orders on your venue account`);
  // Read as written: the figures are the venue's own strings, and the comma here is the sentence's.
  await expect(ruleRow(page, 'largest').locator('dd')).toHaveText(`${own.maxOrderQty} ${base}, or ${own.maxOrderNotional} USDC`);
  await expect(panel).not.toContainText('Not published');
  await stepPicture();

  // The market list the desk reads (our door's list of the markets INTAFACED shows) carries the venue's own figures.
  const listed = (await (await api(c.account)).get('/api/v1/venue/markets')).body.value.find((m) => m.symbol === symbol);
  expect(listed, `${symbol} is on the customer's market list`).toBeTruthy();
  expect(sameDecimal(listed.tickSize, own.tickSize) && sameDecimal(listed.lotSize, own.lotSize)).toBe(true);
  expect(sameDecimal(listed.minOrderNotional, own.minOrderNotional)).toBe(true);
  expect(sameDecimal(listed.priceBandBps, own.priceBandBps)).toBe(true);
  expect(listed.maxOpenOrders).toBe(own.maxOpenOrders);
});

test(`${J} #6 trades a pair whose rule the venue doesn't publish, or where the owner has not published a band: an unpublished venue rule is shown as not published and left to the venue without defaulting, and a blank owner value refuses by name`, async ({
  page,
  browser,
  stepPicture,
}) => {
  test.setTimeout(420_000);
  const c = customer();
  const client = await api(c.account);
  const venue = await venueInfo();
  // A rule the venue does not publish is shown as not published and left to the venue (never defaulted by us; a venue
  // refusal is shown in its own words), while a blank owner value still refuses.
  const { symbol, base } = await freshMarket('U', { ...RULES, minOrderNotional: null, priceBandBps: null, maxOpenOrders: null });
  await listByApi(symbol);
  const { symbol: noBand, base: noBandBase } = await freshMarket('B', { ...RULES, priceBandBps: null });
  await listByApi(noBand);
  const { symbol: ruled, base: ruledBase } = await freshMarket('P', RULES);
  await listByApi(ruled);
  const own = await venueMarket(c.owner, symbol);
  expect([own.minOrderNotional, own.priceBandBps, own.maxOpenOrders]).toEqual([null, null, null]);
  const before = await venueOwn(c.owner, symbol);
  expect(before.open).toHaveLength(0);

  // Our door's own market list carries the venue's blanks as blanks: no smallest order value, band or cap of ours stands
  // in, and preview/prepare forward the order to the venue instead of refusing or defaulting.
  const order = limitBuy(c.owner, symbol, '1', '20', 'unpublished');
  await expect
    .poll(async () => (await client.post('/api/v1/venue/preview', { owner: c.owner, intent: order })).status, {
      timeout: 90_000,
    })
    .toBe(200);
  const listed = (await client.get('/api/v1/venue/markets')).body.value.find((m) => m.symbol === symbol);
  expect(listed, `${symbol} is on the customer's market list`).toBeTruthy();
  expect([listed.minOrderNotional, listed.priceBandBps, listed.maxOpenOrders]).toEqual([null, null, null]);

  // On the desk: each unpublished rule reads "Not published by <venue>", and the trader can still place a limit buy
  // on the venue and cancel it.
  await openVenueDesk(page, c.account, `/trade/spot/${symbol}`, c.walletKey);
  await expect(ruleRow(page, 'min').locator('dd')).toHaveText(`Not published by ${venue.displayName}`);
  await expect(ruleRow(page, 'band').locator('dd')).toHaveText(`Not published by ${venue.displayName}`);
  await expect(ruleRow(page, 'cap').locator('dd')).toHaveText(`Not published by ${venue.displayName}`);
  await buyForm(page).getByRole('textbox', { name: 'Price', exact: true }).fill('20');
  await buyForm(page).getByRole('textbox', { name: 'Amount', exact: true }).fill('1');
  const buyButton = buyForm(page).getByRole('button', { name: `Buy ${base}`, exact: true });
  await expect(buyButton).toBeEnabled({ timeout: 20_000 });
  await buyButton.click();
  const sheet = reviewSheet(page);
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Confirm buy', exact: true }).click();
  await continueInWallet(page);
  await expect.poll(async () => (await venueOwn(c.owner, symbol)).open.length, { timeout: 20_000 }).toBe(1);
  // Cancel the resting order from Open orders so nothing is left open or locked on the venue.
  const openRow = page.getByTestId('venue-open-orders').locator('tbody tr').first();
  await expect(openRow).toBeVisible({ timeout: 20_000 });
  await openRow.getByRole('button', { name: 'Cancel', exact: true }).click();
  await continueInWallet(page);
  await expect.poll(async () => (await venueOwn(c.owner, symbol)).open.length, { timeout: 20_000 }).toBe(0);

  // On a pair with no published price band (like Hyperliquid spot), a refusal from the venue itself is shown in its own words.
  const refusedPage = await (await browser.newContext()).newPage();
  try {
    await openVenueDesk(refusedPage, c.account, `/trade/spot/${noBand}`, c.walletKey);
    await expect(ruleRow(refusedPage, 'band').locator('dd')).toHaveText(`Not published by ${venue.displayName}`);
    await buyForm(refusedPage).getByRole('textbox', { name: 'Price', exact: true }).fill('5');
    await buyForm(refusedPage).getByRole('textbox', { name: 'Amount', exact: true }).fill('1');
    const refusedNote = buyForm(refusedPage).getByTestId('venue-ticket-refused');
    await expect(refusedNote).toContainText('below the smallest order', { timeout: 20_000 });
    await expect(buyForm(refusedPage).getByRole('button', { name: `Buy ${noBandBase}`, exact: true })).toBeDisabled();
  } finally {
    await refusedPage.context().close();
  }

  // The owner's branch: a market order is bounded by the owner's price protection, a band only the owner sets. Left
  // blank, a market order on this step's fully ruled pair refuses by name, on the desk and at our door.
  const ruledBefore = await venueOwn(c.owner, ruled);
  try {
    restartTrade({ LOCAL_STACK_USER_VENUE: 'on', LOCAL_STACK_TRADE_SLIPPAGE_CAP: 'off' });
    const market = { ...limitBuy(c.owner, ruled, '1', '20', 'no-protection'), type: 'market', timeInForce: 'IOC' };
    const refused = await client.post('/api/v1/venue/preview', { owner: c.owner, intent: market });
    expect(refused.status, JSON.stringify(refused.body).slice(0, 300)).toBeGreaterThanOrEqual(400);
    expect(refused.body.intafacedCode).toBe('trade.slippage_cap_unset');
    // A second browser page: the TEST wallet is installed once per page.
    const desk = await (await browser.newContext()).newPage();
    try {
      const second = await openVenueDesk(desk, c.account, `/trade/spot/${ruled}`, c.walletKey);
      await desk.getByRole('tab', { name: 'Market', exact: true }).click();
      await buyForm(desk).getByRole('textbox', { name: 'Amount', exact: true }).fill('1');
      await expect(buyForm(desk).locator('[data-code="trade.slippage_cap_unset"]')).toHaveText(
        'Market orders are closed: protection not set, so nothing bounds the price they fill at.',
      );
      await expect(buyForm(desk).getByRole('button', { name: `Buy ${ruledBase}`, exact: true })).toBeDisabled();
      expect(second.requests).toHaveLength(0);
      await stepPicture();
    } finally {
      await desk.context().close();
    }
  } finally {
    restartTrade({ LOCAL_STACK_USER_VENUE: 'on' });
  }

  // Nothing rests and nothing is locked on the venue, on either pair: its own record, read straight from it.
  const after = await venueOwn(c.owner, symbol);
  expect(after.open).toHaveLength(0);
  expect(sameDecimal(after.locked, before.locked)).toBe(true);
  const ruledAfter = await venueOwn(c.owner, ruled);
  expect(ruledAfter.open).toHaveLength(ruledBefore.open.length);
  expect(sameDecimal(ruledAfter.locked, ruledBefore.locked)).toBe(true);
});
