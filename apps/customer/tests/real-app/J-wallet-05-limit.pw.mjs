// World: gates, stack
import { test, expect } from './journey.mjs';
import { fund, journeyState, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator } from './identity-factors.mjs';
import { ADDRESS, LABEL, withdrawKit } from './wallet-withdraw.mjs';

// J-wallet-05 #4's two withdrawals sent at once, in the running app (docs/roadmap/journeys.json): I withdraw crypto, and the
// 24-hour limit holds when two sends race. Split from J-wallet-05.pw.mjs so no one file holds the whole journey's time: run
// on this file's own verified TEST account with an authenticator app, TEST 300 USDT and one saved wallet on TEST Ethereum,
// approved by its emailed link and past its cooling-off (`local-test-stack.mjs age-addresses`). The limits are the TEST
// withdrawal terms the stack's founders publish in svc-pay (`local-test-gates.mjs withdraw-terms`): a fixed 1.5 network fee
// on top, a 90-second quote, USDT limits of 1000 a withdrawal and 5000 a day for verified accounts (the day counts the fee),
// sent by svc-pay's TEST custody signer for TEST Ethereum.
const J = 'J-wallet-05';
const run = journeyState(`${J}-limit-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const { account, totpLib, signInWithCode, customerApi, leftToday, fillSend, stepUp, saveAndApprove, readyToConfirm, sendOut } = withdrawKit(
  J,
  run,
);

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

test(`${J} #4 two withdrawals sent at once that together pass the 24-hour limit: exactly one goes through`, async ({ page, browser }) => {
  test.setTimeout(900_000);
  expect(fund(account().account.email, 'USDT', '5000').tx).toBeTruthy();
  await signInWithCode(page);
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
    const api = await customerApi();
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
      await stepUp(tab).getByRole('button', { name: 'Confirm' }).click();
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
