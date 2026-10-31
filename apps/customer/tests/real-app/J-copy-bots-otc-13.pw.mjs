import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './journey.mjs';
import { approverSessions, makeContext, setFeeDiscountSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, bestPrices, fund, journeyState, toUnits, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { followOnScreen, listLeader, userIdOf } from './copy.mjs';

// J-copy-bots-otc-13, in the running app (docs/roadmap/journeys.json): support finds a customer's follows, bots and OTC
// quotes and reads the module numbers, on the founder console. One test per step, titled "J-copy-bots-otc-13 #<n>", run
// in order. Every value the room shows is held to what svc-trade itself answers: founder b asks the same operator doors
// through svc-edge (`admin.copyBotsOtc.*`), and the customer reads its own follow and bots.
// #1 first makes the customer (a verified TEST account following a TEST leader once, with two TEST bots made through its
// own algo door), so the live counts are not zero. #1 has two more tests: one source failing alone (svc-trade's own
// database role loses its read of the follows table, given back after) and svc-trade restarted with a blank window.
// #2 looks the customer up as founder a; "#2 as a support operator" is red, named for its blocker.
// #3 uses a founder session whose scope list leaves lookup out (`local-test-gates.mjs scoped-session`).
// #4 makes a real failed settlement (a TEST quote accepted and left past the desk's settle window), a settled quote and
// an open quote, and reads each back on the desk by its id. The bots are stopped once the file is done, pass or fail.
// A room that is not there fails at its heading, quickly (UNBUILT).
const J = 'J-copy-bots-otc-13';
const ONE = toUnits('1');
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
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

const COUNTS = {
  activeCopiers: 'Active copiers',
  activeBots: 'Active bots',
  rfqsRequested: 'Quotes requested in the window',
  rfqsSettled: 'Quotes settled in the window',
};
const STAMP = String.raw`\d{4}-\d\d-\d\d \d\d:\d\d:\d\d`;
const METRIC_UNAVAILABLE = 'trade.ops_metric_unavailable';
/** A time as the room prints it (copy-bots-otc.tsx `when`): UTC, to the second. */
const when = (iso) => iso.replace('T', ' ').slice(0, 19);
/** A follow's state as the lookup shows it (svc-trade admin/copy-bots-otc.ts FOLLOW_STATE; past its expiry, Expired). */
const FOLLOW_STATE = { ACTIVE: 'Active', PAUSED: 'Paused', STOPPING: 'Stopping', DETACHED: 'Detached' };
const followState = (follow, at) =>
  follow.relationshipState === 'ACTIVE' && Date.parse(follow.expiresAt) <= at ? 'Expired' : FOLLOW_STATE[follow.relationshipState];
const byBot = (a, b) => a.botId.localeCompare(b.botId);

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

/**
 * Founder b's own signed-in session, asking svc-trade's operator doors through svc-edge as the console does. What it
 * answers is the bar the room is held to.
 */
async function founderReads() {
  const ctx = await makeContext({ log: () => undefined });
  const pair = await approverSessions(ctx);
  const raw = (proc, input) => ctx.edge.query('trade', `admin.copyBotsOtc.${proc}`, input, pair.b.token);
  const ask = async (proc, input) => {
    const res = await raw(proc, input);
    expect(res.status, `${proc}: ${res.text.slice(0, 300)}`).toBe(200);
    return res.json.result.data;
  };
  return {
    ctx,
    pair,
    raw,
    metrics: () => ask('metrics'),
    lookup: (userId) => ask('lookup', { userId }),
    quoteDesk: () => ask('quoteDesk'),
  };
}

/** svc-trade's own database role on the stack (loopback, the marker's postgres port, the stack's secret). */
function tradeDb(ctx) {
  const postgres = createRequire(path.join(REPO, 'services', 'svc-trade', 'package.json'))('postgres');
  const port = ctx.marker.ports.postgres ?? 15460;
  return postgres(`postgres://svc_trade:${encodeURIComponent(ctx.secrets.pgService)}@127.0.0.1:${port}/intafaced_local_test`, {
    max: 1,
    onnotice: () => {},
  });
}

/** Each count the region shows, held between svc-trade's own answers before and after the page was read. */
async function countsBetween(metrics, before, after, skip = []) {
  for (const [key, label] of Object.entries(COUNTS)) {
    if (skip.includes(key)) continue;
    const shownCell = metricValue(metrics, label);
    await expect(shownCell).toHaveText(/^\d+$/);
    const shown = Number(await shownCell.textContent());
    expect(shown, label).toBeGreaterThanOrEqual(Math.min(before[key].value, after[key].value));
    expect(shown, label).toBeLessThanOrEqual(Math.max(before[key].value, after[key].value));
  }
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

/** Each bot's status as the customer's own algo read gives it. */
async function botStatuses(me, bots) {
  const out = [];
  for (const algoId of bots) {
    const got = await me.get(`/api/trade/trpc/algo.get?input=${encodeURIComponent(JSON.stringify({ algoId }))}`);
    expect(got.status, JSON.stringify(got.body).slice(0, 300)).toBe(200);
    out.push({ botId: algoId, status: got.body.result.data.status });
  }
  return out;
}

/** The customer's own follow, as its follow list gives it. */
async function ownFollow(me, followId) {
  const listed = await me.get(`/api/trade/trpc/copy.listMyFollows?input=${encodeURIComponent(JSON.stringify({ limit: 500 }))}`);
  expect(listed.status, JSON.stringify(listed.body).slice(0, 300)).toBe(200);
  const follow = listed.body.result.data.find((f) => f.followId === followId);
  expect(follow, JSON.stringify(listed.body).slice(0, 300)).toBeTruthy();
  return follow;
}

test.afterAll(async () => {
  // The bots' slices buy on TEST money until stopped: each one still active is stopped once the file is done.
  const { customer, bots } = run.read();
  if (!customer || !bots?.length) return;
  const me = await api(customer);
  const stopped = [];
  for (const { botId, status } of await botStatuses(me, bots)) {
    if (status === 'active') stopped.push(await me.post('/api/trade/trpc/algo.cancel', { algoId: botId }));
  }
  expect(
    stopped.map((r) => r.status),
    JSON.stringify(stopped.map((r) => r.body)).slice(0, 600),
  ).toEqual(stopped.map(() => 200));
});

test(`${J} #1 opens the module metrics: counts with their window and as-of time`, async ({ page, browser }) => {
  test.setTimeout(360_000);
  run.reset({});
  // The customer #2 looks up, made first so svc-trade has an active copier and active bots to count.
  const tag = Date.now().toString(36);
  const leader = await fundedTrader(page, 'jcl13', '10');
  const leaderName = `Journey Lookup ${tag}`;
  const leaderRef = await listLeader(leader, leaderName);
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
      clientAlgoId: `${J}-1-${n}-${tag}`,
      kind: 'twap',
    });
    expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
    bots.push(made.body.result.data.id);
  }
  run.write({ customer, customerId: await userIdOf(customer), leaderName, followId, bots });

  const reads = await founderReads();
  const before = await reads.metrics();
  const desk = await (await browser.newContext()).newPage();
  await moduleRoom(desk);
  const metrics = desk.getByRole('region', { name: 'Module metrics' });
  await expect(metricValue(metrics, 'As of')).toHaveText(new RegExp(`^${STAMP} UTC$`));
  const after = await reads.metrics();
  for (const read of [before, after]) {
    // svc-trade counts this customer's follow and bots, and every source answered.
    expect(read.activeCopiers.value).toBeGreaterThanOrEqual(1);
    expect(read.activeBots.value).toBeGreaterThanOrEqual(1);
    for (const key of Object.keys(COUNTS)) expect(read[key].unavailable, key).toBeNull();
    expect(read.window.to).toBe(read.asOf);
    expect(Date.parse(read.window.from)).toBe(Date.parse(read.asOf) - read.window.seconds * 1000);
    // The stack's TEST window (tooling/profiles/test-owner-values/trade.json), which the room reads as 1 day.
    expect(read.window.seconds).toBe(86_400);
  }
  await expect(metrics.getByText('Module metrics could not be read')).toHaveCount(0);
  await countsBetween(metrics, before, after);
  // The room's own read fell between the two: its as-of time, and the window ending at it.
  const asOf = (await metricValue(metrics, 'As of').textContent()).replace(/ UTC$/, '');
  expect(asOf >= when(before.asOf) && asOf <= when(after.asOf), `${when(before.asOf)} ≤ ${asOf} ≤ ${when(after.asOf)}`).toBe(true);
  const from = when(new Date(Date.parse(`${asOf.replace(' ', 'T')}Z`) - after.window.seconds * 1000).toISOString());
  await expect(metricValue(metrics, 'Window')).toHaveText(`1 day, ${from} to ${asOf} UTC`);
  await expect(metrics).toContainText(`As of ${asOf} UTC, over the last 1 day.`);
  await desk.context().close();
});

test(`${J} #1 one failing source reads "Could not load" with its code; the others still count`, async ({ page }) => {
  test.setTimeout(300_000);
  const reads = await founderReads();
  await founderSignIn(page, 'a');
  const sql = tradeDb(reads.ctx);
  try {
    // svc-trade's own role loses its read of the follows table, so the active-copiers count alone fails.
    await sql`REVOKE SELECT ON trade.copy_follows FROM svc_trade`;
    const before = await reads.metrics();
    await page.goto(`${ADMIN}/trade-ops/copy-bots-otc`);
    await expect(page.getByRole('heading', { name: 'Copy, bots and OTC', level: 1 })).toBeVisible(UNBUILT);
    const metrics = page.getByRole('region', { name: 'Module metrics' });
    await expect(metricValue(metrics, 'As of')).toHaveText(new RegExp(`^${STAMP} UTC$`));
    const after = await reads.metrics();
    for (const read of [before, after]) {
      expect(read.activeCopiers).toEqual({ value: null, unavailable: METRIC_UNAVAILABLE });
      for (const key of ['activeBots', 'rfqsRequested', 'rfqsSettled']) expect(read[key].unavailable, key).toBeNull();
    }
    await expect(metrics.getByText('Module metrics could not be read')).toHaveCount(0);
    const copiers = metricValue(metrics, 'Active copiers');
    await expect(copiers).toHaveText(new RegExp(`^Could not load\\s*${METRIC_UNAVAILABLE.replaceAll('.', '\\.')}$`));
    await expect(copiers.locator('span')).toHaveText(METRIC_UNAVAILABLE);
    await countsBetween(metrics, before, after, ['activeCopiers']);
  } finally {
    try {
      await sql`GRANT SELECT ON trade.copy_follows TO svc_trade`;
    } finally {
      await sql.end();
    }
  }
  await expect.poll(async () => (await reads.metrics()).activeCopiers.unavailable).toBeNull();
});

test(`${J} #1 a blank window reads "Could not load" for every count, never zero`, async ({ page }) => {
  test.setTimeout(300_000);
  const reads = await founderReads();
  // Signed in before the restart, so the console is asked nothing from this process while svc-trade restarts.
  await founderSignIn(page, 'a');
  try {
    tradeMetricsWindow(false);
    const refused = await reads.raw('metrics');
    expect(refused.status, refused.text.slice(0, 300)).not.toBe(200);
    expect(refused.text).toContain('trade.ops_metrics_window_not_set');
    await page.goto(`${ADMIN}/trade-ops/copy-bots-otc`);
    await expect(page.getByRole('heading', { name: 'Copy, bots and OTC', level: 1 })).toBeVisible(UNBUILT);
    const metrics = page.getByRole('region', { name: 'Module metrics' });
    await expect(metrics.getByText('Module metrics could not be read')).toBeVisible();
    await expect(metrics.locator('[data-slot="empty-state-code"]')).toHaveText('trade.ops_metrics_window_not_set');
    for (const label of Object.values(COUNTS)) {
      await expect(metricValue(metrics, label)).toHaveText('Could not load');
      await expect(metricValue(metrics, label)).not.toHaveText(/^0$/);
    }
    await expect(metricValue(metrics, 'Window')).toHaveText('Not read');
  } finally {
    tradeMetricsWindow(true);
  }
  await expect.poll(async () => (await reads.raw('metrics')).status).toBe(200);
});

test(`${J} #2 looks up a customer with one follow and two bots: listed with their statuses`, async ({ page }) => {
  test.setTimeout(180_000);
  const customer = state('customer');
  const followId = state('followId');
  const bots = state('bots');
  const me = await api(customer);
  const reads = await founderReads();
  await moduleRoom(page);
  const follow = await ownFollow(me, followId);
  const held = await botStatuses(me, bots);
  const lookedUp = await reads.lookup(state('customerId'));
  // Both live, so the rows below are statuses svc-trade holds now, not a leftover.
  expect(follow.relationshipState).toBe('ACTIVE');
  expect(held.map((b) => b.status)).toEqual(['active', 'active']);
  await page.getByRole('searchbox', { name: 'Find a customer' }).fill(customer.email);
  await page.getByRole('searchbox', { name: 'Find a customer' }).press('Enter');
  // Each row read back by its own id, with its status as svc-trade gives it and the room maps it.
  const follows = page.getByRole('table', { name: 'Follows', exact: true });
  await expect(follows.locator('tbody tr')).toHaveCount(1);
  const shownState = followState(follow, Date.now());
  await expect(cellOf(follows, followId, 1)).toHaveText(shownState);
  const leaderCell = lookedUp.follows.find((f) => f.followId === followId)?.leader;
  expect(leaderCell).toBe(state('leaderName'));
  await expect(cellOf(follows, followId, 0)).toHaveText(leaderCell);
  const listed = page.getByRole('table', { name: 'Bots', exact: true });
  await expect(listed.locator('tbody tr')).toHaveCount(2);
  for (const { botId, status } of held) await expect(cellOf(listed, botId, 3)).toHaveText(status);
  run.write({ seen: { follows: [{ followId, state: shownState }], bots: [...held].sort(byBot) } });
});

test(`${J} #2 as a support operator`, async () => {
  throw new Error(
    `${J} #2 as a support operator is blocked: the founder console has no non-founder staff login, so no support ` +
      'operator can sign in to look a customer up. #2 above runs as founder a.',
  );
});

test(`${J} #3 looks up as an agent without the lookup scope: refused`, async ({ page }) => {
  test.setTimeout(180_000);
  const customerId = state('customerId');
  const seen = state('seen');
  const reads = await founderReads();
  const sql = tradeDb(reads.ctx);
  const audited = async (operatorId, since) =>
    (
      await sql`SELECT count(*)::int AS n FROM trade.operator_audit
        WHERE kind = 'copy_bots_otc.lookup' AND operator_id = ${operatorId} AND account_id = ${customerId} AND occurred_at >= ${since}`
    )[0].n;
  try {
    // What the lookup reads just before the refusal. #2's own snapshot can be stale here: when a step of this file fails
    // (the support-operator step always does, by name), Playwright starts a fresh worker and runs afterAll, which
    // cancels the bots. The follow is read against #2's snapshot too, since afterAll never touches it.
    const before = await reads.lookup(customerId);
    const project = (r) => ({
      follows: r.follows.map((f) => ({ followId: f.followId, state: f.state })),
      bots: r.bots.map((b) => ({ botId: b.botId, status: b.status })).sort(byBot),
    });
    expect(project(before).follows).toEqual(seen.follows);
    expect(project(before).bots.map((b) => b.botId)).toEqual(seen.bots.map((b) => b.botId));
    const [{ since }] = await sql`SELECT now() AS since`;
    await page.goto(`${ADMIN}/login`);
    const out = JSON.parse(tool('local-test-gates.mjs', 'scoped-session', '--without', 'support:lookup'));
    await page.context().addCookies(out.cookies);
    await page.goto(`${ADMIN}/trade-ops/copy-bots-otc?customer=${encodeURIComponent(state('customer').email)}`);
    await expect(page.getByText(/You don’t have the lookup permission/)).toBeVisible();
    // Refused by the typed scope code, naming the scope, and none of the customer's records reached the screen.
    const refusal = page.locator('[data-outcome="refused"]');
    await expect(refusal.locator('code')).toHaveText('scope.denied');
    await expect(refusal).toContainText('support:lookup');
    for (const name of ['Follows', 'Bots', 'Customer quotes']) await expect(page.getByRole('table', { name, exact: true })).toHaveCount(0);
    // The same page still reads the module numbers, which need no lookup scope.
    const metrics = page.getByRole('region', { name: 'Module metrics' });
    await expect(metrics.getByText('Module metrics could not be read')).toHaveCount(0);
    for (const label of Object.values(COUNTS)) await expect(metricValue(metrics, label)).toHaveText(/^\d+$/);
    // The scoped session (founder a, lookup left out) read nothing, so svc-trade audited no lookup by it.
    expect(await audited(reads.pair.a.op.userId, since)).toBe(0);
    // The refusal changed nothing: founder b's own lookup reads the follow and both bots exactly as just before it, and
    // that read is audited once, which shows the audit query sees a lookup when there is one.
    const again = await reads.lookup(customerId);
    expect(project(again)).toEqual(project(before));
    expect(await audited(reads.pair.b.op.userId, since)).toBe(1);
  } finally {
    await sql.end();
  }
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

  const reads = await founderReads();
  await moduleRoom(page);
  await page.getByRole('tab', { name: 'Quote desk' }).click();
  const quotes = page.getByRole('table', { name: 'Quotes', exact: true });
  await expect(cellOf(quotes, openId, 3)).toHaveText(/\S/);
  // svc-trade's own desk read, as the room showed it: each quote's status, and the one exception with its saga key.
  const desk = await reads.quoteDesk();
  const lifecycleOf = (id) => desk.quotes.find((q) => q.quoteId === id)?.lifecycle;
  expect([lifecycleOf(openId), lifecycleOf(settledId), lifecycleOf(quoteId)]).toEqual(['open', 'settled', 'bound']);
  for (const id of [openId, settledId, quoteId]) await expect(cellOf(quotes, id, 3)).toHaveText(lifecycleOf(id));
  const exception = desk.exceptions.find((e) => e.quoteId === quoteId);
  expect(exception, JSON.stringify(desk.exceptions).slice(0, 600)).toBeTruthy();
  expect(exception.reason).toBe('not_settled_by_deadline');
  expect(desk.exceptions.map((e) => e.quoteId)).not.toContain(openId);
  expect(desk.exceptions.map((e) => e.quoteId)).not.toContain(settledId);
  const exceptions = page.getByRole('table', { name: 'Settlement exceptions' });
  await expect(cellOf(exceptions, exception.sagaKey, 0)).toHaveText(exception.sagaKey);
  await expect(cellOf(exceptions, exception.sagaKey, 1)).toHaveText('Not settled by its deadline');
  await expect(cellOf(exceptions, exception.sagaKey, 3)).toHaveText(when(exception.deadline));
  for (const id of [openId, settledId]) await expect(exceptions.locator('tbody tr', { hasText: id })).toHaveCount(0);
  // Listing it changed nothing: the service's own record of the quote is still bound at the same price, not settled.
  expect(await read(quoteId)).toEqual(bound);
});
