// World: restart, gates, stack
import { test, expect } from './journey.mjs';
import { fund, journeyState, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator } from './identity-factors.mjs';
import { ADDRESS, LABEL, withdrawKit } from './wallet-withdraw.mjs';

// J-wallet-05 #6 and #8, in the running app (docs/roadmap/journeys.json): I withdraw crypto, sent and then watched. Split
// from J-wallet-05.pw.mjs so no one file holds the whole journey's time: the same steps, run in order on this file's own
// verified TEST account with an authenticator app, TEST 300 USDT and one saved wallet on TEST Ethereum, approved by its
// emailed link and past its cooling-off (the wait is stood in for by `local-test-stack.mjs age-addresses`). The fee and the
// quote lifetime are the TEST withdrawal terms the stack's founders publish in svc-pay (`local-test-gates.mjs
// withdraw-terms`): a fixed 1.5 network fee on TEST Ethereum, the fee on top, a 90-second quote. svc-pay's TEST custody
// signer for TEST Ethereum sends through the in-memory MemoryChain. #8 watches the withdrawal #6 sent, so it runs after #6.
const J = 'J-wallet-05';
const run = journeyState(`${J}-send-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const { account, totpLib, freshCode, signInWithCode, customerApi, confirmSend, fillSend, stepUp, saveAndApprove, readyToConfirm } =
  withdrawKit(J, run);

/** svc-pay restarted with no settle depth for a send out (blank), or back on the stack's TEST depth (local-stack-services/pay.mjs). */
function payWithdrawDepth(published) {
  const before = process.env.LOCAL_STACK_PAY_WITHDRAW_DEPTH;
  if (published) delete process.env.LOCAL_STACK_PAY_WITHDRAW_DEPTH;
  else process.env.LOCAL_STACK_PAY_WITHDRAW_DEPTH = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'pay');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_PAY_WITHDRAW_DEPTH;
    else process.env.LOCAL_STACK_PAY_WITHDRAW_DEPTH = before;
  }
}

test(`${J} starts (send): a verified TEST account with 300 USDT, a second factor and a TEST Ethereum wallet approved and past its cooling-off`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  tool('local-test-gates.mjs', 'withdraw-terms');
  const who = await signUp(page, 'wd');
  await verify(page, who);
  await signIn(page, who);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ account: who, secret, step });
  expect(fund(who.email, 'USDT', '300').tx).toBeTruthy();

  // The TEST Ethereum wallet, saved and then approved by its emailed link opened in another browser (J-wallet-04 #5).
  await saveAndApprove(page, browser, who, LABEL, 'ethereum', ADDRESS);

  // The cooling-off runs from the approval; the LOCAL TEST clock moves it past its end.
  expect(tool('local-test-stack.mjs', 'age-addresses', who.email, '25')).toContain('1 saved address(es)');
  await page.reload();
  await expect(page.locator('tbody tr', { hasText: LABEL })).toContainText('Ready to use');
});

test(`${J} #6 reviews and confirms with a fresh step-up: no code keeps Confirm shut, a wrong one is refused in words, and neither sends anything; then one withdrawal, a success panel naming it, and its record`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  await signInWithCode(page);
  const api = await customerApi();
  // A missing step-up is a typed refusal: the signed-in session alone may not send, it lacks `trade:withdraw`.
  const send = {
    assetId: 'USDT',
    amount: '25',
    railId: 'crypto-native',
    networkId: 'ethereum',
    quoteRef: 'J-wallet-05-no-quote',
    destination: { kind: 'crypto', ref: ADDRESS },
    clientRef: `${J}-no-step-up`,
  };
  const unstepped = await api.create(send);
  expect(unstepped.status, JSON.stringify(unstepped.body)).toBe(403);
  expect(unstepped.body?.error?.data?.code).toBe('FORBIDDEN');
  expect(unstepped.body?.error?.message).toContain('trade:withdraw');
  // An expired step-up is refused too: its token lives five minutes, and once past that it sends nothing.
  const elevated = await api.stepUp();
  expect(Date.parse(elevated.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
  // While it lives, the same token gets past the step-up check: svc-pay stops only at the quote this send names, which
  // does not exist, so nothing is held.
  const live = await api.create({ ...send, clientRef: `${J}-live-step-up` }, elevated.accessToken);
  expect(live.status, JSON.stringify(live.body).slice(0, 400)).toBe(404);
  expect(live.body?.error?.data?.cause?.code, JSON.stringify(live.body).slice(0, 400)).toBe('withdrawal_quote.not_found');
  await page.waitForTimeout(Math.max(0, Date.parse(elevated.expiresAt) - Date.now()) + 2_000);
  // Once expired, the edge no longer vouches for it, and svc-pay refuses it as signed out: UNAUTHORIZED, not the
  // FORBIDDEN of a session that never stepped up.
  const expired = await api.create({ ...send, clientRef: `${J}-expired-step-up` }, elevated.accessToken);
  expect(expired.status, JSON.stringify(expired.body)).toBe(401);
  expect(expired.body?.error?.data?.code).toBe('UNAUTHORIZED');
  expect(await api.withdrawals()).toEqual([]);
  expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));

  await fillSend(page, '25');
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(page.getByTestId('withdraw-review')).toContainText('Leaves your balance26.5 USDT');
  await confirmSend(page).click();
  const dialog = stepUp(page);
  const code = dialog.getByLabel('Authenticator code or recovery code');
  // With no code typed, Confirm stays shut: nothing can be sent without one.
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await code.fill('000000');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toContainText('That code didn’t match. Check your authenticator app and try again.');
  expect(await api.withdrawals()).toEqual([]);

  await code.fill(await freshCode());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  const outcome = page.getByTestId('withdraw-outcome');
  await expect(outcome).toContainText('Withdrawal recorded', { timeout: 30_000 });
  const [made] = await api.withdrawals();
  expect(made?.id).toBeTruthy();
  // #8 watches this one by its id.
  run.reset({ ...account(), sent6: made.id });
  await expect(outcome).toContainText(`Withdrawal ${made.id} is recorded.`);
  expect(await api.withdrawals()).toHaveLength(1);
  // One withdrawal: 25 out with the 1.5 fee on top, so the balance reads 273.5.
  expect(toUnits(await api.available('USDT'))).toBe(toUnits('273.5'));
  await outcome.getByRole('link', { name: 'See this withdrawal' }).click();
  await expect(page.getByText(made.id).first()).toBeVisible();
});

test(`${J} #8 watches the status: requested, held, broadcast, confirming and settled in plain words, settled only at the owner's depth, and a failure reads as a sentence`, async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(600_000);
  // Every word the page may show, in the order a withdrawal moves through them, then the ends that are not Settled.
  const order = ['requested', 'pending_review', 'approved', 'held', 'dispatching', 'broadcast', 'confirming', 'settled'];
  const word = {
    requested: 'Requested',
    pending_review: 'In review',
    approved: 'Approved',
    held: 'Held',
    dispatching: 'Sending',
    broadcast: 'Broadcast',
    confirming: 'Confirming',
    settled: 'Settled',
    rejected: 'Rejected',
    canceled: 'Cancelled',
    failed: 'Failed',
    needs_review: 'Needs review',
  };
  const ownContext = await browser.newContext();
  try {
    const own = await ownContext.newPage();
    await signInWithCode(own);
    const api = await customerApi();
    const record = async (id) => {
      const found = (await api.withdrawals(200)).find((w) => w.id === id);
      expect(found, `svc-pay has withdrawal ${id}`).toBeTruthy();
      return found;
    };
    /**
     * The withdrawal's page, read between two reads of svc-pay's record: it shows a state the record held in that time
     * (the one read before, the one read after, or a step between them on the way to Settled), in its word.
     */
    const look = async (tab, id, reader = api, reads = []) => {
      const before = (await reader.withdrawal(id)).customerStatus;
      await tab.goto(`/uc/withdraw?withdrawalId=${id}`);
      const status = tab.getByTestId('withdrawal-status');
      await expect(status).toBeVisible({ timeout: 15_000 });
      const shown = { state: await status.getAttribute('data-status'), text: (await status.textContent())?.trim() };
      const after = (await reader.withdrawal(id)).customerStatus;
      reads.push(before, after);
      const [from, to, at] = [before, after, shown.state].map((state) => order.indexOf(state));
      const between = from >= 0 && to >= 0 && from <= at && at <= to;
      expect(
        between || [before, after].includes(shown.state),
        `the page reads ${shown.state} while svc-pay read ${before}, then ${after}`,
      ).toBe(true);
      expect(shown.text, `${shown.state} in its word`).toBe(word[shown.state]);
      return shown.state;
    };
    const forwards = (seen) => {
      for (const state of seen) expect(order, `${state} is a step on the way to Settled (${seen.join(' → ')})`).toContain(state);
      const steps = seen.map((state) => order.indexOf(state));
      expect(steps, `never backwards: ${seen.join(' → ')}`).toEqual([...steps].sort((a, b) => a - b));
    };
    /**
     * One real send from the Withdraw form. Its create is let through to svc-pay unchanged, and svc-pay's answer is held back
     * from the page until the form has been read: while the call is in flight the room says Requested. Returns svc-pay's
     * answer, as the page then gets it.
     */
    const sendWatched = async (amount) => {
      await readyToConfirm(page, amount);
      let release;
      const released = new Promise((resolve) => (release = resolve));
      let answered;
      const answer = new Promise((resolve) => (answered = resolve));
      await page.route('**/api/pay/trpc/withdrawal.create**', async (route) => {
        const response = await route.fetch();
        answered(await response.json());
        await released;
        await route.fulfill({ response });
      });
      try {
        await stepUp(page).getByRole('button', { name: 'Confirm' }).click();
        const requested = page.getByTestId('withdraw-requested');
        await expect(requested).toHaveAttribute('data-status', 'requested', { timeout: 30_000 });
        await expect(requested.locator('strong')).toHaveText(word.requested);
        const body = await answer;
        // Still in flight for the page while svc-pay has answered: the room still says Requested.
        await expect(requested).toBeVisible();
        release();
        await expect(requested).toBeHidden({ timeout: 30_000 });
        return body?.result?.data;
      } finally {
        release?.();
        await page.unroute('**/api/pay/trpc/withdrawal.create**');
      }
    };

    // #6's send, picked by the id #6 kept: Settled on its page and in svc-pay's record, and in the person's list.
    const sent6 = run.read().sent6;
    expect(sent6, 'the withdrawal #6 sent (#8 runs after #6)').toBeTruthy();
    await expect.poll(async () => (await api.withdrawal(sent6)).customerStatus, { timeout: 90_000 }).toBe('settled');
    expect(await look(own, sent6)).toBe('settled');
    const made6 = await record(sent6);
    expect(made6).toMatchObject({ status: 'settled', destination: { kind: 'crypto', ref: ADDRESS } });
    expect(toUnits(made6.amount)).toBe(toUnits('25'));
    await own.goto('/uc/withdraw');
    await own.mouse.move(0, 600);
    const row6 = own.getByTestId('withdrawal-history').locator(`[data-testid="withdrawal-row"][data-withdrawal-id="${sent6}"]`);
    await expect(row6.locator('[data-withdrawal-status]')).toHaveText('Settled', { timeout: 30_000 });

    // "An old `sent` row reads settled": a withdrawal svc-pay stored as `sent` (written as svc-pay's withdraw leaves one it
    // broadcast and settled, local-test-stack.mjs seed-withdrawal) reads Settled in svc-pay's answer, on its page and in the list.
    const seededOut = tool(
      'local-test-stack.mjs',
      'seed-withdrawal',
      account().account.email,
      'USDT',
      '2',
      '--state',
      'sent',
      '--ref',
      `jw05-sent-${process.env.JOURNEY_RUN_ID ?? 'local'}-${Date.now().toString(36)}`,
    );
    const oldSent = /^\s*withdrawal\s+([0-9a-f-]{36})$/m.exec(seededOut)?.[1];
    expect(oldSent, seededOut).toMatch(/^[0-9a-f-]{36}$/);
    expect(seededOut).toMatch(/state\s+sent\b/);
    expect((await api.withdrawal(oldSent)).customerStatus).toBe('settled');
    expect(await record(oldSent)).toMatchObject({ status: 'settled' });
    expect(await look(own, oldSent)).toBe('settled');
    await expect(own.getByTestId('withdrawal-status')).toHaveText('Settled');
    await own.goto('/uc/withdraw');
    await own.mouse.move(0, 600);
    const sentRow = own.getByTestId('withdrawal-history').locator(`[data-testid="withdrawal-row"][data-withdrawal-id="${oldSent}"]`);
    await expect(sentRow.locator('[data-withdrawal-status]')).toHaveText('Settled', { timeout: 30_000 });

    // A new real send of 12, watched from the request to Settled. svc-pay books the hold inside the create and answers
    // Held; its advance worker then sends it on the stack's TEST chain, which answers after a few seconds and makes a block
    // every few seconds after that; svc-pay settles it only once the chain holds it at PAY_MIN_CONFIRMATIONS deep.
    const freeBeforeTwelve = toUnits(await api.available('USDT'));
    const reservedBeforeTwelve = toUnits(await api.reserved('USDT'));
    await signInWithCode(page);
    const twelve = await sendWatched('12');
    expect(twelve, 'svc-pay answered the create').toBeTruthy();
    expect(twelve).toMatchObject({ status: 'held', customerStatus: 'held', cancellable: true });
    expect(toUnits(twelve.amount)).toBe(toUnits('12'));
    // svc-pay's own record reads it back held, and the ledger has reserved the 12 with the TEST 1.5 fee on top.
    expect((await api.withdrawal(twelve.id)).customerStatus, 'withdrawal.get reads the new send back').toBe('held');
    expect(toUnits(await api.reserved('USDT')), 'the ledger holds 12 + 1.5 for it').toBe(reservedBeforeTwelve + toUnits('13.5'));
    expect(toUnits(await api.available('USDT')), 'and it left the available balance').toBe(freeBeforeTwelve - toUnits('13.5'));
    await expect(page.getByTestId('withdraw-outcome')).toContainText(`Withdrawal ${twelve.id} is recorded.`);
    await expect(page.getByTestId('withdraw-outcome-status')).toHaveText(word.held);

    const seen = [];
    const reads = [];
    const until = Date.now() + 120_000;
    while (seen.at(-1) !== 'settled' && Date.now() < until) {
      const state = await look(own, twelve.id, api, reads);
      if (seen.at(-1) !== state) seen.push(state);
    }
    expect(seen.at(-1), `seen: ${seen.join(' → ')}`).toBe('settled');
    forwards(seen);
    for (const state of ['held', 'dispatching', 'broadcast', 'confirming']) {
      expect(seen, `the page read the real send ${state} on its way: ${seen.join(' → ')}`).toContain(state);
      expect(reads, `svc-pay itself read it ${state}: ${reads.join(', ')}`).toContain(state);
    }
    const made12 = await record(twelve.id);
    expect(made12.status).toBe('settled');
    expect(toUnits(made12.amount)).toBe(toUnits('12'));
    // Settled, read back from the ledger: the hold is gone and the 12 with its 1.5 fee left the person's money for good.
    expect(toUnits(await api.reserved('USDT')), 'the settle consumed the hold').toBe(reservedBeforeTwelve);
    expect(toUnits(await api.available('USDT')), 'the settled 12 took 12 + 1.5 from the balance').toBe(freeBeforeTwelve - toUnits('13.5'));

    // A real send the TEST chain refuses (any send of exactly 13, `PAY_TEST_CHAIN_REFUSE_AMOUNT`): held by the create, then
    // refused when the worker sends it, its hold back, and the page says why in a sentence, never as its code.
    const freeBeforeThirteen = toUnits(await api.available('USDT'));
    const reservedBeforeThirteen = toUnits(await api.reserved('USDT'));
    const thirteen = await sendWatched('13');
    expect(thirteen).toMatchObject({ status: 'held', customerStatus: 'held' });
    expect(toUnits(await api.reserved('USDT')), 'the ledger holds 13 + 1.5 for it').toBe(reservedBeforeThirteen + toUnits('14.5'));
    await expect.poll(async () => (await api.withdrawal(thirteen.id)).customerStatus, { timeout: 60_000 }).toBe('failed');
    const refused = await record(thirteen.id);
    expect(refused).toMatchObject({ status: 'failed', failure: { code: 'rail.refused', known: true } });
    expect(toUnits(refused.amount)).toBe(toUnits('13'));
    expect(toUnits(await api.reserved('USDT')), 'the refused send’s hold went back').toBe(reservedBeforeThirteen);
    expect(toUnits(await api.available('USDT')), 'and the balance is whole again').toBe(freeBeforeThirteen);
    expect(await look(own, thirteen.id)).toBe('failed');
    await expect(own.getByTestId('withdrawal-facts')).toContainText(
      'The network refused this withdrawal. Nothing was sent, and any amount held for it went back to your available balance.',
    );
    await expect(own.getByTestId('withdrawal-facts')).not.toContainText('rail.refused');

    // Settled comes only from the owner's settle depth. With it blank, svc-pay invents none: a send out refuses with its one
    // typed code before anything is held, and the room says so in a sentence. svc-pay is restarted on the TEST depth after.
    const freeBeforeBlank = toUnits(await api.available('USDT'));
    const reservedBeforeBlank = toUnits(await api.reserved('USDT'));
    const countBeforeBlank = (await api.withdrawals(200)).length;
    try {
      payWithdrawDepth(false);
      await signInWithCode(page);
      await readyToConfirm(page, '11');
      const answered = page.waitForResponse((res) => res.url().includes('/api/pay/trpc/withdrawal.create'));
      await stepUp(page).getByRole('button', { name: 'Confirm' }).click();
      const blank = await (await answered).json();
      expect(blank?.error?.data?.cause?.code, JSON.stringify(blank).slice(0, 400)).toBe('pay.withdraw_confirmations_unset');
      const outcome = page.getByTestId('withdraw-outcome');
      await expect(outcome).toContainText('Not sent');
      await expect(outcome).toContainText(
        'No confirmation depth is published for sending to a wallet outside INTAFACED, so this withdrawal was refused before anything was held.',
      );
      await expect(outcome).not.toContainText('pay.withdraw_confirmations_unset');
      expect(toUnits(await api.available('USDT')), 'nothing left the available balance').toBe(freeBeforeBlank);
      expect(toUnits(await api.reserved('USDT')), 'and nothing is held').toBe(reservedBeforeBlank);
      expect(await api.withdrawals(200), 'svc-pay recorded no withdrawal').toHaveLength(countBeforeBlank);
    } finally {
      payWithdrawDepth(true);
    }
  } finally {
    await ownContext.close();
  }
});
