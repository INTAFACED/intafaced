// World: book, gates, restart
import { test, expect } from './journey.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { EDGE, ORIGIN, api, journeyState, signOutBrowser, stackFile, toUnits, fromUnits, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';

// J-derivatives-08, in the running app (docs/roadmap/journeys.json): I see the funding rate and what I paid or received.
// One test per step, titled "J-derivatives-08 #<n>", on two TEST accounts funded with TEST USDT: A holds a long and B a
// short on the TEST perpetual `local-test-gates.mjs futures` lists, open through funding periods.
//
// The stack stands in for both outside rails the journey names, labelled TEST: svc-trade restarts with its funding jobs
// on for the TEST perpetual only (LOCAL_STACK_TRADE_FUNDING_MARKET, tooling/scripts/local-stack-services/trade.mjs) and
// with the TEST index feed (`feed.market`'s stand-in: the TEST spot book the perpetual is marked from, one source), and
// the two TEST operators publish the funding numbers and the index source list through svc-trade's four-eyes doors, as
// operators would (`owner.decision`'s stand-in). Every number this file checks is the service's own answer, read back.
//
// The file runs #1, #3, #4, #5, #2, #6: #2 unpublishes the index, so it follows the steps that need one, and #6 reads the
// history #2 leaves (a null index with its reason). When the file ends, the funding numbers go blank again and svc-trade
// restarts as the stack starts it, so no other journey's positions pay or receive funding.
const J = 'J-derivatives-08';
const DESK = '/trade/futures';
const SYMBOL = 'BTC/USDT:USDT';
const SIZE = '0.01';
const LEVERAGE = '5';
// LOCAL TEST funding numbers, not owner decisions: a 90 s period on a fixed grid (each period is seen by the 60 s funding
// tick at least once), a sample every 3 s, nothing trimmed, three samples at least, and a cap far above the base.
const TEST_ANCHOR = '2026-01-01T00:00:00.000Z';
const TEST_PARAMS = {
  baseComponent: '0.0001',
  cap: '0.003',
  cadenceSeconds: 3,
  trimRatioBps: 0,
  minSamples: 3,
  periodSeconds: 90,
  periodAnchor: TEST_ANCHOR,
};
const NEGATIVE_BASE = '-0.0002';
const TEST_SOURCE = 'test:spot-book';
const TEST_INDEX = {
  sources: [{ sourceId: TEST_SOURCE, weight: 1, enabled: true }],
  params: { minSources: 1, outlierBandBps: 500, maxAgeSeconds: 30 },
};
const BLANK_INDEX = {
  sources: [{ sourceId: TEST_SOURCE, weight: 1, enabled: true }],
  params: { minSources: null, outlierBandBps: null, maxAgeSeconds: null },
};
const BLANK_PARAMS = Object.fromEntries(Object.keys(TEST_PARAMS).map((k) => [k, null]));
const SETTLE_MS = 240_000;
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const enc = encodeURIComponent(SYMBOL);

test.describe.configure({ mode: 'default' });

function state(key) {
  const value = run.read()[key];
  if (value === undefined) throw new Error(`${J}: an earlier step left no ${key}, so this step has nothing to act on`);
  return value;
}

async function until(read, ok, what, ms = 30_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${what}: still ${JSON.stringify(last)?.slice(0, 1500)}`);
}

/** A public read, signed out, through Edge. */
async function publicGet(route) {
  const res = await fetch(`${EDGE}${route}`, { headers: { origin: ORIGIN } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// ── The TEST owner numbers, through svc-trade's four-eyes doors ───────────────

let gatesCtx = null;
async function operators() {
  if (!gatesCtx) {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    gatesCtx = { gates, ctx, sessions: await gates.approverSessions(ctx) };
  }
  return gatesCtx;
}

async function publishParams(marketId, params) {
  const { gates, ctx, sessions } = await operators();
  return gates.setFundingParams(ctx, marketId, params, { sessions, reason: `${J}: LOCAL TEST funding numbers` });
}

async function publishIndex(marketId, config) {
  const { gates, ctx, sessions } = await operators();
  return gates.setIndexSources(ctx, marketId, config, { sessions, reason: `${J}: LOCAL TEST index source list` });
}

/** svc-trade restarted with its funding jobs on for `marketId` only, or (null) as the stack starts it. */
function tradeFunding(marketId) {
  const before = process.env.LOCAL_STACK_TRADE_FUNDING_MARKET;
  if (marketId) process.env.LOCAL_STACK_TRADE_FUNDING_MARKET = marketId;
  else delete process.env.LOCAL_STACK_TRADE_FUNDING_MARKET;
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_TRADE_FUNDING_MARKET;
    else process.env.LOCAL_STACK_TRADE_FUNDING_MARKET = before;
  }
}

// A failed step keeps svc-trade's funding lines (the computer's and the tick's) with its results, since a tick's error
// reaches only the service log.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  try {
    const lines = readFileSync(stackFile('logs/trade.log'), 'utf8')
      .split('\n')
      .filter((line) => /funding/i.test(line))
      .slice(-300);
    writeFileSync(testInfo.outputPath('svc-trade-funding.log'), lines.join('\n'));
  } catch (error) {
    writeFileSync(testInfo.outputPath('svc-trade-funding.log'), `could not read the svc-trade log: ${error}`);
  }
});

test.afterAll(async () => {
  const marketId = run.read().marketId;
  if (!marketId) return;
  // Put back what the file changed: blank funding numbers, then svc-trade as the stack starts it.
  try {
    await publishParams(marketId, BLANK_PARAMS);
  } finally {
    tradeFunding(null);
  }
});

// ── Positions and reads ──────────────────────────────────────────────────────

async function openPosition(me, side) {
  const preview = await me.post('/api/v1/positions/preview', { symbol: SYMBOL, side, size: SIZE, leverage: LEVERAGE });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const placed = await me.post('/api/v1/futures/orders', {
    symbol: SYMBOL,
    side: side === 'long' ? 'buy' : 'sell',
    type: 'market',
    amount: SIZE,
    leverage: LEVERAGE,
    marginMode: 'isolated',
    confirmTier: preview.body.riskTier?.projected,
    clientOrderId: `${J}-${side}-${Date.now()}`,
  });
  expect(placed.status, JSON.stringify(placed.body)).toBeLessThan(300);
  const list = await until(
    async () => (await me.get('/api/v1/positions')).body,
    (rows) =>
      Array.isArray(rows) && rows.some((p) => p.symbol === SYMBOL && p.side === side && p.status === 'open' && p.contracts === SIZE),
    `the TEST ${side}`,
  );
  return list.find((p) => p.symbol === SYMBOL && p.side === side && p.status === 'open');
}

async function payments(me, positionId) {
  const res = await me.get(`/api/v1/positions/${positionId}/funding-payments`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.payments;
}

async function statement(me) {
  const res = await me.get('/api/v1/futures/funding-statement');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

const signed = (row) => (row.direction === 'paid' ? -toUnits(row.amount) : toUnits(row.amount));
const sum = (rows) => rows.reduce((a, r) => a + signed(r), 0n);

async function fundingRate() {
  const res = await publicGet(`/api/v1/funding-rate/${enc}`);
  return res;
}

async function history() {
  return publicGet(`/api/v1/funding-history/${enc}`);
}

/** The published period `periodId` once the tick has settled it: its public history row, with the settlement. */
async function settledRow(periodId, what) {
  return until(
    async () => (await history()).body?.rates?.find((r) => r.periodId === periodId) ?? null,
    (row) => row?.settlement != null,
    what,
    SETTLE_MS,
  );
}

// ── What the room draws ──────────────────────────────────────────────────────

/** An exact decimal as the room draws it: thousands grouped, trailing zeros dropped, nothing rounded, a true minus. */
function exact(decimal) {
  const negative = decimal.startsWith('-');
  let [whole, frac = ''] = decimal.replace(/^-/, '').split('.');
  frac = frac.replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

/** A rate as an exact percent: the decimal times 100, not a digit lost. */
function pct(decimal) {
  const units = toUnits(decimal) * 100n;
  return `${exact(fromUnits(units))}%`;
}

function valueOf(scope, label) {
  return scope
    .locator('[data-slot="key-value-row"]')
    .filter({ has: scope.page().locator('dt', { hasText: new RegExp(`^${label}$`) }) })
    .locator('dd');
}

async function fundingTab(page, who) {
  await signIn(page, who);
  await page.goto(DESK);
  await page.getByRole('tab', { name: 'Funding' }).click();
  const tab = page.getByRole('region', { name: 'Funding', exact: true });
  await expect(tab).toBeVisible();
  return tab;
}

// ── Steps ────────────────────────────────────────────────────────────────────

test(`${J} #1 reads the contract strip and Funding tab: rate, countdown, premium, interest component, cap, mark and index`, async ({
  page,
}) => {
  test.setTimeout(SETTLE_MS + 240_000);
  const markets = await publicGet('/api/v1/markets?limit=500');
  const market = markets.body.find((m) => m.symbol === SYMBOL);
  expect(market?.id, 'the TEST perpetual is listed').toBeTruthy();
  run.reset({ marketId: market.id });

  tradeFunding(market.id);
  await publishIndex(market.id, TEST_INDEX);
  const params = await publishParams(market.id, TEST_PARAMS);
  expect(params.params).toMatchObject(TEST_PARAMS);

  const short = await fundedTrader(page, 'jd8s', '1000');
  await signOutBrowser(page.context());
  const long = await fundedTrader(page, 'jd8l', '1000');
  const a = await api(long);
  const b = await api(short);
  const longPos = await openPosition(a, 'long');
  const shortPos = await openPosition(b, 'short');
  // The ledger as it stands once both are open, with whatever funding each already shows, so #5 can compare.
  const [aBal, bBal, aPaid, bPaid] = await Promise.all([a.balances(), b.balances(), payments(a, longPos.id), payments(b, shortPos.id)]);
  run.write({
    long,
    short,
    longId: longPos.id,
    shortId: shortPos.id,
    base: { a: aBal.USDT.total, b: bBal.USDT.total, aRows: aPaid.length, bRows: bPaid.length },
  });

  // A period closes on the TEST grid and the service publishes its rate with every input.
  const published = await until(
    fundingRate,
    (r) => r.status === 200 && r.body.periodId != null && r.body.interestComponent === TEST_PARAMS.baseComponent,
    'a published funding period',
    SETTLE_MS,
  );
  const f = published.body;
  for (const field of [
    'fundingRate',
    'premium',
    'interestComponent',
    'cap',
    'markPrice',
    'indexPrice',
    'periodMarkPrice',
    'periodIndexPrice',
  ]) {
    expect(f[field], field).toMatch(/^-?\d+(\.\d+)?$/);
  }
  expect(f.cap).toBe(TEST_PARAMS.cap);
  // The rate is the premium plus the interest component, held inside the cap: to the last digit.
  const raw = toUnits(f.premium) + toUnits(f.interestComponent);
  const cap = toUnits(f.cap);
  const clamped = raw > cap ? cap : raw < -cap ? -cap : raw;
  expect(toUnits(f.fundingRate)).toBe(clamped);
  expect(f.clamped).toBe(clamped !== raw);
  // The countdown counts to the end of the period open now, a boundary of the TEST grid, within one period from now.
  expect((f.nextFundingTimestamp - Date.parse(TEST_ANCHOR)) % (TEST_PARAMS.periodSeconds * 1000)).toBe(0);
  expect(f.nextFundingTimestamp).toBeGreaterThan(Date.parse(f.periodEnd));
  expect(f.nextFundingTimestamp - Date.now()).toBeLessThanOrEqual(TEST_PARAMS.periodSeconds * 1000 + 5_000);
  expect(f.indexNow).toMatchObject({ reason: null });
  expect(f.indexNow.price).toMatch(/^\d+(\.\d+)?$/);
  // CCXT's indexPrice is the index now; what the rate was built from is the period's closing sample.
  expect(f.indexPrice).toBe(f.indexNow.price);

  // The room: the strip names the rate and the countdown; the Funding tab names every input, as the service gave them.
  const tab = await fundingTab(page, long);
  const strip = page.getByRole('region', { name: SYMBOL, exact: true });
  await expect(strip).toContainText('Funding rate');
  await expect(strip).toContainText('Next funding');
  await expect(strip).toContainText(/in \d/);
  const shown = await until(
    async () => {
      const now = (await fundingRate()).body;
      const drawn = {};
      for (const label of [
        'Current rate',
        'Premium',
        'Interest component',
        'Rate cap',
        'Mark at period close',
        'Index at period close',
        'Time to next funding',
      ]) {
        drawn[label] = (await valueOf(tab, label).innerText()).trim();
      }
      return { now, drawn };
    },
    ({ now, drawn }) =>
      drawn['Current rate'] === pct(now.fundingRate) &&
      drawn.Premium === pct(now.premium) &&
      drawn['Interest component'] === pct(now.interestComponent) &&
      drawn['Rate cap'] === pct(now.cap) &&
      drawn['Mark at period close'] === exact(now.periodMarkPrice) &&
      drawn['Index at period close'] === exact(now.periodIndexPrice),
    'the Funding tab drawn from the published period',
    90_000,
  );
  expect(shown.drawn['Time to next funding']).toMatch(/\d/);
});

test(`${J} #3 a period closes: one funding payment per position in the payments list, with its period key`, async ({ page }) => {
  test.setTimeout(SETTLE_MS * 2 + 60_000);
  const a = await api(state('long'));
  const b = await api(state('short'));
  const longId = state('longId');
  const shortId = state('shortId');

  // The first period settled after both opened, with a positive rate: the long pays, the short receives.
  const rows = await until(
    async () => ({ a: await payments(a, longId), b: await payments(b, shortId) }),
    (r) => r.a.some((p) => p.direction === 'paid') && r.b.some((p) => r.a.some((q) => q.periodId === p.periodId && q.direction === 'paid')),
    'a settled period with both positions in it',
    SETTLE_MS * 2,
  );
  const paid = rows.a.find((p) => p.direction === 'paid' && rows.b.some((q) => q.periodId === p.periodId));
  const received = rows.b.find((q) => q.periodId === paid.periodId);
  expect(paid.periodId).toMatch(new RegExp(`^${state('marketId')}:\\d{4}-\\d{2}-\\d{2}T`));
  expect(received.direction).toBe('received');
  expect(toUnits(paid.rate)).toBeGreaterThan(0n);
  expect(received.rate).toBe(paid.rate);
  // One payment per position per period.
  for (const list of [rows.a, rows.b]) {
    expect(new Set(list.map((p) => p.periodId)).size).toBe(list.length);
  }
  run.write({ positivePeriod: paid.periodId });

  // The room lists it: the payments table names the period key and the amount, paid.
  const tab = await fundingTab(page, state('long'));
  const table = tab.getByRole('table', { name: 'Funding payments' });
  const row = table.getByRole('row').filter({ hasText: paid.periodId });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(SYMBOL);
  await expect(row).toContainText(exact(paid.amount));
  await expect(row).toContainText('Paid');
  await expect(row).toContainText(pct(paid.rate));
});

test(`${J} #4 checks the legs: payers and receivers net to zero, and with a negative rate the payer flips`, async ({ page }) => {
  test.setTimeout(SETTLE_MS * 3 + 60_000);
  const a = await api(state('long'));
  const b = await api(state('short'));
  const longId = state('longId');
  const shortId = state('shortId');

  // The positive period's legs: what payers paid is what receivers received, to the last digit.
  const positive = await settledRow(state('positivePeriod'), 'the positive period settled');
  expect(positive.settlement.legs).toBeGreaterThan(0);
  expect(toUnits(positive.settlement.paid)).toBeGreaterThan(0n);
  expect(positive.settlement.paid).toBe(positive.settlement.received);

  // A negative interest component, well above the premium: the next period's rate is negative.
  await publishParams(state('marketId'), { ...TEST_PARAMS, baseComponent: NEGATIVE_BASE });
  const rows = await until(
    async () => ({ a: await payments(a, longId), b: await payments(b, shortId) }),
    (r) => r.b.some((p) => p.direction === 'paid' && r.a.some((q) => q.periodId === p.periodId && q.direction === 'received')),
    'a settled period with a negative rate',
    SETTLE_MS * 2,
  );
  const shortPaid = rows.b.find((p) => p.direction === 'paid' && rows.a.some((q) => q.periodId === p.periodId));
  const longGot = rows.a.find((q) => q.periodId === shortPaid.periodId);
  expect(toUnits(shortPaid.rate)).toBeLessThan(0n);
  expect(longGot).toMatchObject({ direction: 'received', rate: shortPaid.rate });
  const negative = await settledRow(shortPaid.periodId, 'the negative period settled');
  expect(toUnits(negative.fundingRate)).toBeLessThan(0n);
  expect(negative.interestComponent).toBe(NEGATIVE_BASE);
  expect(negative.settlement.paid).toBe(negative.settlement.received);
  run.write({ negativePeriod: shortPaid.periodId });

  // The room: the long's list shows the negative period received.
  const tab = await fundingTab(page, state('long'));
  const row = tab.getByRole('table', { name: 'Funding payments' }).getByRole('row').filter({ hasText: shortPaid.periodId });
  await expect(row).toContainText('Received');
  await expect(row).toContainText(exact(longGot.amount));
});

test(`${J} #5 opens the funding statement: payments by position and period that sum to the ledger amounts`, async ({ page }) => {
  const a = await api(state('long'));
  const b = await api(state('short'));
  const base = state('base');
  const longId = state('longId');
  const shortId = state('shortId');

  // Read the statement and the ledger together until no period settles between the two reads.
  const read = async (me, id, baseTotal) => {
    const [s, bal, list] = await Promise.all([statement(me), me.balances(), payments(me, id)]);
    return { s, total: bal.USDT.total, list, baseTotal };
  };
  for (const [me, id, baseTotal, baseRows] of [
    [a, longId, base.a, base.aRows],
    [b, shortId, base.b, base.bRows],
  ]) {
    const got = await until(
      () => read(me, id, baseTotal),
      ({ s, total, list }) => {
        const mine = s.rows.filter((r) => r.positionId === id);
        const after = list.slice(baseRows);
        return mine.length === list.length && toUnits(total) - toUnits(baseTotal) === sum(after);
      },
      'the statement and the ledger read at one moment',
      60_000,
    );
    const mine = got.s.rows.filter((r) => r.positionId === id);
    // By position and period: one row each, the same period keys and amounts as the payments list.
    expect(mine.map((r) => [r.periodId, r.amount, r.direction])).toEqual(got.list.map((p) => [p.periodId, p.amount, p.direction]));
    for (const r of mine) expect(r).toMatchObject({ symbol: SYMBOL, positionId: id });
    // The totals are the rows' sums.
    const usdt = got.s.totals.find((t) => t.asset === 'USDT');
    const paid = got.s.rows.filter((r) => r.direction === 'paid').reduce((x, r) => x + toUnits(r.amount), 0n);
    const received = got.s.rows.filter((r) => r.direction === 'received').reduce((x, r) => x + toUnits(r.amount), 0n);
    expect(toUnits(usdt.paid)).toBe(paid);
    expect(toUnits(usdt.received)).toBe(received);
    expect(toUnits(usdt.net)).toBe(received - paid);
  }

  // The room: the statement opens from the Funding tab and draws the service's rows and totals.
  const tab = await fundingTab(page, state('long'));
  await tab.getByRole('button', { name: 'Funding statement' }).click();
  const region = page.getByRole('region', { name: 'Funding statement' });
  await expect(region).toBeVisible();
  const s = await statement(a);
  const table = region.getByRole('table', { name: 'Funding statement' });
  for (const r of s.rows) {
    const row = table.getByRole('row').filter({ hasText: r.periodId });
    await expect(row).toContainText(exact(r.amount));
  }
  const usdt = s.totals.find((t) => t.asset === 'USDT');
  await expect(valueOf(region, 'Total paid')).toHaveText(`${exact(usdt.paid)} USDT`);
  await expect(valueOf(region, 'Total received')).toHaveText(`${exact(usdt.received)} USDT`);
  await expect(valueOf(region, 'Net')).toHaveText(`${exact(usdt.net)} USDT`);
});

test(`${J} #2 the index feed is not published: "Index unpublished", a period recorded unset, nothing posted`, async ({ page }) => {
  test.setTimeout(SETTLE_MS * 2 + 120_000);
  const a = await api(state('long'));
  const b = await api(state('short'));
  const marketId = state('marketId');

  // Wait until the latest published period is settled, so nothing is still owed when the index goes.
  const latest = (await fundingRate()).body.periodId;
  await settledRow(latest, 'the latest published period settled');

  await publishIndex(marketId, BLANK_INDEX);
  const refused = await until(
    fundingRate,
    (r) => r.status === 200 && r.body.indexNow?.price === null && r.body.lastPeriod?.status === 'refused',
    'a period refused for the unpublished index',
    SETTLE_MS,
  );
  expect(refused.body.indexNow.reason).toBe('trade.index_params_unset');
  expect(refused.body.lastPeriod.code).toMatch(/_unset$/);
  expect(refused.body.lastPeriod.code).toBe('trade.index_params_unset');

  // Nothing posted: through a whole funding tick after the refusal, no new payment and not a unit moved in the ledger.
  const before = {
    a: await payments(a, state('longId')),
    b: await payments(b, state('shortId')),
    aTotal: (await a.balances()).USDT.total,
    bTotal: (await b.balances()).USDT.total,
  };
  await new Promise((r) => setTimeout(r, 70_000));
  expect(await payments(a, state('longId'))).toEqual(before.a);
  expect(await payments(b, state('shortId'))).toEqual(before.b);
  expect((await a.balances()).USDT.total).toBe(before.aTotal);
  expect((await b.balances()).USDT.total).toBe(before.bTotal);
  const recent = (await history()).body.rates;
  expect(recent.some((r) => r.periodTimestamp >= Date.parse(refused.body.lastPeriod.periodStart))).toBe(false);

  // The room says so.
  const tab = await fundingTab(page, state('long'));
  await expect(valueOf(tab, 'Index now')).toHaveText('Index unpublished');
  await expect(valueOf(tab, 'Last period')).toContainText('recorded unset');
});

test(`${J} #6 reads public funding, index and mark history: premium, annualised rate, series, a null index with its reason`, async ({
  page,
}) => {
  // Signed out: public reads.
  const hist = await history();
  expect(hist.status, JSON.stringify(hist.body)).toBe(200);
  const rows = hist.body.rates;
  for (const id of [state('positivePeriod'), state('negativePeriod')]) {
    const row = rows.find((r) => r.periodId === id);
    expect(row, id).toBeTruthy();
    expect(row.premium).toMatch(/^-?\d+(\.\d+)?$/);
    expect(row.index_price).toMatch(/^\d+(\.\d+)?$/);
    expect(row.mark_price).toMatch(/^\d+(\.\d+)?$/);
    // Annualised: the period rate times the periods in a 365-day year, exactly.
    const perYear = BigInt((365 * 86_400) / TEST_PARAMS.periodSeconds);
    expect(toUnits(row.annualisedRate)).toBe(toUnits(row.fundingRate) * perYear);
  }

  const series = await publicGet(`/api/v1/funding-index-history/${enc}?limit=1000`);
  expect(series.status, JSON.stringify(series.body)).toBe(200);
  const points = series.body.series;
  expect(points.length).toBeGreaterThan(0);
  const withIndex = points.filter((p) => p.index !== null);
  const without = points.filter((p) => p.index === null);
  expect(withIndex.length).toBeGreaterThan(0);
  for (const p of withIndex) {
    expect(p.index).toMatch(/^\d+(\.\d+)?$/);
    expect(p.indexReason).toBeNull();
  }
  // Since #2 the index is unpublished: those points are null, with the reason, never a number.
  expect(without.length).toBeGreaterThan(0);
  for (const p of without) expect(p.indexReason).toContain('trade.index_params_unset');
  for (const p of points) expect(p.mark === null || /^\d+(\.\d+)?$/.test(p.mark)).toBe(true);
  // A series read with no limit is refused by name, not cut at an invented page size.
  const unbounded = await publicGet(`/api/v1/funding-index-history/${enc}`);
  expect(unbounded.status).toBe(400);
  expect(JSON.stringify(unbounded.body)).toContain('trade.series_limit_unset');

  // The room: the Funding tab's public history draws the rows and the series.
  const tab = await fundingTab(page, state('long'));
  const table = tab.getByRole('table', { name: 'Funding history' });
  const positive = rows.find((r) => r.periodId === state('positivePeriod'));
  const row = table.getByRole('row').filter({ hasText: pct(positive.annualisedRate) });
  await expect(row).toContainText(pct(positive.fundingRate));
  await expect(row).toContainText(pct(positive.premium));
  const seriesTable = tab.getByRole('table', { name: 'Mark and index' });
  await expect(seriesTable.getByRole('row').filter({ hasText: 'Index unpublished' }).first()).toBeVisible();
});
