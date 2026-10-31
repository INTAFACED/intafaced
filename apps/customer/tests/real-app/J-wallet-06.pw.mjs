import { test, expect } from './journey.mjs';
import { api, fund, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-wallet-06, in the running app (docs/roadmap/journeys.json): I cancel a withdrawal, or recover one that came back. One test
// per step, titled "J-wallet-06 #<n>", each on its own verified TEST account with TEST 100 USDT. Sending out is switched off in
// svc-pay on this stack, so each withdrawal starts in its state from `local-test-stack.mjs seed-withdrawal`, which writes it
// the way svc-pay's `withdraw` leaves it and books its hold through the ledger first. Cancelling is svc-pay's own code, pressed
// on the person's withdrawal page; every balance is read back from the ledger through the person's own API.
// #5 reads the person's History, filtered by coin and status and paged by svc-pay's cursor past 200 rows; its long history is
// written by the same tool (`--count`, requested withdrawals, nothing held). #6 starts from a sent withdrawal (`--state sent`,
// settled through the ledger's own recipe): the stack's TEST founders record that it came back and a second founder approves
// the credit, through svc-pay's founder doors as the console sends them; the person's page shows why and the amount back in
// available, once.
const J = 'J-wallet-06';
const ASSET = 'USDT';

/** One TEST withdrawal of `amount` USDT in `state`. Returns its id. */
function seedWithdrawal(who, state, amount, label) {
  const out = tool('local-test-stack.mjs', 'seed-withdrawal', who.email, ASSET, amount, '--state', state, '--ref', label);
  const id = /^\s*withdrawal\s+([0-9a-f-]{36})$/m.exec(out)?.[1];
  expect(id, out).toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

/** A verified TEST person, signed in, with TEST 100 USDT, and their own API client. */
async function person(page, tag) {
  const who = await signUp(page, tag);
  await verify(page, who);
  await signIn(page, who);
  expect(fund(who.email, ASSET, '100').tx).toBeTruthy();
  const client = await api(who);
  return {
    who,
    usdt: async () => toUnits((await client.balances())[ASSET]?.free ?? '0'),
    /** The person's own cancel, through the API, as a second press would send it. */
    cancel: (withdrawalId) => client.post('/api/pay/trpc/withdrawal.cancel', { withdrawalId }),
  };
}

let founderPair;
/** The stack's two TEST founders, signed in with their second factor (local-test-gates.mjs). */
async function founders() {
  if (!founderPair) {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    founderPair = { ctx, pair: await gates.approverSessions(ctx) };
  }
  return founderPair;
}

/** One founder door of svc-pay's returned withdrawals, as founder `who` ('a' or 'b'). Returns { status, row, text }. */
async function returnsDoor(who, procedure, input) {
  const { ctx, pair } = await founders();
  const res = await ctx.edge.mutate('pay', `founderAdmin.withdrawalReturns.${procedure}`, input, pair[who].token);
  return { status: res.status, row: res.json?.result?.data ?? null, text: res.text };
}

async function openWithdrawal(page, id) {
  await page.goto(`/uc/withdraw?withdrawalId=${id}`);
  await page.mouse.move(0, 600);
  await expect(page.getByTestId('withdrawal-status')).toBeVisible({ timeout: 30_000 });
}

const status = (page) => page.getByTestId('withdrawal-status');
const cancelPart = (page) => page.getByTestId('withdrawal-cancel');

test(`${J} #1 a requested withdrawal is cancelled and nothing was posted`, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const me = await person(page, 'w6a');
  const id = seedWithdrawal(me.who, 'requested', '40', `jw06a-${me.who.handle}-r${testInfo.retry}`);
  expect(await me.usdt()).toBe(toUnits('100'));

  await openWithdrawal(page, id);
  await expect(status(page)).toHaveAttribute('data-status', 'requested');
  await expect(status(page)).toHaveText('Requested');
  await expect(cancelPart(page)).toContainText('Nothing has been sent, so you can cancel it.');
  await cancelPart(page).getByRole('button', { name: 'Cancel withdrawal' }).click();

  await expect(page.getByTestId('withdrawal-canceled')).toHaveText('Cancelled. Nothing was posted: no amount was held for it.');
  await expect(status(page)).toHaveAttribute('data-status', 'canceled');
  await expect(status(page)).toHaveText('Cancelled');
  await expect(cancelPart(page)).toHaveCount(0);
  expect(await me.usdt()).toBe(toUnits('100'));
});

test(`${J} #2 a held withdrawal not yet sent is cancelled twice, and its hold goes back once`, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const me = await person(page, 'w6b');
  const id = seedWithdrawal(me.who, 'held', '40', `jw06b-${me.who.handle}-r${testInfo.retry}`);
  expect(await me.usdt()).toBe(toUnits('60'));

  await openWithdrawal(page, id);
  await expect(status(page)).toHaveAttribute('data-status', 'held');
  await expect(status(page)).toHaveText('Held');
  await expect(
    page.getByText('A withdrawal can be cancelled only before it is sent. After it is broadcast, it cannot be reversed.'),
  ).toBeVisible();
  await cancelPart(page).getByRole('button', { name: 'Cancel withdrawal' }).click();

  await expect(page.getByTestId('withdrawal-canceled')).toHaveText(
    'Cancelled. The amount held for it went back to your available balance, once.',
  );
  await expect(status(page)).toHaveAttribute('data-status', 'canceled');
  expect(await me.usdt()).toBe(toUnits('100'));

  // The second cancel: the same cancelled withdrawal, and nothing more goes back.
  const again = await me.cancel(id);
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.result.data).toMatchObject({ id, customerStatus: 'canceled', holdReleased: true });
  expect(await me.usdt()).toBe(toUnits('100'));
  await page.reload();
  await expect(status(page)).toHaveAttribute('data-status', 'canceled', { timeout: 30_000 });
});

test(`${J} #3 a broadcast withdrawal cannot be cancelled: a typed refusal`, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const me = await person(page, 'w6c');
  const id = seedWithdrawal(me.who, 'broadcast', '40', `jw06c-${me.who.handle}-r${testInfo.retry}`);

  await openWithdrawal(page, id);
  await expect(status(page)).toHaveAttribute('data-status', 'broadcast');
  await expect(status(page)).toHaveText('Broadcast');
  await expect(cancelPart(page)).toContainText('This withdrawal was broadcast, so it cannot be cancelled. A broadcast cannot be reversed.');
  await cancelPart(page).getByRole('button', { name: 'Cancel withdrawal' }).click();

  await expect(page.getByTestId('withdrawal-cancel-refused')).toContainText(
    'This withdrawal can no longer be cancelled. Refresh it to see where it stands.',
  );
  await expect(status(page)).toHaveAttribute('data-status', 'broadcast');
  const refused = await me.cancel(id);
  expect(refused.status).toBe(409);
  expect(JSON.stringify(refused.body)).toContain('pay.withdrawal_not_cancellable');
  expect(await me.usdt()).toBe(toUnits('60'));
});

test(`${J} #4 after a lost reply the cancel is refused and the withdrawal stays held until the original outcome is known`, async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const me = await person(page, 'w6d');
  const id = seedWithdrawal(me.who, 'dispatching', '40', `jw06d-${me.who.handle}-r${testInfo.retry}`);

  await openWithdrawal(page, id);
  await expect(status(page)).toHaveAttribute('data-status', 'dispatching');
  await expect(status(page)).toHaveText('Sending');
  await expect(cancelPart(page)).toContainText(
    'A send was asked for and its outcome is not known. The withdrawal stays held until the original outcome is known, so it cannot be cancelled.',
  );
  await cancelPart(page).getByRole('button', { name: 'Cancel withdrawal' }).click();

  await expect(page.getByTestId('withdrawal-cancel-refused')).toContainText(
    'This withdrawal can no longer be cancelled. Refresh it to see where it stands.',
  );
  await page.reload();
  await expect(status(page)).toHaveAttribute('data-status', 'dispatching', { timeout: 30_000 });
  // The funds stay in the hold: nothing came back to available.
  expect(await me.usdt()).toBe(toUnits('60'));
});

test(`${J} #5 History filters by coin and status and pages past 200; an empty result is an honest empty state`, async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const me = await person(page, 'w6e');
  const tag = `jw06e-${me.who.handle}-r${testInfo.retry}`;
  const many = tool(
    'local-test-stack.mjs',
    'seed-withdrawal',
    me.who.email,
    ASSET,
    '1',
    '--state',
    'requested',
    '--ref',
    `${tag}-u`,
    '--count',
    '205',
  );
  expect(many).toContain('withdrawals 205');
  const few = tool(
    'local-test-stack.mjs',
    'seed-withdrawal',
    me.who.email,
    'USDC',
    '2',
    '--state',
    'requested',
    '--ref',
    `${tag}-c`,
    '--count',
    '3',
  );
  expect(few).toContain('withdrawals 3');
  const heldId = seedWithdrawal(me.who, 'held', '40', `${tag}-h`);

  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  const windowNote = page.getByTestId('withdrawal-window');
  const rows = page.getByTestId('withdrawal-history').getByTestId('withdrawal-row');
  const coin = page.locator('select[name="withdrawal-coin"]');
  const state = page.locator('select[name="withdrawal-status"]');
  // Every coin and status: the newest page of 50, and more behind it.
  await expect(windowNote).toHaveAttribute('data-count', '50', { timeout: 30_000 });
  await expect(windowNote).toHaveAttribute('data-more', 'true');
  await expect(rows.first()).toHaveAttribute('data-withdrawal-id', heldId);

  // One coin: the three USDC withdrawals and nothing else.
  await coin.selectOption('USDC');
  await expect(windowNote).toHaveAttribute('data-count', '3', { timeout: 30_000 });
  await expect(windowNote).toHaveAttribute('data-more', 'false');
  await expect(windowNote).toContainText('That is every withdrawal that matches.');
  for (const text of await page.getByTestId('withdrawal-history').locator('[data-withdrawal-amount]').allTextContents())
    expect(text).toContain('USDC');

  // One coin and one status: the held USDT withdrawal alone.
  await coin.selectOption(ASSET);
  await state.selectOption('held');
  await expect(windowNote).toHaveAttribute('data-count', '1', { timeout: 30_000 });
  await expect(rows.first()).toHaveAttribute('data-withdrawal-id', heldId);
  await expect(rows.first().locator('[data-withdrawal-status]')).toHaveText('Held');

  // Requested USDT: 205 rows, read page by page past 200, each once.
  await state.selectOption('requested');
  await expect(windowNote).toHaveAttribute('data-count', '50', { timeout: 30_000 });
  for (const count of ['100', '150', '200', '205']) {
    await page.getByRole('button', { name: 'Show older withdrawals' }).click();
    await expect(windowNote).toHaveAttribute('data-count', count, { timeout: 30_000 });
  }
  await expect(windowNote).toHaveAttribute('data-more', 'false');
  await expect(page.getByRole('button', { name: 'Show older withdrawals' })).toHaveCount(0);
  const ids = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-withdrawal-id')));
  expect(ids).toHaveLength(205);
  expect(new Set(ids).size).toBe(205);
  expect(new Set(await rows.locator('[data-withdrawal-status]').allTextContents())).toEqual(new Set(['Requested']));

  // A coin and status nothing matches: an honest empty state, not a made-up row.
  await coin.selectOption('USDC');
  await state.selectOption('settled');
  await expect(page.getByRole('heading', { name: 'No withdrawals match' })).toBeVisible({ timeout: 30_000 });
  await expect(rows).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show older withdrawals' })).toHaveCount(0);
});

test(`${J} #6 a returned withdrawal shows why and its amount back in available, once`, async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const me = await person(page, 'w6f');
  const id = seedWithdrawal(me.who, 'sent', '40', `jw06f-${me.who.handle}-r${testInfo.retry}`);
  expect(await me.usdt()).toBe(toUnits('60'));

  await openWithdrawal(page, id);
  await expect(status(page)).toHaveAttribute('data-status', 'settled');
  await expect(page.getByTestId('withdrawal-returned')).toHaveCount(0);

  // Founder A records that it came back. Nothing is booked yet, and A alone cannot approve the credit.
  const recorded = await returnsDoor('a', 'record', {
    withdrawalId: id,
    returnRef: `local-test-return-${id}`,
    amount: '40',
    reason: 'LOCAL TEST: the receiving exchange rejected the deposit',
    reasonCode: 'destination_rejected',
  });
  expect(recorded.status, recorded.text).toBe(200);
  expect(recorded.row).toMatchObject({ state: 'parked' });
  const alone = await returnsDoor('a', 'recredit', { withdrawalId: id, reason: 'LOCAL TEST approval' });
  expect(alone.status).toBe(403);
  expect(alone.text).toContain('withdrawal_return.same_founder');

  await page.reload();
  const back = page.getByTestId('withdrawal-returned');
  await expect(back).toHaveAttribute('data-credited', 'false');
  await expect(back).toContainText('40 USDT came back to us. We are checking it before it goes back to your available balance.');
  await expect(back).toContainText('Why: the receiving address or account sent it back.');
  expect(await me.usdt()).toBe(toUnits('60'));

  // Founder B approves: the amount is back in available. Approved again, nothing more is booked.
  const credited = await returnsDoor('b', 'recredit', { withdrawalId: id, reason: 'LOCAL TEST approval' });
  expect(credited.status, credited.text).toBe(200);
  expect(credited.row).toMatchObject({ state: 'credited' });
  const again = await returnsDoor('b', 'recredit', { withdrawalId: id, reason: 'LOCAL TEST approval' });
  expect(again.row?.ledgerTxId).toBe(credited.row.ledgerTxId);

  await page.reload();
  await expect(back).toHaveAttribute('data-credited', 'true');
  await expect(back).toContainText('40 USDT came back to your available balance.');
  await expect(back).toContainText('Why: the receiving address or account sent it back.');
  expect(await me.usdt()).toBe(toUnits('100'));
});
