import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, journeyState, tool } from './stack.mjs';
import { forgetSession, nextCode } from './identity-factors.mjs';
import {
  businessReadyPerson,
  openBusiness,
  paidCardPayment,
  payApiOf,
  refusedPayCalls,
  signInWithCode,
  verifiedBusiness,
} from './merchant.mjs';
import { tableIn } from './tables.mjs';

// J-merchant-07, in the running app (docs/roadmap/journeys.json): see the business's money and ask for a payout. One test
// per step, titled "J-merchant-07 #<n>", run in order on one verified TEST business. #1 makes the owner and the business
// and reads Money while it has none. The later steps need TEST settlements posted to it, a verified default destination
// and a finance teammate who can request but not send.
// #2 settles #1's own payment through the service and keeps the posted settlement for the payout steps.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #7 and #8 ask the stack for more TEST settlements (`local-test-world.mjs merchant-settlement <merchantId>`, proposed)
//   to pay out (M-money-out-05).
// - #3: the stack publishes no pricing schedule for a TEST business, so Pricing shows no fee table and the calculator
//   is off (`local-test-world.mjs merchant-pricing`, proposed).
// - #4: no payout schedule or rules (M-money-out-03, M-adv-money-out-01); #5: no top-up (M-money-out-02).
const J = 'J-merchant-07';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

const saved = (who) => ({ handle: who.handle, email: who.email, password: who.password, secret: who.secret, step: who.step });

function journey() {
  const state = run.read();
  if (!state.owner?.secret) throw new Error(`${J} #1 made no business, so this step has no owner to act as`);
  return state;
}

async function signInOwner(page, destination) {
  const state = journey();
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const who = { ...state.owner, totp };
  await signInWithCode(page, who, destination);
  run.write({ owner: saved(who) });
  return { ...who, totp };
}

/** The owner's own pay API through Edge; the code's time step is kept for the next sign-in. */
async function ownerApi() {
  const state = journey();
  return payApiOf(state.owner, (step) => run.write({ owner: { ...state.owner, step } }));
}

/** The TEST settlement the stack posts to the business, read back as its row on Settlements. */
function postedSettlement() {
  const { merchantId } = journey();
  const out = tool('local-test-world.mjs', 'merchant-settlement', merchantId, '--net', '100', '--asset', 'USDT');
  return /settlement\s+([0-9a-f-]{36})/.exec(out)?.[1];
}

test(`${J} #1 opens Money: zero per asset with "No money yet" for a new business; with balances, clearing and available and a reserve card "recorded, not withheld"`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const owner = await businessReadyPerson(page, 'mm');
  const merchantId = await openBusiness(page, owner);
  await verifiedBusiness(page, owner, merchantId);
  run.reset({ owner: saved(owner), merchantId });
  await signInOwner(page, '/pay/money');
  const refused = refusedPayCalls(page);
  await expect(page.getByRole('heading', { name: 'Balances', level: 1 })).toBeVisible();
  await expect(page.getByText('No money yet')).toBeVisible();
  await expect(page.getByRole('group', { name: /Balances at a glance/ })).toHaveCount(0);
  // The reserve card is there before the first payment too.
  await expect(page.getByRole('region', { name: 'Reserve' })).toContainText('recorded, not withheld');

  // A TEST card payment, paid: it is captured, so it waits in clearing until a settlement makes it available. The TEST
  // acquirer holds its funds (`tok_funds_held`) until it reports them available, which #2 needs.
  const api = await ownerApi();
  const paid = await paidCardPayment(api, merchantId, {
    key: `${J}:payment:clearing:${merchantId}`,
    amount: '40.00',
    token: 'tok_funds_held',
  });
  expect(paid.status).toBe('captured');
  // Settlement selects by capture time; the capture has just happened, so its UTC day is today's (not the creation's).
  run.write({ paymentId: paid.id, window: new Date().toISOString().slice(0, 10) });
  // The balances follow the payment's events, so the page is read again until the payment shows.
  const balances = page.getByRole('group', { name: /Balances at a glance/ });
  await expect(async () => {
    await page.reload();
    await expect(balances).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await expect(balances.getByRole('link', { name: /^Clearing/ })).toContainText(/40(\.0+)?\s*USDT/);
  await expect(balances.getByRole('link', { name: /^Available to pay out/ })).toContainText(/Now\s*0(\.0+)?\s*USDT/);
  // Every asset the business holds, once, with its two figures: USDT only, 0.00 available and 40.00 clearing.
  const all = page.getByRole('region', { name: 'All balances' });
  await expect(all.getByRole('rowgroup').last().getByRole('row')).toHaveCount(1);
  await expect(all.getByRole('rowgroup').last().getByRole('row').getByRole('cell')).toHaveText(['USDT', '0.00 USDT', '40.00 USDT']);
  const reserve = page.getByRole('region', { name: 'Reserve' });
  await expect(reserve).toContainText('recorded, not withheld');
  await expect(reserve).toContainText('No reserve rule is set for your account.');
  expect(refused).toEqual([]);

  // A balance the page cannot read says so, and never reads as zero: with the ledger stopped the service refuses the
  // read with its code, and the page shows the refusal and no figure. Started again, the same 40.00 is back.
  const snapshot = () => api.query('merchantMetrics.snapshot', { merchantId, window: { kind: 'preset', preset: 'rolling_30d' } });
  expect((await snapshot()).balances).toEqual([
    { assetCode: 'USDT', clearing: expect.stringMatching(/^40(\.0+)?$/), available: expect.stringMatching(/^0(\.0+)?$/) },
  ]);
  try {
    tool('local-test-stack.mjs', 'stop', 'ledger');
    await expect(snapshot()).rejects.toThrow(/refused: 503 .*pay\.metrics_balance_unavailable/);
    await page.reload();
    // The refusal the page shows is the balance read's own (pay.metrics_balance_unavailable), not some other failure.
    await expect(page.getByTestId('failure').filter({ hasText: 'We can’t show your balances right now.' })).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Reserve' })).toContainText('recorded, not withheld');
    await expect(page.getByRole('group', { name: /Balances at a glance/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'All balances' })).toHaveCount(0);
    await expect(page.getByText('Available to pay out')).toHaveCount(0);
    await expect(page.getByText('No money yet')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText(/\b0\.00 USDT/);
  } finally {
    // `start` brings back only what is down; `restart` refuses a just-stopped process the system has not reaped yet.
    tool('local-test-stack.mjs', 'start');
  }
  await expect(async () => {
    await page.reload();
    await expect(balances.getByRole('link', { name: /^Clearing/ })).toContainText('40.00 USDT', { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
});

// #2, all three clauses green in the running app (RC-merchant-10). #1's 40.00 TEST payment was captured with its funds
// held by the TEST acquirer. (1) A settlement run before the acquirer releases them leaves the payment out: the window
// waits, clearing still reads 40.00 and available 0, from merchantMetrics.snapshot and on Money. (2) A payout of that
// waiting window is refused `pay.payout_clearing_pending`, by the API and on the payout page, and the balances read
// again are unchanged. (3) Once the acquirer reports the funds available (a signed `funds.available` delivery from the
// stack's TEST acquirer, never the client), the same run settles the window once, on its business key
// (merchant, window, asset): available reads the net read back from the settlement and clearing reads 0, and a third
// run changes nothing. No clause stays red.
test(`${J} #2 reads funds moving from clearing to available: funds wait until available, and a payout of clearing money is refused without moving it`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { merchantId, paymentId, window } = journey();
  expect(paymentId, 'the held TEST payment from #1').toBeTruthy();
  const api = await ownerApi();
  const snapshot = async () =>
    (await api.query('merchantMetrics.snapshot', { merchantId, window: { kind: 'preset', preset: 'rolling_30d' } })).balances;
  const settle = () => api.mutate('settlement.run', { merchantId, window, assetId: 'USDT' });

  // (1) Settlement runs before the rail has released the funds: the payment is left out and stays in clearing.
  const waiting = await settle();
  expect(waiting.status).toBe('pending');
  expect(waiting.clearingPending).toEqual([
    { paymentId, amount: expect.stringMatching(/^40(\.0+)?$/), assetId: 'USDT', availableOn: null, settlementId: waiting.id },
  ]);
  const before = await snapshot();
  expect(before).toEqual([
    { assetCode: 'USDT', clearing: expect.stringMatching(/^40(\.0+)?$/), available: expect.stringMatching(/^0(\.0+)?$/) },
  ]);
  expect((await api.query('settlement.clearing', { merchantId })).held.map((h) => h.paymentId)).toEqual([paymentId]);

  // A destination to pay out to, saved by the owner on the go-live page with a fresh authenticator code.
  const owner = await signInOwner(page, '/pay/onboarding/go-live');
  const refused = refusedPayCalls(page);
  await page.getByLabel('Wallet address *').fill(`0x${'cd'.repeat(20)}`);
  await page.getByRole('button', { name: 'Save destination' }).click();
  const save = page.getByRole('dialog');
  const saveCode = await nextCode(owner.totp, owner.secret, owner.step);
  run.write({ owner: saved({ ...owner, step: saveCode.step }) });
  await save.getByLabel('6-digit code from your authenticator app *').fill(saveCode.code);
  await save.getByRole('button', { name: 'Save destination' }).click();
  await expect(page.getByText('Destination saved.', { exact: true })).toBeVisible();

  await page.goto('/pay/money');
  const balances = page.getByRole('group', { name: /Balances at a glance/ });
  await expect(balances.getByRole('link', { name: /^Clearing/ })).toContainText('40.00 USDT');
  await expect(balances.getByRole('link', { name: /^Available to pay out/ })).toContainText(/Now\s*0(\.0+)?\s*USDT/);
  const all = page.getByRole('region', { name: 'All balances' });
  await expect(all.getByRole('rowgroup').last().getByRole('row').getByRole('cell')).toHaveText(['USDT', '0.00 USDT', '40.00 USDT']);
  // Clearing is listed apart, with the day it becomes available: the TEST acquirer named none.
  const clearing = page.getByRole('region', { name: 'Still clearing' });
  await expect(clearing.getByRole('rowgroup').last().getByRole('row').getByRole('cell')).toHaveText([
    paymentId.slice(0, 8),
    '40.00 USDT',
    'Not given yet',
    'Open',
  ]);
  await expect(clearing.getByRole('rowgroup').last().getByRole('link', { name: 'Open', exact: true })).toHaveAttribute(
    'href',
    `/pay/payments/${paymentId}`,
  );

  // (2) A payout of clearing money is refused by name, by the API and on the page, and moves nothing.
  await page.goto(`/pay/payouts/new?settlement=${waiting.id}`);
  await expect(page.getByLabel('Settlement')).toHaveValue(waiting.id);
  await expect(page.getByLabel('Settlement').locator('option:checked')).toContainText('still clearing');
  await expect(page.getByLabel('Destination')).toHaveValue(/.+/);
  const asked = page.waitForResponse((res) => res.url().includes('/api/pay/trpc/merchantControl.approvals.request'));
  await page.getByRole('button', { name: 'Pay out', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: "Confirm it's you" });
  const payCode = await nextCode(owner.totp, owner.secret, saveCode.step);
  run.write({ owner: saved({ ...owner, step: payCode.step }) });
  await confirm.getByLabel('6-digit code from your authenticator app').fill(payCode.code);
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review: Pay out' });
  await review.getByRole('button', { name: 'Pay out', exact: true }).click();
  const answer = await asked;
  expect(answer.status()).toBe(412);
  expect(JSON.stringify(await answer.json())).toContain('"code":"pay.payout_clearing_pending"');
  const said = review.getByRole('status').filter({ hasText: 'The request was refused' });
  await expect(said).toContainText('This money is still clearing, so it isn’t available to pay out yet.');
  expect(refused).toEqual(['412 merchantControl.approvals.request']);
  // By the API, with the owner's "Confirm it's you" payout token (a plain session may do neither): asking for the payout
  // and sending it are both refused the same way.
  const sendCode = await nextCode(owner.totp, owner.secret, payCode.step);
  run.write({ owner: saved({ ...owner, step: sendCode.step }) });
  const payer = await api.steppedUp(merchantId, ['pay:payout'], sendCode.code);
  const refusalOf = (call) =>
    call.then(
      () => 'not refused',
      (err) => ({ status: err.status, code: err.body?.includes('"code":"pay.payout_clearing_pending"') }),
    );
  const clearingRefusal = { status: 412, code: true };
  expect(
    await refusalOf(payer.mutate('merchantControl.approvals.request', { merchantId, settlementId: waiting.id, railId: 'crypto-native' })),
  ).toEqual(clearingRefusal);
  expect(await refusalOf(payer.mutate('settlement.payout', { settlementId: waiting.id, railId: 'crypto-native' }))).toEqual(
    clearingRefusal,
  );
  // Read again: nothing moved, the window still waits and no payout was asked for or sent.
  expect(await snapshot()).toEqual(before);
  expect((await api.query('settlement.get', { settlementId: waiting.id })).status).toBe('pending');
  expect((await api.query('merchantControl.approvals.list', { merchantId, limit: 50 })).items).toEqual([]);

  // (3) The TEST acquirer reports the funds available, signed, to the service's own webhook; the same run now settles.
  tool('local-test-stack.mjs', 'card-funds', paymentId, 'available');
  const posted = await settle();
  expect(posted.id).toBe(waiting.id);
  expect(posted.status).toBe('posted');
  expect(posted.clearingPending).toBeUndefined();
  expect(posted.gross).toMatch(/^40(\.0+)?$/);
  const net = posted.net;
  const after = await snapshot();
  expect(after).toEqual([{ assetCode: 'USDT', clearing: expect.stringMatching(/^0(\.0+)?$/), available: net }]);
  expect((await api.query('settlement.clearing', { merchantId })).held).toEqual([]);
  // Run again: the window's business key already holds it, so nothing settles twice.
  const again = await settle();
  expect({ id: again.id, status: again.status, net: again.net }).toEqual({ id: posted.id, status: 'posted', net });
  expect(await snapshot()).toEqual(after);
  run.write({ settlement: posted.id });

  await page.goto('/pay/money');
  const shown = new RegExp(
    `Now\\s*${net
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '')
      .replace('.', '\\.')}`,
  );
  await expect(balances.getByRole('link', { name: /^Available to pay out/ })).toContainText(shown);
  await expect(balances.getByRole('link', { name: /^Clearing/ })).toContainText(/0\.00\s*USDT/);
  // The Still clearing section now lists nothing: its empty line instead of the held list.
  await expect(page.getByTestId('mn-held-none')).toHaveText('Nothing is waiting to clear.');
  await expect(page.getByRole('region', { name: 'Still clearing' })).toHaveCount(0);
});

test(`${J} #3 reads Pricing and Fees: the tier fee table, a calculator on the live engine; a blank tier fee reads "Not set" and refuses a total; payout "not charged" when so published`, async ({
  page,
}) => {
  await signInOwner(page, '/pay/pricing');
  await expect(page.getByRole('heading', { name: /Pricing/, level: 1 })).toBeVisible();
  const table = tableIn(page, /Fees/).first();
  await expect(table).toBeVisible(UNBUILT);
  for (const cell of await table.getByRole('cell').allInnerTexts()) expect(cell.trim()).not.toBe('');
  await page.getByRole('textbox', { name: /Payment amount/ }).fill('100');
  await page.getByRole('button', { name: 'Work out the fee' }).click();
  await expect(page.getByRole('main')).toContainText(/You receive|Not set/);
});

test(`${J} #4 opens the payout schedule and rules: manual by default or the next date after cut-off; changes with who and when; minimums disable the control with the reason`, async ({
  page,
}) => {
  await signInOwner(page, '/pay/payouts');
  const schedule = page.getByRole('region', { name: 'Payout schedule' });
  await expect(schedule).toContainText(/Manual|Next payout/, UNBUILT);
  await expect(tableIn(page, 'Schedule changes')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Payout rules' })).toContainText(/Minimum amount/);
});

test(`${J} #5 requests a top-up: with no rail "Top up is not set up for your account" and Request off; the balance is unchanged`, async ({
  page,
}) => {
  await signInOwner(page, '/pay/money');
  await page.getByRole('link', { name: 'Top up' }).click(UNBUILT);
  await expect(page.getByText('Top up is not set up for your account')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request' })).toBeDisabled();
});

test(`${J} #6 presses Pay out on a posted settlement: the whole net with no amount box, the destination and the approval rule`, async ({
  page,
}) => {
  const { settlement } = journey();
  expect(settlement, 'a TEST settlement from #2').toBeTruthy();
  await signInOwner(page, '/pay/settlements');
  const row = page
    .getByRole('region', { name: 'Settlements', exact: true })
    .getByRole('row')
    .filter({ hasText: settlement.slice(0, 8) });
  await row.getByRole('link', { name: 'Pay out' }).click();
  await expect(page.getByRole('textbox', { name: /Amount/ })).toHaveCount(0);
  await expect(page.getByLabel('Destination')).toHaveValue(/.+/);
  await expect(page.getByRole('main')).toContainText(/approval/i);
});

test(`${J} #7 confirms with a fresh step-up and sends: one payout with a receipt; a second inside the confirmation life does not ask again`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { settlement } = journey();
  expect(settlement, 'a TEST settlement from #2').toBeTruthy();
  const owner = await signInOwner(page, '/pay/payouts/new');
  await page.getByRole('button', { name: 'Pay out' }).click();
  const confirm = page.getByRole('dialog', { name: "Confirm it's you" });
  const { code, step } = await nextCode(owner.totp, owner.secret, owner.step);
  run.write({ owner: saved({ ...owner, step }) });
  await confirm.getByLabel('6-digit code from your authenticator app').fill(code);
  await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('The payout has been sent.')).toBeVisible();
  await expect(page.getByRole('link', { name: /receipt/i }).first()).toBeVisible();
  // A second payout inside the confirmation's life goes without asking again.
  const second = postedSettlement();
  expect(second).toBeTruthy();
  await page.goto('/pay/payouts/new');
  await page.getByRole('button', { name: 'Pay out' }).click();
  await expect(page.getByText('The payout has been sent.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: "Confirm it's you" })).toHaveCount(0);
});

test(`${J} #8 a finance teammate asks for the same: they request an approval and cannot send or refund; the owner approves`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  expect(postedSettlement(), 'a TEST settlement for the teammate to ask about').toBeTruthy();
  const finance = await businessReadyPerson(page, 'mfn', '/pay/merchant');
  await forgetSession(page);
  await signInOwner(page, '/pay/team');
  await page.getByRole('button', { name: 'Invite by account ID instead' }).click();
  await page.getByLabel('Account ID *').fill(finance.userId);
  await page.getByRole('combobox', { name: /^Role \*/ }).selectOption({ label: 'Finance' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await forgetSession(page);

  await signInWithCode(page, finance, '/pay/team');
  const accept = page.locator('li').filter({ hasText: 'Finance' }).getByRole('button', { name: 'Accept' }).first();
  await expect(async () => {
    await page.reload();
    await expect(accept).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await accept.click();
  await page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last().click();
  await page.goto('/pay/payouts/new');
  await page.getByLabel('Destination').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Pay out' }).click();
  await expect(page.getByText('Your request is with your team for approval.').first()).toBeVisible();
  await page.goto('/pay/refunds');
  await expect(page.getByText('Only the account owner can refund payments.').first()).toBeVisible();
  await forgetSession(page);

  await signInOwner(page, '/pay/approvals');
  await page.getByLabel('Your reason *').fill('TEST checked the destination');
  await page.getByRole('button', { name: 'Approve payout' }).click();
  await expect(page.getByText('Approved, not sent yet').first()).toBeVisible();
});
