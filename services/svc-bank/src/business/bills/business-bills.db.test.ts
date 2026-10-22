/**
 * BK-bill-01 through the router: bill inbox upload, hand review, duplicate flags and the admin's "not a duplicate".
 * No ledger write anywhere in this slice. Uses TEST_DATABASE_URL; this file does not start Docker.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServices } from '../../bank-service.js';
import { memoryLedgerHistory } from '../../analytics/ledger-history.js';
import { createBankRouter } from '../../router.js';
import { sortInbox, type BillRecord } from './bill-intake.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '../../..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const ADMIN = '11111111-1111-4111-8111-111111111111';
const EDITOR = '22222222-2222-4222-8222-222222222222';
const VIEWER = '33333333-3333-4333-8333-333333333333';
const STRANGER = '44444444-4444-4444-8444-444444444444';
const SID = '77777777-7777-4777-8777-777777777777';

// TEST values only. The owner publishes the real limits; nothing here is a default.
const TEST_LIMITS = JSON.stringify({ allowedTypes: ['application/pdf', 'image/png'], maxBytes: 64 });
const b64 = (text: string) => Buffer.from(text).toString('base64');

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

function caller(bank: BankServices, userId: string) {
  const raw = encodePrincipal(principal(userId));
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank, {}).createCaller(
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

describe('BK-bill-01 business bill inbox', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;

  const services = (billUploadLimits: string | undefined) =>
    createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      billUploadLimits,
    });

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.business_bill_not_duplicates, bank.business_bills, bank.business_members, bank.business_accounts,
               bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
  });

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  async function openBusiness(bank: BankServices) {
    const account = await bank.business.createAccount({
      accountId: randomUUID(),
      name: 'TEST Bills Co',
      assetId: 'USDT',
      spendThreshold: parseAmount('1'),
      creatorUserId: ADMIN,
    });
    await bank.business.addMember({ accountId: account.id, actorUserId: ADMIN, userId: EDITOR, role: 'editor' });
    await bank.business.addMember({ accountId: account.id, actorUserId: ADMIN, userId: VIEWER, role: 'viewer' });
    return account.id;
  }

  const review = {
    payee: 'TEST Payee Ltd',
    reference: 'INV-TEST-1',
    amount: '12.5',
    assetId: 'USDT',
    dueDate: '2026-11-30',
  };

  it('refuses every upload while the owner has published no limits, and stores nothing', async () => {
    for (const blank of [undefined, '', '{"allowedTypes":[]}', 'not json']) {
      const bank = services(blank);
      const accountId = await openBusiness(bank);
      await expect(
        caller(bank, ADMIN).business.bills.inbox.upload({
          accountId,
          name: 'bill.pdf',
          type: 'application/pdf',
          contentBase64: b64('TEST a'),
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', cause: { code: 'bank.bill_upload_limit_unset' } });
      expect(await caller(bank, ADMIN).business.bills.inbox.limits()).toEqual({ state: 'unset', allowedTypes: [], maxBytes: null });
      await sql`TRUNCATE bank.business_members, bank.business_accounts, bank.spaces RESTART IDENTITY CASCADE`;
    }
    expect(await sql`SELECT id FROM bank.business_bills`).toHaveLength(0);
  });

  it('an uploaded bill lands unreviewed with every field blank; the same file again is the same bill', async () => {
    const bank = services(TEST_LIMITS);
    const accountId = await openBusiness(bank);
    const admin = caller(bank, ADMIN);
    const post = vi.spyOn(ledger, 'post');

    const first = await admin.business.bills.inbox.upload({
      accountId,
      name: 'bill.pdf',
      type: 'Application/PDF',
      contentBase64: b64('TEST a'),
    });
    expect(first).toMatchObject({
      accountId,
      source: 'upload',
      status: 'unreviewed',
      fileType: 'application/pdf',
      receivedBy: ADMIN,
      payee: null,
      reference: null,
      amount: null,
      assetId: null,
      dueDate: null,
      possibleDuplicateOf: [],
    });
    const again = await caller(bank, EDITOR).business.bills.inbox.upload({
      accountId,
      name: 'renamed.pdf',
      type: 'application/pdf',
      contentBase64: b64('TEST a'),
    });
    expect(again.id).toBe(first.id);
    expect(again.fileName).toBe('bill.pdf');
    expect(await sql`SELECT intake_key FROM bank.business_bills`).toEqual([
      { intake_key: expect.stringMatching(new RegExp(`^bill-in:${accountId}:[0-9a-f]{64}$`)) },
    ]);
    expect(await admin.business.bills.inbox.document({ accountId, billId: first.id })).toEqual({
      name: 'bill.pdf',
      type: 'application/pdf',
      contentBase64: b64('TEST a'),
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('refuses a type the owner did not publish, an oversize file and an unreadable file', async () => {
    const bank = services(TEST_LIMITS);
    const accountId = await openBusiness(bank);
    const admin = caller(bank, ADMIN);
    await expect(
      admin.business.bills.inbox.upload({ accountId, name: 'bill.jpg', type: 'image/jpeg', contentBase64: b64('TEST a') }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', cause: { code: 'bank.bill_file_type' } });
    await expect(
      admin.business.bills.inbox.upload({ accountId, name: 'bill.pdf', type: 'application/pdf', contentBase64: b64('T'.repeat(65)) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', cause: { code: 'bank.bill_file_too_large' } });
    await expect(
      admin.business.bills.inbox.upload({ accountId, name: 'bill.pdf', type: 'application/pdf', contentBase64: '!!!!' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', cause: { code: 'bank.bill_input_invalid' } });
    await expect(
      admin.business.bills.inbox.upload({ accountId, name: '   ', type: 'application/pdf', contentBase64: b64('TEST a') }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', cause: { code: 'bank.bill_input_invalid' } });
    expect(await sql`SELECT id FROM bank.business_bills`).toHaveLength(0);
    expect(await admin.business.bills.inbox.limits()).toEqual({
      state: 'published',
      allowedTypes: ['application/pdf', 'image/png'],
      maxBytes: 64,
    });
  });

  it('only members read and only proposers upload or review; a closed business takes no new bill', async () => {
    const bank = services(TEST_LIMITS);
    const accountId = await openBusiness(bank);
    const bill = await caller(bank, EDITOR).business.bills.inbox.upload({
      accountId,
      name: 'bill.pdf',
      type: 'application/pdf',
      contentBase64: b64('TEST a'),
    });
    await expect(
      caller(bank, VIEWER).business.bills.inbox.upload({ accountId, name: 'b.pdf', type: 'application/pdf', contentBase64: b64('TEST b') }),
    ).rejects.toMatchObject({ cause: { code: 'bank.business_role_forbidden' } });
    await expect(caller(bank, VIEWER).business.bills.review({ accountId, billId: bill.id, ...review })).rejects.toMatchObject({
      cause: { code: 'bank.business_role_forbidden' },
    });
    expect(await caller(bank, VIEWER).business.bills.inbox.list({ accountId, limit: 10 })).toHaveLength(1);
    await expect(caller(bank, STRANGER).business.bills.inbox.list({ accountId, limit: 10 })).rejects.toMatchObject({
      cause: { code: 'bank.business_not_member' },
    });
    await expect(caller(bank, STRANGER).business.bills.inbox.get({ accountId, billId: bill.id })).rejects.toMatchObject({
      cause: { code: 'bank.business_not_member' },
    });

    await sql`UPDATE bank.business_accounts SET status = 'closed' WHERE id = ${accountId}::uuid`;
    await expect(
      caller(bank, ADMIN).business.bills.inbox.upload({ accountId, name: 'c.pdf', type: 'application/pdf', contentBase64: b64('TEST c') }),
    ).rejects.toMatchObject({ cause: { code: 'bank.business_closed' } });
  });

  it("another business's bill is not found, even to an admin of a different business", async () => {
    const bank = services(TEST_LIMITS);
    const accountId = await openBusiness(bank);
    const otherId = await openBusiness(bank);
    const bill = await caller(bank, ADMIN).business.bills.inbox.upload({
      accountId,
      name: 'bill.pdf',
      type: 'application/pdf',
      contentBase64: b64('TEST a'),
    });
    await expect(caller(bank, ADMIN).business.bills.inbox.get({ accountId: otherId, billId: bill.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      cause: { code: 'bank.bill_not_found' },
    });
    await expect(caller(bank, ADMIN).business.bills.review({ accountId: otherId, billId: bill.id, ...review })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller(bank, ADMIN).business.bills.inbox.document({ accountId: otherId, billId: bill.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a second bill with the same payee and reference is flagged "may be a duplicate of" until an admin clears it', async () => {
    const bank = services(TEST_LIMITS);
    const accountId = await openBusiness(bank);
    const editor = caller(bank, EDITOR);
    const admin = caller(bank, ADMIN);
    const post = vi.spyOn(ledger, 'post');

    const first = await editor.business.bills.inbox.upload({
      accountId,
      name: 'a.pdf',
      type: 'application/pdf',
      contentBase64: b64('TEST a'),
    });
    await editor.business.bills.review({ accountId, billId: first.id, ...review });
    const second = await editor.business.bills.inbox.upload({ accountId, name: 'b.png', type: 'image/png', contentBase64: b64('TEST b') });
    expect(second.possibleDuplicateOf).toEqual([]);
    const reviewed = await editor.business.bills.review({
      accountId,
      billId: second.id,
      ...review,
      payee: '  test payee   LTD ',
      reference: 'inv-test-1',
      amount: '99',
      dueDate: '2026-12-31',
    });
    expect(reviewed).toMatchObject({ status: 'reviewed', payee: 'test payee   LTD', amount: '99', possibleDuplicateOf: [first.id] });
    expect((await admin.business.bills.inbox.get({ accountId, billId: first.id })).possibleDuplicateOf).toEqual([second.id]);

    // Only an admin may clear the flag.
    await expect(
      editor.business.bills.dedupe.markNotDuplicate({ accountId, billId: second.id, otherBillId: first.id }),
    ).rejects.toMatchObject({ cause: { code: 'bank.business_role_forbidden' } });
    await expect(
      admin.business.bills.dedupe.markNotDuplicate({ accountId, billId: second.id, otherBillId: second.id }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', cause: { code: 'bank.bill_input_invalid' } });
    const cleared = await admin.business.bills.dedupe.markNotDuplicate({ accountId, billId: second.id, otherBillId: first.id });
    expect(cleared.possibleDuplicateOf).toEqual([]);
    expect((await admin.business.bills.inbox.get({ accountId, billId: first.id })).possibleDuplicateOf).toEqual([]);
    // Repeating it is a no-op, and the pair is one row whichever side is named.
    await admin.business.bills.dedupe.markNotDuplicate({ accountId, billId: first.id, otherBillId: second.id });
    expect(await sql`SELECT bill_id FROM bank.business_bill_not_duplicates`).toHaveLength(1);
    expect(post).not.toHaveBeenCalled();
  });

  it('flags the same amount, asset and due date, but not a different asset or another business', async () => {
    const bank = services(TEST_LIMITS);
    const accountId = await openBusiness(bank);
    const otherId = await openBusiness(bank);
    const admin = caller(bank, ADMIN);
    const up = async (acct: string, text: string) =>
      (await admin.business.bills.inbox.upload({ accountId: acct, name: 'x.pdf', type: 'application/pdf', contentBase64: b64(text) })).id;

    const a = await up(accountId, 'TEST a');
    await admin.business.bills.review({ accountId, billId: a, ...review });
    const b = await up(accountId, 'TEST b');
    const sameMoney = await admin.business.bills.review({ accountId, billId: b, ...review, payee: 'TEST Other', reference: null });
    expect(sameMoney.possibleDuplicateOf).toEqual([a]);

    const c = await up(accountId, 'TEST c');
    const otherAsset = await admin.business.bills.review({
      accountId,
      billId: c,
      ...review,
      payee: 'TEST Third',
      reference: 'R3',
      assetId: 'USDC',
    });
    expect(otherAsset.possibleDuplicateOf).toEqual([]);

    const d = await up(otherId, 'TEST a');
    const elsewhere = await admin.business.bills.review({ accountId: otherId, billId: d, ...review });
    expect(elsewhere.possibleDuplicateOf).toEqual([]);
  });

  it('an edit after approval resets the approval; the same values again change nothing; a paid bill is not edited', async () => {
    const bank = services(TEST_LIMITS);
    const accountId = await openBusiness(bank);
    const admin = caller(bank, ADMIN);
    const bill = await admin.business.bills.inbox.upload({
      accountId,
      name: 'a.pdf',
      type: 'application/pdf',
      contentBase64: b64('TEST a'),
    });
    const first = await admin.business.bills.review({ accountId, billId: bill.id, ...review });

    // Approval is BK-bill-02; set the state directly to prove the reset.
    await sql`UPDATE bank.business_bills SET status = 'approved' WHERE id = ${bill.id}::uuid`;
    const same = await admin.business.bills.review({ accountId, billId: bill.id, ...review });
    expect(same).toMatchObject({ status: 'approved', reviewedAt: first.reviewedAt });
    const edited = await admin.business.bills.review({ accountId, billId: bill.id, ...review, amount: '12.51' });
    expect(edited).toMatchObject({ status: 'reviewed', amount: '12.51' });

    await sql`UPDATE bank.business_bills SET status = 'paid' WHERE id = ${bill.id}::uuid`;
    await expect(admin.business.bills.review({ accountId, billId: bill.id, ...review, amount: '1' })).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'bank.bill_already_paid' },
    });
  });

  it('refuses a review with a day that does not exist or a zero amount', async () => {
    const bank = services(TEST_LIMITS);
    const accountId = await openBusiness(bank);
    const admin = caller(bank, ADMIN);
    const bill = await admin.business.bills.inbox.upload({
      accountId,
      name: 'a.pdf',
      type: 'application/pdf',
      contentBase64: b64('TEST a'),
    });
    for (const bad of [{ dueDate: '2026-02-30' }, { amount: '0' }, { payee: '   ' }]) {
      await expect(admin.business.bills.review({ accountId, billId: bill.id, ...review, ...bad })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'bank.bill_input_invalid' },
      });
    }
    expect((await admin.business.bills.inbox.get({ accountId, billId: bill.id })).status).toBe('unreviewed');
  });

  it('lists the inbox by approval status then due date; the page size is required', async () => {
    const bank = services(TEST_LIMITS);
    const accountId = await openBusiness(bank);
    const admin = caller(bank, ADMIN);
    await expect(admin.business.bills.inbox.list({ accountId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'bank.business_bills_list_limit_unset' },
    });
    const ids: string[] = [];
    for (const [i, due] of ['2026-12-01', null, '2026-11-01', '2026-10-01'].entries()) {
      const bill = await admin.business.bills.inbox.upload({
        accountId,
        name: `${i}.pdf`,
        type: 'application/pdf',
        contentBase64: b64(`TEST ${i}`),
      });
      if (due)
        await admin.business.bills.review({ accountId, billId: bill.id, ...review, reference: `R${i}`, amount: `${i + 1}`, dueDate: due });
      ids.push(bill.id);
    }
    await sql`UPDATE bank.business_bills SET status = 'approved' WHERE id = ${ids[3]!}::uuid`;
    const page = await admin.business.bills.inbox.list({ accountId, limit: 10 });
    expect(page.map((b) => b.status)).toEqual(['unreviewed', 'reviewed', 'reviewed', 'approved']);
    const records: BillRecord[] = page.map((b) => ({
      id: b.id,
      businessId: b.accountId,
      status: b.status,
      payee: b.payee,
      reference: b.reference,
      amount: b.amount === null ? null : parseAmount(b.amount),
      assetId: b.assetId,
      dueDate: b.dueDate,
      notDuplicateOf: [],
      receivedAt: b.receivedAt,
    }));
    expect(sortInbox([...records].reverse()).map((r) => r.id)).toEqual(page.map((b) => b.id));
    expect(page.map((b) => b.id)).toEqual([ids[1], ids[2], ids[0], ids[3]]);
    expect(await admin.business.bills.inbox.list({ accountId, limit: 2 })).toHaveLength(2);
  });
});
