import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { approverSessions, makeContext, setFeeDiscountSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, bestPrices, fund, journeyState, toUnits, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { followOnScreen, listLeader } from './copy.mjs';

// J-copy-bots-otc-13, in the running app (docs/roadmap/journeys.json): support finds a customer's follows, bots and OTC
// quotes and reads the module numbers, on the founder console. One test per step, titled "J-copy-bots-otc-13 #<n>", run
// in order; #1 is two tests, the live read and a blank-window restart of svc-trade. #2 makes the customer: a verified TEST account following a TEST leader once, with two TEST bots made through
// its own algo door, stopped once looked up. The founder signs in with the lookup scope; the stack has no support agent
// without it, so #3 uses a founder session whose scope list leaves lookup out (`local-test-gates.mjs scoped-session`).
// #4 makes a real failed settlement (a TEST quote accepted and left past the desk's settle window), a settled quote and
// an open quote, and reads each back on the desk by its id.
// A room that is not there fails at its heading, quickly (UNBUILT).
const J = 'J-copy-bots-otc-13';
const ONE = toUnits('1');
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

async function moduleRoom(page) {
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/trade-ops/copy-bots-otc`);
  await expect(page.getByRole('heading', { name: 'Copy, bots and OTC', level: 1 })).toBeVisible(UNBUILT);
}

const COUNTS = ['Active copiers', 'Active bots', 'Quotes requested in the window', 'Quotes settled in the window'];
const STAMP = String.raw`\d{4}-\d\d-\d\d \d\d:\d\d:\d\d`;

/** The value the metrics region shows beside one label. */
function metricValue(metrics, label) {
  return metrics
    .locator('[data-slot="key-value-row"]')
    .filter({ has: metrics.page().locator('dt').getByText(label, { exact: true }) })
    .locator('dd');
}

/** One cell (by column index) of the row whose id cell reads `id` exactly. */
function cellOf(table, id, column) {
  return table
    .locator('tbody tr')
    .filter({ has: table.page().getByText(id, { exact: true }) })
    .locator('td')
    .nth(column);
}

/** svc-trade restarted with its metrics window blank (`off`), or back on the stack's TEST window. */
function tradeMetricsWindow(on) {
  const name = 'LOCAL_STACK_TRADE_OPS_METRICS_WINDOW';
  const before = process.env[name];
  if (on) delete process.env[name];
  else process.env[name] = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'trade');
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

test(`${J} #1 opens the module metrics: counts with their window and as-of time`, async ({ page }) => {
  run.reset({});
  await moduleRoom(page);
  const metrics = page.getByRole('region', { name: 'Module metrics' });
  await expect(metrics.getByText('Module metrics could not be read')).toHaveCount(0);
  for (const label of COUNTS) await expect(metricValue(metrics, label)).toHaveText(/^\d+$/);
  // The stack's TEST window is 86400 s (tooling/profiles/test-owner-values/trade.json), which the room reads as 1 day.
  await expect(metricValue(metrics, 'Window')).toHaveText(new RegExp(`^1 day, ${STAMP} to ${STAMP} UTC$`));
  await expect(metricValue(metrics, 'As of')).toHaveText(new RegExp(`^${STAMP} UTC$`));
  await expect(metrics).toContainText(new RegExp(`As of ${STAMP} UTC, over the last 1 day\\.`));
});

test(`${J} #1 a failed source reads "Could not load", never zero`, async ({ page }) => {
  test.setTimeout(300_000);
  // Signed in before the restart, so the console is asked nothing from this process while svc-trade restarts.
  await founderSignIn(page, 'a');
  tradeMetricsWindow(false);
  try {
    await page.goto(`${ADMIN}/trade-ops/copy-bots-otc`);
    await expect(page.getByRole('heading', { name: 'Copy, bots and OTC', level: 1 })).toBeVisible(UNBUILT);
    const metrics = page.getByRole('region', { name: 'Module metrics' });
    await expect(metrics.getByText('Module metrics could not be read')).toBeVisible();
    await expect(metrics.locator('[data-slot="empty-state-code"]')).toHaveText('trade.ops_metrics_window_not_set');
    for (const label of COUNTS) {
      await expect(metricValue(metrics, label)).toHaveText('Could not load');
      await expect(metricValue(metrics, label)).not.toHaveText(/^0$/);
    }
    await expect(metricValue(metrics, 'Window')).toHaveText('Not read');
  } finally {
    tradeMetricsWindow(true);
  }
});

test(`${J} #2 looks up a customer with one follow and two bots: listed with their statuses`, async ({ page, browser }) => {
  test.setTimeout(360_000);
  const tag = Date.now().toString(36);
  const leader = await fundedTrader(page, 'jcl13', '10');
  const leaderRef = await listLeader(leader, `Journey Lookup ${tag}`);
  const customer = await fundedTrader(page, 'jcc13', '1000');
  await signIn(page, customer);
  const followId = await followOnScreen(page, customer, leaderRef, { perOrder: '20', total: '40', fixed: '10' });
  expect(followId).toBeTruthy();
  // Two bots through the customer's own algo door. A buy limit must sit at or over the ask (the slice price band); a
  // whole number 1% over it.
  const { ask } = await bestPrices();
  const limitPrice = String((toUnits(ask) * 101n) / 100n / ONE + 1n);
  const me = await api(customer);
  const bots = [];
  for (const n of [1, 2]) {
    const made = await me.post('/api/trade/trpc/algo.createTwap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      totalQty: '0.002',
      durationMs: 600_000,
      sliceIntervalMs: 60_000,
      limitPrice,
      clientAlgoId: `${J}-2-${n}-${tag}`,
      kind: 'twap',
    });
    expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
    bots.push(made.body.result.data.id);
  }
  run.write({ customer, leaderRef });
  try {
    const desk = await (await browser.newContext()).newPage();
    await moduleRoom(desk);
    await desk.getByRole('searchbox', { name: 'Find a customer' }).fill(customer.email);
    await desk.getByRole('searchbox', { name: 'Find a customer' }).press('Enter');
    // Each row read back by its own id, with its status as the room shows it.
    const follows = desk.getByRole('table', { name: 'Follows', exact: true });
    await expect(follows.locator('tbody tr')).toHaveCount(1);
    await expect(cellOf(follows, followId, 1)).toHaveText('Active');
    const listed = desk.getByRole('table', { name: 'Bots', exact: true });
    await expect(listed.locator('tbody tr')).toHaveCount(2);
    for (const botId of bots) await expect(cellOf(listed, botId, 3)).toHaveText('active');
    await desk.context().close();
  } finally {
    // Their slices buy on TEST money until stopped, so the journey stops both once looked up, pass or fail.
    // Every bot is asked to stop before any refusal is reported.
    const stopped = [];
    for (const algoId of bots) stopped.push(await me.post('/api/trade/trpc/algo.cancel', { algoId }));
    expect(
      stopped.map((r) => r.status),
      JSON.stringify(stopped.map((r) => r.body)).slice(0, 600),
    ).toEqual(bots.map(() => 200));
  }
});

test(`${J} #3 looks up as an agent without the lookup scope: refused`, async ({ page }) => {
  await page.goto(`${ADMIN}/login`);
  const out = JSON.parse(tool('local-test-gates.mjs', 'scoped-session', '--without', 'support:lookup'));
  await page.context().addCookies(out.cookies);
  await page.goto(`${ADMIN}/trade-ops/copy-bots-otc?customer=${encodeURIComponent(state('customer').email)}`);
  await expect(page.getByText(/You don’t have the lookup permission/)).toBeVisible();
  // Refused by the typed scope code, and none of the customer's records reached the screen.
  await expect(page.locator('[data-outcome="refused"] code')).toHaveText('scope.denied');
  for (const name of ['Follows', 'Bots', 'Customer quotes']) await expect(page.getByRole('table', { name, exact: true })).toHaveCount(0);
});

/**
 * The desk's stake gate reads the caller's stake from svc-token, which refuses every read while its fee-decay ladder is
 * blank. On a stack where no journey has published one yet, two TEST founders publish a one-step TEST ladder (no
 * discount at any stake) through the token's two-person door, as J-copy-bots-otc-24 does; one already there stands.
 */
async function stakeReadable(client) {
  const read = async () => (await client.get('/api/token/trpc/feeDiscount.get')).body.result.data;
  if ((await read()).schedule != null) return;
  const ctx = await makeContext({ log: () => undefined });
  const schedule = { basis: 'staked', tiers: [{ minStake: '0', discountBps: 0 }] };
  await setFeeDiscountSchedule(ctx, schedule, { sessions: await approverSessions(ctx) }).catch(async (err) => {
    if ((await read()).schedule == null) throw err;
  });
}

/**
 * Stakes the desk's own published floor (`minStake=` on its status line) for the account through svc-token's stake
 * door, funded first through the ledger, with business keys so a retried step neither funds nor stakes twice.
 */
async function stakeToDeskFloor(who, client) {
  const desk = await client.get('/api/trade/trpc/otc.deskStatus');
  expect(desk.status, JSON.stringify(desk.body).slice(0, 300)).toBe(200);
  const floor = /(?:^| )minStake=(\S+)/.exec(desk.body.result.data.statusLine)?.[1];
  expect(floor, desk.body.result.data.statusLine).toBeTruthy();
  const hex = createHash('sha256').update(`${J}:stake:${who.email}:${floor}`).digest('hex');
  expect(fund(who.email, 'IFC', floor, `${J}-stake-${hex.slice(0, 16)}`).tx).toBeTruthy();
  const stakeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const staked = await client.post('/api/token/trpc/stake', { amount: floor, tier: 'flex', stakeId });
  expect(staked.status, JSON.stringify(staked.body).slice(0, 300)).toBe(200);
  await expect.poll(async () => (await client.get('/api/token/trpc/stakeOf')).body.result.data.staked).toBe(floor);
}

test(`${J} #4 opens the quote desk list: open and settled RFQs with statuses; a failed settlement listed with its saga key`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  // A real failed settlement: a TEST quote over the desk's minimum, accepted, then left past its settle-by time.
  const trader = await fundedTrader(page, 'jco13', '6000');
  const me = await api(trader);
  await stakeReadable(me);
  await stakeToDeskFloor(trader, me);
  const makers = await me.get('/api/trade/trpc/otc.makers.list');
  expect(makers.status, JSON.stringify(makers.body).slice(0, 300)).toBe(200);
  const house = makers.body.result.data.makers.find((m) => m.route === 'platform');
  expect(house, JSON.stringify(makers.body).slice(0, 300)).toBeTruthy();
  const ask = async () => {
    const quoted = await me.post('/api/trade/trpc/rfq.quote', {
      side: 'buy',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      qty: '0.02',
      makerIds: [house.id],
    });
    expect(quoted.status, JSON.stringify(quoted.body).slice(0, 300)).toBe(200);
    return quoted.body.result.data.quoteId;
  };
  const acceptQuote = async (quoteId) => {
    const accepted = await me.post('/api/trade/trpc/rfq.accept', { quoteId });
    expect(accepted.status, JSON.stringify(accepted.body).slice(0, 300)).toBe(200);
  };
  const read = async (quoteId) => {
    const got = await me.get(`/api/trade/trpc/rfq.get?input=${encodeURIComponent(JSON.stringify({ quoteId }))}`);
    expect(got.status, JSON.stringify(got.body).slice(0, 300)).toBe(200);
    return got.body.result.data;
  };
  const quoteId = await ask();
  await acceptQuote(quoteId);
  const bound = await read(quoteId);
  expect(bound.lifecycle).toBe('bound');
  expect(bound.settleBy).toBeTruthy();
  await page.waitForTimeout(Math.max(0, Date.parse(bound.settleBy) - Date.now()) + 1_000);
  // A settled quote: asked, accepted and settled now, inside its window.
  const settledId = await ask();
  await acceptQuote(settledId);
  // The desk is the counterparty and sells from the house inventory: TEST BTC for this one settle, keyed by the quote.
  expect(fund('house', 'BTC', '0.02', `jco13-house-${settledId}`).tx).toBeTruthy();
  const settle = await me.post('/api/trade/trpc/otc.settle', { quoteId: settledId });
  expect(settle.status, JSON.stringify(settle.body).slice(0, 300)).toBe(200);
  expect((await read(settledId)).lifecycle).toBe('settled');
  // An open quote: asked and left alone, read inside its time to live.
  const openId = await ask();
  expect((await read(openId)).lifecycle).toBe('open');

  await moduleRoom(page);
  await page.getByRole('tab', { name: 'Quote desk' }).click();
  const quotes = page.getByRole('table', { name: 'Quotes', exact: true });
  await expect(cellOf(quotes, openId, 3)).toHaveText('open');
  await expect(cellOf(quotes, settledId, 3)).toHaveText('settled');
  await expect(cellOf(quotes, quoteId, 3)).toHaveText('bound');
  const exceptions = page.getByRole('table', { name: 'Settlement exceptions' });
  await expect(exceptions.locator('tbody tr', { hasText: `otc.settle:${quoteId}` })).toHaveCount(1);
  // Listing it changed nothing: the service's own record of the quote is still bound at the same price, not settled.
  expect(await read(quoteId)).toEqual(bound);
});
