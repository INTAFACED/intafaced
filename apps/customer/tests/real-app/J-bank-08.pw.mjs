import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { DEVICE_KEY, EDGE, ORIGIN, fund, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-08, in the running app (docs/roadmap/journeys.json): I earn on my savings. One TEST saver funded with TEST 1000
// USDT. The journey opens its own TEST pools through the bank's treasury doors, each approved by the stack's two TEST
// founders as an owner's change would be, so it never changes the stack's seeded pools that other journeys save in.
// Its USDT pools stay below the seeded instant-access pool's rate: journeys that pick the first USDT flexible pool the
// bank lists keep picking the seeded one. Step 1 (BK-earn-05): Earn lists the pools and the saver compares them side by
// side; the journey pool's page shows its rate history, three dated steps (opened at 1.5%, raised to 1.75%, cut to
// 1.25%), and says there is no earlier history before the first. Step 2 (BK-earn-02): the pool page reads what the
// pool publishes; the owner tables nobody has published (rate by balance, a commission on interest, a capacity) read
// "not set". Steps 3 to 8 (BK-earn-01, BK-earn-03, BK-earn-04) follow as their slices land; until then each stops at
// the first control its slice adds, quickly.
const J = 'J-bank-08';
const RUN = process.env.JOURNEY_RUN_ID ?? `local-${Date.now()}`;
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
/** How long a check on a room a later slice builds may wait: the room is not there, so this fails fast. */
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who) {
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
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        code: body?.error?.data?.intafacedCode ?? body?.error?.data?.cause?.code ?? body?.error?.data?.code,
        body,
      };
    return { ok: true, data: body.result.data };
  };
  return {
    query: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, {
        headers,
      }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
  };
}

let staffDoor;
async function founders() {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    return { gates, ctx, sessions: await gates.approverSessions(ctx) };
  })();
  return staffDoor;
}
/**
 * One treasury door of the bank, approved by the stack's two TEST founders. The approval is bound to `fields`, the
 * door's canonical strings; `input` is what the door is sent.
 */
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
  return ctx.edge.mutate('bank', procedure, { ...input, ...approval }, await sessions.a.treasuryToken());
}
/** A TEST pool the journey owns, opened through the treasury door. */
async function openPool({ kind, aprBps, termDays = null, minDeposit, label }) {
  const input = { poolId: randomUUID(), assetId: 'USDT', kind, name: `TEST ${J} ${label} ${RUN}`, aprBps, termDays, minDeposit };
  const fields = { ...input, aprBps: String(aprBps), termDays: termDays === null ? '' : String(termDays) };
  const res = await treasury('bank.ops.createEarnPool', 'ops.createEarnPool', input, fields);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return { id: input.poolId, name: input.name };
}
async function setRate(poolId, rateBps, reason) {
  const res = await treasury(
    'bank.ops.setEarnPoolRate',
    'ops.setEarnPoolRate',
    { poolId, rateBps, reason },
    { poolId, rateBps: String(rateBps), reason },
  );
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
}

function state() {
  const saved = run.read();
  if (!saved.who || !saved.pool) throw new Error(`${J} #1 made no saver or pool, so this step has nothing to act on`);
  return saved;
}
const poolPage = (poolId) => `/bank/earn/pool?id=${encodeURIComponent(poolId)}`;

test(`${J} #1 opens Earn and compares pools: pools side by side with rates, and a rate history of dated steps with no earlier history before the first`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'jb08');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '1000').tx).toBeTruthy();
  run.reset({ who });

  // The journey's own flexible pool: opened at 1.5% with a TEST minimum of 10, then raised and cut by approved changes.
  const pool = await openPool({ kind: 'flexible', aprBps: 150, minDeposit: '10', label: 'flexible' });
  run.write({ pool: pool.id, poolName: pool.name });
  expect(await setRate(pool.id, 175, 'TEST rate rise')).toMatchObject({ rateBps: 175, previousBps: 150 });
  expect(await setRate(pool.id, 125, 'TEST rate cut')).toMatchObject({ rateBps: 125, previousBps: 175 });

  const api = await bank(who);
  const pools = await api.query('earn.pools', { limit: 200 });
  expect(pools.ok, JSON.stringify(pools.body ?? {}).slice(0, 300)).toBe(true);
  const mine = pools.data.find((row) => row.id === pool.id);
  expect(mine).toMatchObject({ aprBps: 125, kind: 'flexible', minDeposit: '10' });
  const fixed = pools.data.find((row) => row.assetId === 'USDT' && row.kind === 'fixed');
  expect(fixed, 'the stack seeds a TEST fixed-term USDT pool').toBeTruthy();

  // Two pools side by side: their rates and terms differ and are marked; how interest is paid is the same.
  await signIn(page, who);
  await page.goto('/bank/earn');
  const compare = page.getByTestId('earn-compare');
  await expect(compare.getByTestId('earn-compare-few')).toBeVisible();
  await compare.locator(`input[data-pool="${pool.id}"]`).check();
  await compare.locator(`input[data-pool="${fixed.id}"]`).check();
  const table = compare.getByTestId('earn-compare-table');
  await expect(table.locator('thead th')).toHaveCount(2);
  const rate = table.locator('tr[data-row="rate"]');
  await expect(rate).toHaveAttribute('data-differs', 'true');
  await expect(rate.locator(`td[data-pool="${pool.id}"]`)).toHaveText('1.25%');
  await expect(rate.locator(`td[data-pool="${fixed.id}"]`)).toHaveText(`${fixed.aprBps / 100}%`);
  await expect(table.locator('tr[data-row="term"]')).toHaveAttribute('data-differs', 'true');
  await expect(table.locator('tr[data-row="payout"]')).toHaveAttribute('data-differs', 'false');
  await expect(table.locator(`tr[data-row="capacity"] td[data-pool="${pool.id}"]`)).toContainText('Not set');

  // Four at most: with four picked, a fifth cannot be added.
  const others = pools.data.filter((row) => row.id !== pool.id && row.id !== fixed.id).slice(0, 3);
  if (others.length >= 3) {
    await compare.locator(`input[data-pool="${others[0].id}"]`).check();
    await compare.locator(`input[data-pool="${others[1].id}"]`).check();
    await expect(table.locator('thead th')).toHaveCount(4);
    await expect(compare.getByTestId('earn-compare-full')).toBeVisible();
    await expect(compare.locator(`input[data-pool="${others[2].id}"]`)).toBeDisabled();
  }

  // The journey pool's own page, opened from the table: three dated steps, newest first, and nothing before the first.
  await table.getByRole('link', { name: `Open ${pool.name}` }).click();
  await expect(page).toHaveURL(new RegExp(`/bank/earn/pool\\?id=${pool.id}`));
  const history = page.getByTestId('earn-rate-history');
  await expect(history).toHaveAttribute('data-steps', '3');
  await expect(history.locator('svg circle')).toHaveCount(3);
  await expect(history.getByTestId('earn-rate-history-table').locator('tbody tr')).toHaveCount(3);
  const rows = history.getByTestId('earn-rate-history-table').locator('tbody tr');
  await expect(rows.nth(0)).toHaveAttribute('data-rate', '125');
  await expect(rows.nth(0)).toContainText('TEST rate cut');
  await expect(rows.nth(1)).toHaveAttribute('data-rate', '175');
  await expect(rows.nth(2)).toHaveAttribute('data-rate', '150');
  await expect(rows.nth(2)).toContainText('First rate on record');
  await expect(history.getByTestId('earn-rate-history-start')).toContainText('No earlier history');
  await expect(history).toContainText('Now: 1.25%');
  const recorded = await api.query('earn.rateHistory', { poolId: pool.id, limit: 50 });
  expect(recorded.data.changes.map((row) => row.rateBps)).toEqual([150, 175, 125]);
  expect(recorded.data.earlier).toBe(false);
});

test(`${J} #2 opens a pool: rate band, yield source, commission and reward asset from the owner's tables, and a blank table reads "not set"`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { who, pool } = state();
  await signIn(page, who);
  await page.goto(poolPage(pool));
  const facts = page.getByTestId('earn-pool-facts');
  await expect(page.getByTestId('earn-pool-status')).toHaveAttribute('data-status', 'open');
  await expect(facts.locator('[data-fact="rate"] dd')).toHaveText('1.25%');
  // No owner has published balance bands, a commission or a capacity: each reads "not set", never zero.
  await expect(facts.locator('[data-fact="bands"] dd')).toHaveText('Not set. The pool pays one rate on every balance.');
  await expect(facts.locator('[data-fact="commission"] dd')).toHaveText('Not set. No commission on interest is published for this pool.');
  await expect(facts.locator('[data-fact="capacity"] dd')).toHaveText('Not set. The bank publishes no cap for this pool.');
  // Where the interest comes from and what it is paid in are the bank's own facts.
  await expect(facts.locator('[data-fact="yield"] dd')).toContainText('reserve');
  await expect(facts.locator('[data-fact="paidIn"] dd')).toHaveText('USDT');
  await expect(facts.locator('[data-fact="payout"] dd')).toContainText('Every day');
  await expect(facts.locator('[data-fact="minimum"] dd')).toHaveText('10 USDT');
  const api = await bank(who);
  const read = await api.query('earn.pool', { poolId: pool });
  expect(read.data).toMatchObject({
    rateBands: null,
    commissionBps: null,
    capacity: null,
    rewardAssetId: 'USDT',
    yieldSource: 'pool_reserve',
  });
  // A pool that does not exist says so.
  await page.goto(poolPage(randomUUID()));
  await expect(page.getByRole('alert')).toContainText('This pool does not exist.');
});

test(`${J} #3 uses the calculator, then deposits below and above the minimum: bank.below_minimum, then waiting for accrual, then accruing`, async ({
  page,
}) => {
  const { who, pool } = state();
  await signIn(page, who);
  await page.goto(poolPage(pool));
  await expect(page.getByTestId('earn-calculator')).toBeVisible(UNBUILT);
});

test(`${J} #4 chooses a fixed term with auto-renew: the lock date, payout schedule and compounding, and early withdrawal refused`, async ({
  page,
}) => {
  const { who } = state();
  await signIn(page, who);
  await page.goto('/bank/earn');
  await expect(page.getByTestId('earn-auto-renew')).toBeVisible(UNBUILT);
});

test(`${J} #5 sees a payout: one payout per period posted, and the schedule shows the next date`, async ({ page }) => {
  const { who, pool } = state();
  await signIn(page, who);
  await page.goto(poolPage(pool));
  await expect(page.getByTestId('earn-payout-schedule')).toBeVisible(UNBUILT);
});

test(`${J} #6 opens a staking-style pool: unbonding states, pool status and a risk disclosure; a closed pool refuses deposits while existing positions keep accruing and can withdraw`, async ({
  page,
}) => {
  const { who, pool } = state();
  await signIn(page, who);
  await page.goto(poolPage(pool));
  await expect(page.getByTestId('earn-risk-disclosure')).toBeVisible(UNBUILT);
});

test(`${J} #7 turns on auto earn and opts in: the setting is saved, and a threshold must be above zero`, async ({ page }) => {
  const { who, pool } = state();
  await signIn(page, who);
  await page.goto(poolPage(pool));
  await expect(page.getByTestId('earn-auto-earn')).toBeVisible(UNBUILT);
});

test(`${J} #8 withdraws: the withdrawal posts once, and an unknown outcome is not retried by the page nor resolved by an empty position read`, async ({
  page,
}) => {
  const { who, pool } = state();
  await signIn(page, who);
  await page.goto(poolPage(pool));
  await expect(page.getByTestId('earn-withdraw')).toBeVisible(UNBUILT);
});
