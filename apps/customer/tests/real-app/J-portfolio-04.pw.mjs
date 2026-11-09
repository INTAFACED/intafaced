// World: book, stack
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { localStackState } from '../../../../tooling/scripts/local-test-state.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, api, bestPrices, fromUnits, fund, journeyState, toUnits } from './stack.mjs';
import { confirm, deskPath, fundedTrader, held, reviewLimit, signIn } from './desk.mjs';

// J-portfolio-04, in the running app (docs/roadmap/journeys.json): "I control how my cost basis is worked out". One test
// per step, titled "J-portfolio-04 #<n>", run in order on one TEST account funded with TEST 1000 USDT. Every figure is
// checked against a hand count from the ledger balances and the public candles, never against the lot book itself. #1's
// acquired times are read from the lot book and each is matched to one of svc-trade's own fills for this person.
const J = 'J-portfolio-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const ONE = toUnits('1');

test.describe.configure({ mode: 'default' });

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** The screen's dollar text for an exact amount (fmtUsd): under 1 dollar at up to 4 places, else cents, half-up. */
function usd(units, signed = false) {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const places = abs < ONE ? 4 : 2;
  const step = 10n ** BigInt(18 - places);
  const rounded = (abs + step / 2n) / step;
  let frac = (rounded % 10n ** BigInt(places)).toString().padStart(places, '0');
  if (places === 4) frac = frac.replace(/0{1,2}$/, '');
  const sign = rounded === 0n ? '' : negative ? '−' : signed ? '+' : '';
  return `${sign}$${(rounded / 10n ** BigInt(places)).toLocaleString('en-US')}.${frac}`;
}

const total = (balances, asset) => toUnits(balances[asset]?.total ?? '0');
const priceAt = (decimal, percent) => fromUnits(((toUnits(decimal) * BigInt(percent)) / 100n / 10n ** 16n) * 10n ** 16n);

/** One limit buy over the best ask: it takes the maker's asks and fills at once. Returns what it cost and what arrived. */
async function buyNow(page, who, amount, symbol = 'BTC/USDT') {
  const base = symbol.split('/')[0];
  const before = await (await api(who)).balances();
  await page.goto(deskPath(symbol));
  const { ask } = await bestPrices(symbol);
  await reviewLimit(page, 'buy', priceAt(ask, 101), amount, base);
  await confirm(page, 'buy');
  await expect.poll(async () => held(await (await api(who)).balances(), 'USDT'), { timeout: 20_000 }).toBe(0n);
  const after = await (await api(who)).balances();
  return { cost: total(before, 'USDT') - total(after, 'USDT'), qty: total(after, base) - total(before, base) };
}

async function lotsPage(page, asset = 'BTC') {
  await page.goto(`/money/pnl?asset=${asset}`);
  const lots = page.getByRole('region', { name: 'Lots' });
  await expect(lots).toBeVisible();
  return lots;
}

test(`${J} #1 opens the lots list for BTC: each lot with acquired date, quantity, basis and source`, async ({ page }) => {
  const who = await fundedTrader(page, 'pf4', '1000');
  run.reset({ account: who });
  await signIn(page, who);
  // Two TEST buys a little apart, so the maker's quotes (and so the prices) move between them.
  const before = Date.now();
  const first = await buyNow(page, who, '0.002');
  await page.waitForTimeout(6_000);
  const second = await buyNow(page, who, '0.003');
  const after = Date.now();
  run.write({ buys: [first, second].map((b) => ({ cost: fromUnits(b.cost), qty: fromUnits(b.qty) })) });

  const lots = await lotsPage(page);
  const rows = lots.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  for (const [i, b] of [first, second].entries()) {
    const row = rows.nth(i);
    await expect(row.locator('[data-col="source"]')).toHaveText('Bought');
    await expect(row.locator('[data-col="qty"]')).toHaveText(fromUnits(b.qty));
    await expect(row.locator('[data-col="left"]')).toHaveText(fromUnits(b.qty));
    await expect(row.locator('[data-col="cost"]')).toHaveText(usd(b.cost));
    await expect(row.locator('[data-col="days"]')).toHaveText('0');
  }
  // The acquired column is each lot's date and time, oldest first. Each lot's time is one of this person's own fills as
  // svc-trade answers them, inside the minutes the buys took, the first before the second.
  const client = await api(who);
  const booked = await client.get('/api/tax/trpc/lotBook');
  expect(booked.status, JSON.stringify(booked.body).slice(0, 300)).toBe(200);
  const lotsHeld = booked.body.result.data.lots.filter((lot) => lot.assetId === 'BTC');
  const fills = (await client.get('/api/v1/account/trades?limit=100')).body.filter((fill) => fill.symbol === 'BTC/USDT');
  const times = lotsHeld.map((lot) => Date.parse(lot.acquiredAt));
  expect(times).toHaveLength(2);
  expect(times[0]).toBeLessThan(times[1]);
  for (const at of times) {
    expect(at).toBeGreaterThanOrEqual(before - 60_000);
    expect(at).toBeLessThanOrEqual(after + 60_000);
    expect(
      fills.some((fill) => Math.abs(fill.timestamp - at) <= 1_000),
      `a fill at ${new Date(at).toISOString()}`,
    ).toBe(true);
  }
  // Each row is that lot, in that order, and shows its time as the page writes a date and time on this device.
  expect(await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-lot')))).toEqual(lotsHeld.map((lot) => lot.id));
  for (const [i, lot] of lotsHeld.entries()) {
    const written = await page.evaluate((iso) => {
      const at = Date.parse(iso);
      const text = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
        .format(at)
        .replace(',', '');
      return `${text.slice(0, text.lastIndexOf(' '))}, ${text.slice(text.lastIndexOf(' ') + 1)}`;
    }, lot.acquiredAt);
    await expect(rows.nth(i).locator('th')).toHaveText(written);
  }
  // The term rule is not published, so only days held is shown and the screen says so.
  await expect(lots).toContainText('Short or long term is not shown');
});

/** Sells `amount` BTC at once (a limit sell under the best bid takes the maker's bids). Returns the USDT that arrived. */
async function sellNow(page, who, amount) {
  const before = await (await api(who)).balances();
  await page.goto(deskPath('BTC/USDT'));
  const { bid } = await bestPrices('BTC/USDT');
  await reviewLimit(page, 'sell', priceAt(bid, 99), amount);
  await confirm(page, 'sell');
  await expect.poll(async () => held(await (await api(who)).balances(), 'BTC'), { timeout: 20_000 }).toBe(0n);
  const after = await (await api(who)).balances();
  expect(total(before, 'BTC') - total(after, 'BTC')).toBe(toUnits(amount));
  return total(after, 'USDT') - total(before, 'USDT');
}

/** The lot engine's share: cost * take / qty, cut at the ledger's 18 places; the whole lot when all of it is taken. */
const share = (cost, qty, take) => (take === qty ? cost : (cost * take) / qty);

/** What one sale of `take` costs under each method, from two open lots [{ cost, qty }] (oldest first). */
function costBy(method, lots, take) {
  const [a, b] = lots;
  if (method === 'FIFO') return share(a.cost, a.qty, take);
  if (method === 'LIFO') return share(b.cost, b.qty, take);
  if (method === 'HIFO') return a.cost * b.qty >= b.cost * a.qty ? share(a.cost, a.qty, take) : share(b.cost, b.qty, take);
  return share(a.cost + b.cost, a.qty + b.qty, take); // AVERAGE
}

/** FIFO by hand, as the lot engine draws it: each sale takes the oldest lot's share, then the next. Returns the lots left. */
function fifoLeft(lots, takes) {
  const open = lots.map((lot) => ({ ...lot }));
  for (let take of takes) {
    while (take > 0n && open.length > 0) {
      const lot = open[0];
      const part = take < lot.qty ? take : lot.qty;
      const cost = share(lot.cost, lot.qty, part);
      lot.cost -= cost;
      lot.qty -= part;
      take -= part;
      if (lot.qty === 0n) open.shift();
    }
  }
  return open;
}

// Steps 4 and 5 run before the deposit of step 3, so every BTC lot they draw on was bought and every method can be worked
// out by hand. Step 5 puts the choices back to FIFO with no pick, which steps 6 and 7 count on.
test(`${J} #4 chooses FIFO, LIFO, HIFO or average cost for the account or one coin: the result and what is left follow`, async ({
  page,
}) => {
  const who = account();
  const buys = run.read().buys.map((b) => ({ cost: toUnits(b.cost), qty: toUnits(b.qty) }));
  await signIn(page, who);
  // TEST: sell 0.001 BTC, less than either lot, so every method draws on one lot (AVERAGE on the pool).
  const take = toUnits('0.001');
  const proceeds = await sellNow(page, who, '0.001');
  run.write({ sale1: fromUnits(proceeds) });
  const totalCost = buys[0].cost + buys[1].cost;

  const expectMethod = async (method, source) => {
    const cost = costBy(method, buys, take);
    const sale = page.getByRole('region', { name: 'Sales' }).locator('tr[data-sale]').first();
    await expect(sale.locator('[data-col="method"] [data-method]')).toHaveAttribute('data-method', method);
    await expect(sale.locator('[data-col="method"]')).toContainText(source);
    await expect(sale.locator('td').nth(2)).toHaveText(usd(cost));
    await expect(sale.locator('[data-col="result"]')).toHaveText(usd(proceeds - cost, true));
    // What is left: the two lots' cost less what this sale took.
    await expect(page.locator('tr[data-asset="BTC"] [data-col="cost"]')).toHaveText(usd(totalCost - cost));
  };

  await page.goto('/money/pnl?asset=BTC');
  await expectMethod('FIFO', '(standard)');
  const choices = page.getByRole('region', { name: 'Your matching choices' });
  await choices.getByRole('combobox', { name: 'Method for all coins' }).selectOption('LIFO');
  await expect(choices.getByRole('status')).toHaveText('Saved. The figures above use it.');
  await expectMethod('LIFO', '(your method for all coins)');
  const coin = page.getByRole('region', { name: 'Lots' }).getByRole('combobox', { name: 'Method for BTC' });
  for (const method of ['HIFO', 'AVERAGE', 'FIFO']) {
    await coin.selectOption(method);
    await expectMethod(method, '(your method for this coin)');
  }
  // Saved, not just on screen: a reload shows the same.
  await page.reload();
  await expectMethod('FIFO', '(your method for this coin)');
  await coin.selectOption('');
  await expectMethod('LIFO', '(your method for all coins)');
});

test(`${J} #5 picks the lot for one sale and sets a method for one day: that sale uses that lot, the other keeps its method`, async ({
  page,
}) => {
  const who = account();
  const buys = run.read().buys.map((b) => ({ cost: toUnits(b.cost), qty: toUnits(b.qty) }));
  const proceeds1 = toUnits(run.read().sale1);
  await signIn(page, who);
  // TEST: a second sale of 0.001 BTC. The account method is LIFO (step 4): the first sale took from the newer lot.
  const take = toUnits('0.001');
  const proceeds2 = await sellNow(page, who, '0.001');
  run.write({ sale2: fromUnits(proceeds2) });
  await page.goto('/money/pnl?asset=BTC');
  const sales = page.getByRole('region', { name: 'Sales' }).locator('tr[data-sale]');
  await expect(sales).toHaveCount(2);
  const [newest, oldest] = [sales.nth(0), sales.nth(1)];

  // Pick the older lot for the newest sale.
  const oldLot = await page.getByRole('region', { name: 'Lots' }).locator('tbody tr').first().getAttribute('data-lot');
  await newest.getByRole('combobox', { name: 'Lot for this sale' }).selectOption(oldLot);
  const firstCost = share(buys[1].cost, buys[1].qty, take); // LIFO, the newer lot
  const pickedCost = share(buys[0].cost, buys[0].qty, take); // the older lot, untouched so far
  await expect(newest.locator('td').nth(2)).toHaveText(usd(pickedCost));
  await expect(newest.locator('[data-col="result"]')).toHaveText(usd(proceeds2 - pickedCost, true));
  await expect(oldest.locator('[data-col="method"] [data-method]')).toHaveAttribute('data-method', 'LIFO');
  await expect(oldest.locator('[data-col="result"]')).toHaveText(usd(proceeds1 - firstCost, true));

  // A method for today (UTC), every coin: HIFO. The picked sale still uses its lot; the other sale follows the day.
  const choices = page.getByRole('region', { name: 'Your matching choices' });
  const day = new Date().toISOString().slice(0, 10);
  await choices.getByLabel('Day (UTC)').fill(day);
  await choices.getByRole('combobox', { name: 'Method for that day' }).selectOption('HIFO');
  await choices.getByRole('button', { name: 'Save day method' }).click();
  await expect(choices.getByRole('list', { name: 'Saved day methods' })).toContainText(`${day} · All coins · HIFO`);
  const hifoCost = costBy('HIFO', buys, take);
  await expect(oldest.locator('[data-col="method"] [data-method]')).toHaveAttribute('data-method', 'HIFO');
  await expect(oldest.locator('[data-col="method"]')).toContainText('(your method for that day)');
  await expect(oldest.locator('[data-col="result"]')).toHaveText(usd(proceeds1 - hifoCost, true));
  // The newest sale keeps its picked lot whatever the day's method: the older lot, unless HIFO's first sale drew on it.
  const left0 = hifoCost === share(buys[0].cost, buys[0].qty, take) ? { cost: buys[0].cost - hifoCost, qty: buys[0].qty - take } : buys[0];
  await expect(newest.locator('td').nth(2)).toHaveText(usd(share(left0.cost, left0.qty, take)));

  // Back to FIFO with no pick and no day method: both sales oldest first, as the standard method does.
  await choices.getByRole('list', { name: 'Saved day methods' }).getByRole('button', { name: 'Remove' }).click();
  await expect(choices.getByRole('list', { name: 'Saved day methods' })).toHaveCount(0);
  await newest.getByRole('combobox', { name: 'Lot for this sale' }).selectOption('');
  await choices.getByRole('combobox', { name: 'Method for all coins' }).selectOption('FIFO');
  await expect(choices.getByRole('status')).toHaveText('Saved. The figures above use it.');
  const fifo1 = share(buys[0].cost, buys[0].qty, take);
  await expect(oldest.locator('[data-col="method"] [data-method]')).toHaveAttribute('data-method', 'FIFO');
  await expect(oldest.locator('[data-col="result"]')).toHaveText(usd(proceeds1 - fifo1, true));
  const left = fifoLeft(buys, [take, take]);
  const leftCost = left.reduce((sum, lot) => sum + lot.cost, 0n);
  await expect(newest.locator('[data-col="method"] [data-method]')).toHaveAttribute('data-method', 'FIFO');
  await expect(page.locator('tr[data-asset="BTC"] [data-col="cost"]')).toHaveText(usd(leftCost));
});

/** The close of the last one-minute candle that started at or before `t`, from the public candles of `symbol`. */
async function closesAround(symbol, before, after) {
  const res = await fetch(
    `${EDGE}/api/v1/ohlcv/${encodeURIComponent(symbol)}?timeframe=1m&since=${Math.floor(before / 60_000) * 60_000 - 3_600_000}&limit=720`,
    { headers: { origin: ORIGIN } },
  );
  expect(res.status).toBe(200);
  const candles = await res.json();
  const lastAt = (t) => candles.filter((c) => c[0] <= t).at(-1)?.[4];
  return [...new Set([lastAt(before), lastAt(after)].filter(Boolean))];
}

/** The screen's dollar text for `qty` coins at each candle close: what the arrival is worth at that price. */
const valuesAt = (qty, closes) => closes.map((close) => usd((toUnits(qty) * toUnits(close) + ONE / 2n) / ONE));

/** The person's svc-bank API through Edge, with a session of its own: earn savings are opened and taken back here. */
async function bankApi(who) {
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const answer = async (res) => {
    const body = await res.json();
    if (!res.ok) throw new Error(`bank refused: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    return body.result.data;
  };
  return {
    query: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
  };
}

let staffDoor;
/** The stack's two TEST founders and its signed service context (`local-test-gates.mjs`), made once. */
async function founders() {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { gates, ctx, sessions: await gates.approverSessions(ctx) };
  })();
  return staffDoor;
}

/** One treasury door of the bank, approved by the stack's two TEST founders, bound to `fields` (the door's canonical strings). */
async function treasury(actionType, procedure, input, fields) {
  const { gates, ctx, sessions } = await founders();
  const approval = await gates.twoPerson(ctx, sessions, {
    actionType,
    targetService: 'svc-bank',
    targetId: actionType,
    expectedVersion: '1',
    payloadHash: gates.bankPayloadHash(actionType, fields),
    policyVersion: gates.MARKERS.policyVersion,
  });
  const res = await ctx.edge.mutate('bank', procedure, { ...input, ...approval }, await sessions.a.treasuryToken());
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
}

/** One day of earn interest for one pool, through the bank's own job procedure, signed as the bank's scheduler signs it. */
async function accrue(poolId, at) {
  const { ctx } = await founders();
  const raw = JSON.stringify({ poolId, at: at.toISOString() });
  const res = await fetch(`${ctx.url('bank')}/trpc/ops.accrueInterest`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', ...ctx.contracts.serviceAuthHeadersForBody('svc-bank', ctx.secrets.internal, raw) },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const parsed = await res.json().catch(() => null);
  expect(res.status, JSON.stringify(parsed).slice(0, 300)).toBe(200);
  return parsed.result.data.results[0];
}

/** One of the stack's TEST seed commands (`tooling/scripts/local-test-seed.mjs`), on this stack. */
function seed(...args) {
  return execFileSync(process.execPath, [path.join(ROOT, 'tooling/scripts/local-test-seed.mjs'), ...args, '--state', localStackState()], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, LOCAL_TEST: '1' },
    timeout: 60_000,
  });
}

test(`${J} #3 reads a deposit: valued at the time it arrived, with the price source named, and no cost until one is entered`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = account();
  // TEST 0.004 BTC arrives by deposit through the real ledger, at a moment the BTC/USDT book has traded.
  const before = Date.now();
  expect(fund(who.email, 'BTC', '0.004').tx).toBeTruthy();
  const after = Date.now();
  await signIn(page, who);
  const lots = await lotsPage(page);
  const row = lots.locator('tbody tr[data-source="deposit"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-col="source"]')).toHaveText('Deposit');
  await expect(row.locator('[data-col="qty"]')).toHaveText('0.004');
  // The TEST owner policy is "customer": a deposit's cost is unknown until the customer gives one, never zero.
  await expect(row.locator('[data-col="cost"]')).toHaveText('Cost unknown');
  await expect(row.locator('[data-col="price-source"]')).toContainText('at the BTC/USDT price, one-minute candle from');

  // Hand count from the public one-minute candles: 0.004 times the close of the last candle that started at or before the
  // arrival. The arrival is posted between `before` and `after`, so the price is the one for either moment.
  const depositValues = valuesAt('0.004', await closesAround('BTC/USDT', before, after));
  expect(depositValues.length).toBeGreaterThan(0);
  const shown = (await row.locator('[data-col="arrival"]').innerText()).split('\n')[0].trim();
  expect(depositValues).toContain(shown.split(' ')[0]);

  // The bought lots keep their cost, and the asset's open cost is now unknown on Open positions: one lot has no cost.
  await expect(lots.locator('tbody tr[data-source="trade"] [data-col="cost"]').first()).not.toHaveText('Cost unknown');
  await expect(page.locator('tr[data-asset="BTC"] [data-col="cost"]')).toHaveText('Not known');

  // A reward: one day of interest from a TEST ETH savings pool of this run's own, paid by the bank's own daily job. It is
  // paid in ETH, not BTC, so the BTC lots the later steps sell from and move stay as they are. A TEST ETH buy first, so
  // the person holds ETH to save (a little over the saving, for the fee) and the ETH/USDT book has a candle to value the
  // reward by.
  await buyNow(page, who, '0.012', 'ETH/USDT');
  const RUN = process.env.JOURNEY_RUN_ID ?? `local-${Date.now()}`;
  const pool = {
    poolId: randomUUID(),
    assetId: 'ETH',
    kind: 'flexible',
    name: `TEST ${J} reward ${RUN}`,
    // A TEST rate of 365% a year: one day pays exactly 1% of the saving, so the reward is a figure a hand count can name.
    aprBps: 36_500,
    termDays: null,
    minDeposit: '0.001',
  };
  await treasury('bank.ops.createEarnPool', 'ops.createEarnPool', pool, {
    ...pool,
    aprBps: String(pool.aprBps),
    termDays: '',
  });
  try {
    expect(seed('fund-earn-pool', pool.poolId, '0.01', `${J}-${RUN}`)).toContain('reserve funded 0.01 ETH');
    const bank = await bankApi(who);
    const PRINCIPAL = '0.01';
    const { positionId } = await bank.mutate('earn.deposit', { poolId: pool.poolId, positionId: randomUUID(), amount: PRINCIPAL });
    // The bank pays only a day that has begun: the saving's opening moves back two days, so its first day is yesterday.
    expect(seed('age-earn-position', positionId, '2')).toContain(`saving ${positionId}: opened`);
    const firstDay = Date.parse((await bank.query('earn.positions', { limit: 50 })).find((p) => p.id === positionId).accruesFrom);
    const paidAt = Date.now();
    const day = await accrue(pool.poolId, new Date(firstDay + 60_000));
    const paidBy = Date.now();
    expect(day).toMatchObject({ recipients: 1, alreadyAccrued: false });
    const history = await bank.query('earn.interestHistory', { poolId: pool.poolId, limit: 31 });
    const REWARD = fromUnits((toUnits(PRINCIPAL) * BigInt(pool.aprBps)) / 10_000n / 365n);
    expect(REWARD).toBe('0.0001');
    expect(history.days.map((d) => d.amount)).toEqual([REWARD]);
    // The saving goes back whole; the interest stays with the person.
    await bank.mutate('earn.withdraw', { positionId });

    // The reward's lot: its own row, sourced "Reward", the amount paid, valued at the ETH/USDT candle of when it arrived.
    const ethLots = await lotsPage(page, 'ETH');
    const reward = ethLots.locator('tbody tr[data-source="reward"]');
    await expect(reward).toHaveCount(1);
    await expect(reward.locator('[data-col="source"]')).toHaveText('Reward');
    await expect(reward.locator('[data-col="qty"]')).toHaveText(REWARD);
    await expect(reward.locator('[data-col="price-source"]')).toContainText('at the ETH/USDT price, one-minute candle from');
    const rewardCloses = await closesAround('ETH/USDT', paidAt, paidBy);
    const rewardValues = valuesAt(REWARD, rewardCloses);
    expect(rewardValues.length).toBeGreaterThan(0);
    const rewardShown = (await reward.locator('[data-col="arrival"]').innerText()).split('\n')[0].trim();
    expect(rewardValues).toContain(rewardShown.split(' ')[0]);

    // Under the TEST owner policy ("customer") the reward, like the deposit, has no cost until the person gives one. The
    // person enters the price it arrived at, so the BTC deposit is the one lot without a cost that steps 6 and 7 work on.
    await expect(reward.locator('[data-col="cost"]')).toHaveText('Cost unknown');
    const rewardLot = await reward.getAttribute('data-lot');
    const item = page.getByRole('region', { name: 'Missing cost' }).locator(`li[data-missing-lot="${rewardLot}"]`);
    await item.getByRole('button', { name: 'Enter a cost' }).click();
    const form = item.getByRole('form', { name: 'Enter a cost for this lot' });
    await form.getByLabel('Price you paid per ETH, in USD').fill(rewardCloses[rewardValues.indexOf(rewardShown.split(' ')[0])]);
    await form.getByLabel('Where this price comes from').fill('TEST the ETH/USDT price when the reward arrived');
    await form.getByRole('button', { name: 'Save price' }).click();
    await expect(page.getByTestId('basis-notice')).toHaveText('Price saved. The figures use it, marked customer-entered.');
    await expect(item).toHaveCount(0);
  } finally {
    // The run's pool closes to new savings, so pools of earlier runs never crowd the bank's list.
    const reason = 'TEST closing the run pool';
    const input = { poolId: pool.poolId, status: 'closed', reason, revision: 1 };
    await treasury('bank.ops.setEarnPoolStatus', 'ops.setEarnPoolStatus', input, { ...input, revision: '1' });
  }
});

test(`${J} #6 sells into the lot with no cost: the warning names that lot, and the sale shows its unknown share`, async ({ page }) => {
  const who = account();
  const buys = run.read().buys.map((b) => ({ cost: toUnits(b.cost), qty: toUnits(b.qty) }));
  // What is left of the bought lots after the two sales of steps 4 and 5, both FIFO now (step 5 put the choices back).
  const bought = fifoLeft(buys, [toUnits('0.001'), toUnits('0.001')]).reduce((sum, lot) => sum + lot.qty, 0n);
  await signIn(page, who);
  // FIFO uses what is left of the two bought lots first (a little under 0.003 BTC), so a sale of 0.006 BTC, a size the desk
  // takes, reaches into the deposit's lot for the rest.
  const amount = '0.006';
  const part = toUnits(amount) - bought;
  expect(part).toBeGreaterThan(0n);
  expect(part).toBeLessThan(toUnits('0.004'));
  const proceeds = await sellNow(page, who, amount);
  run.write({ sold: amount, part: fromUnits(part), proceeds: fromUnits(proceeds) });

  await page.goto('/money/pnl?asset=BTC');
  const missing = page.getByRole('region', { name: 'Missing cost' });
  await expect(missing).toBeVisible();
  const lots = page.getByRole('region', { name: 'Lots' });
  const depositLot = await lots.locator('tbody tr[data-source="deposit"]').getAttribute('data-lot');
  const item = missing.locator(`li[data-missing-lot="${depositLot}"]`);
  await expect(item).toContainText('Deposit on');
  await expect(item).toContainText(`${fromUnits(toUnits('0.004') - part)} BTC with no cost`);
  await expect(item.locator('[data-effect="unknown-share"]')).toHaveText(`Unknown share: ${fromUnits(part)} BTC sold with no cost`);
  // The sale itself: what was received is known, its cost and result are not, and the unknown share is named.
  const sale = page.getByRole('region', { name: 'Sales' }).locator('tr[data-sale]').first();
  await expect(sale.locator('td').nth(0)).toHaveText(amount);
  await expect(sale.locator('td').nth(1)).toHaveText(usd(proceeds));
  await expect(sale.locator('[data-col="result"]')).toContainText('Cost unknown');
  await expect(sale.locator('[data-effect="unknown-share"]')).toHaveText(`Unknown share: ${fromUnits(part)} BTC sold with no cost`);
});

test(`${J} #7 enters the price paid for that lot: the result recomputes, marked customer-entered, and our unknown stays on record`, async ({
  page,
}) => {
  const who = account();
  const { proceeds, part } = run.read();
  const buys = run.read().buys.map((b) => ({ cost: toUnits(b.cost), qty: toUnits(b.qty) }));
  const boughtCost = fifoLeft(buys, [toUnits('0.001'), toUnits('0.001')]).reduce((sum, lot) => sum + lot.cost, 0n);
  const PRICE = '61000.5';
  await signIn(page, who);
  await page.goto('/money/pnl?asset=BTC');
  const missing = page.getByRole('region', { name: 'Missing cost' });
  await missing.getByRole('button', { name: 'Enter a cost' }).click();
  const form = missing.getByRole('form', { name: 'Enter a cost for this lot' });
  await expect(form).toContainText('Our record: cost unknown.');
  // A blank note is refused before anything is sent.
  await form.getByLabel('Price you paid per BTC, in USD').fill(PRICE);
  await form.getByRole('button', { name: 'Save price' }).click();
  await expect(form.getByRole('status')).toHaveText('Say where this price comes from, for example the receipt of the purchase.');
  await form.getByLabel('Where this price comes from').fill('TEST receipt from an earlier purchase');
  await form.getByRole('button', { name: 'Save price' }).click();
  await expect(page.getByTestId('basis-notice')).toHaveText('Price saved. The figures use it, marked customer-entered.');

  // The deposit's lot now has the customer's cost (0.004 at that price), labelled, with our own unknown beside it.
  const lots = page.getByRole('region', { name: 'Lots' });
  const lot = lots.locator('tbody tr[data-source="deposit"]');
  await expect(lot.locator('[data-col="cost"]')).toContainText(usd((toUnits('0.004') * toUnits(PRICE)) / ONE));
  await expect(lot.locator('[data-col="cost"] [data-label="customer-entered"]')).toContainText(
    'Customer-entered · our record: cost unknown',
  );
  // The sale recomputes by hand: its cost is what was left of the two bought lots plus the deposit's part at the entered price; the result is
  // what was received minus that, and it says it uses a price the customer entered.
  const cost = boughtCost + (toUnits(part) * toUnits(PRICE)) / ONE;
  const sale = page.getByRole('region', { name: 'Sales' }).locator('tr[data-sale]').first();
  await expect(sale.locator('td').nth(2)).toHaveText(usd(cost));
  await expect(sale.locator('[data-col="result"]')).toContainText(usd(toUnits(proceeds) - cost).replace(/^(?!−)/, '+'));
  await expect(sale.locator('[data-col="result"] [data-label="customer-entered"]')).toHaveText('Customer-entered');
  await expect(page.getByRole('region', { name: 'Missing cost' })).toHaveCount(0);

  // Taking the price back: the lot's cost is unknown again, and the sale's result with it. Nothing else moved.
  const balances = await (await api(who)).balances();
  await lot.getByRole('button', { name: 'Remove my price' }).click();
  await expect(page.getByTestId('basis-notice')).toHaveText('Price removed. That lot’s cost is unknown again.');
  await expect(lot.locator('[data-col="cost"]')).toHaveText('Cost unknown');
  await expect(sale.locator('[data-col="result"]')).toContainText('Cost unknown');
  await expect(page.getByRole('region', { name: 'Missing cost' })).toBeVisible();
  expect(await (await api(who)).balances()).toEqual(balances);
});

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who) {
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then((r) => r.json());
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused`);
  const res = await fetch(`${EDGE}/api/bank/trpc/spaces.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`spaces.list refused: ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body.result.data;
}

// Step 2 runs last: moving the coins out of the main account changes which lots the sales of steps 4 to 7 could draw on.
test(`${J} #2 moves TEST BTC from the main account to a space: each lot keeps its acquired date and basis and shows in the space's list`, async ({
  page,
}) => {
  const who = account();
  const SPACE = 'Cold TEST';
  await signIn(page, who);
  // A fresh TEST buy, so the move carries a lot with a known cost as well as what is left of the deposit (cost unknown).
  const bought = await buyNow(page, who, '0.002');

  // The open lots on the main account before the move, as the list shows them.
  let lots = await lotsPage(page);
  const open = [];
  for (const row of await lots.locator('tbody tr').all()) {
    if ((await row.locator('[data-col="left"]').innerText()) === '0') continue;
    open.push({
      id: await row.getAttribute('data-lot'),
      acquired: await row.locator('th').innerText(),
      source: await row.getAttribute('data-source'),
      left: await row.locator('[data-col="left"]').innerText(),
      costLeft: await row.locator('[data-col="cost-left"]').innerText(),
    });
  }
  expect(open.map((lot) => lot.source)).toEqual(['deposit', 'trade']);
  expect(open[1].left).toBe(fromUnits(bought.qty));
  expect(open[1].costLeft).toBe(usd(bought.cost));

  // Create the space in the app, then move every BTC on the main account into it.
  await page.goto('/bank/spaces');
  await page.getByRole('button', { name: 'Create space' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Asset', { exact: true }).selectOption('BTC');
  await dialog.getByLabel('Space name').fill(SPACE);
  await dialog.getByRole('button', { name: 'Review' }).click();
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible();
  const spaces = await bank(who);
  const main = spaces.find((s) => s.kind === 'primary' && s.assetId === 'BTC');
  const cold = spaces.find((s) => s.kind === 'named' && s.name === SPACE);
  expect(cold).toBeTruthy();
  const amount = main.balance;
  expect(toUnits(amount)).toBe(open.reduce((sum, lot) => sum + toUnits(lot.left), 0n));

  await page.goto('/bank/transfers');
  await page.getByLabel('From your space').selectOption(main.id);
  await page.getByRole('button', { name: 'Continue' }).click();
  const move = page.getByRole('dialog');
  await move.getByLabel('To which of your accounts').selectOption(cold.id);
  await move.getByLabel(/Amount/).fill(amount);
  await move.getByRole('button', { name: 'Review' }).click();
  await move.getByRole('button', { name: 'Confirm' }).click();
  await expect(move.getByText(/ledger/i).first()).toBeVisible();
  const after = await bank(who);
  expect(after.find((s) => s.id === cold.id).balance).toBe(amount);

  // The space's lots: one per lot that moved, with the date, source and cost it had, marked as moved between accounts.
  lots = await lotsPage(page);
  await lots.getByLabel('Account for lots').selectOption(cold.id);
  await expect(page).toHaveURL(new RegExp(`account=${cold.id}`));
  const rows = lots.locator('tbody tr');
  await expect(rows).toHaveCount(open.length);
  for (const [i, before] of open.entries()) {
    const row = rows.nth(i);
    await expect(row.locator('th')).toHaveText(before.acquired);
    await expect(row).toHaveAttribute('data-source', before.source);
    await expect(row.locator('[data-col="account"]')).toContainText(`Space: ${SPACE}`);
    await expect(row.locator('[data-col="account"] [data-label="carried"]')).toContainText('Moved between your accounts');
    await expect(row.locator('[data-col="qty"]')).toHaveText(before.left);
    await expect(row.locator('[data-col="cost-left"]')).toHaveText(before.costLeft);
  }
  // The bought lot's basis went with it, to the cent; the deposit's part is still without a cost, not a made-up one.
  await expect(rows.nth(1).locator('[data-col="cost"]')).toHaveText(usd(bought.cost));
  await expect(rows.nth(0).locator('[data-col="cost"]')).toContainText('Cost unknown');
  await expect(lots).toContainText('Moving coins between your main account and your spaces is not a sale.');

  // A move is not a sale: no new sale row, and the main account's lots are used up by the move.
  await lots.getByLabel('Account for lots').selectOption('main');
  for (const lot of open) await expect(lots.locator(`tbody tr[data-lot="${lot.id}"] [data-col="left"]`)).toHaveText('0');
  await expect(page.getByRole('region', { name: 'Sales' }).locator('tr[data-sale]')).toHaveCount(3);
});
