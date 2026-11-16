/**
 * J-bank-20 through the real router (BK-bill-01 to BK-bill-03): a business pays its suppliers' bills from its account at
 * the TEST partner bank. A bill uploaded twice is flagged and not paid until cleared; a pre-approved vendor's bill under
 * its cap goes straight to payment and one over it to approvers; blank Bill Pay limits refuse; a split must add up and is
 * our record beside the partner's one payment; a scheduled payment cancelled before send never reaches the partner; a
 * declined payment and a returned one put the bill back in the inbox with the partner's reason, and a return is credited
 * once. The ledger posts nothing. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { testPartner, type TestPartner } from '../partner/test-partner.js';
import { memoryBusinessDirectory, type DirectoryPerson } from './business-directory.js';
import { billPayKey, billReturnKey, readTestBill } from './business-bills.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const SID = '99999999-9999-4999-8999-999999999999';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = id(1);
const BOOK = id(2);
const OFFICE = id(3);
const A1 = id(4);
const A2 = id(5);
const ADVISOR = id(6);
const NEWCOMER = id(7);
const PEOPLE: DirectoryPerson[] = [
  [OWNER, 'owner'],
  [BOOK, 'book'],
  [OFFICE, 'office'],
  [A1, 'approver1'],
  [A2, 'approver2'],
  [ADVISOR, 'advisor'],
  [NEWCOMER, 'newcomer'],
].map(([userId, handle]) => ({ userId: userId!, handle: handle!, email: `${handle}@example.test`, status: 'active' as const }));

function principal(userId: string): Principal {
  return {
    sub: userId,
    userId,
    sid: SID,
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

const codeOf = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code;
async function refused(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return codeOf(err);
  }
  throw new Error('expected a refusal');
}

describe('business bill pay (J-bank-20)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let partner: TestPartner;
  let inviteMinutes: string | undefined;
  let postingFreeze: { postingEnabled: () => Promise<boolean> } | undefined;

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.business_bill_splits, bank.business_bill_payments, bank.business_bill_limits, bank.business_bill_vendors,
               bank.business_bill_approvals, bank.business_bills, bank.business_payment_approvals, bank.business_payments, bank.business_payment_rules, bank.business_invites,
               bank.business_advisors, bank.business_members, bank.business_custom_roles, bank.business_departments,
               bank.business_accounts, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    partner = testPartner();
    inviteMinutes = '2';
    postingFreeze = { postingEnabled: async () => true };
  });

  function as(userId: string) {
    const raw = encodePrincipal(principal(userId));
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
    return createBankRouter(services()).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  function services() {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      testPartner: partner,
      ...(postingFreeze ? { postingFreeze } : {}),
      directory: memoryBusinessDirectory(PEOPLE),
      get businessInviteMinutes() {
        return inviteMinutes;
      },
      billReader: 'test-lines',
    });
  }

  /** The owner's business with its money at the TEST partner: TEST 10000 USDT in the business's own partner account. */
  async function business() {
    const owner = as(OWNER);
    await owner.testPartner.set({ custody: 'off' });
    const accountId = randomUUID();
    await owner.business.create({ accountId, name: 'TEST Team Ltd', assetId: 'USDT', spendThreshold: '1' });
    await owner.testPartner.fundBusiness({ accountId, fundId: `fund-${accountId}`, amount: '10000' });
    return { accountId, owner };
  }

  async function join(accountId: string, owner: ReturnType<typeof as>, userId: string, invite: { role?: string; roleId?: string }) {
    const made = await owner.businessTeam.invite({
      accountId,
      inviteId: randomUUID(),
      email: null,
      role: (invite.role ?? null) as never,
      roleId: invite.roleId ?? null,
    });
    await as(userId).businessTeam.acceptInvite({ token: made.token! });
  }

  const BUSINESS = (accountId: string) => ({ userId: `business:${accountId}`, assetId: 'USDT', spaceId: null });
  const held = async (accountId: string) => (await partner.bank.balance(BUSINESS(accountId))).amount;
  const file = (vendor: string, reference: string, amount: string, due: string, note = '') =>
    Buffer.from(`TEST BILL\nVendor: ${vendor}\nReference: ${reference}\nAmount: ${amount}\nDue: ${due}\n${note}`).toString('base64');
  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  async function upload(owner: ReturnType<typeof as>, accountId: string, content: string, billId = randomUUID()) {
    return owner.businessBills.upload({ accountId, billId, fileName: 'bill.txt', contentType: 'text/plain', contentBase64: content });
  }

  async function ready(owner: ReturnType<typeof as>, accountId: string) {
    await join(accountId, owner, A1, { role: 'checker' });
    await owner.businessBills.setVendor({ accountId, name: 'TEST Paper Co', cap: '200' });
    await owner.businessBills.setLimits({ accountId, perPayment: '5000', daily: '8000', monthly: '9000' });
  }

  it('the TEST reader reads only labelled lines, and never guesses', () => {
    const read = readTestBill(Buffer.from('Vendor: TEST Paper Co\nReference: INV-1\nAmount: 150.00\nDue: 2026-12-01\n'));
    expect(read).toMatchObject({
      label: 'Preview · sample data',
      vendor: 'TEST Paper Co',
      reference: 'INV-1',
      amount: '150',
      dueDate: '2026-12-01',
    });
    expect(readTestBill(Buffer.from('Amount: lots\nDue: 2026-02-30'))).toMatchObject({ vendor: null, amount: null, dueDate: null });
  });

  it('#1 a bill uploaded twice: the second is flagged "may be a duplicate of" the first and cannot be paid until cleared', async () => {
    const { accountId, owner } = await business();
    await ready(owner, accountId);
    const content = file('TEST Paper Co', 'INV-1001', '150.00', '2026-12-01');
    const first = await upload(owner, accountId, content);
    expect(first).toMatchObject({
      status: 'inbox',
      vendor: 'TEST Paper Co',
      amount: '150',
      duplicateOf: null,
      extracted: { label: 'Preview · sample data' },
    });
    // The same upload sent again under its id is the same bill, never a second one.
    expect((await upload(owner, accountId, content, first.id)).id).toBe(first.id);
    const second = await upload(owner, accountId, content);
    expect(second.duplicateOf).toMatchObject({ id: first.id, reference: 'INV-1001' });
    expect(await refused(owner.businessBills.submit({ billId: second.id }))).toBe('bank.bill_duplicate_uncleared');
    // A different file with the same vendor and reference is flagged too.
    const rescan = await upload(owner, accountId, file('TEST Paper Co', 'INV-1001', '150.00', '2026-12-01', 'rescanned'));
    expect(rescan.duplicateOf?.id).toBe(first.id);
    // Only someone who manages the team clears it.
    await join(accountId, owner, BOOK, { role: 'maker' });
    expect(await refused(as(BOOK).businessBills.clearDuplicate({ billId: second.id }))).toBe('bank.business_role_forbidden');
    const cleared = await owner.businessBills.clearDuplicate({ billId: second.id });
    expect(cleared.duplicateCleared).toBe(true);
    expect((await owner.businessBills.submit({ billId: second.id })).status).toBe('approved');
    expect(ledger.journal()).toEqual([]);
  });

  it('#2 a pre-approved vendor at or under its cap goes straight to payment, over it to approvers; blank limits refuse', async () => {
    const { accountId, owner } = await business();
    await join(accountId, owner, A1, { role: 'checker' });
    await owner.businessBills.setVendor({ accountId, name: 'TEST Paper Co', cap: '200' });
    const small = await upload(owner, accountId, file('TEST Paper Co', 'INV-2001', '150.00', '2026-12-02'));
    expect(await owner.businessBills.submit({ billId: small.id })).toMatchObject({
      status: 'approved',
      preapproved: true,
      approvalsNeeded: 0,
    });
    // Limits blank: every payment refuses, and nothing reaches the partner.
    expect((await owner.businessBills.settings({ accountId })).limits).toEqual({ perPayment: null, daily: null, monthly: null });
    const paymentId = randomUUID();
    expect(await refused(owner.businessBills.pay({ billId: small.id, paymentId, scheduledFor: null, splits: [] }))).toBe(
      'bank.bill_limit_unset',
    );
    await owner.businessBills.setLimits({ accountId, perPayment: '5000', daily: null, monthly: '9000' });
    expect(await refused(owner.businessBills.pay({ billId: small.id, paymentId, scheduledFor: null, splits: [] }))).toBe(
      'bank.bill_limit_unset',
    );
    await owner.businessBills.setLimits({ accountId, perPayment: '100', daily: '8000', monthly: '9000' });
    expect(await refused(owner.businessBills.pay({ billId: small.id, paymentId, scheduledFor: null, splits: [] }))).toBe(
      'bank.bill_limit_exceeded',
    );
    expect(await held(accountId)).toBe(parseAmount('10000'));
    await owner.businessBills.setLimits({ accountId, perPayment: '5000', daily: '8000', monthly: '9000' });
    const paid = await owner.businessBills.pay({ billId: small.id, paymentId, scheduledFor: null, splits: [] });
    expect(paid).toMatchObject({ status: 'paid', payments: [{ status: 'sent', partnerKey: billPayKey(small.id, 1) }] });
    expect(await held(accountId)).toBe(parseAmount('9850'));
    const big = await upload(owner, accountId, file('TEST Paper Co', 'INV-2002', '250.00', '2026-12-03'));
    const waiting = await owner.businessBills.submit({ billId: big.id });
    expect(waiting).toMatchObject({ status: 'awaiting_approval', preapproved: false, approvalsNeeded: 1 });
    expect(await refused(owner.businessBills.pay({ billId: big.id, paymentId: randomUUID(), scheduledFor: null, splits: [] }))).toBe(
      'bank.bill_not_approved',
    );
    expect(await refused(owner.businessBills.approve({ billId: big.id }))).toBe('bank.business_self_approve');
    expect((await as(A1).businessBills.approve({ billId: big.id })).status).toBe('approved');
    expect(await refused(as(A1).businessBills.approve({ billId: big.id }))).toBe('bank.business_approval_inactive');
    expect(ledger.journal()).toEqual([]);
  });

  it('#3 a split is our record beside the partner’s one payment, and must add up to the bill', async () => {
    const { accountId, owner } = await business();
    await ready(owner, accountId);
    const bill = await upload(owner, accountId, file('TEST Paper Co', 'INV-3001', '100.00', '2026-12-04'));
    await owner.businessBills.submit({ billId: bill.id });
    const paymentId = randomUUID();
    const wrong = [
      { category: 'Office supplies', amount: '60.00' },
      { category: 'Printing', amount: '39.99' },
    ];
    expect(await refused(owner.businessBills.pay({ billId: bill.id, paymentId, scheduledFor: null, splits: wrong }))).toBe(
      'bank.split_total_mismatch',
    );
    const splits = [
      { category: 'Office supplies', amount: '60.00' },
      { category: 'Printing', amount: '40.00' },
    ];
    const paid = await owner.businessBills.pay({ billId: bill.id, paymentId, scheduledFor: null, splits });
    expect(paid.payments[0]).toMatchObject({
      status: 'sent',
      amount: '100',
      splits: [
        { category: 'Office supplies', amount: '60' },
        { category: 'Printing', amount: '40' },
      ],
    });
    const moves = await partner.bank.moves(`business:${accountId}`, { limit: 50 });
    expect(moves.filter((m) => m.key.startsWith('bank.business.bill-pay:'))).toHaveLength(1);
    expect(moves[0]).toMatchObject({ key: billPayKey(bill.id, 1), amount: parseAmount('100') });
    // The same payment id again moves nothing more.
    await owner.businessBills.pay({ billId: bill.id, paymentId, scheduledFor: null, splits });
    expect(await partner.bank.moves(`business:${accountId}`, { limit: 50 })).toHaveLength(1);
    expect(ledger.journal()).toEqual([]);
  });

  it('a lost partner answer is read back by its key and paid once', async () => {
    const { accountId, owner } = await business();
    await ready(owner, accountId);
    const bill = await upload(owner, accountId, file('TEST Paper Co', 'INV-3101', '50.00', '2026-12-04'));
    await owner.businessBills.submit({ billId: bill.id });
    const input = { billId: bill.id, paymentId: randomUUID(), scheduledFor: null, splits: [] };
    partner.set(`business:${accountId}`, { nextReply: 'lost' });
    expect(await refused(owner.businessBills.pay(input))).toBe('bank.partner_reply_lost');
    expect((await owner.businessBills.get({ billId: bill.id })).payments[0]!.status).toBe('sending');
    expect((await owner.businessBills.pay(input)).status).toBe('paid');
    expect(await partner.bank.moves(`business:${accountId}`, { limit: 50 })).toHaveLength(1);
    expect(await held(accountId)).toBe(parseAmount('9950'));
  });

  it('#4 a scheduled payment cancelled before send never reaches the partner, and the bill is approved again', async () => {
    const { accountId, owner } = await business();
    await ready(owner, accountId);
    const bill = await upload(owner, accountId, file('TEST Paper Co', 'INV-4001', '120.00', '2026-12-05'));
    await owner.businessBills.submit({ billId: bill.id });
    expect(
      await refused(
        owner.businessBills.pay({
          billId: bill.id,
          paymentId: randomUUID(),
          scheduledFor: new Date().toISOString().slice(0, 10),
          splits: [],
        }),
      ),
    ).toBe('bank.bill_schedule_invalid');
    const paymentId = randomUUID();
    const scheduled = await owner.businessBills.pay({ billId: bill.id, paymentId, scheduledFor: tomorrow(), splits: [] });
    expect(scheduled).toMatchObject({ status: 'scheduled', payments: [{ status: 'scheduled', scheduledFor: tomorrow() }] });
    const cancelled = await owner.businessBills.cancel({ paymentId });
    expect(cancelled).toMatchObject({ status: 'approved', payments: [{ status: 'cancelled' }] });
    expect((await owner.businessBills.cancel({ paymentId })).payments).toHaveLength(1);
    // The day comes: nothing is sent for it.
    await sql`UPDATE bank.business_bill_payments SET scheduled_for = current_date WHERE id = ${paymentId}::uuid`;
    expect(await services().businessBills.runDue({ limit: 10 })).toEqual({ sent: 0, declined: 0, unknown: 0 });
    expect(await partner.bank.moveByKey(billPayKey(bill.id, 1))).toBeNull();
    expect(await held(accountId)).toBe(parseAmount('10000'));
    // A scheduled one not cancelled is sent once on its day, and then cannot be cancelled.
    const again = randomUUID();
    await owner.businessBills.pay({ billId: bill.id, paymentId: again, scheduledFor: tomorrow(), splits: [] });
    await sql`UPDATE bank.business_bill_payments SET scheduled_for = current_date WHERE id = ${again}::uuid`;
    expect(await services().businessBills.runDue({ limit: 10 })).toEqual({ sent: 1, declined: 0, unknown: 0 });
    expect(await services().businessBills.runDue({ limit: 10 })).toEqual({ sent: 0, declined: 0, unknown: 0 });
    expect(await refused(owner.businessBills.cancel({ paymentId: again }))).toBe('bank.bill_payment_sent');
    expect(await held(accountId)).toBe(parseAmount('9880'));
    expect(ledger.journal()).toEqual([]);
  });

  it('#5 a declined payment and a returned one: the partner’s reason, the bill back in the inbox, a return credited once', async () => {
    const { accountId, owner } = await business();
    await ready(owner, accountId);
    // More than the partner holds: the partner declines, nothing moves.
    const big = await upload(owner, accountId, file('TEST Paper Co', 'INV-5001', '12000.00', '2026-12-06'));
    await owner.businessBills.setLimits({ accountId, perPayment: '20000', daily: '30000', monthly: '40000' });
    await owner.businessBills.submit({ billId: big.id });
    await as(A1).businessBills.approve({ billId: big.id });
    const declined = await owner.businessBills.pay({ billId: big.id, paymentId: randomUUID(), scheduledFor: null, splits: [] });
    expect(declined).toMatchObject({
      status: 'inbox',
      round: 2,
      approvals: [],
      back: { reason: 'bank.partner_insufficient_funds' },
      payments: [{ status: 'declined', partnerReason: 'bank.partner_insufficient_funds' }],
    });
    expect(declined.back!.text).toContain('The partner reports');
    expect(await held(accountId)).toBe(parseAmount('10000'));
    // Returned: paid once, then given back once as the partner reports it.
    const bill = await upload(owner, accountId, file('TEST Paper Co', 'INV-5002', '120.00', '2026-12-07'));
    await owner.businessBills.submit({ billId: bill.id });
    const paymentId = randomUUID();
    await owner.businessBills.pay({ billId: bill.id, paymentId, scheduledFor: null, splits: [] });
    expect(await held(accountId)).toBe(parseAmount('9880'));
    const back = await services().businessBills.returned({ paymentId, reason: 'account_closed' });
    expect(back).toMatchObject({
      status: 'inbox',
      back: { reason: 'returned:account_closed', text: 'The payee’s bank account is closed.' },
      payments: [{ status: 'returned', partnerReason: 'account_closed' }],
    });
    expect(await held(accountId)).toBe(parseAmount('10000'));
    await services().businessBills.returned({ paymentId, reason: 'account_closed' });
    expect(await held(accountId)).toBe(parseAmount('10000'));
    const moves = await partner.bank.moves(`business:${accountId}`, { limit: 50 });
    expect(moves.filter((m) => m.key === billReturnKey(paymentId))).toHaveLength(1);
    // Corrected and paid again: a new attempt under a new key.
    await owner.businessBills.submit({ billId: bill.id });
    const retry = await owner.businessBills.pay({ billId: bill.id, paymentId: randomUUID(), scheduledFor: null, splits: [] });
    expect(retry.payments.map((p) => [p.attempt, p.status, p.partnerKey])).toEqual([
      [1, 'returned', billPayKey(bill.id, 1)],
      [2, 'sent', billPayKey(bill.id, 2)],
    ]);
    expect(ledger.journal()).toEqual([]);
  });

  it('while posting is frozen nothing is paid', async () => {
    const { accountId, owner } = await business();
    await ready(owner, accountId);
    const bill = await upload(owner, accountId, file('TEST Paper Co', 'INV-6001', '10.00', '2026-12-08'));
    await owner.businessBills.submit({ billId: bill.id });
    postingFreeze = { postingEnabled: async () => false };
    // A caller made now reads the freeze (each caller builds its services when it is made).
    expect(await refused(as(OWNER).businessBills.pay({ billId: bill.id, paymentId: randomUUID(), scheduledFor: null, splits: [] }))).toBe(
      'bank.posting_frozen',
    );
    expect((await owner.businessBills.get({ billId: bill.id })).payments).toEqual([]);
    expect(await held(accountId)).toBe(parseAmount('10000'));
  });
});
