// World: stack
import { test, expect } from './journey.mjs';
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
import { ADMIN, founderSignIn } from './admin.mjs';

// J-merchant-02 #4 and #5, in the running app (docs/roadmap/journeys.json): get verified and go live. The journey's
// other steps run in J-merchant-02.pw.mjs; these are here so neither file holds main's journeys run alone. Each test
// opens its own business, so none needs another's state, and none needs a fresh stack (the category table may hold
// categories already: merchant.mjs chooseTakenCategory picks a standard one). Tests titled "J-merchant-02 #<n>" prove a
// whole step; the others prove part of one and say which.
const J = 'J-merchant-02';

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
