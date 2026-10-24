import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { DEVICE_KEY, EDGE, ORIGIN, fund, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-07, in the running app (docs/roadmap/journeys.json): I organise money in pots, goals and a shared account. Steps 1
// and 2 (BK-pots-02): a space with a goal whose progress is exact, rounded down and capped, changed and cleared on the
// space's own page; then a lock that refuses every debit by name, a standing order that records the lock as its reason,
// and an early unlock that waits out the bank's window. Step 3 (BK-pots-02): a standing order and a card round-up made on
// the space's page each land once, and the space's own statement lists them. One TEST account funded with TEST 100 USDT.
// The stack publishes a TEST space limit and a TEST early-unlock wait of 24 hours (tooling/profiles/test-owner-values/
// bank.json). The stack has no timer for the standing-order runner: this file runs it with the job door's own signed
// call, as a scheduler would. The stack's card issuer is the simulator, so the card payment arrives through the bank's
// four-eyes ops doors that stand in for the issuer's webhook, approved by the stack's two TEST founders.
const J = 'J-bank-07';
const POT = 'Holiday TEST';
const WAIT_HOURS = 24;
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

let jobCtx;
/** One signed call to a bank job door, as the stack's own tooling makes it. */
async function job(path, body = {}) {
  jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} }));
  const ctx = await jobCtx;
  const raw = JSON.stringify(body);
  const res = await fetch(`${ctx.url('bank')}/internal/jobs/${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody('local-test-stack', ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const parsed = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`${path} refused: ${res.status} ${JSON.stringify(parsed).slice(0, 300)}`);
  return parsed;
}
/**
 * Runner passes until nothing is due, as a scheduler would call it: the stack's TEST batch is one schedule a pass. Other
 * journeys' orders share this stack, so this stops after 30 passes and the step checks this person's own record.
 */
async function runDue() {
  for (let passes = 0; passes < 30; passes += 1) {
    const pass = await job('run-due-transfers', {});
    if (pass.schedulesConsidered === 0) return;
  }
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
/** One card-issuer event through the bank's ops door, approved by two founders as the simulator's stand-in requires. */
async function cardEvent(actionType, procedure, fields) {
  const { gates, ctx, sessions } = await founders();
  const approval = await gates.twoPerson(ctx, sessions, {
    actionType,
    targetService: 'svc-bank',
    targetId: actionType,
    expectedVersion: '1',
    payloadHash: gates.bankPayloadHash(actionType, fields),
    policyVersion: gates.MARKERS.policyVersion,
  });
  const res = await ctx.edge.mutate('bank', procedure, { ...fields, ...approval }, await sessions.a.treasuryToken());
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data;
}

function person() {
  const { who } = run.read();
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}
async function spaces(who) {
  const res = await (await bank(who)).query('spaces.list', { limit: 50 });
  if (!res.ok) throw new Error(`spaces.list refused: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  return res.data;
}
const main = (rows) => rows.find((s) => s.kind === 'primary' && s.assetId === 'USDT');
const named = (rows, name) => rows.find((s) => s.kind === 'named' && s.name === name);
/** A `datetime-local` value, in the browser's (and this process's) local time. */
function local(at) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** One action of the selected space's page, through its review, to the bank's own confirmation. */
async function act(page, button, fill, form = true) {
  await page.locator('.money-selected-space').getByRole('button', { name: button, exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (fill) await fill(dialog);
  // An action with nothing to fill in opens straight on its review.
  if (form) await dialog.getByRole('button', { name: 'Review' }).click();
  return dialog;
}
async function confirm(dialog, submit = 'Confirm') {
  await dialog.getByRole('button', { name: submit }).click();
  await expect(dialog.getByText('Confirmed by the service')).toBeVisible({ timeout: 30_000 });
}
async function close(page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test(`${J} #1 opens a space with a goal: progress is exact, rounded down and capped, and no bar is drawn without a goal`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'jb07');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '100').tx).toBeTruthy();
  run.reset({ who });

  // The space is made in the app with a goal of 50.
  await signIn(page, who);
  await page.goto('/bank/spaces');
  await page.getByRole('button', { name: 'Create space' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Asset', { exact: true }).selectOption('USDT');
  await dialog.getByLabel('Space name').fill(POT);
  await dialog.getByLabel(/Savings target/).fill('50');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await confirm(dialog);
  const pot = named(await spaces(who), POT);
  expect(pot).toMatchObject({ goalTarget: '50', lockedUntil: null, unlocksAt: null });

  // 20 moves in through the person's own API, so the bar has a balance to measure.
  const api = await bank(who);
  const moved = await api.mutate('transfers.create', {
    transferId: `jb07-${randomUUID()}`,
    fromSpaceId: main(await spaces(who)).id,
    toSpaceId: pot.id,
    amount: '20',
  });
  expect(moved.ok, JSON.stringify(moved.body ?? {}).slice(0, 300)).toBe(true);

  await page.goto(`/bank/spaces?space=${pot.id}`);
  const selected = page.locator('.money-selected-space');
  const bar = selected.getByRole('progressbar', { name: 'Progress toward the savings target' });
  await expect(selected.getByRole('heading', { name: POT })).toBeVisible();
  await expect(bar).toHaveAttribute('aria-valuenow', '40');
  await expect(selected).toContainText('20 of 50 USDT');

  // A goal of 30.3: 20 of it is 66.006…%, shown as 66, never rounded up.
  await confirm(await act(page, 'Set goal', (d) => d.getByLabel(/Goal/).fill('30.3')));
  await close(page);
  await expect(bar).toHaveAttribute('aria-valuenow', '66');
  await expect(selected).toContainText('20 of 30.3 USDT');

  // A goal below the balance is capped at the goal and says it is reached.
  await confirm(await act(page, 'Set goal', (d) => d.getByLabel(/Goal/).fill('15')));
  await close(page);
  await expect(bar).toHaveAttribute('aria-valuenow', '100');
  await expect(selected).toContainText('Target reached');

  // Cleared: no target, and no bar drawn. The balance never moved.
  await confirm(await act(page, 'Set goal'));
  await close(page);
  await expect(selected).toContainText('No savings target');
  await expect(selected.getByRole('progressbar')).toHaveCount(0);
  const after = named(await spaces(who), POT);
  expect(after).toMatchObject({ goalTarget: null });
  expect(toUnits(after.balance)).toBe(toUnits('20'));
  run.write({ pot: pot.id });
});

test(`${J} #2 locks the space: a debit refuses bank.space_locked, a standing order records it, and an early unlock waits out the window`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = person();
  const { pot } = run.read();
  if (!pot) throw new Error(`${J} #1 made no space, so this step has nothing to lock`);
  const api = await bank(who);
  const mainId = main(await spaces(who)).id;

  await signIn(page, who);
  await page.goto(`/bank/spaces?space=${pot}`);
  const selected = page.locator('.money-selected-space');
  const until = new Date(Date.now() + 10 * 24 * 3600_000);
  until.setSeconds(0, 0);
  await confirm(await act(page, 'Lock', (d) => d.getByLabel('Locked until').fill(local(until))));
  await close(page);
  const locked = named(await spaces(who), POT);
  expect(locked.lockedUntil).toBe(until.toISOString());
  await expect(selected.getByRole('button', { name: 'Lock for longer' })).toBeVisible();

  // A debit from the locked space is refused by name, and nothing moves.
  const refused = await api.mutate('transfers.create', {
    transferId: `jb07-${randomUUID()}`,
    fromSpaceId: pot,
    toSpaceId: mainId,
    amount: '1',
  });
  expect(refused).toMatchObject({ ok: false, code: 'bank.space_locked' });
  expect(toUnits(named(await spaces(who), POT).balance)).toBe(toUnits('20'));

  // A lock can only get longer here: an earlier date is refused, to be asked for as an early unlock.
  const shorter = await api.mutate('spaces.setLock', { spaceId: pot, lockedUntil: new Date(Date.now() + 24 * 3600_000).toISOString() });
  expect(shorter).toMatchObject({ ok: false, code: 'bank.space_change_invalid' });

  // A standing order out of the locked space records the lock as the reason its run did not post.
  const order = randomUUID();
  const made = await api.mutate('transfers.schedule', {
    scheduleId: order,
    fromSpaceId: pot,
    toSpaceId: mainId,
    amount: '5',
    cadence: 'daily',
    startsAt: new Date(Date.now() - 60_000).toISOString(),
  });
  expect(made.ok, JSON.stringify(made.body ?? {}).slice(0, 300)).toBe(true);
  await runDue();
  const ran = await api.query('transfers.executions', { scheduleId: order, limit: 50 });
  expect(ran.ok).toBe(true);
  expect(ran.data[0]).toMatchObject({ occurrence: 0, status: 'rejected', rejectionCode: 'bank.space_locked', ledgerTxId: null });
  await page.goto('/bank/transfers');
  const record = page.locator('article.money-standing-record').filter({ hasText: order });
  await record.getByRole('button', { name: 'Execution history' }).click();
  const history = page.locator('.money-selected-instruction .money-execution-history');
  await expect(history).toContainText('rejected');
  await expect(history).toContainText('bank.space_locked');
  expect((await api.mutate('transfers.cancel', { scheduleId: order })).ok).toBe(true);

  // An early unlock: the person confirms, and the space stays locked for the bank's TEST wait of 24 hours.
  await page.goto(`/bank/spaces?space=${pot}`);
  const asked = Date.now();
  const dialog = await act(page, 'Unlock early', undefined, false);
  await expect(dialog).toContainText('The space stays locked for the bank’s waiting time and then opens.');
  await confirm(dialog, 'Ask to unlock');
  await expect(dialog).toContainText('Opens early at');
  await close(page);
  const early = selected.getByTestId('space-early-unlock');
  await expect(early).toContainText('It stays locked until this time.');
  const opens = Date.parse(await early.getAttribute('data-opens'));
  expect(opens).toBeGreaterThanOrEqual(asked + WAIT_HOURS * 3600_000 - 1000);
  expect(opens).toBeLessThanOrEqual(Date.now() + WAIT_HOURS * 3600_000);
  expect(named(await spaces(who), POT)).toMatchObject({ lockedUntil: until.toISOString(), unlocksAt: new Date(opens).toISOString() });
  await expect(selected.getByRole('button', { name: 'Keep locked' })).toBeVisible();
  await expect(selected.getByRole('button', { name: 'Unlock early' })).toHaveCount(0);

  // Still locked during the wait, and asking again keeps the first opening time.
  const still = await api.mutate('transfers.create', {
    transferId: `jb07-${randomUUID()}`,
    fromSpaceId: pot,
    toSpaceId: mainId,
    amount: '1',
  });
  expect(still).toMatchObject({ ok: false, code: 'bank.space_locked' });
  const again = await api.mutate('spaces.requestUnlock', { spaceId: pot });
  expect(again).toMatchObject({ ok: true, data: { unlocksAt: new Date(opens).toISOString() } });
  expect(toUnits(named(await spaces(who), POT).balance)).toBe(toUnits('20'));
});

test(`${J} #3 money flows into the space on its own: a standing order and a card round-up land once each, and the space's statement lists them`, async ({
  page,
}) => {
  test.setTimeout(360_000);
  const who = person();
  const { pot } = run.read();
  if (!pot) throw new Error(`${J} #1 made no space, so this step has nowhere to save into`);
  const api = await bank(who);
  const before = named(await spaces(who), POT);
  const mainBefore = main(await spaces(who)).balance;

  await signIn(page, who);
  await page.goto(`/bank/spaces?space=${pot}`);
  const selected = page.locator('.money-selected-space');
  const inflows = selected.getByTestId('space-inflows');
  await expect(inflows).toContainText('No standing order pays into this space.');
  await expect(inflows).toContainText('No card round-up goes into this space.');

  // A weekly standing order of TEST 5 from the account into the space, made on the space's page. Its first run is the
  // first whole minute at least a minute away, the soonest the form takes.
  const first = new Date(Date.now() + 120_000);
  first.setSeconds(0, 0);
  await confirm(
    await act(page, 'Save automatically', async (d) => {
      await d.getByLabel(/^Amount/).fill('5');
      await d.getByLabel('Cadence').selectOption('weekly');
      await d.getByLabel('First run').fill(local(first));
    }),
  );
  await close(page);
  const order = inflows.getByTestId('space-inflow-order');
  await expect(order).toHaveCount(1);
  await expect(order).toContainText('5 USDT, every week');
  const orderId = await order.getAttribute('data-id');

  // A card round-up to the next TEST 1, into this space, made on the same page.
  await confirm(await act(page, 'Add round-up', (d) => d.getByLabel(/^Round up to the next/).fill('1')));
  await close(page);
  const roundUp = inflows.getByTestId('space-inflow-roundup');
  await expect(roundUp).toHaveCount(1);
  await expect(roundUp).toContainText('Each card payment rounded up to the next 1 USDT');
  await expect(roundUp).toContainText('Active');

  // A TEST card payment of 4.30: authorised, then captured. The spare 0.70 moves into the space with the capture.
  const cardId = randomUUID();
  const issued = await api.mutate('cards.issue', { cardId, assetId: 'USDT', perAuthorizationLimit: '50', cardType: 'virtual' });
  expect(issued.ok, JSON.stringify(issued.body ?? {}).slice(0, 300)).toBe(true);
  const payment = { cardId, authorizationRef: `jb07-${randomUUID()}`, amount: '4.3' };
  const held = await cardEvent('bank.card_authorize', 'ops.cardAuthorize', payment);
  expect(held).toMatchObject({ decision: 'approved', declineCode: null });
  const captured = await cardEvent('bank.card_capture', 'ops.cardCapture', payment);
  expect(captured.roundUp).toMatchObject({ status: 'settled', amount: '0.7', spaceId: pot });

  // The standing order's first run, once its time has come.
  await expect
    .poll(
      async () => {
        await runDue();
        const ran = await api.query('transfers.executions', { scheduleId: orderId, limit: 50 });
        return ran.ok ? ran.data.map((r) => r.status) : [];
      },
      { timeout: 200_000, intervals: [10_000] },
    )
    .toEqual(['settled']);

  // Each landed once: the space gained 5.7, the account paid the card 4.3 and the space 5.7.
  const after = await spaces(who);
  expect(toUnits(named(after, POT).balance)).toBe(toUnits(before.balance) + toUnits('5.7'));
  expect(toUnits(main(after).balance)).toBe(toUnits(mainBefore) - toUnits('10'));

  // The space's own statement, this month so far: the order's run and the round-up, once each, and nothing else's lines.
  await page.goto(`/bank/spaces?space=${pot}`);
  const statement = selected.getByRole('form', { name: 'Space statement' });
  await expect(statement.getByLabel('Format')).toHaveValue('csv');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    statement.getByRole('button', { name: 'Download space statement' }).click(),
  ]);
  const csv = readFileSync(await download.path(), 'utf8').replace(/^\uFEFF/, '');
  const [header, ...lines] = csv.trim().split('\r\n');
  expect(header.split(',')[4]).toBe('Amount');
  const amounts = lines.map((line) => line.split(','));
  expect(amounts.every((cells) => cells[6] === POT)).toBe(true);
  expect(amounts.filter((cells) => cells[4] === '5')).toHaveLength(1);
  expect(amounts.filter((cells) => cells[4] === '0.7')).toHaveLength(1);
  await expect(statement.getByRole('status')).toContainText(`${lines.length} lines`);
});
