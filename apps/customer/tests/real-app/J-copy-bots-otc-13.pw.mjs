import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { approverSessions, makeContext, setFeeDiscountSchedule } from '../../../../tooling/scripts/local-test-gates.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { api, bestPrices, fund, journeyState, toUnits, tool } from './stack.mjs';
import { fundedTrader, signIn } from './desk.mjs';
import { followOnScreen, listLeader } from './copy.mjs';

// J-copy-bots-otc-13, in the running app (docs/roadmap/journeys.json): support finds a customer's follows, bots and OTC
// quotes and reads the module numbers, on the founder console. One test per step, titled "J-copy-bots-otc-13 #<n>", run
// in order. #2 makes the customer: a verified TEST account following a TEST leader once, with two TEST bots made through
// its own algo door, stopped once looked up. The founder signs in with the lookup scope; the stack has no support agent
// without it, so #3 uses a founder session whose scope list leaves lookup out (`local-test-gates.mjs scoped-session`).
// #4 makes a real failed settlement: a TEST quote accepted and left past the desk's settle window, then listed with its
// saga key while the service's own record of the quote stays bound.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #2: the local stack's founder session carries no lookup scope until identity's founder scope list names it.
// - #3: the stack has no scoped founder session until `local-test-gates.mjs scoped-session` lands.
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

test(`${J} #1 opens the module metrics: counts with their window and as-of time; a failed source reads "Could not load", never zero`, async ({
  page,
}) => {
  run.reset({});
  await moduleRoom(page);
  const metrics = page.getByRole('region', { name: 'Module metrics' });
  await expect(metrics).toContainText(/Active copiers\s*(\d+|Could not load)/);
  await expect(metrics).toContainText(/As of \d/);
  await expect(metrics).toContainText(/Window/);
});

test(`${J} #2 looks up a customer with one follow and two bots: listed with their statuses`, async ({ page, browser }) => {
  test.setTimeout(360_000);
  const tag = Date.now().toString(36);
  const leader = await fundedTrader(page, 'jcl13', '10');
  const leaderRef = await listLeader(leader, `Journey Lookup ${tag}`);
  const customer = await fundedTrader(page, 'jcc13', '1000');
  await signIn(page, customer);
  await followOnScreen(page, customer, leaderRef, { perOrder: '20', total: '40', fixed: '10' });
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
    await expect(desk.getByRole('table', { name: 'Follows' }).locator('tbody tr')).toHaveCount(1);
    await expect(desk.getByRole('table', { name: 'Follows' })).toContainText('Active');
    await expect(desk.getByRole('table', { name: 'Bots' }).locator('tbody tr')).toHaveCount(2);
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
  const trader = await fundedTrader(page, 'jco13', '2000');
  const me = await api(trader);
  await stakeReadable(me);
  await stakeToDeskFloor(trader, me);
  const makers = await me.get('/api/trade/trpc/otc.makers.list');
  expect(makers.status, JSON.stringify(makers.body).slice(0, 300)).toBe(200);
  const house = makers.body.result.data.makers.find((m) => m.route === 'platform');
  expect(house, JSON.stringify(makers.body).slice(0, 300)).toBeTruthy();
  const quoted = await me.post('/api/trade/trpc/rfq.quote', {
    side: 'buy',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    qty: '0.02',
    makerIds: [house.id],
  });
  expect(quoted.status, JSON.stringify(quoted.body).slice(0, 300)).toBe(200);
  const quoteId = quoted.body.result.data.quoteId;
  const accepted = await me.post('/api/trade/trpc/rfq.accept', { quoteId });
  expect(accepted.status, JSON.stringify(accepted.body).slice(0, 300)).toBe(200);
  const read = async () => {
    const got = await me.get(`/api/trade/trpc/rfq.get?input=${encodeURIComponent(JSON.stringify({ quoteId }))}`);
    expect(got.status, JSON.stringify(got.body).slice(0, 300)).toBe(200);
    return got.body.result.data;
  };
  const bound = await read();
  expect(bound.lifecycle).toBe('bound');
  expect(bound.settleBy).toBeTruthy();
  await page.waitForTimeout(Math.max(0, Date.parse(bound.settleBy) - Date.now()) + 1_000);

  await moduleRoom(page);
  await page.getByRole('tab', { name: 'Quote desk' }).click();
  await expect(page.getByRole('table', { name: 'Quotes' })).toBeVisible();
  const exceptions = page.getByRole('table', { name: 'Settlement exceptions' });
  await expect(exceptions.locator('tbody tr', { hasText: `otc.settle:${quoteId}` })).toHaveCount(1);
  // Listing it changed nothing: the service's own record of the quote is still bound at the same price, not settled.
  expect(await read()).toEqual(bound);
});
