import { execFileSync } from 'node:child_process';
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
  uuidOf,
  verifiedBusiness,
} from './merchant.mjs';
import { tableIn } from './tables.mjs';

// J-merchant-07, in the running app (docs/roadmap/journeys.json): see the business's money and ask for a payout. One test
// per step, titled "J-merchant-07 #<n>", run in order on one verified TEST business. #1 makes the owner and the business
// and reads Money while it has none. #3 puts the business on TEST tiers of its own through the two-founder doors
// (`local-test-merchant-pricing.mjs`) and reads Pricing and Fees on each. The later steps need TEST settlements posted to it, a verified default destination
// and a finance teammate who can request but not send.
// #2 settles #1's own payment through the service and keeps the posted settlement for the payout steps.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #7 and #8 ask the stack for more TEST settlements (`local-test-world.mjs merchant-settlement <merchantId>`, proposed)
//   to pay out (M-money-out-05).
// - #4: no payout schedule or rules (M-money-out-03, M-adv-money-out-01).
// #5 needs only #1's business: no top-up rail exists, so it proves the refusal, Request off and the balance unchanged;
//   its "with a rail" clause is a second #5 test that stays red, by name, until a top-up rail exists (UNBUILT).
//   svc-pay has no top-up rail setting to leave blank, so 'no rail' is the only state #5 can show.
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

/**
 * Puts the business on a TEST tier of its own through the two-founder doors and returns what the founders read back
 * (`tooling/scripts/local-test-merchant-pricing.mjs`). Signing the two founders in can wait out TOTP steps, so it
 * gets longer than `tool`'s two minutes.
 */
function merchantPricing(...args) {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tooling/scripts/local-test-merchant-pricing.mjs'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

/** The priced TEST tier's fee as the table writes it (JOURNEY_PRICING_RULE in local-test-merchant-pricing.mjs). */
const PRICED_FEE_TEXT = '2.50% from 0.00 USDT · 1.50% + 0.30 USDT from 10,000.00 USDT · minimum 0.50 USDT';

/** The fee calculator's section on Pricing and Fees. */
const calculator = (page) =>
  page.getByTestId('pay-section').filter({ has: page.getByRole('heading', { name: 'Fee calculator', level: 2 }) });

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
  // Watched from the first load of Money, so a refused read on that load counts too.
  const refused = refusedPayCalls(page);
  await signInOwner(page, '/pay/money');
  await expect(page.getByRole('heading', { name: 'Balances', level: 1 })).toBeVisible();
  await expect(page.getByText('No money yet')).toBeVisible();
  await expect(page.getByRole('group', { name: /Balances at a glance/ })).toHaveCount(0);
  // The reserve card is there before the first payment too.
  await expect(page.getByRole('region', { name: 'Reserve' })).toContainText('recorded, not withheld');

  // The service's own answer for the new business: no asset holds anything yet, and no reserve rule is set. The page
  // above reads exactly that, not a zero it made up.
  const api = await ownerApi();
  const snapshot = () => api.query('merchantMetrics.snapshot', { merchantId, window: { kind: 'preset', preset: 'rolling_30d' } });
  // "Zero per asset" for a new business: the service lists no asset at all (it lists only assets the business has
  // held), so the page shows "No money yet" with no asset row and no figure, never a made-up zero.
  expect((await snapshot()).balances, 'a new business holds no asset yet').toEqual([]);
  await expect(page.getByRole('region', { name: 'All balances' })).toHaveCount(0);
  const reserveRead = await api.query('merchantControl.reserve', { merchantId });
  expect(reserveRead).toMatchObject({ rule: null, holding: 'recorded_not_withheld', payoutsRefused: false, assets: [] });
  await expect(page.getByRole('region', { name: 'Reserve' })).toContainText('No reserve rule is set for your account.');

  // A TEST card payment, paid: it is captured, so it waits in clearing until a settlement makes it available. The TEST
  // acquirer holds its funds (`tok_funds_held`) until it reports them available, which #2 needs.
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
  // The card's "no rule" is the service's: the reserve read still has no rule after the payment.
  expect((await api.query('merchantControl.reserve', { merchantId })).rule).toBeNull();
  await expect(reserve).toContainText('No reserve rule is set for your account.');
  expect(refused).toEqual([]);

  // A balance the page cannot read says so, and never reads as zero: with the ledger stopped the service refuses the
  // read with its code, and the page shows the refusal and no figure. Started again, the same 40.00 is back.
  expect((await snapshot()).balances).toEqual([
    { assetCode: 'USDT', clearing: expect.stringMatching(/^40(\.0+)?$/), available: expect.stringMatching(/^0(\.0+)?$/) },
  ]);
  try {
    tool('local-test-stack.mjs', 'stop', 'ledger');
    await expect(snapshot()).rejects.toThrow(/refused: 503 .*pay\.metrics_balance_unavailable/);
    // The page's own balance read is the one refused, with the balance code, not some other failure.
    const [pageRead] = await Promise.all([
      page.waitForResponse((res) => new URL(res.url()).pathname.includes('merchantMetrics.snapshot')),
      page.reload(),
    ]);
    expect(pageRead.status()).toBe(503);
    const refusal = (await pageRead.json())?.error?.data;
    expect(refusal?.intafacedCode ?? refusal?.cause?.code ?? refusal?.code).toBe('pay.metrics_balance_unavailable');
    await expect(page.getByTestId('failure').filter({ hasText: 'We can’t show your balances right now.' })).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Reserve' })).toContainText('recorded, not withheld');
    await expect(page.getByRole('group', { name: /Balances at a glance/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'All balances' })).toHaveCount(0);
    await expect(page.getByText('Available to pay out')).toHaveCount(0);
    await expect(page.getByText('No money yet')).toHaveCount(0);
    // No zero in any form: "0 USDT", "0.00 USDT", "Now 0".
    await expect(page.locator('main')).not.toContainText(/(^|[^\d.,])0(\.0+)?\s*USDT|Now\s*0\b/);
  } finally {
    // `start` brings back only what is down; `restart` refuses a just-stopped process the system has not reaped yet.
    tool('local-test-stack.mjs', 'start');
  }
  await expect(async () => {
    await page.reload();
    await expect(balances.getByRole('link', { name: /^Clearing/ })).toContainText('40.00 USDT', { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  // The same two figures from the service once the ledger is back: the outage moved nothing.
  expect((await snapshot()).balances).toEqual([
    { assetCode: 'USDT', clearing: expect.stringMatching(/^40(\.0+)?$/), available: expect.stringMatching(/^0(\.0+)?$/) },
  ]);
  await expect(balances.getByRole('link', { name: /^Available to pay out/ })).toContainText(/Now\s*0(\.0+)?\s*USDT/);
});

// #2, the wait and the payout half green in the running app (RC-merchant-10). #1's 40.00 TEST payment was captured
// with its funds held by the TEST acquirer. (1) A settlement run before the acquirer releases them leaves the payment
// out: the window waits, clearing still reads 40.00 and available 0, from merchantMetrics.snapshot and on Money.
// (2) A payout of that waiting window is refused `pay.payout_clearing_pending`, by the API and on the payout page; the
// balances, the settlement record and the held list read again are unchanged, and Money reloaded still shows clearing
// 40.00 and available 0. (3) Once the acquirer reports the funds available (a signed `funds.available` delivery from
// the stack's TEST acquirer, never the client), the same run settles the window once, on its business key
// (merchant, window, asset): available reads the net read back from the settlement and clearing reads 0, and a third
// run changes nothing. The spend half of the step has no path in the running app: it is the separate red test below,
// named for its blocker.
test(`${J} #2 reads funds moving from clearing to available: funds wait until available, and a payout of still-pending clearing is refused without moving it`, async ({
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
  const heldBefore = (await api.query('settlement.clearing', { merchantId })).held;
  expect(heldBefore.map((h) => h.paymentId)).toEqual([paymentId]);

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

  // (2) A payout of clearing money is refused by its typed code, by the API and on the page, and moves nothing.
  const recordBefore = await api.query('settlement.get', { settlementId: waiting.id });
  expect(recordBefore.status).toBe('pending');
  const clearingCode = 'pay.payout_clearing_pending';
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
  expect((await answer.json()).error?.data?.cause?.code).toBe(clearingCode);
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
      (err) => ({ status: err.status, code: JSON.parse(err.body ?? 'null')?.error?.data?.cause?.code }),
    );
  const clearingRefusal = { status: 412, code: clearingCode };
  expect(
    await refusalOf(payer.mutate('merchantControl.approvals.request', { merchantId, settlementId: waiting.id, railId: 'crypto-native' })),
  ).toEqual(clearingRefusal);
  expect(await refusalOf(payer.mutate('settlement.payout', { settlementId: waiting.id, railId: 'crypto-native' }))).toEqual(
    clearingRefusal,
  );
  // Read again: nothing moved, the window still waits and no payout was asked for or sent.
  expect(await snapshot()).toEqual(before);
  expect(await api.query('settlement.get', { settlementId: waiting.id })).toEqual(recordBefore);
  expect((await api.query('settlement.clearing', { merchantId })).held).toEqual(heldBefore);
  expect((await api.query('merchantControl.approvals.list', { merchantId, limit: 50 })).items).toEqual([]);
  // And on Money, reloaded: clearing still 40.00 and nothing available.
  await page.goto('/pay/money');
  await expect(balances.getByRole('link', { name: /^Clearing/ })).toContainText('40.00 USDT');
  await expect(balances.getByRole('link', { name: /^Available to pay out/ })).toContainText(/Now\s*0(\.0+)?\s*USDT/);
  await expect(all.getByRole('rowgroup').last().getByRole('row').getByRole('cell')).toHaveText(['USDT', '0.00 USDT', '40.00 USDT']);

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

// #2's spend half stays red until a merchant can spend a balance in the running app. The only spend of a settlement
// is conversion (svc-pay conversion.quote/execute), and the TEST stack leaves it off: no PAY_CONVERSION_* is set, so
// there is no venue and every quote is refused `pay.conversion_slippage_unconfigured` before it reads a settlement, and
// it converts USD settlements only while this journey's TEST payment is USDT. A refund also draws on clearing, but it
// returns the buyer's own payment rather than spending the merchant's funds; #2 proves the payout refusal.
test(`${J} #2 a spend of still-pending clearing is refused (blocked: conversion, the only merchant spend, is off on the TEST stack, PAY_CONVERSION_MODE unset, and takes USD settlements only)`, async () => {
  expect(
    'no merchant spend path in the running app',
    'blocked: conversion is off on the TEST stack (PAY_CONVERSION_MODE unset, no venue, quotes refused pay.conversion_slippage_unconfigured) and converts USD settlements only; no other merchant spend is wired',
  ).toBe('a spend of still-pending clearing refused by its typed code');
});

test(`${J} #3 reads Pricing and Fees: the tier fee table, a calculator on the live engine; a blank tier fee reads "Not set" and refuses a total; payout "not charged" when so published`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  const { merchantId } = journey();
  // The business's own TEST tier with a TEST USDT fee and no payout fee published, through the two-founder doors.
  const priced = merchantPricing(merchantId, '--tier', 'priced');
  expect(priced).toMatchObject({ merchantId, onTier: true, payoutFee: null });
  const api = await ownerApi();
  await signInOwner(page, '/pay/pricing');
  await expect(page.getByRole('heading', { name: 'Pricing and fees', level: 1 })).toBeVisible();
  const fees = tableIn(page, 'Fees by tier');
  const pricedRow = fees.getByTestId(`tier-fee-${priced.tierId}-USDT`);
  await expect(pricedRow).toHaveCount(1);
  await expect(pricedRow.getByRole('rowheader')).toHaveText(`${priced.tierName} (your tier)`);
  await expect(pricedRow.getByRole('cell')).toHaveText(['USDT', PRICED_FEE_TEXT, 'Not set']);
  // The row is what the service publishes to the business, not something the page made up.
  const ladder = await api.query('merchantControl.tiers.list', { merchantId });
  expect(ladder.ownTierId).toBe(priced.tierId);
  expect(ladder.tiers.find((tier) => tier.id === priced.tierId)).toMatchObject({
    payoutFee: null,
    fees: [
      {
        assetCode: 'USDT',
        bands: [
          { fromAmount: expect.stringMatching(/^0(\.0+)?$/), feeBps: 250, flatFee: null },
          { fromAmount: expect.stringMatching(/^10000(\.0+)?$/), feeBps: 150, flatFee: expect.stringMatching(/^0\.30*$/) },
        ],
        minFee: expect.stringMatching(/^0\.50*$/),
      },
    ],
  });

  // The calculator asks the live engine: 100 USDT at no volume yet is the 2.50% band, 2.50 off and 97.50 left.
  const calc = calculator(page);
  await expect(calc.getByRole('combobox', { name: 'Asset' })).toHaveValue('USDT');
  await calc.getByRole('textbox', { name: /Payment amount/ }).fill('100');
  await calc.getByRole('textbox', { name: /Your volume so far this month/ }).fill('0');
  const quoted = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith('/merchantControl.pricing.preview'));
  await calc.getByRole('button', { name: 'Work out the fee' }).click();
  const quoteRes = await quoted;
  expect(quoteRes.status()).toBe(200);
  expect((await quoteRes.json()).result.data).toMatchObject({ fee: '2.5', net: '97.5', appliedLayer: 'tier' });
  const facts = calc.getByTestId('pp-facts');
  await expect(facts.getByRole('term')).toHaveText([
    'Fee',
    'You would receive',
    'Price applied',
    'Band starting at',
    'Volume so far this month',
    'Fractions of the smallest unit',
  ]);
  await expect(facts.getByRole('definition')).toHaveText([
    /^2\.50\s*USDT$/,
    /^97\.50\s*USDT$/,
    'Set for your tier',
    /^0\.00\s*USDT$/,
    /^0\.00\s*USDT$/,
    'go to INTAFACED',
  ]);
  expect(
    await api.query('merchantControl.pricing.preview', { merchantId, assetCode: 'USDT', amount: '100', monthlyVolume: '0' }),
  ).toMatchObject({
    fee: '2.5',
    net: '97.5',
    appliedLayer: 'tier',
  });

  // Published as not charged, the payout fee reads "Not charged"; until then it read "Not set" (above).
  const published = merchantPricing(merchantId, '--tier', 'priced', '--payout-not-charged');
  expect(published).toMatchObject({ tierId: priced.tierId, onTier: true, payoutFee: { kind: 'not_charged' } });
  await page.reload();
  await expect(pricedRow.getByRole('cell')).toHaveText(['USDT', PRICED_FEE_TEXT, 'Not charged']);
  expect((await api.query('merchantControl.tiers.list', { merchantId })).tiers.find((tier) => tier.id === priced.tierId).payoutFee).toEqual(
    {
      kind: 'not_charged',
    },
  );

  // A second TEST tier of the business's own with no fee at all: its fee and its payout fee read "Not set".
  // Whatever happens below, the business goes back to the priced tier (payout fee published) for the steps after this one.
  try {
    const blank = merchantPricing(merchantId, '--tier', 'blank');
    expect(blank).toMatchObject({ merchantId, onTier: true, payoutFee: null });
    expect(blank.tierId).not.toBe(priced.tierId);
    await page.reload();
    const blankRow = fees.getByTestId(`tier-fee-${blank.tierId}-none`);
    await expect(blankRow.getByRole('rowheader')).toHaveText(`${blank.tierName} (your tier)`);
    await expect(blankRow.getByRole('cell')).toHaveText(['—', 'Not set', 'Not set']);
    // The priced tier is off the shared ladder, so the business no longer sees it.
    await expect(fees.getByTestId(new RegExp(`^tier-fee-${priced.tierId}-`))).toHaveCount(0);

    // The calculator still offers the tier's asset, asks the engine, and the engine refuses: no total, no "You would receive".
    const recordBefore = await api.query('merchantControl.get', { merchantId });
    const ladderBefore = await api.query('merchantControl.tiers.list', { merchantId });
    expect(recordBefore).toMatchObject({ tierId: blank.tierId, pricing: null });
    // The service itself publishes no fee and no payout fee for the blank tier; the "Not set" cells are what it sent.
    expect(ladderBefore.tiers.find((tier) => tier.id === blank.tierId)).toMatchObject({ fees: [], payoutFee: null });
    await expect(calc.getByRole('combobox', { name: 'Asset' })).toHaveValue('USDT');
    await calc.getByRole('textbox', { name: /Payment amount/ }).fill('100');
    await calc.getByRole('textbox', { name: /Your volume so far this month/ }).fill('0');
    const refusedQuote = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith('/merchantControl.pricing.preview'));
    await calc.getByRole('button', { name: 'Work out the fee' }).click();
    const refusedRes = await refusedQuote;
    expect(refusedRes.status()).toBe(412);
    expect(await refusedRes.text()).toContain('"pay.pricing_unconfigured"');
    await expect(calc.getByTestId('failure')).toHaveText(/No price is set for that asset on your account, so no fee can be worked out\./);
    await expect(calc.getByTestId('pp-facts')).toHaveCount(0);
    await expect(calc.getByText('You would receive')).toHaveCount(0);
    await expect(
      api.query('merchantControl.pricing.preview', { merchantId, assetCode: 'USDT', amount: '100', monthlyVolume: '0' }),
    ).rejects.toThrow(/refused: 412 .*pay\.pricing_unconfigured/);
    // The refusal changed nothing: the record and the ladder read the same afterwards.
    expect(await api.query('merchantControl.get', { merchantId })).toEqual(recordBefore);
    expect(await api.query('merchantControl.tiers.list', { merchantId })).toEqual(ladderBefore);
  } finally {
    expect(merchantPricing(merchantId, '--tier', 'priced', '--payout-not-charged')).toMatchObject({ tierId: priced.tierId, onTier: true });
  }
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

/** The tRPC error for one procedure in a response, found by its path when the call went out in a batch. */
function trpcErrorOf(url, body, procedure) {
  const paths = new URL(url).pathname.split('/trpc/')[1].split(',');
  const entry = Array.isArray(body) ? body[paths.indexOf(procedure)] : body;
  expect(entry, `an answer for ${procedure} in ${paths.join(',')}`).toBeTruthy();
  return entry.error;
}

/** The balances as the service reads them (the ledger, through svc-pay), never as the page draws them. */
const serviceBalances = (api, merchantId) => async () =>
  (await api.query('merchantMetrics.snapshot', { merchantId, window: { kind: 'preset', preset: 'rolling_30d' } })).balances;
/** What #1 left: a captured TEST card payment of 40.00 USDT waiting in clearing, nothing available. */
const FROM_STEP_1 = [{ assetCode: 'USDT', clearing: expect.stringMatching(/^40(\.0+)?$/), available: expect.stringMatching(/^0(\.0+)?$/) }];
/** What #2 leaves when it ran: the rail released those funds and the settlement posted, so nothing is clearing and its
 * net (above zero, below the 40.00 gross) is available. */
const FROM_STEP_2 = [
  { assetCode: 'USDT', clearing: expect.stringMatching(/^0(\.0+)?$/), available: expect.stringMatching(/^(?:[1-3]?\d)(?:\.\d+)?$/) },
];
/** The figures the earlier steps left, so "unchanged" compares figures that could move. */
const leftBefore = () => (journey().settlement ? FROM_STEP_2 : FROM_STEP_1);

test(`${J} #5 requests a top-up: with no rail "Top up is not set up for your account" and Request off; the balance is unchanged`, async ({
  page,
}) => {
  const { merchantId } = journey();
  const api = await ownerApi();
  const balances = serviceBalances(api, merchantId);
  const before = await balances();
  expect(before, 'the USDT left by #1 (and #2 when it ran), so "unchanged" compares figures that could move').toEqual(leftBefore());
  expect(Number(before[0].clearing) + Number(before[0].available), 'a balance above zero').toBeGreaterThan(0);

  // Top up is reachable from Money.
  await signInOwner(page, '/pay/money');
  await expect(page.getByRole('heading', { name: 'Balances', level: 1 })).toBeVisible();
  const asked = page.waitForResponse(
    (res) => new URL(res.url()).pathname.split('/trpc/')[1]?.split(',').includes('merchantControl.topUp.options') ?? false,
  );
  await page.getByRole('link', { name: 'Top up' }).click();
  await expect(page).toHaveURL(/\/pay\/money\/top-up$/);
  await expect(page.getByRole('heading', { name: 'Top up', level: 1 })).toBeVisible();

  // With no rail the service refuses with its own typed code (the formatter copies it to data.cause.code), and the
  // room says so.
  const res = await asked;
  expect(res.status()).toBe(412);
  const error = trpcErrorOf(res.url(), await res.json(), 'merchantControl.topUp.options');
  expect(error.data.code).toBe('PRECONDITION_FAILED');
  expect(error.data.cause.code).toBe('pay.topup_unconfigured');
  await expect(page.getByTestId('pfo-soon').filter({ hasText: 'Top up is not set up for your account.' })).toHaveCount(1);
  await expect(page.getByTestId('failure')).toHaveCount(0);
  // The same read straight to the service: the same typed code, parsed, not a match on the error text.
  const direct = await api.answer('merchantControl.topUp.options', { merchantId });
  expect(direct.status).toBe(412);
  expect(direct.body.error.data.cause.code).toBe('pay.topup_unconfigured');

  // Only after the refusal: Request and Amount are off because the read refused (TopUpView turns them on only when the
  // read answers), and the note says why. The form is there, never a "coming soon" page.
  const request = page.getByRole('button', { name: 'Request', exact: true });
  await expect(request).toBeVisible();
  await expect(request).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Amount' })).toBeDisabled();
  await expect(page.getByRole('note').filter({ hasText: 'Request is off because top up is not set up for your account.' })).toHaveCount(1);

  // The balance is unchanged, read from the service again.
  expect(await balances()).toEqual(before);
});

// #5's second clause is blocked, so it is its own red test, named for its blocker. It asks the service for a top-up,
// so it cannot pass on a page alone, and it ends on a stub that stays red until the landing is real.
const NO_RAIL =
  'with a rail: a pending row with the deposit address and reference (unbuilt: no top-up rail; owner.decision top-up rail, M-money-out-02)';
test(`${J} #5 with a rail: a pending row with the deposit address and reference; the balance is unchanged until it lands (unbuilt: no top-up rail)`, async ({
  page,
}) => {
  const { merchantId } = journey();
  const api = await ownerApi();
  const balances = serviceBalances(api, merchantId);
  const before = await balances();
  expect(before).toEqual(leftBefore());

  // A TEST top-up of 25.00 USDT, keyed by business so a retried step finds the same request.
  const requestId = uuidOf(`${J}:top-up:${merchantId}`);
  let asked;
  try {
    asked = await api.mutate('merchantControl.topUp.request', { merchantId, requestId, assetId: 'USDT', amount: '25.00' });
  } catch (e) {
    throw new Error(`${NO_RAIL}: ${e.message}`);
  }
  expect(asked.id, NO_RAIL).toBeTruthy();

  // The pending row is the one the service returned, found by its id, with the address and reference it gave.
  await signInOwner(page, '/pay/money/top-up');
  const row = page
    .getByRole('region', { name: 'Pending top-ups' })
    .getByRole('row')
    .filter({ has: page.getByText(asked.id, { exact: true }) });
  await expect(row, NO_RAIL).toHaveCount(1, UNBUILT);
  await expect(row).toContainText('Pending');
  await expect(row).toContainText(asked.depositAddress);
  await expect(row).toContainText(asked.reference);

  // Pending is not landed: the balance the service reads is the same until the rail says the money arrived.
  expect(await balances()).toEqual(before);

  // When it lands: the balance changes once, by the amount, and a second landing report moves nothing. That needs a
  // TEST top-up landing on a real rail; until a rail's slice writes it here, this stub keeps the test red.
  expect(false, 'when it lands: the balance changes once, by 25.00 USDT (unbuilt: no top-up rail to land on; M-money-out-02)').toBe(true);
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
