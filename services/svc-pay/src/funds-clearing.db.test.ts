import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  formatAmount,
  merchantClearing,
  merchantProceeds,
  parseAmount as amt,
  type PostRequest,
} from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresDisputeCaseStore } from './fraud/dispute-case-store.js';
import { memoryPayoutDestinations } from './merchant-payout-destination.js';
import { PayService, type PaymentView } from './payment-service.js';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { CardSandboxAdapter, SANDBOX_FUNDS_HELD_TOKEN } from './rails/card-sandbox.js';
import { RailRegistry } from './rails/registry.js';
import { signPayload } from './rails/webhook-signature.js';

/**
 * RC-merchant-10: funds move from clearing to available only once the rail says so.
 *
 * A TEST card payment the acquirer holds stays in clearing through a settlement run, a payout of that waiting window is
 * refused `pay.payout_clearing_pending` with nothing moved, and the rail's signed `funds.available` lets a re-run settle
 * it once, on the window's business key. Every figure here is TEST.
 */
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-pay-funds-clearing-secret-at-least-32';
const MERCHANT_USER = '11111111-1111-4111-8111-111111111111';
const FEE_BPS = 100;

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_funds_clearing_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('clearing to available (RC-merchant-10)', { timeout: 30_000 }, () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let pay: PayService;
  let posts: PostRequest[];

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
      `TRUNCATE pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    posts = [];
    const realPost = ledger.post.bind(ledger);
    ledger.post = async (request: PostRequest) => {
      posts.push(request);
      return realPost(request);
    };
    pay = new PayService(sql, ledger, new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 })]), {
      payoutDestinations: memoryPayoutDestinations(),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
      disputeCases: new PostgresDisputeCaseStore(sql),
    });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const wide = () => ({ from: new Date(Date.now() - 24 * 3600_000), to: new Date(Date.now() + 24 * 3600_000) });
  const settlementKey = (merchantId: string, window: string) => `settlement:${merchantId}:${window}:USDT`;
  const clearingOf = async (merchantId: string) => formatAmount((await ledger.balance(merchantClearing(merchantId, 'USDT'))).amount);
  const availableOf = async (merchantId: string) => formatAmount((await ledger.balance(merchantProceeds(merchantId, 'USDT'))).amount);
  const settlementPosts = () => posts.filter((p) => p.idempotencyKey.startsWith('settlement:'));

  function signed(payload: Record<string, unknown>, secret = SECRET) {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return { headers: { 'x-sandbox-signature': signPayload(secret, timestamp, body), 'x-sandbox-timestamp': timestamp }, body };
  }
  const release = (payment: PaymentView, id: string, secret?: string) =>
    pay.handleWebhook('card-sandbox', signed({ id, type: 'funds.available', ref: payment.railRef, assetId: 'USDT' }, secret));

  async function captured(merchantId: string, amount: string, token = SANDBOX_FUNDS_HELD_TOKEN): Promise<PaymentView> {
    const created = await pay.createPayment({
      merchantId,
      amount: amt(amount),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token },
    });
    await pay.authorize(created.id);
    await pay.capture(created.id);
    return pay.getPayment(created.id);
  }

  const merchant = () => pay.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: FEE_BPS } });

  it('leaves a held 100.00 payment in clearing when settlement runs, and names it', async () => {
    const m = await merchant();
    const payment = await captured(m.id, '100.00');
    expect(await clearingOf(m.id)).toBe('100');

    const run = await pay.settleWindow({ merchantId: m.id, window: 'held-1', assetId: 'USDT', ...wide() });

    expect(run.status).toBe('pending');
    expect(run.clearingPending).toEqual([{ paymentId: payment.id, amount: '100', assetId: 'USDT', availableOn: null }]);
    expect(settlementPosts()).toHaveLength(0);
    expect(await ledger.getTxByKey(settlementKey(m.id, 'held-1'))).toBeNull();
    expect(await clearingOf(m.id)).toBe('100');
    expect(await availableOf(m.id)).toBe('0');
    expect((await pay.getPayment(payment.id)).status).toBe('captured');
    expect(await pay.heldClearing(m.id, 'USDT')).toEqual(run.clearingPending);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses a payout of 100.00 that is only clearing, by name, and moves no ledger entry', async () => {
    const m = await merchant();
    await captured(m.id, '100.00');
    const run = await pay.settleWindow({ merchantId: m.id, window: 'held-2', assetId: 'USDT', ...wide() });
    const before = posts.length;

    for (let i = 0; i < 2; i++) {
      await expect(pay.payoutSettlement({ settlementId: run.id, railId: 'card-sandbox' })).rejects.toMatchObject({
        code: 'pay.payout_clearing_pending',
        message: expect.stringContaining('100 USDT'),
      });
    }

    expect(posts.length).toBe(before);
    const [admissions] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pay.payout_admissions`;
    expect(admissions?.n).toBe(0);
    expect((await pay.getSettlement(run.id)).status).toBe('pending');
    expect(await clearingOf(m.id)).toBe('100');
    expect(await availableOf(m.id)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('settles once the rail reports availability, keyed by merchant, window and asset, and never twice', async () => {
    const m = await merchant();
    const payment = await captured(m.id, '100.00');
    const waiting = await pay.settleWindow({ merchantId: m.id, window: 'held-3', assetId: 'USDT', ...wide() });
    expect(waiting.status).toBe('pending');

    const delivered = await release(payment, 'evt-funds-3');
    expect(delivered).toMatchObject({ applied: true, duplicate: false, paymentId: payment.id });
    expect(await release(payment, 'evt-funds-3')).toMatchObject({ duplicate: true, applied: false });
    expect(await pay.heldClearing(m.id, 'USDT')).toEqual([]);

    const posted = await pay.settleWindow({ merchantId: m.id, window: 'held-3', assetId: 'USDT', ...wide() });
    expect(posted.id).toBe(waiting.id);
    expect(posted.status).toBe('posted');
    expect(posted.clearingPending).toBeUndefined();
    expect(formatAmount(posted.gross)).toBe('100');
    const net = formatAmount(posted.net);
    expect(formatAmount(posted.fees)).toBe('1');

    const again = await pay.settleWindow({ merchantId: m.id, window: 'held-3', assetId: 'USDT', ...wide() });
    expect(again.status).toBe('posted');
    expect(settlementPosts().map((p) => p.idempotencyKey)).toEqual([settlementKey(m.id, 'held-3')]);
    expect(await ledger.getTxByKey(settlementKey(m.id, 'held-3'))).not.toBeNull();
    expect(await clearingOf(m.id)).toBe('0');
    expect(await availableOf(m.id)).toBe(net);
    expect((await pay.getPayment(payment.id)).status).toBe('settled');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('heals a crash between the freeze and the post on the same key', async () => {
    const m = await merchant();
    const payment = await captured(m.id, '100.00');
    const waiting = await pay.settleWindow({ merchantId: m.id, window: 'held-4', assetId: 'USDT', ...wide() });
    await release(payment, 'evt-funds-4');

    // The ledger books the window, then the process dies before svc-pay records it.
    const realPost = ledger.post;
    ledger.post = async (request: PostRequest) => {
      const tx = await realPost(request);
      if (request.idempotencyKey.startsWith('settlement:')) throw new Error('crash after the ledger post');
      return tx;
    };
    await expect(pay.settleWindow({ merchantId: m.id, window: 'held-4', assetId: 'USDT', ...wide() })).rejects.toThrow(
      'crash after the ledger post',
    );
    expect((await pay.getSettlement(waiting.id)).status).toBe('pending');
    ledger.post = realPost;

    const healed = await pay.settleWindow({ merchantId: m.id, window: 'held-4', assetId: 'USDT', ...wide() });
    expect(healed.status).toBe('posted');
    expect(new Set(settlementPosts().map((p) => p.idempotencyKey))).toEqual(new Set([settlementKey(m.id, 'held-4')]));
    expect(await availableOf(m.id)).toBe(formatAmount(healed.net));
    expect(await clearingOf(m.id)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('settles the available part of a window and leaves the held part for a later one', async () => {
    const m = await merchant();
    const ready = await captured(m.id, '30.00', 'tok_ok');
    const held = await captured(m.id, '100.00');

    const first = await pay.settleWindow({ merchantId: m.id, window: 'mixed-1', assetId: 'USDT', ...wide() });
    expect(first.status).toBe('posted');
    expect(formatAmount(first.gross)).toBe('30');
    expect(first.clearingPending).toEqual([{ paymentId: held.id, amount: '100', assetId: 'USDT', availableOn: null }]);
    expect((await pay.getPayment(ready.id)).status).toBe('settled');
    expect((await pay.getPayment(held.id)).status).toBe('captured');
    expect(await clearingOf(m.id)).toBe('100');

    await release(held, 'evt-funds-mixed');
    // Its capture window is closed; the rail's release makes it overdue for the next one.
    const later = await pay.settleWindow({
      merchantId: m.id,
      window: 'mixed-2',
      assetId: 'USDT',
      from: new Date(Date.now() + 24 * 3600_000),
      to: new Date(Date.now() + 48 * 3600_000),
    });
    expect(later.status).toBe('posted');
    expect(formatAmount(later.gross)).toBe('100');
    expect(await clearingOf(m.id)).toBe('0');
    expect(await availableOf(m.id)).toBe(formatAmount(first.net + later.net));
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('takes availability only from a signed rail delivery', async () => {
    const m = await merchant();
    const payment = await captured(m.id, '100.00');
    await expect(release(payment, 'evt-forged', 'not-the-rail-secret-but-at-least-32-chars')).rejects.toMatchObject({
      code: 'pay.webhook_invalid',
    });
    expect(await pay.heldClearing(m.id)).toHaveLength(1);

    const run = await pay.settleWindow({ merchantId: m.id, window: 'forged', assetId: 'USDT', ...wide() });
    expect(run.status).toBe('pending');
    expect(settlementPosts()).toHaveLength(0);
  });

  it('records a release day the rail names, and ignores availability for a payment it never held', async () => {
    const m = await merchant();
    const held = await captured(m.id, '100.00');
    const day = '2026-11-02T00:00:00.000Z';
    await pay.handleWebhook(
      'card-sandbox',
      signed({ id: 'evt-pending-day', type: 'funds.pending', ref: held.railRef, assetId: 'USDT', availableOn: day }),
    );
    expect(await pay.heldClearing(m.id, 'USDT')).toEqual([{ paymentId: held.id, amount: '100', assetId: 'USDT', availableOn: day }]);

    const ready = await captured(m.id, '30.00', 'tok_ok');
    expect(await release(ready, 'evt-not-held')).toMatchObject({ applied: false, duplicate: false });
    const run = await pay.settleWindow({ merchantId: m.id, window: 'never-held', assetId: 'USDT', ...wide() });
    expect(formatAmount(run.gross)).toBe('30');
  });

  it('keeps the book whole: clearing plus available plus fees equals what was captured, at every step', async () => {
    const m = await merchant();
    const a = await captured(m.id, '100.00');
    const b = await captured(m.id, '45.50', 'tok_ok');
    const captured_ = amt('145.50');
    const feesOf = async () => {
      const rows = await sql<
        Array<{ fees: string }>
      >`SELECT COALESCE(SUM(fees), 0)::text AS fees FROM pay.settlements WHERE status = 'posted'`;
      return amt(rows[0]!.fees);
    };
    const whole = async () => {
      const clearing = (await ledger.balance(merchantClearing(m.id, 'USDT'))).amount;
      const available = (await ledger.balance(merchantProceeds(m.id, 'USDT'))).amount;
      expect(clearing + available + (await feesOf())).toBe(captured_);
      expect(ledger.reconcile()).toEqual({ ok: true });
    };
    await whole();
    await pay.settleWindow({ merchantId: m.id, window: 'inv-1', assetId: 'USDT', ...wide() });
    await whole();
    await expect(pay.settleWindow({ merchantId: m.id, window: 'inv-2', assetId: 'USDT', ...wide() })).resolves.toMatchObject({
      status: 'pending',
    });
    const waiting = await pay.settleWindow({ merchantId: m.id, window: 'inv-2', assetId: 'USDT', ...wide() });
    await expect(pay.payoutSettlement({ settlementId: waiting.id, railId: 'card-sandbox' })).rejects.toMatchObject({
      code: 'pay.payout_clearing_pending',
    });
    await whole();
    await release(a, 'evt-inv');
    await pay.settleWindow({ merchantId: m.id, window: 'inv-2', assetId: 'USDT', ...wide() });
    await whole();
    expect((await pay.getPayment(b.id)).status).toBe('settled');
  });
});
