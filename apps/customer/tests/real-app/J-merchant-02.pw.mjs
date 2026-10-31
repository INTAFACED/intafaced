import { test, expect } from './journey.mjs';
import { forgetSession, nextCode } from './identity-factors.mjs';
import {
  approveKyb,
  businessReadyPerson,
  openBusiness,
  paidCardPayment,
  payApiOf,
  refusedPayCalls,
  sentForReview,
  signInWithCode,
  uuidOf,
  verifiedBusiness,
} from './merchant.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { tool } from './stack.mjs';

// J-merchant-02, in the running app (docs/roadmap/journeys.json): get verified and go live. Tests titled
// "J-merchant-02 #<n>" prove a whole step; the others prove part of one and say which.
const J = 'J-merchant-02';

test(`${J} part of #2 sending the verification reference and INTAFACED's decision both show in the verification history`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mkh', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST History Ltd');
  const refused = refusedPayCalls(page);
  // Sends the reference from /pay/onboarding/verification, then the founder pair approves it.
  await verifiedBusiness(page, owner, merchantId);

  await page.goto('/pay/onboarding/verification');
  const history = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Verification history' }) });
  await expect(history).toContainText('In review to Approved');
  await expect(history).toContainText('Decided by INTAFACED');
  await expect(history).toContainText('Not sent to In review');
  await expect(history).toContainText('Sent by you');
  await expect(history.getByText('Nothing sent yet')).toHaveCount(0);
  expect(refused).toEqual([]);
});

test(`${J} part of #1 the owner reads the second-approval rule and turns it on and off again`, async ({ page }) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'msa', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Second Approval Ltd');
  // Changing a setting is a pay:write call, which a business holds once it is verified.
  await verifiedBusiness(page, owner, merchantId);
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/settings');
  const refused = refusedPayCalls(page);

  const rule = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Second approval', level: 2 }) });
  await expect(rule.getByRole('status')).toHaveText('Second approval is off.');
  await expect(rule).not.toContainText('We can’t read this setting.');
  await rule.getByRole('button', { name: 'Turn on second approval' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn on second approval' }).click();
  await expect(rule.getByRole('status')).toHaveText('Second approval is on.');
  await page.reload();
  await expect(rule.getByRole('status')).toHaveText('Second approval is on.');
  await rule.getByRole('button', { name: 'Turn off second approval' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn off second approval' }).click();
  await expect(rule.getByRole('status')).toHaveText('Second approval is off.');
  expect(refused).toEqual([]);
});

test(`${J} part of #1 a new owner adds the business address before verification, and setup counts the details as done`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mad', '/pay/onboarding');
  await openBusiness(page, owner, 'TEST Address Ltd');
  const refused = refusedPayCalls(page);
  await page.goto('/pay/onboarding');
  await expect(page.getByText('Your business details are missing: address.')).toBeVisible();

  await page.goto('/pay/settings');
  await page.getByLabel('Address line 1').fill('1 Test Street');
  await page.getByLabel('City').fill('Testville');
  await page.getByLabel('Postal code').fill('T3ST 1NG');
  await page.getByLabel('Country code').fill('GB');
  await page.getByLabel('Reason *').fill('Add our address');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('1 Test Street, Testville, T3ST 1NG, GB');
  await review.getByRole('button', { name: 'Save changes' }).click();
  const history = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Change history', level: 2 }) });
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await expect(history).toContainText('Add our address');

  await page.goto('/pay/onboarding');
  await expect(page.getByText('What is left')).toBeVisible();
  await expect(page.getByText(/Your business details are missing/)).toHaveCount(0);
  await expect(page.getByText('Send your verification reference for review (step 2).')).toBeVisible();
  expect(refused).toEqual([]);
});

/** Pay restarted with the starting fee blank, or back on the stack's TEST fee (tooling/scripts/local-stack-services/pay.mjs). */
function payStarterFee(published) {
  const before = process.env.LOCAL_STACK_PAY_STARTER_FEE;
  if (published) delete process.env.LOCAL_STACK_PAY_STARTER_FEE;
  else process.env.LOCAL_STACK_PAY_STARTER_FEE = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'pay');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_PAY_STARTER_FEE;
    else process.env.LOCAL_STACK_PAY_STARTER_FEE = before;
  }
}

test(`${J} #1 starts onboarding and fills the business step: a saved draft that survives leaving; with no starting fee published the first step refuses to open an account`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  const owner = await businessReadyPerson(page, 'mbd', '/pay/onboarding');
  const fillBusiness = async () => {
    await page.getByLabel('Legal business name *').fill('TEST Draft Ltd');
    await page.getByLabel('Country code *').fill('DE');
    await page.getByLabel('Type of business *').fill('online shop');
    await page.getByLabel('Contact email *').fill(owner.email);
  };
  const createButton = page.locator('form').getByRole('button', { name: 'Create my account' });

  // With no starting fee published, the first step refuses to open an account: the room says why and the button stays
  // off, and the service refuses a create sent straight to it with its code. No account exists afterwards.
  try {
    payStarterFee(false);
    // The owner's own token, taken from a pay call the room itself makes.
    const own = page.waitForRequest((r) => r.url().includes('/api/pay/trpc/') && Boolean(r.headers().authorization));
    await page.goto('/pay/onboarding/business');
    const authorization = (await own).headers().authorization;
    const payCall = async (procedure, input) => {
      const res =
        input === undefined
          ? await page.request.get(`/api/pay/trpc/${procedure}`, { headers: { authorization } })
          : await page.request.post(`/api/pay/trpc/${procedure}`, {
              headers: { authorization, origin: new URL(page.url()).origin },
              data: input,
            });
      const json = await res.json();
      return { status: res.status(), data: json?.result?.data, typed: /^([a-z]+\.[a-z_]+):/.exec(json?.error?.message ?? '')?.[1] ?? null };
    };
    expect((await payCall('merchant.starterFee')).data).toEqual({ starterFee: null });
    await fillBusiness();
    await expect(page.getByText('Opening new accounts isn’t possible here. INTAFACED has not set the starting fee')).toBeVisible();
    await expect(createButton).toBeDisabled();
    // A TEST fee the caller names is no way round it: the service opens accounts only at the fee it publishes.
    const create = await payCall('merchant.create', { pricing: { feeBps: 250 } });
    expect(create.status).toBe(412);
    expect(create.typed).toBe('pay.starter_fee_unpublished');
    expect((await payCall('merchant.me')).data).toBeNull();
    // The room asks before a reload drops what was typed; the owner leaves anyway, and the cleared form shows the reload ran.
    page.once('dialog', (dialog) => dialog.accept());
    await page.reload();
    await expect(page.getByLabel('Legal business name *')).toHaveValue('');
    await expect(page.getByText('Opening new accounts isn’t possible here. INTAFACED has not set the starting fee')).toBeVisible();
    await expect(page.getByText('Your merchant account exists.')).toHaveCount(0);
  } finally {
    payStarterFee(true);
  }

  // The stack's TEST starting fee published again: the same step opens the account.
  await page.goto('/pay/onboarding/business');
  await fillBusiness();
  await expect(page.getByText('Opening new accounts isn’t possible here')).toHaveCount(0);
  const created = page.waitForResponse((r) => r.url().includes('merchant.create') && r.request().method() === 'POST');
  await createButton.click();
  const review = page.getByRole('dialog');
  await expect(review.locator('dt', { hasText: 'Starting fee' }).locator('+ dd')).not.toHaveText(/^(Not published)?$/);
  await review.getByRole('button', { name: 'Create my account' }).click();
  const sent = await (await created).json();
  const merchantId = (Array.isArray(sent) ? sent[0] : sent).result.data.id;
  await expect(page.getByText('Your merchant account exists.')).toBeVisible();
  // Before the account exists the person holds no business grant, so the check starts here, as in the steps below.
  const refused = refusedPayCalls(page);

  const app = await startApplication(page, 'Private company');
  const company = app.getByRole('region', { name: 'Company details' });
  await company.getByLabel('Registered legal name *').fill('TEST Draft Ltd');
  await company.getByRole('button', { name: 'Save' }).click();
  await expect(company.getByRole('status')).toHaveText('Saved.');
  await expect(company).toContainText('Saved, not finished');

  // Leaving: back to the personal home, then a sign-out with the browser's storage cleared, then a fresh sign-in.
  // Calls a signed-out page makes are refused, as they should be, so the check is split around the sign-out.
  await page.goto('/home');
  expect(refused).toEqual([]);
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/onboarding/business');
  const refusedAfter = refusedPayCalls(page);
  await expect(page.getByTestId('pp-mono').filter({ hasText: merchantId })).toBeVisible();
  await page.goto('/pay/onboarding/verification');
  const back = app.getByRole('region', { name: 'Company details' });
  await expect(back).toContainText('Saved, not finished');
  await expect(back.getByLabel('Registered legal name *')).toHaveValue('TEST Draft Ltd');
  await expect(app.getByRole('list', { name: 'Still needed' })).toContainText('Company details');
  expect(refusedAfter).toEqual([]);
});

test(`${J} part of #6 the owner reads the published merchant terms and accepts them before going live`, async ({ page }) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mtc', '/pay/onboarding');
  await openBusiness(page, owner, 'TEST Terms Ltd');
  const refused = refusedPayCalls(page);

  await page.goto('/pay/onboarding');
  await expect(page.getByText('Accept the terms of service (step 3).')).toBeVisible();
  await page.goto('/pay/onboarding/go-live');
  const terms = page.getByTestId('onboarding-terms');
  await expect(terms.getByRole('link', { name: 'Read the terms (version TEST-merchant-terms-1)' })).toHaveAttribute(
    'href',
    'https://terms.example/TEST-merchant-terms-1',
  );
  await expect(page.getByText('No terms of service to accept')).toHaveCount(0);
  await terms.getByRole('button', { name: 'Accept the terms' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Accept the terms' }).click();
  await expect(terms.getByRole('status')).toContainText('Version TEST-merchant-terms-1 accepted.');
  await page.reload();
  await expect(terms.getByRole('status')).toContainText('Version TEST-merchant-terms-1 accepted.');
  await page.goto('/pay/onboarding');
  await expect(page.getByText('Accept the terms of service (step 3).')).toHaveCount(0);
  expect(refused).toEqual([]);
});

test(`${J} part of #5 the verified owner saves where payouts go, confirming it with a fresh authenticator code; svc-pay lists that one destination and the Destinations room shows the same one`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mpd', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Payout Ltd');
  await verifiedBusiness(page, owner, merchantId);
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/onboarding/go-live');
  const refused = refusedPayCalls(page);

  const wallet = `0x${'ab'.repeat(20)}`;
  await page.getByLabel('Wallet address *').fill(wallet);
  await page.getByRole('button', { name: 'Save destination' }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText(wallet);
  const code = review.getByLabel('6-digit code from your authenticator app *');
  await code.fill('123456');
  await review.getByRole('button', { name: 'Save destination' }).click();
  await expect(review.getByText("That code didn't match. Check your authenticator app and try again.")).toBeVisible();
  await expect(code).toHaveValue('');
  const fresh = await nextCode(owner.totp, owner.secret, owner.step);
  owner.step = fresh.step;
  await code.fill(fresh.code);
  await review.getByRole('button', { name: 'Save destination' }).click();
  await expect(page.getByText('Destination saved.', { exact: true })).toBeVisible();
  // The code is good once: the field is empty again.
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.reload();
  const standing = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Before you go live', level: 2 }) });
  await expect(standing).toContainText('DestinationSaved');
  // svc-pay's list, as the Destinations room reads it: exactly this one wallet, masked to its end.
  const listed = async (open) => {
    const read = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/pay/trpc/merchant.payoutDestinations.list' && r.request().method() === 'GET',
    );
    await open();
    const res = await read;
    expect(res.status()).toBe(200);
    return (await res.json()).result.data.items;
  };
  const items = await listed(() => page.goto('/pay/payouts/destinations'));
  expect(items).toHaveLength(1);
  const [saved] = items;
  expect(saved).toMatchObject({ merchantId, kind: 'crypto' });
  expect(saved.destinationMasked).toMatch(/abab$/);
  expect(saved.destinationMasked).not.toContain(wallet);
  const table = page.getByRole('region', { name: 'Saved destinations' });
  const rows = table.getByRole('row').filter({ hasText: /Wallet / });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(`Wallet ${saved.destinationMasked}`);
  await expect(page.getByText(wallet)).toHaveCount(0);
  // The service keeps it: the same destination, by id, after a reload.
  expect(await listed(() => page.reload())).toEqual(items);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(`Wallet ${saved.destinationMasked}`);
  expect(refused).toEqual([]);
});

// #5 in the running app: the owner saves a wallet in the Destinations room with no code, and svc-pay keeps it Unverified;
// a payout of a posted TEST settlement to it is refused by svc-pay's typed code and nothing moves. Verifying it (the
// address typed again and a fresh authenticator code) starts the hold: svc-pay answers Held with the time it becomes
// Active, the stack's TEST PAY_DESTINATION_HOLD_SECONDS later (45 s, tooling/profiles/test-owner-values/pay.json), and
// a payout is still refused. Once that time passes svc-pay reads it Active. Throughout, the one destination (same id, same
// masked address) is in both lists: the Destinations room and the Pay out form's Destination choice.
test(`${J} #5 a new payout destination reads Unverified and cannot receive a payout; after verifying it is Active after the hold; the same destination appears in both lists`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const owner = await businessReadyPerson(page, 'mpu', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Payout Hold Ltd');
  await verifiedBusiness(page, owner, merchantId);
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/payouts/destinations');
  const refused = refusedPayCalls(page);
  const api = await payApiOf(owner, (step) => {
    owner.step = step;
  });
  // A posted TEST settlement, so a payout can be tried and the Pay out form has something to pay.
  const paid = await paidCardPayment(api, merchantId, { key: `${J}:#5:payment:${merchantId}`, amount: '25.00' });
  expect(paid.status).toBe('captured');
  const settlement = await api.mutate('settlement.run', { merchantId, window: new Date().toISOString().slice(0, 10), assetId: 'USDT' });
  expect(settlement.status).toBe('posted');
  const settlementBefore = await api.query('settlement.get', { settlementId: settlement.id });
  const listed = async () => (await api.query('merchant.payoutDestinations.list', { merchantId, limit: 10 })).items;
  const refusalOf = (call) =>
    call.then(
      () => 'not refused',
      (err) => ({ status: err.status, code: JSON.parse(err.body ?? 'null')?.error?.data?.cause?.code }),
    );
  const confirmCode = async () => {
    const fresh = await nextCode(owner.totp, owner.secret, owner.step);
    owner.step = fresh.step;
    return fresh.code;
  };

  // Saved in the room: no code is asked for, and svc-pay keeps it Unverified.
  const wallet = `0x${'5e'.repeat(20)}`;
  await page.getByLabel('Payout network').selectOption({ label: 'Crypto network' });
  await page.getByLabel('Wallet address *').fill(wallet);
  await page.getByRole('button', { name: 'Save destination' }).click();
  const save = page.getByRole('dialog', { name: 'Review: Save destination' });
  await expect(save).toContainText(wallet);
  await expect(save.getByLabel('6-digit code from your authenticator app *')).toHaveCount(0);
  const added = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/pay/trpc/merchant.payoutDestinations.add');
  await save.getByRole('button', { name: 'Save destination' }).click();
  expect((await added).status()).toBe(200);
  await expect(page.getByText('Destination saved. It is unverified and can’t receive a payout until you verify it.')).toBeVisible();
  const [unverified, ...others] = await listed();
  expect(others).toEqual([]);
  expect(unverified).toMatchObject({ merchantId, railId: 'crypto-native', kind: 'crypto', state: 'unverified', activatesAt: null });
  expect(unverified.destinationMasked).toMatch(/5e5e$/);
  expect(unverified.destinationMasked).not.toContain(wallet);
  const table = page.getByRole('region', { name: 'Saved destinations' });
  const row = table.getByRole('row').filter({ hasText: unverified.destinationMasked });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Unverified');

  // It cannot receive a payout: svc-pay refuses by its code before any admission or hold, and the settlement is unchanged.
  const payer = await api.steppedUp(merchantId, ['pay:payout'], await confirmCode());
  const payout = () => payer.mutate('settlement.payout', { settlementId: settlement.id, railId: 'crypto-native' });
  expect(await refusalOf(payout())).toEqual({ status: 412, code: 'pay.payout_destination_unverified' });
  expect(await api.query('settlement.get', { settlementId: settlement.id })).toEqual(settlementBefore);

  // The second list: the Pay out form offers the same destination, marked Unverified.
  const choice = () => page.getByLabel('Destination').locator('option').filter({ hasText: unverified.destinationMasked });
  await page.goto('/pay/payouts/new');
  await expect(choice()).toHaveCount(1);
  await expect(choice()).toHaveText(/Unverified/);
  await expect(choice()).toHaveAttribute('value', unverified.id);

  // Verified in the room: the address typed again and a fresh code. svc-pay answers Held with the time it becomes Active.
  await page.goto('/pay/payouts/destinations');
  const item = page
    .getByRole('list', { name: 'Manage saved destinations' })
    .getByRole('listitem')
    .filter({ hasText: unverified.destinationMasked });
  await item.getByRole('button', { name: 'Verify' }).click();
  const verify = page.getByRole('dialog', { name: 'Review: Verify' });
  await verify.getByLabel('Wallet address *').fill(wallet);
  await verify.getByLabel('6-digit code from your authenticator app *').fill(await confirmCode());
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/pay/trpc/merchant.setPayoutDestination');
  const verifiedAt = Date.now();
  await verify.getByRole('button', { name: 'Verify' }).click();
  const verifiedRes = await answered;
  expect(verifiedRes.status()).toBe(200);
  const verified = (await verifiedRes.json()).result.data;
  expect(verified).toEqual({ status: 'held', railId: 'crypto-native', kind: 'crypto', ref: wallet, activatesAt: expect.any(String) });
  // The stack's TEST hold is 45 seconds from the verification.
  const holdEnd = Date.parse(verified.activatesAt);
  expect(holdEnd - verifiedAt).toBeGreaterThan(40_000);
  expect(holdEnd - verifiedAt).toBeLessThanOrEqual(50_000);
  await expect(page.getByText('Destination verified. It becomes active at the time shown in the list.')).toBeVisible();
  const [held] = await listed();
  expect(held).toEqual({ ...unverified, state: 'held', activatesAt: verified.activatesAt });
  // The Status cell (the table's second column) names the service's own end of the hold.
  const status = row.getByRole('cell').nth(1);
  await expect(status).toContainText('Waiting until');
  await expect(status.locator('time')).toHaveAttribute('datetime', verified.activatesAt);
  await expect(row).not.toContainText('Unverified');
  await expect(item.getByRole('button', { name: 'Verify' })).toHaveCount(0);
  // Still no payout while it is held.
  expect(await refusalOf(payout())).toEqual({ status: 412, code: 'pay.payout_destination_held' });
  expect(await api.query('settlement.get', { settlementId: settlement.id })).toEqual(settlementBefore);
  await page.goto('/pay/payouts/new');
  await expect(choice()).toHaveText(/Not active yet/);
  await expect(choice()).toHaveAttribute('value', unverified.id);

  // After the hold svc-pay reads it Active, and both lists show the same destination with nothing pending on it.
  await expect
    .poll(async () => (await listed())[0]?.state, { timeout: Math.max(holdEnd - Date.now(), 0) + 60_000, intervals: [2_000] })
    .toBe('active');
  expect(Date.now()).toBeGreaterThanOrEqual(holdEnd);
  expect(await listed()).toEqual([{ ...unverified, state: 'active', activatesAt: null }]);
  await page.goto('/pay/payouts/destinations');
  await expect(status).toHaveText('Active');
  await expect(row).not.toContainText(/Unverified|Waiting until/);
  await page.goto('/pay/payouts/new');
  await expect(choice()).toHaveCount(1);
  await expect(choice()).not.toHaveText(/Unverified|Not active yet/);
  await expect(choice()).toHaveAttribute('value', unverified.id);
  expect(refused).toEqual([]);
});

// Part of #5, the lead's ruling of 2026-10-30: the owner can cancel a verification while it waits out the hold. With no
// code (it only lowers risk), svc-pay moves the destination back to Unverified, keeps the same id, and a repeat changes
// nothing; the room reads Unverified again and offers Verify back.
test(`${J} part of #5 the owner cancels a verification while it is held: svc-pay and the room read Unverified again, and a repeat changes nothing`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const owner = await businessReadyPerson(page, 'mpc', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Payout Cancel Ltd');
  await verifiedBusiness(page, owner, merchantId);
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/payouts/destinations');
  const refused = refusedPayCalls(page);
  const api = await payApiOf(owner, (step) => {
    owner.step = step;
  });
  const listed = async () => (await api.query('merchant.payoutDestinations.list', { merchantId, limit: 10 })).items;

  const wallet = `0x${'c4'.repeat(20)}`;
  await page.getByLabel('Payout network').selectOption({ label: 'Crypto network' });
  await page.getByLabel('Wallet address *').fill(wallet);
  await page.getByRole('button', { name: 'Save destination' }).click();
  await page.getByRole('dialog', { name: 'Review: Save destination' }).getByRole('button', { name: 'Save destination' }).click();
  await expect(page.getByText('Destination saved. It is unverified and can’t receive a payout until you verify it.')).toBeVisible();
  const [saved] = await listed();
  expect(saved).toMatchObject({ merchantId, state: 'unverified', activatesAt: null });

  const item = page
    .getByRole('list', { name: 'Manage saved destinations' })
    .getByRole('listitem')
    .filter({ hasText: saved.destinationMasked });
  const row = page.getByRole('region', { name: 'Saved destinations' }).getByRole('row').filter({ hasText: saved.destinationMasked });
  const status = row.getByRole('cell').nth(1);
  await item.getByRole('button', { name: 'Verify' }).click();
  const verify = page.getByRole('dialog', { name: 'Review: Verify' });
  await verify.getByLabel('Wallet address *').fill(wallet);
  const fresh = await nextCode(owner.totp, owner.secret, owner.step);
  owner.step = fresh.step;
  await verify.getByLabel('6-digit code from your authenticator app *').fill(fresh.code);
  await verify.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('Destination verified. It becomes active at the time shown in the list.')).toBeVisible();
  const [held] = await listed();
  expect(held).toEqual({ ...saved, state: 'held', activatesAt: expect.any(String) });
  await expect(status).toContainText('Waiting until');
  await expect(status.locator('time')).toHaveAttribute('datetime', held.activatesAt);

  // Cancel: no code is asked for; svc-pay answers unverified for the same destination.
  await item.getByRole('button', { name: 'Cancel verification' }).click();
  const cancelDialog = page.getByRole('dialog', { name: 'Review: Cancel verification' });
  await expect(cancelDialog.getByLabel('6-digit code from your authenticator app *')).toHaveCount(0);
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/pay/trpc/merchant.payoutDestinations.cancelHold');
  await cancelDialog.getByRole('button', { name: 'Cancel verification' }).click();
  const res = await answered;
  expect(res.status()).toBe(200);
  expect((await res.json()).result.data).toEqual({ destinationId: saved.id, state: 'unverified', changed: true });
  await expect(page.getByText('Verification cancelled. The destination is unverified again.')).toBeVisible();
  expect(await listed()).toEqual([{ ...saved, state: 'unverified', activatesAt: null }]);
  await expect(status).toHaveText('Unverified');
  await expect(item.getByRole('button', { name: 'Verify' })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Cancel verification' })).toHaveCount(0);

  // A repeat is a no-op: still unverified, the same id, nothing changed.
  expect(await api.mutate('merchant.payoutDestinations.cancelHold', { merchantId, destinationId: saved.id })).toEqual({
    destinationId: saved.id,
    state: 'unverified',
    changed: false,
  });
  expect(await listed()).toEqual([{ ...saved, state: 'unverified', activatesAt: null }]);
  await page.reload();
  await expect(status).toHaveText('Unverified');
  expect(refused).toEqual([]);
});

/** Step 2's business application on the verification page, started for one type and country. */
async function startApplication(page, typeLabel, country = 'DE') {
  await page.goto('/pay/onboarding/verification');
  const app = page
    .locator('section[data-testid="pay-section"]')
    .filter({ has: page.getByRole('heading', { name: 'Business application' }) });
  await app.getByLabel('Legal entity type *').selectOption({ label: typeLabel });
  await app.getByLabel('Country the business is registered in *').selectOption(country);
  await app.getByRole('button', { name: 'Start the application' }).click();
  await expect(app.getByText('Pending', { exact: true })).toBeVisible();
  return app;
}

test(`${J} #2 the owner chooses the legal entity type; changing it returns the application to Pending and lists what is still needed with a due date`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mkt', '/pay/onboarding');
  await openBusiness(page, owner, 'TEST Entity Ltd');
  const refused = refusedPayCalls(page);
  // svc-pay's own answer to each application write the room makes, read from the reply the room receives.
  const reply = (procedure) =>
    page
      .waitForResponse((r) => new URL(r.url()).pathname === `/api/pay/trpc/kyb.application.${procedure}` && r.request().method() === 'POST')
      .then(async (r) => {
        expect(r.status(), `kyb.application.${procedure}`).toBe(200);
        return (await r.json()).result.data;
      });
  const DAY_MS = 24 * 60 * 60 * 1000;
  const dueBy = (app) => app.locator('dt', { hasText: 'Due by' }).locator('+ dd time');
  // The application's status fact (document rows also read Pending, so the status is read from its own row).
  const status = (app) => app.locator('dt', { hasText: /^Application$/ }).locator('+ dd');

  // Started as a sole trader: Pending, with every part it needs still listed, and a due date from the service.
  const started = reply('start');
  const app = await startApplication(page, 'Sole trader');
  const view = await started;
  await expect(status(app)).toHaveText('Pending');
  expect(view).toMatchObject({ entityType: 'sole_proprietorship', state: 'draft' });
  expect(view.missing).toEqual(['company_details', 'people', 'documents', 'questionnaires']);
  // The stack's TEST due date (PAY_KYB_APPLICATION_DUE_DAYS=30) counts from the start.
  expect(Date.parse(view.dueAt) - Date.parse(view.startedAt)).toBe(30 * DAY_MS);
  await expect(dueBy(app)).toHaveAttribute('datetime', view.dueAt);
  const needed = app.getByRole('list', { name: 'Still needed' });
  await expect(needed.getByRole('listitem')).toHaveText([
    'Company details',
    'People behind the business',
    'Documents: Test proof of identity, Test proof of address',
    'Questions',
  ]);

  // Every part filled in: the application is no longer Pending but ready to send.
  const company = app.getByRole('region', { name: 'Company details' });
  await company.getByLabel('Registered legal name *').fill('TEST Entity Ltd');
  await company.getByLabel('Registered address *').fill('1 Test Street, Berlin');
  await company.getByRole('button', { name: 'Save' }).click();
  await expect(company.getByRole('status')).toHaveText('Saved. This part is done.');
  await expect(needed).not.toContainText('Company details');
  const people = app.getByRole('region', { name: 'People behind the business' });
  await people.getByLabel('Full legal name *').fill('TEST Proprietor');
  await people.getByLabel('Date of birth *').fill('1980-01-02');
  await people.getByLabel('Nationality (2-letter country code) *').fill('DE');
  await people.getByRole('button', { name: 'Save' }).click();
  await expect(people.getByRole('status')).toHaveText('Saved. This part is done.');
  const questions = app.getByRole('region', { name: 'Questions' });
  await questions.getByLabel('Test nature of business *').fill('TEST online sales of printed books');
  await questions.getByRole('button', { name: 'Save' }).click();
  await expect(questions.getByRole('status')).toHaveText('Saved. This part is done.');
  const docs = app.getByRole('region', { name: 'Documents', exact: true });
  const pdf = (text) => Buffer.from(`%PDF-1.4\n% TEST ${text}\n%%EOF\n`);
  for (const [key, file] of [
    ['Test proof of identity', 'identity.pdf'],
    ['Test proof of address', 'address.pdf'],
  ]) {
    const row = docs.getByRole('row', { name: new RegExp(key) });
    await row.getByLabel(`Choose a file for ${key}`).setInputFiles({ name: file, mimeType: 'application/pdf', buffer: pdf(file) });
    await row.getByRole('button', { name: 'Send' }).click();
    await expect(docs.getByRole('row', { name: new RegExp(key) })).toContainText('Pending');
  }
  const confirmed = reply('saveSection');
  await docs.getByRole('button', { name: 'Confirm documents' }).click();
  expect((await confirmed).missing, 'svc-pay: nothing is missing').toEqual([]);
  await expect(status(app)).toHaveText('Ready to send');
  await expect(app.getByText('Nothing. Every part is done.')).toBeVisible();

  // The type changes to a private company: the application returns to Pending, and what the new type needs is listed
  // again, each part as svc-pay names it, under the same due date.
  const change = app.getByRole('region', { name: 'Change the legal entity type' });
  await change.getByLabel('Legal entity type *').selectOption({ label: 'Private company' });
  const changed = reply('changeType');
  await change.getByRole('button', { name: 'Change type' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Change type' }).click();
  const after = await changed;
  expect(after).toMatchObject({
    applicationId: view.applicationId,
    entityType: 'private_company',
    state: 'draft',
    startedAt: view.startedAt,
    dueAt: view.dueAt,
  });
  expect(after.missing).toEqual(['company_details', 'people', 'documents', 'questionnaires']);
  await expect(change.getByRole('status').filter({ hasText: 'Type changed.' })).toHaveText(
    'Type changed. Fill in each part again for the new type.',
  );
  await expect(status(app)).toHaveText('Pending');
  await expect(needed.getByRole('listitem')).toHaveText([
    'Company details',
    'People behind the business',
    'Documents: Test certificate of incorporation, Test proof of address',
    'Questions',
  ]);
  await expect(dueBy(app)).toHaveAttribute('datetime', after.dueAt);
  await expect(app.getByRole('region', { name: 'Company details' })).toContainText('Not started');

  // The service holds it: after a reload the room reads the same from svc-pay.
  const reread = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/pay/trpc/kyb.application.current');
  await page.reload();
  const current = (await (await reread).json()).result.data;
  expect(current).toMatchObject({ entityType: 'private_company', state: 'draft', dueAt: view.dueAt });
  expect(current.missing).toEqual(after.missing);
  await expect(app.locator('dd', { hasText: 'Private company' })).toBeVisible();
  await expect(status(app)).toHaveText('Pending');
  await expect(needed.getByRole('listitem')).toHaveText([
    'Company details',
    'People behind the business',
    'Documents: Test certificate of incorporation, Test proof of address',
    'Questions',
  ]);
  await expect(dueBy(app)).toHaveAttribute('datetime', view.dueAt);
  expect(refused).toEqual([]);
});

test(`${J} #3 the owner adds the people and documents a sole trader is asked for; a file over the limit or of a wrong type is refused before it is sent; each row reads Pending, then Verified or Invalid with the reason once INTAFACED reviews it, and an Invalid one takes a new file`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mdc', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Documents Ltd');
  const refused = refusedPayCalls(page);
  const uploads = [];
  page.on('request', (req) => req.url().includes('kyb.documents.upload') && uploads.push(req.url()));

  const app = await startApplication(page, 'Sole trader');
  const company = app.getByRole('region', { name: 'Company details' });
  await company.getByLabel('Registered legal name *').fill('TEST Documents Ltd');
  await company.getByLabel('Registered address *').fill('2 Test Street, Berlin');
  await company.getByRole('button', { name: 'Save' }).click();
  await expect(company.getByRole('status')).toHaveText('Saved. This part is done.');

  const people = app.getByRole('region', { name: 'People behind the business' });
  await people.getByLabel('Full legal name *').fill('TEST Proprietor');
  await people.getByLabel('Date of birth *').fill('1980-01-02');
  await people.getByLabel('Nationality (2-letter country code) *').fill('DE');
  await people.getByRole('button', { name: 'Save' }).click();
  await expect(people.getByRole('status')).toHaveText('Saved. This part is done.');

  const questions = app.getByRole('region', { name: 'Questions' });
  await questions.getByLabel('Test nature of business *').fill('TEST online sales of printed books');
  await questions.getByRole('button', { name: 'Save' }).click();
  await expect(questions.getByRole('status')).toHaveText('Saved. This part is done.');

  const docs = app.getByRole('region', { name: 'Documents', exact: true });
  await expect(docs).toContainText('Files up to 1.0 MB. Accepted: PDF, PNG.');
  await expect(docs).toContainText('The automatic document check isn’t connected');
  const identity = docs.getByRole('row', { name: /Test proof of identity/ });
  await expect(identity).toContainText('Needed');
  const pick = identity.getByLabel('Choose a file for Test proof of identity');
  await pick.setInputFiles({ name: 'too-big.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2 * 1024 * 1024, 1) });
  await expect(identity.getByRole('alert')).toHaveText('This file is 2.0 MB. The limit is 1.0 MB. Choose a smaller file.');
  await expect(identity.getByRole('button', { name: 'Send' })).toBeDisabled();
  await pick.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('TEST notes') });
  await expect(identity.getByRole('alert')).toHaveText('This kind of file isn’t accepted. Accepted: PDF, PNG.');
  await expect(identity.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(uploads).toEqual([]);

  const pdf = (text) => Buffer.from(`%PDF-1.4\n% TEST ${text}\n%%EOF\n`);
  await pick.setInputFiles({ name: 'identity.pdf', mimeType: 'application/pdf', buffer: pdf('identity') });
  await identity.getByRole('button', { name: 'Send' }).click();
  await expect(docs.getByRole('row', { name: /Test proof of identity/ })).toContainText('Pending');
  const address = docs.getByRole('row', { name: /Test proof of address/ });
  await address
    .getByLabel('Choose a file for Test proof of address')
    .setInputFiles({ name: 'address.png', mimeType: 'image/png', buffer: Buffer.from('TEST png') });
  await address.getByRole('button', { name: 'Send' }).click();
  await expect(docs.getByRole('row', { name: /Test proof of address/ })).toContainText('Pending');
  expect(uploads).toHaveLength(2);

  await docs.getByRole('button', { name: 'Confirm documents' }).click();
  await expect(docs.getByRole('status').filter({ hasText: 'Saved.' })).toHaveText('Saved. This part is done.');
  await expect(app.getByText('Ready to send', { exact: true })).toBeVisible();
  await page.reload();
  await expect(app.getByText('Ready to send', { exact: true })).toBeVisible();
  await expect(
    app.getByRole('region', { name: 'Documents', exact: true }).getByRole('row', { name: /Test proof of identity/ }),
  ).toContainText('Pending');

  await app.getByRole('button', { name: 'Send application for review' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send application for review' }).click();
  await expect(app.getByText('Sent for review', { exact: true })).toBeVisible();
  await expect(app).toContainText('INTAFACED is reviewing your application');
  await expect(page.getByText('INTAFACED is reviewing it')).toBeVisible();
  await expect(app.getByRole('region', { name: 'Documents', exact: true }).locator('input[type=file]')).toHaveCount(0);

  // INTAFACED's compliance reviewer opens each file in the founder console and gives it a verdict.
  const desk = await (await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } })).newPage();
  await founderSignIn(desk, 'a');
  await desk.goto(`/merchants/${merchantId}?tab=verification`);
  const review = desk.locator('#verification');
  await expect(review).toContainText('Sent for review');
  const opened = desk.context().waitForEvent('page');
  await review.getByRole('button', { name: 'Open the file for Test proof of identity' }).click();
  // The tab opens on the click and then shows the file's bytes.
  const tab = await opened;
  await expect.poll(() => tab.url()).toMatch(/^blob:/);
  await review.getByRole('button', { name: 'Mark Test proof of identity Verified' }).click();
  await expect(review.getByRole('button', { name: 'Mark Test proof of identity Verified' })).toHaveCount(0);
  await expect(review.getByRole('row', { name: /Test proof of identity/ })).toContainText('Reviewed by');
  const addressRow = review.getByRole('row', { name: /Test proof of address/ });
  await expect(addressRow.getByRole('button', { name: 'Mark Test proof of address Invalid' })).toBeDisabled();
  await addressRow.getByLabel('Reason, if Invalid (the merchant reads it)').fill('TEST the address is cut off at the bottom');
  await addressRow.getByRole('button', { name: 'Mark Test proof of address Invalid' }).click();
  await expect(addressRow).toContainText('Reason given: TEST the address is cut off at the bottom');
  await desk.context().close();
  await page.reload();
  const reviewed = app.getByRole('region', { name: 'Documents', exact: true });
  await expect(reviewed.getByRole('row', { name: /Test proof of identity/ })).toContainText('Verified');
  const invalid = reviewed.getByRole('row', { name: /Test proof of address/ });
  await expect(invalid).toContainText('Invalid');
  await expect(invalid).toContainText('Reason: TEST the address is cut off at the bottom');

  // Still under review, the owner answers Invalid with a new file for that document only.
  await expect(app).toContainText('INTAFACED marked a document Invalid. Send a new file for it under Documents');
  await expect(reviewed.locator('input[type=file]')).toHaveCount(1);
  await invalid
    .getByLabel('Choose a file for Test proof of address')
    .setInputFiles({ name: 'address-whole.png', mimeType: 'image/png', buffer: Buffer.from('TEST png, the whole page') });
  await invalid.getByRole('button', { name: 'Send' }).click();
  await expect(reviewed.getByRole('row', { name: /Test proof of address/ })).toContainText('Pending');
  await expect(reviewed.locator('input[type=file]')).toHaveCount(0);
  expect(uploads).toHaveLength(3);
  expect(refused).toEqual([]);
});

test(`${J} #4 the owner answers an information request from the reviewer: a banner when one is past due, an infected file refused, and a closed request shows who closed it`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const owner = await businessReadyPerson(page, 'mir', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Requests Ltd');
  const answers = [];
  page.on('request', (req) => req.url().includes('kyb.requests.answer') && answers.push(req.url()));

  // INTAFACED's compliance reviewer asks for two things in the founder console: one due in ten days, one in two minutes.
  const desk = await (await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } })).newPage();
  await founderSignIn(desk, 'a');
  await desk.goto(`/merchants/${merchantId}?tab=verification`);
  const asks = desk.locator('#information-requests');
  await expect(asks).toContainText('No information requests');
  const localTime = (ms) => {
    const d = new Date(Date.now() + ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const STATEMENT = 'TEST send a bank statement from the last three months';
  const BILL = 'TEST send a utility bill for the business address';
  await asks.getByLabel('What the merchant should send (they read it as written)').fill(STATEMENT);
  await asks.getByLabel('Due by (your local time)').fill(localTime(10 * 86_400_000));
  await asks.getByRole('button', { name: 'Send request' }).click();
  await expect(asks.getByTestId('kyb-request').filter({ hasText: STATEMENT })).toContainText('Open');
  await asks.getByLabel('What the merchant should send (they read it as written)').fill(BILL);
  await asks.getByLabel('Due by (your local time)').fill(localTime(2 * 60_000));
  await asks.getByRole('button', { name: 'Send request' }).click();
  await expect(asks.getByTestId('kyb-request').filter({ hasText: BILL })).toBeVisible();

  // The owner reads both on the Compliance page and answers the statement request.
  await page.goto('/pay/compliance');
  const requests = page.getByRole('list', { name: 'Information requests' });
  const statement = requests.getByRole('listitem', { name: STATEMENT });
  await expect(statement).toContainText('Open');
  await expect(statement).toContainText('Every file is checked for malware before it is kept.');
  await expect(requests.getByRole('listitem', { name: BILL })).toBeVisible();

  // An infected file (the industry-standard EICAR test string) is refused and nothing of it is kept.
  const eicar = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE', '!$H+H*'].join('');
  await statement.getByLabel('Your note').fill('TEST the statement is attached');
  await statement.getByLabel('Choose a file to send with your answer').setInputFiles({
    name: 'statement.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(eicar),
  });
  await statement.getByRole('button', { name: 'Send answer' }).click();
  await expect(statement.getByRole('alert')).toHaveText(
    'The malware check found a threat in this file, so it wasn’t kept. Send a clean copy.',
  );
  await expect(statement).toContainText('Open');

  await statement.getByLabel('Choose a file to send with your answer').setInputFiles({
    name: 'statement.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% TEST bank statement\n%%EOF\n'),
  });
  await statement.getByRole('button', { name: 'Send answer' }).click();
  await expect(statement).toContainText('Answered');
  await expect(statement).toContainText('passed the malware check');
  expect(answers).toHaveLength(2);

  // The reviewer opens the file and closes the request with a note.
  await desk.reload();
  const asked = asks.getByTestId('kyb-request').filter({ hasText: STATEMENT });
  await expect(asked).toContainText('Merchant’s note: TEST the statement is attached');
  const opened = desk.context().waitForEvent('page');
  await asked.getByRole('button', { name: /^Open the file sent for request/ }).click();
  const tab = await opened;
  await expect.poll(() => tab.url()).toMatch(/^blob:/);
  await asked.getByLabel('Closing note (the merchant reads it)').fill('TEST statement received, thank you');
  await asked.getByRole('button', { name: /^Close request/ }).click();
  await expect(asked).toContainText('Closed by');
  await expect(asked).toContainText('TEST statement received, thank you');
  await desk.context().close();

  await page.reload();
  const closed = page.getByRole('list', { name: 'Information requests' }).getByRole('listitem', { name: STATEMENT });
  await expect(closed).toContainText('Closed by INTAFACED reviewer');
  await expect(closed).toContainText('TEST statement received, thank you');
  await expect(closed.getByRole('button', { name: 'Send answer' })).toHaveCount(0);

  // Once the bill request's due date passes unanswered, the page warns about it.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('alert').filter({ hasText: 'past its due date' })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 200_000, intervals: [10_000] });
  await expect(page.getByRole('listitem', { name: BILL })).toContainText('Past due');
});

test(`${J} #7 the owner chooses the business category and reads its class rule; "no rule set" while the table is empty, and a high-risk category shows its reserve and extra documents`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mbc', '/pay/onboarding');
  await openBusiness(page, owner, 'TEST Category Ltd');
  const refused = refusedPayCalls(page);
  // "No rule set" while the table is empty: this step adds the stack's first category, so on a fresh stack (each
  // journeys shard starts one) svc-pay's own read of the table is empty here, and the room says so.
  const categoryRead = page.waitForResponse((r) => r.url().includes('merchant.category.get') && r.request().method() === 'GET');
  await page.goto('/pay/compliance');
  const firstRead = await categoryRead;
  expect(firstRead.status()).toBe(200);
  const before = (await firstRead.json()).result.data;
  expect(before.policy.categories, 'svc-pay holds no category yet (a fresh stack: this step adds the first)').toEqual([]);
  expect(before.chosen).toBeNull();
  const section = page
    .locator('section[data-testid="pay-section"]')
    .filter({ has: page.getByRole('heading', { name: 'Business category' }) });
  const all = section.getByRole('list', { name: 'Every category' });
  await expect(section.getByTestId('category-no-rule')).toBeVisible();
  await expect(section).toContainText('No rule set');
  await expect(all).toHaveCount(0);
  await expect(section.getByLabel('Your business category')).toHaveCount(0);

  // Founder A adds a high-risk (restricted) TEST category; founder B approves exactly that change in their own sign-in.
  const tag = Date.now().toString(36);
  const LABEL = `TEST gaming ${tag}`;
  const contextA = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const a = await contextA.newPage();
  await founderSignIn(a, 'a');
  await a.goto('/merchants/categories');
  const editor = a.getByRole('group', { name: 'Change the category table' });
  await editor.getByRole('button', { name: 'Add a category' }).click();
  await editor.getByLabel('Key (lowercase words joined by hyphens; it never changes)').fill(`test-gaming-${tag}`);
  await editor.getByLabel('Name the business reads').fill(LABEL);
  await editor.getByLabel('Class').selectOption('restricted');
  await editor.getByLabel('Reserve percent (blank: not set)').fill('5.00');
  await editor.getByLabel('Reserve held for, in days (blank: not set)').fill('90');
  await editor.getByLabel('Extra documents the business sends (one per line)').fill('TEST gaming licence');
  await editor.getByLabel('Why (kept in the history)').fill('TEST add a high-risk category');
  await editor.getByRole('button', { name: 'Review the change' }).click();
  await expect(editor.getByTestId('category-review')).toContainText(LABEL);
  await editor.getByRole('button', { name: 'Ask the other founder to approve' }).click();
  const handoff = await editor.getByLabel('Request for the other founder').inputValue();

  const contextB = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const b = await contextB.newPage();
  await founderSignIn(b, 'b');
  await b.goto('/merchants/categories');
  const approve = b.getByRole('group', { name: 'Approve a category change' });
  await approve.getByLabel('Request from the other founder').fill(handoff);
  await expect(approve).toContainText(LABEL);
  await approve.getByRole('button', { name: 'Approve this category change' }).click();
  await expect(approve).toContainText('Approved');
  await contextB.close();

  await editor.getByRole('button', { name: 'Save the change' }).click();
  await expect(editor).toContainText(`${LABEL} is in the table`);
  await a.reload();
  await expect(a.getByTestId('category-table')).toContainText(LABEL);
  await expect(a.getByTestId('category-event').filter({ hasText: LABEL })).toContainText('TEST add a high-risk category');

  // And a standard TEST category (OWNER 108: cards, crypto and bank transfer), once per stack, so every later journey's
  // business takes every method whichever journeys ran before it (merchant.mjs chooseTakenCategory picks it first).
  const table = a.getByTestId('category-table');
  await expect(table).toContainText(LABEL);
  if (!((await table.textContent()) ?? '').includes('test-standard-shop')) {
    await editor.getByRole('button', { name: 'Add a category' }).click();
    await editor.getByLabel('Key (lowercase words joined by hyphens; it never changes)').fill('test-standard-shop');
    await editor.getByLabel('Name the business reads').fill('TEST Standard shop');
    await editor.getByLabel('Class').selectOption('standard');
    await editor.getByLabel('Why (kept in the history)').fill('TEST add a standard category');
    await editor.getByRole('button', { name: 'Review the change' }).click();
    await expect(editor.getByTestId('category-review')).toContainText('TEST Standard shop');
    await editor.getByRole('button', { name: 'Ask the other founder to approve' }).click();
    const standardHandoff = await editor.getByLabel('Request for the other founder').inputValue();
    const contextB2 = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
    const b2 = await contextB2.newPage();
    await founderSignIn(b2, 'b');
    await b2.goto('/merchants/categories');
    const approve2 = b2.getByRole('group', { name: 'Approve a category change' });
    await approve2.getByLabel('Request from the other founder').fill(standardHandoff);
    await expect(approve2).toContainText('TEST Standard shop');
    await approve2.getByRole('button', { name: 'Approve this category change' }).click();
    await expect(approve2).toContainText('Approved');
    await contextB2.close();
    await editor.getByRole('button', { name: 'Save the change' }).click();
    await expect(editor).toContainText('TEST Standard shop is in the table');
  }
  await contextA.close();

  // The owner reads the table with the class rule, reserve and documents, and picks the new category.
  await page.reload();
  const item = section.getByRole('list', { name: 'Every category' }).getByRole('listitem', { name: LABEL });
  await expect(item).toContainText('High risk');
  await expect(item).toContainText('No card payments (crypto and bank transfer only), extra documents and a reserve.');
  await expect(item).toContainText('5% of payments, held for 90 days');
  await expect(item).toContainText('TEST gaming licence');
  await expect(section).toContainText('You haven’t chosen a category yet');
  await section.getByLabel('Your business category').selectOption({ label: LABEL });
  await section.getByRole('button', { name: 'Save category' }).click();
  await expect(section.getByText('Your category was saved.')).toBeVisible();
  const chosen = section.getByTestId('category-chosen');
  await expect(chosen).toContainText('High risk');
  await expect(chosen).toContainText('5% of payments, held for 90 days');
  await page.reload();
  await expect(section.getByTestId('category-chosen')).toContainText('TEST gaming licence');
  expect(refused).toEqual([]);
});

// The step's text (operation-zero merchant journeys.md, J-merchant-02 #6): "Reads the verification history and the
// activation state: append-only history with no implied screening clearance; activation reads unconfirmed until the
// service says so". svc-pay says so when its own status history records a move to active; today the one production door
// that records one is a founder's restore (accountControls.change), so the founders restrict, then restore, the business.
test(`${J} #6 reads the verification history and the activation state: append-only history with no implied screening clearance; activation reads unconfirmed until the service says so`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const owner = await businessReadyPerson(page, 'mav', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Activation Ltd');
  const refused = refusedPayCalls(page);
  const activation = page.getByTestId('pp-activation');
  const history = page.getByRole('list', { name: 'Verification history' });
  const entries = async () =>
    history.getByRole('listitem').evaluateAll((items) =>
      items.map((li) => ({
        title: li.querySelector('strong')?.textContent ?? '',
        at: li.querySelector('time')?.getAttribute('datetime') ?? '',
      })),
    );
  // No words that read as a screening clearance anywhere in the room (a facts row's label and value join with no space,
  // so the pattern allows none), and none in any history entry.
  const noClearance = async () => {
    await expect(page.locator('main')).not.toContainText(/screening\s*(passed|cleared|complete|clear)|(passed|cleared)\s*screening/i);
    for (const entry of await entries()) expect(entry.title).not.toMatch(/screen|clear|sanction/i);
  };
  // Once there is a verification record, it says outright that it is not a screening result, and its Screening row says
  // the results are not shown.
  const screeningDisclaimed = async () => {
    const record = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Current record' }) });
    await expect(record.locator('dt', { hasText: /^Screening$/ }).locator('xpath=following-sibling::dd[1]')).toHaveText(
      'Handled by INTAFACED. Results are not shown here.',
    );
    await expect(page.getByText('Verification is not a screening result.', { exact: false })).toBeVisible();
  };
  const NO_RECORD = 'INTAFACED has no recorded activation decision for this business.';
  const UNCONFIRMED = { activation: 'unconfirmed', status: 'active', activatedAt: null, reason: 'no_activation_record' };

  // svc-pay asked straight through Edge as the owner, with the token the room itself sends.
  let ownerToken = '';
  const askRaw = (procedure, input) =>
    page.request.get(`/api/pay/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`, {
      headers: { authorization: ownerToken },
    });
  const ask = async (procedure, input) => {
    const res = await askRaw(procedure, input);
    expect(res.status()).toBe(200);
    return (await res.json()).result.data;
  };
  const askActivation = () => ask('merchantOps.activation.get', {});
  // The verification history as svc-pay keeps it, newest first, in one page.
  const serviceHistory = async () => {
    const one = await ask('merchantOps.kyb.history', { limit: 50 });
    expect(one.nextCursor).toBeNull();
    return one.items;
  };
  // Opens the compliance room and returns svc-pay's reply to the room's own activation read, after requiring the
  // service to give the owner the same answer when asked directly.
  const openCompliance = async (open = () => page.goto('/pay/compliance')) => {
    const replied = page.waitForResponse((r) => r.url().includes('merchantOps.activation.get') && r.request().method() === 'GET');
    await open();
    const res = await replied;
    expect(res.status()).toBe(200);
    const body = await res.json();
    const shown = body.result.data;
    ownerToken = res.request().headers().authorization;
    expect(await askActivation()).toEqual(shown);
    return shown;
  };

  // A new business: nothing sent, activation unconfirmed because svc-pay holds no activation record.
  expect(await openCompliance()).toEqual(UNCONFIRMED);
  await expect(activation).toContainText('Unconfirmed');
  await expect(activation).not.toContainText('Active since');
  await expect(page.getByText(NO_RECORD, { exact: false })).toBeVisible();
  await expect(page.getByText('No verification history yet')).toBeVisible();
  expect(await serviceHistory()).toEqual([]);
  await noClearance();

  // Sent for review: one entry, by the owner, the same in the room and in the service.
  await sentForReview(page, owner);
  expect(await openCompliance()).toEqual(UNCONFIRMED);
  await expect(history.getByRole('listitem')).toHaveCount(1);
  const sent = await entries();
  expect(sent).toEqual([{ title: 'Verification changed: Not sent → In review', at: expect.stringMatching(/^\d{4}-/) }]);
  await expect(history).toContainText('Changed by your merchant account');
  const sentRows = await serviceHistory();
  expect(sentRows).toEqual([
    {
      seq: expect.stringMatching(/^\d+$/),
      fromStatus: 'none',
      toStatus: 'pending',
      kybRef: `TEST-kyb-${owner.handle}`,
      decidedBy: 'merchant',
      reason: expect.any(String),
      at: sent[0].at,
    },
  ]);

  // INTAFACED approves it: a new entry on top, the earlier one exactly as it was, times in order.
  approveKyb(merchantId);
  // An approved verification is not the service saying so: svc-pay records no activation on a KYB decision.
  expect(await openCompliance(() => page.reload())).toEqual(UNCONFIRMED);
  await expect(history.getByRole('listitem')).toHaveCount(2);
  const decided = await entries();
  expect(decided[0].title).toBe('Verification changed: In review → Approved');
  expect(decided[1]).toEqual(sent[0]);
  expect(Date.parse(decided[0].at)).toBeGreaterThanOrEqual(Date.parse(decided[1].at));
  await expect(history.getByRole('listitem').first()).toContainText('Changed by INTAFACED');
  const decidedRows = await serviceHistory();
  expect(decidedRows).toHaveLength(2);
  expect(decidedRows[0]).toMatchObject({
    fromStatus: 'pending',
    toStatus: 'approved',
    decidedBy: 'intafaced',
    reason: null,
    at: decided[0].at,
  });
  expect(decidedRows[1]).toEqual(sentRows[0]);
  const record = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Current record' }) });
  await expect(record.getByTestId('pp-facts')).toContainText('Approved');
  await expect(activation).toContainText('Unconfirmed');
  await expect(activation).not.toContainText('Confirmed');
  await expect(page.getByText(NO_RECORD, { exact: false })).toBeVisible();
  await expect(page.getByText('It is not a screening result.')).toBeVisible();
  await screeningDisclaimed();
  await noClearance();

  // The owner cannot say so themselves: svc-pay refuses the owner's own restore with its typed code and records the
  // attempt; the activation and the verification history read back exactly as before.
  const ownRestore = {
    requestId: uuidOf(`${J}:own-restore:${merchantId}`),
    target: { area: 'merchant', merchantId },
    action: 'restore',
    reason: 'TEST J-merchant-02 #6 owner restore',
    expectedVersion: '0',
  };
  const ownAttempt = await page.request.post('/api/pay/trpc/accountControls.change', {
    headers: { authorization: ownerToken, origin: new URL(page.url()).origin },
    data: ownRestore,
  });
  expect(ownAttempt.status()).toBe(200);
  const ownRefusal = (await ownAttempt.json()).result.data;
  expect(ownRefusal).toEqual({
    requestId: ownRestore.requestId,
    target: ownRestore.target,
    action: 'restore',
    reason: ownRestore.reason,
    auditId: expect.any(String),
    occurredAt: expect.stringMatching(/^\d{4}-/),
    outcome: 'refused',
    changed: false,
    actorUserId: owner.userId.toLowerCase(),
    code: 'operator.denied',
    current: null,
  });
  expect(await askActivation()).toEqual(UNCONFIRMED);
  expect(await serviceHistory()).toEqual(decidedRows);

  // The service says so: founder A restricts the business, then restores it, in the founder console's account controls
  // (svc-pay accountControls.change). The restore writes svc-pay's dated move back to active.
  const desk = await (await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } })).newPage();
  const founder = await founderSignIn(desk, 'a');
  const founderId = founder.userId.toLowerCase();
  await desk.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  await desk.getByLabel('Account area').selectOption('merchant');
  await desk.getByLabel('Merchant ID').fill(merchantId);
  await desk.getByRole('button', { name: 'Inspect account' }).click();
  await expect(desk.getByRole('heading', { name: 'Access permitted' })).toBeVisible({ timeout: 60_000 });
  const controlRows = desk.locator('table tbody tr');
  // svc-pay's control history as the founder reads it from the service, newest first.
  const controlHistory = async () => {
    const res = await desk.request.get(`${ADMIN}/api/accounts?area=merchant&id=${merchantId}&history=true&limit=50`);
    expect(res.status()).toBe(200);
    return res.json();
  };
  expect(await controlHistory()).toEqual([ownRefusal]);
  await expect(controlRows).toHaveCount(1);
  await expect(controlRows.first()).toContainText('refused');
  const control = async (button, action, reason, before) => {
    const answered = desk.waitForResponse((r) => new URL(r.url()).pathname === '/api/accounts' && r.request().method() === 'POST');
    await desk.getByLabel('Reason').fill(reason);
    await desk.getByLabel(/I reviewed this account/).check();
    await desk.getByRole('button', { name: button }).click();
    const res = await answered;
    expect(res.status()).toBe(200);
    const result = await res.json();
    expect(result).toEqual({
      auditId: expect.any(String),
      requestId: expect.any(String),
      target: { area: 'merchant', merchantId },
      action,
      reason,
      occurredAt: expect.stringMatching(/^\d{4}-/),
      outcome: 'changed',
      changed: true,
      actorUserId: founderId,
      before,
      after: { ...before, version: String(Number(before.version) + 1), restricted: action === 'restrict' },
    });
    return result;
  };
  const restricted = await control('Restrict access', 'restrict', 'TEST J-merchant-02 #6 restrict', {
    target: { area: 'merchant', merchantId },
    version: '0',
    restricted: false,
  });
  await expect(desk.getByRole('status')).toContainText('Account restricted.');
  await expect(desk.getByRole('heading', { name: 'Restricted' })).toBeVisible();
  expect(await controlHistory()).toEqual([restricted, ownRefusal]);
  await expect(controlRows).toHaveCount(2);

  // While restricted the service confirms nothing: it refuses the owner's activation read with its typed code, because a
  // restricted business's owner grant is withdrawn (svc-pay own-merchant-read).
  const whileRestricted = await askRaw('merchantOps.activation.get', {});
  expect(whileRestricted.status()).toBe(403);
  expect((await whileRestricted.json()).error.message).toBe('pay.owner_grant_withdrawn');
  // And the owner's room, opened now, shows no activation and no "Active since". Its reads are refused while the
  // business is restricted, each 403 (the withdrawn owner grant); they are taken out here so the end of the step still
  // proves nothing else was refused.
  const refusedBefore = refused.length;
  const roomAsked = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/api/pay/trpc/merchant.me'));
  await page.goto('/pay/compliance');
  expect((await roomAsked).status(), "the room's own business read is refused while restricted").toBe(403);
  await expect(page.locator('main')).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/Confirmed|Active since/);
  const whileRestrictedRefused = refused.splice(refusedBefore);
  expect(whileRestrictedRefused.length, 'the room read svc-pay while restricted').toBeGreaterThan(0);
  for (const call of whileRestrictedRefused) expect(call, 'refused only as the withdrawn owner grant').toMatch(/^403 /);

  const restored = await control('Restore access', 'restore', 'TEST J-merchant-02 #6 restore', restricted.after);
  await expect(desk.getByRole('status')).toContainText('Account restored.');
  await expect(desk.getByRole('heading', { name: 'Access permitted' })).toBeVisible();
  // svc-pay's control history only grew: the restore on top, everything below it exactly as it was.
  expect(await controlHistory()).toEqual([restored, restricted, ownRefusal]);
  await expect(controlRows).toHaveCount(3);
  await expect(controlRows.first()).toContainText('restore');
  await desk.context().close();

  // Now the service says so: confirmed, active since the restore's own recorded time, and the page shows that time.
  const confirmed = await openCompliance(() => page.reload());
  expect(confirmed).toEqual({ activation: 'confirmed', status: 'active', activatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  // The status row is written in the restore's own transaction, so its time sits beside the service's record of it.
  expect(Math.abs(Date.parse(confirmed.activatedAt) - Date.parse(restored.occurredAt))).toBeLessThan(5_000);
  expect(Date.parse(confirmed.activatedAt)).toBeGreaterThan(Date.parse(restricted.occurredAt));
  await expect(activation).toContainText('Confirmed');
  await expect(activation).not.toContainText('Unconfirmed');
  await expect(activation.locator('div').filter({ hasText: 'Active since' }).locator('time')).toHaveAttribute(
    'datetime',
    confirmed.activatedAt,
  );
  await expect(page.getByText(NO_RECORD, { exact: false })).toHaveCount(0);

  // The verification history only grew: the founders' controls rewrote none of it and implied no screening clearance.
  await expect(history.getByRole('listitem')).toHaveCount(2);
  expect(await entries()).toEqual(decided);
  expect(await serviceHistory()).toEqual(decidedRows);
  await expect(page.getByText('It is not a screening result.')).toBeVisible();
  await noClearance();
  expect(refused).toEqual([]);
});
