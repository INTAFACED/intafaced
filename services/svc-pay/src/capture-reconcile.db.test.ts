import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes, type LedgerTx, type PostRequest } from '@intafaced/ledger-client';
import { PayService, type PaymentView } from './payment-service.js';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { RailRegistry } from './rails/registry.js';
import { composeGuards } from './seams/guards.js';
import {
  CAPTURE_RECONCILE_LOCK_A,
  CAPTURE_RECONCILE_LOCK_B,
  resetCaptureReconcileLoggerForTests,
  setCaptureReconcileLogger,
} from './capture-reconcile.js';
import { registerCaptureReconcileRoutes } from './capture-reconcile-routes.js';
import { ChangeService } from './control/changes.js';
import { createControlGuards } from './control/guards.js';
import { applyChange, migrations, openAdmin, TEST_GLOBAL_RULE, TEST_TIER } from './control/control.testkit.js';

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
    await sql`UPDATE pay.merchants SET status = 'suspended' WHERE id = ${m.id}`;
    const warnings: Array<Record<string, unknown>> = [];
    setCaptureReconcileLogger({
      warn: (fields) => {
        warnings.push(fields);
      },
    });
    try {
      const report = await pay.reconcileAuthorizedCaptures({ limit: 5 }, 'required');
      expect(report).toMatchObject({ examined: 1, reconciled: 0, mismatched: 1, leftAuthorized: 0, failed: 0 });
      expect(await statusOf(stuck.id)).toBe('authorized');
      expect(await capturedEvents(stuck.id)).toHaveLength(0);
      expect(await audits(stuck.id)).toHaveLength(0);
      const mismatch = await sql<Array<{ before: { status?: string }; kind: string }>>`
        SELECT kind, before FROM pay.control_audit
         WHERE kind = 'payment.capture_reconcile_mismatch' AND after->>'paymentId' = ${stuck.id}
      `;
      expect(mismatch).toEqual([{ kind: 'payment.capture_reconcile_mismatch', before: { status: 'suspended' } }]);
      expect(warnings).toEqual([
        expect.objectContaining({
          event: 'payment.capture_reconcile_mismatch',
          paymentId: stuck.id,
          merchantId: m.id,
          merchantStatus: 'suspended',
        }),
      ]);
      expect(posts.length).toBe(postsBefore);
    } finally {
      resetCaptureReconcileLoggerForTests();
    }
  });

  it('writes one mismatch audit per ledger transaction across repeated runs', async () => {
    const m = await merchant();
    const first = await authorized(m.id, '10');
    const second = await authorized(m.id, '11');
    await postCapture(first, parseAmount('9'));
    await postCapture(second, parseAmount('8'));
    const txFirst = await ledger.getTxByKey(`payment.capture:${first.id}`);
    const txSecond = await ledger.getTxByKey(`payment.capture:${second.id}`);
    const once = await pay.reconcileAuthorizedCaptures({ limit: 10 }, 'required');
    const twice = await pay.reconcileAuthorizedCaptures({ limit: 10 }, 'required');
    expect(once).toMatchObject({ examined: 2, mismatched: 2, reconciled: 0, failed: 0 });
    expect(twice).toMatchObject({ examined: 2, mismatched: 2, reconciled: 0, failed: 0 });
    expect(await statusOf(first.id)).toBe('authorized');
    expect(await statusOf(second.id)).toBe('authorized');
    const rows = await sql<Array<{ ledger: string }>>`
      SELECT after->>'ledgerTxId' AS ledger FROM pay.control_audit
       WHERE kind = 'payment.capture_reconcile_mismatch'
       ORDER BY after->>'ledgerTxId'
    `;
    expect(rows.map((row) => row.ledger).sort()).toEqual([txFirst!.id, txSecond!.id].sort());
  });

  it('leaves an authorized payment mismatched when its rail reference is blank', async () => {
    const m = await merchant();
    const stuck = await authorized(m.id, '10');
    await postCapture(stuck);
    await sql`UPDATE pay.payments SET rail_ref = '' WHERE id = ${stuck.id}`;
    const report = await pay.reconcileAuthorizedCaptures({ limit: 5 }, 'required');
    expect(report).toMatchObject({ examined: 1, reconciled: 0, mismatched: 1, failed: 0 });
    expect(await statusOf(stuck.id)).toBe('authorized');
    expect(await capturedEvents(stuck.id)).toHaveLength(0);
    const again = await pay.reconcileAuthorizedCaptures({ limit: 5 }, 'required');
    expect(again).toMatchObject({ mismatched: 1, reconciled: 0 });
    const rows = await sql`
      SELECT id FROM pay.control_audit
       WHERE kind = 'payment.capture_reconcile_mismatch' AND after->>'paymentId' = ${stuck.id}
    `;
    expect(rows).toHaveLength(1);
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

  it('reconciles a capture the HTTP client would return with an empty meta', async () => {
    const m = await merchant();
    const stuck = await authorized(m.id, '11');
    await postCapture(stuck);
    const original = ledger.getTxByKey.bind(ledger);
    const seen: unknown[] = [];
    ledger.getTxByKey = async (key) => {
      const tx = await original(key);
      if (!tx) return null;
      const httpShaped: LedgerTx = { ...tx, meta: {} };
      seen.push(httpShaped.meta);
      return httpShaped;
    };
    const report = await pay.reconcileAuthorizedCaptures({ limit: 5 }, 'required');
    expect(seen).toEqual([{}]);
    expect(report).toMatchObject({ examined: 1, reconciled: 1, mismatched: 0, failed: 0 });
    expect(await statusOf(stuck.id)).toBe('captured');
  });

  it('leaves the payment authorized when the empty-meta capture legs are reversed', async () => {
    const m = await merchant();
    const stuck = await authorized(m.id, '11');
    await postCapture(stuck);
    const original = ledger.getTxByKey.bind(ledger);
    ledger.getTxByKey = async (key) => {
      const tx = await original(key);
      if (!tx) return null;
      return {
        ...tx,
        meta: {},
        entries: tx.entries.map((entry) => ({
          ...entry,
          direction: entry.direction === 'credit' ? ('debit' as const) : ('credit' as const),
        })),
      };
    };
    const report = await pay.reconcileAuthorizedCaptures({ limit: 5 }, 'required');
    expect(report).toMatchObject({ examined: 1, reconciled: 0, mismatched: 1, failed: 0 });
    expect(await statusOf(stuck.id)).toBe('authorized');
    expect(await capturedEvents(stuck.id)).toHaveLength(0);
  });

  it('counts a ledger failure and still finishes the next payment', async () => {
    const m = await merchant();
    const bad = await authorized(m.id, '3');
    const good = await authorized(m.id, '4');
    await postCapture(good);
    const original = ledger.getTxByKey.bind(ledger);
    ledger.getTxByKey = async (key) => {
      if (key.endsWith(bad.id)) throw new Error('ledger unread');
      return original(key);
    };
    const report = await pay.reconcileAuthorizedCaptures({ limit: 10 }, 'required');
    expect(report).toMatchObject({ failed: 1, reconciled: 1, mismatched: 0 });
    expect(await statusOf(bad.id)).toBe('authorized');
    expect(await capturedEvents(bad.id)).toHaveLength(0);
    expect(await statusOf(good.id)).toBe('captured');
  });

  it('a cursor walks past a healthy head and a mismatch instead of rereading them', async () => {
    const m = await merchant();
    const healthy = await authorized(m.id, '5');
    const wrong = await authorized(m.id, '6');
    const stuck = await authorized(m.id, '7');
    await postCapture(wrong, parseAmount('1'));
    await postCapture(stuck);
    await sql`UPDATE pay.payments SET created_at = '2026-01-01T00:00:00Z' WHERE id = ${healthy.id}`;
    await sql`UPDATE pay.payments SET created_at = '2026-01-02T00:00:00Z' WHERE id = ${wrong.id}`;
    await sql`UPDATE pay.payments SET created_at = '2026-01-03T00:00:00Z' WHERE id = ${stuck.id}`;

    const first = await pay.reconcileAuthorizedCaptures({ limit: 1 }, 'required');
    expect(first).toMatchObject({ examined: 1, leftAuthorized: 1, nextCursor: { id: healthy.id } });
    const second = await pay.reconcileAuthorizedCaptures({ limit: 1, cursor: first.nextCursor! }, 'required');
    expect(second).toMatchObject({ examined: 1, mismatched: 1, nextCursor: { id: wrong.id } });
    const third = await pay.reconcileAuthorizedCaptures({ limit: 1, cursor: second.nextCursor! }, 'required');
    expect(third).toMatchObject({ examined: 1, reconciled: 1, nextCursor: { id: stuck.id } });
    const done = await pay.reconcileAuthorizedCaptures({ limit: 1, cursor: third.nextCursor! }, 'required');
    expect(done).toMatchObject({ examined: 0, nextCursor: null });
    expect(await statusOf(healthy.id)).toBe('authorized');
    expect(await statusOf(wrong.id)).toBe('authorized');
    expect(await statusOf(stuck.id)).toBe('captured');
  });

  it('returns busy and 409 when the try-lock is already held', async () => {
    const m = await merchant();
    const stuck = await authorized(m.id, '9');
    await postCapture(stuck);
    const holder = postgres(db.url, { max: 1, onnotice: () => undefined });
    await holder`SELECT pg_advisory_lock(${CAPTURE_RECONCILE_LOCK_A}, ${CAPTURE_RECONCILE_LOCK_B})`;
    const blocked = (label: string) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(label)), 3_000));
    try {
      const report = await Promise.race([
        pay.reconcileAuthorizedCaptures({ limit: 10 }, 'required'),
        blocked('reconcile blocked on the advisory lock'),
      ]);
      expect(report).toMatchObject({ busy: true, examined: 0, reconciled: 0, failed: 0 });
      expect(await statusOf(stuck.id)).toBe('authorized');

      const app = Fastify({ logger: false });
      registerCaptureReconcileRoutes(app, { internalSecret: SECRET, pay, mode: 'required' });
      await app.ready();
      const payload = JSON.stringify({ limit: 10 });
      const res = await Promise.race([
        app.inject({
          method: 'POST',
          url: '/internal/jobs/reconcile-authorized-captures',
          headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-cron', SECRET, payload) },
          payload,
        }),
        blocked('route blocked on the advisory lock'),
      ]);
      expect(res.statusCode).toBe(409);
      expect(res.json().busy).toBe(true);
      await app.close();
      expect(await statusOf(stuck.id)).toBe('authorized');
    } finally {
      await holder`SELECT pg_advisory_unlock(${CAPTURE_RECONCILE_LOCK_A}, ${CAPTURE_RECONCILE_LOCK_B})`;
      await holder.end();
    }
  }, 20_000);

  it('counts a reconciled capture in the ledger postedAt period, and a live capture in the guard clock', async () => {
    const runAt = new Date('2026-03-20T08:00:00.000Z');
    const postedAt = new Date('2026-01-15T22:00:00.000Z');
    const guarded = new PayService(sql, ledger, new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 })]), {
      guards: composeGuards(createControlGuards({ sql, mode: 'required', now: () => runAt })),
    });
    const changes = new ChangeService(sql);
    const m = await guarded.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 } });
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: TEST_TIER } });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId: m.id,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
    });
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
    });
    const live = await guarded.createPayment({
      requestId: randomUUID(),
      merchantId: m.id,
      amount: parseAmount('10'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
    });
    await guarded.authorize(live.id);
    expect((await guarded.capture(live.id)).status).toBe('captured');

    const stuck = await guarded.createPayment({
      requestId: randomUUID(),
      merchantId: m.id,
      amount: parseAmount('12'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
    });
    const authorizedStuck = await guarded.authorize(stuck.id);
    await postCapture(authorizedStuck);
    const original = ledger.getTxByKey.bind(ledger);
    ledger.getTxByKey = async (key) => {
      const tx = await original(key);
      if (!tx || !key.endsWith(stuck.id)) return tx;
      return { ...tx, postedAt };
    };
    const report = await guarded.reconcileAuthorizedCaptures({ limit: 5 }, 'required');
    expect(report).toMatchObject({ reconciled: 1, failed: 0 });
    expect(await statusOf(stuck.id)).toBe('captured');
    const usage = await sql<Array<{ cap_kind: string; period_key: string; used: string }>>`
      SELECT cap_kind, period_key, used::text AS used
        FROM pay.control_cap_usage
       WHERE merchant_id = ${m.id}
       ORDER BY cap_kind, period_key
    `;
    const shaped = usage.map((row) => ({ ...row, used: row.used }));
    expect(shaped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cap_kind: 'daily_intake', period_key: '2026-03-20' }),
        expect.objectContaining({ cap_kind: 'monthly_intake', period_key: '2026-03' }),
        expect.objectContaining({ cap_kind: 'daily_intake', period_key: '2026-01-15' }),
        expect.objectContaining({ cap_kind: 'monthly_intake', period_key: '2026-01' }),
      ]),
    );
    const byPeriod = Object.fromEntries(usage.map((row) => [`${row.cap_kind}:${row.period_key}`, parseAmount(row.used)]));
    expect(byPeriod['daily_intake:2026-03-20']).toBe(parseAmount('10'));
    expect(byPeriod['daily_intake:2026-01-15']).toBe(parseAmount('12'));
    expect(byPeriod['monthly_intake:2026-03']).toBe(parseAmount('10'));
    expect(byPeriod['monthly_intake:2026-01']).toBe(parseAmount('12'));
  });

  it('a failing over-cap notice does not undo a reconciled capture', async () => {
    const guarded = new PayService(sql, ledger, new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 })]), {
      guards: composeGuards(createControlGuards({ sql, mode: 'required' })),
    });
    const changes = new ChangeService(sql);
    const m = await guarded.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 } });
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: TEST_TIER } });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId: m.id,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
    });
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
    });
    const created = await guarded.createPayment({
      requestId: randomUUID(),
      merchantId: m.id,
      amount: parseAmount('100'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
    });
    const stuck = await guarded.authorize(created.id);
    await applyChange(changes, sql, {
      scope: 'tier',
      change: {
        kind: 'upsert_tier',
        tier: { ...TEST_TIER, caps: TEST_TIER.caps.map((cap) => (cap.kind === 'daily_intake' ? { ...cap, limit: '30' } : cap)) },
      },
    });
    await postCapture(stuck);
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION pay.test_reject_over_cap_notice() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'notice insert refused';
      END $$;
      CREATE TRIGGER test_reject_over_cap_notice
      BEFORE INSERT ON pay.merchant_notifications
      FOR EACH ROW EXECUTE FUNCTION pay.test_reject_over_cap_notice();
    `);
    try {
      const report = await guarded.reconcileAuthorizedCaptures({ limit: 5 }, 'required');
      expect(report).toMatchObject({ reconciled: 1, failed: 0 });
      expect(await statusOf(stuck.id)).toBe('captured');
      expect(await sql`SELECT 1 FROM pay.merchant_notifications WHERE merchant_id = ${m.id}`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM pay.control_audit WHERE merchant_id = ${m.id} AND kind = 'payment.captured_over_cap'`).toHaveLength(1);
    } finally {
      await sql`DROP TRIGGER IF EXISTS test_reject_over_cap_notice ON pay.merchant_notifications`;
      await sql`DROP FUNCTION IF EXISTS pay.test_reject_over_cap_notice()`;
    }
  });

  it('a live capture racing the reconciler finishes the payment once', async () => {
    const guarded = new PayService(sql, ledger, new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 })]), {
      guards: composeGuards(createControlGuards({ sql, mode: 'required' })),
    });
    const changes = new ChangeService(sql);
    const m = await guarded.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 } });
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: TEST_TIER } });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId: m.id,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
    });
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
    });
    const created = await guarded.createPayment({
      requestId: randomUUID(),
      merchantId: m.id,
      amount: parseAmount('15'),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
    });
    const stuck = await guarded.authorize(created.id);
    await postCapture(stuck);

    const pause = 86421357;
    const holder = postgres(db.url, { max: 1, onnotice: () => undefined });
    const pending: Array<Promise<unknown>> = [];
    const waitFor = async (label: string, ready: () => Promise<boolean>) => {
      for (let i = 0; i < 250; i += 1) {
        if (await ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(label);
    };
    try {
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION pay.test_pause_capture_status() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.status = 'authorized' AND NEW.status = 'captured' THEN
            PERFORM pg_advisory_lock(${pause});
            PERFORM pg_advisory_unlock(${pause});
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_pause_capture_status
        BEFORE UPDATE ON pay.payments
        FOR EACH ROW EXECUTE FUNCTION pay.test_pause_capture_status();
      `);
      await holder`SELECT pg_advisory_lock(${pause})`;
      const reconcilePromise = guarded.reconcileAuthorizedCaptures({ limit: 5 }, 'required');
      pending.push(reconcilePromise);
      await waitFor('reconcile did not reach the status update', async () => {
        const [row] = await sql<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
        return row!.n >= 1;
      });
      const capturePromise = guarded.capture(stuck.id);
      pending.push(capturePromise);
      await waitFor('capture did not wait on the payment row', async () => {
        const [row] = await sql<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype <> 'advisory'`;
        return row!.n >= 1;
      });
      await holder`SELECT pg_advisory_unlock(${pause})`;
      const [report, view] = await Promise.all([reconcilePromise, capturePromise]);
      pending.length = 0;
      expect(view.status).toBe('captured');
      expect(report.reconciled + report.alreadyCaptured).toBe(1);
      expect(report.failed).toBe(0);
      expect(await capturedEvents(stuck.id)).toHaveLength(1);
      expect(await audits(stuck.id)).toHaveLength(1);
      const [used] = await sql<Array<{ used: string }>>`
        SELECT used::text AS used FROM pay.control_cap_usage
         WHERE merchant_id = ${m.id} AND cap_kind = 'daily_intake'`;
      expect(parseAmount(used!.used)).toBe(parseAmount('15'));
    } finally {
      await holder`SELECT pg_advisory_unlock(${pause})`.catch(() => undefined);
      await Promise.allSettled(pending);
      await sql`DROP TRIGGER IF EXISTS test_pause_capture_status ON pay.payments`;
      await sql`DROP FUNCTION IF EXISTS pay.test_pause_capture_status()`;
      await holder.end();
    }
  }, 30_000);
});
