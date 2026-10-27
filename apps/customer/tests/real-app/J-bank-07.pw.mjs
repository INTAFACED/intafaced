import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { DEVICE_KEY, EDGE, ORIGIN, fromUnits, fund, journeyState, json, signOutBrowser, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-bank-07, in the running app (docs/roadmap/journeys.json): I organise money in pots, goals and a shared account. Steps 1
// and 2 (BK-pots-02): a space with a goal whose progress is exact, rounded down and capped, changed and cleared on the
// space's own page; then a lock that refuses every debit by name, a standing order that records the lock as its reason,
// and an early unlock that waits out the bank's window. Step 3 (BK-pots-02): a standing order and a card round-up made on
// the space's page each land once, and the space's own statement lists them. One TEST account funded with TEST 100 USDT.
// The stack publishes a TEST space limit and a TEST early-unlock wait of 24 hours (tooling/profiles/test-owner-values/
// bank.json). The stack has no timer for the standing-order runner: this file runs it with the job door's own signed
// call, as a scheduler would. The stack's card issuer is the simulator, so the card payment arrives through the bank's
// four-eyes ops doors that stand in for the issuer's webhook, approved by the stack's two TEST founders. Step 4
// (BK-pots-03): an income sorter made on the Spaces page; one over 100% is refused by name, and a TEST 100 payment from
// a second TEST person splits 60 and 40 into two spaces, once. The stack publishes a TEST smallest sorted payment. Then
// the bills pot (BK-pots-03): a pot holding TEST 5 that pays a TEST bill of 8 by standing order to another TEST person.
// With the top-up off, the run is refused and recorded and nothing moves; with it on, 3 moves from the account into the
// pot first and the bill pays once. Step 5 (BK-pots-03): instant-access savings on the Spaces page show the bank's rate
// for the stack's seeded TEST instant-access pool; TEST 10 saved there earns three days of interest, each paid once by the
// bank's own job procedure (the stack has no accrual timer), the interest view lists them from the server and they add up
// to what the account was paid; then the savings go back to the account whole. Step 6 (BK-acct-09): the owner shares the
// pot from the Spaces page by handle with a viewer and a contributor. The stack publishes TEST terms: an invite lasts two
// minutes and a pot is shared with two people at most, open invites included. A third invite is refused, the contributor
// accepts and adds TEST 5 once, the viewer's invite outlives its two minutes and is refused as expired, and once the
// viewer has joined, adding money or taking it out is refused bank.space_forbidden and nothing moves. The owner links a
// TEST card to the pot, the contributor freezes it from the pot, the viewer is refused, and the pot's log names who
// invited, who joined, and who froze the card.
const J = 'J-bank-07';
const POT = 'Holiday TEST';
const BILLS = 'Bills TEST';
const SAVINGS = 'Rainy day TEST';
const WAIT_HOURS = 24;
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who) {
  const { status, body: login } = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then(json);
  const token = login?.result?.data?.accessToken;
  // The refusal's own words, so a red run names why (run 591 gave only "refused").
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${status} ${JSON.stringify(login).slice(0, 300)}`);
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
    /** The signed-in person's user id, as identity answered the sign-in. */
    userId: login.result.data.userId,
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
/** One call to svc-bank signed with the stack's service secret: as `caller`, to `path` under the bank's own URL. */
async function signed(path, body, caller) {
  jobCtx ??= import('../../../../tooling/scripts/local-test-gates.mjs').then((gates) => gates.makeContext({ log: () => {} }));
  const ctx = await jobCtx;
  const raw = JSON.stringify(body);
  const res = await fetch(`${ctx.url('bank')}/${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      ...ctx.contracts.serviceAuthHeadersForBody(caller, ctx.secrets.internal, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const parsed = await res.json().catch(() => null);
  if (res.status !== 200) throw new Error(`${path} refused: ${res.status} ${JSON.stringify(parsed).slice(0, 300)}`);
  return parsed;
}
/** One signed call to a bank job door, as the stack's own tooling makes it. */
const job = (path, body = {}) => signed(`internal/jobs/${path}`, body, 'local-test-stack');
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
  await page.getByTestId('money-selected-space').getByRole('button', { name: button, exact: true }).click();
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
  const selected = page.getByTestId('money-selected-space');
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
  const selected = page.getByTestId('money-selected-space');
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
  const record = page.locator('article[data-testid="money-standing-record"]').filter({ hasText: order });
  await record.getByRole('button', { name: 'Execution history' }).click();
  const history = page.getByTestId('money-selected-instruction').getByTestId('money-execution-history');
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
  const selected = page.getByTestId('money-selected-space');
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

test(`${J} #4 sets an income sorter: one over 100% is refused, and a TEST 100 payment from another person splits 60 and 40, once`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const who = person();
  const api = await bank(who);
  // A second TEST person who pays, holding TEST 100 USDT.
  const payer = await signUp(page, 'jb07p');
  await verify(page, payer);
  expect(fund(payer.email, 'USDT', '100').tx).toBeTruthy();
  // Two spaces for the split, made through the person's own API (making a space in the app is step 1's).
  for (const name of [BILLS, SAVINGS]) {
    const made = await api.mutate('spaces.create', { assetId: 'USDT', name });
    expect(made.ok, JSON.stringify(made.body ?? {}).slice(0, 300)).toBe(true);
  }
  const rows = await spaces(who);
  const bills = named(rows, BILLS);
  const savings = named(rows, SAVINGS);

  // The bank itself refuses a sorter over 100%, by name, and keeps nothing.
  const over = await api.mutate('sorter.create', {
    sorterId: randomUUID(),
    assetId: 'USDT',
    legs: [
      { spaceId: bills.id, shareBp: 6000 },
      { spaceId: savings.id, shareBp: 5000 },
    ],
  });
  expect(over).toMatchObject({ ok: false, code: 'bank.sorter_invalid' });

  await signIn(page, who);
  await page.goto('/bank/spaces');
  const sorter = page.getByTestId('income-sorter');
  await expect(sorter.getByTestId('income-sorter-terms')).toHaveAttribute('data-state', 'set');
  await expect(sorter).toContainText('No payments are sorted.');

  // The page names a split over 100% before anything is sent; at 60 and 40 the bank confirms the sorter.
  await sorter.getByRole('button', { name: 'Sort USDT payments' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(`${BILLS}: percent`).fill('60');
  await dialog.getByLabel(`${SAVINGS}: percent`).fill('50');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await expect(dialog).toContainText('The shares add up to 110%, more than 100%.');
  await dialog.getByLabel(`${SAVINGS}: percent`).fill('40');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await confirm(dialog);
  await close(page);
  const card = sorter.getByTestId('income-sorter-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(`60% into ${BILLS}`);
  await expect(card).toContainText(`40% into ${SAVINGS}`);
  await expect(card).toContainText('Nothing has been sorted so far.');

  // The payer sends TEST 100 to this person. The split happens with the payment.
  const before = await spaces(who);
  const payerApi = await bank(payer);
  const from = main((await payerApi.query('spaces.list', { limit: 50 })).data);
  const transferId = `jb07-${randomUUID()}`;
  const paid = await payerApi.mutate('transfers.toUser', { transferId, fromSpaceId: from.id, toUserId: api.userId, amount: '100' });
  expect(paid.ok, JSON.stringify(paid.body ?? {}).slice(0, 300)).toBe(true);
  // The same payment sent again, and a sweep of the sorter's job, move nothing more.
  const again = await payerApi.mutate('transfers.toUser', { transferId, fromSpaceId: from.id, toUserId: api.userId, amount: '100' });
  expect(again.ok && again.data.ledgerTxId).toBe(paid.data.ledgerTxId);
  await job('run-income-sorter', { limit: 50 });

  const after = await spaces(who);
  expect(toUnits(named(after, BILLS).balance)).toBe(toUnits(named(before, BILLS).balance) + toUnits('60'));
  expect(toUnits(named(after, SAVINGS).balance)).toBe(toUnits(named(before, SAVINGS).balance) + toUnits('40'));
  expect(toUnits(main(after).balance)).toBe(toUnits(main(before).balance));

  // The page shows the payment and both splits, moved, once.
  await page.reload();
  const run = card.getByTestId('income-sorter-run');
  await expect(run).toHaveCount(1);
  await expect(run).toHaveAttribute('data-credit', paid.data.ledgerTxId);
  await expect(run).toContainText('100 USDT received');
  await expect(run).toContainText(`60 USDT into ${BILLS}: moved`);
  await expect(run).toContainText(`40 USDT into ${SAVINGS}: moved`);
});

test(`${J} #4 keeps a bills pot: a TEST bill of 8 from a pot holding 5 is refused with the top-up off, and with it on 3 moves from the account and the bill pays once`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const who = person();
  const api = await bank(who);
  // The bill's payee: another TEST person.
  const payee = await signUp(page, 'jb07l');
  await verify(page, payee);
  const payeeApi = await bank(payee);
  const payeeMain = async () => {
    const rows = (await payeeApi.query('spaces.list', { limit: 50 })).data ?? [];
    return toUnits(main(rows)?.balance ?? '0');
  };

  // The pot that pays the bills holds exactly TEST 5 (the sorter's bills space, or a new one when it has none).
  if (!named(await spaces(who), BILLS)) {
    const made = await api.mutate('spaces.create', { assetId: 'USDT', name: BILLS });
    expect(made.ok, JSON.stringify(made.body ?? {}).slice(0, 300)).toBe(true);
  }
  {
    const rows = await spaces(who);
    const held = toUnits(named(rows, BILLS).balance);
    const five = toUnits('5');
    if (held !== five) {
      const [fromSpaceId, toSpaceId] = held > five ? [named(rows, BILLS).id, main(rows).id] : [main(rows).id, named(rows, BILLS).id];
      const amount = fromUnits(held > five ? held - five : five - held);
      const moved = await api.mutate('transfers.create', { transferId: `jb07-${randomUUID()}`, fromSpaceId, toSpaceId, amount });
      expect(moved.ok, JSON.stringify(moved.body ?? {}).slice(0, 300)).toBe(true);
    }
  }
  const pot = named(await spaces(who), BILLS);
  expect(pot.balance).toBe('5');
  // A rerun on the same stack starts where a first run does: the pot pays no bills yet.
  const cleared = await api.mutate('spaces.clearBillsPot', { spaceId: pot.id });
  expect(cleared.ok, JSON.stringify(cleared.body ?? {}).slice(0, 300)).toBe(true);

  // On the pot's own page: not a bills pot, then made one, with the top-up off as it starts.
  await signIn(page, who);
  await page.goto(`/bank/spaces?space=${pot.id}`);
  const state = page.getByTestId('money-selected-space').getByTestId('bills-pot');
  await expect(state).toHaveAttribute('data-state', 'none');
  await confirm(await act(page, 'Pay bills from this pot', null, false), 'Pay bills from this pot');
  await close(page);
  await expect(state).toHaveAttribute('data-state', 'bills');
  await expect(state).toContainText('Top-up from your account is off.');

  /** A TEST bill of 8 from the pot to the payee, once, at the first whole minute at least a minute away; run when due. */
  const bill = async () => {
    const first = new Date(Date.now() + 70_000);
    first.setSeconds(0, 0);
    if (first.getTime() < Date.now() + 60_000) first.setMinutes(first.getMinutes() + 1);
    const made = await api.mutate('transfers.scheduleToUser', {
      fromSpaceId: pot.id,
      toUserId: payeeApi.userId,
      amount: '8',
      cadence: 'once',
      startsAt: first.toISOString(),
      scheduleId: randomUUID(),
    });
    expect(made.ok, JSON.stringify(made.body ?? {}).slice(0, 300)).toBe(true);
    let runs = [];
    await expect
      .poll(
        async () => {
          await runDue();
          const ran = await api.query('transfers.executions', { scheduleId: made.data.id, limit: 50 });
          runs = ran.ok ? ran.data : [];
          return runs.length;
        },
        { timeout: 200_000, intervals: [10_000] },
      )
      .toBe(1);
    return runs[0];
  };

  // Top-up off: the run is refused for too little money and recorded, and nothing moves.
  const before = await spaces(who);
  const payeeBefore = await payeeMain();
  const refused = await bill();
  expect(refused).toMatchObject({ status: 'rejected', rejectionCode: 'ledger.insufficient_funds', ledgerTxId: null });
  const unchanged = await spaces(who);
  expect(named(unchanged, BILLS).balance).toBe('5');
  expect(toUnits(main(unchanged).balance)).toBe(toUnits(main(before).balance));
  expect(await payeeMain()).toBe(payeeBefore);

  // Top-up on, on the same page: the next bill moves 3 from the account into the pot, then pays 8, once.
  await page.reload();
  await confirm(await act(page, 'Top up from my account', null, false), 'Top up from my account');
  await close(page);
  await expect(state).toHaveAttribute('data-state', 'fallback');
  await expect(state).toContainText('Top-up from your account is on.');
  const paid = await bill();
  expect(paid).toMatchObject({ status: 'settled', rejectionCode: null });
  const after = await spaces(who);
  expect(named(after, BILLS).balance).toBe('0');
  expect(toUnits(main(after).balance)).toBe(toUnits(main(before).balance) - toUnits('3'));
  expect(await payeeMain()).toBe(payeeBefore + toUnits('8'));
});

/**
 * One day of earn interest for one TEST pool, through the bank's own job procedure signed as the bank's scheduler would
 * sign it. The stack has no accrual timer, so a day is paid only when a test asks for it.
 */
async function accrue(poolId, at) {
  const answer = await signed('trpc/ops.accrueInterest', { poolId, at: at.toISOString() }, 'svc-bank');
  return answer.result.data.results[0];
}

test(`${J} #5 uses instant-access savings: the bank's rate, TEST 10 saved, three days of interest that add up to what the account was paid, then taken back`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = person();
  const api = await bank(who);
  expect(fund(who.email, 'USDT', '20').tx).toBeTruthy();
  const pools = await api.query('earn.pools', { limit: 50 });
  expect(pools.ok, JSON.stringify(pools.body ?? {}).slice(0, 300)).toBe(true);
  const pool = pools.data.find((row) => row.assetId === 'USDT' && row.kind === 'flexible');
  expect(pool, 'the stack seeds a TEST instant-access USDT pool').toBeTruthy();

  // The Spaces page shows the bank's own rate for it, and opens TEST 10 of savings from the account.
  await signIn(page, who);
  await page.goto('/bank/spaces');
  const card = page.getByTestId('instant-savings').locator(`[data-testid="instant-savings-pool"][data-pool="${pool.id}"]`);
  await expect(card.getByTestId('instant-savings-rate')).toHaveAttribute('data-bps', String(pool.aprBps));
  await expect(card.getByTestId('instant-savings-rate')).toHaveText(`${pool.aprBps / 100}% a year`);
  const mainBefore = toUnits(main(await spaces(who)).balance);
  await card.getByRole('button', { name: 'Open instant-access savings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Amount (USDT)').fill('10');
  await dialog.getByRole('button', { name: 'Review' }).click();
  await confirm(dialog, 'Open instant-access savings');
  await close(page);
  const positions = await api.query('earn.positions', { limit: 50 });
  const saved = positions.data.filter((row) => row.poolId === pool.id);
  expect(saved.map((row) => row.principal)).toEqual(['10']);
  expect(toUnits(main(await spaces(who)).balance)).toBe(mainBefore - toUnits('10'));
  await page.reload();
  await expect(card.getByTestId('instant-savings-position')).toContainText('10 USDT');
  await expect(card).toContainText('No interest paid.');

  // Three days of interest, each paid once by the bank's daily job. Days another run on this stack already paid are
  // passed over: a day is paid once, to whoever saved before it began.
  const paidBefore = toUnits(main(await spaces(who)).balance);
  const days = [];
  for (let ahead = 1; days.length < 3 && ahead <= 400; ahead += 1) {
    const at = new Date(Date.now() + ahead * 24 * 60 * 60 * 1000);
    const day = await accrue(pool.id, at);
    if (!day.alreadyAccrued) days.push(day.date);
    // Paying a day twice pays nothing more.
    if (!day.alreadyAccrued) expect((await accrue(pool.id, at)).alreadyAccrued).toBe(true);
  }
  expect(days).toHaveLength(3);

  // The interest view lists those three days from the server, and they add up to what the account was paid.
  const history = await api.query('earn.interestHistory', { poolId: pool.id, limit: 31 });
  expect(history.ok, JSON.stringify(history.body ?? {}).slice(0, 300)).toBe(true);
  expect(history.data.days.map((row) => row.date).sort()).toEqual([...days].sort());
  const perDay = (toUnits('10') * BigInt(pool.aprBps)) / 10_000n / 365n;
  expect(history.data.days.every((row) => toUnits(row.amount) === perDay && row.rateBps === pool.aprBps)).toBe(true);
  const total = history.data.days.reduce((sum, row) => sum + toUnits(row.amount), 0n);
  expect(toUnits(history.data.total)).toBe(total);
  expect(toUnits(main(await spaces(who)).balance)).toBe(paidBefore + total);
  await page.reload();
  await expect(card.getByTestId('instant-savings-day')).toHaveCount(3);
  for (const date of days)
    await expect(card.locator(`[data-testid="instant-savings-day"][data-date="${date}"]`)).toHaveAttribute(
      'data-amount',
      history.data.days[0].amount,
    );
  await expect(card.getByTestId('instant-savings-earned')).toHaveAttribute('data-amount', history.data.total);

  // Taken back to the account at once, without a penalty: the whole TEST 10 returns, and the interest paid stays.
  await card.getByRole('button', { name: 'Take back to my account', exact: true }).click();
  await confirm(page.getByRole('dialog'), 'Take back to my account');
  await close(page);
  const left = await api.query('earn.positions', { limit: 50 });
  expect(left.data.filter((row) => row.poolId === pool.id)).toEqual([]);
  expect(toUnits(main(await spaces(who)).balance)).toBe(paidBefore + total + toUnits('10'));
  // The interest already paid stays listed.
  await page.reload();
  await expect(card.getByTestId('instant-savings-position')).toHaveCount(0);
  await expect(card.getByTestId('instant-savings-day')).toHaveCount(3);
  await expect(card.getByTestId('instant-savings-earned')).toHaveAttribute('data-amount', history.data.total);
});

test(`${J} #6 shares a pot: invites by handle, an invite that expires, a contributor who adds money, a viewer refused bank.space_forbidden, and a log that names who froze the pot's card`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const who = person();
  const api = await bank(who);
  const pot = named(await spaces(who), POT);
  expect(pot, `${J} #1 made the pot this step shares`).toBeTruthy();
  // The partner adds money, the viewer only looks, and a third person is one too many for the stack's TEST cap of 2.
  const partner = await signUp(page, 'jb07p');
  await verify(page, partner);
  const viewer = await signUp(page, 'jb07v');
  await verify(page, viewer);
  const third = await signUp(page, 'jb07t');
  await signOutBrowser(page.context());
  for (const p of [partner, viewer]) expect(fund(p.email, 'USDT', '20').tx).toBeTruthy();
  const partnerApi = await bank(partner);
  const viewerApi = await bank(viewer);
  const potBalance = async () => toUnits(named(await spaces(who), POT).balance);
  const mainOf = async (p) => toUnits(main(await spaces(p)).balance);

  // The owner shares the pot from the Spaces page: the bank's TEST terms, then an invite to the viewer and one to the partner.
  await signIn(page, who);
  await page.goto('/bank/spaces');
  const shared = page.getByTestId('shared-pots');
  await expect(shared.getByTestId('shared-pots-terms')).toHaveAttribute('data-state', 'set');
  await expect(shared.getByTestId('shared-pots-terms')).toHaveAttribute('data-minutes', '2');
  await expect(shared.getByTestId('shared-pots-terms')).toHaveAttribute('data-cap', '2');
  const invite = async (person, role) => {
    await shared.getByRole('button', { name: 'Share a pot', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Pot', { exact: true }).selectOption(pot.id);
    await dialog.getByLabel('Their handle or email').fill(`@${person.handle}`);
    await dialog.getByLabel('What they can do').selectOption(role);
    await dialog.getByRole('button', { name: 'Review' }).click();
    await confirm(dialog, 'Send invite');
    await close(page);
  };
  await invite(viewer, 'viewer');
  const firstInviteAt = Date.now();
  await invite(partner, 'contributor');
  // Two open invites fill the TEST cap: a third is refused by name, and nothing is stored for it.
  const full = await api.mutate('sharedPots.invite', { inviteId: randomUUID(), spaceId: pot.id, handle: third.handle, role: 'viewer' });
  expect(full).toMatchObject({ ok: false, code: 'bank.shared_pot_full' });
  await page.reload();
  const mine = shared.locator(`[data-testid="shared-pot-owned"][data-pot="${pot.id}"]`);
  await expect(mine.getByTestId('shared-pot-open-invite')).toHaveCount(2);

  // The partner accepts in the app and adds TEST 5 from their own account; the pot is TEST 5 fuller, once.
  await signOutBrowser(page.context());
  await signIn(page, partner);
  await page.goto('/bank/spaces');
  const partnerInvite = shared.getByTestId('shared-pot-invite');
  await expect(partnerInvite).toContainText(`@${who.handle} invites you to ${POT} (USDT) as a contributor.`);
  await partnerInvite.getByRole('button', { name: 'Accept', exact: true }).click();
  await confirm(page.getByRole('dialog'), 'Accept');
  await close(page);
  await page.reload();
  const asPartner = shared.locator(`[data-testid="shared-pot-shared"][data-pot="${pot.id}"]`);
  await expect(asPartner).toHaveAttribute('data-role', 'contributor');
  const before = await potBalance();
  const partnerBefore = await mainOf(partner);
  await expect(asPartner.getByTestId('shared-pot-balance')).toHaveAttribute('data-amount', fromUnits(before));
  await asPartner.getByRole('button', { name: 'Add money', exact: true }).click();
  const add = page.getByRole('dialog');
  await add.getByLabel('Amount (USDT)').fill('5');
  await add.getByRole('button', { name: 'Review' }).click();
  await confirm(add, 'Add money');
  await close(page);
  expect(await potBalance()).toBe(before + toUnits('5'));
  expect(await mainOf(partner)).toBe(partnerBefore - toUnits('5'));

  // The viewer's invite has outlived the TEST two minutes: it shows as ended, and accepting it is refused by name.
  await page.waitForTimeout(Math.max(0, firstInviteAt + 2 * 60_000 + 5_000 - Date.now()));
  await signOutBrowser(page.context());
  await signIn(page, viewer);
  await page.goto('/bank/spaces');
  const ended = shared.getByTestId('shared-pot-invite');
  await expect(ended).toHaveAttribute('data-expired', 'true');
  await expect(ended).toContainText('This invite ended at');
  await ended.getByRole('button', { name: 'Accept', exact: true }).click();
  const refusedDialog = page.getByRole('dialog');
  await refusedDialog.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(refusedDialog).toContainText('This invite has ended. Ask the pot’s owner for a new one.');
  const expiredId = await ended.getAttribute('data-invite');
  expect(await viewerApi.mutate('sharedPots.accept', { inviteId: expiredId })).toMatchObject({ ok: false, code: 'bank.invite_expired' });
  expect((await viewerApi.query('sharedPots.list', { limit: 50 })).data.shared).toEqual([]);

  // The owner asks again, and the viewer joins. Adding money from the app is refused by name and moves nothing; so is
  // taking money out.
  const again = await api.mutate('sharedPots.invite', { inviteId: randomUUID(), spaceId: pot.id, handle: viewer.handle, role: 'viewer' });
  expect(again.ok, JSON.stringify(again.body ?? {}).slice(0, 300)).toBe(true);
  expect(await viewerApi.mutate('sharedPots.accept', { inviteId: again.data.inviteId })).toMatchObject({
    ok: true,
    data: { role: 'viewer' },
  });
  await page.goto('/bank/spaces');
  const asViewer = shared.locator(`[data-testid="shared-pot-shared"][data-pot="${pot.id}"]`);
  await expect(asViewer).toHaveAttribute('data-role', 'viewer');
  const held = await potBalance();
  const viewerHeld = await mainOf(viewer);
  await expect(asViewer.getByTestId('shared-pot-balance')).toHaveAttribute('data-amount', fromUnits(held));
  await asViewer.getByRole('button', { name: 'Add money', exact: true }).click();
  const tried = page.getByRole('dialog');
  await tried.getByLabel('Amount (USDT)').fill('5');
  await tried.getByRole('button', { name: 'Review' }).click();
  await tried.getByRole('button', { name: 'Add money', exact: true }).click();
  await expect(tried).toContainText('You can see this shared pot, but your part in it does not let you move this money. Nothing was sent.');
  const viewerMain = main(await spaces(viewer));
  const into = await viewerApi.mutate('transfers.create', {
    transferId: `jb07v-${randomUUID()}`,
    fromSpaceId: viewerMain.id,
    toSpaceId: pot.id,
    amount: '5',
  });
  expect(into).toMatchObject({ ok: false, code: 'bank.space_forbidden' });
  const out = await viewerApi.mutate('transfers.create', {
    transferId: `jb07v-${randomUUID()}`,
    fromSpaceId: pot.id,
    toSpaceId: viewerMain.id,
    amount: '1',
  });
  expect(out).toMatchObject({ ok: false, code: 'bank.space_forbidden' });
  expect(await potBalance()).toBe(held);
  expect(await mainOf(viewer)).toBe(viewerHeld);

  // The owner links a TEST card to the pot from the Spaces page, so the pot's holders can freeze it.
  const cardId = randomUUID();
  const issued = await api.mutate('cards.issue', { cardId, assetId: 'USDT', perAuthorizationLimit: '50', cardType: 'virtual' });
  expect(issued.ok, JSON.stringify(issued.body ?? {}).slice(0, 300)).toBe(true);
  const tail = issued.data.panTail;
  await signOutBrowser(page.context());
  await signIn(page, who);
  await page.goto('/bank/spaces');
  await mine.getByRole('button', { name: 'Link a card', exact: true }).click();
  const link = page.getByRole('dialog');
  await link.getByLabel('Card', { exact: true }).selectOption(cardId);
  await link.getByRole('button', { name: 'Review' }).click();
  await confirm(link, 'Link a card');
  await close(page);
  await page.reload();
  await expect(mine.getByTestId('shared-pot-card')).toHaveAttribute('data-status', 'active');
  await expect(mine.getByTestId('shared-pot-card')).toHaveAttribute('data-tail', tail);

  // The contributor freezes it from the pot: the card stops paying, and only the owner can lift that.
  await signOutBrowser(page.context());
  await signIn(page, partner);
  await page.goto('/bank/spaces');
  await expect(asPartner.getByTestId('shared-pot-card')).toHaveAttribute('data-status', 'active');
  await asPartner.getByRole('button', { name: 'Freeze card', exact: true }).click();
  await confirm(page.getByRole('dialog'), 'Freeze card');
  await close(page);
  await page.reload();
  await expect(asPartner.getByTestId('shared-pot-card')).toHaveAttribute('data-status', 'frozen');
  await expect(asPartner).toContainText(`Only @${who.handle} can unfreeze it.`);
  const cards = await api.query('cards.list', { limit: 50 });
  expect(cards.data.find((c) => c.id === cardId)?.status).toBe('frozen');
  // The viewer cannot freeze it, and the contributor cannot lift it through the card's own door.
  expect(await viewerApi.mutate('sharedPots.freezeCard', { spaceId: pot.id })).toMatchObject({ ok: false, code: 'bank.space_forbidden' });
  expect(await partnerApi.mutate('cards.setStatus', { cardId, status: 'active' })).toMatchObject({ ok: false, status: 403 });

  // The pot's log, read by its owner in the app, names who did each thing, and who froze the card.
  await signOutBrowser(page.context());
  await signIn(page, who);
  await page.goto('/bank/spaces');
  await mine.getByTestId('shared-pot-log').locator('summary').click();
  const lines = mine.getByTestId('shared-pot-log-entry');
  await expect(lines).toHaveCount(7);
  await expect(lines.nth(0)).toContainText(`@${partner.handle} froze the card •••• ${tail}`);
  await expect(lines.nth(1)).toContainText(`@${who.handle} linked the card •••• ${tail}`);
  await expect(lines.nth(2)).toContainText(`@${viewer.handle} joined as a viewer`);
  await expect(lines.nth(3)).toContainText(`@${who.handle} invited @${viewer.handle} as a viewer`);
  await expect(lines.nth(4)).toContainText(`@${partner.handle} joined as a contributor`);
  await expect(lines.nth(5)).toContainText(`@${who.handle} invited @${partner.handle} as a contributor`);
  await expect(lines.nth(6)).toContainText(`@${who.handle} invited @${viewer.handle} as a viewer`);
  const log = await api.query('sharedPots.activity', { spaceId: pot.id, limit: 50 });
  expect(log.data.map((e) => [e.kind, e.actor.handle])).toEqual([
    ['card_frozen', partner.handle],
    ['card_linked', who.handle],
    ['joined', viewer.handle],
    ['invited', who.handle],
    ['joined', partner.handle],
    ['invited', who.handle],
    ['invited', who.handle],
  ]);
});
