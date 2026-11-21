// World: none
import { test, expect } from './journey.mjs';
import { api, journeyState, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { setPartner } from './partner.mjs';
import { venueBalance, venueRecord } from './venue.mjs';
import { STACK_PORTS } from '../../../../tooling/scripts/local-test-facts.mjs';

// J-bank-17, in the running app (docs/roadmap/journeys.json): I finish bank onboarding, answer reviews and close my bank
// account. One TEST account, signed up and verified with us, whose bank account the stack's TEST partner bank holds
// (`testPartner.set({ custody: 'off' })`), with TEST 25 USDT paid in there and an information request from the partner
// open, as the journey starts. Every step, requirement, request, review and closure is the partner's, read through the
// person's own bank API and pages; the owner's requirements, an answer's size cap and the reopen window are the stack's
// TEST owner values (tooling/profiles/test-owner-values/bank.json). The ledger posts nothing: the person's ledger
// balances stay empty throughout, and the closure's payout is checked against the TEST partner's own book, read on
// loopback (svc-bank src/partner/test-partner-record.ts), never through our doors.
// Step 3 (tax self-certification) is deferred until launch prep (owner decision 2026-10-27, OWNER 87) and has no test.
const J = 'J-bank-17';
const PARTNER_BANK = 'TEST partner bank';
const PARTNER_RECORD = `http://127.0.0.1:${STACK_PORTS.bank}/test-partner`;
const PAYOUTS = 'partner:outbound-payments';
// TEST: the standard example IBAN, nobody's account.
const DESTINATION = { name: 'TEST own account elsewhere', accountRef: 'NL91 ABNA 0417 1643 00' };
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function person() {
  const { who } = run.read();
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** One call to the person's own bank API; returns the tRPC data, or throws with the refusal. */
async function bank(who, method, procedure, input) {
  const session = await api(who);
  const res =
    method === 'GET'
      ? await session.get(`/api/bank/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`)
      : await session.post(`/api/bank/trpc/${procedure}`, input ?? {});
  return res;
}

async function ok(who, method, procedure, input) {
  const res = await bank(who, method, procedure, input);
  expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 400)}`).toBe(200);
  return res.body.result.data;
}

/** The refusal code a call answered with; the call must not succeed. */
async function refusal(who, procedure, input) {
  const res = await bank(who, 'POST', procedure, input);
  expect(res.status, `${procedure} should refuse: ${JSON.stringify(res.body).slice(0, 400)}`).not.toBe(200);
  const data = res.body?.error?.data;
  return data?.intafacedCode ?? data?.cause?.code ?? res.body?.error?.message;
}

/** The person's ledger balances: every one must be zero, as the ledger posts nothing for this journey. */
async function expectNothingOnLedger(who) {
  const balances = await (await api(who)).balances();
  for (const [asset, row] of Object.entries(balances ?? {})) {
    expect(toUnits(row.total), `ledger ${asset}`).toBe(0n);
  }
}

const bankAccount = (page) => page.getByTestId('bank-account');

test(`${J} #1 opens the onboarding banner: the partner's steps and requirements with the owner's, and our identity case from Verification where the partner accepts it`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await signUp(page, 'bk17');
  await verify(page, who);
  run.reset({ who });
  await setPartner(who, { custody: 'off' });
  const funded = await ok(who, 'POST', 'testPartner.fund', { fundId: `${J}-${who.email}`.slice(0, 64), assetId: 'USDT', amount: '25' });
  expect(funded).toMatchObject({ label: PARTNER_BANK, balance: '25' });
  const opened = await ok(who, 'POST', 'testPartner.openCompliance', { kind: 'request', id: 'bk17-request-1', dueDays: 14 });
  run.reset({ who, requestDueAt: opened.dueAt });
  await expectNothingOnLedger(who);
  await signIn(page, who);

  // The banner on the Bank's first page, naming the partner and what is open.
  await page.goto('/bank');
  const banner = page.getByTestId('bank-onboarding-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(`${PARTNER_BANK} needs something from you`);
  await expect(banner).toContainText('1 information requests');
  await banner.getByRole('link', { name: 'Open onboarding' }).click();
  await expect(page).toHaveURL(/\/bank\/account$/);

  // The partner's steps: identity done with our case from Verification, which the partner accepts; information open.
  const onboarding = page.getByTestId('bank-onboarding');
  await expect(onboarding).toHaveAttribute('data-partner', PARTNER_BANK);
  await expect(onboarding.locator('li[data-step="identity"]')).toHaveAttribute('data-status', 'done');
  await expect(onboarding.locator('li[data-step="identity"]')).toHaveAttribute('data-done-with', 'identity_case');
  await expect(onboarding.locator('li[data-step="identity"]')).toContainText(
    `Done with your INTAFACED verification, which ${PARTNER_BANK} accepts`,
  );
  await expect(onboarding.locator('li[data-step="information"]')).toHaveAttribute('data-status', 'open');
  const identityCase = page.getByTestId('bank-identity-case');
  await expect(identityCase).toHaveAttribute('data-accepted', 'true');
  await expect(identityCase).toHaveAttribute('data-tier', 'full');
  await expect(identityCase).toContainText(`Your INTAFACED verification (level full) is offered to ${PARTNER_BANK}, and it accepts it.`);
  // The partner's requirements, with the owner's beside them.
  await expect(page.getByTestId('bank-partner-requirements').locator('li')).toHaveText([
    'TEST: be 18 or older',
    'TEST: live in a country the partner bank serves',
  ]);
  await expect(page.getByTestId('bank-owner-requirements').locator('li')).toHaveText([
    'TEST owner requirement: keep your contact email up to date',
    'TEST owner requirement: use the account for your own money only',
  ]);

  // Where the partner does not accept our case, the identity step is the partner's own check, still open.
  await setPartner(who, { identityCase: 'not_accepted' });
  await page.reload();
  await expect(page.getByTestId('bank-identity-case')).toHaveAttribute('data-accepted', 'false');
  await expect(page.getByTestId('bank-identity-case')).toContainText(`${PARTNER_BANK} does not accept your INTAFACED verification`);
  await expect(page.getByTestId('bank-onboarding').locator('li[data-step="identity"]')).toHaveAttribute('data-status', 'open');
  await expect(page.getByTestId('bank-onboarding').locator('li[data-step="identity"]')).toHaveAttribute('data-done-with', '');
  await setPartner(who, { identityCase: 'accepted' });
});

test(`${J} #2 answers an information request with an upload: the request, the upload box with the owner's size cap and the deadline; answering moves it to under review once`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = person();
  const { requestDueAt } = run.read();
  await signIn(page, who);
  await page.goto('/bank/account');
  const request = bankAccount(page).locator('li[data-request]').first();
  await expect(request).toHaveAttribute('data-status', 'open');
  await expect(request).toContainText('TEST: show where the money you pay in comes from');
  // The partner's deadline, as it opened the request.
  await expect(request).toHaveAttribute('data-due', requestDueAt);
  await expect(request).toContainText(`Deadline: ${requestDueAt.slice(0, 10)}`);
  // The owner's size cap and types, on the upload box.
  await expect(request.locator('[data-max-bytes]')).toHaveAttribute('data-max-bytes', '65536');
  await expect(request).toContainText('One application/pdf or image/png file, up to 65536 bytes.');

  // A file over the owner's cap is refused, and the request stays open.
  const file = request.getByLabel('File');
  await file.setInputFiles({ name: 'too-big.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(65_537, 0x25) });
  await request.getByRole('button', { name: 'Send answer' }).click();
  await expect(request.getByRole('alert')).toHaveAttribute('data-code', 'bank.info_request_too_large');
  await expect(request).toHaveAttribute('data-status', 'open');

  // A file inside the cap: the request moves to under review, with the file as the partner received it.
  await request
    .getByLabel('File')
    .setInputFiles({ name: 'payslip.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 TEST payslip') });
  await request.getByRole('button', { name: 'Send answer' }).click();
  await expect(request).toHaveAttribute('data-status', 'under_review');
  await expect(request).toContainText('Under review since');
  await expect(request).toContainText('Sent: payslip.pdf, 21 bytes');
  await expect(request.getByRole('button', { name: 'Send answer' })).toHaveCount(0);

  // Once: a second answer is refused, and the first file stands.
  const id = await request.getAttribute('data-request');
  expect(
    await refusal(who, 'bankAccount.answerRequest', {
      requestId: id,
      name: 'other.pdf',
      type: 'application/pdf',
      contentBase64: Buffer.from('%PDF other').toString('base64'),
    }),
  ).toBe('bank.info_request_not_open');
  const { requests } = await ok(who, 'GET', 'bankAccount.requests');
  expect(requests.filter((r) => r.id === id)).toEqual([
    expect.objectContaining({ status: 'under_review', file: expect.objectContaining({ name: 'payslip.pdf', size: 21 }) }),
  ]);
  // With the request answered and our case accepted, onboarding is done.
  expect(await ok(who, 'GET', 'bankAccount.onboarding')).toMatchObject({ complete: true, openRequests: 0 });
});

test(`${J} #4 answers a periodic review: an open review shows its due date and the effect of missing it`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = person();
  const opened = await ok(who, 'POST', 'testPartner.openCompliance', { kind: 'review', id: 'bk17-review-1', dueDays: 30 });
  await signIn(page, who);
  await page.goto('/bank/account');
  const review = bankAccount(page).locator('li[data-review]').first();
  await expect(review).toHaveAttribute('data-status', 'open');
  await expect(review).toHaveAttribute('data-due', opened.dueAt);
  await expect(review).toContainText(`Due: ${opened.dueAt.slice(0, 10)}`);
  await expect(review.getByTestId('bank-review-missed')).toHaveText(
    'If you miss it: TEST: if this review is not answered by its due date, the partner bank restricts the account to incoming payments until it is.',
  );
  await review.getByLabel('My account details are still accurate').check();
  await review.getByRole('button', { name: 'Answer review' }).click();
  await expect(review).toHaveAttribute('data-status', 'answered');
  await expect(review).toContainText('Answered on');
  expect(await refusal(who, 'bankAccount.answerReview', { reviewId: opened.id, stillAccurate: true, note: null })).toBe(
    'bank.review_not_open',
  );
});

test(`${J} #5 requests closure with a balance: restricted while pending; a destination for the balance is required; closed once the partner reports it paid out; a legal hold refuses`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = person();
  const session = await api(who);
  expect((await venueBalance(session.userId, 'USDT', PARTNER_RECORD)).total).toBe('25');
  await signIn(page, who);
  await page.goto('/bank/account');
  const closure = page.getByTestId('bank-closure');
  await expect(closure).toHaveAttribute('data-state', 'open');

  // A balance and no destination: refused, nothing changes.
  await closure.getByRole('button', { name: 'Close account' }).click();
  await expect(closure.getByRole('alert')).toHaveAttribute('data-code', 'bank.closure_destination_required');
  await expect(closure).toHaveAttribute('data-state', 'open');

  // A legal hold at the partner refuses closure.
  await setPartner(who, { legalHold: 'held' });
  await closure.getByLabel('Name on the destination account').fill(DESTINATION.name);
  await closure.getByLabel('Destination account number (IBAN)').fill(DESTINATION.accountRef);
  await closure.getByRole('button', { name: 'Close account' }).click();
  await expect(closure.getByRole('alert')).toHaveAttribute('data-code', 'bank.closure_legal_hold');
  await expect(closure).toHaveAttribute('data-state', 'open');
  await setPartner(who, { legalHold: 'none' });

  // With a destination: pending, and the account is restricted while it is.
  await closure.getByLabel('Name on the destination account').fill(DESTINATION.name);
  await closure.getByLabel('Destination account number (IBAN)').fill(DESTINATION.accountRef);
  await closure.getByRole('button', { name: 'Close account' }).click();
  await expect(closure).toHaveAttribute('data-state', 'pending');
  await expect(closure.getByTestId('bank-closure-restricted')).toHaveText(
    `Closing: restricted while ${PARTNER_BANK} pays out your balance to ${DESTINATION.name}, NL91ABNA0417164300. No money moves in or out until then.`,
  );
  await expect(closure.locator('li[data-asset="USDT"]')).toHaveAttribute('data-amount', '25');
  expect(await refusal(who, 'testPartner.spend', { spendId: `${J}-while-pending`, assetId: 'USDT', amount: '1', kind: 'payment' })).toBe(
    'bank.account_restricted',
  );
  expect(await refusal(who, 'testPartner.fund', { fundId: `${J}-while-pending`, assetId: 'USDT', amount: '1' })).toBe(
    'bank.account_restricted',
  );
  // Not closed yet: the money is still the person's at the partner until it reports the payout.
  expect((await venueBalance(session.userId, 'USDT', PARTNER_RECORD)).total).toBe('25');

  // The partner reports the balance paid out: closed, and its own book shows the whole balance left once.
  const paid = await ok(who, 'POST', 'testPartner.closurePaidOut');
  await page.reload();
  await expect(page.getByTestId('bank-closure')).toHaveAttribute('data-state', 'closed');
  await expect(page.getByTestId('bank-closure')).toContainText(`Paid out by ${PARTNER_BANK} on ${paid.closedAt.slice(0, 10)}`);
  expect((await venueBalance(session.userId, 'USDT', PARTNER_RECORD)).total).toBe('0');
  const payouts = (await venueRecord(session.userId, '/moves', {}, PARTNER_RECORD, null)).value.filter((m) =>
    m.key.startsWith('bank.closure.payout:'),
  );
  expect(payouts).toEqual([
    expect.objectContaining({
      id: paid.payoutMoveIds[0],
      amount: '25',
      from: expect.objectContaining({ owner: session.userId }),
      to: expect.objectContaining({ owner: PAYOUTS }),
    }),
  ]);
  // A second report pays nothing more.
  expect(await refusal(who, 'testPartner.closurePaidOut')).toBe('bank.closure_not_found');
  await expectNothingOnLedger(who);
  run.reset({ ...run.read(), closedAt: paid.closedAt });
});

test(`${J} #6 asks for my data, or reopens the account: the data-rights request with its record; reopen within the owner's window`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const who = person();
  const { closedAt } = run.read();
  if (!closedAt) throw new Error(`${J} #5 closed no account, so there is nothing to reopen`);
  await signIn(page, who);
  await page.goto('/bank/account');

  // The data-rights request, recorded by the partner with its reference.
  const data = page.getByTestId('bank-data-rights');
  await data.getByLabel('What you ask for').selectOption('access');
  await data.getByRole('button', { name: 'Send request' }).click();
  const record = data.locator('li[data-request]');
  await expect(record).toHaveCount(1);
  await expect(record).toHaveAttribute('data-kind', 'access');
  await expect(record).toHaveAttribute('data-status', 'received');
  const ref = await record.getAttribute('data-partner-ref');
  expect(ref).toMatch(/^test-partner-data-/);
  await expect(record).toContainText(`A copy of my data: received on ${new Date().toISOString().slice(0, 10)}, reference ${ref}`);
  expect((await ok(who, 'GET', 'bankAccount.dataRequests')).requests).toEqual([
    expect.objectContaining({ partnerRef: ref, kind: 'access' }),
  ]);

  // Reopen within the owner's window: 30 TEST days from the closing.
  const closure = page.getByTestId('bank-closure');
  const until = new Date(Date.parse(closedAt) + 30 * 86_400_000).toISOString();
  await expect(closure.getByTestId('bank-reopen-until')).toHaveAttribute('data-until', until);
  await expect(closure.getByTestId('bank-reopen-until')).toHaveAttribute('data-days', '30');
  await expect(closure.getByTestId('bank-reopen-until')).toHaveText(`You can reopen it until ${until.slice(0, 10)}.`);
  await closure.getByRole('button', { name: 'Reopen account' }).click();
  await expect(closure).toHaveAttribute('data-state', 'open');
  await expect(closure).toContainText('Reopened on');
  // Open again: the partner takes a payment in, and the account is no longer restricted.
  expect(await ok(who, 'POST', 'testPartner.fund', { fundId: `${J}-after-reopen`, assetId: 'USDT', amount: '1' })).toMatchObject({
    balance: '1',
  });
  expect(await refusal(who, 'bankAccount.reopen')).toBe('bank.account_not_closed');
  await expectNothingOnLedger(who);
});
