/**
 * BK-bill-01 hardening (Deep review 3 findings) through the router: the review asset is checked against the catalogue
 * and normalised so case cannot dodge the duplicate flag; an oversized upload is refused before it is decoded; the stored
 * type comes from the bytes, not the client. Uses TEST_DATABASE_URL; this file does not start Docker.
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
/** A real minimal PDF (signature, comment body, EOF); `text` keeps each file's bytes distinct. */
const b64 = (text: string) => Buffer.from(`%PDF-1.4\n%${text}\n%%EOF\n`).toString('base64');

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

describe('BK-bill-01 business bill hardening', () => {
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

  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x54, 0x45, 0x53, 0x54]);
  const PDF = Buffer.from('%PDF-1.4 TEST');

  it('usdt and USDT, 12.5 and 12.50 are one asset and amount: the duplicate flag still fires', async () => {
    const bank = services(TEST_LIMITS);
    const accountId = await openBusiness(bank);
    const admin = caller(bank, ADMIN);
    const a = await admin.business.bills.inbox.upload({ accountId, name: 'a.pdf', type: 'application/pdf', contentBase64: b64('TEST a') });
    const b = await admin.business.bills.inbox.upload({ accountId, name: 'b.pdf', type: 'application/pdf', contentBase64: b64('TEST b') });
    await admin.business.bills.review({ accountId, billId: a.id, ...review });
    const second = await admin.business.bills.review({
      accountId,
      billId: b.id,
      ...review,
      payee: 'TEST Other Payee',
      reference: 'INV-OTHER',
      amount: '12.50',
      assetId: ' usdt ',
    });
    expect(second.assetId).toBe('USDT');
    expect(second.possibleDuplicateOf).toEqual([a.id]);
  });

  it('an asset outside the catalogue refuses the review and changes nothing', async () => {
    const bank = services(TEST_LIMITS);
    const accountId = await openBusiness(bank);
    const admin = caller(bank, ADMIN);
    const a = await admin.business.bills.inbox.upload({ accountId, name: 'a.pdf', type: 'application/pdf', contentBase64: b64('TEST a') });
    await expect(admin.business.bills.review({ accountId, billId: a.id, ...review, assetId: 'NOPE' })).rejects.toMatchObject({
      cause: { code: 'bank.bill_input_invalid' },
    });
    expect(await sql`SELECT status, asset_id FROM bank.business_bills`).toEqual([{ status: 'unreviewed', asset_id: null }]);
  });

  it('an oversized upload is refused before its base64 is decoded', async () => {
    const bank = services(TEST_LIMITS);
    const accountId = await openBusiness(bank);
    const big = b64('T'.repeat(65));
    const from = vi.spyOn(Buffer, 'from');
    try {
      await expect(
        caller(bank, ADMIN).business.bills.inbox.upload({ accountId, name: 'big.pdf', type: 'application/pdf', contentBase64: big }),
      ).rejects.toMatchObject({ cause: { code: 'bank.bill_file_too_large' } });
      expect(from.mock.calls.some((c) => c[0] === big)).toBe(false);
    } finally {
      from.mockRestore();
    }
    expect(await sql`SELECT id FROM bank.business_bills`).toHaveLength(0);
  });

  it('the stored type comes from the bytes: a mismatch and active markup refuse; a signature sets the type', async () => {
    const bank = services(JSON.stringify({ allowedTypes: ['application/pdf', 'image/png', 'image/svg+xml', 'text/html'], maxBytes: 64 }));
    const accountId = await openBusiness(bank);
    const admin = caller(bank, ADMIN);
    const upload = (type: string, bytes: Buffer) =>
      admin.business.bills.inbox.upload({ accountId, name: 'f', type, contentBase64: bytes.toString('base64') });
    await expect(upload('application/pdf', PNG)).rejects.toMatchObject({ cause: { code: 'bank.bill_file_type' } });
    await expect(upload('image/svg+xml', Buffer.from('<svg onload="x"/>'))).rejects.toMatchObject({
      cause: { code: 'bank.bill_file_type' },
    });
    await expect(upload('application/pdf', Buffer.from('<html>TEST</html>'))).rejects.toMatchObject({
      cause: { code: 'bank.bill_file_type' },
    });
    await expect(upload('application/pdf', Buffer.from('TEST plain'))).rejects.toMatchObject({ cause: { code: 'bank.bill_file_type' } });
    await expect(upload('image/png', Buffer.from('TEST plain'))).rejects.toMatchObject({ cause: { code: 'bank.bill_file_type' } });
    await expect(upload('text/html', Buffer.from('TEST plain'))).rejects.toMatchObject({ cause: { code: 'bank.bill_file_type' } });
    expect(await sql`SELECT id FROM bank.business_bills`).toHaveLength(0);
    expect((await upload('image/png', PNG)).fileType).toBe('image/png');
    expect((await upload('Application/PDF', PDF)).fileType).toBe('application/pdf');
  });
});
