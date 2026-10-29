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
  verifiedBusiness,
} from './merchant.mjs';
import { tableIn } from './tables.mjs';

// J-merchant-07, in the running app (docs/roadmap/journeys.json): see the business's money and ask for a payout. One test
// per step, titled "J-merchant-07 #<n>", run in order on one verified TEST business. #1 makes the owner and the business
// and reads Money while it has none. #3 puts the business on TEST tiers of its own through the two-founder doors
// (`local-test-merchant-pricing.mjs`) and reads Pricing and Fees on each. The later steps need TEST settlements posted to it, a verified default destination
// and a finance teammate who can request but not send.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - The stack cannot post a TEST settlement to a business (`local-test-world.mjs merchant-settlement <merchantId>`,
//   proposed), so #2 and #6 to #8 have no settlement to pay out (M-money-out-05).
// - #2: no clearing-to-available view (RC-merchant-10); #4: no payout schedule or rules (M-money-out-03,
//   M-adv-money-out-01); #5: no top-up (M-money-out-02).
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
  await signInOwner(page, '/pay/money');
  const refused = refusedPayCalls(page);
  await expect(page.getByRole('heading', { name: 'Balances', level: 1 })).toBeVisible();
  await expect(page.getByText('No money yet')).toBeVisible();
  await expect(page.getByRole('group', { name: /Balances at a glance/ })).toHaveCount(0);
  // The reserve card is there before the first payment too.
  await expect(page.getByRole('region', { name: 'Reserve' })).toContainText('recorded, not withheld');

  // A TEST card payment, paid: it is captured, so it waits in clearing until a settlement makes it available.
  const api = await ownerApi();
  const paid = await paidCardPayment(api, merchantId, { key: `${J}:payment:clearing:${merchantId}`, amount: '40.00' });
  expect(paid.status).toBe('captured');
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

test(`${J} #2 reads funds moving from clearing to available: funds wait until available, and a payout of clearing money is refused without moving it`, async ({
  page,
}) => {
  const settlement = postedSettlement();
  expect(settlement).toBeTruthy();
  run.write({ settlement });
  await signInOwner(page, '/pay/money');
  await expect(page.getByRole('group', { name: /Balances at a glance/ })).toContainText(/Clearing\s*100(\.0+)? USDT/);
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
