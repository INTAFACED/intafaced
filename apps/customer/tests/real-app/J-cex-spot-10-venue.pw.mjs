// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { EDGE, api, fromUnits, journeyState, restartWithSetting, toUnits } from './stack.mjs';
import { reviewSheet, signIn, signUp, verify } from './desk.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import { ownSpotMarket } from './own-market.mjs';
import {
  openVenueDesk,
  otherTraderKey,
  otherTraderRun,
  sameDecimal,
  testDeposit,
  testVenue,
  venueAccount,
  venueForThisFile,
  venueInfo,
  venueRecord,
} from './venue.mjs';

// J-cex-spot-10 #1 #2 #3 #4 #6 #9 on the venue model (docs/roadmap/journeys.json): a person sees what they pay on their
// own venue account, the venue's maker or taker fee and our builder fee named apart, what tier the venue placed them
// in, and how to get cheaper. One test per step, titled "J-cex-spot-10 #<n>", run in order on one TEST account.
// J-cex-spot-10.pw.mjs keeps the steps that are ours alone (our tier programme, VIP benefits, the notice board, the fee
// API) and the custodial desk's checks of these six, titled "part of", which count for no step.
//
// INTAFACED holds none of this person's money: with svc-trade's user-venue door on for this file (venueForThisFile),
// every rate, fee, fill, tier and volume is read from the stack's TEST venue simulator (packages/venue-sim) itself,
// never from the page, and the ledger is read before and after to show it posts nothing for the person. Each step that
// trades does so on a TEST spot market of its own (ownSpotMarket), so no other journey's book or fees move. Two other
// TEST traders sign on the TEST venue directly and make the other side. Every figure is TEST.
const J = 'J-cex-spot-10';
const MAKER = 'js10-maker';
const TAKER = 'js10-taker';
const run = journeyState(`${J}-venue-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey) throw new Error(`${J} #1 made no account and wallet, so this step has no one to act as`);
  return { ...s, owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}
const desk = (symbol) => `/trade/spot/${symbol}`;
const ref = () => `84532:0x${randomBytes(32).toString('hex')}:0`;
const traderOwner = (name) => otherTraderKey(name).address.toLowerCase();

const sellForm = (page) => page.locator('form[data-testid="dk-form"][data-side="sell"]');
const orderTab = (page, name) => page.getByTestId('dk-order').locator('[role=tab]', { hasText: new RegExp(`^${name}$`) });
const line = (scope, name) => scope.locator(`[data-line="${name}"]`);

/** "3.5" bps → "0.035%": the point moved two places, exactly as the page writes a rate. */
function pct(bps) {
  const units = toUnits(bps);
  const neg = units < 0n;
  const shown = fromUnits((neg ? -units : units) / 100n);
  return `${neg ? '-' : ''}${shown}%`;
}

/** Every signing write the page sends to the door (prepare, submit), so a step can show nothing was sent. */
function writes(page) {
  const sent = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (r.method() === 'POST' && (p === '/api/v1/venue/prepare' || p === '/api/v1/venue/submit')) sent.push(p);
  });
  return sent;
}

/** The venue's preview the page asks for on `act` (typing into the ticket): its answer, which must be the venue's. */
async function previewOn(page, act) {
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/venue/preview' && r.request().method() === 'POST');
  await act();
  const res = await answer;
  const body = await res.json();
  expect(res.status(), JSON.stringify(body).slice(0, 300)).toBe(200);
  return body;
}

/** The venue's own record of a market, as it lists it. */
const venueMarket = async (symbol) => (await testVenue('/markets', {})).body.value.find((m) => m.symbol === symbol);
const openOn = async (owner, symbol) => (await venueRecord(owner, '/open-orders')).value.filter((o) => o.symbol === symbol);
const balanceOf = async (owner, asset) =>
  (await venueRecord(owner, '/balances')).value.find((b) => b.asset === asset) ?? { asset, free: '0', locked: '0', total: '0' };

/** One TEST order of another trader, signed on the TEST venue directly. */
async function traderOrder(name, symbol, side, price, amount, timeInForce) {
  const answer = await otherTraderRun(name, {
    kind: 'place_order',
    symbol,
    side,
    type: 'limit',
    amount,
    price,
    timeInForce,
    reduceOnly: false,
    clientOrderKey: `order:${traderOwner(name)}:js10-${randomBytes(4).toString('hex')}`,
    builderFee: null,
  });
  expect(answer, JSON.stringify(answer).slice(0, 300)).toMatchObject({ accepted: true });
  return answer.order;
}

/** One action prepared by svc-trade's door, signed by the person's own wallet key, and sent. Returns the prepared order. */
async function throughUs(s, intent, actionKey) {
  const session = await api(s.account);
  const key = privateKeyToAccount(s.walletKey);
  let prepared;
  await expect(async () => {
    prepared = await session.post('/api/v1/venue/prepare', {
      owner: s.owner,
      signer: { role: 'owner', address: s.owner },
      intent,
      actionKey,
    });
    expect(prepared.status, JSON.stringify(prepared.body).slice(0, 400)).toBe(200);
  }).toPass({ timeout: 30_000, intervals: [2_000] });
  const t = prepared.body.prepared.typedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  const sent = await session.post('/api/v1/venue/submit', {
    actionKey: prepared.body.actionKey,
    signature: { digest: prepared.body.prepared.digest, signature, signedBy: s.owner },
  });
  expect(sent.status, JSON.stringify(sent.body).slice(0, 400)).toBe(200);
  expect(sent.body.outcome).toMatchObject({ definite: true, accepted: true });
  return prepared.body.prepared;
}

/** The person's own order on `symbol` through our door: a limit at `price`, `timeInForce` GTC or IOC. */
const personOrder = (s, symbol, side, price, amount, timeInForce) =>
  throughUs(
    s,
    {
      kind: 'place_order',
      symbol,
      side,
      type: 'limit',
      amount,
      price,
      timeInForce,
      reduceOnly: false,
      clientOrderKey: `order:${s.owner}:js10-${randomBytes(4).toString('hex')}`,
      builderFee: null,
    },
    `js10-${randomBytes(6).toString('hex')}`,
  );

/** The venue's fills of one order of the person, once it has at least one. */
async function fillsOf(s, venueClientOrderId) {
  let fills = [];
  await expect
    .poll(
      async () => {
        fills = (await venueRecord(s.owner, '/fills', { since: new Date(Date.now() - 3_600_000).toISOString() })).value.filter(
          (f) => f.venueClientOrderId === venueClientOrderId,
        );
        return fills.length;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  return fills;
}

/** The person's ledger balances: the ledger posts nothing for them on the venue (INTAFACED holds none of it). */
const ledgerOf = async (s) => (await api(s.account)).balances();

/**
 * TEST setup, not a step (the Starts line), made at the start of #1: a verified account, this run's TEST wallet, TEST
 * USDC in the person's venue account by the TEST venue's deposit control, our TEST builder fee approved once by the
 * person's wallet (a spot sell carries it), and the two other TEST traders funded. The venue publishes its TEST fee
 * tiers at boot (packages/venue-sim TEST_VENUE_FEE_TIERS) and the stack sets our TEST builder fee
 * (TRADE_USER_VENUE_BUILDER_FEE_BPS).
 */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const who = await signUp(page, 'js10v');
    await verify(page, who);
    const walletKey = testWalletKey();
    const owner = privateKeyToAccount(walletKey).address.toLowerCase();
    expect(await testDeposit(owner, 'USDC', '150000', ref())).toBe(true);
    const session = await api(who);
    const status = (await session.get('/api/v1/venue/status')).body;
    expect(status, JSON.stringify(status).slice(0, 300)).toMatchObject({ enabled: true, test: true });
    expect(status.builder, 'the stack publishes a TEST builder fee').toBeTruthy();
    const s = { account: who, walletKey, owner };
    await throughUs(
      s,
      { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
      `builder-approval:${owner}:${J}`,
    );
    return run.reset({ account: who, walletKey, builder: status.builder, ledgerStart: await session.balances() });
  } finally {
    await page.close();
  }
}

/** A TEST spot market of this step's own, its other traders funded in its coin and in USDC. */
async function stepMarket(tag, s, personCoin = '0') {
  const market = await ownSpotMarket(J, 'JSF', tag);
  for (const name of [MAKER, TAKER]) {
    for (const [asset, amount] of [
      [market.base, '5000'],
      ['USDC', '500000'],
    ]) {
      const funded = await testVenue('/test/deposit', {
        account: await venueAccount(traderOwner(name)),
        asset,
        amount,
        depositRef: `seed:${name}:${market.symbol}:${asset}`,
      });
      expect(funded.status, JSON.stringify(funded.body)).toBe(200);
    }
  }
  if (personCoin !== '0') expect(await testDeposit(s.owner, market.base, personCoin, ref())).toBe(true);
  return market;
}

test(`${J} #1 previews a maker limit and a taker market: the venue's maker and taker rates and our builder fee, each named; the line comes from the preview, not the list`, async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000);
  await startsLine(browser);
  const s = state();
  const market = await stepMarket('A', s, '10');
  run.write({ marketA: market });
  // The other side: a bid at 99.8 the market sell meets, and an ask at 100.2 (a spread inside the owner's TEST spread
  // limit, so a market order may be prepared), so a sell at 150 can only rest.
  await traderOrder(MAKER, market.symbol, 'buy', '99.8', '5', 'GTC');
  await traderOrder(MAKER, market.symbol, 'sell', '100.2', '5', 'GTC');
  const listed = await venueMarket(market.symbol);
  expect(listed).toMatchObject({ makerFeeBps: { known: true }, takerFeeBps: { known: true } });

  // The market list the desk reads is rewritten to say other rates (9 bps both): what the review shows must still be the
  // venue's own rates for this account, from the preview of this order.
  await page.route('**/api/v1/venue/markets*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const m of body.value ?? [])
      if (m.symbol === market.symbol)
        Object.assign(m, { makerFeeBps: { known: true, value: '9' }, takerFeeBps: { known: true, value: '9' } });
    await route.fulfill({ response: res, json: body });
  });
  const wallet = await openVenueDesk(page, s.account, desk(market.symbol), s.walletKey);
  const sent = writes(page);
  const asked = wallet.requests.length;
  await expect(page.getByTestId('venue-header')).toContainText('maker 9 bps, taker 9 bps');
  const ledgerBefore = await ledgerOf(s);
  const coinBefore = await balanceOf(s.owner, market.base);

  // The person's own rates as the venue reports them for their account (the base tier: the market's own published ones).
  const own = (await venueRecord(s.owner, '/fee-status')).value.account;
  expect(own.tierName).toBe('TEST base');
  const makerRate = listed.makerFeeBps.value;
  const takerRate = listed.takerFeeBps.value;
  const ratesWords = `maker ${pct(makerRate)}, taker ${pct(takerRate)}`;

  // A maker limit: a sell at 150 rests above every bid. Reviewed: the preview's own rates, role and fees, each named.
  await orderTab(page, 'Limit').click();
  await sellForm(page).getByRole('textbox', { name: 'Price', exact: true }).fill('150');
  const maker = await previewOn(page, () => sellForm(page).getByRole('textbox', { name: 'Amount', exact: true }).fill('1'));
  expect(maker.value).toMatchObject({
    role: 'maker',
    rates: { makerFeeBps: { known: true, value: makerRate }, takerFeeBps: { known: true, value: takerRate } },
  });
  await sellForm(page)
    .getByRole('button', { name: `Sell ${market.base}`, exact: true })
    .click();
  let sheet = reviewSheet(page);
  await expect(sheet).toBeVisible();
  await expect(line(sheet, 'venue-rates')).toHaveText(ratesWords);
  await expect(line(sheet, 'role')).toHaveText('Maker');
  // The venue's fee: 150 x 1 at the maker rate, in USDC; our builder fee beside it at our rate, a line of its own.
  expect(sameDecimal(maker.value.venueFee.value.amount, fromUnits((toUnits('150') * toUnits(makerRate)) / toUnits('10000')))).toBe(true);
  await expect(line(sheet, 'venue-fee')).toContainText('USDC');
  const builderAmount = fromUnits((toUnits('150') * toUnits(s.builder.feeBps)) / toUnits('10000'));
  expect(sameDecimal(maker.value.builderFee.value.amount, builderAmount)).toBe(true);
  await expect(line(sheet, 'builder-fee')).toContainText('USDC');
  expect(sameDecimal((await line(sheet, 'builder-fee').innerText()).replace(/[^\d.]/g, ''), builderAmount)).toBe(true);
  expect(sameDecimal((await line(sheet, 'venue-fee').innerText()).replace(/[^\d.]/g, ''), maker.value.venueFee.value.amount)).toBe(true);
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(sheet).toHaveCount(0);

  // A taker market: it meets the bid at 99.8 now. Reviewed: taker, the same two rates from its own preview.
  await sellForm(page).getByRole('textbox', { name: 'Amount', exact: true }).fill('');
  await orderTab(page, 'Market').click();
  const taker = await previewOn(page, () => sellForm(page).getByRole('textbox', { name: 'Amount', exact: true }).fill('1'));
  expect(taker.value).toMatchObject({
    role: 'taker',
    rates: { makerFeeBps: { known: true, value: makerRate }, takerFeeBps: { known: true, value: takerRate } },
  });
  // What the venue charges a taker: what fills now (at 99.8) at the taker rate.
  expect(sameDecimal(taker.value.venueFee.value.amount, fromUnits((toUnits('99.8') * toUnits(takerRate)) / toUnits('10000')))).toBe(true);
  await sellForm(page)
    .getByRole('button', { name: `Sell ${market.base}`, exact: true })
    .click();
  sheet = reviewSheet(page);
  await expect(sheet).toBeVisible();
  await expect(line(sheet, 'venue-rates')).toHaveText(ratesWords);
  await expect(line(sheet, 'role')).toHaveText('Taker');
  expect(sameDecimal((await line(sheet, 'venue-fee').innerText()).replace(/[^\d.]/g, ''), taker.value.venueFee.value.amount)).toBe(true);
  await expect(line(sheet, 'builder-fee')).toContainText('USDC');
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();

  // Previewing sends nothing: no prepare or submit, no signature, no order, nothing locked, the ledger untouched.
  expect(sent).toEqual([]);
  expect(wallet.requests.length).toBe(asked);
  expect(await openOn(s.owner, market.symbol)).toEqual([]);
  expect(await balanceOf(s.owner, market.base)).toEqual(coinBefore);
  expect(await ledgerOf(s)).toEqual(ledgerBefore);
});

test(`${J} #2 opens the public fee page: the venue's schedule and our builder fee, never above the venue's cap; a blank value reads "not set"; the network fee is a separate line`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const s = state();
  // A market whose venue publishes no fee: its blank rates must read "not set", never zero or a guess.
  const blank = await stepMarket('B', s);
  const unpublished = await testVenue('/test/market-fees', { symbol: blank.symbol, makerFeeBps: null, takerFeeBps: null });
  expect(unpublished.status).toBe(200);

  // Signed out: the page is public.
  await page.goto('/fees');
  await expect(page.getByRole('heading', { level: 1, name: 'Trading fees', exact: true })).toBeVisible();
  const section = page.locator('[data-fees="venue"]');
  await expect(section).toContainText('our builder fee is added on top, as its own line');

  // The venue's tiers, row for row as the venue publishes them.
  const schedule = (await testVenue('/fee-status', {})).body.value.schedule;
  expect(schedule.tiers.length).toBeGreaterThan(1);
  for (const tier of schedule.tiers) {
    const row = section.locator(`[data-fees="venue-tiers"] tr[data-tier="${tier.name}"]`);
    await expect(row.locator('[data-cell="from"]')).toHaveText(tier.fromVolume);
    await expect(row.locator('[data-cell="spot-maker"]')).toHaveText(pct(tier.spot.makerFeeBps.value));
    await expect(row.locator('[data-cell="spot-taker"]')).toHaveText(pct(tier.spot.takerFeeBps.value));
    await expect(row.locator('[data-cell="perp-maker"]')).toHaveText(pct(tier.perpetual.makerFeeBps.value));
    await expect(row.locator('[data-cell="perp-taker"]')).toHaveText(pct(tier.perpetual.takerFeeBps.value));
  }

  // Each listed market: the venue's own rates, our builder fee and the venue's cap on it, each read from the venue.
  const ours = await (await fetch(`${EDGE}/api/v1/venue/fees`)).json();
  const listedOnVenue = (await testVenue('/markets', {})).body.value;
  expect(ours.value.markets.length).toBeGreaterThan(0);
  const builderPct = pct(s.builder.feeBps);
  for (const m of ours.value.markets) {
    const venue = listedOnVenue.find((v) => v.symbol === m.symbol);
    const row = section.locator(`[data-fees="venue-markets"] tr[data-market="${m.symbol}"]`);
    // A rate below zero is the venue's rebate, never a negative fee.
    const rate = (r) =>
      !r.known
        ? 'not set'
        : toUnits(r.value) === 0n
          ? 'Zero fee'
          : toUnits(r.value) < 0n
            ? `Venue rebate ${pct(r.value).slice(1)}`
            : pct(r.value);
    await expect(row.locator('[data-cell="venue-maker"]')).toHaveText(rate(venue.makerFeeBps));
    await expect(row.locator('[data-cell="venue-taker"]')).toHaveText(rate(venue.takerFeeBps));
    await expect(row.locator('[data-cell="builder-cap"]')).toHaveText(pct(venue.builderFeeCapBps.value));
    // Ours, a sell's on spot, never above the venue's own cap on that market.
    await expect(row.locator('[data-cell="builder-fee"]')).toHaveText(`${builderPct}${venue.kind === 'spot' ? ' on a sell' : ''}`);
    expect(toUnits(s.builder.feeBps)).toBeLessThanOrEqual(toUnits(venue.builderFeeCapBps.value));
  }
  const blankRow = section.locator(`[data-fees="venue-markets"] tr[data-market="${blank.symbol}"]`);
  await expect(blankRow.locator('[data-cell="venue-maker"]')).toHaveText('not set');
  await expect(blankRow.locator('[data-cell="venue-taker"]')).toHaveText('not set');
  // The cap line names the venue's caps by kind, as the venue publishes them: 1% on spot, 0.1% on perpetuals.
  const caps = (kind) => [
    ...new Set(
      ours.value.markets
        .filter((m) => m.kind === kind)
        .map((m) => pct(listedOnVenue.find((v) => v.symbol === m.symbol).builderFeeCapBps.value)),
    ),
  ];
  expect(caps('spot')).toEqual(['1%']);
  await expect(section.locator('[data-fees="builder-cap"]')).toContainText('1% on spot');
  if (caps('perpetual').length) {
    expect(caps('perpetual')).toEqual(['0.1%']);
    await expect(section.locator('[data-fees="builder-cap"]')).toContainText('0.1% on perpetuals');
  }
  // The network fee for sending a coin out is its own line, never inside a trading rate.
  await expect(page.locator('[data-fees="network"]')).toContainText('Network fee on withdrawals');
});

test(`${J} #3 trades where our builder fee is not set: refused "builder fee not set" before signing`, async ({ page }) => {
  test.setTimeout(420_000);
  const s = state();
  const market = run.read().marketA;
  const before = { coin: await balanceOf(s.owner, market.base), usdc: await balanceOf(s.owner, 'USDC'), ledger: await ledgerOf(s) };
  const saved = process.env.LOCAL_STACK_USER_VENUE;
  process.env.LOCAL_STACK_USER_VENUE = 'on';
  try {
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE_BUILDER_FEE', 'off');
    const wallet = await openVenueDesk(page, s.account, desk(market.symbol), s.walletKey);
    const sent = writes(page);
    const asked = wallet.requests.length;
    // A limit sell: it would carry our builder fee, which is blank. The ticket says so in words; nothing can be sent.
    await orderTab(page, 'Limit').click();
    await sellForm(page).getByRole('textbox', { name: 'Price', exact: true }).fill('150');
    await sellForm(page).getByRole('textbox', { name: 'Amount', exact: true }).fill('1');
    const refused = page.getByTestId('venue-ticket-refused');
    await expect(refused).toContainText('Builder fee not set', { timeout: 20_000 });
    await expect(refused).toHaveAttribute('data-code', 'trade.venue.builder_fee_not_published');
    const sell = sellForm(page).getByRole('button', { name: `Sell ${market.base}`, exact: true });
    await expect(sell).toBeDisabled();
    await sell.click({ force: true });
    await expect(reviewSheet(page)).toHaveCount(0);

    // Sent anyway, straight to the door: refused by name before anything is prepared for signing.
    const prepared = await (
      await api(s.account)
    ).post('/api/v1/venue/prepare', {
      owner: s.owner,
      signer: { role: 'owner', address: s.owner },
      intent: {
        kind: 'place_order',
        symbol: market.symbol,
        side: 'sell',
        type: 'limit',
        amount: '1',
        price: '150',
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: `order:${s.owner}:js10-blank-${randomBytes(4).toString('hex')}`,
        builderFee: null,
      },
      actionKey: `js10-blank-${randomBytes(4).toString('hex')}`,
    });
    expect(prepared.status, JSON.stringify(prepared.body).slice(0, 300)).toBe(422);
    expect(prepared.body.intafacedCode).toBe('trade.venue.builder_fee_not_published');
    expect(prepared.body.prepared).toBeUndefined();

    // Nothing was signed or sent, and nothing rests, locks or moves.
    expect(sent).toEqual([]);
    expect(wallet.requests.length).toBe(asked);
    expect(await openOn(s.owner, market.symbol)).toEqual([]);
    expect(await balanceOf(s.owner, market.base)).toEqual(before.coin);
    expect(await balanceOf(s.owner, 'USDC')).toEqual(before.usdc);
    expect(await ledgerOf(s)).toEqual(before.ledger);
  } finally {
    restartWithSetting('trade', 'LOCAL_STACK_USER_VENUE_BUILDER_FEE', null);
    if (saved === undefined) delete process.env.LOCAL_STACK_USER_VENUE;
    else process.env.LOCAL_STACK_USER_VENUE = saved;
  }
});

test(`${J} #4 fills where the venue charges no fee, and where the venue pays a rebate: zero fee shown; the rebate shown as the venue's rebate, never a negative fee`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const s = state();
  const ledgerBefore = await ledgerOf(s);

  // Zero fee: a market whose venue charges no maker or taker fee. The person's IOC buy takes the other trader's ask.
  const zero = await stepMarket('Z', s);
  expect((await testVenue('/test/market-fees', { symbol: zero.symbol, makerFeeBps: '0', takerFeeBps: '0' })).status).toBe(200);
  await traderOrder(MAKER, zero.symbol, 'sell', '100', '1', 'GTC');
  const zeroBuy = await personOrder(s, zero.symbol, 'buy', '100', '1', 'IOC');
  const [zeroFill] = await fillsOf(s, zeroBuy.venueClientOrderId);
  expect(zeroFill).toMatchObject({ role: 'taker', side: 'buy' });
  expect(toUnits(zeroFill.venueFee)).toBe(0n);
  expect(toUnits(zeroFill.builderFee)).toBe(0n);

  // A rebate: a market whose venue pays a maker 0.01% (a maker rate of -1 bps). The person's sell rests and is taken.
  const rebate = await stepMarket('R', s, '5');
  expect((await testVenue('/test/market-fees', { symbol: rebate.symbol, makerFeeBps: '-1', takerFeeBps: '3.5' })).status).toBe(200);
  const usdcBefore = await balanceOf(s.owner, 'USDC');
  const rested = await personOrder(s, rebate.symbol, 'sell', '100', '1', 'GTC');
  await traderOrder(TAKER, rebate.symbol, 'buy', '100', '1', 'IOC');
  const [rebateFill] = await fillsOf(s, rested.venueClientOrderId);
  expect(rebateFill).toMatchObject({ role: 'maker', side: 'sell', feeAsset: 'USDC' });
  // The venue's record: a fee below zero, 100 x 1 x -1 bps = -0.01 USDC, paid to the person; our builder fee apart.
  expect(rebateFill.venueFee).toMatch(/^-/);
  expect(toUnits(rebateFill.venueFee)).toBe(-toUnits('0.01'));
  const builderDue = (toUnits('100') * toUnits(s.builder.feeBps)) / toUnits('10000');
  expect(toUnits(rebateFill.builderFee)).toBe(builderDue);
  // The venue credited it: the sale, plus the rebate, less only our builder fee.
  const usdcAfter = await balanceOf(s.owner, 'USDC');
  expect(toUnits(usdcAfter.total) - toUnits(usdcBefore.total)).toBe(toUnits('100') + toUnits('0.01') - builderDue);

  // The desk's trade history, each fill as the venue charged it: "Zero fee" on one, the venue's rebate on the other.
  await openVenueDesk(page, s.account, desk(zero.symbol), s.walletKey);
  await page.getByRole('tab', { name: 'Trade history', exact: true }).click();
  const zeroRow = page.getByTestId('venue-fills').locator(`tr[data-fill="${zeroFill.fillId}"]`);
  await expect(zeroRow.locator('[data-cell="venue-fee"]')).toHaveText('Zero fee');
  await page.goto(desk(rebate.symbol));
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Trade history', exact: true }).click();
  const rebateRow = page.getByTestId('venue-fills').locator(`tr[data-fill="${rebateFill.fillId}"]`);
  await expect(rebateRow.locator('[data-cell="venue-fee"]')).toHaveText('Venue rebate 0.01');
  await expect(rebateRow.locator('[data-cell="venue-fee"] [data-fee="rebate"]')).toHaveAttribute('data-rebate', '0.01');
  // Never a negative fee anywhere on the row.
  await expect(rebateRow).not.toContainText(/[-−]\s*0\.0/);
  expect(sameDecimal(await rebateRow.locator('[data-cell="builder-fee"]').innerText(), fromUnits(builderDue))).toBe(true);
  // The ledger posts nothing for the person: the money is on their own venue account.
  expect(await ledgerOf(s)).toEqual(ledgerBefore);
});

test(`${J} #6 crosses a venue tier: the venue's tier read from the venue at its next update, with the figures the venue reports`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const s = state();
  const { chainId } = await venueInfo();
  const venueFees = async () => (await venueRecord(s.owner, '/fee-status')).value;
  const before = await venueFees();
  const [base, tier1, tier2] = before.schedule.tiers;
  expect(before.account.tierName).toBe(base.name);

  // My tier, with the person's wallet connected: the venue's tier, what it counted, and the next threshold.
  await installTestWallet(page, { chainId, privateKey: s.walletKey });
  await signIn(page, s.account);
  const open = async () => {
    await page.goto('/fees/my-tier');
    const section = page.locator('[data-tier-page="venue"]');
    await expect(section).toBeVisible({ timeout: 30_000 });
    // The first visit connects the wallet; a reload finds it connected already.
    const connect = section.getByRole('button', { name: 'Connect TEST Wallet', exact: true });
    await expect(connect.or(section.getByTestId('venue-wallet-address'))).toBeVisible({ timeout: 20_000 });
    if (await connect.isVisible()) await connect.click();
    await expect(section.getByTestId('venue-wallet-address')).toHaveText(s.owner);
    await expect(section.getByTestId('venue-tier')).toBeVisible({ timeout: 20_000 });
    return section.getByTestId('venue-tier');
  };
  let tier = await open();
  await expect(tier.locator('[data-cell="tier"]')).toHaveText(base.name);
  await expect(tier.locator('[data-cell="next"]')).toHaveText(`${tier1.name} from ${tier1.fromVolume} ${before.schedule.volumeAsset}`);

  // The person trades past tier 1's threshold: 1,100 at 100 on a market of this step's own, 110,000 USDC.
  const market = await stepMarket('T', s);
  await traderOrder(MAKER, market.symbol, 'sell', '100', '1100', 'GTC');
  const bought = await personOrder(s, market.symbol, 'buy', '100', '1100', 'IOC');
  await fillsOf(s, bought.venueClientOrderId);
  const traded = (await venueRecord(s.owner, '/fills', { since: new Date(Date.now() - 14 * 86_400_000).toISOString() })).value.reduce(
    (sum, f) => sum + (toUnits(f.price) * toUnits(f.amount)) / toUnits('1'),
    0n,
  );
  expect(traded).toBeGreaterThanOrEqual(toUnits(tier1.fromVolume));

  // Before the venue's next update the venue still reports the base tier, and so does the page.
  expect((await venueFees()).account.tierName).toBe(base.name);
  tier = await open();
  await expect(tier.locator('[data-cell="tier"]')).toHaveText(base.name);

  // The venue's next update places the account by the volume it counted; the page reads it from the venue.
  const updated = await testVenue('/test/fee-tier-update', { owner: s.owner });
  expect(updated.status, JSON.stringify(updated.body)).toBe(200);
  const after = await venueFees();
  expect(after.account.tierName).toBe(tier1.name);
  expect(toUnits(after.account.volume.value)).toBe(traded);
  tier = await open();
  await expect(tier.locator('[data-cell="tier"]')).toHaveText(tier1.name);
  expect(sameDecimal((await tier.locator('[data-cell="volume"]').innerText()).replace(/\s*USDC$/, ''), after.account.volume.value)).toBe(
    true,
  );
  await expect(tier.locator('[data-cell="updated"] time')).toHaveAttribute('datetime', after.account.tierUpdatedAt);
  await expect(tier.locator('[data-cell="spot-rates"]')).toHaveText(
    `maker ${pct(after.account.spot.makerFeeBps.value)}, taker ${pct(after.account.spot.takerFeeBps.value)}`,
  );
  await expect(tier.locator('[data-cell="next"]')).toHaveText(`${tier2.name} from ${tier2.fromVolume} ${after.schedule.volumeAsset}`);
  await expect(tier.locator(`tr[data-tier="${tier1.name}"]`)).toHaveAttribute('aria-current', 'true');
  // And the venue charges the new tier's rate from then on: the next preview on any market says so.
  const preview = await (
    await api(s.account)
  ).post('/api/v1/venue/preview', {
    owner: s.owner,
    intent: {
      kind: 'place_order',
      symbol: market.symbol,
      side: 'buy',
      type: 'limit',
      amount: '1',
      price: '50',
      timeInForce: 'GTC',
      reduceOnly: false,
      clientOrderKey: `order:${s.owner}:js10-tier-${randomBytes(4).toString('hex')}`,
      builderFee: null,
    },
  });
  expect(preview.status, JSON.stringify(preview.body).slice(0, 300)).toBe(200);
  expect(preview.body.value.rates).toEqual({ makerFeeBps: tier1.spot.makerFeeBps, takerFeeBps: tier1.spot.takerFeeBps });
});

test(`${J} #9 chooses to pay trading fees in IFC: at launch the row is disabled with its reason; nothing sent`, async ({ page }) => {
  test.setTimeout(180_000);
  const s = state();
  const market = run.read().marketA;
  const wallet = await openVenueDesk(page, s.account, desk(market.symbol), s.walletKey);
  const row = page.getByTestId('venue-fee-currency');
  await expect(row).toBeVisible();
  const ifc = row.getByRole('button', { name: 'IFC', exact: true });
  await expect(ifc).toBeDisabled();
  await expect(ifc).toHaveAccessibleDescription(
    'Not at launch: the venue charges its fee in the fill’s own coin, and INTAFACED holds no coin of yours to pay it with in IFC.',
  );
  // Chosen anyway: nothing is sent, to our door or anywhere, and the wallet is asked nothing.
  const requests = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET') requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  const asked = wallet.requests.length;
  await ifc.click({ force: true });
  await ifc.focus();
  await page.keyboard.press('Enter');
  // oxlint-disable-next-line garden/no-wait-for-timeout -- proving nothing is sent over a short while after the press
  await page.waitForTimeout(1_000);
  expect(requests.filter((r) => !r.endsWith('/api/v1/venue/preview'))).toEqual([]);
  expect(wallet.requests.length).toBe(asked);
  expect(await openOn(s.owner, market.symbol)).toEqual([]);
});
