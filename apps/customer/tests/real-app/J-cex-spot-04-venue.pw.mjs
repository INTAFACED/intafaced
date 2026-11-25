// World: book, gates, restart, stack
import { marketDetails } from './futures-desk.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext, twoPerson } from '../../../../tooling/scripts/local-test-gates.mjs';
import { EDGE, ORIGIN, api, fromUnits, fund, journeyState, toUnits, tool } from './stack.mjs';
import { awayBid, held, openDesk, openOrders, placements, previewed, reviewSheet, signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  continueInWallet,
  doorOk,
  openVenueDesk,
  sameDecimal,
  signPrepared,
  testDeposit,
  testVenue,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
  venueWrites,
  walletDoorAct,
} from './venue.mjs';

// J-cex-spot-04 #2, #3, #5, #6 and #7, in the running app (docs/roadmap/journeys.json), on the stack's outside TEST
// venue: at launch a pair's rules are the venue's own (CUSTODY-DELTA: "Rules now come from the venue"), so the person
// reads them as the venue publishes them, with the venue named; below-minimum orders and finer digits refuse before
// preview; reaching the venue's open-order cap refuses naming how many are open and the cap; a rule the venue does not
// publish is shown as not published and left to the venue without defaulting, while a blank owner value refuses by name;
// and an order whose request deadline has passed refuses as expired before any lock. One test per step, titled
// "J-cex-spot-04 #<n>". J-cex-spot-04.pw.mjs holds #1 and #4 and keeps "part of #<n>" checks on today's custodial desk.
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
const ruleRow = async (page, rule) => (await marketDetails(page)).getByTestId('venue-rules').locator(`[data-rule="${rule}"]`);
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

/** Waits until svc-trade's user-venue door has refreshed its market list to see a newly added `symbol`. */
async function waitForDoorMarket(client, owner, symbol) {
  const probe = limitBuy(owner, symbol, '1', '20', 'probe');
  await expect
    .poll(async () => (await client.post('/api/v1/venue/preview', { owner, intent: probe })).status, { timeout: 90_000 })
    .toBe(200);
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

/** The own-book pair's published rules from the public market list. */
async function ownBookRules(symbol) {
  const res = await fetch(`${EDGE}/api/v1/markets?limit=500`, { headers: { origin: ORIGIN } });
  expect(res.status).toBe(200);
  const body = await res.json();
  const market = (Array.isArray(body) ? body : (body.markets ?? body.items ?? [])).find((m) => m.symbol === symbol);
  expect(market, `${symbol} is listed`).toBeTruthy();
  const rules = market.pairRules ?? market.info?.pairRules;
  expect(rules, `${symbol} publishes its rules`).toBeTruthy();
  return rules;
}

/** An amount on the lot that clears `cost` at `price`. */
function ownBookAmount(price, lot, cost = '10') {
  const one = toUnits('1');
  const step = toUnits(lot);
  const raw = (toUnits(cost) * one) / toUnits(price);
  return fromUnits(((raw + step - 1n) / step) * step);
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
  const panel = (await marketDetails(page)).getByTestId('venue-rules');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('venue-rules-source')).toHaveText(`As ${venue.displayName} publishes them`);
  const shown = async (rule) => (await (await ruleRow(page, rule)).locator('dd').innerText()).replace(/,/g, '');
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
  await expect((await ruleRow(page, 'largest')).locator('dd')).toHaveText(`${own.maxOrderQty} ${base}, or ${own.maxOrderNotional} USDC`);
  await expect(panel).not.toContainText('Not published');
  await stepPicture();

  // The market list the desk reads (our door's list of the markets INTAFACED shows) carries the venue's own figures,
  // our door names the venue on `/api/v1/venue/status`, and the desk's market switcher lists the pair on screen.
  await expect(page.locator(`option[value="${symbol}"]`)).toHaveCount(1);
  const customerClient = await api(c.account);
  const statusBody = (await customerClient.get('/api/v1/venue/status')).body;
  expect(statusBody.venue?.displayName).toBe(venue.displayName);
  const listed = (await customerClient.get('/api/v1/venue/markets')).body.value.find((m) => m.symbol === symbol);
  expect(listed, `${symbol} is on the customer's market list`).toBeTruthy();
  expect(sameDecimal(listed.tickSize, own.tickSize) && sameDecimal(listed.lotSize, own.lotSize)).toBe(true);
  expect(sameDecimal(listed.minOrderNotional, own.minOrderNotional)).toBe(true);
  expect(sameDecimal(listed.priceBandBps, own.priceBandBps)).toBe(true);
  expect(listed.maxOpenOrders).toBe(own.maxOpenOrders);
});

test(`${J} #6 trades a pair whose rule the venue doesn't publish, or where the owner has not published a band, cap or minimum: an unpublished venue rule is shown as not published and left to the venue without defaulting, and a blank owner value refuses by name`, async ({
  page,
  browser,
  stepPicture,
}) => {
  test.setTimeout(480_000);
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
  await expect((await ruleRow(page, 'min')).locator('dd')).toHaveText(`Not published by ${venue.displayName}`);
  await expect((await ruleRow(page, 'band')).locator('dd')).toHaveText(`Not published by ${venue.displayName}`);
  await expect((await ruleRow(page, 'cap')).locator('dd')).toHaveText(`Not published by ${venue.displayName}`);
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

  // On a pair with no published price band (like Hyperliquid spot), an order that clears client-side checks still asks
  // the venue rather than blocking locally, and shows the venue's own refusal verbatim when the venue refuses it.
  const tooLarge = limitBuy(c.owner, noBand, '101', '20', 'too-large-venue-refusal');
  const directRefusal = await testVenue('/preview', {
    account: { venueId: venue.id, owner: c.owner, subAccount: null },
    intent: tooLarge,
  });
  expect(directRefusal.status, JSON.stringify(directRefusal.body)).toBeGreaterThanOrEqual(400);
  const venueRefusalText = directRefusal.body.refusal?.detail ?? directRefusal.body.message ?? directRefusal.body.error;
  expect(venueRefusalText, JSON.stringify(directRefusal.body)).toBeTruthy();

  const refusedPage = await (await browser.newContext()).newPage();
  try {
    await openVenueDesk(refusedPage, c.account, `/trade/spot/${noBand}`, c.walletKey);
    await expect((await ruleRow(refusedPage, 'band')).locator('dd')).toHaveText(`Not published by ${venue.displayName}`);
    const previewWait = refusedPage.waitForResponse(
      (res) => res.url().includes('/api/v1/venue/preview') && res.request().method() === 'POST',
    );
    await buyForm(refusedPage).getByRole('textbox', { name: 'Price', exact: true }).fill('20');
    await buyForm(refusedPage).getByRole('textbox', { name: 'Amount', exact: true }).fill('101');
    const previewRes = await previewWait;
    expect(previewRes.status()).toBeGreaterThanOrEqual(400);
    const previewBody = await previewRes.json();
    expect(previewBody.intafacedCode).toBe('trade.venue.order_above_venue_max');
    const refusedNote = buyForm(refusedPage).getByTestId('venue-ticket-refused');
    await expect(refusedNote).toContainText(venueRefusalText, { timeout: 20_000 });
    await expect(buyForm(refusedPage).getByRole('button', { name: `Buy ${noBandBase}`, exact: true })).toBeDisabled();
  } finally {
    await refusedPage.context().close();
  }

  // The owner's branch: market orders are bounded by the owner's protections (slippage cap and spread limit). Left
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
      await stepPicture(desk);
    } finally {
      await desk.context().close();
    }

    // A second blank owner protection (spread limit) also refuses by name at the door.
    restartTrade({ LOCAL_STACK_USER_VENUE: 'on', LOCAL_STACK_TRADE_SPREAD_LIMIT: 'off' });
    const spreadRefused = await client.post('/api/v1/venue/preview', {
      owner: c.owner,
      intent: { ...market, clientOrderKey: `${market.clientOrderKey}-spread` },
    });
    expect(spreadRefused.status, JSON.stringify(spreadRefused.body).slice(0, 300)).toBeGreaterThanOrEqual(400);
    expect(spreadRefused.body.intafacedCode).toBe('trade.spread_limit_unset');
  } finally {
    restartTrade({ LOCAL_STACK_USER_VENUE: 'on' });
  }

  // Blank owner band, cap and minimum on a pair: each blank rule reads "Not published" on the desk and refuses with its
  // own typed refusal naming the missing rule, before any hold (BTC/USDT stays on the own-book desk while venue mode is on).
  const ownPair = 'BTC/USDT';
  const ownPublished = await ownBookRules(ownPair);
  expect(ownPublished.protection.collar).not.toBe('not set');
  expect(ownPublished.protection.openOrdersPerMarket).not.toBe('not set');
  expect(ownPublished.minNotional).not.toBe('not set');
  expect(fund(c.account.email, 'USDT', '500').tx).toBeTruthy();
  const beforeUsdt = held(await client.balances(), 'USDT');
  const ownPrice = await awayBid(95, ownPair);
  const ownAmount = ownBookAmount(ownPrice, ownPublished.lot);
  const sendOwn = (key) =>
    client.post('/api/v1/orders', {
      symbol: ownPair,
      type: 'limit',
      side: 'buy',
      amount: ownAmount,
      price: ownPrice,
      timeInForce: 'GTC',
      clientOrderId: `${J}-6-own-${key}-${Date.now()}`,
    });
  try {
    tool('local-test-gates.mjs', 'risk', ownPair, 'collar=unset', 'throttle=unset', 'minNotional=unset');
    await expect
      .poll(async () => {
        const r = await ownBookRules(ownPair);
        return [r.protection.collar, r.protection.openOrdersPerMarket, r.minNotional];
      })
      .toEqual(['not set', 'not set', 'not set']);

    const ownDesk = await (await browser.newContext()).newPage();
    try {
      await openDesk(ownDesk, c.account, ownPair);
      const sentOwn = placements(ownDesk);
      const rulesEl = ownDesk.locator('details[data-testid="dk-rules"]');
      await rulesEl.locator('summary').click();
      const ownRow = (name) => rulesEl.locator('dl > div').filter({ has: ownDesk.locator('dt', { hasText: new RegExp(`^${name}$`) }) });
      await expect(ownRow('Price band').locator('dd')).toHaveText('Not published');
      await expect(ownRow('Open orders').locator('dd')).toHaveText('Not published');
      await expect(ownRow('Smallest order value').locator('dd')).toHaveText('Not published');
      await buyForm(ownDesk).getByRole('textbox', { name: 'Price', exact: true }).fill(ownPrice);
      await previewed(ownDesk, () => buyForm(ownDesk).getByRole('textbox', { name: 'Amount', exact: true }).fill(ownAmount));
      const bandNote = buyForm(ownDesk).getByTestId('dk-note--bad');
      await expect(bandNote).toContainText('No price band is published');
      await expect(bandNote).not.toContainText('trade.');
      await expect(buyForm(ownDesk).getByRole('button', { name: 'Buy BTC', exact: true })).toBeDisabled();
      expect(sentOwn).toHaveLength(0);

      // 1. Blank owner band: 503 trade.price_band_unset naming price band.
      const noBandRes = await sendOwn('band');
      expect(noBandRes.status).toBe(503);
      expect(noBandRes.body.intafacedCode).toBe('trade.price_band_unset');

      // 2. Band back, cap and minimum still blank: 503 trade.open_orders_cap_unset naming open-order cap.
      tool('local-test-gates.mjs', 'risk', ownPair, `collar=${ownPublished.protection.collar}`);
      await expect.poll(async () => (await ownBookRules(ownPair)).protection.collar).toBe(ownPublished.protection.collar);
      const noCapRes = await sendOwn('cap');
      expect(noCapRes.status).toBe(503);
      expect(noCapRes.body.intafacedCode).toBe('trade.open_orders_cap_unset');

      // 3. Band and cap back, minimum still blank: desk names missing minimum, and 503 trade.min_notional_unset.
      tool('local-test-gates.mjs', 'risk', ownPair, `throttle=${ownPublished.protection.openOrdersPerMarket}`);
      await expect
        .poll(async () => (await ownBookRules(ownPair)).protection.openOrdersPerMarket)
        .toBe(ownPublished.protection.openOrdersPerMarket);
      await openDesk(ownDesk, c.account, ownPair);
      await buyForm(ownDesk).getByRole('textbox', { name: 'Price', exact: true }).fill(ownPrice);
      await previewed(ownDesk, () => buyForm(ownDesk).getByRole('textbox', { name: 'Amount', exact: true }).fill(ownAmount));
      const minNote = buyForm(ownDesk).getByTestId('dk-note--bad');
      await expect(minNote).toContainText('No minimum order value is published');
      await expect(minNote).not.toContainText('trade.');
      await expect(buyForm(ownDesk).getByRole('button', { name: 'Buy BTC', exact: true })).toBeDisabled();
      const noMinRes = await sendOwn('min');
      expect(noMinRes.status).toBe(503);
      expect(noMinRes.body.intafacedCode).toBe('trade.min_notional_unset');
      expect(await openOrders(c.account, ownPair)).toHaveLength(0);
      expect(held(await client.balances(), 'USDT')).toBe(beforeUsdt);
    } finally {
      await ownDesk.context().close();
    }
  } finally {
    tool(
      'local-test-gates.mjs',
      'risk',
      ownPair,
      `collar=${ownPublished.protection.collar}`,
      `throttle=${ownPublished.protection.openOrdersPerMarket}`,
      `minNotional=${ownPublished.minNotional}`,
    );
  }
  const ownRestored = await ownBookRules(ownPair);
  expect([ownRestored.protection.collar, ownRestored.protection.openOrdersPerMarket, ownRestored.minNotional]).toEqual([
    ownPublished.protection.collar,
    ownPublished.protection.openOrdersPerMarket,
    ownPublished.minNotional,
  ]);

  // Nothing rests and nothing is locked on the venue, on either pair: its own record, read straight from it.
  const after = await venueOwn(c.owner, symbol);
  expect(after.open).toHaveLength(0);
  expect(sameDecimal(after.locked, before.locked)).toBe(true);
  const ruledAfter = await venueOwn(c.owner, ruled);
  expect(ruledAfter.open).toHaveLength(ruledBefore.open.length);
  expect(sameDecimal(ruledAfter.locked, ruledBefore.locked)).toBe(true);
});

test(`${J} #3 types an amount below the smallest order, or finer than the lot or tick: "Too small" in words; finer digits cannot be typed; nothing is previewed or sent`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const c = customer();
  const { symbol, base } = await freshMarket('S', RULES);
  await listByApi(symbol);
  const own = await venueMarket(c.owner, symbol);
  expect(sameDecimal(own.minOrderNotional, RULES.minOrderNotional)).toBe(true);
  const before = await venueOwn(c.owner, symbol);
  expect(before.open).toHaveLength(0);

  const wallet = await openVenueDesk(page, c.account, `/trade/spot/${symbol}`, c.walletKey);
  const asked = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (r.method() === 'POST' && ['/api/v1/venue/preview', '/api/v1/venue/prepare', '/api/v1/venue/submit'].includes(p)) asked.push(p);
  });

  // Finer digits than the venue's tick or lot cannot be typed.
  const tickPlaces = (own.tickSize.split('.')[1] ?? '').length;
  const priceOnTick = tickPlaces > 0 ? `20.${'1'.repeat(tickPlaces)}` : '20';
  const priceBox = buyForm(page).getByRole('textbox', { name: 'Price', exact: true });
  await priceBox.fill('');
  await priceBox.pressSequentially(`${priceOnTick}5`);
  await expect(priceBox).toHaveValue(priceOnTick);

  const amountBox = buyForm(page).getByRole('textbox', { name: 'Amount', exact: true });
  await amountBox.fill('');
  await amountBox.pressSequentially(`${own.lotSize}5`);
  await expect(amountBox).toHaveValue(own.lotSize);

  // That order (20.1 × 0.001 = 0.0201 USDC) is below the venue's smallest order value (10 USDC): "Too small" in words,
  // Buy disabled, and nothing previewed or sent.
  const note = buyForm(page).getByTestId('venue-ticket-below-min');
  await expect(note).toHaveText(`Too small: the smallest order is ${own.minOrderNotional} USDC. Nothing was previewed or sent.`);
  await expect(buyForm(page).getByRole('button', { name: `Buy ${base}`, exact: true })).toBeDisabled();
  await stepPicture();

  // Nothing was previewed, prepared, signed or locked on the TEST venue itself.
  const after = await venueOwn(c.owner, symbol);
  expect(asked).toEqual([]);
  expect(wallet.requests).toHaveLength(0);
  expect(after.open).toHaveLength(0);
  expect(sameDecimal(after.locked, before.locked)).toBe(true);
});

test(`${J} #5 reaches the open-order cap: refused with the cap and how many are open; nothing held`, async ({ page, stepPicture }) => {
  test.setTimeout(300_000);
  const c = customer();
  const key = privateKeyToAccount(c.walletKey);
  const client = await api(c.account);
  const venue = await venueInfo();
  const { symbol, base } = await freshMarket('C', RULES);
  await listByApi(symbol);
  await waitForDoorMarket(client, c.owner, symbol);

  const own = await venueMarket(c.owner, symbol);
  const cap = own.maxOpenOrders;
  expect(Number.isInteger(cap) && cap > 0).toBe(true);
  expect((await venueRecord(c.owner, '/open-orders')).value).toHaveLength(0);

  const placedKeys = [];
  try {
    for (let i = 0; i < cap; i++) {
      const intent = limitBuy(c.owner, symbol, '1', '20', `cap-${i}`);
      await walletDoorAct(client, key, { intent });
      placedKeys.push(intent.clientOrderKey);
    }
    expect((await venueRecord(c.owner, '/open-orders')).value).toHaveLength(cap);
    const lockedAtCap = (await venueBalance(c.owner, 'USDC')).locked;

    // On the desk, typing another valid order is refused naming how many are open and the venue's cap; nothing is signed.
    const wallet = await openVenueDesk(page, c.account, `/trade/spot/${symbol}`, c.walletKey);
    const writes = venueWrites(page);
    await buyForm(page).getByRole('textbox', { name: 'Price', exact: true }).fill('20');
    await buyForm(page).getByRole('textbox', { name: 'Amount', exact: true }).fill('1');
    const note = buyForm(page).getByTestId('venue-ticket-refused');
    await expect(note).toBeVisible({ timeout: 15_000 });
    await expect(note).toContainText(`this account has ${cap} open orders and ${venue.displayName} allows ${cap}`);
    await expect(buyForm(page).getByRole('button', { name: `Buy ${base}`, exact: true })).toBeDisabled();
    expect(writes).toEqual([]);
    expect(wallet.requests).toHaveLength(0);
    await stepPicture();

    // Direct prepare on our door refuses with the same venue cap, before anything is prepared or locked.
    const refused = await client.post('/api/v1/venue/prepare', {
      owner: c.owner,
      signer: { role: 'owner', address: c.owner },
      intent: limitBuy(c.owner, symbol, '1', '20', 'over-cap'),
    });
    expect(refused.status, JSON.stringify(refused.body).slice(0, 300)).toBe(422);
    expect(refused.body.intafacedCode).toBe('trade.venue.open_orders_above_venue_cap');
    expect(refused.body.message).toContain(`${cap} open orders`);
    expect(refused.body.message).toContain(`allows ${cap}`);
    expect((await venueRecord(c.owner, '/open-orders')).value).toHaveLength(cap);
    expect(sameDecimal((await venueBalance(c.owner, 'USDC')).locked, lockedAtCap)).toBe(true);
  } finally {
    for (const clientOrderKey of placedKeys) {
      await walletDoorAct(client, key, {
        intent: { kind: 'cancel_order', symbol, clientOrderKey },
        actionKey: `cancel:${clientOrderKey}`,
      });
    }
  }
  expect((await venueRecord(c.owner, '/open-orders')).value).toHaveLength(0);
});

test(`${J} #7 sends an order whose request deadline has passed: refused as expired before any hold`, async ({ page, stepPicture }) => {
  test.setTimeout(300_000);
  const c = customer();
  const key = privateKeyToAccount(c.walletKey);
  const client = await api(c.account);
  const { symbol } = await freshMarket('D', RULES);
  await listByApi(symbol);
  await waitForDoorMarket(client, c.owner, symbol);

  await venueMarket(c.owner, symbol);
  const before = await venueOwn(c.owner, symbol);
  expect(before.open).toHaveLength(0);

  // 1. Expired deadline on prepare: 400 trade.request_expired, nothing prepared or locked on the venue.
  const expiredPrep = await client.post('/api/v1/venue/prepare', {
    owner: c.owner,
    signer: { role: 'owner', address: c.owner },
    intent: limitBuy(c.owner, symbol, '1', '20', 'expired-prep'),
    requestDeadline: new Date(Date.now() - 60_000).toISOString(),
  });
  expect(expiredPrep.status, JSON.stringify(expiredPrep.body).slice(0, 300)).toBe(400);
  expect(expiredPrep.body.intafacedCode).toBe('trade.request_expired');
  const afterPrep = await venueOwn(c.owner, symbol);
  expect(afterPrep.open).toHaveLength(0);
  expect(sameDecimal(afterPrep.locked, before.locked)).toBe(true);

  // 2. Prepared and signed before the deadline, then submitted after it passed: 400 trade.request_expired, nothing locked.
  const subIntent = limitBuy(c.owner, symbol, '1', '20', 'expired-sub');
  const prep = doorOk(
    await client.post('/api/v1/venue/prepare', {
      owner: c.owner,
      signer: { role: 'owner', address: c.owner },
      intent: subIntent,
      requestDeadline: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  const sig = await signPrepared(key, prep.prepared);
  const expiredSub = await client.post('/api/v1/venue/submit', {
    actionKey: prep.actionKey,
    signature: sig,
    requestDeadline: new Date(Date.now() - 1_000).toISOString(),
  });
  expect(expiredSub.status, JSON.stringify(expiredSub.body).slice(0, 300)).toBe(400);
  expect(expiredSub.body.intafacedCode).toBe('trade.request_expired');
  const afterSub = await venueOwn(c.owner, symbol);
  expect(afterSub.open).toHaveLength(0);
  expect(sameDecimal(afterSub.locked, before.locked)).toBe(true);

  // 3. Control: the exact same signed order with a future deadline succeeds on the venue, proving the deadline caused
  // the refusal; then cancel it cleanly.
  try {
    const sent = doorOk(
      await client.post('/api/v1/venue/submit', {
        actionKey: prep.actionKey,
        signature: sig,
        requestDeadline: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    expect(sent.outcome, JSON.stringify(sent.outcome).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
    const placed = await venueOwn(c.owner, symbol);
    expect(placed.open).toHaveLength(1);
    expect(sameDecimal(placed.locked, '20')).toBe(true);
  } finally {
    await walletDoorAct(client, key, {
      intent: { kind: 'cancel_order', symbol, clientOrderKey: subIntent.clientOrderKey },
      actionKey: `cancel:${subIntent.clientOrderKey}`,
    });
  }
  const finalOwn = await venueOwn(c.owner, symbol);
  expect(finalOwn.open).toHaveLength(0);
  expect(sameDecimal(finalOwn.locked, before.locked)).toBe(true);

  // On the desk, the venue account shows zero locked USDC matching the venue's own record.
  await openVenueDesk(page, c.account, `/trade/spot/${symbol}`, c.walletKey);
  const usedCell = page.getByTestId('venue-account').locator('dl[data-asset="USDC"] [data-cell="used"]');
  await expect(usedCell).toBeVisible();
  await expect.poll(async () => sameDecimal((await usedCell.innerText()).replace(/\s*USDC\s*$/, ''), finalOwn.locked)).toBe(true);
  await stepPicture();
});
