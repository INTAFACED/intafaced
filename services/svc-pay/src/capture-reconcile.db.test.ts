import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes, type PostRequest } from '@intafaced/ledger-client';
import { PayService, type PaymentView } from './payment-service.js';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { RailRegistry } from './rails/registry.js';
import { registerCaptureReconcileRoutes } from './capture-reconcile-routes.js';
import { migrations, openAdmin } from './control/control.testkit.js';

const SECRET = 'dev-only-svc-pay-control-test-secret-0123456789abcdef';

describe('authorized capture reconciler', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let ledger!: MemoryLedger;
  let posts: string[] = [];
  let capturedNotices: string[] = [];
  let pay!: PayService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants, pay.control_audit, pay.merchant_notifications, pay.merchant_notification_preferences RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    posts = [];
    capturedNotices = [];
    const book = ledger;
    const originalPost = book.post.bind(book);
    book.post = (request: PostRequest) => {
      posts.push(request.idempotencyKey);
      return originalPost(request);
    };
    pay = new PayService(sql, book, new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 })]), {
      afterPaymentEvent: (event) => {
        if (event.type === 'payment.captured') capturedNotices.push(event.payment.id);
      },
    });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function merchant() {
    return pay.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 } });
  }

  async function authorized(merchantId: string, amount: string): Promise<PaymentView> {
    const created = await pay.createPayment({
      requestId: randomUUID(),
      merchantId,
      amount: parseAmount(amount),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
    });
    const view = await pay.authorize(created.id);
    expect(view.status).toBe('authorized');
    expect(view.railRef).toBeTruthy();
    return view;
  }

  async function postCapture(view: PaymentView, amount = view.amount) {
    await ledger.post(
      recipes.paymentCapture({
        paymentId: view.id,
        merchantId: view.merchantId,
        assetId: view.assetId,
        amount,
        rail: view.railAdapter,
        railRef: view.railRef ?? '',
      }),
    );
  }

  async function statusOf(id: string) {
    const rows = await sql<Array<{ status: string }>>`SELECT status FROM pay.payments WHERE id = ${id}`;
    return rows[0]?.status;
  }

  async function capturedEvents(id: string) {
    return sql<Array<{ payload: Record<string, unknown> }>>`
      SELECT payload FROM pay.payment_events WHERE payment_id = ${id} AND event = 'captured'
    `;
  }

  async function audits(id: string) {
    return sql<Array<{ kind: string; outcome: string; actor_id: string; after: { ledgerTxId?: string; idempotencyKey?: string } }>>`
      SELECT kind, outcome, actor_id, after FROM pay.control_audit
       WHERE kind = 'payment.capture_reconciled' AND after->>'paymentId' = ${id}
    `;
  }

  it('moves a stuck authorized payment to captured without posting again', async () => {
    const m = await merchant();
    const live = await authorized(m.id, '10');
    const liveCapture = await pay.capture(live.id);
    expect(liveCapture.status).toBe('captured');
    const liveEvent = (await capturedEvents(live.id))[0]?.payload;
    expect(liveEvent).toMatchObject({ amount: expect.any(String), railRef: expect.any(String), ledgerTxId: expect.any(String) });

    const stuck = await authorized(m.id, '12');
    const postsBefore = posts.length;
    await postCapture(stuck);
    expect(await statusOf(stuck.id)).toBe('authorized');
    const booked = await ledger.getTxByKey(`payment.capture:${stuck.id}`);
    expect(booked).not.toBeNull();

    const noticesBefore = capturedNotices.length;
    const report = await pay.reconcileAuthorizedCaptures({ limit: 10 }, 'required');
    expect(report).toMatchObject({ examined: 1, reconciled: 1, leftAuthorized: 0, mismatched: 0 });
    expect(posts.length).toBe(postsBefore + 1);
    expect(await statusOf(stuck.id)).toBe('captured');
    const stuckEvents = await capturedEvents(stuck.id);
    expect(stuckEvents).toHaveLength(1);
    expect(Object.keys(stuckEvents[0]!.payload).sort()).toEqual(Object.keys(liveEvent!).sort());
    expect(stuckEvents[0]!.payload.ledgerTxId).toBe(booked!.id);
    expect(stuckEvents[0]!.payload.railRef).toBe(stuck.railRef);
    const audit = await audits(stuck.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      outcome: 'reconciled',
      actor_id: 'system:capture_reconcile',
      after: { ledgerTxId: booked!.id, idempotencyKey: `payment.capture:${stuck.id}` },
    });
    expect(capturedNotices.slice(noticesBefore)).toEqual([stuck.id]);
    expect(await ledger.getTxByKey(`payment.capture:${stuck.id}`)).toMatchObject({ id: booked!.id });
  });

  it('leaves an authorized payment alone when the ledger has no capture key', async () => {
    const m = await merchant();
    const pending = await authorized(m.id, '8');
    const postsBefore = posts.length;
    const report = await pay.reconcileAuthorizedCaptures({ limit: 10 }, 'required');
    expect(report).toMatchObject({ examined: 1, reconciled: 0, leftAuthorized: 1, mismatched: 0 });
    expect(await statusOf(pending.id)).toBe('authorized');
    expect(await capturedEvents(pending.id)).toHaveLength(0);
    expect(await audits(pending.id)).toHaveLength(0);
    expect(posts.length).toBe(postsBefore);
    expect(capturedNotices).not.toContain(pending.id);
  });

  it('two concurrent runners complete the stuck payment once', async () => {
    const m = await merchant();
    const stuck = await authorized(m.id, '15');
    await postCapture(stuck);
    const postsBefore = posts.length;
    const [first, second] = await Promise.all([
      pay.reconcileAuthorizedCaptures({ limit: 10 }, 'required'),
      pay.reconcileAuthorizedCaptures({ limit: 10 }, 'required'),
    ]);
    expect(first.reconciled + second.reconciled).toBe(1);
    expect(first.reconciled + second.alreadyCaptured + second.reconciled + first.alreadyCaptured).toBeGreaterThanOrEqual(1);
    expect(await statusOf(stuck.id)).toBe('captured');
    expect(await capturedEvents(stuck.id)).toHaveLength(1);
    expect(await audits(stuck.id)).toHaveLength(1);
    expect(posts.length).toBe(postsBefore);
    expect(capturedNotices.filter((id) => id === stuck.id)).toEqual([stuck.id]);
  });

  it('does not complete a capture whose booked amount disagrees with the authorization', async () => {
    const m = await merchant();
    const stuck = await authorized(m.id, '10');
    await postCapture(stuck, parseAmount('9'));
    const postsBefore = posts.length;
    const report = await pay.reconcileAuthorizedCaptures({ limit: 5 }, 'required');
    expect(report).toMatchObject({ examined: 1, reconciled: 0, mismatched: 1, leftAuthorized: 0 });
    expect(await statusOf(stuck.id)).toBe('authorized');
    expect(await capturedEvents(stuck.id)).toHaveLength(0);
    expect(await audits(stuck.id)).toHaveLength(0);
    expect(posts.length).toBe(postsBefore);
  });

  it('refuses while the flag is off and when the limit is blank', async () => {
    const m = await merchant();
    const stuck = await authorized(m.id, '10');
    await postCapture(stuck);
    await expect(pay.reconcileAuthorizedCaptures({ limit: 10 }, 'off')).rejects.toMatchObject({
      code: 'pay.capture_reconcile_disabled',
    });
    await expect(pay.reconcileAuthorizedCaptures({}, 'required')).rejects.toMatchObject({
      code: 'pay.capture_reconcile_batch_limit_unset',
    });
    expect(await statusOf(stuck.id)).toBe('authorized');
    expect(await capturedEvents(stuck.id)).toHaveLength(0);
  });

  it('a limit of 1 finishes one stuck payment and leaves the next', async () => {
    const m = await merchant();
    const first = await authorized(m.id, '4');
    const second = await authorized(m.id, '6');
    await postCapture(first);
    await postCapture(second);
    const report = await pay.reconcileAuthorizedCaptures({ limit: 1 }, 'required');
    expect(report).toMatchObject({ examined: 1, reconciled: 1 });
    const done = [await statusOf(first.id), await statusOf(second.id)].sort();
    expect(done).toEqual(['authorized', 'captured']);
  });

  it('the cron route reconciles a stuck payment for a credentialed caller', async () => {
    const m = await merchant();
    const stuck = await authorized(m.id, '7');
    await postCapture(stuck);
    const app = Fastify({ logger: false });
    registerCaptureReconcileRoutes(app, { internalSecret: SECRET, pay, mode: 'required' });
    await app.ready();
    const payload = JSON.stringify({ limit: 10 });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/reconcile-authorized-captures',
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-cron', SECRET, payload) },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reconciled: 1 });
    expect(await statusOf(stuck.id)).toBe('captured');
    await app.close();
  });
});
