import { test, expect } from '@playwright/test';
import { api, fund, tool, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-wallet-06, in the running app (docs/roadmap/journeys.json): I cancel a withdrawal, or recover one that came back. One test
// per step, titled "J-wallet-06 #<n>", each on its own verified TEST account with TEST 100 USDT. Sending out is switched off in
// svc-pay on this stack, so each withdrawal starts in its state from `local-test-stack.mjs seed-withdrawal`, which writes it
// the way svc-pay's `withdraw` leaves it and books its hold through the ledger first. Cancelling is svc-pay's own code, pressed
// on the person's withdrawal page; every balance is read back from the ledger through the person's own API.
// Not here yet: #5 (History filters past 200) and #6 (a returned withdrawal needs the returned-funds ledger recipe).
const J = 'J-wallet-06';
const ASSET = 'USDT';

/** One TEST withdrawal of `amount` USDT in `state`. Returns its id. */
function seedWithdrawal(who, state, amount, label) {
  const out = tool('local-test-stack.mjs', 'seed-withdrawal', who.email, ASSET, amount, '--state', state, '--ref', label);
  const id = /withdrawal (\S+)/.exec(out)?.[1];
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
