// World: stack
import { randomBytes, randomUUID } from 'node:crypto';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api as ledgerApi, journeyState, json, signOutBrowser, signUpInBrowser } from './stack.mjs';
import { signIn, verify } from './desk.mjs';

// J-bank-21, in the running app (docs/roadmap/journeys.json): I pay my team and contractors in bulk. Tests titled
// "J-bank-21 #<n>" prove a step.
//
// Starts: a business admin (the business's owner), signed up as a business and verified, in Business mode on a business
// bank account whose money is the TEST partner bank's (`custody: 'off'`), with TEST 1000 USDT paid into the business's
// own partner account (`testPartner.fundBusiness`): the partner's figure and no ledger post. The business's threshold is
// TEST 500 USDT. An approver (the built-in checker role) is on the team. The business's own wallet is a TEST key made
// for this file (public, holding nothing anywhere), connected by its signature before the steps start.
//
// Each step opens a business of its own. A bulk run is one instruction to the partner under
// `bank.business.bulk-pay:<run id>`; a contractor batch is one under `bank.business.contractor-batch:<batch id>`; a crypto
// payroll run is signed by the business's own wallet, under `bank.business.crypto-payroll:<payroll>:<month>`. The
// ledger posts nothing, which every step checks on the owner's ledger figures.
const J = 'J-bank-21';
const RUN = Date.now().toString(36);
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const PARTNER_BANK = 'TEST partner bank';
const FUNDED = '1000';
const THRESHOLD = '500';
const IBANS = ['DE89370400440532013000', 'GB82WEST12345698765432', 'NL91ABNA0417164300'];
/** The business's own TEST wallet and someone else's, from public seeds: they hold nothing anywhere. */
const BUSINESS_WALLET = privateKeyToAccount(keccak256(toBytes(`TEST ${J} business wallet`)));
const OTHER_WALLET = privateKeyToAccount(keccak256(toBytes(`TEST ${J} someone else`)));
const CONTRACTOR_WALLET = privateKeyToAccount(keccak256(toBytes(`TEST ${J} contractor wallet`)));

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

/** The owner, the approver and a contractor, made once a run and kept in its run file. */
async function world(page) {
  const kept = run.read();
  if (kept.owner) return kept;
  const owner = await person(page, 'jb21o', { accountType: 'business' });
  const approver = await person(page, 'jb21a');
  const contractor = await person(page, 'jb21c');
  ok(await (await bank(owner)).mutate('testPartner.set', { custody: 'off' }));
  const ownerLedger = await (await ledgerApi(owner)).balances();
  return run.reset({ owner, approver, contractor, ownerLedger });
}

/** A business of the step's own: TEST 1000 USDT at the TEST partner, threshold 500, the approver on its team, its wallet connected. */
async function business(w, tag) {
  const own = await bank(w.owner);
  const accountId = randomUUID();
  const name = `TEST Payroll ${tag} ${RUN}`;
  ok(await own.mutate('business.create', { accountId, name, assetId: 'USDT', spendThreshold: THRESHOLD }));
  const funded = ok(await own.mutate('testPartner.fundBusiness', { accountId, fundId: `jb21-${accountId}`.slice(0, 64), amount: FUNDED }));
  expect(funded).toMatchObject({ label: PARTNER_BANK, assetId: 'USDT', balance: FUNDED });
  const invite = ok(
    await own.mutate('businessTeam.invite', { accountId, inviteId: randomUUID(), email: null, role: 'checker', roleId: null }),
  );
  ok(await (await bank(w.approver)).mutate('businessTeam.acceptInvite', { token: invite.token }));
  const offer = ok(await own.mutate('businessPayouts.walletOffer', { accountId, address: BUSINESS_WALLET.address }));
  const signature = await BUSINESS_WALLET.signMessage({ message: offer.message });
  ok(await own.mutate('businessPayouts.connectWallet', { offerId: offer.offerId, signature }));
  return { own, accountId, name };
}

/** The business's account at the partner, as the partner reports it. */
async function held(own, accountId) {
  return ok(await own.query('businessTeam.overview', { accountId })).partner.amount;
}

/**
 * `who` signed in, in Business mode on `name`, at the payouts room. The pick is saved on the account's view record a
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
    await page.goto('/bank/business/payouts');
    const shown = page.getByTestId('payouts-business');
    await expect(shown).toBeVisible();
    if ((await shown.textContent()) === name || attempt === 3) break;
  }
  await expect(page.getByTestId('payouts-business')).toHaveText(name);
}

async function ledgerUnchanged(w) {
  expect(await (await ledgerApi(w.owner)).balances()).toEqual(w.ownerLedger);
}

const csvFile = (rows) => ({
  name: 'payroll.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from(['name,iban,amount,currency,reference', ...rows].join('\n')),
});

async function importInApp(page, rows) {
  const form = page.getByRole('form', { name: 'Import file' });
  await form.getByLabel('Payments file (CSV)').setInputFiles(csvFile(rows));
  await form.getByRole('button', { name: 'Import file' }).click();
  await expect(page.getByTestId('payouts-notice')).toContainText('File imported');
  return page.getByTestId('bulk-run');
}

test(`${J} #1 imports a CSV with 3 good lines, one bad amount and one duplicate: a validation report listing exactly the two lines with codes; nothing is held`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const { own, accountId, name } = await business(w, 'import');
  await inBusiness(page, w.owner, name);

  const runView = await importInApp(page, [
    `TEST Ana,${IBANS[0]},100.00,USDT,Nov`,
    `TEST Ben,${IBANS[1]},150.50,USDT,Nov`,
    `TEST Cy,${IBANS[2]},49.50,USDT,Nov`,
    `TEST Dee,FR1420041010050500013M02606,12.3.4,USDT,Nov`,
    `TEST Ana,${IBANS[0]},100.00,USDT,Nov`,
  ]);
  await expect(runView).toHaveAttribute('data-status', 'draft');
  // Exactly the two lines, each with its code.
  const issues = page.getByTestId('bulk-issue');
  await expect(issues).toHaveCount(2);
  await expect(issues.nth(0)).toHaveAttribute('data-line', '4');
  await expect(issues.nth(0)).toHaveAttribute('data-code', 'amount_invalid');
  await expect(issues.nth(1)).toHaveAttribute('data-line', '5');
  await expect(issues.nth(1)).toHaveAttribute('data-code', 'duplicate_line');
  await expect(page.getByTestId('bulk-report')).toContainText('Nothing is held');
  await expect(page.getByTestId('bulk-line')).toHaveCount(3);

  // Nothing is held: the run is a draft with no partner instruction, and the partner's figure is unchanged.
  const runs = ok(await own.query('businessPayouts.runs', { accountId }));
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ status: 'draft', total: '300', partnerMoveId: null, sentAt: null });
  expect(runs[0].issues.map((i) => [i.line, i.code])).toEqual([
    [4, 'amount_invalid'],
    [5, 'duplicate_line'],
  ]);
  await expect(page.getByTestId('payouts-balance')).toHaveAttribute('data-amount', FUNDED);
  expect(await held(own, accountId)).toBe(FUNDED);
  await ledgerUnchanged(w);
});

test(`${J} #2 funds and confirms the batch: a funding step; at or above the threshold, approval is required; one instruction to the partner per run, sent once`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const { own, accountId, name } = await business(w, 'fund');
  await inBusiness(page, w.owner, name);

  // Under the threshold: the funding step, then one instruction, sent once.
  let runView = await importInApp(page, [`TEST Ana,${IBANS[0]},100,USDT,Nov`, `TEST Ben,${IBANS[1]},200,USDT,Nov`]);
  const funding = page.getByTestId('bulk-funding');
  await expect(funding).toBeVisible();
  await expect(funding.getByTestId('bulk-total')).toHaveAttribute('data-amount', '300');
  await expect(funding).toContainText(`Balance at ${PARTNER_BANK}: ${FUNDED} USDT`);
  await funding.getByRole('button', { name: 'Confirm and send' }).click();
  await expect(runView).toHaveAttribute('data-status', 'sent');
  await expect(page.getByTestId('bulk-status')).toHaveText(`Sent once to ${PARTNER_BANK}`);
  const small = ok(await own.query('businessPayouts.runs', { accountId }))[0];
  expect(small).toMatchObject({ status: 'sent', total: '300', approvalsNeeded: 0, threshold: THRESHOLD });
  expect(small.partnerKey).toBe(`bank.business.bulk-pay:${small.id}`);
  expect(small.partnerMoveId).toBeTruthy();
  expect(await held(own, accountId)).toBe('700');
  // Sent once: confirming again answers the same run and the same partner move, and nothing more moves.
  const again = ok(await own.mutate('businessPayouts.confirmRun', { runId: small.id }));
  expect(again).toMatchObject({ status: 'sent', partnerMoveId: small.partnerMoveId });
  expect(await held(own, accountId)).toBe('700');

  // A second run cannot reuse or blank the run key.
  expect(
    await own.mutate('businessPayouts.importRun', {
      accountId,
      runId: small.id,
      csv: `name,iban,amount,currency\nTEST Cy,${IBANS[2]},5,USDT`,
    }),
  ).toMatchObject({
    ok: false,
    code: 'bank.business_request_conflict',
  });
  expect(
    await own.mutate('businessPayouts.importRun', { accountId, runId: '', csv: `name,iban,amount,currency\nTEST Cy,${IBANS[2]},5,USDT` }),
  ).toMatchObject({
    ok: false,
    status: 400,
  });
  // A line in a different asset from the debit account is refused and sends nothing.
  const eur = ok(
    await own.mutate('businessPayouts.importRun', {
      accountId,
      runId: randomUUID(),
      csv: `name,iban,amount,currency\nTEST Cy,${IBANS[2]},5,EUR`,
    }),
  );
  expect(eur.issues.map((i) => i.code)).toEqual(['asset_mismatch']);
  expect(await own.mutate('businessPayouts.confirmRun', { runId: eur.id })).toMatchObject({ ok: false, code: 'bank.bulk_run_empty' });

  // At the threshold: approval is required before anything is sent.
  await page.reload();
  runView = await importInApp(page, [`TEST Ana,${IBANS[0]},300,USDT,Dec`, `TEST Ben,${IBANS[1]},200,USDT,Dec`]);
  await page.getByTestId('bulk-funding').getByRole('button', { name: 'Confirm and send' }).click();
  await expect(runView).toHaveAttribute('data-status', 'awaiting_approval');
  await expect(page.getByTestId('bulk-approval')).toContainText('another approver must approve it');
  await expect(page.getByRole('button', { name: 'Approve run' })).toHaveCount(0);
  const big = ok(await own.query('businessPayouts.runs', { accountId }))[0];
  expect(big).toMatchObject({ status: 'awaiting_approval', total: '500', approvalsNeeded: 1, partnerMoveId: null });
  expect(await own.mutate('businessPayouts.approveRun', { runId: big.id })).toMatchObject({
    ok: false,
    code: 'bank.business_self_approve',
  });
  expect(await held(own, accountId)).toBe('700');

  await inBusiness(page, w.approver, name);
  await expect(page.getByTestId('bulk-run')).toHaveAttribute('data-id', big.id);
  await page.getByRole('button', { name: 'Approve run' }).click();
  await expect(page.getByTestId('bulk-run')).toHaveAttribute('data-status', 'sent');
  const sent = ok(await own.query('businessPayouts.run', { runId: big.id }));
  expect(sent.partnerKey).toBe(`bank.business.bulk-pay:${big.id}`);
  expect(sent.approvals).toHaveLength(1);
  expect(await held(own, accountId)).toBe('200');
  await ledgerUnchanged(w);
});

test(`${J} #3 adds a contractor and stores an invoice of TEST 500.00: the contractor record with the invoice`, async ({ page }) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const { own, accountId, name } = await business(w, 'contractor');
  await inBusiness(page, w.owner, name);

  const add = page.getByRole('form', { name: 'Add contractor' });
  await add.getByLabel('Name').fill('TEST Dev Studio');
  await add.getByLabel('Payout IBAN').fill(IBANS[0]);
  await add.getByRole('button', { name: 'Add contractor' }).click();
  const row = page.getByTestId('contractor-row').filter({ hasText: 'TEST Dev Studio' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('IBAN …3000');

  const invoice = page.getByRole('form', { name: 'Store invoice TEST Dev Studio' });
  await invoice.getByLabel('Invoice number').fill('TEST-INV-21');
  await invoice.getByLabel('Amount').fill('500.00');
  await invoice.getByRole('button', { name: 'Store invoice' }).click();
  const stored = row.getByTestId('invoice-row');
  await expect(stored).toHaveCount(1);
  await expect(stored).toHaveAttribute('data-number', 'TEST-INV-21');
  await expect(stored).toHaveAttribute('data-amount', '500');
  await expect(stored).toHaveAttribute('data-status', 'open');

  const list = ok(await own.query('businessPayouts.contractors', { accountId }));
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ name: 'TEST Dev Studio', ibanLast4: '3000', onboarded: 'business' });
  expect(list[0].invoices).toEqual([expect.objectContaining({ number: 'TEST-INV-21', amount: '500', assetId: 'USDT', status: 'open' })]);
  expect(await held(own, accountId)).toBe(FUNDED);
  await ledgerUnchanged(w);
});

test(`${J} #4 pays the contractor batch: approval rules apply; the intent row is written first; paid through the partner's payout rail`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const { own, accountId, name } = await business(w, 'batch');
  // The business's approval rule (J-bank-19): a payment over 100 needs one approver.
  ok(
    await own.mutate('businessTeam.addRule', {
      accountId,
      ruleId: randomUUID(),
      overAmount: '100',
      payee: null,
      paymentType: null,
      approvals: 1,
    }),
  );
  const contractorId = randomUUID();
  ok(
    await own.mutate('businessPayouts.addContractor', {
      accountId,
      contractorId,
      name: 'TEST Dev Studio',
      email: null,
      iban: IBANS[1],
      walletAddress: null,
    }),
  );
  const c = ok(
    await own.mutate('businessPayouts.addInvoice', {
      contractorId,
      invoiceId: randomUUID(),
      number: 'TEST-INV-41',
      amount: '500.00',
      dueDate: null,
    }),
  );
  const invoiceId = c.invoices[0].id;

  await inBusiness(page, w.owner, name);
  const pay = page.getByRole('form', { name: 'Pay selected invoices' });
  await pay.getByLabel(/Pay invoice TEST-INV-41/).check();
  await pay.getByRole('button', { name: 'Pay selected invoices' }).click();
  const batchRow = page.getByTestId('batch-row');
  await expect(batchRow).toHaveCount(1);
  // The rule applies: the batch waits for an approver, and nothing has reached the partner.
  await expect(batchRow).toHaveAttribute('data-status', 'awaiting_approval');
  await expect(batchRow.getByTestId('batch-status')).toHaveText('Waiting for 1 approval(s) under your approval rules');
  // The intent row is written first: it is there, with its key, before any partner move.
  const intent = ok(await own.query('businessPayouts.batches', { accountId }))[0];
  expect(intent).toMatchObject({ status: 'awaiting_approval', total: '500', approvalsNeeded: 1, partnerMoveId: null, sentAt: null });
  expect(intent.partnerKey).toBe(`bank.business.contractor-batch:${intent.id}`);
  expect(intent.lines).toEqual([expect.objectContaining({ invoiceId, number: 'TEST-INV-41', amount: '500' })]);
  expect(await held(own, accountId)).toBe(FUNDED);
  expect(await own.mutate('businessPayouts.approveBatch', { batchId: intent.id })).toMatchObject({
    ok: false,
    code: 'bank.business_self_approve',
  });

  await inBusiness(page, w.approver, name);
  await page.getByTestId('batch-row').getByRole('button', { name: 'Approve batch' }).click();
  await expect(page.getByTestId('batch-row')).toHaveAttribute('data-status', 'sent');
  await expect(page.getByTestId('batch-status')).toHaveText(`Paid through ${PARTNER_BANK}’s payout rail`);
  const sent = ok(await own.query('businessPayouts.batches', { accountId }))[0];
  expect(sent).toMatchObject({ id: intent.id, status: 'sent', refusalCode: null });
  expect(sent.partnerMoveId).toBeTruthy();
  expect(sent.approvals).toHaveLength(1);
  expect(ok(await own.query('businessPayouts.contractors', { accountId }))[0].invoices[0].status).toBe('paid');
  expect(await held(own, accountId)).toBe('500');
  // Paid once: the same batch again is the same, and nothing more moves.
  expect(ok(await own.mutate('businessPayouts.payBatch', { accountId, batchId: intent.id, invoiceIds: [invoiceId] }))).toMatchObject({
    status: 'sent',
    partnerMoveId: sent.partnerMoveId,
  });
  expect(await held(own, accountId)).toBe('500');
  await ledgerUnchanged(w);
});

test(`${J} #5 sets up recurring crypto payroll with payslips and contractor self-onboarding: each run is signed by the business's own wallet; INTAFACED holds no vault`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const { own, accountId, name } = await business(w, 'crypto');
  await inBusiness(page, w.owner, name);
  await expect(page.getByTestId('payroll-wallet')).toHaveAttribute('data-address', BUSINESS_WALLET.address.toLowerCase());

  // Contractor self-onboarding: a one-use link the contractor opens and fills in with their own wallet.
  await page.getByRole('button', { name: 'Create onboarding link' }).click();
  const link = (await page.getByTestId('invite-link').textContent()).trim();
  expect(link).toContain('/bank/business/contractor-join?token=');
  await signOutBrowser(page.context());
  await signIn(page, w.contractor);
  await page.goto(new URL(link).pathname + new URL(link).search);
  await expect(page.getByTestId('contractor-join')).toContainText(`Add your details for ${name}`);
  const join = page.getByRole('form', { name: 'Add my details' });
  await join.getByLabel('Name').fill('TEST Remote Dev');
  await join.getByLabel('Wallet address for crypto payroll (optional)').fill(CONTRACTOR_WALLET.address);
  await join.getByRole('button', { name: 'Add my details' }).click();
  await expect(page.getByTestId('payouts-notice')).toHaveText(`You are now a contractor of ${name}.`);
  const people = ok(await own.query('businessPayouts.contractors', { accountId }));
  expect(people).toEqual([
    expect.objectContaining({ name: 'TEST Remote Dev', onboarded: 'self', walletAddress: CONTRACTOR_WALLET.address.toLowerCase() }),
  ]);

  // The schedule, then one month's run with its payslips.
  await inBusiness(page, w.owner, name);
  await expect(page.getByTestId('contractor-row').filter({ hasText: 'TEST Remote Dev' })).toContainText('added themselves');
  const setup = page.getByRole('form', { name: 'Set up payroll' });
  await setup.getByLabel('Payroll name').fill('TEST Monthly payroll');
  await setup.getByLabel('Day of the month (1 to 28)').fill('25');
  await setup.getByLabel('Amount for TEST Remote Dev').fill('250');
  await setup.getByRole('button', { name: 'Set up payroll' }).click();
  const payroll = page.getByTestId('payroll-row').filter({ hasText: 'TEST Monthly payroll' });
  await expect(payroll).toContainText('Monthly on day 25, in USDT');
  const prepare = page.getByRole('form', { name: 'Prepare run TEST Monthly payroll' });
  await prepare.getByLabel('Month (YYYY-MM)').fill('2026-12');
  await prepare.getByRole('button', { name: 'Prepare run' }).click();
  const runView = payroll.locator('[data-testid="payroll-run"][data-period="2026-12"]');
  await expect(runView).toHaveAttribute('data-status', 'awaiting_signature');
  await expect(runView.getByTestId('payslip-row')).toHaveCount(1);
  await expect(runView.getByTestId('payslip-row')).toHaveAttribute('data-amount', '250');
  await expect(runView.getByTestId('payslip-row')).toContainText(`TEST Remote Dev: 250 USDT to ${CONTRACTOR_WALLET.address.toLowerCase()}`);
  const message = (await runView.getByTestId('sign-message').textContent()) ?? '';
  expect(message).toContain(`From your wallet: ${BUSINESS_WALLET.address.toLowerCase()}`);

  // Signed by anyone but the business's own wallet: refused, and the run stays unsigned.
  const sign = page.getByRole('form', { name: 'Submit signature 2026-12' });
  await sign.getByLabel('Signature').fill(await OTHER_WALLET.signMessage({ message }));
  await sign.getByRole('button', { name: 'Submit signature' }).click();
  await expect(page.getByTestId('payouts-refusal')).toHaveAttribute('data-code', 'bank.payroll_signature_invalid');
  await expect(runView).toHaveAttribute('data-status', 'awaiting_signature');
  // Signed by the business's own wallet.
  await sign.getByLabel('Signature').fill(await BUSINESS_WALLET.signMessage({ message }));
  await sign.getByRole('button', { name: 'Submit signature' }).click();
  await expect(runView).toHaveAttribute('data-status', 'signed');
  await expect(runView.getByTestId('payroll-run-status')).toHaveText(
    `Signed by the business’s own wallet ${BUSINESS_WALLET.address.toLowerCase()}`,
  );
  await expect(runView.getByTestId('payroll-rail')).toContainText('INTAFACED holds no vault');

  const [p] = ok(await own.query('businessPayouts.payrolls', { accountId }));
  expect(p.runs).toHaveLength(1);
  expect(p.runs[0]).toMatchObject({
    period: '2026-12',
    status: 'signed',
    runKey: `bank.business.crypto-payroll:${p.id}:2026-12`,
    walletAddress: BUSINESS_WALLET.address.toLowerCase(),
    total: '250',
  });
  // INTAFACED holds no vault: nothing moved at the partner and nothing was posted.
  expect(await held(own, accountId)).toBe(FUNDED);
  await ledgerUnchanged(w);
});
