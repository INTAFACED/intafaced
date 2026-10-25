import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { localStackState } from '../../../../tooling/scripts/local-test-state.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, fromUnits, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-08, in the running app (docs/roadmap/journeys.json): I earn on my savings. One TEST saver funded with TEST 1000
// USDT. The journey opens its own TEST pools through the bank's treasury doors, each approved by the stack's two TEST
// founders as an owner's change would be, so it never changes the stack's seeded pools that other journeys save in.
// Its USDT pools stay below the seeded instant-access pool's rate: journeys that pick the first USDT flexible pool the
// bank lists keep picking the seeded one. Step 1 (BK-earn-05): Earn lists the pools and the saver compares them side by
// side; the journey pool's page shows its rate history, three dated steps (opened at 1.5%, raised to 1.75%, cut to
// 1.25%), and says there is no earlier history before the first. Step 2 (BK-earn-02): the pool page reads what the
// pool publishes; the owner tables nobody has published (rate by balance, a commission on interest, a capacity) read
// "not set". Step 3 (BK-earn-01, BK-earn-03): the pool page's calculator works out TEST 100 at the pool's rate the way
// the bank pays it; a deposit under the minimum is refused, TEST 100 waits for its first full UTC day, and once the
// bank's own accrual job (signed as its scheduler, the stack has no timer) pays that day the saving is accruing and the
// day paid is the calculator's figure to the unit. The pool's TEST reserve comes from `local-test-seed.mjs
// fund-earn-pool`, the seed's own funding move. Step 7: auto earn into the pool refuses a keep-amount of zero, then
// saves one. Step 8: the answer to taking the saving back is lost on the way to the page; the bank took it back once,
// the page sends nothing again, and the empty list afterwards does not settle the lost answer. Steps 4 to 6 (BK-earn-03,
// BK-earn-04) follow as their slices land; until then each stops at the first control its slice adds, quickly.
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

let jobCtx;
/** One day of earn interest for one pool, through the bank's job procedure signed as its scheduler would sign it. */
async function accrue(poolId, at) {
  jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} }));
  const ctx = await jobCtx;
  const raw = JSON.stringify({ poolId, at: at.toISOString() });
  const res = await fetch(`${ctx.url('bank')}/trpc/ops.accrueInterest`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', ...ctx.contracts.serviceAuthHeadersForBody('svc-bank', ctx.secrets.internal, raw) },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const parsed = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`ops.accrueInterest refused: ${res.status} ${JSON.stringify(parsed).slice(0, 300)}`);
  return parsed.result.data.results[0];
}
/** The journey pool's TEST reserve, moved by the seed's own funding step; `ref` keys it, so a retry funds once. */
function fundReserve(poolId, amount, ref) {
  return execFileSync(
    process.execPath,
    [path.join(ROOT, 'tooling/scripts/local-test-seed.mjs'), 'fund-earn-pool', poolId, amount, ref, '--state', localStackState()],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LOCAL_TEST: '1' }, timeout: 60_000 },
  );
}
/** One day of the bank's interest on `principal` at `bps`, as it pays it: the year's interest and then the day, cut down. */
const daily = (principal, bps) => (toUnits(principal) * BigInt(bps)) / 10_000n / 365n;
async function mainUsdt(api) {
  const res = await api.query('spaces.list', { limit: 50 });
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 300)).toBe(true);
  return toUnits(res.data.find((s) => s.kind === 'primary' && s.assetId === 'USDT').balance);
}
async function confirm(dialog, submit) {
  await dialog.getByRole('button', { name: submit, exact: true }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });
}
async function close(page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
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
  test.setTimeout(180_000);
  const { who, pool } = state();
  const api = await bank(who);
  await signIn(page, who);
  await page.goto(poolPage(pool));

  // The calculator: TEST 100 for 30 days at the pool's 1.25%, each day as the bank pays it, and the formula said.
  const calculator = page.getByTestId('earn-calculator');
  await calculator.getByLabel('Amount (USDT)').fill('100');
  await calculator.getByLabel('Days saved').fill('30');
  const perDay = fromUnits(daily('100', 125));
  const result = calculator.getByTestId('earn-calculator-result');
  await expect(result).toHaveAttribute('data-per-day', perDay);
  await expect(result).toHaveAttribute('data-total', fromUnits(daily('100', 125) * 30n));
  await expect(result).toContainText(`${perDay} USDT`);
  await expect(calculator.getByTestId('earn-calculator-formula')).toContainText('1.25% ÷ 365');

  // Under the pool's TEST minimum of 10: the form says so, and the bank itself refuses it.
  const deposit = page.getByTestId('earn-pool-deposit');
  await deposit.getByRole('button', { name: 'Deposit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Amount (USDT)').fill('5');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await expect(dialog).toContainText('The amount is below this pool’s minimum of 10 USDT.');
  const refused = await api.mutate('earn.deposit', { poolId: pool, positionId: randomUUID(), amount: '5' });
  expect(refused).toMatchObject({ ok: false, code: 'bank.below_minimum' });
  expect((await api.query('earn.positions', { limit: 50, poolId: pool })).data).toEqual([]);

  // TEST 100 saved: it waits for its first full UTC day.
  await dialog.getByLabel('Amount (USDT)').fill('100');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await confirm(dialog, 'Deposit');
  await close(page);
  const saved = await api.query('earn.positions', { limit: 50, poolId: pool });
  expect(saved.data).toHaveLength(1);
  const [position] = saved.data;
  // Its first day begins at the UTC midnight after it opened.
  const firstDay = new Date(`${position.openedAt.slice(0, 10)}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000;
  expect(position).toMatchObject({ principal: '100', accrual: 'waiting', accruesFrom: new Date(firstDay).toISOString() });
  run.write({ position: position.id });
  await page.reload();
  const card = page.locator(`[data-testid="earn-pool-position"][data-position="${position.id}"]`);
  await expect(card.getByTestId('earn-pool-accrual')).toHaveAttribute('data-state', 'waiting');
  await expect(card.getByTestId('earn-pool-accrual')).toContainText('Waiting for accrual: interest starts');
  await expect(page.getByTestId('earn-pool-earned')).toContainText('No interest has been paid to you from this pool.');

  // The bank's job pays that first day from the pool's TEST reserve: the saving is accruing, and the day paid is the
  // calculator's figure for one day, exactly.
  expect(fundReserve(pool, '10', 'jb08-reserve')).toContain('reserve funded 10 USDT');
  const day = await accrue(pool, new Date(firstDay + 60 * 60 * 1000));
  expect(day).toMatchObject({ paid: perDay, recipients: 1, alreadyAccrued: false });
  await page.reload();
  await expect(card.getByTestId('earn-pool-accrual')).toHaveAttribute('data-state', 'accruing');
  const earned = page.getByTestId('earn-pool-earned');
  await expect(earned).toHaveAttribute('data-total', perDay);
  await expect(earned.getByTestId('earn-pool-earned-day')).toHaveCount(1);
  await expect(earned.getByTestId('earn-pool-earned-day')).toHaveAttribute('data-amount', perDay);
  await expect(earned.getByTestId('earn-pool-earned-day')).toHaveAttribute('data-bps', '125');
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
  test.setTimeout(120_000);
  const { who, pool } = state();
  const api = await bank(who);
  await signIn(page, who);
  await page.goto(poolPage(pool));
  const auto = page.getByTestId('earn-auto-earn');
  await auto.getByRole('button', { name: 'Turn on auto earn', exact: true }).click();
  const dialog = page.getByRole('dialog');

  // Zero to keep is refused by the form and by the bank, and nothing is saved.
  await dialog.getByLabel('Keep available (USDT)').fill('0');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await expect(dialog).toContainText('Enter an exact decimal amount greater than zero.');
  const zero = await api.mutate('autoInvest.createThresholdSweep', { assetId: 'USDT', targetPoolId: pool, threshold: '0' });
  expect(zero).toMatchObject({ ok: false, code: 'bank.auto_invest_invalid_threshold' });
  const none = await api.query('autoInvest.list', { limit: 200 });
  expect(none.data.filter((rule) => rule.targetPoolId === pool)).toEqual([]);

  // Keep TEST 50: saved by the bank and shown on the pool's page.
  await dialog.getByLabel('Keep available (USDT)').fill('50');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await confirm(dialog, 'Turn on auto earn');
  await close(page);
  const rules = (await api.query('autoInvest.list', { limit: 200 })).data.filter((rule) => rule.targetPoolId === pool);
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ kind: 'threshold_sweep', assetId: 'USDT', threshold: '50', status: 'active' });
  await page.reload();
  const rule = auto.locator(`[data-testid="earn-auto-earn-rule"][data-rule="${rules[0].id}"]`);
  await expect(rule).toHaveAttribute('data-status', 'active');
  await expect(rule).toContainText('Auto earn is on: keep 50 USDT available, the rest moves into this pool.');
});

test(`${J} #8 withdraws: the withdrawal posts once, and an unknown outcome is not retried by the page nor resolved by an empty position read`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { who, pool, position } = state();
  if (!position) throw new Error(`${J} #3 saved nothing, so there is nothing to take back`);
  const api = await bank(who);
  const before = await mainUsdt(api);
  await signIn(page, who);
  await page.goto(poolPage(pool));

  // The bank takes the saving back, and its answer is lost on the way to the page.
  let sent = 0;
  await page.route('**/api/bank/trpc/earn.withdraw**', async (route) => {
    sent += 1;
    await route.fetch();
    await route.abort('failed');
  });
  const card = page.locator(`[data-testid="earn-pool-position"][data-position="${position}"]`);
  await card.getByTestId('earn-withdraw').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Take back', exact: true }).click();
  await expect(dialog).toContainText('This request may have completed', { timeout: 30_000 });
  await expect(dialog).not.toContainText('Confirmed by the service');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();

  // Posted once: the whole TEST 100 is back in the account once, and the saving is closed.
  expect(sent).toBe(1);
  expect(await mainUsdt(api)).toBe(before + toUnits('100'));
  expect((await api.query('earn.positions', { limit: 50, poolId: pool })).data).toEqual([]);

  // The list no longer shows the saving, and that does not settle the lost answer: its reference stays to check.
  await page.getByRole('button', { name: 'Refresh', exact: true }).first().click();
  await expect(page.getByText('You have no savings in this pool.', { exact: true })).toBeVisible();
  await expect(page.locator('#bank-unconfirmed')).toBeVisible();
  expect(sent).toBe(1);
  // Interest already paid stays listed.
  await expect(page.getByTestId('earn-pool-earned').getByTestId('earn-pool-earned-day')).toHaveCount(1);
});
