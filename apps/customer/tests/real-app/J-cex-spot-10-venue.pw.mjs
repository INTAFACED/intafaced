// World: book, gates, restart, stack
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { setFeeSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';
import { EDGE, api, fromUnits, journeyState, restartWithSetting, toUnits } from './stack.mjs';
import { reviewSheet, signIn, signUp, verify } from './desk.mjs';
import { draftNotice, publishNotice } from './notices.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';
import { ownSpotMarket } from './own-market.mjs';
import {
  continueInWallet,
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
  venueRunState,
  venueWrites,
} from './venue.mjs';

// J-cex-spot-10 #1 #2 #3 #4 #6 #9 #10 #11 on the venue model (docs/roadmap/journeys.json): a person sees what they pay on
// their own venue account, the venue's maker or taker fee and our builder fee named apart, what tier the venue placed
// them in, and how to get cheaper. One test per step, titled "J-cex-spot-10 #<n>", run in order on one TEST account.
// J-cex-spot-10.pw.mjs keeps the steps that are ours alone (our tier programme, VIP benefits, fee currency on our own
// desk) and the custodial desk's checks of these eight, titled "part of", which count for no step.
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

const state = () => venueRunState(run, J);
const desk = (symbol) => `/trade/spot/${symbol}`;
const ref = () => `84532:0x${randomBytes(32).toString('hex')}:0`;
const traderOwner = (name) => otherTraderKey(name).address.toLowerCase();

const sellForm = (page) => page.locator('form[data-testid="dk-form"][data-side="sell"]');
const orderTab = (page, name) => page.getByTestId('dk-order').locator('[role=tab]', { hasText: new RegExp(`^${name}$`) });
const line = (scope, name) => scope.locator(`[data-line="${name}"]`);

/**
 * Opens a tab of the desk's bottom strip and checks it is the one shown. The caller first waits for the desk to settle
 * (its wallet back, its own orders read): until then it still grows above the strip, and a click lands where the tab
 * was a moment before. In run 44570528831 the Trade history click on a reloaded desk left Open orders shown.
 */
async function bottomTab(page, name) {
  const tab = page.getByTestId('venue-bottom').getByRole('tab', { name, exact: true });
  await tab.click();
  await expect(tab, `the ${name} tab is the one shown after its click`).toHaveAttribute('aria-selected', 'true');
}

/** "3.5" bps → "0.035%": the point moved two places, exactly as the page writes a rate. */
function pct(bps) {
  const units = toUnits(bps);
  const neg = units < 0n;
  const shown = fromUnits((neg ? -units : units) / 100n);
  return `${neg ? '-' : ''}${shown}%`;
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

/**
 * My tier with the person's wallet connected (the page was signed in with the TEST wallet installed): the venue's
 * section of it, once its tier is read. The first visit connects the wallet; a reload finds it connected already.
 */
async function openMyTier(page, s) {
  await page.goto('/fees/my-tier');
  const section = page.locator('[data-tier-page="venue"]');
  await expect(section).toBeVisible({ timeout: 30_000 });
  const connect = section.getByRole('button', { name: 'Connect TEST Wallet', exact: true });
  await expect(connect.or(section.getByTestId('venue-wallet-address'))).toBeVisible({ timeout: 20_000 });
  if (await connect.isVisible()) await connect.click();
  await expect(section.getByTestId('venue-wallet-address')).toHaveText(s.owner);
  await expect(section.getByTestId('venue-tier')).toBeVisible({ timeout: 20_000 });
  return section.getByTestId('venue-tier');
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
  stepPicture,
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

  // The desk reads the venue's market list once, as it opens: its header names the rates listed then.
  const wallet = await openVenueDesk(page, s.account, desk(market.symbol), s.walletKey);
  const sent = venueWrites(page);
  const asked = wallet.requests.length;
  const listedWords = `maker ${listed.makerFeeBps.value} bps, taker ${listed.takerFeeBps.value} bps`;
  await expect(page.getByTestId('venue-header')).toContainText(listedWords);
  const ledgerBefore = await ledgerOf(s);
  const coinBefore = await balanceOf(s.owner, market.base);
  // Every read of the market list from here on: a review that took its rates from a list read again as it opens would
  // show the venue's new rates too, so the list must not be read at all while the reviews are drawn.
  const listReads = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/v1/venue/markets') listReads.push(r.url());
  });

  // Then the venue changes this market's TEST rates (its own control, as a venue publishes a new schedule): the list the
  // page holds is now out of date, and only a preview of this order can carry the rates the venue charges now.
  const makerRate = '2.5';
  const takerRate = '6.5';
  expect([makerRate, takerRate]).not.toEqual([listed.makerFeeBps.value, listed.takerFeeBps.value]);
  const changed = await testVenue('/test/market-fees', { symbol: market.symbol, makerFeeBps: makerRate, takerFeeBps: takerRate });
  expect(changed.status, JSON.stringify(changed.body)).toBe(200);
  try {
    // The person's own rates as the venue reports them for their account now (the base tier: the market's own ones).
    const own = (await venueRecord(s.owner, '/fee-status')).value.account;
    expect(own.tierName).toBe('TEST base');
    expect(await venueMarket(market.symbol)).toMatchObject({
      makerFeeBps: { known: true, value: makerRate },
      takerFeeBps: { known: true, value: takerRate },
    });
    const ratesWords = `maker ${pct(makerRate)}, taker ${pct(takerRate)}`;
    const builderOn = (notional) => fromUnits((toUnits(notional) * toUnits(s.builder.feeBps)) / toUnits('10000'));
    const shown = async (scope, name) => (await line(scope, name).innerText()).replace(/[^\d.]/g, '');

    // A maker limit: a sell at 150 rests above every bid. Reviewed: the preview's own rates, role and fees, each named.
    await orderTab(page, 'Limit').click();
    await sellForm(page).getByRole('textbox', { name: 'Price', exact: true }).fill('150');
    const maker = await previewOn(page, () => sellForm(page).getByRole('textbox', { name: 'Amount', exact: true }).fill('1'));
    expect(maker.value).toMatchObject({
      role: 'maker',
      rates: { makerFeeBps: { known: true, value: makerRate }, takerFeeBps: { known: true, value: takerRate } },
    });
    // The venue's fee: 150 x 1 at the maker rate, in USDC; our builder fee beside it at our rate, a line of its own.
    expect(sameDecimal(maker.value.venueFee.value.amount, fromUnits((toUnits('150') * toUnits(makerRate)) / toUnits('10000')))).toBe(true);
    expect(sameDecimal(maker.value.builderFee.value.amount, builderOn('150'))).toBe(true);
    await sellForm(page)
      .getByRole('button', { name: `Sell ${market.base}`, exact: true })
      .click();
    let sheet = reviewSheet(page);
    await expect(sheet).toBeVisible();
    await expect(line(sheet, 'venue-rates')).toHaveText(ratesWords);
    await expect(line(sheet, 'role')).toHaveText('Maker');
    await expect(line(sheet, 'venue-fee')).toContainText('USDC');
    await expect(line(sheet, 'builder-fee')).toContainText('USDC');
    await expect.poll(async () => sameDecimal(await shown(sheet, 'venue-fee'), maker.value.venueFee.value.amount)).toBe(true);
    await expect.poll(async () => sameDecimal(await shown(sheet, 'builder-fee'), builderOn('150'))).toBe(true);
    // Not the list: the page read no market list since it opened, and its header still names the rates it read then.
    expect(listReads).toEqual([]);
    await expect(page.getByTestId('venue-header')).toContainText(listedWords);
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
    // What the venue charges a taker, and our builder fee: what fills now (at 99.8), each at its own rate.
    expect(sameDecimal(taker.value.venueFee.value.amount, fromUnits((toUnits('99.8') * toUnits(takerRate)) / toUnits('10000')))).toBe(true);
    expect(sameDecimal(taker.value.builderFee.value.amount, builderOn('99.8'))).toBe(true);
    await sellForm(page)
      .getByRole('button', { name: `Sell ${market.base}`, exact: true })
      .click();
    sheet = reviewSheet(page);
    await expect(sheet).toBeVisible();
    await expect(line(sheet, 'venue-rates')).toHaveText(ratesWords);
    await expect(line(sheet, 'role')).toHaveText('Taker');
    await expect(line(sheet, 'venue-fee')).toContainText('USDC');
    await expect(line(sheet, 'builder-fee')).toContainText('USDC');
    await expect.poll(async () => sameDecimal(await shown(sheet, 'venue-fee'), taker.value.venueFee.value.amount)).toBe(true);
    await expect.poll(async () => sameDecimal(await shown(sheet, 'builder-fee'), builderOn('99.8'))).toBe(true);
    expect(listReads).toEqual([]);
    await expect(page.getByTestId('venue-header')).toContainText(listedWords);
    // The step's picture: the taker's review open, its rates, role and both fees named.
    await stepPicture();
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();

    // Previewing sends nothing: no prepare or submit, no signature, no order, nothing locked, the ledger untouched.
    expect(sent).toEqual([]);
    expect(wallet.requests.length).toBe(asked);
    expect(await openOn(s.owner, market.symbol)).toEqual([]);
    expect(await balanceOf(s.owner, market.base)).toEqual(coinBefore);
    expect(await ledgerOf(s)).toEqual(ledgerBefore);
  } finally {
    // This step's own market goes back to the rates it listed, for #3 and #9, which trade on it.
    await testVenue('/test/market-fees', {
      symbol: market.symbol,
      makerFeeBps: listed.makerFeeBps.value,
      takerFeeBps: listed.takerFeeBps.value,
    });
  }
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

  // The venue's tiers, row for row as the venue's own record publishes them (one schedule, whichever account reads it).
  const schedule = (await venueRecord(s.owner, '/fee-status')).value.schedule;
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
  const listedOnVenue = (await venueRecord(s.owner, '/markets')).value;
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
    const sent = venueWrites(page);
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
  await bottomTab(page, 'Trade history');
  const zeroRow = page.getByTestId('venue-fills').locator(`tr[data-fill="${zeroFill.fillId}"]`);
  await expect(zeroRow.locator('[data-cell="venue-fee"]')).toHaveText('Zero fee');
  await page.goto(desk(rebate.symbol));
  await expect(page.getByTestId('venue-header')).toBeVisible({ timeout: 30_000 });
  // The wallet comes back on its own after the load (no prompt): the desk is the person's before its history is read.
  await expect(page.getByTestId('venue-wallet-address')).toHaveText(s.owner, { timeout: 20_000 });
  // And its reads of the person's account have answered: the rested order is listed, Filled, under Open orders.
  await expect(page.getByTestId('venue-open-orders').locator(`a[href="/trade/orders/${rested.venueClientOrderId}"]`)).toBeVisible({
    timeout: 20_000,
  });
  await bottomTab(page, 'Trade history');
  const rebateRow = page.getByTestId('venue-fills').locator(`tr[data-fill="${rebateFill.fillId}"]`);
  await expect(rebateRow.locator('[data-cell="venue-fee"]')).toHaveText('Venue rebate 0.01');
  await expect(rebateRow.locator('[data-cell="venue-fee"] [data-fee="rebate"]')).toHaveAttribute('data-rebate', '0.01');
  // Never a negative fee anywhere on the row.
  await expect(rebateRow).not.toContainText(/[-−]\s*0\.0/);
  await expect
    .poll(async () => sameDecimal(await rebateRow.locator('[data-cell="builder-fee"]').innerText(), fromUnits(builderDue)))
    .toBe(true);
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
  const open = () => openMyTier(page, s);
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
  await expect
    .poll(async () =>
      sameDecimal((await tier.locator('[data-cell="volume"]').innerText()).replace(/\s*USDC$/, ''), after.account.volume.value),
    )
    .toBe(true);
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

/** The stack's regular engine rates, carried unchanged beside our TEST builder-fee versions. */
const BASE_SCHEDULE = {
  defaultPairGroup: 'all-others',
  pairGroups: { 'ETH/USDC': 'test-zero-fee' },
  rows: [
    { pairGroup: 'all-others', tierId: 'regular', zeroFee: false, makerBps: '8', takerBps: '10', minFee: null },
    { pairGroup: 'all-others', tierId: 'test-vip-1', zeroFee: false, makerBps: '6', takerBps: '9', minFee: null },
    { pairGroup: 'test-zero-fee', tierId: 'regular', zeroFee: true, minFee: null },
  ],
  perpetual: { makerBps: '2', takerBps: '5' },
};

/** BASE_SCHEDULE with a TEST builder-fee version on `venueId`: `symbol` at `symbolBps`, every other market at `defaultBps`. */
const builderSchedule = (venueId, defaultBps, symbol, symbolBps) => ({
  ...BASE_SCHEDULE,
  builderFees: {
    [venueId]: {
      defaultGroup: 'all-markets',
      marketGroups: { [symbol]: 'test-fee-change' },
      groups: { 'all-markets': defaultBps, 'test-fee-change': symbolBps },
    },
  },
});

/** Latest stored fee-schedule effective time: a new version may not start before it. */
async function latestScheduleEffective(founders) {
  const { ctx, sessions } = await founders.ops();
  const res = await ctx.edge.query('trade', 'admin.fees.get', undefined, await sessions.a.tradeOpsToken());
  const data = res.json?.result?.data;
  expect(data, JSON.stringify(res.json).slice(0, 300)).toBeTruthy();
  return data.history.length ? data.history[data.history.length - 1].effectiveAt : null;
}

/** Our builder fee currently published on `/api/v1/venue/fees` for `symbol`. */
async function publicBuilderFee(symbol) {
  const res = await fetch(`${EDGE}/api/v1/venue/fees`);
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.value.markets.find((m) => m.symbol === symbol)?.builderFeeBps ?? null;
}

test(`${J} #10 receives a fee-change notice before a new schedule version takes effect: /notice shows the effective time; open orders keep their placement version`, async ({
  page,
  founders,
  stepPicture,
}) => {
  test.setTimeout(360_000);
  const s = state();
  const session = await api(s.account);
  const venueId = (await venueInfo()).id;
  const ledgerBefore = await ledgerOf(s);
  const tag = Date.now().toString(36);
  const since = new Date(Date.now() - 60_000).toISOString();

  // This step's own market with a bid at 99.8 and an ask at 180 (within 95% of 99.8), so our resting sells at 150 sit
  // at the best ask and a crossing buy at 150 meets only them.
  const market = await stepMarket('F', s, '10');
  await traderOrder(MAKER, market.symbol, 'buy', '99.8', '5', 'GTC');
  await traderOrder(MAKER, market.symbol, 'sell', '180', '5', 'GTC');
  const listed = await venueMarket(market.symbol);
  const ownRates = (await venueRecord(s.owner, '/fee-status')).value.account;
  const makerBps = ownRates?.spot.makerFeeBps.known ? ownRates.spot.makerFeeBps.value : listed.makerFeeBps.value;

  const { ctx, sessions } = await founders.ops();
  const prevEffective = await latestScheduleEffective(founders);
  const v1At = Math.max(Date.now() + 8_000, prevEffective ? Date.parse(prevEffective) + 3_000 : 0);
  const v1 = await setFeeSchedule(ctx, builderSchedule(venueId, s.builder.feeBps, market.symbol, '2'), {
    effectiveAt: v1At,
    reason: `LOCAL TEST ${J}: ${market.symbol} builder fee 2 bps before the change`,
    sessions,
  });
  let v2 = null;
  try {
    await expect
      .poll(async () => (await publicBuilderFee(market.symbol))?.value ?? null, {
        timeout: Math.max(0, Date.parse(v1.effectiveAt) - Date.now()) + 30_000,
      })
      .toBe('2');

    // Approve our builder up to v1's 2 bps, then place a resting sell under v1.
    await throughUs(
      s,
      { kind: 'approve_builder_fee', builder: s.builder.address, maxFeeBps: '2' },
      `builder-approval:${s.owner}:${J}-10-v1-${tag}`,
    );
    const order1 = await personOrder(s, market.symbol, 'sell', '150', '1', 'GTC');
    expect(sameDecimal(order1.builderFee.feeBps, '2')).toBe(true);
    expect((await openOn(s.owner, market.symbol)).map((o) => o.venueClientOrderId)).toContain(order1.venueClientOrderId);

    // Two operators schedule v2 (3 bps) ahead of time and publish the fee-change notice on /notice.
    const v2At = Math.max(Date.now() + 50_000, Date.parse(v1.effectiveAt) + 5_000);
    v2 = await setFeeSchedule(ctx, builderSchedule(venueId, s.builder.feeBps, market.symbol, '3'), {
      effectiveAt: v2At,
      reason: `LOCAL TEST ${J}: ${market.symbol} builder fee 3 bps from the notice time`,
      sessions,
    });
    const effectiveAt = new Date(v2.effectiveAt).toISOString();
    const draft = await draftNotice({
      kind: 'fee_change',
      title: `TEST fee change ${tag}`,
      body: `TEST: our builder fee on ${market.symbol} changes from 0.02% to 0.03%.`,
      startsAt: effectiveAt,
      key: `${J}:venue:${tag}:fee-change`,
    });
    expect((await publishNotice(draft, `${J}:venue:${tag}:fee-change`)).status).toBe('published');

    // Before the effective time: /notice shows the fee-change notice with its effective time, and v1 is still in force.
    await page.goto('/notice');
    const card = page.getByTestId(`notice-${draft.id}`);
    await expect(card).toContainText(`TEST fee change ${tag}`);
    await expect(card).toContainText('Fee change');
    const when = card.getByTestId('notice-effective');
    await expect(when).toHaveText(`Takes effect ${effectiveAt.slice(0, 19).replace('T', ' ')} UTC`);
    await expect(when).toHaveAttribute('datetime', effectiveAt);
    await expect(card).toContainText('Orders placed before then keep the fees in force when they were placed.');
    expect(Date.now()).toBeLessThan(Date.parse(effectiveAt));
    expect(sameDecimal((await publicBuilderFee(market.symbol)).value, '2')).toBe(true);
    // The step's picture: the notice on /notice naming the effective time before v2 takes effect.
    await stepPicture();

    // Once the effective time passes: the public schedule serves v2's 3 bps, and order1 still rests unfilled.
    await expect
      .poll(async () => (await publicBuilderFee(market.symbol))?.value ?? null, {
        timeout: Math.max(0, Date.parse(effectiveAt) - Date.now()) + 30_000,
      })
      .toBe('3');
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(effectiveAt));
    await page.goto('/fees');
    await expect(page.locator(`[data-fees="venue-markets"] tr[data-market="${market.symbol}"] [data-cell="builder-fee"]`)).toHaveText(
      '0.03% on a sell',
    );
    expect((await openOn(s.owner, market.symbol)).map((o) => o.venueClientOrderId)).toContain(order1.venueClientOrderId);
    const earlyFills = (await venueRecord(s.owner, '/fills', { since })).value.filter(
      (f) => f.venueClientOrderId === order1.venueClientOrderId,
    );
    expect(earlyFills).toEqual([]);

    // The order placed under v1 fills after v2 took effect: the venue charges v1's 2 bps (0.03 USDC), not v2's 3 bps.
    await traderOrder(TAKER, market.symbol, 'buy', '150', '1', 'IOC');
    const [fill1] = await fillsOf(s, order1.venueClientOrderId);
    const fee1Builder = fromUnits((toUnits('150') * toUnits('2')) / toUnits('10000'));
    const fee1Venue = fromUnits((toUnits('150') * toUnits(makerBps)) / toUnits('10000'));
    expect(fill1).toMatchObject({ role: 'maker', side: 'sell', feeAsset: 'USDC' });
    expect(sameDecimal(fill1.builderFee, fee1Builder)).toBe(true);
    expect(sameDecimal(fill1.venueFee, fee1Venue)).toBe(true);

    // On the desk: Trade history shows fill1's placement builder fee, and a new order previews and signs under v2 (3 bps).
    await openVenueDesk(page, s.account, desk(market.symbol), s.walletKey);
    await expect(page.getByTestId('venue-open-orders').locator(`a[href="/trade/orders/${order1.venueClientOrderId}"]`)).toBeVisible({
      timeout: 20_000,
    });
    await bottomTab(page, 'Trade history');
    const fill1Row = page.getByTestId('venue-fills').locator(`tr[data-fill="${fill1.fillId}"]`);
    await expect.poll(async () => sameDecimal(await fill1Row.locator('[data-cell="builder-fee"]').innerText(), fee1Builder)).toBe(true);
    await expect.poll(async () => sameDecimal(await fill1Row.locator('[data-cell="venue-fee"]').innerText(), fee1Venue)).toBe(true);

    await orderTab(page, 'Limit').click();
    await sellForm(page).getByRole('textbox', { name: 'Price', exact: true }).fill('150');
    const nextPreview = await previewOn(page, () => sellForm(page).getByRole('textbox', { name: 'Amount', exact: true }).fill('1'));
    const fee2Builder = fromUnits((toUnits('150') * toUnits('3')) / toUnits('10000'));
    expect(sameDecimal(nextPreview.value.builderFeeBps, '3')).toBe(true);
    expect(sameDecimal(nextPreview.value.builderFee.value.amount, fee2Builder)).toBe(true);

    // Because v2 raised our builder fee past the wallet's 2 bps approval, the review asks to approve 3 bps before Confirm.
    await sellForm(page)
      .getByRole('button', { name: `Sell ${market.base}`, exact: true })
      .click();
    const sheet = reviewSheet(page);
    await expect(sheet).toBeVisible();
    await expect(line(sheet, 'builder-fee')).toContainText('0.045');
    await expect(line(sheet, 'builder-fee')).toContainText('3 bps');
    const confirmSell = sheet.getByRole('button', { name: 'Confirm sell', exact: true });
    await expect(confirmSell).toBeDisabled();
    await sheet.getByRole('button', { name: 'Approve our builder fee in your wallet', exact: true }).click();
    await continueInWallet(page);
    await expect(confirmSell).toBeEnabled({ timeout: 20_000 });
    await confirmSell.click();
    await continueInWallet(page);
    await expect(sheet).toHaveCount(0);

    // Wait for the new order placed under v2 to rest, cross it, and verify it carries v2's 3 bps (0.045 USDC).
    let order2;
    await expect
      .poll(
        async () => {
          const open = await openOn(s.owner, market.symbol);
          order2 = open.find((o) => o.venueClientOrderId !== order1.venueClientOrderId);
          return order2?.venueClientOrderId ?? null;
        },
        { timeout: 20_000 },
      )
      .toBeTruthy();
    await traderOrder(TAKER, market.symbol, 'buy', '150', '1', 'IOC');
    const [fill2] = await fillsOf(s, order2.venueClientOrderId);
    expect(fill2).toMatchObject({ role: 'maker', side: 'sell', feeAsset: 'USDC' });
    expect(sameDecimal(fill2.builderFee, fee2Builder)).toBe(true);

    // Our ledger posts only our builder fee earned for each fill (0.03 for v1, 0.045 for v2), and holds none of the person's money.
    await expect
      .poll(
        async () => {
          const { status, body } = await session.get(`/api/v1/venue/builder-fees?owner=${s.owner}&since=${encodeURIComponent(since)}`);
          if (status !== 200) return false;
          const byFill = new Map(body.value.map((r) => [r.fillId, r]));
          const r1 = byFill.get(fill1.fillId);
          const r2 = byFill.get(fill2.fillId);
          return (
            r1?.status === 'posted' &&
            Boolean(r1.ledgerTxId) &&
            sameDecimal(r1.amount, fee1Builder) &&
            r2?.status === 'posted' &&
            Boolean(r2.ledgerTxId) &&
            sameDecimal(r2.amount, fee2Builder)
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(await ledgerOf(s)).toEqual(ledgerBefore);
  } finally {
    const after = await latestScheduleEffective(founders);
    const restoreAt = Math.max(Date.now() + 8_000, after ? Date.parse(after) + 3_000 : 0, v2 ? Date.parse(v2.effectiveAt) + 3_000 : 0);
    await setFeeSchedule(ctx, BASE_SCHEDULE, {
      effectiveAt: restoreAt,
      reason: `LOCAL TEST ${J}: restore boot builder fee after #10`,
      sessions,
    });
    await expect
      .poll(
        async () => {
          const fee = await publicBuilderFee(market.symbol);
          return fee?.known ? sameDecimal(fee.value, s.builder.feeBps) : false;
        },
        { timeout: Math.max(0, restoreAt - Date.now()) + 30_000 },
      )
      .toBe(true);
  }
});

test(`${J} #11 reads the fee and volume API: the same rates and volume as the screen`, async ({ page }) => {
  test.setTimeout(180_000);
  const s = state();
  const { chainId } = await venueInfo();
  // What the venue itself reports for this account now: #6 placed it in a tier by the volume it counted.
  const venue = (await venueRecord(s.owner, '/fee-status')).value.account;
  expect(venue, "the venue reports this account's fees").toBeTruthy();
  expect(venue.volume.known).toBe(true);
  expect(toUnits(venue.volume.value)).toBeGreaterThan(0n);

  // The fee and volume API, read with the person's own session: the venue's tier, volume and rates, nothing of ours.
  const session = await api(s.account);
  const read = await session.get(`/api/v1/venue/fee-tier?owner=${s.owner}`);
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  const fees = read.body.value.account;
  expect(read.body.test).toBe(true);
  expect(fees.tierName).toBe(venue.tierName);
  expect(fees.volume.known).toBe(true);
  expect(sameDecimal(fees.volume.value, venue.volume.value)).toBe(true);
  for (const role of ['makerFeeBps', 'takerFeeBps']) {
    expect(fees.spot[role].known).toBe(true);
    expect(sameDecimal(fees.spot[role].value, venue.spot[role].value)).toBe(true);
    expect(fees.perpetual[role].known).toBe(venue.perpetual[role].known);
    if (venue.perpetual[role].known) expect(sameDecimal(fees.perpetual[role].value, venue.perpetual[role].value)).toBe(true);
  }
  expect(new Date(fees.tierUpdatedAt).toISOString()).toBe(new Date(venue.tierUpdatedAt).toISOString());

  // My tier shows the same tier, volume and spot rates the API answered.
  await installTestWallet(page, { chainId, privateKey: s.walletKey });
  await signIn(page, s.account);
  const tier = await openMyTier(page, s);
  await expect(tier.locator('[data-cell="tier"]')).toHaveText(fees.tierName);
  await expect
    .poll(async () => sameDecimal((await tier.locator('[data-cell="volume"]').innerText()).replace(/\s*USDC$/, ''), fees.volume.value))
    .toBe(true);
  await expect(tier.locator('[data-cell="spot-rates"]')).toHaveText(
    `maker ${pct(fees.spot.makerFeeBps.value)}, taker ${pct(fees.spot.takerFeeBps.value)}`,
  );
  await expect(tier.locator('[data-cell="updated"] time')).toHaveAttribute('datetime', fees.tierUpdatedAt);
});
