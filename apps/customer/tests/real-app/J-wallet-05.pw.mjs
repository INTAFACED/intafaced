// World: restart, gates, stack
import { test, expect } from './journey.mjs';
import { fund, journeyState, toUnits, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator } from './identity-factors.mjs';
import { TEST_WITHDRAW_NETWORK_RULES } from '../../../../tooling/scripts/local-test-gates.mjs';
import { LOCAL_TEST_SANCTIONED_ADDRESS } from '../../../../tooling/scripts/local-stack-services/bank.mjs';
import { ADDRESS, LABEL, BASE_ADDRESS, BASE_LABEL, withdrawKit } from './wallet-withdraw.mjs';

// J-wallet-05, in the running app (docs/roadmap/journeys.json): I withdraw crypto. One test per step, titled
// "J-wallet-05 #<n>", run in order on one verified TEST account with an authenticator app, TEST 300 USDT, and two saved
// wallets, one on TEST Ethereum and one on TEST Base, each approved by its emailed link and past its cooling-off (the wait is
// stood in for by `local-test-stack.mjs age-addresses`). The fee, the quote lifetime and the limits are the TEST withdrawal
// terms the stack's founders publish in svc-pay (`local-test-gates.mjs withdraw-terms`): a fixed 1.5 network fee on TEST
// Ethereum and TEST Base, the fee on top, a 90-second quote, USDT limits of 1000 a withdrawal and 5000 a day for verified
// accounts (the day counts the fee), and a TEST custody policy that lets a TEST send out on the crypto-native rail through.
// The stack's svc-pay has a TEST custody signer for TEST Ethereum only (`PAY_TEST_WITHDRAW_SIGNER_NETWORKS`), sending through
// the in-memory MemoryChain; TEST Base has none, which is what #7 meets. #6, #8 (which watches the withdrawal #6 sent) and #4's two
// parallel sends run in J-wallet-05-send.pw.mjs and J-wallet-05-limit.pw.mjs, each on its own account, so no
// one file holds the whole journey's time; here #7 still meets the balance at 300.
// #2's sanctions clause uses the stack's LOCAL TEST destination sanctions list (svc-bank `BANK_DESTINATION_SANCTIONS`, set only
// by local-stack-services/bank.mjs), one made-up address and not a real list.
// #5 (travel rule) waits for launch (owner decision 2026-10-27).
const J = 'J-wallet-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
// The address the stack's TEST fraud list holds (svc-bank, listed by `local-test-gates.mjs withdraw-terms`, W-withdraw-03).
const FRAUD_LISTED = '0x7e5700000000000000000000000000000000fa1d';

test.describe.configure({ mode: 'default' });

const {
  account,
  totpLib,
  signInWithCode,
  confirmItsMe,
  customerApi,
  form,
  pick,
  amountBox,
  confirmSend,
  fillSend,
  stepUp,
  saveAndApprove,
} = withdrawKit(J, run);

/** svc-pay restarted with no sanctions screener (the blank list), or back on the stack's local-test screener. */
function payScreener(on) {
  const before = process.env.LOCAL_STACK_PAY_SCREENER;
  if (on) delete process.env.LOCAL_STACK_PAY_SCREENER;
  else process.env.LOCAL_STACK_PAY_SCREENER = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'pay');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_PAY_SCREENER;
    else process.env.LOCAL_STACK_PAY_SCREENER = before;
  }
}

test(`${J} starts: a verified TEST account with 300 USDT, a second factor and a saved wallet approved and past its cooling-off`, async ({
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

  // Two wallets, each saved and then approved by its emailed link opened in another browser (J-wallet-04 #5).
  for (const [label, network, address] of [
    [LABEL, 'ethereum', ADDRESS],
    [BASE_LABEL, 'base', BASE_ADDRESS],
  ]) {
    await saveAndApprove(page, browser, who, label, network, address);
  }

  // The cooling-off runs from the approval; the LOCAL TEST clock moves it past its end.
  expect(tool('local-test-stack.mjs', 'age-addresses', who.email, '25')).toContain('2 saved address(es)');
  await page.reload();
  await expect(page.locator('tbody tr', { hasText: LABEL })).toContainText('Ready to use');
  await expect(page.locator('tbody tr', { hasText: BASE_LABEL })).toContainText('Ready to use');
});

test(`${J} #1 opens Withdraw and picks asset and network: the default network with its tag rule, minimum, maximum and step from the catalogue, and a changed network checks the address again`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  // The default is the one svc-bank's catalogue names for USDT, read from the catalogue itself, never a guess.
  const api = await customerApi();
  const usdt = (await api.networks()).find((entry) => entry.assetId === 'USDT');
  expect(usdt?.defaultNetworkId, 'the catalogue names a default network for USDT').toBeTruthy();
  expect(usdt.networks.map((network) => network.networkId)).toContain(usdt.defaultNetworkId);
  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  await pick(page, 'Asset').selectOption('USDT');
  await expect(pick(page, 'Network')).toHaveValue(usdt.defaultNetworkId);
  // The steps below use TEST Ethereum's address book and rules, so the stack's default must be that one.
  expect(usdt.defaultNetworkId, 'the stack publishes TEST Ethereum as the USDT default').toBe('ethereum');

  // A typed address is checked on the network chosen: saved on TEST Ethereum, not saved on TEST Base.
  const typed = form(page).getByRole('textbox', { name: /^Or enter a new address/ });
  await typed.fill(ADDRESS);
  await expect(form(page)).toContainText(`This is your saved address ${LABEL}. Choose it above to send to it.`);
  await pick(page, 'Network').selectOption('base');
  await expect(form(page)).toContainText('This address is not in your address book, so nothing is sent to it.');
  await pick(page, 'Network').selectOption('ethereum');

  // The network's own rules, as the catalogue publishes them for TEST Ethereum: no tag, and a minimum, maximum and step.
  const rules = page.getByTestId('withdraw-network-rules');
  await expect(rules).toBeVisible();
  await expect(rules).toContainText('This network takes no tag or memo.');
  // Each figure is the one the stack's founders published (TEST_WITHDRAW_NETWORK_RULES: 1, 1000 and 0.01), compared as a
  // number so a grouped or zero-padded display of the same value still matches, and any other value fails.
  const figure = (text) =>
    text
      .replace(/,/g, '')
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '');
  for (const [rule, want] of [
    ['Minimum', TEST_WITHDRAW_NETWORK_RULES.minimum],
    ['Maximum', TEST_WITHDRAW_NETWORK_RULES.maximum],
    ['Step', TEST_WITHDRAW_NETWORK_RULES.step],
  ]) {
    const shown = (await rules.textContent()).match(new RegExp(`${rule}\\D*?([\\d.,]+) USDT`));
    expect(shown, `${rule} is shown`).not.toBeNull();
    expect(figure(shown[1]), `${rule} is the catalogue's TEST ${want} USDT`).toBe(figure(want));
  }
  await expect(form(page).getByRole('textbox', { name: /^(Tag|Memo)/ })).toHaveCount(0);
  // A tag on a network without tags is refused by svc-pay itself, by name, with a real quote and a fresh step-up: never
  // dropped and sent without it. Then nothing is held and nothing is recorded.
  const quoteRef = `${J}-tag-quote-${Date.now()}`;
  const quoted = await api.quote({ quoteRef, assetId: 'USDT', networkId: 'ethereum', amount: '25' });
  expect(quoted.status, JSON.stringify(quoted.body).slice(0, 400)).toBe(200);
  const tagged = await api.create(
    {
      assetId: 'USDT',
      amount: '25',
      railId: 'crypto-native',
      networkId: 'ethereum',
      quoteRef,
      destination: { kind: 'crypto', ref: ADDRESS, tag: '12345' },
      clientRef: `${J}-tag-${Date.now()}`,
    },
    (await api.stepUp()).accessToken,
  );
  expect(tagged.body?.error?.data?.cause?.code, JSON.stringify(tagged.body).slice(0, 400)).toBe('pay.withdrawal_tag_not_taken');
  expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
  expect(await api.withdrawals()).toEqual([]);
});

test(`${J} #2 picks the saved address or pastes one: a mistyped address is refused before any call, and an address on the fraud list is refused by name with nothing held, and so is a sanctioned address`, async ({
  page,
}) => {
  // Two svc-pay restarts (screener off, then back on) take most of a minute each.
  test.setTimeout(480_000);
  await signInWithCode(page);
  const writes = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/pay\//.test(request.url())) writes.push(request.url());
  });
  await page.goto('/uc/withdraw');
  await page.mouse.move(0, 600);
  await pick(page, 'Asset').selectOption('USDT');
  await form(page)
    .getByRole('textbox', { name: /^Or enter a new address/ })
    .fill(ADDRESS.slice(0, -1));
  await expect(form(page)).toContainText('This is not a valid address. It must be 0x followed by 40 letters a to f or digits.');
  expect(writes).toEqual([]);

  // The TEST fraud list holds FRAUD_LISTED: saving it is refused with the reason, and it never reaches the address book.
  await page.goto('/uc/withdraw/address');
  const add = page.getByRole('form', { name: 'Add an address' });
  await add.getByRole('textbox', { name: /^Label/ }).fill('TEST fraud-listed wallet');
  await add.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await add.getByRole('combobox', { name: /^Network/ }).selectOption('ethereum');
  await add.getByRole('textbox', { name: /^Address/ }).fill(FRAUD_LISTED);
  await add.getByRole('button', { name: 'Save address' }).click();
  const refusal = add.getByRole('alert');
  await expect(refusal.or(stepUp(page))).toBeVisible();
  if (await stepUp(page).isVisible()) await confirmItsMe(page);
  await expect(refusal).toHaveText('This address is on our fraud list, so it can’t be saved. Nothing was saved.');
  await expect(page.locator('tbody tr', { hasText: 'TEST fraud-listed wallet' })).toHaveCount(0);

  // The screen may refuse on its pre-check; the bank itself refuses the save with its typed code, even with a fresh step-up.
  const api = await customerApi();
  const listed = await api.saveAddress(
    { assetId: 'USDT', network: 'ethereum', ref: FRAUD_LISTED, label: 'TEST fraud-listed wallet' },
    (await api.stepUp()).accessToken,
  );
  expect(listed.body?.error?.data?.cause?.code).toBe('bank.destination_fraud_listed');
  expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
  expect(await api.withdrawals()).toEqual([]);

  // The blank-list half: with no screener set, svc-pay refuses a send to the saved, ready address with its typed code before
  // anything is held. svc-pay is put back on the stack's local-test screener afterwards, so #6 and #4 can still send.
  try {
    payScreener(false);
    await fillSend(page, '25');
    await page.getByRole('button', { name: 'Get the fee' }).click();
    await expect(page.getByTestId('withdraw-review')).toContainText('Leaves your balance26.5 USDT');
    const answered = page.waitForResponse((res) => res.url().includes('/api/pay/trpc/withdrawal.create'));
    await confirmSend(page).click();
    await confirmItsMe(page);
    const refused = await (await answered).json();
    expect(refused?.error?.data?.cause?.code, JSON.stringify(refused).slice(0, 400)).toBe('pay.guard_screening_unavailable');
    const outcome = page.getByTestId('withdraw-outcome');
    await expect(outcome).toContainText('Not sent');
    await expect(outcome).toContainText('Nothing was sent: no sanctions screening service is connected, and every send needs one.');
    await expect(outcome).toContainText('Nothing was sent and nothing is held. Your available balance is 300 USDT.');
    expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
    expect(await api.withdrawals()).toEqual([]);
  } finally {
    payScreener(true);
  }

  // The sanctions clause: the address on the stack's LOCAL TEST destination sanctions list is refused by name when saved,
  // in the customer's words, and never reaches the address book; nothing is held and nothing is sent.
  await page.goto('/uc/withdraw/address');
  const again = page.getByRole('form', { name: 'Add an address' });
  await again.getByRole('textbox', { name: /^Label/ }).fill('TEST sanctioned wallet');
  await again.getByRole('combobox', { name: /^Asset/ }).selectOption('USDT');
  await again.getByRole('combobox', { name: /^Network/ }).selectOption('ethereum');
  await again.getByRole('textbox', { name: /^Address/ }).fill(LOCAL_TEST_SANCTIONED_ADDRESS);
  await again.getByRole('button', { name: 'Save address' }).click();
  // The check before the confirmation code refuses it, so no code is asked for.
  await expect(again.getByRole('alert')).toHaveText('This address is on the sanctions list, so it can’t be saved. Nothing was saved.');
  await expect(stepUp(page)).toHaveCount(0);
  await expect(page.locator('tbody tr', { hasText: 'TEST sanctioned wallet' })).toHaveCount(0);
  // The bank itself refuses it with its typed code, however its letters are cased, even with a fresh step-up.
  for (const ref of [LOCAL_TEST_SANCTIONED_ADDRESS, LOCAL_TEST_SANCTIONED_ADDRESS.toUpperCase().replace('0X', '0x')]) {
    const sanctioned = await api.saveAddress(
      { assetId: 'USDT', network: 'ethereum', ref, label: 'TEST sanctioned wallet' },
      (await api.stepUp()).accessToken,
    );
    expect(sanctioned.body?.error?.data?.cause?.code, JSON.stringify(sanctioned.body).slice(0, 400)).toBe(
      'bank.destination_sanctions_listed',
    );
  }
  expect((await api.addresses()).filter((row) => row.label === 'TEST sanctioned wallet')).toEqual([]);
  expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
  expect(await api.withdrawals()).toEqual([]);
});

test(`${J} #3 reads the fee quote: fee, what arrives and the total debit as exact decimals, an expired quote must be got again, and a blank fee is a refusal`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInWithCode(page);
  await fillSend(page, '25');
  const fee = page.getByTestId('withdraw-fee');
  const review = page.getByTestId('withdraw-review');
  await expect(fee).toContainText('Get the fee to see it');
  await expect(page.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();

  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(fee).toContainText('1.5 USDT');
  await expect(review).toContainText('Network fee1.5 USDT');
  await expect(review).toContainText('Arrives25 USDT');
  await expect(review).toContainText('Leaves your balance26.5 USDT');
  await expect(page.getByText('The fee is added to the amount.')).toBeVisible();
  await expect(confirmSend(page)).toBeEnabled();

  // A changed amount drops the quote: no fee is shown for terms it was not quoted for.
  await amountBox(page).fill('26');
  await expect(fee).toContainText('Get the fee to see it');
  await expect(page.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();

  // The TEST quote lives 90 seconds. Once it has expired, confirm goes off until the fee is got again.
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(review).toContainText('Leaves your balance27.5 USDT');
  await expect(page.getByText('This quote has expired. Get the fee again.')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(review).toContainText('Leaves your balance27.5 USDT');
  await expect(confirmSend(page)).toBeEnabled();

  // A blank fee is a refusal: TEST Ethereum's fee is cleared through the founders' own door for this clause only, and put
  // back in the finally. The page names it in words, svc-pay answers one typed code, and nothing is quoted or held.
  const api = await customerApi();
  try {
    tool('local-test-gates.mjs', 'withdraw-fee', 'ethereum', 'unset');
    await amountBox(page).fill('25');
    await page.getByRole('button', { name: 'Get the fee' }).click();
    await expect(page.getByText('No fee is set for this network, so nothing can be sent on it.')).toBeVisible();
    await expect(fee).not.toContainText('1.5 USDT');
    await expect(page.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();
    await expect(confirmSend(page)).toHaveCount(0);
    const blank = await api.quote({ quoteRef: `${J}-blank-fee-${Date.now()}`, assetId: 'USDT', networkId: 'ethereum', amount: '25' });
    expect(blank.body?.error?.data?.cause?.code, JSON.stringify(blank.body).slice(0, 400)).toBe('pay.fee_unset');
    expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
    expect(await api.withdrawals()).toEqual([]);
  } finally {
    tool('local-test-gates.mjs', 'withdraw-fee', 'ethereum', 'test');
  }
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(fee).toContainText('1.5 USDT');
});

test(`${J}, part of #4 reads the limit line: what the account's level may send now, per withdrawal and in 24 hours`, async ({ page }) => {
  test.setTimeout(180_000);
  await signInWithCode(page);
  await fillSend(page, '25');
  await expect(page.getByTestId('withdraw-limit')).toContainText(
    'You can send up to 1,000 USDT now: 1,000 per withdrawal, and 5,000 of 5,000 left in the last 24 hours.',
  );
});

test(`${J} #4 a blank limit refuses and holds nothing`, async ({ page }) => {
  test.setTimeout(300_000);
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
    await page.getByRole('button', { name: 'Get the fee' }).click();
    await expect(page.getByTestId('withdraw-fee')).toContainText('1.5 USDT');
    // With the fee in hand the send still cannot be reviewed: no limit, no confirm.
    await expect(page.getByRole('button', { name: 'Review withdrawal' })).toBeDisabled();
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
});

test(`${J} #7 confirms with a fresh step-up while no signer is connected: refused by name, nothing held, the balance still reads 300`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInWithCode(page);
  // TEST Base has no custody signer on the stack; TEST Ethereum's TEST signer is what #6 and #4 use.
  await fillSend(page, '25', { base: true });
  await page.getByRole('button', { name: 'Get the fee' }).click();
  await expect(page.getByTestId('withdraw-review')).toContainText('Leaves your balance26.5 USDT');
  await confirmSend(page).click();
  await expect(page.getByRole('dialog', { name: 'Confirm it’s you' })).toContainText('Sending money out needs a fresh confirmation.');
  const answered = page.waitForResponse((res) => res.url().includes('/api/pay/trpc/withdrawal.create'));
  await confirmItsMe(page);
  // svc-pay refuses with the one typed code for a network with no signer.
  const refused = await (await answered).json();
  expect(refused?.error?.data?.cause?.code, JSON.stringify(refused).slice(0, 400)).toBe('pay.wallet_withdraw_unavailable');

  const outcome = page.getByTestId('withdraw-outcome');
  await expect(outcome).toContainText('Not sent');
  await expect(outcome).toContainText(
    'Sending to a wallet outside INTAFACED isn’t connected: no custody signer is set up, so this withdrawal was refused before anything was held.',
  );
  await expect(outcome).toContainText('Nothing was sent and nothing is held. Your available balance is 300 USDT.');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The ledger agrees: nothing left the available balance, and svc-pay recorded no withdrawal.
  const api = await customerApi();
  expect(toUnits(await api.available('USDT'))).toBe(toUnits('300'));
  expect(await api.withdrawals()).toEqual([]);
  await page.reload();
  await expect(page.getByText('No withdrawals yet')).toBeVisible();
});
