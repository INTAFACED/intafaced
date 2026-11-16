// World: book, gates, restart, stack
import { createHash, randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fromUnits, journeyState, otherTrader, toUnits } from './stack.mjs';
import { awayBid as engineAwayBid, reviewSheet, signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { approverSessions, makeContext, twoPerson } from '../../../../tooling/scripts/local-test-gates.mjs';
import {
  continueInWallet,
  openVenueDesk,
  otherTraderKey,
  otherTraderRun,
  sameDecimal,
  testDeposit,
  testVenue,
  venueAccount,
  venueBalance,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-charts-desk-14 "I read the order flow: time and sales, depth, ladder and the DOM, and trade from the ladder", in the
// running app (docs/roadmap/journeys.json), on the venue spot desk under the launch money model
// (docs/adr/2026-11-10-launch-money-model.md): the person's money is in their own venue account and the ledger records
// none of it. One test per step, titled "J-charts-desk-14 #<n>", on one TEST account: verified, its TEST wallet connected,
// TEST USDC in its own venue account, the venue desk's chart open on BTC-USDC. Every figure the DOM shows is compared with
// the stack's TEST venue's own record (packages/venue-sim), read here on loopback, never our engine or ledger; the ledger
// is read only to show it posts nothing. Money line: an order from the ladder or the chart is the desk's own signed venue
// order (J-cex-spot-02): one venue order per client order id and one signature; nothing is signed or sent from a click
// without the review unless instant placement is on. The user-venue door is on for this file only.
const J = 'J-charts-desk-14';
const SYMBOL = 'BTC-USDC';
const DESK = `/trade/spot/${SYMBOL}`;
const SMALL = '0.001'; // about 60 TEST USDC at the TEST venue's price
const LARGE = '0.005';
const BETWEEN = '0.003';
const START_USDC = '2000';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J}'s TEST setup made no account and wallet, so this step has no one to act as`);
  return s;
}
const ownerOf = (s) => privateKeyToAccount(s.walletKey).address.toLowerCase();

// ── the TEST venue's own record ──

/** Today's engine market, read only for the engine queue read's privacy checks in #8. */
const ENGINE_SYMBOL = 'BTC/USDT';
const venueOpen = async (owner) => (await venueRecord(owner, '/open-orders')).value;
const venueByClientId = async (owner, venueClientOrderId) =>
  (await venueRecord(owner, '/order-by-client-id', { venueClientOrderId })).value;
/** The venue's own book on `symbol`, as deep as the DOM reads it (50 levels a side). */
async function venueBook(symbol = SYMBOL) {
  const { status, body } = await testVenue('/book', { symbol, depth: 50 });
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.value;
}
async function venueBest(symbol = SYMBOL) {
  const { status, body } = await testVenue('/best-prices', { symbol });
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.value;
}
async function venuePrints(symbol = SYMBOL, limit = 500) {
  const { status, body } = await testVenue('/trades', { symbol, limit });
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}
async function venueMarketRules(symbol = SYMBOL) {
  const { body } = await testVenue('/markets', {});
  const market = body.value.find((m) => m.symbol === symbol);
  expect(market, `${symbol} is a TEST venue market`).toBeTruthy();
  return market;
}

/** Our ledger's view of this account: this journey's ledger posts nothing. */
const ledgerView = async (who) => (await api(who)).balances();
/** The wallet's signature prompts so far (typed data is the only thing a venue action is signed as). */
const signatures = (wallet) => wallet.requests.filter((r) => r.method === 'eth_signTypedData_v4').length;
/** Every door call this page makes, by its path (`prepare`, `submit`, `preview`), with its body. */
function doorCalls(page) {
  const calls = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === 'POST' && path.startsWith('/api/v1/venue/'))
      calls.push({ path: path.slice('/api/v1/venue/'.length), body: r.postDataJSON() });
  });
  return { all: calls, of: (name) => calls.filter((c) => c.path === name), sent: () => calls.filter((c) => c.path !== 'preview') };
}
/** The next venue preview the page asks for, and the venue's answer to it. */
const nextPreview = (page) =>
  page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');

/** A decimal string as one canonical form: no thousands separators, no unit, no trailing zeros. */
const canon = (text) =>
  String(text)
    .replace(/[^\d.]/g, '')
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
const same = (a, b) => toUnits(canon(a) || '0') === toUnits(canon(b) || '0');

/** The person signs one action on the TEST venue with their own TEST wallet key, outside the app: TEST setup only. */
async function personRun(walletKey, intent) {
  const key = privateKeyToAccount(walletKey);
  const owner = key.address.toLowerCase();
  const prepared = await testVenue('/prepare', { account: await venueAccount(owner), signer: { role: 'owner', address: owner }, intent });
  expect(prepared.status, JSON.stringify(prepared.body).slice(0, 300)).toBe(200);
  const typed = prepared.body.typedData;
  const signature = await key.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  const sent = await testVenue('/submit', {
    prepared: prepared.body,
    signature: { digest: prepared.body.digest, signature, signedBy: owner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(200);
  return sent.body;
}

/** Another TEST trader with TEST funds in its own venue account (deposits keyed by a chain-transfer-shaped reference). */
async function fundedOther(name, funds) {
  const owner = otherTraderKey(name).address.toLowerCase();
  for (const [asset, amount] of Object.entries(funds))
    await testDeposit(owner, asset, amount, `84532:0x${randomBytes(32).toString('hex')}:0`);
  return owner;
}
const limitIntent = (symbol, side, price, amount, key, timeInForce = 'GTC') => ({
  kind: 'place_order',
  symbol,
  side,
  type: 'limit',
  amount,
  price,
  timeInForce,
  reduceOnly: false,
  clientOrderKey: key,
  builderFee: null,
});

// ── the operators, to list this file's own second market (J-cex-spot-16's two-person door) ──

const LISTING_SET = 'trade.venue_listing_set';
const POLICY = 'trade-venue-markets-v1';
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

/**
 * A second spot market of this run's own on the TEST venue, listed by two operators through svc-trade's door and quoted
 * by another TEST trader, so the chart has a second venue market to move to that no other journey trades.
 */
async function secondMarket() {
  const base = `J14${randomBytes(3).toString('hex').toUpperCase()}`;
  const symbol = `${base}-USDC`;
  const added = await testVenue('/test/market-add', {
    symbol,
    baseAsset: base,
    quoteAsset: 'USDC',
    maxOrderQty: '100',
    maxOrderNotional: '10000',
  });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  const ctx = await makeContext({ log: () => undefined });
  const sessions = await approverSessions(ctx);
  const venueId = (await venueInfo()).id;
  const opensAt = new Date(Date.now() - 60_000).toISOString();
  const reason = `LOCAL TEST ${J}: list ${symbol} as the chart's second market`;
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
  const maker = 'jcd14-second-maker';
  await fundedOther(maker, { USDC: '1000', [base]: '10' });
  for (const [side, price] of [
    ['buy', '9.9'],
    ['buy', '9.8'],
    ['sell', '10.1'],
  ])
    expect(await otherTraderRun(maker, limitIntent(symbol, side, price, '1', `order:jcd14:${symbol}:${side}:${price}`))).toMatchObject({
      definite: true,
      accepted: true,
    });
  return symbol;
}

/**
 * TEST setup, not a step (the Starts line), made at the start of #1: a verified account, this run's TEST wallet key, TEST
 * USDC in its own venue account by the TEST venue's deposit control, our TEST builder fee approved on that account by its
 * own key (a sell carries it), and a second listed TEST market. Made in #1, never in a beforeAll: a worker that restarts
 * after a failed step would run a beforeAll again and replace the account the later steps act as.
 */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'jcd14v');
    await verify(page, account);
    const walletKey = testWalletKey();
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', START_USDC, `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    expect(sameDecimal((await venueBalance(owner, 'USDC')).free, START_USDC)).toBe(true);
    const status = await (await api(account)).get('/api/v1/venue/status');
    expect(status.status, JSON.stringify(status.body).slice(0, 300)).toBe(200);
    const builder = status.body.builder;
    expect(builder, 'the TEST stack publishes our TEST builder fee').toBeTruthy();
    expect(await personRun(walletKey, { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps })).toMatchObject({
      definite: true,
      accepted: true,
    });
    run.reset({ account, walletKey, second: await secondMarket() });
  } finally {
    await page.close();
  }
}

// ── the desk ──

const dom = (page) => page.getByRole('region', { name: 'Depth of market' });
const ladder = (page) => dom(page).getByRole('grid', { name: 'Depth of market' });
const tapeRegion = (page) => page.getByRole('region', { name: 'Time and sales' });
const chartTrade = (page) => page.getByRole('group', { name: 'Trade from the chart' });
const buyForm = (page) => page.locator('form[data-testid="dk-form"][data-side="buy"]');
const sellForm = (page) => page.locator('form[data-testid="dk-form"][data-side="sell"]');

/** Open the DOM from the chart's own button, unless it is already showing. */
async function openDom(page) {
  const button = page.getByTestId('venue-chart').getByRole('button', { name: /^(Open|Close) DOM$/ });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await expect(dom(page)).toBeVisible();
}

async function setLadder(page, columns, step) {
  await dom(page).getByLabel('Columns').selectOption({ label: columns });
  await dom(page).getByLabel('Price step').selectOption({ label: step });
}

/** The ladder and the depth chart as the page has them, read in one go so both come from one render. */
async function readFlow(page) {
  return page.evaluate(() => {
    const region = document.querySelector('[data-testid="of-dom"]');
    const grid = region?.querySelector('[data-testid="of-ladder"]');
    const chart = region?.querySelector('[data-testid="of-depth-chart"]');
    const rowsRead = [...(region?.querySelectorAll('[data-testid="of-ladder-row"]') ?? [])].map((row) => ({
      price: row.getAttribute('data-price'),
      bid: row.getAttribute('data-bid'),
      ask: row.getAttribute('data-ask'),
      myBid: row.getAttribute('data-my-bid'),
      highlight: row.getAttribute('data-highlight'),
    }));
    return {
      symbol: region?.getAttribute('data-symbol'),
      nonce: region?.getAttribute('data-book-nonce'),
      step: grid?.getAttribute('data-step'),
      bestBid: grid?.getAttribute('data-best-bid') ?? null,
      bestAsk: grid?.getAttribute('data-best-ask') ?? null,
      bidTotal: grid?.getAttribute('data-bid-total') ?? null,
      askTotal: grid?.getAttribute('data-ask-total') ?? null,
      rows: rowsRead,
      chart: chart
        ? {
            nonce: chart.getAttribute('data-book-nonce'),
            bidTotal: chart.getAttribute('data-bid-total'),
            askTotal: chart.getAttribute('data-ask-total'),
            bids: (chart.getAttribute('data-bid-points') ?? '').split(' ').filter(Boolean),
            asks: (chart.getAttribute('data-ask-points') ?? '').split(' ').filter(Boolean),
          }
        : null,
    };
  });
}

const sumOf = (levels) => levels.reduce((s, l) => s + toUnits(l.amount), 0n);

/**
 * At one tick, the ladder is the venue's own book level for level: every bid and ask price with its size, and the best
 * prices and totals, equal the TEST venue's own `/book` read (polled: the DOM reads the venue every 2 s).
 */
async function ladderIsVenueBook(page, symbol) {
  await expect
    .poll(
      async () => {
        const flow = await readFlow(page);
        const book = await venueBook(symbol);
        if (flow.symbol !== symbol) return `DOM on ${flow.symbol}`;
        const bids = flow.rows.filter((r) => r.bid).map((r) => `${canon(r.price)}:${canon(r.bid)}`);
        const asks = flow.rows
          .filter((r) => r.ask)
          .map((r) => `${canon(r.price)}:${canon(r.ask)}`)
          .reverse();
        const want = (levels) => levels.map((l) => `${canon(l.price)}:${canon(l.amount)}`);
        if (JSON.stringify(bids) !== JSON.stringify(want(book.bids))) return `bids ${bids} vs ${want(book.bids)}`;
        if (JSON.stringify(asks) !== JSON.stringify(want(book.asks))) return `asks ${asks} vs ${want(book.asks)}`;
        if (!same(flow.bidTotal, fromUnits(sumOf(book.bids))) || !same(flow.askTotal, fromUnits(sumOf(book.asks)))) return 'totals';
        if (book.bids[0] ? !same(flow.bestBid, book.bids[0].price) : flow.bestBid !== '') return 'best bid';
        if (book.asks[0] ? !same(flow.bestAsk, book.asks[0].price) : flow.bestAsk !== '') return 'best ask';
        return 'same';
      },
      { timeout: 20_000, message: `the ladder is the TEST venue's own ${symbol} book` },
    )
    .toBe('same');
}

/**
 * Press the ask cell (a buy) of a ladder row and return the row's price: the row with the best ask, or the `nth` row that
 * has bids (0 is the best). Found and pressed in one browser task, so a requote cannot move the press onto another row.
 */
async function pressAskCell(page, which) {
  let price = null;
  await expect
    .poll(
      async () => {
        price = await dom(page).evaluate((region, w) => {
          const rows = [...region.querySelectorAll('[data-testid="of-ladder-row"]')];
          const row =
            w === 'best-ask'
              ? rows.find((r) => r.getAttribute('data-highlight') === 'best-ask')
              : rows.filter((r) => r.getAttribute('data-bid'))[w];
          const button = row?.querySelector('[data-testid="of-ask-cell"]');
          if (!(button instanceof HTMLButtonElement)) return null;
          button.click();
          return row.getAttribute('data-price');
        }, which);
        return price !== null;
      },
      { timeout: 20_000, message: `the ladder has the ${which} row` },
    )
    .toBe(true);
  return price;
}

/** Press a button and return the amount and price it showed at that very moment, in one browser task. */
async function pressShowing(button) {
  return button.evaluate((el) => {
    const shown = { amount: el.getAttribute('data-amount'), price: el.getAttribute('data-price') };
    el.click();
    return shown;
  });
}

/** Press one-click cancel on the ladder row whose bucket holds `price` (single column, one tick), in one browser task. */
async function pressRowCancel(page, price) {
  const want = canon(price);
  await expect
    .poll(
      () =>
        dom(page).evaluate((region, target) => {
          const c = (text) =>
            String(text)
              .replace(/[^\d.]/g, '')
              .replace(/(\.\d*?)0+$/, '$1')
              .replace(/\.$/, '');
          const row = [...region.querySelectorAll('[data-testid="of-ladder-row"]')].find(
            (el) => c(el.getAttribute('data-price') ?? '') === target,
          );
          const button = row?.querySelector('[data-testid="of-row-cancel"]');
          if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
          button.click();
          return true;
        }, want),
      { timeout: 20_000, message: `one-click cancel on the ladder row at ${price}` },
    )
    .toBe(true);
}

/** A TEST price `percent` of the venue's own best bid, on the tick: a buy there rests and never fills. */
async function awayBid(percent) {
  const { bid } = await venueBest();
  expect(bid, 'the TEST venue has a bid').toBeTruthy();
  const tick = toUnits((await venueMarketRules()).tickSize);
  return fromUnits(((toUnits(bid) * BigInt(percent)) / 100n / tick) * tick);
}

/** Types a limit buy on the venue ticket, reviews it, confirms it in the wallet; returns the venue's order for it. */
async function placeLimitBuy(page, wallet, owner, price, amount) {
  await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
  const form = buyForm(page);
  await form.getByRole('textbox', { name: 'Price' }).fill(price);
  const preview = nextPreview(page);
  await form.getByRole('textbox', { name: 'Amount' }).fill(amount);
  expect((await preview).status()).toBe(200);
  await page.getByRole('button', { name: 'Buy BTC' }).click();
  const review = reviewSheet(page);
  await expect(review).toBeVisible();
  const asked = signatures(wallet);
  const prepared = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/prepare' && r.request().method() === 'POST');
  await review.getByRole('button', { name: 'Confirm buy' }).click();
  await continueInWallet(page);
  const { prepared: p } = await (await prepared).json();
  const id = p.venueClientOrderId;
  await expect.poll(async () => (await venueByClientId(owner, id))?.status, { timeout: 20_000 }).toBe('open');
  expect(signatures(wallet)).toBe(asked + 1);
  return { ...(await venueByClientId(owner, id)), clientOrderKey: p.intent.clientOrderKey };
}

/** The account's own `trade.instant` record, read from identity as the signed-in person. */
async function instantRecord(who) {
  const input = encodeURIComponent(JSON.stringify({ namespace: 'trade.instant' }));
  const res = await (await api(who)).get(`/api/identity/trpc/preferences.get?input=${input}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}
const oneClick = (page) => dom(page).getByRole('region', { name: 'One-click trading' });
const instantSwitch = (page) => oneClick(page).getByRole('switch', { name: 'Instant placement' });
const instantStatus = (page) => oneClick(page).getByTestId('of-instant-status');
const summary = (page) => page.getByTestId('of-instant-summary');
async function turnInstantOn(page) {
  await instantSwitch(page).click();
  await expect(summary(page)).toBeVisible();
  await summary(page).getByLabel('I understand that my clicks will send orders without a review.').check();
  const write = page.waitForResponse((r) => r.url().includes('preferences.set') && r.request().method() === 'POST');
  await summary(page).getByRole('button', { name: 'Turn on instant placement' }).click();
  expect((await write).status()).toBe(200);
  await expect(summary(page)).toHaveCount(0);
  await expect(instantSwitch(page)).toHaveAttribute('aria-checked', 'true');
}
async function turnInstantOff(page) {
  const write = page.waitForResponse((r) => r.url().includes('preferences.set') && r.request().method() === 'POST');
  await instantSwitch(page).click();
  expect((await write).status()).toBe(200);
  await expect(instantSwitch(page)).toHaveAttribute('aria-checked', 'false');
}

/** The venue desk again after another page or a reload: the TEST wallet, still authorised, comes back connected. */
async function backToDesk(page, reload = false) {
  if (reload) await page.reload();
  else await page.goto(DESK);
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('venue-wallet-address')).toBeVisible({ timeout: 15_000 });
}

/** The venue desk with its chart open, signed in with the TEST wallet connected, the DOM opened from the chart. */
async function deskWithDom(page, s, { columns = 'Single', step = '1 tick' } = {}) {
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  await openDom(page);
  await setLadder(page, columns, step);
  return wallet;
}

test(`${J} #1 opens the DOM from the chart; it binds to the chart's symbol and re-binds when the symbol changes`, async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  await startsLine(browser);
  const s = state();
  const owner = ownerOf(s);
  const ledgerBefore = await ledgerView(s.account);
  const openBefore = await venueOpen(owner);
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const door = doorCalls(page);
  await openDom(page);
  await expect(page.getByTestId('venue-chart').getByRole('button', { name: 'Close DOM' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dom(page)).toHaveAttribute('data-symbol', SYMBOL);
  await expect(dom(page).getByRole('heading', { name: `Depth of market for ${SYMBOL}` })).toBeVisible();
  await expect(dom(page).getByTestId('venue-test')).toBeVisible();
  await setLadder(page, 'Single', '1 tick');
  await ladderIsVenueBook(page, SYMBOL);
  // A ladder setting, to see that it follows the DOM to the next symbol.
  await setLadder(page, 'Double', '2 ticks');
  await expect(dom(page)).toHaveAttribute('data-columns', 'double');

  // The chart's symbol changes, from the chart's own market list: the DOM is still open, bound to the new symbol, with
  // the same ladder settings, and its ladder is that market's venue book.
  await page.getByTestId('venue-chart').getByLabel('Chart market').selectOption(s.second);
  await expect(page).toHaveURL(new RegExp(`/trade/spot/${s.second}$`));
  await expect(page.getByTestId('if-desk')).toHaveAttribute('data-market', s.second);
  await expect(dom(page)).toHaveAttribute('data-symbol', s.second);
  await expect(dom(page).getByRole('heading', { name: `Depth of market for ${s.second}` })).toBeVisible();
  await expect(dom(page)).toHaveAttribute('data-columns', 'double');
  await expect(dom(page)).toHaveAttribute('data-step-ticks', '2');
  await setLadder(page, 'Single', '1 tick');
  await ladderIsVenueBook(page, s.second);
  const second = await venueBook(s.second);
  expect(second.bids.length).toBeGreaterThan(0);
  // Back to BTC-USDC: bound again, to its venue book.
  await page.getByTestId('venue-chart').getByLabel('Chart market').selectOption(SYMBOL);
  await expect(dom(page)).toHaveAttribute('data-symbol', SYMBOL);
  await ladderIsVenueBook(page, SYMBOL);
  // Reading sends nothing: no prepare or submit, no signature, the venue holds the same orders, the ledger posts nothing.
  expect(door.sent()).toEqual([]);
  expect(signatures(wallet)).toBe(0);
  expect(await venueOpen(owner)).toEqual(openBefore);
  expect(await ledgerView(s.account)).toEqual(ledgerBefore);
});

test(`${J} #2 reads time and sales and the depth chart: the tape with filters and the depth curve from the same book`, async ({ page }) => {
  test.setTimeout(240_000);
  const s = state();
  const owner = ownerOf(s);
  const ledgerBefore = await ledgerView(s.account);
  // Two prints of known size on the venue from another TEST trader: a small and a larger buy at the venue's best ask.
  const taker = 'jcd14-taker';
  await fundedOther(taker, { USDC: '2000' });
  for (const [n, amount] of [
    [1, SMALL],
    [2, LARGE],
  ]) {
    const { ask } = await venueBest();
    const answer = await otherTraderRun(
      taker,
      limitIntent(SYMBOL, 'buy', ask, amount, `order:jcd14-print-${n}-${randomBytes(4).toString('hex')}`, 'IOC'),
    );
    expect(answer).toMatchObject({ definite: true, accepted: true });
  }
  const wallet = await deskWithDom(page, s);
  const door = doorCalls(page);
  const tapeRows = () => tapeRegion(page).getByTestId('of-tape-row');
  const rowsOf = () =>
    tapeRows().evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute('data-trade-id'),
        price: el.getAttribute('data-price'),
        amount: el.getAttribute('data-amount'),
      })),
    );
  const amounts = async () => (await rowsOf()).map((r) => canon(r.amount));
  const values = async () => (await tapeRows().evaluateAll((els) => els.map((el) => el.getAttribute('data-value')))).map(canon);
  const hiddenNote = tapeRegion(page).getByTestId('of-tape-hidden');

  // No minimum: the tape is the venue's own newest prints, print for print, the small one on it, nothing hidden.
  await tapeRegion(page).getByLabel('Hide trades under').fill('');
  await expect
    .poll(
      async () => {
        const shown = await rowsOf();
        const { value } = await venuePrints();
        const want = value.slice(0, shown.length).map((p) => `${p.tradeId}|${canon(p.price)}|${canon(p.amount)}`);
        return (
          shown.length > 0 && JSON.stringify(shown.map((r) => `${r.id}|${canon(r.price)}|${canon(r.amount)}`)) === JSON.stringify(want)
        );
      },
      { timeout: 20_000, message: 'the tape is the TEST venue’s own prints' },
    )
    .toBe(true);
  expect((await amounts()).some((a) => same(a, SMALL))).toBe(true);
  await expect(hiddenNote).toHaveAttribute('data-hidden', '0');

  // A minimum of 0.003 BTC: every print under it leaves the tape and is counted as hidden; the large one stays.
  await tapeRegion(page).getByLabel('Units').selectOption({ label: 'BTC' });
  await tapeRegion(page).getByLabel('Hide trades under').fill(BETWEEN);
  await expect.poll(async () => (await amounts()).every((a) => toUnits(a) >= toUnits(BETWEEN))).toBe(true);
  expect((await amounts()).some((a) => same(a, LARGE))).toBe(true);
  expect((await amounts()).some((a) => same(a, SMALL))).toBe(false);
  await expect.poll(async () => Number(await hiddenNote.getAttribute('data-hidden'))).toBeGreaterThanOrEqual(1);
  const hidden = await hiddenNote.getAttribute('data-hidden');
  const total = await hiddenNote.getAttribute('data-total');
  await expect(hiddenNote).toHaveText(`${hidden} of ${total} trades are below the minimum and hidden.`);
  // Hidden is exactly the venue's prints under the minimum, among those the tape read.
  const read = (await venuePrints()).value.slice(0, Number(total));
  expect(read.filter((p) => toUnits(p.amount) < toUnits(BETWEEN)).length).toBe(Number(hidden));

  // The same filter in quote units: 50 USDC lets the small print (about 60 USDC) back on, and hides anything smaller.
  await tapeRegion(page).getByLabel('Units').selectOption({ label: 'USDC' });
  await tapeRegion(page).getByLabel('Hide trades under').fill('50');
  await expect.poll(async () => (await amounts()).some((a) => same(a, SMALL))).toBe(true);
  expect((await values()).every((v) => toUnits(v) >= toUnits('50'))).toBe(true);

  // Accumulate at price: no two rows next to each other share a price and side any more.
  await tapeRegion(page).getByLabel('Hide trades under').fill('');
  await tapeRegion(page).getByLabel('Accumulate at price').check();
  const pairs = await tapeRows().evaluateAll((els) => els.map((el) => `${el.getAttribute('data-price')}|${el.getAttribute('data-side')}`));
  for (let i = 1; i < pairs.length; i++) expect(pairs[i], `rows ${i - 1} and ${i}`).not.toBe(pairs[i - 1]);
  await tapeRegion(page).getByLabel('Accumulate at price').uncheck();

  // The depth curve is drawn from the same venue book read as the ladder: the same read's mark, the same totals, its first
  // point on each side the ladder's best price with the size there, and its totals the venue's own book.
  const chart = page.getByRole('img', { name: new RegExp(`^Depth chart of ${SYMBOL}`) });
  await expect(chart).toBeVisible();
  await expect
    .poll(async () => {
      const flow = await readFlow(page);
      if (!flow.chart || flow.nonce !== flow.chart.nonce) return 'not one book';
      const book = await venueBook();
      const bestBidRow = flow.rows.find((r) => r.highlight === 'best-bid');
      const bestAskRow = flow.rows.find((r) => r.highlight === 'best-ask');
      const [bidPrice, bidCum] = flow.chart.bids[0].split(':');
      const [askPrice, askCum] = flow.chart.asks[0].split(':');
      return [
        flow.chart.bidTotal === flow.bidTotal,
        flow.chart.askTotal === flow.askTotal,
        same(bidPrice, bestBidRow.price) && same(bidCum, bestBidRow.bid),
        same(askPrice, bestAskRow.price) && same(askCum, bestAskRow.ask),
        same(flow.chart.bids.at(-1).split(':')[1], flow.bidTotal),
        same(flow.chart.asks.at(-1).split(':')[1], flow.askTotal),
        same(flow.chart.bidTotal, fromUnits(sumOf(book.bids))) && same(flow.chart.askTotal, fromUnits(sumOf(book.asks))),
        same(bidPrice, book.bids[0].price) && same(askPrice, book.asks[0].price),
      ].every(Boolean)
        ? 'one book'
        : 'differs';
    })
    .toBe('one book');
  const flow = await readFlow(page);
  for (const side of [flow.chart.bids, flow.chart.asks])
    for (let i = 1; i < side.length; i++) expect(toUnits(side[i].split(':')[1])).toBeGreaterThan(toUnits(side[i - 1].split(':')[1]));
  // Pointing at the curve reads the cumulative size at a price of that book.
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
  const readout = page.getByTestId('of-depth-readout');
  await expect(readout).toHaveText(/^Cumulative [\d.,]+ BTC at [\d.,]+$/);
  const pointed = `${await readout.getAttribute('data-price')}:${await readout.getAttribute('data-amount')}`;
  const now = await readFlow(page);
  expect([...now.chart.bids, ...now.chart.asks]).toContain(pointed);
  // Reading sends nothing.
  expect(door.sent()).toEqual([]);
  expect(signatures(wallet)).toBe(0);
  expect(await venueOpen(owner)).toEqual([]);
  expect(await ledgerView(s.account)).toEqual(ledgerBefore);
});

test(`${J} #3 sets the ladder to double columns with a price step of 2 ticks; prices group by the step with highlights`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const owner = ownerOf(s);
  const ledgerBefore = await ledgerView(s.account);
  const tick = toUnits((await venueMarketRules()).tickSize);
  const step = tick * 2n;
  const wallet = await deskWithDom(page, s);
  // A resting bid of my own, well under the touch, placed on the venue ticket, so the ladder has my order to highlight.
  const price = await awayBid(90);
  const mine = await placeLimitBuy(page, wallet, owner, price, SMALL);
  expect(sameDecimal(mine.price, price) && sameDecimal(mine.amount, SMALL)).toBe(true);
  run.write({ restingBid: { price, venueClientOrderId: mine.venueClientOrderId } });

  await setLadder(page, 'Double', '2 ticks');
  await expect(dom(page)).toHaveAttribute('data-columns', 'double');
  await expect(dom(page)).toHaveAttribute('data-step-ticks', '2');
  for (const name of ['My bids', 'Bids (BTC)', 'Price (USDC)', 'Asks (BTC)', 'My asks'])
    await expect(ladder(page).getByRole('columnheader', { name })).toBeVisible();
  expect(same(await ladder(page).getAttribute('data-step'), fromUnits(step))).toBe(true);

  await expect
    .poll(
      async () => {
        const flow = await readFlow(page);
        const book = await venueBook();
        if (flow.rows.length === 0) return 'no rows';
        for (const row of flow.rows) if (toUnits(row.price) % step !== 0n) return `off step ${row.price}`;
        for (let i = 1; i < flow.rows.length; i++)
          if (toUnits(flow.rows[i].price) >= toUnits(flow.rows[i - 1].price)) return 'not highest first';
        // Grouping moves size between prices, never adds or loses any: the rows add up to the venue's own book.
        const bids = flow.rows.reduce((t, r) => t + (r.bid ? toUnits(r.bid) : 0n), 0n);
        const asks = flow.rows.reduce((t, r) => t + (r.ask ? toUnits(r.ask) : 0n), 0n);
        if (bids !== sumOf(book.bids) || asks !== sumOf(book.asks)) return 'not the venue book';
        // Each bucket holds exactly the venue's levels that fall in it: bids round down, asks round up.
        const bucket = (p, side) => {
          const floor = (toUnits(p) / step) * step;
          return side === 'bid' || floor === toUnits(p) ? floor : floor + step;
        };
        for (const [side, levels] of [
          ['bid', book.bids],
          ['ask', book.asks],
        ]) {
          const want = new Map();
          for (const l of levels) want.set(bucket(l.price, side), (want.get(bucket(l.price, side)) ?? 0n) + toUnits(l.amount));
          for (const [at, amount] of want) {
            const row = flow.rows.find((r) => toUnits(r.price) === at);
            if (!row || toUnits(row[side] || '0') !== amount) return `${side} bucket ${fromUnits(at)}`;
          }
        }
        // The best bid and the best ask are highlighted: the venue's best bid rounded down, its best ask rounded up.
        const bestBid = flow.rows.filter((r) => r.highlight === 'best-bid');
        const bestAsk = flow.rows.filter((r) => r.highlight === 'best-ask');
        if (bestBid.length !== 1 || toUnits(bestBid[0].price) !== bucket(book.bids[0].price, 'bid')) return 'best bid not highlighted';
        if (bestAsk.length !== 1 || toUnits(bestAsk[0].price) !== bucket(book.asks[0].price, 'ask')) return 'best ask not highlighted';
        // My resting bid is in its bucket, in my bids column, highlighted as mine.
        const row = flow.rows.find((r) => toUnits(r.price) === bucket(price, 'bid'));
        if (!row || !same(row.myBid, SMALL) || row.highlight !== 'mine') return `my bid at ${price} not shown`;
        return 'ok';
      },
      { timeout: 20_000 },
    )
    .toBe('ok');
  // One tick again shows at least as many prices as two ticks did.
  const grouped = (await readFlow(page)).rows.length;
  await setLadder(page, 'Single', '1 tick');
  await expect(ladder(page).getByRole('columnheader', { name: 'My orders' })).toBeVisible();
  await expect.poll(async () => (await readFlow(page)).rows.length).toBeGreaterThanOrEqual(grouped);
  // The only venue order this step made is that one bid, and the ledger posts nothing.
  expect((await venueOpen(owner)).map((o) => o.venueClientOrderId)).toEqual([mine.venueClientOrderId]);
  expect(await ledgerView(s.account)).toEqual(ledgerBefore);
});

test(`${J} #4 clicks a ladder ask; the ticket fills with the price and the review opens, and nothing is sent`, async ({ page }) => {
  test.setTimeout(240_000);
  const s = state();
  const owner = ownerOf(s);
  const ledgerBefore = await ledgerView(s.account);
  const wallet = await deskWithDom(page, s);
  await chartTrade(page).getByLabel('Click size (BTC)').fill(SMALL);
  const door = doorCalls(page);
  const openBefore = await venueOpen(owner);
  const review = reviewSheet(page);

  // The best ask on the ladder: the review opens on its own, a limit buy at the clicked ask at the click's size.
  const preview = nextPreview(page);
  const askPrice = await pressAskCell(page, 'best-ask');
  expect(same(askPrice, (await venueBest()).ask), 'the clicked best ask is the venue’s').toBe(true);
  await expect(review).toBeVisible();
  await expect(review).toContainText('Review your buy');
  expect((await preview).status()).toBe(200);
  const asked = door.of('preview').at(-1).body.intent;
  expect(asked).toMatchObject({ symbol: SYMBOL, side: 'buy', type: 'limit', timeInForce: 'GTC' });
  expect(same(asked.price, askPrice) && same(asked.amount, SMALL)).toBe(true);
  await expect(review.getByTestId('client-order-id')).toHaveText(asked.clientOrderKey);
  // Nothing was prepared, signed or sent, and the venue holds the same orders.
  expect(door.sent()).toEqual([]);
  expect(signatures(wallet)).toBe(0);
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toHaveCount(0);
  // The ticket holds the clicked price and the click's size.
  expect(same(await buyForm(page).getByRole('textbox', { name: 'Price' }).inputValue(), askPrice)).toBe(true);
  expect(same(await buyForm(page).getByRole('textbox', { name: 'Amount' }).inputValue(), SMALL)).toBe(true);
  await page.waitForTimeout(1_000);
  expect(door.sent()).toEqual([]);
  expect(await venueOpen(owner)).toEqual(openBefore);

  // Money line: a ladder order is the desk's own signed venue order. The third bid row's ask cell is a buy under the touch,
  // so it rests; confirmed, it is one prepare, one signature, one submit and one venue order under the reviewed client id,
  // and the venue locks exactly what its preview said.
  const lockedBefore = toUnits((await venueBalance(owner, 'USDC')).locked);
  const restPreview = nextPreview(page);
  const restPrice = await pressAskCell(page, 2);
  await expect(review).toBeVisible();
  const lock = (await (await restPreview).json()).value.lock;
  expect(lock.asset).toBe('USDC');
  const key = (await review.getByTestId('client-order-id').innerText()).trim();
  const prepared = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/prepare' && r.request().method() === 'POST');
  await review.getByRole('button', { name: 'Confirm buy' }).click();
  await continueInWallet(page);
  const { prepared: p } = await (await prepared).json();
  expect(p.intent.clientOrderKey).toBe(key);
  await expect.poll(async () => (await venueByClientId(owner, p.venueClientOrderId))?.status, { timeout: 20_000 }).toBe('open');
  const order = await venueByClientId(owner, p.venueClientOrderId);
  expect(sameDecimal(order.price, restPrice) && sameDecimal(order.amount, SMALL) && order.side === 'buy').toBe(true);
  expect(signatures(wallet)).toBe(1);
  expect(door.of('prepare')).toHaveLength(1);
  expect(door.of('submit')).toHaveLength(1);
  expect((await venueOpen(owner)).filter((o) => o.venueClientOrderId === p.venueClientOrderId)).toHaveLength(1);
  await expect.poll(async () => toUnits((await venueBalance(owner, 'USDC')).locked) - lockedBefore).toBe(toUnits(lock.amount));
  expect(await ledgerView(s.account)).toEqual(ledgerBefore);
});

test(`${J} #5 uses Buy and Sell buttons on the chart; each shows the live spread, and a type the market does not list refuses`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const owner = ownerOf(s);
  const ledgerBefore = await ledgerView(s.account);
  const openBefore = await venueOpen(owner);
  const wallet = await openVenueDesk(page, s.account, DESK, s.walletKey);
  const door = doorCalls(page);
  const group = chartTrade(page);
  const buy = group.getByTestId('of-chart-buy');
  const sell = group.getByTestId('of-chart-sell');
  const spread = group.getByTestId('of-chart-spread');
  // Each button carries the venue's live touch, and the spread between them is its best ask less its best bid.
  await expect
    .poll(
      async () => {
        const { bid, ask } = await venueBest();
        const shown = {
          bid: await sell.getAttribute('data-price'),
          ask: await buy.getAttribute('data-price'),
          spread: await spread.getAttribute('data-spread'),
        };
        return same(shown.bid, bid) && same(shown.ask, ask) && same(shown.spread, fromUnits(toUnits(ask) - toUnits(bid)));
      },
      { timeout: 20_000, message: 'the chart buttons follow the venue’s live best prices' },
    )
    .toBe(true);
  await expect(buy).toHaveText(/^Buy [\d.,]+$/);
  await expect(sell).toHaveText(/^Sell [\d.,]+$/);
  await expect(spread).toHaveText(/^Spread [\d.,]+$/);
  const spreadText = await spread.innerText();
  await expect(buy).toHaveAccessibleDescription(spreadText);
  await expect(sell).toHaveAccessibleDescription(spreadText);
  expect(same(await buy.innerText(), await buy.getAttribute('data-price'))).toBe(true);
  expect(same(await sell.innerText(), await sell.getAttribute('data-price'))).toBe(true);

  await group.getByLabel('Click size (BTC)').fill(SMALL);
  const review = reviewSheet(page);
  // Buy at market: the venue review of a market buy opens; nothing is sent.
  await group.getByLabel('Order kind').selectOption({ label: 'Market' });
  const marketPreview = nextPreview(page);
  await buy.click();
  await expect(review).toContainText('Review your buy');
  expect((await marketPreview).status()).toBe(200);
  expect(door.of('preview').at(-1).body.intent).toMatchObject({ side: 'buy', type: 'market', timeInForce: 'IOC' });
  expect(same(door.of('preview').at(-1).body.intent.amount, SMALL)).toBe(true);
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toHaveCount(0);
  // Sell, limit at the touch: the review is a sell at the venue's best bid the button showed.
  await group.getByLabel('Order kind').selectOption({ label: 'Limit at the touch' });
  const limitPreview = nextPreview(page);
  const { price: bidShown } = await pressShowing(sell);
  await expect(review).toContainText('Review your sell');
  expect((await limitPreview).status()).toBe(200);
  const sold = door.of('preview').at(-1).body.intent;
  expect(sold).toMatchObject({ side: 'sell', type: 'limit' });
  expect(same(sold.price, bidShown) && same(sold.amount, SMALL)).toBe(true);
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toHaveCount(0);
  expect(same(await sellForm(page).getByRole('textbox', { name: 'Price' }).inputValue(), bidShown)).toBe(true);

  // A type the venue market does not list: the venue desk's existing reason, and no review, no draft.
  const rules = await venueMarketRules();
  expect(rules.orderTypes).not.toContain('stop');
  await group.getByLabel('Order kind').selectOption({ label: 'Stop' });
  const previews = door.of('preview').length;
  await buy.click();
  const note = group.getByTestId('of-chart-note');
  await expect(note).toHaveText('Stop: not offered by this venue');
  await expect(page.locator('[data-not-offered="stop"]')).toHaveText('Stop: not offered by this venue');
  await expect(review).toHaveCount(0);
  await page.waitForTimeout(1_000);
  // The Stop press drafts nothing: any preview since is the ticket refreshing the sell draft it already holds (same
  // client order key, same limit price), never a stop and never a new order.
  const since = door
    .of('preview')
    .slice(previews)
    .map((c) => c.body.intent);
  for (const intent of since) {
    expect(intent.type).not.toBe('stop');
    expect(intent).toMatchObject({ clientOrderKey: sold.clientOrderKey, side: 'sell', type: 'limit', price: sold.price });
  }
  expect(door.sent()).toEqual([]);
  expect(signatures(wallet)).toBe(0);
  expect(await venueOpen(owner)).toEqual(openBefore);
  expect(await ledgerView(s.account)).toEqual(ledgerBefore);
});

test(`${J} #6 turns instant placement on: a click sends after the settings summary; off, it always reviews`, async ({ page }) => {
  test.setTimeout(300_000);
  const s = state();
  const owner = ownerOf(s);
  const ledgerBefore = await ledgerView(s.account);
  const wallet = await deskWithDom(page, s);
  await chartTrade(page).getByLabel('Click size (BTC)').fill(SMALL);
  const door = doorCalls(page);
  const review = reviewSheet(page);

  // Off by default: the switch reads off, the account holds nothing, and a ladder click opens the review.
  await expect(instantSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(instantStatus(page)).toHaveText('Off: every click opens the review first.');
  const before = await instantRecord(s.account);
  expect(before.value === null || before.value.on === false).toBe(true);
  await pressAskCell(page, 3);
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toHaveCount(0);
  expect(door.sent()).toEqual([]);

  // Turning it on shows the settings summary first. Keeping it off changes nothing, and Turn on waits for the agreement.
  await instantSwitch(page).click();
  await expect(summary(page)).toBeVisible();
  await expect(summary(page)).toContainText('Turn on instant placement?');
  await expect(summary(page)).toContainText('sends the order at once at the click size. There is no review.');
  await expect(summary(page)).toContainText('A market order still opens the review, because its price can move.');
  await expect(summary(page)).toContainText('Every order is still checked');
  await expect(summary(page)).toContainText('You can turn it off at any time with one click.');
  await expect(summary(page).getByRole('button', { name: 'Turn on instant placement' })).toBeDisabled();
  await summary(page).getByRole('button', { name: 'Keep it off' }).click();
  await expect(summary(page)).toHaveCount(0);
  await expect(instantSwitch(page)).toHaveAttribute('aria-checked', 'false');
  const kept = await instantRecord(s.account);
  expect(kept.value === null || kept.value.on === false).toBe(true);

  // Accepted: the account holds the agreement and the moment it was accepted, and the switch says since when.
  const accepted = Date.now();
  await turnInstantOn(page);
  const record = await instantRecord(s.account);
  expect(record.value.on).toBe(true);
  expect(record.value.agreement).toBe('instant-placement-v1');
  expect(Date.parse(record.value.agreedAt)).toBeGreaterThanOrEqual(accepted - 5_000);
  expect(Date.parse(record.value.agreedAt)).toBeLessThanOrEqual(Date.now() + 5_000);
  await expect(instantStatus(page)).toHaveAttribute('data-agreed-at', record.value.agreedAt);
  await expect(instantStatus(page)).toContainText(/^On since .+: a click sends at once, with no review\.$/);
  await expect(dom(page).getByTestId('of-ladder-hint')).toHaveText(
    'Instant placement is on: a click sends at that price at once, at the click size.',
  );

  // On: a ladder click goes to the wallet at once, with no review: the venue checks it first (its preview), then one
  // prepare, one signature after the plain-words sheet, one submit, and one venue order under one client id, locking
  // exactly what the venue's check said.
  const lockedBefore = toUnits((await venueBalance(owner, 'USDC')).locked);
  const check = nextPreview(page);
  const restPrice = await pressAskCell(page, 3);
  const lock = (await (await check).json()).value.lock;
  await continueInWallet(page);
  await expect.poll(() => door.of('submit').length, { timeout: 20_000 }).toBe(1);
  await expect(review).toHaveCount(0);
  expect(signatures(wallet)).toBe(1);
  expect(door.of('prepare')).toHaveLength(1);
  const intent = door.of('prepare')[0].body.intent;
  expect(intent).toMatchObject({ symbol: SYMBOL, side: 'buy', type: 'limit', timeInForce: 'GTC' });
  expect(same(intent.price, restPrice) && same(intent.amount, SMALL)).toBe(true);
  // The order's key is the desk's business key for this person and draft, never a bare random id.
  expect(intent.clientOrderKey).toMatch(new RegExp(`^order:${owner}:${SYMBOL.toLowerCase()}:[0-9a-z]+$`));
  expect(door.of('submit')[0].body.actionKey).toBe(intent.clientOrderKey);
  await expect
    .poll(async () => (await venueOpen(owner)).filter((o) => sameDecimal(o.price, restPrice) && sameDecimal(o.amount, SMALL)).length, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(1);
  const placed = (await venueOpen(owner)).filter((o) => sameDecimal(o.price, restPrice) && o.venueClientOrderId);
  const ids = await Promise.all(placed.map((o) => venueByClientId(owner, o.venueClientOrderId)));
  expect(ids.every((o) => o !== null)).toBe(true);
  await expect.poll(async () => toUnits((await venueBalance(owner, 'USDC')).locked) - lockedBefore).toBe(toUnits(lock.amount));
  await page.waitForTimeout(1_000);
  expect(door.of('submit')).toHaveLength(1);
  expect(signatures(wallet)).toBe(1);
  run.write({ instantOrder: { price: restPrice, key: intent.clientOrderKey } });

  // A market order from the chart still opens the review with instant placement on: its price can move.
  await chartTrade(page).getByLabel('Order kind').selectOption({ label: 'Market' });
  await chartTrade(page).getByTestId('of-chart-buy').click();
  await expect(review).toContainText('Review your buy');
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toHaveCount(0);
  expect(door.of('submit')).toHaveLength(1);

  // It is the account's setting: a fresh load of the desk still has it on.
  await backToDesk(page, true);
  await openDom(page);
  await expect(instantSwitch(page)).toHaveAttribute('aria-checked', 'true');

  // Off is one click, with no summary, and a click reviews again.
  await turnInstantOff(page);
  await expect(instantStatus(page)).toHaveText('Off: every click opens the review first.');
  expect((await instantRecord(s.account)).value).toEqual({ on: false, agreement: null, agreedAt: null });
  const afterReload = doorCalls(page);
  await setLadder(page, 'Single', '1 tick');
  await chartTrade(page).getByLabel('Click size (BTC)').fill(SMALL);
  await pressAskCell(page, 3);
  await expect(review).toBeVisible();
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toHaveCount(0);
  await page.waitForTimeout(1_000);
  expect(afterReload.sent()).toEqual([]);
  expect(signatures(wallet)).toBe(1);
  expect(await ledgerView(s.account)).toEqual(ledgerBefore);
});

test(`${J} #7 one-click close, cancel and size presets each act once with the reviewed or the instant setting`, async ({ page }) => {
  test.setTimeout(480_000);
  const s = state();
  const owner = ownerOf(s);
  const ledgerBefore = await ledgerView(s.account);
  // Size presets are the person's own quick sizes, set in Account, Trading.
  const w = await openVenueDesk(page, s.account, DESK, s.walletKey);
  await page.goto('/view');
  await page.getByLabel('Quick sizes').fill(`${SMALL}, ${BETWEEN}`);
  await page.getByRole('button', { name: 'Save quick sizes' }).click();
  await expect(page.getByText('Quick sizes saved.')).toBeVisible();
  await backToDesk(page);
  await openDom(page);
  await setLadder(page, 'Single', '1 tick');
  const door = doorCalls(page);
  const review = reviewSheet(page);
  const clickSize = chartTrade(page).getByLabel('Click size (BTC)');
  const cancelReview = page.getByTestId('of-cancel-review');
  const close = oneClick(page).getByTestId('of-close-all');
  await expect(instantSwitch(page)).toHaveAttribute('aria-checked', 'false');
  const submits = () => door.of('submit').length;

  // A preset fills the click size and sends nothing.
  const presets = oneClick(page).getByRole('group', { name: 'Size presets' }).getByTestId('of-preset');
  await expect(presets).toHaveCount(2);
  await oneClick(page)
    .getByRole('button', { name: `${BETWEEN} BTC` })
    .click();
  await expect(clickSize).toHaveValue(BETWEEN);
  await expect(oneClick(page).getByRole('button', { name: `${BETWEEN} BTC` })).toHaveAttribute('aria-pressed', 'true');
  await oneClick(page)
    .getByRole('button', { name: `${SMALL} BTC` })
    .click();
  await expect(clickSize).toHaveValue(SMALL);
  await page.waitForTimeout(1_000);
  expect(door.sent()).toEqual([]);

  // Reviewed (instant off). A click on the best ask at the preset's size opens the review and sends nothing; its Confirm
  // sends one venue order at that size, which buys from the venue's ask: the BTC one-click close sells next.
  const btcBefore = toUnits((await venueBalance(owner, 'BTC')).free);
  await pressAskCell(page, 'best-ask');
  await expect(review).toContainText('Review your buy');
  await page.waitForTimeout(500);
  expect(door.sent()).toEqual([]);
  await review.getByRole('button', { name: 'Confirm buy' }).click();
  await continueInWallet(page);
  await expect.poll(submits, { timeout: 20_000 }).toBe(1);
  await expect(review).toHaveCount(0);
  const bought = door.of('prepare')[0].body.intent;
  expect(same(bought.amount, SMALL)).toBe(true);
  expect(signatures(w)).toBe(1);
  await expect.poll(async () => toUnits((await venueBalance(owner, 'BTC')).free) > btcBefore, { timeout: 20_000 }).toBe(true);

  // Reviewed one-click cancel: a resting buy of mine placed from the ladder, then its row's cancel. A review names it,
  // nothing is cancelled until confirmed, then one signed venue cancel for exactly that order.
  await pressAskCell(page, 4);
  await expect(review).toContainText('Review your buy');
  await review.getByRole('button', { name: 'Confirm buy' }).click();
  await continueInWallet(page);
  await expect.poll(submits, { timeout: 20_000 }).toBe(2);
  const rest = door.of('prepare').at(-1).body.intent;
  let restId = null;
  await expect
    .poll(async () => {
      const o = (await venueOpen(owner)).find((x) => sameDecimal(x.price, rest.price) && sameDecimal(x.amount, SMALL));
      restId = o?.venueClientOrderId ?? null;
      return restId !== null;
    })
    .toBe(true);
  expect(signatures(w)).toBe(2);
  await pressRowCancel(page, rest.price);
  await expect(cancelReview).toBeVisible();
  const lines = cancelReview.getByTestId('of-cancel-line');
  const named = await lines.evaluateAll((els) => els.map((el) => el.getAttribute('data-order-id')));
  expect(named).toContain(restId);
  const atRow = (await venueOpen(owner)).filter((o) => sameDecimal(o.price, rest.price));
  expect(named.sort()).toEqual(atRow.map((o) => o.venueClientOrderId).sort());
  await page.waitForTimeout(1_000);
  expect(submits()).toBe(2);
  expect((await venueByClientId(owner, restId)).status).toBe('open');
  await cancelReview.getByRole('button', { name: named.length === 1 ? 'Cancel order' : `Cancel ${named.length} orders` }).click();
  for (let i = 0; i < named.length; i++) await continueInWallet(page);
  await expect(cancelReview).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(async () => (await venueByClientId(owner, restId)).status, { timeout: 20_000 }).toBe('canceled');
  expect(door.of('prepare').filter((c) => c.body.intent.kind === 'cancel_order' || c.body.intent.kind === 'cancel_orders')).toHaveLength(
    named.length,
  );
  expect(signatures(w)).toBe(2 + named.length);
  let signed = 2 + named.length;

  // Reviewed one-click close: a limit sell of every free BTC lot at the venue's best bid, in the review; nothing is sent.
  await expect(close).toBeEnabled({ timeout: 20_000 });
  const closePreview = nextPreview(page);
  const { amount: freeShown, price: bidShown } = await pressShowing(close);
  expect(toUnits(freeShown)).toBeGreaterThan(0n);
  const lot = toUnits((await venueMarketRules()).lotSize);
  expect(toUnits(freeShown)).toBe((toUnits((await venueBalance(owner, 'BTC')).free) / lot) * lot);
  await expect(review).toContainText('Review your sell');
  expect((await closePreview).status()).toBe(200);
  const closeIntent = door.of('preview').at(-1).body.intent;
  expect(closeIntent).toMatchObject({ side: 'sell', type: 'limit' });
  expect(same(closeIntent.price, bidShown) && same(closeIntent.amount, freeShown)).toBe(true);
  const sentBefore = submits();
  await review.getByRole('button', { name: 'Cancel' }).click();
  await expect(review).toHaveCount(0);
  await page.waitForTimeout(1_000);
  expect(submits()).toBe(sentBefore);
  // Confirmed: one signed limit sell of every free lot at the bid the button showed; the BTC it sells is no longer free.
  const { amount: freeConfirmed, price: bidConfirmed } = await pressShowing(close);
  await expect(review).toContainText('Review your sell');
  await review.getByRole('button', { name: 'Confirm sell' }).click();
  await continueInWallet(page);
  await expect.poll(submits, { timeout: 20_000 }).toBe(sentBefore + 1);
  const sellIntent = door.of('prepare').at(-1).body.intent;
  expect(sellIntent).toMatchObject({ side: 'sell', type: 'limit' });
  expect(same(sellIntent.price, bidConfirmed) && same(sellIntent.amount, freeConfirmed)).toBe(true);
  signed += 1;
  expect(signatures(w)).toBe(signed);
  await expect.poll(async () => toUnits((await venueBalance(owner, 'BTC')).free) < lot, { timeout: 20_000 }).toBe(true);

  // Instant. A ladder click at the preset's size sends at once (one signature), and one-click cancel acts at once: no
  // review, one signed venue cancel for that order.
  await turnInstantOn(page);
  await oneClick(page)
    .getByRole('button', { name: `${SMALL} BTC` })
    .click();
  const instantSent = submits();
  const instantPrice = await pressAskCell(page, 4);
  await continueInWallet(page);
  await expect.poll(submits, { timeout: 20_000 }).toBe(instantSent + 1);
  await expect(review).toHaveCount(0);
  const instantIntent = door.of('prepare').at(-1).body.intent;
  expect(same(instantIntent.price, instantPrice) && same(instantIntent.amount, SMALL)).toBe(true);
  signed += 1;
  let instantId = null;
  await expect
    .poll(async () => {
      const o = (await venueOpen(owner)).find((x) => sameDecimal(x.price, instantPrice));
      instantId = o?.venueClientOrderId ?? null;
      return instantId !== null;
    })
    .toBe(true);
  await pressRowCancel(page, instantPrice);
  await continueInWallet(page);
  await expect(cancelReview).toHaveCount(0);
  await expect.poll(async () => (await venueByClientId(owner, instantId)).status, { timeout: 20_000 }).toBe('canceled');
  signed += 1;
  expect(signatures(w)).toBe(signed);

  // Instant one-click close: buy a little at the venue's ask first (instant, one signature), then one limit sell of every
  // free lot at the best bid the button shows, sent at once with one signature.
  const topUp = submits();
  await pressAskCell(page, 'best-ask');
  await continueInWallet(page);
  await expect.poll(submits, { timeout: 20_000 }).toBe(topUp + 1);
  signed += 1;
  await expect.poll(async () => toUnits((await venueBalance(owner, 'BTC')).free) >= lot, { timeout: 20_000 }).toBe(true);
  await expect
    .poll(async () => toUnits(canon((await close.getAttribute('data-amount')) ?? '') || '0') > 0n, { timeout: 20_000 })
    .toBe(true);
  const closing = submits();
  const { amount: freeNow, price: bidNow } = await pressShowing(close);
  await continueInWallet(page);
  await expect.poll(submits, { timeout: 20_000 }).toBe(closing + 1);
  await expect(review).toHaveCount(0);
  const instantClose = door.of('prepare').at(-1).body.intent;
  expect(instantClose).toMatchObject({ side: 'sell', type: 'limit' });
  expect(same(instantClose.price, bidNow) && same(instantClose.amount, freeNow)).toBe(true);
  signed += 1;
  await expect.poll(async () => toUnits((await venueBalance(owner, 'BTC')).free) < lot, { timeout: 20_000 }).toBe(true);
  await page.waitForTimeout(1_000);
  expect(submits()).toBe(closing + 1);
  expect(signatures(w)).toBe(signed);
  // Each order went once: one venue order per client order id the door prepared.
  for (const c of door.of('prepare').filter((x) => x.body.intent.kind === 'place_order'))
    expect(
      door
        .of('prepare')
        .filter((x) => x.body.intent.kind === 'place_order' && x.body.intent.clientOrderKey === c.body.intent.clientOrderKey),
    ).toHaveLength(1);

  await turnInstantOff(page);
  expect(await ledgerView(s.account)).toEqual(ledgerBefore);
});

test(`${J} #8 reads my place in the queue and the fill chance of a resting order: from the book, with the estimate's basis`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const s = state();
  const owner = ownerOf(s);
  const ledgerBefore = await ledgerView(s.account);
  // A price inside the venue's spread, so the queue there is exactly the orders this step places.
  const { bid, ask } = await venueBest();
  const tick = toUnits((await venueMarketRules()).tickSize);
  const price = fromUnits(toUnits(bid) + tick);
  expect(toUnits(price) < toUnits(ask), 'the TEST venue’s spread is wider than a tick').toBe(true);
  // Another TEST trader rests first at that price, then me (on the venue ticket): 0.002 BTC rests ahead of mine.
  const ahead = 'jcd14-queue-ahead';
  await fundedOther(ahead, { USDC: '1000' });
  const aheadKey = `order:jcd14-ahead-${randomBytes(4).toString('hex')}`;
  expect(await otherTraderRun(ahead, limitIntent(SYMBOL, 'buy', price, '0.002', aheadKey))).toMatchObject({
    definite: true,
    accepted: true,
  });
  const wallet = await deskWithDom(page, s);
  const mine = await placeLimitBuy(page, wallet, owner, price, SMALL);
  try {
    // A real print at my price from a third TEST trader: it sells 0.001 into the queue, filling part of the order ahead.
    const seller = 'jcd14-queue-seller';
    await fundedOther(seller, { BTC: '0.01' });
    expect(
      await otherTraderRun(seller, limitIntent(SYMBOL, 'sell', price, SMALL, `order:jcd14-print-${randomBytes(4).toString('hex')}`, 'IOC')),
    ).toMatchObject({
      definite: true,
      accepted: true,
    });
    const level = async () => (await venueBook()).bids.find((l) => sameDecimal(l.price, price));
    await expect.poll(async () => toUnits((await level())?.amount ?? '0'), { timeout: 15_000 }).toBe(toUnits('0.002'));
    expect(
      (await venuePrints()).value.some((p) => sameDecimal(p.price, price) && sameDecimal(p.amount, SMALL) && p.takerSide === 'sell'),
    ).toBe(true);
    const fillWindow = (await (await api(s.account)).get('/api/v1/charts/owner-values')).body.queueFillWindowSeconds;
    expect(fillWindow, 'the TEST stack sets a TEST queue window').toBeGreaterThan(0);

    // The DOM shows my order's place from the venue's own book: the level less my own remaining is the most ahead of me,
    // and the chance with its basis is that basis's own ratio, recomputed here from the venue's own prints.
    const queue = dom(page).getByRole('region', { name: 'My place in the queue' });
    const row = queue.getByTestId('of-queue-row').and(page.locator(`[data-order-id="${mine.venueClientOrderId}"]`));
    await expect(row).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await expect(row).toHaveAttribute('data-source', 'venue_l2');
    await expect
      .poll(
        async () => {
          const shown = await row.evaluate((el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])));
          const book = await venueBook();
          const levelNow = book.bids.find((l) => sameDecimal(l.price, price));
          const record = (await venueOpen(owner)).find((o) => o.venueClientOrderId === mine.venueClientOrderId);
          if (!levelNow || !record) return 'not on the venue book';
          const remaining = toUnits(record.remaining);
          const aheadMost = toUnits(levelNow.amount) > remaining ? toUnits(levelNow.amount) - remaining : 0n;
          if (toUnits(shown['data-level-total']) !== toUnits(levelNow.amount))
            return `level ${shown['data-level-total']} vs ${levelNow.amount}`;
          if (toUnits(shown['data-remaining']) !== remaining) return 'remaining';
          if (toUnits(shown['data-size-ahead']) !== aheadMost) return 'size ahead';
          if (Number(shown['data-window']) !== fillWindow) return 'window';
          // The traded volume: the venue's sells at or under my price inside the window the DOM names, to the venue's time.
          const start = Date.parse(shown['data-window-start']);
          const end = Date.parse(shown['data-tape-as-of']);
          if (end - start !== fillWindow * 1000) return 'window span';
          const { value: prints } = await venuePrints();
          const traded = prints
            .filter((p) => p.takerSide === 'sell' && toUnits(p.price) <= toUnits(price))
            .filter((p) => Date.parse(p.tradedAt) >= start && Date.parse(p.tradedAt) <= end)
            .reduce((t, p) => t + toUnits(p.amount), 0n);
          if (toUnits(shown['data-traded']) !== traded) return `traded ${shown['data-traded']} vs ${fromUnits(traded)}`;
          // The DOM polls the book and the tape apart, so for one poll its book can already hold the print while the tape it
          // read (and stamps as data-tape-as-of) is from before it: that readout is true as of its tape, so wait for the next.
          if (traded < toUnits(SMALL)) return `the tape as of ${shown['data-tape-as-of']} predates the print`;
          const toFill = aheadMost + remaining;
          if (toUnits(shown['data-to-fill']) !== toFill) return 'to fill';
          const one = 10n ** 18n;
          const ratio = traded >= toFill ? one : (traded * one) / toFill;
          if (toUnits(shown['data-chance']) !== (ratio / 10n ** 14n) * 10n ** 14n) return `chance ${shown['data-chance']}`;
          return 'same';
        },
        { timeout: 30_000, message: 'the queue readout is the venue’s own book and prints' },
      )
      .toBe('same');
    // The print at my price moved the chance above zero, and the order ahead shrank to 0.001 BTC.
    expect(toUnits(await row.getAttribute('data-chance'))).toBeGreaterThan(0n);
    expect(toUnits(await row.getAttribute('data-traded'))).toBeGreaterThanOrEqual(toUnits(SMALL));
    expect(toUnits(await row.getAttribute('data-size-ahead'))).toBe(toUnits(SMALL));
    await expect(row.getByTestId('of-queue-ahead')).toHaveText(/^At most 0\.0010* BTC ahead of you at this price$/);
    await expect(row.getByTestId('of-queue-chance')).toHaveText(/^Estimated chance of a fill: \d+\.\d{2}%$/);
    await expect(row.getByTestId('of-queue-basis')).toContainText(
      new RegExp(`traded at or through this price in the last ${fillWindow} seconds, against at most 0\\.0020* BTC that must trade`),
    );
    await expect(row.getByTestId('of-queue-basis')).toContainText('From the venue’s own published book and trades.');

    // Nothing of another person's order is on my page: my row names my own order and the level's sum, never the order
    // ahead's key, its venue id or its owner.
    const aheadOwner = otherTraderKey(ahead).address.toLowerCase();
    const aheadOrder = (await venueOpen(aheadOwner)).find((o) => sameDecimal(o.price, price));
    expect(aheadOrder?.venueClientOrderId, 'the order ahead rests on the TEST venue').toBeTruthy();
    const rowHtml = (await row.evaluate((el) => el.outerHTML)).toLowerCase();
    for (const theirs of [aheadKey, aheadOrder.venueClientOrderId, aheadOwner]) expect(rowHtml).not.toContain(theirs.toLowerCase());
    // My own reads through the venue door name only my orders: the order ahead's id, read on my account, is the same
    // nothing as an id no one has, so the door tells me nothing of whether it exists.
    const mineClient = await api(s.account);
    const byId = (id) => mineClient.get(`/api/v1/venue/orders/by-client-id?owner=${owner}&clientOrderId=${encodeURIComponent(id)}`);
    const foreignRead = await byId(aheadOrder.venueClientOrderId);
    const missingRead = await byId(`0x${'0'.repeat(32)}`);
    expect(foreignRead.status, JSON.stringify(foreignRead.body).slice(0, 300)).toBe(200);
    expect(foreignRead.body.value).toBeNull();
    expect([missingRead.status, missingRead.body.value]).toEqual([foreignRead.status, foreignRead.body.value]);
    expect(await ledgerView(s.account)).toEqual(ledgerBefore);
  } finally {
    // Leave the venue's spread as it was: both resting orders at that price are cancelled, each by its own key's owner.
    await otherTraderRun(ahead, { kind: 'cancel_order', symbol: SYMBOL, clientOrderKey: aheadKey }).catch(() => undefined);
    await personRun(s.walletKey, { kind: 'cancel_order', symbol: SYMBOL, clientOrderKey: mine.clientOrderKey }).catch(() => undefined);
  }
  await expect.poll(async () => (await venueByClientId(owner, mine.venueClientOrderId)).status, { timeout: 15_000 }).toBe('canceled');
  // Once cancelled, my order is no longer in the queue: the DOM lists no queue row for it, and the venue door's own read
  // of it says canceled, never open.
  await expect(
    dom(page).getByRole('region', { name: 'My place in the queue' }).locator(`[data-order-id="${mine.venueClientOrderId}"]`),
  ).toHaveCount(0, { timeout: 30_000 });
  const gone = await (
    await api(s.account)
  ).get(`/api/v1/venue/orders/by-client-id?owner=${owner}&clientOrderId=${encodeURIComponent(mine.venueClientOrderId)}`);
  expect(gone.status, JSON.stringify(gone.body).slice(0, 300)).toBe(200);
  expect(gone.body.value?.status).toBe('canceled');

  // Today's engine queue read keeps its privacy: another person's order id refuses exactly as an order that does not
  // exist (no existence leak), its owner reads it, and once cancelled it is not open.
  const other = await api(otherTrader());
  const engine = await api(s.account);
  const away = await engineAwayBid(85, ENGINE_SYMBOL);
  const rested = await other.post('/api/v1/orders', {
    symbol: ENGINE_SYMBOL,
    type: 'limit',
    side: 'buy',
    price: away,
    amount: SMALL,
    timeInForce: 'GTC',
    clientOrderId: `jcd14-q8-other-${randomBytes(4).toString('hex')}`,
  });
  expect(rested.status, JSON.stringify(rested.body).slice(0, 300)).toBeLessThan(300);
  const theirId = rested.body.id;
  let cancelled = false;
  try {
    const own = await other.get(`/api/v1/orders/${theirId}/queue`);
    expect(own.status, JSON.stringify(own.body).slice(0, 300)).toBe(200);
    const foreign = await engine.get(`/api/v1/orders/${theirId}/queue`);
    const missing = await engine.get(`/api/v1/orders/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/queue`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.intafacedCode).toBe('trade.order_not_found');
    expect([missing.status, missing.body.intafacedCode]).toEqual([foreign.status, foreign.body.intafacedCode]);
    const del = await other.delete(`/api/v1/orders/${theirId}?symbol=${encodeURIComponent(ENGINE_SYMBOL)}`);
    expect(del.status, JSON.stringify(del.body).slice(0, 300)).toBeLessThan(300);
    cancelled = true;
    const closed = await other.get(`/api/v1/orders/${theirId}/queue`);
    expect(closed.status).toBe(409);
    expect(closed.body.intafacedCode).toBe('trade.order_not_open');
  } finally {
    if (!cancelled) await other.delete(`/api/v1/orders/${theirId}?symbol=${encodeURIComponent(ENGINE_SYMBOL)}`).catch(() => undefined);
  }
});
