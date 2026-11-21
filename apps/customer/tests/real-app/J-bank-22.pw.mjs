// World: stack
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api as ledgerApi, journeyState, json, signOutBrowser, signUpInBrowser } from './stack.mjs';
import { signIn, verify } from './desk.mjs';

// J-bank-22, in the running app (docs/roadmap/journeys.json): I give my team cards and handle their expenses. Tests
// titled "J-bank-22 #<n>" prove a step.
//
// Starts: a business admin (the business's owner), signed up as a business and verified, in Business mode on a business
// bank account whose money is the TEST partner bank's (`custody: 'off'`), with TEST 1000 USDT paid into the business's
// own partner account (`testPartner.fundBusiness`): the partner's figure and no ledger post. A team member (built-in
// viewer role) is on the team, their own bank money also at the TEST partner. The roles and the business's approval
// threshold (TEST 500) are set when the business is made.
//
// Each step opens a business of its own. Cards are TEST cards on the TEST card network (`rail.card` is not connected).
// A captured purchase is one partner move under `bank.business.card-capture:<purchase id>`; a reimbursement is one
// partner move under `bank.business.reimbursement:<claim id>`. The ledger posts nothing, which every step checks on the
// owner's and the member's ledger figures.
const J = 'J-bank-22';
const RUN = Date.now().toString(36);
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const PARTNER_BANK = 'TEST partner bank';
const FUNDED = '1000';
const THRESHOLD = '500';

test.describe.configure({ mode: 'default' });

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who) {
  const { status, body: login } = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then(json);
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${status} ${JSON.stringify(login).slice(0, 300)}`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const answer = async (res) => {
    const body = await res.json();
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        code: body?.error?.data?.intafacedCode ?? body?.error?.data?.cause?.code ?? body?.error?.data?.code,
        body,
      };
    return { ok: true, data: body.result.data };
  };
  return {
    userId: login.result.data.userId,
    query: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
  };
}

function ok(res) {
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 400)).toBe(true);
  return res.data;
}

async function person(page, prefix, options = {}) {
  const handle = `${prefix}${RUN}${randomBytes(2).toString('hex')}`;
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  await signUpInBrowser(page, who, options);
  await verify(page, who);
  return who;
}

/** The owner and a team member, made once a run and kept in its run file, with their ledger figures before anything. */
async function world(page) {
  const kept = run.read();
  if (kept.owner) return kept;
  const owner = await person(page, 'jb22o', { accountType: 'business' });
  const member = await person(page, 'jb22m');
  const ownerLedger = await (await ledgerApi(owner)).balances();
  const memberLedger = await (await ledgerApi(member)).balances();
  return run.reset({ owner, member, ownerLedger, memberLedger });
}

/** A business of the step's own: TEST 1000 USDT at the TEST partner, the member on its team, both people's money at the partner. */
async function business(w, tag) {
  const own = await bank(w.owner);
  const mem = await bank(w.member);
  // Each person's bank money at the TEST partner, set again each time: a stack restart puts the switch back.
  ok(await own.mutate('testPartner.set', { custody: 'off' }));
  ok(await mem.mutate('testPartner.set', { custody: 'off' }));
  const accountId = randomUUID();
  const name = `TEST Cards ${tag} ${RUN}`;
  ok(await own.mutate('business.create', { accountId, name, assetId: 'USDT', spendThreshold: THRESHOLD }));
  const funded = ok(await own.mutate('testPartner.fundBusiness', { accountId, fundId: `jb22-${accountId}`.slice(0, 64), amount: FUNDED }));
  expect(funded).toMatchObject({ label: PARTNER_BANK, assetId: 'USDT', balance: FUNDED });
  const invite = ok(
    await own.mutate('businessTeam.invite', { accountId, inviteId: randomUUID(), email: null, role: 'viewer', roleId: null }),
  );
  ok(await mem.mutate('businessTeam.acceptInvite', { token: invite.token }));
  return { own, mem, accountId, name };
}

/** A card for the member with a per-purchase limit, issued through the API (a step's precondition). */
async function cardFor(b, limit) {
  return ok(
    await b.own.mutate('businessCards.issueCard', {
      accountId: b.accountId,
      cardId: randomUUID(),
      memberUserId: b.mem.userId,
      perPurchaseLimit: limit,
    }),
  );
}

/** The business's account at the partner, as the partner reports it. */
async function held(own, accountId) {
  return ok(await own.query('businessTeam.overview', { accountId })).partner.amount;
}

/**
 * `who` signed in, in Business mode on `name`, at the cards room. The pick is saved on the account's view record a
 * moment later (shared/view-sync.ts), and that record wins on the next load; so the room is read until it names the
 * business just picked, picking again if a load beat the save.
 */
async function inBusiness(page, who, name) {
  await signOutBrowser(page.context());
  await signIn(page, who);
  await page.goto('/home');
  for (let attempt = 1; ; attempt++) {
    const saved = page
      .waitForResponse((r) => r.url().includes('/preferences.set') && r.request().method() === 'POST', { timeout: 5_000 })
      .catch(() => null);
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByTestId('profile-business').filter({ hasText: name }).click();
    await page.waitForURL('**/pay/merchant');
    await saved;
    await page.goto('/bank/business/cards');
    const shown = page.getByTestId('cards-business');
    await expect(shown).toBeVisible();
    if ((await shown.textContent()) === name || attempt === 3) break;
  }
  await expect(page.getByTestId('cards-business')).toHaveText(name);
}

async function ledgerUnchanged(w) {
  expect(await (await ledgerApi(w.owner)).balances()).toEqual(w.ownerLedger);
  expect(await (await ledgerApi(w.member)).balances()).toEqual(w.memberLedger);
}

const receiptFile = (text, name = 'receipt.txt') => ({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });

async function spendInApp(page, merchant, amount) {
  const form = page.getByRole('form', { name: 'Spend on the TEST card network' });
  await form.getByLabel('Merchant').fill(merchant);
  await form.getByLabel('Amount').fill(amount);
  await form.getByRole('button', { name: 'Pay with this card' }).click();
  await expect(page.getByTestId('cards-notice')).toHaveText('The card network answered.');
  return page.getByTestId('card-purchase').filter({ hasText: merchant });
}

test(`${J} #1 issues a card to a member with a limit of 100.00: the card is in the member's view, and the card API path is under Developers`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const b = await business(w, 'issue');
  await inBusiness(page, w.owner, b.name);

  const form = page.getByRole('form', { name: 'Issue a card' });
  await form.getByLabel('Team member').selectOption({ label: w.member.handle });
  await form.getByLabel('Per-purchase limit').fill('100.00');
  await form.getByRole('button', { name: 'Issue card' }).click();
  await expect(page.getByTestId('cards-notice')).toHaveText('Card issued.');
  const issued = ok(await b.own.query('businessCards.overview', { accountId: b.accountId })).cards;
  expect(issued).toHaveLength(1);
  expect(issued[0]).toMatchObject({ memberUserId: b.mem.userId, perPurchaseLimit: '100', test: true, status: 'active' });

  // The card in the member's view: signed in as the member, in Business mode on the business.
  await inBusiness(page, w.member, b.name);
  const card = page.getByTestId('business-card');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-limit', '100');
  await expect(card).toHaveAttribute('data-member', b.mem.userId);
  await expect(card).toContainText(`TEST card •••• ${issued[0].panTail} for you: up to 100 USDT a purchase`);
  await expect(page.getByRole('form', { name: 'Spend on the TEST card network' })).toBeVisible();

  // The card API path: listed beside the cards, and under Developers, where it links back to it.
  const paths = page.getByTestId('card-api-path');
  await expect(paths.filter({ hasText: 'POST /api/bank/trpc/businessCards.issueCard' })).toHaveCount(1);
  await expect(paths.filter({ hasText: 'GET /api/bank/trpc/businessCards.overview' })).toHaveCount(1);
  await page.goto('/developers');
  const listed = page.getByRole('link', { name: 'Business cards API' });
  await expect(listed).toHaveAttribute('href', '/developers/business-cards');
  await listed.click();
  await expect(page.locator('a[href="/bank/business/cards#card-api"]')).toBeVisible();
  // The path is real: the member's own API session reads the same card through it.
  const viaApi = ok(await b.mem.query('businessCards.overview', { accountId: b.accountId }));
  expect(viaApi.cards.map((c) => c.id)).toEqual([issued[0].id]);
  expect(await held(b.own, b.accountId)).toBe(FUNDED);
  await ledgerUnchanged(w);
});

test(`${J} #2 the member spends 120.00 on a 100.00 card: the decline over_limit and an over-limit request to the admin`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const b = await business(w, 'decline');
  await cardFor(b, '100.00');
  await inBusiness(page, w.member, b.name);

  const row = await spendInApp(page, 'TEST Electronics', '120.00');
  await expect(row).toHaveAttribute('data-status', 'declined');
  await expect(row).toHaveAttribute('data-reason', 'over_limit');
  await expect(row.getByTestId('purchase-state')).toHaveText('Declined: over_limit');
  await expect(row.getByTestId('purchase-request')).toHaveText('An over-limit request was sent to your admin.');
  const purchase = ok(await b.mem.query('businessCards.overview', { accountId: b.accountId })).purchases[0];
  expect(purchase).toMatchObject({ status: 'declined', declineReason: 'over_limit', amount: '120', partnerMoveId: null });
  // A decline moves nothing at the partner.
  expect(await held(b.own, b.accountId)).toBe(FUNDED);

  // The admin sees the request.
  await inBusiness(page, w.owner, b.name);
  const request = page.getByTestId('limit-request');
  await expect(request).toHaveCount(1);
  await expect(request).toHaveAttribute('data-status', 'open');
  await expect(request).toHaveAttribute('data-amount', '120');
  await expect(request).toHaveAttribute('data-purchase', purchase.id);
  await expect(request).toContainText('waiting for you');
  await expect(request.getByRole('button', { name: 'Raise the limit' })).toBeVisible();
  await ledgerUnchanged(w);
});

test(`${J} #3 a capture of 80.00 with no receipt over the TEST 50.00 rule: "Needs receipt" and one reminder queued; bulk download of receipts`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const b = await business(w, 'receipts');
  await cardFor(b, '100.00');
  // The admin sets the TEST 50.00 receipt rule in the app.
  await inBusiness(page, w.owner, b.name);
  const rule = page.getByRole('form', { name: 'Receipt rule' });
  await rule.getByLabel('Receipt needed over').fill('50.00');
  await rule.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByTestId('receipt-policy')).toHaveText('A purchase over 50 USDT needs a receipt.');

  await inBusiness(page, w.member, b.name);
  // An earlier purchase with its receipt given, so the download has something in it.
  const lunch = await spendInApp(page, 'TEST Lunch', '60.00');
  await expect(lunch).toHaveAttribute('data-status', 'captured');
  const attach = page.getByRole('form', { name: 'Give receipt TEST Lunch' });
  await attach.getByLabel('Receipt file').setInputFiles(receiptFile('TEST receipt: lunch 60.00'));
  await attach.getByRole('button', { name: 'Give receipt' }).click();
  await expect(page.getByTestId('cards-notice')).toHaveText('Receipt given.');
  await expect(lunch).toHaveAttribute('data-needs-receipt', 'false');

  const hotel = await spendInApp(page, 'TEST Hotel', '80.00');
  await expect(hotel).toHaveAttribute('data-status', 'captured');
  await expect(hotel).toHaveAttribute('data-needs-receipt', 'true');
  await expect(hotel).toHaveAttribute('data-reminders', '1');
  await expect(hotel.getByTestId('purchase-receipt')).toHaveText('Needs receipt · One reminder queued');
  const captured = ok(await b.mem.query('businessCards.overview', { accountId: b.accountId })).purchases.find(
    (p) => p.merchant === 'TEST Hotel',
  );
  expect(captured).toMatchObject({ status: 'captured', amount: '80', receiptOver: '50', needsReceipt: true, reminders: 1 });
  expect(captured.partnerKey).toBe(`bank.business.card-capture:${captured.id}`);
  expect(captured.partnerMoveId).toBeTruthy();
  // One reminder, however often the purchase is read or asked again.
  await page.reload();
  await expect(page.getByTestId('card-purchase').filter({ hasText: 'TEST Hotel' })).toHaveAttribute('data-reminders', '1');
  const again = ok(
    await b.mem.mutate('businessCards.testPurchase', {
      cardId: captured.cardId,
      purchaseId: captured.id,
      merchant: 'TEST Hotel',
      amount: '80.00',
    }),
  );
  expect(again).toMatchObject({ reminders: 1, partnerMoveId: captured.partnerMoveId });
  // Both captures came out of the business's account at the partner, once each.
  expect(await held(b.own, b.accountId)).toBe('860');

  // The admin's bulk download of receipts: one ZIP file with the receipt given.
  await inBusiness(page, w.owner, b.name);
  await expect(page.getByTestId('card-purchase').filter({ hasText: 'TEST Hotel' }).getByTestId('purchase-receipt')).toContainText(
    'Needs receipt',
  );
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download all receipts' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^receipts-.*\.zip$/);
  const zip = await readFile(await download.path());
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  expect(zip.includes(Buffer.from('TEST receipt: lunch 60.00'))).toBe(true);
  await expect(page.getByTestId('cards-notice')).toHaveText('1 receipt(s) downloaded.');
  await ledgerUnchanged(w);
});

test(`${J} #4 the member submits a reimbursement of 42.50 with a receipt: a claim for review`, async ({ page }) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const b = await business(w, 'claim');
  await inBusiness(page, w.member, b.name);

  const form = page.getByRole('form', { name: 'Claim back an expense' });
  await form.getByLabel('Amount').fill('42.50');
  await form.getByLabel('What it was for').fill('TEST taxi to a client');
  await form.getByLabel('Receipt file').setInputFiles(receiptFile('TEST receipt: taxi 42.50', 'taxi.txt'));
  await form.getByRole('button', { name: 'Submit claim' }).click();
  await expect(page.getByTestId('cards-notice')).toHaveText('Claim submitted for review.');
  const claim = page.getByTestId('claim');
  await expect(claim).toHaveCount(1);
  await expect(claim).toHaveAttribute('data-status', 'submitted');
  await expect(claim).toHaveAttribute('data-amount', '42.5');
  await expect(claim.getByTestId('claim-state')).toHaveText('A claim for review');
  // The member cannot approve their own claim.
  await expect(claim.getByRole('button', { name: 'Approve and pay' })).toHaveCount(0);
  const [c] = ok(await b.mem.query('businessCards.overview', { accountId: b.accountId })).claims;
  expect(c).toMatchObject({ status: 'submitted', amount: '42.5', description: 'TEST taxi to a client', partnerMoveId: null });
  expect(c.receipt).toMatchObject({ fileName: 'taxi.txt', contentType: 'text/plain', size: 'TEST receipt: taxi 42.50'.length });
  expect(await b.mem.mutate('businessCards.approveAndPay', { claimId: c.id })).toMatchObject({
    ok: false,
    code: 'bank.business_self_approve',
  });

  // The admin sees it waiting for review; nothing has moved.
  await inBusiness(page, w.owner, b.name);
  await expect(page.getByTestId('claim')).toHaveAttribute('data-status', 'submitted');
  await expect(page.getByTestId('claim').getByRole('button', { name: 'Approve and pay' })).toBeVisible();
  expect(await held(b.own, b.accountId)).toBe(FUNDED);
  await ledgerUnchanged(w);
});

test(`${J} #5 the admin approves and pays: one partner transfer; the claim closes; the member's balance rises by exactly 42.50 as the partner reports`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const b = await business(w, 'pay');
  const claim = ok(
    await b.mem.mutate('businessCards.submitClaim', {
      accountId: b.accountId,
      claimId: randomUUID(),
      amount: '42.50',
      description: 'TEST train ticket',
      receiptId: randomUUID(),
      fileName: 'train.txt',
      contentType: 'text/plain',
      contentBase64: Buffer.from('TEST receipt: train 42.50').toString('base64'),
    }),
  );
  const before = ok(await b.mem.query('businessCards.overview', { accountId: b.accountId })).myBalance;
  expect(before.label).toBe(PARTNER_BANK);
  expect(before.amount).not.toBeNull();

  await inBusiness(page, w.owner, b.name);
  const row = page.getByTestId('claim');
  await row.getByRole('button', { name: 'Approve and pay' }).click();
  await expect(page.getByTestId('cards-notice')).toHaveText('Claim paid.');
  await expect(row).toHaveAttribute('data-status', 'paid');
  await expect(row.getByTestId('claim-state')).toHaveText(`Paid and closed: one transfer at ${PARTNER_BANK}`);
  await expect(row.getByRole('button', { name: 'Approve and pay' })).toHaveCount(0);

  const paid = ok(await b.own.query('businessCards.overview', { accountId: b.accountId })).claims[0];
  expect(paid).toMatchObject({ id: claim.id, status: 'paid', partnerKey: `bank.business.reimbursement:${claim.id}` });
  expect(paid.partnerMoveId).toBeTruthy();
  await expect(row.getByTestId('claim-partner-ref')).toHaveText(paid.partnerMoveId);
  // One partner transfer: paying again answers the same move, and the business's account went down once, by 42.50.
  expect(ok(await b.own.mutate('businessCards.approveAndPay', { claimId: claim.id }))).toMatchObject({
    status: 'paid',
    partnerMoveId: paid.partnerMoveId,
  });
  expect(await held(b.own, b.accountId)).toBe('957.5');

  // The member's balance rises by exactly 42.50, as the partner reports it before and after.
  const after = ok(await b.mem.query('businessCards.overview', { accountId: b.accountId })).myBalance;
  const scaled = (s) => BigInt(Math.round(Number(s) * 100));
  expect(scaled(after.amount) - scaled(before.amount)).toBe(4250n);
  expect(scaled(paid.memberAfter) - scaled(paid.memberBefore)).toBe(4250n);
  await expect(row.getByTestId('claim-member-balance')).toHaveText(
    `Member’s balance at ${PARTNER_BANK}: ${paid.memberBefore} → ${paid.memberAfter} USDT`,
  );
  await inBusiness(page, w.member, b.name);
  await expect(page.getByTestId('cards-my-balance')).toHaveAttribute('data-amount', after.amount);
  await expect(page.getByTestId('claim')).toHaveAttribute('data-status', 'paid');
  await ledgerUnchanged(w);
});
