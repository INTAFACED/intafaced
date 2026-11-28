// World: book, restart
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { api, fromUnits, journeyState, toUnits } from './stack.mjs';
import { signUp, verify } from './desk.mjs';
import { testWalletKey } from './test-wallet.mjs';
import {
  doorOk,
  openVenuePage,
  otherTraderKey,
  otherTraderRun,
  testDeposit,
  testVenue,
  venueForThisFile,
  venueRecord,
  venueRunState,
  walletDoorAct,
} from './venue.mjs';

// J-portfolio-19, in the running app on the launch model: "I see what my trading made beside what it would have made
// had I kept my own rules". The person's closed TEST perp trades are on their own venue account on the TEST venue
// simulator, on the TEST perpetual XJRN-PERP that only this file trades (no makers' ladder, its mark fixed by its TEST
// oracle, so every fill and print on it is one made here at a price chosen here, and no stop fires by itself). The
// Starts line, as TEST setup through our door, signed by the person's wallet:
//   the daily loss limit of J-derivatives-35 set first, to "Warn me" at TEST 3 USDC;
//   KEPT     long 1 @ 100, stop 95 kept, sold @ 102;
//   WON      long 1 @ 100, stop 95 widened to 90, a TEST print at 94 (past the first stop), sold @ 103;
//   LOST     long 1 @ 100, stop 95 widened to 90, sold @ 90.5: more than 1R lost; today's loss is now past 3 USDC;
//   WARNED   long 1 @ 100 opened while the limit stood reached (the door warned on it), stop 95 kept, sold @ 101.
// Each step's figures are worked here from the venue's own fills (`/fills`), never from the page or the journal's code:
// 1R = |entry − first stop| × size; a widened stop past its first stop counts minus 1R less the trade's fees; the
// warned trade counts 0; the kept one what it made. One test per step, titled "J-portfolio-19 #<n>". Every figure is TEST.
const J = 'J-portfolio-19';
const SYMBOL = 'XJRN-PERP';
const FIRST_STOP = '95';
const WIDENED_STOP = '90';
const LIMIT = '3';
const runId = process.env.JOURNEY_RUN_ID ?? 'local';
const run = journeyState(`${J}-${runId}`);

test.describe.configure({ mode: 'default' });
venueForThisFile(test);

const tag = () => randomBytes(4).toString('hex');
const sum = (xs) => xs.reduce((a, b) => a + b, 0n);
const usdc = (units) => `${fromUnits(units)} USDC`;
/** A venue decimal as the page writes it: no trailing zeros. */
const plain = (decimal) => fromUnits(toUnits(decimal));

/**
 * The makers: two TEST other traders, each resting one order on XJRN-PERP for the person to take at the price chosen.
 * One rests every ask and one every bid, so each only ever opens (the TEST venue rests no reduce-only order).
 */
const MAKERS = { sell: `${J}-${runId}-asks`, buy: `${J}-${runId}-bids` };
async function makerRests(side, price) {
  const name = MAKERS[side];
  const owner = otherTraderKey(name).address.toLowerCase();
  const rested = await otherTraderRun(name, {
    kind: 'place_order',
    symbol: SYMBOL,
    side,
    type: 'limit',
    amount: '1',
    price,
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${owner}:jpf19:${tag()}`,
    builderFee: null,
  });
  expect(rested.definite && rested.accepted, JSON.stringify(rested)).toBe(true);
}

/** TEST setup, not a step (the Starts line): the person, their limit and their four closed trades. */
test.beforeAll(async ({ browser }) => {
  if (process.env.JOURNEY_RUN_ID && run.read().account) return;
  test.setTimeout(300_000);
  const page = await browser.newPage();
  try {
    const account = await signUp(page, 'pf19');
    await verify(page, account);
    const walletKey = testWalletKey();
    const key = privateKeyToAccount(walletKey);
    const owner = key.address.toLowerCase();
    const session = await api(account);
    const act = (intent, actionKey = null) => walletDoorAct(session, key, { intent, actionKey });

    expect(await testDeposit(owner, 'USDC', '1000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    for (const name of Object.values(MAKERS)) {
      const maker = otherTraderKey(name).address.toLowerCase();
      expect(await testDeposit(maker, 'USDC', '100000', `84532:0x${randomBytes(32).toString('hex')}:0`)).toBe(true);
    }
    const leverage = { kind: 'update_leverage', symbol: SYMBOL, leverageBps: 50_000, marginMode: 'isolated' };
    for (const name of Object.values(MAKERS))
      expect(await otherTraderRun(name, leverage)).toMatchObject({ definite: true, accepted: true });
    // A market listed a moment ago may not be in the door's list yet: the same action, under the same key, is asked
    // again until the door takes it.
    await expect(() => act(leverage, `leverage:${owner}:${SYMBOL}:5x`)).toPass({ timeout: 30_000, intervals: [2_000] });
    const status = doorOk(await session.get('/api/v1/venue/status'));
    expect(status.builder, 'the TEST builder fee is set on the door').toBeTruthy();
    await act(
      { kind: 'approve_builder_fee', builder: status.builder.address, maxFeeBps: status.builder.feeBps },
      `approve-builder:${owner}:jpf19`,
    );

    // The rule set before any trade: the daily loss limit, "Warn me" (advisory), at TEST 3 USDC.
    const set = await session.post('/api/trade/trpc/dailyLoss.set', { owner, limit: LIMIT, mode: 'advisory' });
    expect(set.status, JSON.stringify(set.body).slice(0, 300)).toBe(200);
    expect(set.body.result.data).toMatchObject({ active: { mode: 'advisory', limit: LIMIT }, today: { reached: false } });

    const order = (side, price, over = {}) => ({
      kind: 'place_order',
      symbol: SYMBOL,
      side,
      type: 'limit',
      amount: '1',
      price,
      timeInForce: 'IOC',
      reduceOnly: side === 'sell',
      clientOrderKey: `order:${owner}:jpf19:${tag()}`,
      builderFee: null,
      ...over,
    });
    const stop = (trigger) =>
      order('sell', String(Number(trigger) - 1), {
        timeInForce: 'GTC',
        reduceOnly: true,
        trigger: { price: trigger, source: 'mark', role: 'stop_loss' },
      });
    const cancel = (o) => act({ kind: 'cancel_order', symbol: SYMBOL, clientOrderKey: o.clientOrderKey });
    const prepareWarnings = async (intent) => {
      const prepared = doorOk(await session.post('/api/v1/venue/prepare', { owner, signer: { role: 'owner', address: owner }, intent }));
      return prepared.warnings ?? [];
    };
    /** One round trip: open long 1 @ 100, its stop at 95 (moved to `widenTo` if given), `during` it, closed @ `exit`. */
    async function trade(name, exit, { widenTo = null, during = null } = {}) {
      await makerRests('sell', '100');
      const open = order('buy', '100');
      const warnings = await prepareWarnings(open);
      await act(open);
      const first = stop(FIRST_STOP);
      await act(first);
      let last = first;
      if (widenTo) {
        // Moved further from the entry: the first stop cancelled and a wider one placed, as the desk moves a stop.
        await cancel(first);
        last = stop(widenTo);
        await act(last);
      }
      if (during) await during();
      await makerRests('buy', exit);
      await act(order('sell', exit));
      await cancel(last);
      const position = (await venueRecord(owner, '/positions')).value.find((p) => p.symbol === SYMBOL);
      expect(position, `${name}: the position is closed on the venue`).toBeFalsy();
      return { name, warnings };
    }

    const kept = await trade('kept', '102');
    const won = await trade('won', '103', {
      widenTo: WIDENED_STOP,
      // TEST: a print at 94 on XJRN-PERP while the trade is open, past its first stop of 95 (the simulator's TEST print
      // control); its candles carry it.
      during: async () => {
        const seeded = await testVenue('/test/seed-prints', {
          symbol: SYMBOL,
          entries: [{ tradedAt: new Date().toISOString(), price: '94', amount: '0.1', takerSide: 'sell' }],
        });
        expect(seeded.status, JSON.stringify(seeded.body)).toBe(200);
      },
    });
    const lost = await trade('lost', '90.5', { widenTo: WIDENED_STOP });
    const view = await session.get(`/api/trade/trpc/dailyLoss.get?input=${encodeURIComponent(JSON.stringify({ owner }))}`);
    expect(view.status, JSON.stringify(view.body).slice(0, 300)).toBe(200);
    const today = view.body.result.data.today;
    expect(today.reached, `today's loss ${today.loss} reached the TEST limit of ${LIMIT}`).toBe(true);
    const warned = await trade('warned', '101');
    // Only the opening order placed past the limit was warned; the three before it were not.
    expect([kept, won, lost].map((t) => t.warnings)).toEqual([[], [], []]);
    expect(warned.warnings).toEqual([expect.objectContaining({ code: 'trade.daily_loss_limit_reached', limit: LIMIT, asset: 'USDC' })]);
    run.reset({ account, walletKey, warning: warned.warnings[0] });
  } finally {
    await page.close();
  }
});

const state = () => venueRunState(run, J);

/**
 * The four trades, worked from the venue's own fills on XJRN-PERP, oldest first (each trade is one opening and one
 * closing fill): entry, exit, fees, net, 1R, and what each counts keeping the person's rules.
 */
async function trades(owner) {
  const fills = (await venueRecord(owner, '/fills', { since: new Date(Date.now() - 86_400_000).toISOString() })).value
    .filter((f) => f.symbol === SYMBOL)
    .sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt));
  expect(fills.map((f) => f.side)).toEqual(['buy', 'sell', 'buy', 'sell', 'buy', 'sell', 'buy', 'sell']);
  const names = ['kept', 'won', 'lost', 'warned'];
  const out = {};
  for (const [i, name] of names.entries()) {
    const [open, close] = [fills[2 * i], fills[2 * i + 1]];
    const fees = sum([open, close].map((f) => toUnits(f.venueFee) + toUnits(f.builderFee)));
    const gross = toUnits(close.price) - toUnits(open.price);
    const net = gross - fees;
    const oneR = toUnits(open.price) - toUnits(FIRST_STOP);
    const rules = name === 'warned' ? 0n : name === 'kept' ? net : -oneR - fees;
    out[name] = { open, close, fees, net, oneR, rules, realised: sum([open, close].map((f) => toUnits(f.realisedPnl ?? '0'))) };
  }
  return out;
}

async function openEquity(page) {
  const { account, walletKey } = state();
  await openVenuePage(page, account, '/trade/journal', walletKey);
  await page.getByRole('tab', { name: 'Equity', exact: true }).click();
  const equity = page.getByTestId('journal-equity');
  await expect(equity).toBeVisible({ timeout: 30_000 });
  return equity;
}

async function openPoint(page, equity, trade) {
  const row = equity.locator(`tr[data-point="${trade.open.fillId}"]`);
  await row.getByRole('button', { name: 'Open', exact: true }).click();
  const point = page.getByTestId('equity-point');
  await expect(point).toHaveAttribute('data-trade', trade.open.fillId);
  return { row, point };
}

const figure = (point, key) => point.locator(`[data-figure="${key}"] dd`);

test(`${J} #1 opens Journal, Equity: two lines over time, "What I made" and "Keeping my rules", and the dollar gap between them at the end, from the journal's trades`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const { owner } = state();
  const t = await trades(owner);
  const all = [t.kept, t.won, t.lost, t.warned];
  const made = sum(all.map((x) => x.net));
  const rules = sum(all.map((x) => x.rules));
  const equity = await openEquity(page);

  // Two lines over the same four trades, each named.
  const chart = equity.getByTestId('equity-chart');
  await expect(chart.locator('svg')).toHaveAttribute('data-points', '4');
  for (const line of ['made', 'rules']) {
    const points = await chart.locator(`[data-line="${line}"] polyline`).getAttribute('points');
    expect(points.trim().split(/\s+/)).toHaveLength(4);
  }
  await expect(equity.getByTestId('equity-legend-made')).toHaveText('What I made');
  await expect(equity.getByTestId('equity-legend-rules')).toHaveText('Keeping my rules');

  // Each point, oldest first, is the running total of the venue's own results on each line.
  let runMade = 0n;
  let runRules = 0n;
  const rows = equity.locator('tbody tr');
  await expect(rows).toHaveCount(4);
  for (const [i, x] of all.entries()) {
    runMade += x.net;
    runRules += x.rules;
    const row = rows.nth(i);
    await expect(row).toHaveAttribute('data-point', x.open.fillId);
    await expect(row.locator('td').nth(2)).toHaveText(usdc(runMade));
    await expect(row.locator('td').nth(3)).toHaveText(usdc(runRules));
  }

  // The ends of both lines, and the dollar gap between them.
  await expect(equity.getByTestId('equity-end-made')).toHaveText(`What I made: ${usdc(made)}`);
  await expect(equity.getByTestId('equity-end-rules')).toHaveText(`Keeping my rules: ${usdc(rules)}`);
  await expect(equity.getByTestId('equity-gap').locator('strong')).toHaveText(`Gap at the end: ${usdc(rules - made)}`);
  await expect(equity.getByTestId('equity-gap')).toContainText('Keeping my rules less what I made, over the same 4 trades.');
  await expect(page.getByTestId('journal-as-of')).toContainText('TEST');
  await stepPicture();
});

test(`${J} #2 opens the point of the trade whose stop was widened and lost more than 1R: "Capped at your first stop", minus 1R less its fees on the rules line, with the figures shown`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const { owner } = state();
  const { lost } = await trades(owner);
  // More than 1R lost: worse than minus 1R less its fees.
  expect(lost.net < -lost.oneR - lost.fees).toBe(true);
  const equity = await openEquity(page);
  const { point } = await openPoint(page, equity, lost);
  await expect(point.getByTestId('equity-point-verdict')).toHaveText('Capped at your first stop');
  await expect(point.getByTestId('equity-point-why')).toHaveText(
    `On the rules line it counts as minus 1R less its fees: −${fromUnits(lost.oneR)} − ${fromUnits(lost.fees)} = ${usdc(lost.rules)}. ` +
      `It made ${usdc(lost.net)}, losing more than 1R after its stop was moved from ${FIRST_STOP} to ${WIDENED_STOP}.`,
  );
  await expect(figure(point, 'entry')).toHaveText(plain(lost.open.price));
  await expect(figure(point, 'exit')).toHaveText(plain(lost.close.price));
  await expect(figure(point, 'first-stop')).toHaveText(FIRST_STOP);
  await expect(figure(point, 'widened')).toHaveText(WIDENED_STOP);
  await expect(figure(point, 'one-r')).toHaveText(usdc(lost.oneR));
  await expect(figure(point, 'fees')).toHaveText(usdc(lost.fees));
  await expect(figure(point, 'net')).toHaveText(usdc(lost.net));
  await expect(figure(point, 'rules')).toHaveText(usdc(lost.rules));
  await stepPicture();
});

test(`${J} #3 opens the point of the trade whose widened stop won after its price crossed the first stop: "Stopped at your first stop", minus 1R less its fees, not its profit`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const { owner } = state();
  const { won } = await trades(owner);
  expect(won.net > 0n).toBe(true);
  // The price crossed the first stop while it was open: the venue's own 1m candles over its window reach below 95.
  const opened = Date.parse(won.open.filledAt);
  const closed = Date.parse(won.close.filledAt);
  const candles = await testVenue('/candles', { symbol: SYMBOL, interval: '1m', limit: 30 });
  expect(candles.status, JSON.stringify(candles.body).slice(0, 300)).toBe(200);
  const window = candles.body.value.filter((c) => Date.parse(c.openAt) + 60_000 > opened && Date.parse(c.openAt) <= closed);
  expect(window.some((c) => toUnits(c.lowPrice) <= toUnits(FIRST_STOP))).toBe(true);
  const equity = await openEquity(page);
  const { point } = await openPoint(page, equity, won);
  await expect(point.getByTestId('equity-point-verdict')).toHaveText('Stopped at your first stop');
  await expect(point.getByTestId('equity-point-why')).toHaveText(
    `On the rules line it counts as minus 1R less its fees: −${fromUnits(won.oneR)} − ${fromUnits(won.fees)} = ${usdc(won.rules)}, ` +
      `not its profit of ${usdc(won.net)}. Its price crossed the first stop of ${FIRST_STOP} after the stop was moved to ${WIDENED_STOP}.`,
  );
  await expect(figure(point, 'net')).toHaveText(usdc(won.net));
  await expect(figure(point, 'rules')).toHaveText(usdc(won.rules));
  await stepPicture();
});

test(`${J} #4 opens the point of the trade opened while the daily loss limit stood reached: "Left out: opened past your daily loss limit"; it counts 0 on the rules line`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const { owner, warning } = state();
  const t = await trades(owner);
  // The loss the venue's fills came to when it was placed: the three trades before it, realised less every fee.
  const lossThen = -(sum([t.kept, t.won, t.lost].map((x) => x.realised)) - sum([t.kept, t.won, t.lost].map((x) => x.fees)));
  expect(lossThen >= toUnits(LIMIT)).toBe(true);
  expect(toUnits(warning.loss)).toBe(lossThen);
  const equity = await openEquity(page);
  const { row, point } = await openPoint(page, equity, t.warned);
  await expect(point.getByTestId('equity-point-verdict')).toHaveText('Left out: opened past your daily loss limit');
  await expect(point.getByTestId('equity-point-why')).toContainText(`It counts 0 on the rules line, not its ${usdc(t.warned.net)}.`);
  await expect(point.getByTestId('equity-point-why')).toContainText(
    `your daily loss limit set to warn stood reached: ${usdc(lossThen)} lost today against your limit of ${LIMIT} USDC`,
  );
  await expect(figure(point, 'rules')).toHaveText('0 USDC');
  await expect(figure(point, 'limit')).toHaveText(`${LIMIT} USDC`);
  await expect(figure(point, 'loss')).toHaveText(usdc(lossThen));
  // On the line itself: the rules total does not move at this point; what was made does.
  const before = sum([t.kept, t.won, t.lost].map((x) => x.rules));
  await expect(row.locator('td').nth(3)).toHaveText(usdc(before));
  await expect(row.locator('td').nth(4)).toHaveText('Left out: opened past your daily loss limit');
  await stepPicture();
});

test(`${J} #5 opens the point of a trade that kept its stop and limit: the same result on both lines, "kept your rules"`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(180_000);
  const { owner } = state();
  const { kept } = await trades(owner);
  const equity = await openEquity(page);
  const { row, point } = await openPoint(page, equity, kept);
  await expect(point.getByTestId('equity-point-verdict')).toHaveText('Kept your rules');
  await expect(point.getByTestId('equity-point-why')).toHaveText(
    `The same result on both lines, ${usdc(kept.net)}: it kept its stop and your daily loss limit.`,
  );
  await expect(figure(point, 'net')).toHaveText(usdc(kept.net));
  await expect(figure(point, 'rules')).toHaveText(usdc(kept.net));
  // The first point: both lines start from the same result.
  await expect(row.locator('td').nth(2)).toHaveText(usdc(kept.net));
  await expect(row.locator('td').nth(3)).toHaveText(usdc(kept.net));
  await stepPicture();
});
