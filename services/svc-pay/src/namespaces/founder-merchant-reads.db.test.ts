import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Context } from '@intafaced/contracts';
import { MemoryLedger } from '@intafaced/ledger-client';
import { migrations, openAdmin, principal } from '../control/control.testkit.js';
import { MerchantControlError } from '../merchant-account-controls.js';
import { PostgresDisputeCaseStore } from '../fraud/dispute-case-store.js';
import { MerchantPayoutDestinationStore } from '../merchant-payout-destination.js';
import { createPayNamespaces } from './index.js';
import { PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';

const FOUNDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTSIDER = randomUUID();
const ADDRESS = `0x${'ab'.repeat(20)}`;

describe('founder merchant reads', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let merchantA = '';
  let merchantB = '';
  let paymentA = '';
  let paymentB = '';

  const authority = async (ctx: Context): Promise<string> => {
    const principal = ctx.principal;
    if (!principal || principal.userId !== FOUNDER || !principal.mfa || (principal as { kid?: string }).kid) {
      throw new MerchantControlError('operator.denied');
    }
    return principal.userId;
  };

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    const pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), {
      payoutDestinations: new MerchantPayoutDestinationStore(sql),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });
    merchantA = (await pay.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 }, status: 'active', kybStatus: 'approved' })).id;
    merchantB = (await pay.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 }, status: 'active', kybStatus: 'pending' })).id;
    await sql`UPDATE pay.merchants SET display_name = 'Alpha', legal_name = 'Alpha Ltd', created_at = now() - interval '2 minutes' WHERE id = ${merchantA}`;
    const inserted = await sql<Array<{ id: string; merchant_id: string }>>`
      INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status)
      VALUES (${merchantA}, 10, 'USDT', 'crypto', 'crypto-native', 'rail-a', 'captured'),
             (${merchantB}, 4, 'USDT', 'crypto', 'crypto-native', NULL, 'failed')
      RETURNING id, merchant_id`;
    paymentA = inserted.find((row) => row.merchant_id === merchantA)!.id;
    paymentB = inserted.find((row) => row.merchant_id === merchantB)!.id;
    await sql`
      INSERT INTO pay.payment_events (payment_id, event, payload)
      VALUES (${paymentA}, 'refunded', ${sql.json({ amount: '1.5', refundId: 'refund-a' })})`;
    await sql`
      INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status, payout_method, payout_ref)
      VALUES (${merchantA}, '2026-10-01', 'USDT', 10, 1, 9, 'pending', 'crypto', ${ADDRESS}),
             (${merchantB}, '2026-10-01', 'USDT', 4, 0, 4, 'failed', 'crypto', ${ADDRESS})`;
    await new MerchantPayoutDestinationStore(sql).persist({ merchantId: merchantA, railId: 'crypto-native', kind: 'crypto', ref: ADDRESS });
    await sql`
      INSERT INTO pay.merchant_webhook_endpoints (id, merchant_id, url, secret_hash, signing_secret)
      VALUES (${randomUUID()}, ${merchantA}, 'https://hooks.example.test/pay', ${'ab'.repeat(32)}, 'webhook-secret-not-for-the-wire')`;
    await sql`
      INSERT INTO pay.merchant_export_jobs (merchant_id, request_id, requested_by, kind, content)
      VALUES (${merchantA}, ${randomUUID()}, ${FOUNDER}, 'payments', 'SECRET-FILE-BYTES')`;
    await sql`
      INSERT INTO pay.dispute_cases (
        dispute_id, payment_id, merchant_id, amount, asset_id, status, opened_at, updated_at,
        payment_marked_disputed, ledger_wire
      ) VALUES
        ('dsp-a', ${paymentA}, ${merchantA}, '5', 'USDT', 'open', now(), now(), false, 'refused'),
        ('dsp-b', ${paymentB}, ${merchantB}, '4', 'USDT', 'open', now() - interval '1 hour', now(), false, 'refused')`;
    await sql`
      INSERT INTO pay.dispute_response_deadlines (merchant_id, dispute_id, response_due_at, rail_event_id)
      VALUES (${merchantA}, 'dsp-a', now() + interval '2 days', 'rail-a')`;
    await sql`
      INSERT INTO pay.metrics_merchant_day (merchant_id, day, asset_code, captured)
      VALUES (${merchantA}, '2026-10-01', 'USDT', 75), (${merchantB}, '2026-10-01', 'USDT', 25)`;
    const namespaces = createPayNamespaces({
      founderAuthority: authority as never,
      sql,
      pay,
      disputes: new PostgresDisputeCaseStore(sql),
    });
    caller = namespaces.createCaller(ctx(FOUNDER));
    merchantCaller = namespaces.createCaller(ctx(OUTSIDER));
  }, 120_000);

  let caller: ReturnType<ReturnType<typeof createPayNamespaces>['createCaller']>;
  let merchantCaller: ReturnType<ReturnType<typeof createPayNamespaces>['createCaller']>;

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  const ctx = (userId: string): Context => ({
    principal: principal(userId),
    service: null,
    region: 'DE',
    requestId: randomUUID(),
  });

  it('refuses a merchant session and an unknown merchant', async () => {
    await expect(
      merchantCaller.founderAdmin.merchants.section({ merchantId: merchantA, section: 'profile', limit: 10 }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller.founderAdmin.merchants.section({ merchantId: randomUUID(), section: 'payments', limit: 10 })).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
        message: 'pay.merchant_not_found',
      },
    );
  });

  it('pages one merchant’s payments and refunds and leaves the other merchant out', async () => {
    const payments = await caller.founderAdmin.merchants.section({ merchantId: merchantA, section: 'payments', limit: 10 });
    expect(payments).toMatchObject({
      section: 'payments',
      items: [expect.objectContaining({ id: paymentA, amount: '10', status: 'captured', assetId: 'USDT' })],
    });
    expect(JSON.stringify(payments)).not.toContain(paymentB);
    const refunds = await caller.founderAdmin.merchants.section({ merchantId: merchantA, section: 'refunds', limit: 1 });
    expect(refunds).toMatchObject({
      section: 'refunds',
      items: [expect.objectContaining({ paymentId: paymentA, amount: '1.5', outcome: 'refunded', refundId: 'refund-a' })],
    });
    await expect(caller.founderAdmin.merchants.section({ merchantId: merchantA, section: 'payments' })).rejects.toMatchObject({
      message: 'pay.payment_list_limit_unset',
    });
  });

  it('masks destinations and keeps webhook secrets and export bytes off the wire', async () => {
    const dest = await caller.founderAdmin.merchants.section({ merchantId: merchantA, section: 'destinations', limit: 10 });
    const masked = `${ADDRESS.slice(0, 6)}…${ADDRESS.slice(-4)}`;
    expect(dest).toMatchObject({ section: 'destinations', items: [expect.objectContaining({ destinationMasked: masked })] });
    expect(JSON.stringify(dest)).not.toContain(ADDRESS);
    const hooks = await caller.founderAdmin.merchants.section({ merchantId: merchantA, section: 'webhooks', limit: 10 });
    expect(JSON.stringify(hooks)).not.toContain('webhook-secret-not-for-the-wire');
    const jobs = await caller.founderAdmin.merchants.section({ merchantId: merchantA, section: 'exports', limit: 10 });
    expect(JSON.stringify(jobs)).not.toContain('SECRET-FILE-BYTES');
    const keys = await caller.founderAdmin.merchants.section({ merchantId: merchantA, section: 'apiKeys' });
    expect(keys).toEqual({ section: 'apiKeys', catalog: 'not_configured', items: [], nextCursor: null });
  });

  it('lists payouts by status and disputes by deadline across merchants', async () => {
    const pending = await caller.founderAdmin.payouts.list({ limit: 10, status: 'pending' });
    expect(pending.items.map((row) => row.merchantId)).toEqual([merchantA]);
    expect(JSON.stringify(pending)).not.toContain(ADDRESS);
    const failed = await caller.founderAdmin.payouts.list({ limit: 10, status: 'failed' });
    expect(failed.items.map((row) => row.merchantId)).toEqual([merchantB]);
    const due = await caller.founderAdmin.disputes.list({ limit: 10, deadline: 'set' });
    expect(due.items.map((row) => row.disputeId)).toEqual(['dsp-a']);
    const none = await caller.founderAdmin.disputes.list({ limit: 10, deadline: 'unset' });
    expect(none.items.map((row) => row.disputeId)).toEqual(['dsp-b']);
    await expect(
      caller.founderAdmin.disputes.list({ limit: 10, deadline: 'unset', dueAfter: '2026-10-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({
      message: 'pay.dispute_deadline_filter_invalid',
    });
  });

  it('counts the last day, ages the pending payout, and shares captured volume', async () => {
    const live = await caller.founderAdmin.live.summary({});
    expect(live.h1.payments.find((row) => row.status === 'captured')?.count).toBe(1);
    expect(live.h24.payments.find((row) => row.status === 'failed')?.count).toBe(1);
    expect(live.h1.refunds.find((row) => row.status === 'refunded')?.count).toBe(1);
    expect(live.queues.oldestPendingPayoutAt).not.toBeNull();
    expect(live.queues.oldestPendingPayoutAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(live.queues.earliestDisputeDeadlineAt).not.toBeNull();
    const risk = await caller.founderAdmin.risk.summary({ topN: 1 });
    expect(risk.window).toBeNull();
    expect(risk.concentration).toEqual([
      {
        assetCode: 'USDT',
        totalCaptured: '100',
        topShare: '0.75',
        merchants: [{ merchantId: merchantA, captured: '75', share: '0.75' }],
      },
    ]);
    expect(risk.failedWorkflows.paymentsFailed).toBe(1);
    expect(risk.failedWorkflows.payoutsFailed).toBe(1);
    await expect(caller.founderAdmin.risk.summary({} as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('lists recently created merchants with KYB and does not create one', async () => {
    const page = await caller.founderAdmin.merchants.recent({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.merchantId).toBe(merchantB);
    expect(page.items[0]?.kybStatus).toBe('pending');
    expect(page.nextCursor).toBeTruthy();
    const rest = await caller.founderAdmin.merchants.recent({ limit: 1, cursor: page.nextCursor! });
    expect(rest.items[0]).toMatchObject({ merchantId: merchantA, displayName: 'Alpha', legalName: 'Alpha Ltd', kybStatus: 'approved' });
    const profile = await caller.founderAdmin.merchants.section({ merchantId: merchantA, section: 'profile', limit: 10 });
    expect(profile).toMatchObject({
      section: 'profile',
      current: { kybStatus: 'approved', status: 'active', displayName: 'Alpha' },
    });
  });
});
