import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { founderDisputeListSchema } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  MemoryLedger,
  formatAmount,
  insuranceFund,
  merchantProceeds,
  parseAmount as amt,
  railBoundary,
  userAvailable,
  type PostRequest,
} from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DISPUTE_FEE_NOTE } from './chargeback-ledger.js';
import { PostgresDisputeCaseStore } from './fraud/dispute-case-store.js';
import { memoryPayoutDestinations } from './merchant-payout-destination.js';
import { createFounderMerchantReads } from './namespaces/founder-merchant-reads.js';
import { PayError, PayService, type PaymentView } from './payment-service.js';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { RailRegistry } from './rails/registry.js';
import { signPayload } from './rails/webhook-signature.js';

/**
 * Lost, won, and shortfall outcomes against the real pay tables and MemoryLedger.
 * These fail on main: a lost dispute did not debit the merchant, a won dispute
 * did not restore it, and a short pot refused instead of posting the shortfall.
 */

const here = dirname(fileURLToPath(import.meta.url));
const migrations = [
  '0000_pay_init.sql',
  '0002_pay_payment_links.sql',
  '0003_pay_checkout_sessions.sql',
  '0005_pay_merchant_kyb.sql',
  '0006_pay_merchant_status_history.sql',
  '0014_pay_merchant_payout_destinations.sql',
  '0018_pay_founder_controls_admission.sql',
  '0050_pay_control_tiers.sql',
  '0051_pay_control_pricing.sql',
  '0071_pay_merchant_names.sql',
  '0082_pay_merchant_business_profile.sql',
  '0073_pay_settlement_read.sql',
  '0065_pay_merchant_dispute_responses.sql',
  '0083_pay_dispute_deadlines_evidence.sql',
].map((f) => readFileSync(join(here, '..', 'drizzle', f), 'utf8'));

const SECRET = 'svc-pay-test-secret-at-least-32-characters';
const MERCHANT_USER = '11111111-1111-4111-8111-111111111111';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    const parsed = new URL(envUrl);
    const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    // createTestDatabase refuses an admin connection whose database does not
    // end in _test. The shared lead Postgres (test-db.env) is named "test";
    // the same server already has intafaced_test, and the per-run database
    // is created from that admin connection.
    if (!name.endsWith('_test')) parsed.pathname = '/intafaced_test';
    return { url: parsed.toString(), stop: async () => undefined };
  }
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_chargeback_outcome_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('chargeback outcomes book the ledger', { timeout: 30_000 }, () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let pay: PayService;
  let store: PostgresDisputeCaseStore;

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
    store = new PostgresDisputeCaseStore(sql);
    const card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    pay = new PayService(sql, ledger, new RailRegistry([card]), {
      payoutDestinations: memoryPayoutDestinations(),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
      disputeCases: store,
    });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  function signed(payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return {
      headers: { 'x-sandbox-signature': signPayload(SECRET, timestamp, body), 'x-sandbox-timestamp': timestamp },
      body,
    };
  }

  async function proceedsOf(merchantId: string): Promise<string> {
    return formatAmount((await ledger.balance(merchantProceeds(merchantId, 'USDT'))).amount);
  }

  async function settled(amount = '100'): Promise<{ merchantId: string; payment: PaymentView }> {
    const merchant = await pay.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 0 } });
    const created = await pay.createPayment({
      merchantId: merchant.id,
      amount: amt(amount),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    const authorized = await pay.authorize(created.id);
    await pay.capture(authorized.id);
    await pay.settleWindow({
      merchantId: merchant.id,
      window: `w-${merchant.id.slice(0, 8)}`,
      assetId: 'USDT',
      from: new Date(Date.now() - 24 * 3600_000),
      to: new Date(Date.now() + 24 * 3600_000),
    });
    const payment = await pay.getPayment(authorized.id);
    if (!payment.railRef) throw new Error('settled card payment has no rail ref');
    return { merchantId: merchant.id, payment };
  }

  function deliver(payment: PaymentView, type: string, disputeId: string, id: string, amount = '40') {
    return pay.handleWebhook('card-sandbox', signed({ id, type, ref: payment.railRef, amount, assetId: 'USDT', disputeId }));
  }

  it('a lost dispute debits merchant proceeds by the disputed amount and conserves value', async () => {
    const { merchantId, payment } = await settled();
    expect(await proceedsOf(merchantId)).toBe('100');
    const beforeRail = (await ledger.balance(railBoundary('card-sandbox', 'USDT'))).amount;
    const disputeId = 'dp-lost-1';
    await deliver(payment, 'dispute.lost', disputeId, 'evt-lost-1', '40');
    expect(await proceedsOf(merchantId)).toBe('60');
    expect(formatAmount((await ledger.balance(userAvailable(MERCHANT_USER, 'USDT'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(railBoundary('card-sandbox', 'USDT'))).amount - beforeRail)).toBe('40');
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(1);
    expect(ledger.journal().some((tx) => tx.reason.includes('fee') && tx.reason.includes('chargeback'))).toBe(false);
    expect(ledger.reconcile()).toEqual({ ok: true });
    const row = await store.get(disputeId);
    expect(row?.status).toBe('lost');
    expect(row?.ledgerWire).toBe('posted');
    const page = founderDisputeListSchema.parse(await createFounderMerchantReads({ sql, pay, disputes: store }).disputeList({ limit: 10 }));
    const item = page.items.find((d) => d.disputeId === disputeId);
    expect(item?.ledgerWire).toBe('posted');
    expect(item?.ledgerRefuseCode).toBeNull();
    expect(item?.ledgerEffect).toMatchObject({
      feePosted: false,
      feeNote: DISPUTE_FEE_NOTE,
      shortfallTxId: null,
      wonTxId: null,
    });
    expect(item?.ledgerEffect?.openingTxId).toBeTruthy();
  });

  it('a won dispute restores the merchant proceeds the opening took', async () => {
    const { merchantId, payment } = await settled();
    const disputeId = 'dp-won-1';
    await deliver(payment, 'dispute.opened', disputeId, 'evt-open-won', '40');
    expect(await proceedsOf(merchantId)).toBe('60');
    await deliver(payment, 'dispute.won', disputeId, 'evt-won-1', '40');
    expect(await proceedsOf(merchantId)).toBe('100');
    expect((await store.get(disputeId))?.status).toBe('won');
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.won')).toHaveLength(1);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
    const page = founderDisputeListSchema.parse(await createFounderMerchantReads({ sql, pay, disputes: store }).disputeList({ limit: 10 }));
    expect(page.items.find((d) => d.disputeId === disputeId)?.ledgerEffect?.wonTxId).toBeTruthy();
  });

  it('a short merchant pot posts the house shortfall and a later win recovers it', async () => {
    const { merchantId, payment } = await settled();
    await ledger.post({
      idempotencyKey: `test.insurance:${payment.id}`,
      module: 'pay',
      reason: 'test.insurance.funded',
      entries: [
        { account: railBoundary('test-seed', 'USDT'), direction: 'credit', amount: amt('70') },
        { account: insuranceFund('USDT'), direction: 'debit', amount: amt('70') },
      ],
    });
    await ledger.post({
      idempotencyKey: `test.drain:${payment.id}`,
      module: 'pay',
      reason: 'test.proceeds.spent',
      entries: [
        { account: merchantProceeds(merchantId, 'USDT'), direction: 'credit', amount: amt('70') },
        { account: railBoundary('test-spend', 'USDT'), direction: 'debit', amount: amt('70') },
      ],
    });
    expect(await proceedsOf(merchantId)).toBe('30');
    const disputeId = 'dp-short-1';
    await deliver(payment, 'dispute.opened', disputeId, 'evt-short-open', '100');
    expect(await proceedsOf(merchantId)).toBe('0');
    expect(formatAmount((await ledger.balance(insuranceFund('USDT'))).amount)).toBe('0');
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.shortfall.covered')).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
    await deliver(payment, 'dispute.won', disputeId, 'evt-short-won', '100');
    expect(await proceedsOf(merchantId)).toBe('30');
    expect(formatAmount((await ledger.balance(insuranceFund('USDT'))).amount)).toBe('70');
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.shortfall.recovered')).toHaveLength(1);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.won')).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
    const page = founderDisputeListSchema.parse(await createFounderMerchantReads({ sql, pay, disputes: store }).disputeList({ limit: 10 }));
    const effect = page.items.find((d) => d.disputeId === disputeId)?.ledgerEffect;
    expect(effect?.feePosted).toBe(false);
    expect(effect?.shortfallTxId).toBeTruthy();
    expect(effect?.recoveredTxId).toBeTruthy();
    expect(effect?.wonTxId).toBeTruthy();
  });

  it('a repeated lost webhook posts the debit once', async () => {
    const { merchantId, payment } = await settled();
    const disputeId = 'dp-dup-1';
    const first = await deliver(payment, 'dispute.lost', disputeId, 'evt-dup-1', '40');
    const same = await deliver(payment, 'dispute.lost', disputeId, 'evt-dup-1', '40');
    const again = await deliver(payment, 'dispute.lost', disputeId, 'evt-dup-2', '40');
    expect(first.duplicate).toBe(false);
    expect(same.duplicate).toBe(true);
    expect(again.applied).toBe(true);
    expect(await proceedsOf(merchantId)).toBe('60');
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(1);
    expect((await store.get(disputeId))?.status).toBe('lost');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a ledger failure on won leaves the dispute open and the debit in place', async () => {
    const { merchantId, payment } = await settled();
    const disputeId = 'dp-fail-1';
    await deliver(payment, 'dispute.opened', disputeId, 'evt-fail-open', '40');
    expect(await proceedsOf(merchantId)).toBe('60');
    const realPost = ledger.post.bind(ledger);
    ledger.post = async (request: PostRequest) => {
      if (request.reason === 'pay.chargeback.won') throw new Error('ledger down');
      return realPost(request);
    };
    await expect(deliver(payment, 'dispute.won', disputeId, 'evt-fail-won', '40')).rejects.toBeInstanceOf(PayError);
    await expect(deliver(payment, 'dispute.won', disputeId, 'evt-fail-won', '40')).rejects.toMatchObject({
      code: 'pay.chargeback_ledger_failed',
    });
    expect((await store.get(disputeId))?.status).toBe('open');
    expect(await proceedsOf(merchantId)).toBe('60');
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.won')).toHaveLength(0);
    const markers = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM pay.payment_events
       WHERE payment_id = ${payment.id} AND event = 'webhook.dispute.won'`;
    expect(markers[0]?.n).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
