// World: gates, stack
import { test, expect } from './journey.mjs';
import { fund, journeyState, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator } from './identity-factors.mjs';
import { ADDRESS, LABEL, withdrawKit } from './wallet-withdraw.mjs';

// J-wallet-05 #4 whole, in the running app (docs/roadmap/journeys.json): I withdraw crypto, and the limit line shows the
// allowance for the account's level, a blank limit refuses and holds nothing, and the 24-hour limit holds when two sends race. Split from J-wallet-05.pw.mjs so no one file holds the whole journey's time: run
// on this file's own verified TEST account with an authenticator app, TEST 300 USDT and one saved wallet on TEST Ethereum,
// approved by its emailed link and past its cooling-off (`local-test-stack.mjs age-addresses`). The limits are the TEST
// withdrawal terms the stack's founders publish in svc-pay (`local-test-gates.mjs withdraw-terms`): a fixed 1.5 network fee
// on top, a 90-second quote, USDT limits of 1000 a withdrawal and 5000 a day for verified accounts (the day counts the fee),
// sent by svc-pay's TEST custody signer for TEST Ethereum.
const J = 'J-wallet-05';
const run = journeyState(`${J}-limit-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const { account, totpLib, signInWithCode, customerApi, leftToday, fillSend, confirmSend, stepUp, saveAndApprove, readyToConfirm, sendOut } =
  withdrawKit(J, run);

test(`${J} starts (limit): a verified TEST account with 300 USDT, a second factor and a TEST Ethereum wallet approved and past its cooling-off`, async ({
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

test(`${J} #4 reads the limit line: the remaining allowance for the account's level; a blank limit refuses and holds nothing; two withdrawals sent at once that together pass the 24-hour limit let exactly one through`, async ({
  page,
  browser,
}) => {
  test.setTimeout(1_200_000);
  await signInWithCode(page);
  const api = await customerApi();
  // "The remaining allowance for the person's tier": svc-pay's limits for this account's level, and the limit line
  // shows exactly those figures. Nothing has been sent yet, so all of the 24-hour limit is left.
  const limits = await api.limits('USDT');
  expect(limits.status, JSON.stringify(limits.body).slice(0, 400)).toBe(200);
  expect(limits.data).toMatchObject({ tier: 'full', assetId: 'USDT', perTx: '1000', rolling24h: '5000', used24h: '0' });
  expect(limits.data.remaining).toEqual({ perTx: '1000', rolling24h: '5000' });
  expect(limits.data.maxNow).toBe('1000');
  await fillSend(page, '25');
  await expect(page.getByTestId('withdraw-limit')).toContainText(
    'You can send up to 1,000 USDT now: 1,000 per withdrawal, and 5,000 of 5,000 left in the last 24 hours.',
  );
  // The account's level (full) and USDT: the stack's TEST limit is cleared to unset through the founders' own door for this
  // step only, and put back in the finally, so every other step still meets the TEST figures.
  try {
    tool('local-test-gates.mjs', 'withdraw-limit', 'full', 'USDT', 'unset');
    await fillSend(page, '25');
    // The limit line says in words that no limit is set, and nothing can be reviewed, so nothing can be confirmed.
    await expect(page.getByTestId('withdraw-limit').locator('p')).toHaveText(
      'No withdrawal limit is set for your account level and this asset, so nothing can be sent.',
    );
    await page.getByRole('button', { name: 'Get the fee', exact: true }).click();
    await expect(page.getByTestId('withdraw-fee')).toContainText('1.5 USDT');
    // With the fee in hand the send still cannot be reviewed: no limit, no confirm.
    await expect(page.getByRole('button', { name: 'Review withdrawal', exact: true })).toBeDisabled();
    await expect(confirmSend(page)).toHaveCount(0);
    // svc-pay itself refuses a send that skips the page: one exact typed code, with a real quote and a fresh step-up.
    const quoteRef = `${J}-blank-limit-quote-${Date.now()}`;
    const quoted = await api.quote({ quoteRef, assetId: 'USDT', networkId: 'ethereum', amount: '25' });
    expect(quoted.status, JSON.stringify(quoted.body).slice(0, 400)).toBe(200);
    const refused = await api.create(
      {
        assetId: 'USDT',
        amount: '25',
        railId: 'crypto-native',
        networkId: 'ethereum',
        quoteRef,
        destination: { kind: 'crypto', ref: ADDRESS },
        clientRef: `${J}-blank-limit-${Date.now()}`,
      },
      (await api.stepUp()).accessToken,
    );
    expect(refused.body?.error?.data?.cause?.code, JSON.stringify(refused.body).slice(0, 400)).toBe('pay.guard_withdrawal_limit_unset');
    // Nothing held, nothing recorded.
    expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
    expect(await api.withdrawals()).toEqual([]);
  } finally {
    tool('local-test-gates.mjs', 'withdraw-limit', 'full', 'USDT', 'test');
  }
  // Back to the TEST figures: the limit line reads them again.
  await fillSend(page, '25');
  await expect(page.getByTestId('withdraw-limit')).toContainText('You can send up to 1,000 USDT now');

  // Two withdrawals sent at once: a 5,000 top-up so the race can reach the 24-hour limit.
  expect(fund(account().account.email, 'USDT', '5000').tx).toBeTruthy();
  await page.reload();
  // Use the allowance up 1,000 at a time (the most one withdrawal may send) until less than 1,000 is left.
  await fillSend(page, '1');
  let left = await leftToday(page);
  while (left > 1000) {
    await sendOut(page, '1000');
    await fillSend(page, '1');
    left = await leftToday(page);
  }
  // Each of the two fits what is left on its own; together they do not.
  const each = String(Math.floor(left / 2) + 1);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await signInWithCode(other);
    const before = (await api.withdrawals()).length;
    const availableBefore = toUnits(await api.available('USDT'));
    await readyToConfirm(page, each);
    await readyToConfirm(other, each);
    const answers = [page, other].map((tab) => tab.waitForResponse((res) => res.url().includes('/api/pay/trpc/withdrawal.create')));
    // Each tab passes its own step-up, one after the other: a code from an earlier 30-second step than one already used is
    // refused, so the two can't verify in either order. Each send then waits in its browser until both are made, and the two
    // go to svc-pay together.
    const isCreate = (url) => url.href.includes('/api/pay/trpc/withdrawal.create');
    let release;
    const bothMade = new Promise((resolve) => (release = resolve));
    let made = 0;
    for (const tab of [page, other]) {
      await tab.route(isCreate, async (route) => {
        if (++made === 2) release();
        await bothMade;
        await route.continue();
      });
    }
    // readyToConfirm typed each tab's code, the second from a later step, so neither send is held for long once it is made
    // and both quotes are still live (90 seconds) when they reach svc-pay.
    for (const tab of [page, other]) {
      const sent = tab.waitForRequest((req) => isCreate(new URL(req.url())));
      await stepUp(tab).getByRole('button', { name: 'Confirm', exact: true }).click();
      await sent;
    }
    // svc-pay answers one send and refuses the other with the one typed code for a limit that would be passed.
    const bodies = await Promise.all(answers.map(async (answer) => (await answer).json()));
    const codes = bodies.map((body) => body?.error?.data?.cause?.code ?? null);
    expect(
      codes.filter((c) => c === null),
      JSON.stringify(bodies).slice(0, 600),
    ).toHaveLength(1);
    expect(codes.filter((c) => c !== null)).toEqual(['pay.guard_withdrawal_limit_exceeded']);
    const states = await Promise.all(
      [page, other].map(async (tab) => {
        const outcome = tab.getByTestId('withdraw-outcome');
        await expect(outcome).toBeVisible({ timeout: 30_000 });
        return outcome.getAttribute('data-status');
      }),
    );
    expect(states.filter((state) => state === 'refused')).toHaveLength(1);
    expect(states.filter((state) => state !== 'refused' && state !== 'unknown')).toHaveLength(1);
    expect(await api.withdrawals()).toHaveLength(before + 1);
    // Exactly one amount and its 1.5 fee left the available balance; the refused one held nothing.
    expect(toUnits(await api.available('USDT'))).toBe(availableBefore - toUnits(each) - toUnits('1.5'));
  } finally {
    await otherContext.close();
  }
});
