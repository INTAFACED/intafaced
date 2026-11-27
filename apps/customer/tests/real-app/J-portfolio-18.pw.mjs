// World: book, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { MINUTE, minuteStart } from './clock.mjs';
import { api, fromUnits, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import { connectWhenAsked } from './dex.mjs';
import {
  continueInWallet,
  doorOk,
  openVenueDesk,
  openVenuePage,
  sameDecimal,
  signPrepared,
  testDeposit,
  testVenue,
  venueForThisFile,
  venueRecord,
} from './venue.mjs';

// J-portfolio-18, "My closed futures trades fill my journal by themselves, with how far each went against and for me and
// the R I planned and got", in the running app against the stack's TEST venue simulator, on its TEST perpetual XJRN-PERP
// (only this file trades it, moves its ladder or takes its history away: packages/venue-sim/src/http-server.ts). One
// test per step, titled "J-portfolio-18 #<n>", run in order on one TEST account. Every figure the Journal shows is
// worked here from the TEST venue's own record (its fills and 1-minute candles, read straight from the venue, never
// through our door), never typed. Every figure is TEST.
//
// The Starts line, made before #1 through our door and signed with the person's own key (our builder fee attached):
//   B, a short opened with no stop and bought back; then the venue keeps XJRN-PERP's candles only from after B
//       (/test/history-kept), as a venue past the history it keeps, so B's MAE and MFE are "incomplete";
//   A, a long opened with a stop (a stop-loss trigger placed before its next fill), added to after the price fell, and
//       closed in two parts as it rose;
//   C, a long that one sell turned short, the short then bought back;
//   D, a long left open for #6 to close on the desk.
// Each trade starts in a minute of its own, so a 1-minute candle holds one trade's prints only. The person writes
// nothing in the journal. #7 takes the venue's fills and candles of the market away and puts them back after the file.
const J = 'J-portfolio-18';
const SYMBOL = 'XJRN-PERP';
const JOURNAL = '/money/journal';
const DESK = `/trade/futures?symbol=${SYMBOL}`;
const STOP = '95';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);
test.afterAll(async () => {
  await testVenue('/test/history-kept', { symbol: SYMBOL, fillsFrom: null, candlesFrom: null });
});

const SCALE = toUnits('1');
const sum = (xs) => xs.reduce((t, x) => t + x, 0n);
const div = (a, b) => (a * SCALE) / b;
const abs = (x) => (x < 0n ? -x : x);
/** Half away from zero, to `places` decimal places (the journal's rounding of R and percent). */
function roundTo(units, places) {
  const step = 10n ** BigInt(18 - places);
  const q = abs(units) / step;
  const out = (abs(units) % step) * 2n >= step ? q + 1n : q;
  return units < 0n ? -(out * step) : out * step;
}
/** `total` split by `weights`, the remainder to the largest remainders (ledger-client proRata). */
function proRata(total, weights) {
  const all = sum(weights);
  const shares = weights.map((w) => (total * w) / all);
  const rest = weights.map((w, i) => ({ i, r: (total * w) % all })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  let dust = total - sum(shares);
  for (const { i } of rest) {
    if (dust === 0n) break;
    shares[i] += 1n;
    dust -= 1n;
  }
  return shares;
}
const minuteOf = (iso) => minuteStart(Date.parse(iso));
/**
 * Waits until the venue's clock (the stack's own) has passed into the next whole minute, so the next trade's 1-minute
 * candles hold its own prints only: the venue's candle is the outcome waited on, and it has no TEST clock.
 */
async function nextMinute() {
  const next = minuteStart(Date.now()) + MINUTE;
  await expect.poll(() => Date.now() > next, { timeout: 70_000, intervals: [1_000] }).toBe(true);
}

function state() {
  const s = run.read();
  if (!s.account || !s.walletKey || !s.trades)
    throw new Error(`${J}'s Starts line made no account, wallet and trades, so this step has none`);
  return { ...s, key: privateKeyToAccount(s.walletKey), owner: privateKeyToAccount(s.walletKey).address.toLowerCase() };
}

/** One action through our door, signed with the person's key; returns the venue's client order id for an order. */
async function door(session, key, intent, actionKey = null) {
  const owner = key.address.toLowerCase();
  const prepared = doorOk(
    await session.post('/api/v1/venue/prepare', { owner, signer: { role: 'owner', address: owner }, intent, actionKey }),
  );
  const sent = doorOk(
    await session.post('/api/v1/venue/submit', { actionKey: prepared.actionKey, signature: await signPrepared(key, prepared.prepared) }),
  );
  expect(sent.outcome, JSON.stringify(sent.outcome).slice(0, 300)).toMatchObject({ definite: true, accepted: true });
  return prepared.prepared.venueClientOrderId;
}
const order = (tag, n, side, amount, price, over = {}) => ({
  kind: 'place_order',
  symbol: SYMBOL,
  side,
  type: 'limit',
  amount,
  price,
  timeInForce: 'IOC',
  reduceOnly: false,
  clientOrderKey: `order:jpf18:${tag}:${n}`,
  builderFee: null,
  ...over,
});
/** The TEST makers rest XJRN-PERP's ladder around `mid` (0.1 apart, 1 XJRN a level). */
const ladder = async (mid) => expect((await testVenue('/test/ladder-mid', { symbol: SYMBOL, price: mid })).status).toBe(200);

/**
 * One trade as the journal must show it, worked from the venue's own fills: `opens` and `closes` are [fill, amount]
 * pairs (a fill that flipped the position is in two trades, its fees split by size and its realised result with the close).
 */
function expected(id, side, opens, closes, largest) {
  const part = ([f, amount], closing) => {
    const units = toUnits(amount);
    const whole = toUnits(f.amount);
    const share = (fee) => (units === whole ? toUnits(fee) : proRata(toUnits(fee), [units, whole - units])[closing ? 0 : 1]);
    return { f, units, venueFee: share(f.venueFee), builderFee: share(f.builderFee), realised: closing ? toUnits(f.realisedPnl) : 0n };
  };
  const o = opens.map((p) => part(p, false));
  const c = closes.map((p) => part(p, true));
  const all = [...o, ...c].sort((a, b) => Date.parse(a.f.filledAt) - Date.parse(b.f.filledAt));
  const avg = (ps) => div(sum(ps.map((p) => (toUnits(p.f.price) * p.units) / SCALE)), sum(ps.map((p) => p.units)));
  const realised = sum(c.map((p) => p.realised));
  const venueFees = sum(all.map((p) => p.venueFee));
  const builderFees = sum(all.map((p) => p.builderFee));
  return {
    id,
    side,
    openedAt: o[0].f.filledAt,
    closedAt: c.at(-1).f.filledAt,
    entry: fromUnits(avg(o)),
    exit: fromUnits(avg(c)),
    size: largest,
    realised: fromUnits(realised),
    venueFees: fromUnits(venueFees),
    builderFees: fromUnits(builderFees),
    fills: all.map((p) => ({
      fillId: p.f.fillId,
      filledAt: p.f.filledAt,
      price: p.f.price,
      amount: fromUnits(p.units),
      venueFee: fromUnits(p.venueFee),
      builderFee: fromUnits(p.builderFee),
      opening: o.includes(p),
      split: p.units !== toUnits(p.f.amount),
    })),
  };
}

/** The net result: the venue's realised result, less the venue's fee and our builder fee, plus or minus funding. */
function withNet(t, funding) {
  t.funding = fromUnits(funding);
  t.net = fromUnits(toUnits(t.realised) - toUnits(t.venueFees) - toUnits(t.builderFees) + funding);
  return t;
}

/** MAE and MFE as the journal must show them: the venue's 1-minute candles from the trade's opening minute to its close. */
function excursion(trade, candles) {
  const from = minuteOf(trade.openedAt);
  const to = Date.parse(trade.closedAt);
  const window = candles.filter((c) => Date.parse(c.openAt) >= from && Date.parse(c.openAt) <= to);
  const low = window.map((c) => toUnits(c.lowPrice)).reduce((a, b) => (a < b ? a : b));
  const high = window.map((c) => toUnits(c.highPrice)).reduce((a, b) => (a > b ? a : b));
  const entry = toUnits(trade.entry);
  const long = trade.side === 'long';
  const of = (price, perUnit) => ({
    price: fromUnits(price),
    perUnit: fromUnits(perUnit),
    usd: fromUnits((perUnit * toUnits(trade.size)) / SCALE),
    pct: fromUnits(roundTo(div(perUnit * 100n, entry), 2)),
  });
  const worst = long ? low : high;
  const best = long ? high : low;
  const max0 = (x) => (x < 0n ? 0n : x);
  return { mae: of(worst, max0(long ? entry - worst : worst - entry)), mfe: of(best, max0(long ? best - entry : entry - best)) };
}

/** R as the journal must show it: 1R = |entry − stop| × largest size; actual R = net ÷ 1R, to four places. */
function rOf(trade, stop) {
  const risk = (abs(toUnits(trade.entry) - toUnits(stop)) * toUnits(trade.size)) / SCALE;
  return { risk: fromUnits(risk), r: fromUnits(roundTo(div(toUnits(trade.net), risk), 4)) };
}

/** XJRN-PERP's fills of the person's account, and its 1-minute candles, as the venue returns them now. */
async function venueNow(owner, since) {
  const fills = (await venueRecord(owner, '/fills', { since })).value.filter((f) => f.symbol === SYMBOL);
  const candles = (await testVenue('/candles', { symbol: SYMBOL, interval: '1m', limit: 720, since })).body.value;
  return { fills, candles };
}

/** TEST setup, not a step (the Starts line). */
async function startsLine(browser) {
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'pf18');
    await verify(page, account);
    const walletKey = testWalletKey();
    const key = privateKeyToAccount(walletKey);
    const owner = key.address.toLowerCase();
    const tag = randomBytes(4).toString('hex');
    const since = new Date(Date.now() - 60_000).toISOString();
    expect(await testDeposit(owner, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    await testVenue('/test/history-kept', { symbol: SYMBOL, fillsFrom: null, candlesFrom: null });
    await testVenue('/test/set-index', { symbol: SYMBOL, price: '100' });
    await testVenue('/test/set-mark', { symbol: SYMBOL, price: '100' });
    const session = await api(account);
    const builder = (await session.get('/api/v1/venue/status')).body.builder;
    expect(builder?.feeBps, 'the stack publishes a TEST builder fee').toBeTruthy();
    await door(
      session,
      key,
      { kind: 'approve_builder_fee', builder: builder.address, maxFeeBps: builder.feeBps },
      `builder-approval:${owner}:${builder.address}:${builder.feeBps}`,
    );
    await door(
      session,
      key,
      { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 100_000, marginMode: 'isolated' },
      `leverage:${owner}:${SYMBOL}:isolated:10:jpf18-${tag}`,
    );
    const ids = {};
    const act = async (name, intent) => (ids[name] = await door(session, key, intent));

    // B: a short with no stop, bought back. Then the venue keeps the market's candles only from after it.
    await nextMinute();
    await ladder('100');
    await act('B1', order(tag, 'b1', 'sell', '0.1', '99.9'));
    await act('B2', order(tag, 'b2', 'buy', '0.1', '100.1', { reduceOnly: true }));
    await testVenue('/test/history-kept', { symbol: SYMBOL, candlesFrom: new Date().toISOString() });

    // A: a long opened with a stop at 95, added to at 98.1, closed in two parts at 102.9 and 103.9.
    await nextMinute();
    await ladder('100');
    await act('A1', order(tag, 'a1', 'buy', '0.1', '100.1'));
    await act(
      'Astop',
      order(tag, 'astop', 'sell', '0.1', '90', {
        timeInForce: 'GTC',
        reduceOnly: true,
        trigger: { price: STOP, source: 'mark', role: 'stop_loss' },
      }),
    );
    await ladder('98');
    await act('A2', order(tag, 'a2', 'buy', '0.1', '98.1'));
    await ladder('103');
    await act('A3', order(tag, 'a3', 'sell', '0.1', '102.9', { reduceOnly: true }));
    await ladder('104');
    await act('A4', order(tag, 'a4', 'sell', '0.1', '103.9', { reduceOnly: true }));

    // C: a long of 0.1 that one sell of 0.3 turns into a short of 0.2, then bought back.
    await nextMinute();
    await ladder('100');
    await act('C1', order(tag, 'c1', 'buy', '0.1', '100.1'));
    await act('C2', order(tag, 'c2', 'sell', '0.3', '99.9'));
    await act('C3', order(tag, 'c3', 'buy', '0.2', '100.1', { reduceOnly: true }));

    // D: a long left open, for #6 to close on the desk.
    await nextMinute();
    await ladder('100');
    await act('D1', order(tag, 'd1', 'buy', '0.1', '100.1'));
    await ladder('100');

    const { fills, candles } = await venueNow(owner, since);
    const of = (name) => {
      const mine = fills.filter((f) => f.venueClientOrderId === ids[name]);
      expect(mine, `${name}: one fill on the venue`).toHaveLength(1);
      return mine[0];
    };
    for (const name of ['B2', 'A3', 'A4', 'C2', 'C3']) expect(of(name).realisedPnl, `${name} reports its realised result`).not.toBeNull();
    for (const f of fills) expect(toUnits(f.builderFee) > 0n, `fill ${f.fillId} carries our builder fee`).toBe(true);
    // The stop the trade opened with was placed before its next fill, as the venue records it.
    const history = (await venueRecord(owner, '/order-history')).value;
    const stop = history.find((r) => r.order.venueClientOrderId === ids.Astop);
    expect(stop?.order.trigger).toMatchObject({ role: 'stop_loss', price: STOP });
    expect(Date.parse(stop.placedAt)).toBeLessThan(Date.parse(of('A2').filledAt));
    // No funding period of the market closed while any of them was open.
    const funding = (await venueRecord(owner, '/funding-payments', { since })).value.filter((p) => p.symbol === SYMBOL);

    const B = expected(of('B1').fillId, 'short', [[of('B1'), '0.1']], [[of('B2'), '0.1']], '0.1');
    const A = expected(
      of('A1').fillId,
      'long',
      [
        [of('A1'), '0.1'],
        [of('A2'), '0.1'],
      ],
      [
        [of('A3'), '0.1'],
        [of('A4'), '0.1'],
      ],
      '0.2',
    );
    const CL = expected(of('C1').fillId, 'long', [[of('C1'), '0.1']], [[of('C2'), '0.1']], '0.1');
    const CS = expected(of('C2').fillId, 'short', [[of('C2'), '0.2']], [[of('C3'), '0.2']], '0.2');
    for (const t of [B, A, CL, CS])
      withNet(
        t,
        sum(
          funding
            .filter(
              (p) =>
                p.side === t.side && Date.parse(p.periodAt) > Date.parse(t.openedAt) && Date.parse(p.periodAt) <= Date.parse(t.closedAt),
            )
            .map((p) => toUnits(p.amount)),
        ),
      );
    // Each trade's candles from the venue, read before #7 takes them away: B's minute is gone; the others are whole.
    expect(candles.some((c) => Date.parse(c.openAt) === minuteOf(B.openedAt))).toBe(false);
    run.reset({
      account,
      walletKey,
      tag,
      since,
      ids,
      dFill: of('D1').fillId,
      trades: { B, A, CL, CS },
      excursion: { A: excursion(A, candles), CL: excursion(CL, candles), CS: excursion(CS, candles) },
      r: rOf(A, STOP),
    });
  } finally {
    await page.close();
  }
}

/** The Journal as the person, with the TEST wallet connected; waits until the venue's journal has answered. */
async function openJournal(page, s, { fresh = true } = {}) {
  if (fresh) await openVenuePage(page, s.account, JOURNAL, s.walletKey);
  else {
    await page.goto(JOURNAL);
    await connectWhenAsked(page, page.getByTestId('venue-wallet-address'));
  }
  await expect(page.getByTestId('money-journal')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('venue-wallet-address')).toHaveText(s.owner);
  await expect(page.getByTestId('journal-summary')).toBeVisible({ timeout: 30_000 });
}
const rowOf = (page, trade) => page.locator(`[data-testid="journal-row"][data-trade="${trade.id}"]`);
const textOf = async (locator) => (await locator.innerText()).replace(/\s*USDC$/, '').trim();
const shows = async (locator, want, what) =>
  expect.poll(async () => sameDecimal(await textOf(locator), want), { message: `${what}: ${want}`, timeout: 15_000 }).toBe(true);

/** Opens one trade beside the list from its row, as the person does. */
async function openTrade(page, trade) {
  await rowOf(page, trade).getByRole('link').first().click();
  const detail = page.locator(`[data-testid="journal-trade"][data-trade="${trade.id}"]`);
  await expect(detail).toBeVisible({ timeout: 15_000 });
  return detail;
}

async function checkRow(page, t) {
  const row = rowOf(page, t);
  await expect(row).toHaveAttribute('data-symbol', SYMBOL);
  await expect(row).toHaveAttribute('data-side', t.side);
  await expect(row).toContainText(t.side === 'long' ? 'Long' : 'Short');
  for (const [cell, want] of [
    ['entry', t.entry],
    ['exit', t.exit],
    ['size', t.size],
    ['realised', t.realised],
    ['venue-fee', t.venueFees],
    ['builder-fee', t.builderFees],
    ['funding', t.funding],
    ['net', t.net],
  ])
    await shows(row.locator(`[data-cell="${cell}"]`), want, `${t.id} ${cell}`);
}

async function checkFills(detail, t) {
  const rows = detail.getByTestId('journal-fill');
  await expect(rows).toHaveCount(t.fills.length);
  for (const [i, f] of t.fills.entries()) {
    const row = rows.nth(i);
    await expect(row).toHaveAttribute('data-fill', f.fillId);
    await shows(row.locator('[data-cell="price"]'), f.price, `fill ${f.fillId} price`);
    await shows(row.locator('[data-cell="size"]'), f.amount, `fill ${f.fillId} size`);
    await shows(row.locator('[data-cell="venue-fee"]'), f.venueFee, `fill ${f.fillId} venue fee`);
    await shows(row.locator('[data-cell="builder-fee"]'), f.builderFee, `fill ${f.fillId} builder fee`);
    await expect(row.locator('[data-cell="part"]')).toHaveAttribute('data-opening', String(f.opening));
    await expect(row.locator('[data-cell="part"]')).toHaveAttribute('data-split', String(f.split));
    // Its time, as the venue stamped it.
    await expect(row).toHaveAttribute('data-at', new Date(f.filledAt).toISOString());
  }
  await shows(detail.getByTestId('journal-prices').locator('[data-part="entry"] dd'), t.entry, `${t.id} entry`);
  await shows(detail.getByTestId('journal-prices').locator('[data-part="exit"] dd'), t.exit, `${t.id} exit`);
}

async function checkExcursion(detail, want) {
  const box = detail.getByTestId('journal-excursion');
  await expect(box).toHaveAttribute('data-complete', 'true');
  for (const part of ['mae', 'mfe']) {
    const line = box.locator(`[data-part="${part}"]`);
    for (const k of ['price', 'perUnit', 'usd', 'pct']) {
      const attr = { price: 'data-price', perUnit: 'data-per-unit', usd: 'data-usd', pct: 'data-pct' }[k];
      await expect
        .poll(async () => sameDecimal(await line.getAttribute(attr), want[part][k]), { message: `${part} ${k}: ${want[part][k]}` })
        .toBe(true);
    }
    await expect(line).toContainText(`${want[part].pct}%`);
  }
}

async function checkR(detail, want) {
  const box = detail.getByTestId('journal-r');
  await shows(box.locator('[data-part="stop"] dd'), STOP, 'the stop it opened with');
  await shows(box.locator('[data-part="risk"] dd'), want.risk, '1R');
  await expect(box.locator('[data-part="r"] dd')).toHaveText(`${want.r}R`);
}

test(`${J} #1 opens Journal: every closed perp trade, one row per round trip from open to flat, with market, side, entry, exit, size and net result, each part as the venue reports it`, async ({
  page,
  browser,
  stepPicture,
}) => {
  test.setTimeout(600_000);
  await startsLine(browser);
  const s = state();
  await openJournal(page, s);
  const room = page.getByTestId('money-journal');
  const { B, A, CL, CS } = s.trades;
  // Newest closed first: the flip's short, then its long and A, then B; D is still open and has no row.
  const rows = room.getByTestId('journal-row');
  await expect(rows).toHaveCount(4, { timeout: 30_000 });
  const order = await rows.evaluateAll((list) => list.map((r) => r.getAttribute('data-trade')));
  expect(order[0]).toBe(CS.id);
  expect(new Set(order)).toEqual(new Set([B.id, A.id, CL.id, CS.id]));
  expect(order.indexOf(B.id)).toBe(3);
  for (const t of [B, A, CL, CS]) await checkRow(page, t);
  // The person wrote nothing: the journal asks for nothing, and every row was kept by the journal itself.
  await expect(room.getByRole('textbox')).toHaveCount(0);
  const storedAt = await rowOf(page, A).getAttribute('data-stored-at');
  expect(Date.parse(storedAt)).toBeGreaterThan(Date.parse(A.closedAt));
  for (const t of [B, A, CL, CS]) await expect(rowOf(page, t)).toHaveAttribute('data-source', 'venue');
  await expect(room.getByTestId('venue-test').first()).toHaveText('TEST');
  run.write({ storedAt });
  await stepPicture();
});

test(`${J} #2 opens the trade scaled into and closed in two parts: its fills with time, price, size and fee; entry and exit as size-weighted averages; both closes in one trade`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const s = state();
  await openJournal(page, s);
  const { A } = s.trades;
  const detail = await openTrade(page, A);
  await checkFills(detail, A);
  // Two opening fills and both closing fills in the one trade, its largest size the two opens together.
  expect(A.fills.filter((f) => f.opening)).toHaveLength(2);
  expect(A.fills.filter((f) => !f.opening)).toHaveLength(2);
  await shows(detail.getByTestId('journal-prices').locator('[data-part="size"] dd'), '0.2', 'largest size');
  // The size-weighted averages, worked here: (100.1 + 98.1) / 2 and (102.9 + 103.9) / 2 at the venue's own prices.
  expect(sameDecimal(A.entry, fromUnits(div(sum(A.fills.filter((f) => f.opening).map((f) => toUnits(f.price))), toUnits('2'))))).toBe(true);
  for (const [part, want] of [
    ['realised', A.realised],
    ['venue-fee', A.venueFees],
    ['builder-fee', A.builderFees],
    ['funding', A.funding],
    ['net', A.net],
  ])
    await shows(detail.getByTestId('journal-result').locator(`[data-part="${part}"] dd`), want, `A ${part}`);
  await stepPicture();
});

test(`${J} #3 reads its MAE and MFE: how far the price went against and for the trade, in price, dollars and percent, from the venue's 1-minute candles; missing candles read "incomplete"`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const s = state();
  await openJournal(page, s);
  const { A, B } = s.trades;
  // Where the venue's candles are missing (B's minute is past the history it keeps): "incomplete", never a figure.
  const b = await openTrade(page, B);
  const missing = b.getByTestId('journal-excursion');
  await expect(missing).toHaveAttribute('data-complete', 'false');
  for (const part of ['mae', 'mfe']) await expect(missing.locator(`[data-part="${part}"] dd`)).toHaveText('incomplete');
  const detail = await openTrade(page, A);
  await checkExcursion(detail, s.excursion.A);
  await expect(detail.getByTestId('journal-excursion')).toContainText('1-minute candles');
  await stepPicture();
});

test(`${J} #4 reads its planned and actual R: 1R as entry to the stop it opened with times its largest size, actual R as net over 1R; with no stop, "no R: no stop when opened"`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const s = state();
  await openJournal(page, s);
  const { A, B } = s.trades;
  const b = await openTrade(page, B);
  await expect(b.getByTestId('journal-r').locator('[data-part="r"] dd')).toHaveText('no R: no stop when opened');
  await expect(b.getByTestId('journal-r').locator('[data-part="risk"]')).toHaveCount(0);
  const detail = await openTrade(page, A);
  await checkR(detail, s.r);
  await stepPicture();
});

test(`${J} #5 opens the long one fill turned short: two trades, the long closed and the short opened at the same time, the fill and its fee split between them by size`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const s = state();
  await openJournal(page, s);
  const { CL, CS } = s.trades;
  const flip = s.trades.CS.fills[0];
  expect(CL.closedAt).toBe(CS.openedAt);
  await checkRow(page, CL);
  await checkRow(page, CS);
  const long = await openTrade(page, CL);
  await checkFills(long, CL);
  const longPart = long.locator(`[data-testid="journal-fill"][data-fill="${flip.fillId}"]`);
  await expect(longPart.locator('[data-cell="part"]')).toHaveAttribute('data-split', 'true');
  const short = await openTrade(page, CS);
  await checkFills(short, CS);
  // The one fill's size and fees, split 0.1 to the long and 0.2 to the short, add back to the venue's fill.
  const [venueFill] = (await venueRecord(s.owner, '/fills', { since: s.since })).value.filter((f) => f.fillId === flip.fillId);
  const closePart = CL.fills.find((f) => f.fillId === flip.fillId);
  for (const k of ['amount', 'venueFee', 'builderFee'])
    expect(fromUnits(toUnits(closePart[k]) + toUnits(flip[k]))).toBe(fromUnits(toUnits(venueFill[k])));
  expect([closePart.amount, flip.amount]).toEqual(['0.1', '0.2']);
  await stepPicture();
});

test(`${J} #6 closes another TEST position on the desk, then opens Journal: one new row for it, with no entry by the person`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(300_000);
  const s = state();
  await openVenueDesk(page, s.account, DESK, s.walletKey);
  await expect(page.getByTestId('venue-contract-strip').getByRole('heading')).toContainText(SYMBOL, { timeout: 20_000 });
  const row = page.getByTestId('venue-positions').locator(`tr[data-symbol="${SYMBOL}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  const close = row.getByTestId('venue-close');
  await close.getByRole('textbox').fill('100');
  await close.getByRole('button', { name: 'Close 100%', exact: true }).click();
  await continueInWallet(page);
  await expect(close).toHaveCount(0, { timeout: 20_000 });
  await expect
    .poll(async () => (await venueRecord(s.owner, '/positions')).value.filter((p) => p.symbol === SYMBOL), { timeout: 20_000 })
    .toEqual([]);
  const { fills } = await venueNow(s.owner, s.since);
  const open = fills.find((f) => f.fillId === s.dFill);
  const closing = fills.filter((f) => Date.parse(f.filledAt) > Date.parse(open.filledAt));
  expect(closing.length).toBeGreaterThan(0);
  const D = expected(
    open.fillId,
    'long',
    [[open, '0.1']],
    closing.map((f) => [f, f.amount]),
    '0.1',
  );
  withNet(D, 0n);

  await openJournal(page, s, { fresh: false });
  const rows = page.getByTestId('journal-row');
  await expect(rows).toHaveCount(5, { timeout: 30_000 });
  await expect(rows.first()).toHaveAttribute('data-trade', D.id);
  await checkRow(page, D);
  await expect(page.getByTestId('money-journal').getByRole('textbox')).toHaveCount(0);
  run.write({ trades: { ...s.trades, D } });
  await stepPicture();
});

test(`${J} #7 opens a trade after the venue stops returning its fills and candles (TEST switch): the same trade, fills, MAE, MFE and R, from the journal's own record, with the time it was stored`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  const s = state();
  const now = new Date().toISOString();
  expect((await testVenue('/test/history-kept', { symbol: SYMBOL, fillsFrom: now, candlesFrom: now })).status).toBe(200);
  const gone = await venueNow(s.owner, s.since);
  expect(gone.fills).toEqual([]);
  expect(gone.candles).toEqual([]);

  await openJournal(page, s);
  const { A } = s.trades;
  await expect(page.getByTestId('journal-row')).toHaveCount(5, { timeout: 30_000 });
  await expect(rowOf(page, A)).toHaveAttribute('data-source', 'record', { timeout: 30_000 });
  await checkRow(page, A);
  const detail = await openTrade(page, A);
  await expect(detail).toHaveAttribute('data-source', 'record');
  await checkFills(detail, A);
  await checkExcursion(detail, s.excursion.A);
  await checkR(detail, s.r);
  const source = detail.getByTestId('journal-source');
  await expect(source).toContainText('From your journal’s own record, stored at');
  await expect(source).toContainText('The venue no longer returns this trade’s fills and candles.');
  await expect(source).toHaveAttribute('data-stored-at', s.storedAt);
  await stepPicture();
});
