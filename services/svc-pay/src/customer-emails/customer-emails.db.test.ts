import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createCustomerEmailRouter } from './router.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_customer_email_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const nid = () => randomUUID();
const principalOf = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: nid(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
  ...over,
});
const ctxOf = (principal: Principal): Context => ({
  principal,
  service: null,
  region: 'DE',
  requestId: nid(),
  forwardedPrincipal: { raw: 'test-principal', signature: 'test-signature', region: 'DE' },
});

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    const err = error as { code?: string; message?: string; cause?: { code?: string; blockers?: Array<{ code: string }> } };
    return { code: err.code, message: err.message, cause: err.cause?.code, blockers: err.cause?.blockers, raw: JSON.stringify(error) };
  }
  throw new Error('expected a refusal');
}

describe('customer receipts and email settings (M-plat-org-10)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = nid();
  const other = nid();
  const viewer = nid();
  const developer = nid();
  const finance = nid();
  let merchant = '';
  let captured = '';
  let partial = '';
  let pending = '';
  let failed = '';
  const address = 'payer-receipt-secret@example.test';
  const wire = (amount: string) => formatAmount(parseAmount(amount));

  const api = () => createCustomerEmailRouter({ sql }).createCaller(ctxOf(principalOf(owner)));
  const as = (userId: string, over: Partial<Principal> = {}) =>
    createCustomerEmailRouter({ sql }).createCaller(ctxOf(principalOf(userId, over)));

  async function payment(status: string, amount: string, events: Array<{ event: string; amount: string }>) {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status)
      VALUES (${merchant}, ${amount}, 'USDT', 'crypto', 'crypto-native', ${'ref-' + nid()}, ${status}::pay.payment_status)
      RETURNING id`;
    const paymentId = rows[0]!.id;
    for (const event of events) {
      await sql`
        INSERT INTO pay.payment_events (payment_id, event, payload)
        VALUES (${paymentId}, ${event.event}, ${sql.json({ amount: event.amount })})`;
    }
    return paymentId;
  }

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    merchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${other})`;
    for (const [userId, role] of [
      [viewer, 'viewer'],
      [developer, 'developer'],
      [finance, 'finance'],
    ] as const) {
      await sql`
        INSERT INTO pay.merchant_team_members (merchant_id, user_id, role, status, invited_by, activated_at)
        VALUES (${merchant}, ${userId}, ${role}, 'active', ${owner}, now())`;
    }
    captured = await payment('captured', '4242.50', [
      { event: 'created', amount: '4242.50' },
      { event: 'captured', amount: '4242.50' },
    ]);
    partial = await payment('captured', '10', [
      { event: 'created', amount: '10' },
      { event: 'captured', amount: '10' },
      { event: 'refunded', amount: '4' },
    ]);
    pending = await payment('authorized', '8', [{ event: 'created', amount: '8' }]);
    failed = await payment('failed', '3', [{ event: 'created', amount: '3' }]);
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  it('leaves every switch unset until the merchant chooses, and an empty save is refused', async () => {
    const fresh = await api().merchant.customerEmails.get();
    expect(fresh).toEqual({
      receipts: null,
      refunds: null,
      invoices: null,
      updatedAt: null,
      automaticReceipts: 'stopped',
    });
    const empty = await refusal(() => api().merchant.customerEmails.set({}));
    expect(empty).toMatchObject({ code: 'BAD_REQUEST', cause: 'pay.customer_emails_empty' });
  });

  it('saves switches, keeps the same timestamp when nothing changed, and stops automatic receipts when off', async () => {
    const turnedOn = await api().merchant.customerEmails.set({ receipts: true, refunds: true });
    expect(turnedOn).toMatchObject({ receipts: true, refunds: true, invoices: null, automaticReceipts: 'not_connected' });
    expect(turnedOn.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const again = await api().merchant.customerEmails.set({ receipts: true });
    expect(again.updatedAt).toBe(turnedOn.updatedAt);
    expect(again.refunds).toBe(true);
    const stopped = await api().merchant.customerEmails.set({ receipts: false });
    expect(stopped.automaticReceipts).toBe('stopped');
    expect(stopped.updatedAt).not.toBe(turnedOn.updatedAt);
    expect(stopped.refunds).toBe(true);
  });

  it('lets finance change the switches and refuses a viewer or a developer', async () => {
    const saved = await as(finance).merchant.customerEmails.set({ invoices: true });
    expect(saved.invoices).toBe(true);
    const viewerSet = await refusal(() => as(viewer).merchant.customerEmails.set({ invoices: false }));
    const developerSet = await refusal(() => as(developer).merchant.customerEmails.set({ invoices: false }));
    expect(viewerSet).toMatchObject({ code: 'FORBIDDEN', cause: 'pay.team_role_forbidden' });
    expect(developerSet).toMatchObject({ code: 'FORBIDDEN', cause: 'pay.team_role_forbidden' });
    expect((await as(viewer).merchant.customerEmails.get()).invoices).toBe(true);
  });

  it('previews real amounts and does not offer a receipt for a failed or unpaid payment', async () => {
    const shown = await api().payments.receipt.preview({ paymentId: captured });
    expect(shown).toMatchObject({
      paymentId: captured,
      status: 'captured',
      currency: 'USDT',
      authorizedAmount: wire('4242.50'),
      capturedAmount: wire('4242.50'),
      refundedAmount: wire('0'),
      hasCapture: true,
      paymentReceipt: 'offered',
      refundReceipt: 'not_refunded',
      delivery: { status: 'not_connected', notConnected: 'vendor.email' },
    });
    const part = await api().payments.receipt.preview({ paymentId: partial });
    expect(part).toMatchObject({
      capturedAmount: wire('10'),
      refundedAmount: wire('4'),
      paymentReceipt: 'offered',
      refundReceipt: 'offered',
      hasCapture: true,
    });
    const waiting = await api().payments.receipt.preview({ paymentId: pending });
    expect(waiting).toMatchObject({ status: 'authorized', hasCapture: false, paymentReceipt: 'not_paid', refundReceipt: 'not_refunded' });
    expect(waiting.status).not.toBe('paid');
    const declined = await api().payments.receipt.preview({ paymentId: failed });
    expect(declined).toMatchObject({ status: 'failed', hasCapture: false, paymentReceipt: 'not_offered' });
  });

  it('refuses send without a provider, writes nothing, and does not store the address', async () => {
    const beforeEvents = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.payment_events`;
    const sent = await refusal(() => api().payments.receipt.send({ paymentId: captured, kind: 'payment', address }));
    const refundSent = await refusal(() => api().payments.receipt.send({ paymentId: partial, kind: 'refund', address }));
    const manualWhileOff = await refusal(() => api().payments.receipt.send({ paymentId: captured, kind: 'payment', address }));
    expect(sent).toMatchObject({ code: 'PRECONDITION_FAILED', message: 'vendor.email', cause: 'vendor.email' });
    expect(sent.blockers).toEqual([{ code: 'vendor.email' }]);
    expect(refundSent.message).toBe('vendor.email');
    expect(manualWhileOff.message).toBe('vendor.email');
    expect(sent.raw).not.toContain(address);
    expect(refundSent.raw).not.toContain(address);
    const afterEvents = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.payment_events`;
    expect(afterEvents[0]!.n).toBe(beforeEvents[0]!.n);
    const columns = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'pay' AND table_name = 'merchant_customer_email_settings'
       ORDER BY column_name`;
    expect(columns.map((column) => column.column_name)).toEqual([
      'created_at',
      'invoices',
      'merchant_id',
      'receipts',
      'refunds',
      'updated_at',
      'updated_by',
    ]);
    const stored = await sql<Array<{ blob: string }>>`
      SELECT coalesce(string_agg(receipts::text || refunds::text || invoices::text || updated_by, ' '), '') AS blob
        FROM pay.merchant_customer_email_settings`;
    expect(stored[0]!.blob).not.toContain(address);
    expect(stored[0]!.blob).not.toContain('@');
  });

  it('refuses a failed payment and a payment with no refund before the missing provider', async () => {
    const declined = await refusal(() => api().payments.receipt.send({ paymentId: failed, kind: 'payment', address }));
    const unpaid = await refusal(() => api().payments.receipt.send({ paymentId: pending, kind: 'payment', address }));
    const noRefund = await refusal(() => api().payments.receipt.send({ paymentId: captured, kind: 'refund', address }));
    expect(declined).toMatchObject({ code: 'PRECONDITION_FAILED', cause: 'pay.receipt_not_offered' });
    expect(unpaid).toMatchObject({ cause: 'pay.receipt_not_paid' });
    expect(noRefund).toMatchObject({ cause: 'pay.receipt_refund_absent' });
    expect(declined.raw).not.toContain(address);
    expect(unpaid.message).toBe('pay.receipt_not_paid');
    expect(unpaid.raw).not.toContain(address);
  });

  it("hides another merchant's payment the same way as a missing one", async () => {
    const foreign = await refusal(() => as(other).payments.receipt.preview({ paymentId: captured }));
    const missing = await refusal(() => as(other).payments.receipt.preview({ paymentId: nid() }));
    expect(foreign).toMatchObject({ code: 'NOT_FOUND', cause: 'pay.receipt_not_found' });
    expect(missing.code).toBe(foreign.code);
    expect(missing.message).toBe(foreign.message);
    expect(foreign.raw).not.toContain('4242');
    expect(missing.raw).not.toContain('4242');
  });

  it('refuses a viewer send and still lets a developer reach the missing provider', async () => {
    const denied = await refusal(() => as(viewer).payments.receipt.send({ paymentId: captured, kind: 'payment', address }));
    expect(denied).toMatchObject({ code: 'FORBIDDEN', cause: 'pay.team_role_forbidden' });
    const dev = await refusal(() =>
      as(developer, { kid: 'ifc_test' }).payments.receipt.send({ paymentId: captured, kind: 'payment', address }),
    );
    expect(dev).toMatchObject({ message: 'vendor.email', cause: 'vendor.email' });
    expect(dev.raw).not.toContain(address);
  });

  it('refuses a read-only session before it looks at the payment', async () => {
    const readOnly = await refusal(() =>
      as(owner, { scopes: ['pay:read'] }).payments.receipt.send({ paymentId: captured, kind: 'payment', address }),
    );
    expect(readOnly.code).toBe('FORBIDDEN');
    expect(readOnly.raw).not.toContain(address);
  });

  it('refuses when the database is not wired', async () => {
    const bare = createCustomerEmailRouter({}).createCaller(ctxOf(principalOf(owner)));
    const got = await refusal(() => bare.merchant.customerEmails.get());
    expect(got).toMatchObject({ code: 'SERVICE_UNAVAILABLE', cause: 'pay.merchant_ops_unavailable' });
  });
});
