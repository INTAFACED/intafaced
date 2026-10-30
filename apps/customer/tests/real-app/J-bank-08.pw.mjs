import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { localStackState } from '../../../../tooling/scripts/local-test-state.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, ROOT, fromUnits, fund, journeyState, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-08, in the running app (docs/roadmap/journeys.json): I earn on my savings. One TEST saver funded with TEST 1000
// USDT. The journey opens its own TEST pools through the bank's treasury doors, each approved by the stack's two TEST
// founders as an owner's change would be, so it never changes the stack's seeded pools that other journeys save in.
// Its USDT pools stay below the seeded instant-access pool's rate: journeys that pick the first USDT flexible pool the
// bank lists keep picking the seeded one. Step 1 (BK-earn-05): Earn lists the pools and the saver compares them side by
// side; the journey pool's page shows its rate history, three dated steps (opened at 1.25%, raised to 1.75%, cut back
// to 1.25%), and says there is no earlier history before the first. Step 2 (BK-earn-02): the pool page reads what the
// pool publishes; the owner tables nobody has published (rate by balance, a commission on interest, a capacity) read
// "not set". Step 3 (BK-earn-01, BK-earn-03): the pool page's calculator works out TEST 100 at the pool's rate the way
// the bank pays it; a deposit under the minimum is refused, TEST 100 waits for its first full UTC day, and once the
// bank's own accrual job (signed as its scheduler, the stack has no timer) pays that day the saving is accruing and the
// day paid is the calculator's figure to the unit. The job pays only a day that has begun, so the journey moves a
// saving's opening back with `local-test-seed.mjs age-earn-position` and pays yesterday or today, never a day ahead;
// the rate changes are all recorded today, so a day that began before them pays the pool's opening rate, 1.25%. The pool's TEST reserve comes from `local-test-seed.mjs
// fund-earn-pool`, the seed's own funding move. Step 4 (BK-earn-03): in a TEST 30-day pool of the journey's own, a
// saving shows its lock date, its daily payout schedule and that nothing compounds; the page offers no early take back
// and the bank refuses one with the date; auto-renew turned on, the bank's renewal job (signed as its scheduler) starts
// one new term of the same amount at the term's end and moves no money, and a second run renews nothing. Step 5: the
// schedule names the next payout day; the job pays that day once however often it runs, and the schedule moves on a
// day. Step 7: auto earn into the pool refuses a keep-amount of zero, then saves one. Step 8: the answer to taking the
// saving back is lost on the way to the page; the bank took it back once, the page sends nothing again, and the empty
// list afterwards does not settle the lost answer. Step 6 (BK-earn-04): in a TEST staking-style pool of the journey's
// own (7-day unbonding), the page shows the pool's kind, its unbonding period, the three states and the owner's risk
// wording (or that none is published, never "no risk"); closed through the treasury door, the pool refuses a deposit
// while the saving in it is still paid its day; taking it back starts unbonding, moves nothing and earns nothing, and at
// its end the bank's release job (signed as its scheduler) pays it back once.
const J = 'J-bank-08';
const RUN = process.env.JOURNEY_RUN_ID ?? `local-${Date.now()}`;
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

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
async function openPool({ kind, aprBps, termDays = null, minDeposit, label, unbondingDays = null }) {
  const input = { poolId: randomUUID(), assetId: 'USDT', kind, name: `TEST ${J} ${label} ${RUN}`, aprBps, termDays, minDeposit };
  if (unbondingDays !== null) input.unbondingDays = unbondingDays;
  const fields = { ...input, aprBps: String(aprBps), termDays: termDays === null ? '' : String(termDays) };
  if (unbondingDays !== null) fields.unbondingDays = String(unbondingDays);
  const res = await treasury('bank.ops.createEarnPool', 'ops.createEarnPool', input, fields);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return { id: input.poolId, name: input.name };
}
/**
 * Close a pool to new savings, or open it again, through the treasury door. `revision` is the pool's next status
 * revision (its current one plus one), bound into the approval like the status and the reason.
 */
async function setStatus(poolId, status, reason, revision) {
  const res = await treasury(
    'bank.ops.setEarnPoolStatus',
    'ops.setEarnPoolStatus',
    { poolId, status, reason, revision },
    { poolId, status, reason, revision: String(revision) },
  );
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
}
/** svc-bank restarted with the staking risk wording blank, or back on the stack's TEST wording. */
function bankRiskWording(on) {
  const name = 'LOCAL_STACK_BANK_EARN_RISK_WORDING';
  const before = process.env[name];
  if (on) delete process.env[name];
  else process.env[name] = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'bank');
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
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
/** One of the bank's job procedures, signed as its scheduler would sign it (the stack has no timer). */
async function job(procedure, input) {
  jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} }));
  const ctx = await jobCtx;
  const raw = JSON.stringify(input);
  const res = await fetch(`${ctx.url('bank')}/trpc/${procedure}`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', ...ctx.contracts.serviceAuthHeadersForBody('svc-bank', ctx.secrets.internal, raw) },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const parsed = await res.json().catch(() => null);
  if (res.status !== 200) {
    // The refusal's HTTP status and its one typed code ride on the error, so a step can match them exactly.
    throw Object.assign(new Error(`${procedure} refused: ${res.status} ${JSON.stringify(parsed).slice(0, 300)}`), {
      status: res.status,
      code: parsed?.error?.data?.cause?.code,
    });
  }
  return parsed.result.data;
}
/** One day of earn interest for one pool. */
const accrue = async (poolId, at) => (await job('ops.accrueInterest', { poolId, at: at.toISOString() })).results[0];
/** Moves one TEST saving's opening back `days` days on this stack, so a day that has begun is its first. */
function ageSaving(positionId, days) {
  return execFileSync(
    process.execPath,
    [path.join(ROOT, 'tooling/scripts/local-test-seed.mjs'), 'age-earn-position', positionId, String(days), '--state', localStackState()],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LOCAL_TEST: '1' }, timeout: 60_000 },
  );
}
/** The UTC day `at` falls in, and the 00:00Z it began at. */
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
const startOf = (at) => Date.parse(`${dayOf(at)}T00:00:00.000Z`);
/** The unbonding release job for one pool, by the bank's own clock. */
const release = (poolId) => job('ops.releaseUnbondedEarn', { poolId, limit: 10 });
/** Ends one TEST saving's unbonding now on this stack (moves its two dates back), as seven days passing would. */
function endUnbonding(positionId) {
  return execFileSync(
    process.execPath,
    [path.join(ROOT, 'tooling/scripts/local-test-seed.mjs'), 'end-earn-unbonding', positionId, '--state', localStackState()],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LOCAL_TEST: '1' }, timeout: 60_000 },
  );
}
/** The renewal job for one pool, run at `at`. */
const renew = (poolId, at) => job('ops.renewEarnTerms', { poolId, at: at.toISOString(), limit: 10 });
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

  // The journey's own flexible pool: opened at 1.25% with a TEST minimum of 10, then raised and cut by approved changes.
  const pool = await openPool({ kind: 'flexible', aprBps: 125, minDeposit: '10', label: 'flexible' });
  run.write({ pool: pool.id, poolName: pool.name });
  expect(await setRate(pool.id, 175, 'TEST rate rise')).toMatchObject({ rateBps: 175, previousBps: 125 });
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
  await expect(rows.nth(2)).toHaveAttribute('data-rate', '125');
  await expect(rows.nth(2)).toContainText('First rate on record');
  await expect(history.getByTestId('earn-rate-history-start')).toContainText('No earlier history');
  await expect(history).toContainText('Now: 1.25%');
  const recorded = await api.query('earn.rateHistory', { poolId: pool.id, limit: 50 });
  expect(recorded.data.changes.map((row) => row.rateBps)).toEqual([125, 175, 125]);
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

  // The job pays only a day that has begun: tomorrow, this saving's first day, is refused by its exact code and records
  // nothing. The saving's opening is then moved back two days, so its first day is yesterday.
  const DAY = 24 * 60 * 60 * 1000;
  const ahead = await job('ops.accrueInterest', { poolId: pool, at: new Date(firstDay + 60 * 60 * 1000).toISOString() }).catch((e) => e);
  expect({ status: ahead.status, code: ahead.code }).toEqual({ status: 412, code: 'bank.accrual_day_not_begun' });
  expect((await api.query('earn.positions', { limit: 50, poolId: pool })).data[0]).toMatchObject({
    id: position.id,
    nextPayoutOn: dayOf(firstDay),
  });
  expect(ageSaving(position.id, 2)).toContain(`saving ${position.id}: opened`);
  const [aged] = (await api.query('earn.positions', { limit: 50, poolId: pool })).data;
  const yesterday = startOf(Date.now()) - DAY;
  expect(aged).toMatchObject({
    id: position.id,
    principal: '100',
    accruesFrom: new Date(yesterday).toISOString(),
    nextPayoutOn: dayOf(yesterday),
  });

  // The bank's job pays that first day from the pool's TEST reserve: the saving is accruing, and the day paid is the
  // calculator's figure for one day, exactly, into the main balance read back from the bank.
  expect(fundReserve(pool, '10', 'jb08-reserve')).toContain('reserve funded 10 USDT');
  const paidBefore = await mainUsdt(api);
  const day = await accrue(pool, new Date(yesterday + 60 * 60 * 1000));
  expect(day).toMatchObject({ date: dayOf(yesterday), paid: perDay, recipients: 1, alreadyAccrued: false });
  expect(await mainUsdt(api)).toBe(paidBefore + toUnits(perDay));
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
  test.setTimeout(180_000);
  const { who } = state();
  const api = await bank(who);
  // A TEST 30-day pool of the journey's own, below the seeded pools' rates.
  const fixed = await openPool({ kind: 'fixed', aprBps: 200, termDays: 30, minDeposit: '10', label: 'fixed' });
  run.write({ fixedPool: fixed.id });
  await signIn(page, who);
  await page.goto(poolPage(fixed.id));

  const deposit = page.getByTestId('earn-pool-deposit');
  await deposit.getByRole('button', { name: 'Deposit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Amount (USDT)').fill('100');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await expect(dialog).toContainText('30 days');
  await confirm(dialog, 'Deposit');
  await close(page);
  const [position] = (await api.query('earn.positions', { limit: 50, poolId: fixed.id })).data;
  // The lock date is the term from the moment it opened.
  expect(Date.parse(position.maturesAt) - Date.parse(position.openedAt)).toBe(30 * 24 * 60 * 60 * 1000);
  expect(position).toMatchObject({ principal: '100', autoRenew: false, renewals: 0 });
  run.write({ fixedPosition: position.id });

  await page.reload();
  const card = page.locator(`[data-testid="earn-pool-position"][data-position="${position.id}"]`);
  const term = card.getByTestId('earn-fixed-term');
  await expect(term).toHaveAttribute('data-matures', position.maturesAt);
  await expect(term).toContainText('30-day term, locked until');
  // The payout schedule: every UTC day to the main balance, through the term, and no compounding.
  const schedule = card.getByTestId('earn-payout-schedule');
  await expect(schedule).toHaveAttribute('data-next', position.accruesFrom.slice(0, 10));
  await expect(schedule).toContainText('Interest is paid every day (UTC) to your main USDT balance.');
  await expect(schedule).toContainText('A fixed term is paid each day of the term, not in one payment at its end.');
  await expect(schedule.getByTestId('earn-compounding')).toHaveAttribute('data-compounding', 'none');

  // Early withdrawal: the page offers none before the lock date, and the bank itself refuses one, naming the date.
  await expect(card.getByTestId('earn-withdraw')).toHaveAttribute('data-state', 'locked');
  await expect(card.getByTestId('earn-withdraw')).toContainText('Locked: you can take it back from');
  const early = await api.mutate('earn.withdraw', { positionId: position.id });
  expect(early).toMatchObject({ ok: false, code: 'bank.position_locked' });
  expect(JSON.stringify(early.body)).toContain(position.maturesAt);

  // Auto-renew on.
  const renewal = card.getByTestId('earn-auto-renew');
  await expect(renewal).toHaveAttribute('data-on', 'false');
  await renewal.getByRole('button', { name: 'Turn on auto-renew', exact: true }).click();
  await expect(dialog).toContainText('A new term of the same length starts');
  await confirm(dialog, 'Turn on auto-renew');
  await close(page);
  await page.reload();
  await expect(renewal).toHaveAttribute('data-on', 'true');
  await expect(renewal).toContainText('Auto-renew is on: when this term ends on');

  // At the end of the term the bank's renewal job starts one new 30-day term with the same amount, and moves no money;
  // a second run renews nothing.
  const before = await mainUsdt(api);
  const ends = new Date(Date.parse(position.maturesAt) + 60_000);
  const next = new Date(Date.parse(position.maturesAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
  expect(await renew(fixed.id, ends)).toEqual({ renewed: [{ positionId: position.id, terms: [1], maturesAt: next }], skipped: [] });
  expect(await renew(fixed.id, ends)).toEqual({ renewed: [], skipped: [] });
  expect(await mainUsdt(api)).toBe(before);
  await page.reload();
  await expect(term).toHaveAttribute('data-matures', next);
  await expect(term).toHaveAttribute('data-renewals', '1');
  await expect(term).toContainText('Terms started by auto-renew: 1.');
  const [renewed] = (await api.query('earn.positions', { limit: 50, poolId: fixed.id })).data;
  expect(renewed).toMatchObject({ principal: '100', maturesAt: next, renewals: 1, autoRenew: true });
});

test(`${J} #5 sees a payout: one payout per period posted, and the schedule shows the next date`, async ({ page }) => {
  test.setTimeout(120_000);
  const { who, pool, position } = state();
  if (!position) throw new Error(`${J} #3 saved nothing, so there is no payout to see`);
  const api = await bank(who);
  const [saving] = (await api.query('earn.positions', { limit: 50, poolId: pool })).data;
  // #3 paid the saving's first day, so the next payout is the day after it.
  const DAY = 24 * 60 * 60 * 1000;
  const secondDay = Date.parse(saving.accruesFrom) + DAY;
  // #3 moved the saving's opening back, so its second day is today: a day that has begun.
  expect(secondDay).toBe(startOf(Date.now()));
  expect(saving.nextPayoutOn).toBe(dayOf(secondDay));
  await signIn(page, who);
  await page.goto(poolPage(pool));
  const card = page.locator(`[data-testid="earn-pool-position"][data-position="${position}"]`);
  const schedule = card.getByTestId('earn-payout-schedule');
  await expect(schedule).toHaveAttribute('data-next', dayOf(secondDay));
  await expect(schedule.getByTestId('earn-payout-next')).toContainText('Next payout:');

  // The period (one UTC day) pays once, however often the job runs that day.
  const perDay = fromUnits(daily('100', 125));
  const before = await mainUsdt(api);
  expect(await accrue(pool, new Date(secondDay + 60 * 1000))).toMatchObject({
    date: dayOf(secondDay),
    paid: perDay,
    recipients: 1,
    alreadyAccrued: false,
  });
  expect(await accrue(pool, new Date(secondDay + 2 * 60 * 1000))).toMatchObject({
    date: dayOf(secondDay),
    paid: perDay,
    alreadyAccrued: true,
  });
  expect(await mainUsdt(api)).toBe(before + toUnits(perDay));
  await page.reload();
  await expect(schedule).toHaveAttribute('data-next', dayOf(secondDay + DAY));
  const earned = page.getByTestId('earn-pool-earned');
  await expect(earned.getByTestId('earn-pool-earned-day')).toHaveCount(2);
  await expect(earned).toHaveAttribute('data-total', fromUnits(daily('100', 125) * 2n));
});

test(`${J} #6 opens a staking-style pool: unbonding states and pool status; a closed pool refuses deposits while existing positions keep accruing and can withdraw`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { who } = state();
  const api = await bank(who);
  // A TEST staking-style pool of the journey's own: flexible, a 7-day unbonding, below the seeded pools' rates.
  const staking = await openPool({ kind: 'flexible', aprBps: 100, minDeposit: '10', label: 'staking', unbondingDays: 7 });
  run.write({ stakingPool: staking.id });
  expect(fundReserve(staking.id, '5', `${J}-${RUN}-staking`)).toContain('reserve funded 5 USDT');
  await signIn(page, who);
  await page.goto(poolPage(staking.id));

  // What the pool publishes: a staking-style pool, its unbonding period, and the three states a saving moves through.
  const facts = page.getByTestId('earn-pool-facts');
  await expect(facts.locator('[data-fact="program"] dd')).toContainText('Staking-style');
  await expect(facts.locator('[data-fact="unbonding"] dd')).toHaveText('7 days after you ask, earning nothing meanwhile');
  await expect(facts.locator('[data-fact="lock"] dd')).toHaveText('No lock, but taking it back starts 7 days of unbonding');
  const states = page.getByTestId('earn-staking');
  await expect(states.locator('li')).toHaveCount(3);
  await expect(states.locator('li[data-state="unbonding"]')).toContainText('It waits 7 days and earns nothing');

  // The risk disclosure is the owner's wording as the bank publishes it: on this stack the profile's TEST wording.
  const wording = await api.query('earn.riskDisclosure');
  expect(wording).toMatchObject({
    ok: true,
    data: { slashing: expect.stringContaining('TEST'), ownership: expect.stringContaining('TEST') },
  });
  const risk = page.getByTestId('earn-risk-disclosure');
  await expect(risk).toHaveAttribute('data-state', 'published');
  await expect(risk.locator('[data-risk="slashing"] dd')).toHaveText(wording.data.slashing);
  await expect(risk.locator('[data-risk="ownership"] dd')).toHaveText(wording.data.ownership);
  await expect(risk).toContainText('while a saving is unbonding it earns nothing and cannot be taken back early');
  // Blank, the bank refuses by name and the page says the wording is not published, never that there is no risk.
  bankRiskWording(false);
  try {
    expect(await api.query('earn.riskDisclosure')).toMatchObject({ ok: false, code: 'bank.earn_risk_wording_unset' });
    await page.reload();
    await expect(risk).toHaveAttribute('data-state', 'unset');
    await expect(risk).toContainText('That is not a statement that there is no risk.');
  } finally {
    bankRiskWording(true);
  }
  expect(await api.query('earn.riskDisclosure')).toEqual(wording);
  await page.reload();
  await expect(risk).toHaveAttribute('data-state', 'published');

  // TEST 100 staked.
  const deposit = page.getByTestId('earn-pool-deposit');
  await deposit.getByRole('button', { name: 'Deposit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Amount (USDT)').fill('100');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await confirm(dialog, 'Deposit');
  await close(page);
  const [opened] = (await api.query('earn.positions', { limit: 50, poolId: staking.id })).data;
  expect(opened).toMatchObject({ principal: '100', maturesAt: null, unbondsAt: null, accrual: 'waiting' });
  // The job pays only a day that has begun, so the saving's opening moves back eight days: its first day is a week ago.
  const DAY = 24 * 60 * 60 * 1000;
  expect(ageSaving(opened.id, 8)).toContain(`saving ${opened.id}: opened`);
  const [position] = (await api.query('earn.positions', { limit: 50, poolId: staking.id })).data;
  expect(position).toMatchObject({ id: opened.id, accruesFrom: new Date(startOf(Date.now()) - 7 * DAY).toISOString() });

  // The pool closes to new savings through the treasury door, as its first status change: the page and the bank refuse
  // a deposit, and the record read again afterwards still holds the one saving and the closed status.
  expect((await api.query('earn.pool', { poolId: staking.id })).data).toMatchObject({ status: 'open', statusRevision: 0 });
  expect(await setStatus(staking.id, 'closed', 'TEST closing the staking pool', 1)).toMatchObject({
    poolId: staking.id,
    status: 'closed',
    previousStatus: 'open',
    revision: 1,
  });
  await page.reload();
  await expect(page.getByTestId('earn-pool-status')).toHaveAttribute('data-status', 'closed');
  await expect(deposit).toHaveAttribute('data-state', 'closed');
  await expect(deposit).toContainText('Savings already in it keep earning and can be taken back.');
  const beforeRefusal = await mainUsdt(api);
  const refused = await api.mutate('earn.deposit', { poolId: staking.id, amount: '50', positionId: randomUUID() });
  expect(refused).toMatchObject({ ok: false, code: 'bank.pool_closed' });
  expect(await mainUsdt(api)).toBe(beforeRefusal);
  expect((await api.query('earn.pool', { poolId: staking.id })).data).toMatchObject({ status: 'closed', statusRevision: 1 });
  const held = (await api.query('earn.positions', { limit: 50, poolId: staking.id })).data;
  expect(held.map((p) => [p.id, p.principal])).toEqual([[position.id, '100']]);

  // The saving already in it keeps earning: the bank's accrual job pays its first day, a day that has begun, in the
  // closed pool, into the main balance read back from the bank.
  const firstDay = Date.parse(position.accruesFrom);
  const perDay = fromUnits(daily('100', 100));
  const unpaid = await mainUsdt(api);
  expect(await accrue(staking.id, new Date(firstDay + 60 * 60 * 1000))).toMatchObject({
    date: dayOf(firstDay),
    paid: perDay,
    recipients: 1,
    alreadyAccrued: false,
  });
  expect(await mainUsdt(api)).toBe(unpaid + toUnits(perDay));
  await page.reload();
  const card = page.locator(`[data-testid="earn-pool-position"][data-position="${position.id}"]`);
  await expect(card.getByTestId('earn-pool-accrual')).toHaveAttribute('data-state', 'accruing');

  // Taking it back starts unbonding: staked, then unbonding with its date, and nothing moves yet. A take back that does
  // not ask to unbond is refused by the bank, so nobody starts a wait they cannot stop by accident.
  const before = await mainUsdt(api);
  expect(await api.mutate('earn.withdraw', { positionId: position.id })).toMatchObject({ ok: false, code: 'bank.unbond_not_confirmed' });
  const take = card.getByTestId('earn-withdraw');
  await expect(take).toHaveAttribute('data-state', 'staked');
  await take.click();
  await expect(dialog).toContainText('7 days after you ask');
  await expect(dialog).toContainText('Unbonding cannot be stopped once it starts.');
  await confirm(dialog, 'Start unbonding');
  await close(page);
  const [unbonding] = (await api.query('earn.positions', { limit: 50, poolId: staking.id })).data;
  // The last day it can be paid is the day it was asked back on: today.
  expect(unbonding).toMatchObject({ id: position.id, accrual: 'unbonding', nextPayoutOn: dayOf(Date.now()), unbondingDays: 7 });
  const ends = Date.parse(unbonding.unbondsAt);
  expect(Math.abs(ends - Date.now() - 7 * 24 * 60 * 60 * 1000)).toBeLessThan(10 * 60 * 1000);
  expect(await mainUsdt(api)).toBe(before);
  await page.reload();
  await expect(take).toHaveAttribute('data-state', 'unbonding');
  await expect(take).toHaveAttribute('data-until', unbonding.unbondsAt);
  await expect(card.getByTestId('earn-pool-accrual')).toHaveAttribute('data-state', 'unbonding');
  expect(await api.mutate('earn.withdraw', { positionId: position.id })).toMatchObject({ ok: false, code: 'bank.position_unbonding' });

  // Nothing comes back before the period ends by the bank's clock, even when a caller names a later time; at its end
  // the bank's job pays the saving back once.
  expect(ends).toBeGreaterThan(Date.now());
  expect(await job('ops.releaseUnbondedEarn', { poolId: staking.id, limit: 10, at: new Date(ends + 60_000).toISOString() })).toEqual({
    released: [],
    skipped: [],
    next: null,
  });
  expect(await release(staking.id)).toEqual({ released: [], skipped: [], next: null });
  expect(await mainUsdt(api)).toBe(before);
  expect(endUnbonding(position.id)).toContain(`saving ${position.id}: unbonding ends`);
  // Its unbonding now began seven days ago, so no day since pays it: today, a day that has begun, pays nobody in this
  // pool, and the main balance read back from the bank has not moved.
  const [ended] = (await api.query('earn.positions', { limit: 50, poolId: staking.id })).data;
  expect(ended).toMatchObject({ id: position.id, accrual: 'unbonding', nextPayoutOn: null });
  expect(await accrue(staking.id, new Date())).toMatchObject({ date: dayOf(Date.now()), paid: '0', recipients: 0, alreadyAccrued: false });
  expect(await mainUsdt(api)).toBe(before);
  expect(await release(staking.id)).toEqual({
    released: [{ positionId: position.id, principal: '100' }],
    skipped: [],
    next: null,
  });
  expect(await release(staking.id)).toEqual({ released: [], skipped: [], next: null });
  expect(await mainUsdt(api)).toBe(before + toUnits('100'));
  await page.reload();
  await expect(page.locator(`[data-testid="earn-pool-position"][data-position="${position.id}"]`)).toHaveCount(0);
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
  const paidDays = (await api.query('earn.interestHistory', { poolId: pool, limit: 50 })).data.days.length;
  expect(paidDays).toBeGreaterThan(0);
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
  await expect(page.getByTestId('earn-pool-earned').getByTestId('earn-pool-earned-day')).toHaveCount(paidDays);
});
