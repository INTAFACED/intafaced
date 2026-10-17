import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { founderDisputeListSchema } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  InsufficientFundsError,
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
import { listControlAudit } from './control/audit.js';
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
  '0009_pay_submerchant_tree.sql',
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
  let outcomePool: postgres.Sql | undefined;
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
    await outcomePool?.end({ timeout: 5 });
    await db?.drop();
    await adminStop();
  }, 30_000);

  function dedicatedOutcomePool(): postgres.Sql {
    if (!db) throw new Error('test database is not open');
    outcomePool ??= postgres(db.url, {
      max: 2,
      connection: { search_path: 'pay,public' },
      onnotice: () => undefined,
    });
    return outcomePool;
  }

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

  function deliver(payment: PaymentView, type: string, disputeId: string, id: string, amount?: string) {
    const payload: Record<string, unknown> = { id, type, ref: payment.railRef, assetId: 'USDT', disputeId };
    if (amount !== undefined) payload.amount = amount;
    return pay.handleWebhook('card-sandbox', signed(payload));
  }

  function debitTotal(book: MemoryLedger, reason: string): bigint {
    let sum = 0n;
    for (const tx of book.journal()) {
      if (tx.reason !== reason) continue;
      for (const entry of tx.entries) {
        if (entry.direction === 'debit') sum += entry.amount;
      }
    }
    return sum;
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

  it('an empty fund with short pots records a refused dispute and a later lost books once the fund can cover', async () => {
    const { merchantId, payment } = await settled();
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
    const disputeId = 'dp-unfunded-later';
    const opened = await deliver(payment, 'dispute.opened', disputeId, 'evt-unfunded-open', '100');
    expect(opened.applied).toBe(true);
    const refused = await store.get(disputeId);
    expect(refused?.status).toBe('open');
    expect(refused?.ledgerWire).toBe('refused');
    expect(refused?.ledgerRefuse?.code).toBe('pay.chargeback_shortfall_unfunded');
    expect((await pay.getPayment(payment.id)).status).toBe('disputed');
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(0);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.shortfall.covered')).toHaveLength(0);

    await ledger.post({
      idempotencyKey: `test.insurance:${payment.id}`,
      module: 'pay',
      reason: 'test.insurance.funded',
      entries: [
        { account: railBoundary('test-seed', 'USDT'), direction: 'credit', amount: amt('70') },
        { account: insuranceFund('USDT'), direction: 'debit', amount: amt('70') },
      ],
    });
    const lost = await deliver(payment, 'dispute.lost', disputeId, 'evt-unfunded-lost', '100');
    expect(lost.applied).toBe(true);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(1);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.shortfall.covered')).toHaveLength(1);
    expect((await store.get(disputeId))?.status).toBe('lost');
    expect(await proceedsOf(merchantId)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a ledger lookup failure on won leaves the dispute open and writes no marker', async () => {
    const { merchantId, payment } = await settled();
    const disputeId = 'dp-lookup-won';
    await deliver(payment, 'dispute.opened', disputeId, 'evt-lookup-open', '40');
    expect(await proceedsOf(merchantId)).toBe('60');
    const real = ledger.getTxByKey.bind(ledger);
    ledger.getTxByKey = async (key: string) => {
      if (key.startsWith('pay.chargeback.')) throw new Error('ledger lookup down');
      return real(key);
    };
    await expect(deliver(payment, 'dispute.won', disputeId, 'evt-lookup-won', '40')).rejects.toMatchObject({
      code: 'pay.chargeback_ledger_failed',
    });
    expect((await store.get(disputeId))?.status).toBe('open');
    const markers = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM pay.payment_events
       WHERE payment_id = ${payment.id} AND event = 'webhook.dispute.won'`;
    expect(markers[0]?.n).toBe('0');
    ledger.getTxByKey = real;
    await deliver(payment, 'dispute.won', disputeId, 'evt-lookup-won', '40');
    expect(await proceedsOf(merchantId)).toBe('100');
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.won')).toHaveLength(1);
    expect((await store.get(disputeId))?.status).toBe('won');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a won amount below the opening posts nothing and leaves the case open', async () => {
    const { merchantId, payment } = await settled();
    const disputeId = 'dp-won-partial';
    await deliver(payment, 'dispute.opened', disputeId, 'evt-open-partial', '40');
    expect(await proceedsOf(merchantId)).toBe('60');
    const outcome = await deliver(payment, 'dispute.won', disputeId, 'evt-won-25', '25');
    expect(outcome.applied).toBe(true);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.won')).toHaveLength(0);
    expect(await proceedsOf(merchantId)).toBe('60');
    expect((await store.get(disputeId))?.status).toBe('open');
    const audit = await listControlAudit(sql, { limit: 10, merchantId, kind: 'pay.dispute_outcome_conflict' });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.after).toMatchObject({ disputeId, outcome: 'won' });
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('concurrent won and lost leave the case and the journal in agreement', async () => {
    const { merchantId, payment } = await settled();
    const disputeId = 'dp-race-outcome';
    await deliver(payment, 'dispute.opened', disputeId, 'evt-race-open', '40');
    const results = await Promise.allSettled([
      deliver(payment, 'dispute.won', disputeId, 'evt-race-won', '40'),
      deliver(payment, 'dispute.lost', disputeId, 'evt-race-lost', '40'),
    ]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const row = await store.get(disputeId);
    const wonTxs = ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.won');
    if (row?.status === 'won') {
      expect(wonTxs).toHaveLength(1);
      expect(await proceedsOf(merchantId)).toBe('100');
    } else {
      expect(row?.status).toBe('lost');
      expect(wonTxs).toHaveLength(0);
      expect(await proceedsOf(merchantId)).toBe('60');
    }
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a won delivery before the open does not debit the merchant', async () => {
    const { merchantId, payment } = await settled();
    const disputeId = 'dp-won-before-open';
    await deliver(payment, 'dispute.won', disputeId, 'evt-won-first', '40');
    expect((await store.get(disputeId))?.status).toBe('won');
    expect(await proceedsOf(merchantId)).toBe('100');
    await deliver(payment, 'dispute.opened', disputeId, 'evt-open-late', '40');
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(0);
    expect(await proceedsOf(merchantId)).toBe('100');
    expect((await store.get(disputeId))?.status).toBe('won');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a lost amount that differs from the opening records the conflict and does not post again', async () => {
    const { merchantId, payment } = await settled();
    const disputeId = 'dp-lost-conflict';
    await deliver(payment, 'dispute.opened', disputeId, 'evt-lost-open-40', '40');
    expect(await proceedsOf(merchantId)).toBe('60');
    const lost = await deliver(payment, 'dispute.lost', disputeId, 'evt-lost-30', '30');
    expect(lost.applied).toBe(true);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(1);
    expect(await proceedsOf(merchantId)).toBe('60');
    expect((await store.get(disputeId))?.status).toBe('open');
    const audit = await listControlAudit(sql, { limit: 10, merchantId, kind: 'pay.dispute_outcome_conflict' });
    expect(audit.entries).toHaveLength(1);
    const again = await deliver(payment, 'dispute.lost', disputeId, 'evt-lost-30-again', '30');
    expect(again.applied).toBe(true);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(1);
    expect((await store.get(disputeId))?.status).toBe('open');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  async function settleOn(service: PayService, amount = '100'): Promise<{ merchantId: string; payment: PaymentView }> {
    const merchant = await service.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 0 } });
    const created = await service.createPayment({
      merchantId: merchant.id,
      amount: amt(amount),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    const authorized = await service.authorize(created.id);
    await service.capture(authorized.id);
    await service.settleWindow({
      merchantId: merchant.id,
      window: `w-${merchant.id.slice(0, 8)}`,
      assetId: 'USDT',
      from: new Date(Date.now() - 24 * 3600_000),
      to: new Date(Date.now() + 24 * 3600_000),
    });
    const payment = await service.getPayment(authorized.id);
    if (!payment.railRef) throw new Error('settled card payment has no rail ref');
    return { merchantId: merchant.id, payment };
  }

  function send(service: PayService, payment: PaymentView, type: string, disputeId: string, id: string, amount?: string) {
    const payload: Record<string, unknown> = { id, type, ref: payment.railRef, assetId: 'USDT', disputeId };
    if (amount !== undefined) payload.amount = amount;
    return service.handleWebhook('card-sandbox', signed(payload));
  }

  function slottedPay(pool: postgres.Sql, book: MemoryLedger) {
    const cases = new PostgresDisputeCaseStore(pool);
    const card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    const service = new PayService(pool, book, new RailRegistry([card]), {
      payoutDestinations: memoryPayoutDestinations(),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
      disputeCases: cases,
      chargebackOutcomeSlots: 1,
    });
    return { cases, service };
  }

  it('three disputes can be won together on a two-connection pool', async () => {
    const pool = dedicatedOutcomePool();
    const book = new MemoryLedger();
    const { service } = slottedPay(pool, book);
    const { payment } = await settleOn(service);
    const ids = ['dp-slot-a', 'dp-slot-b', 'dp-slot-c'];
    for (const [index, disputeId] of ids.entries()) {
      await send(service, payment, 'dispute.opened', disputeId, `evt-slot-open-${index}`, '30');
    }
    const results = await Promise.allSettled(
      ids.map((disputeId, index) => send(service, payment, 'dispute.won', disputeId, `evt-slot-won-${index}`, '30')),
    );
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const won = book.journal().filter((tx) => tx.reason === 'pay.chargeback.won');
    expect(won.map((tx) => tx.idempotencyKey).sort()).toEqual(ids.map((id) => `pay.chargeback.won:${id}`).sort());
    expect(book.reconcile()).toEqual({ ok: true });
  }, 15_000);

  it('three won deliveries of one dispute settle on a two-connection pool', async () => {
    const pool = dedicatedOutcomePool();
    const book = new MemoryLedger();
    const { cases, service } = slottedPay(pool, book);
    const { payment } = await settleOn(service);
    const disputeId = 'dp-slot-one';
    await send(service, payment, 'dispute.opened', disputeId, 'evt-one-open', '40');
    const results = await Promise.allSettled([
      send(service, payment, 'dispute.won', disputeId, 'evt-one-a', '40'),
      send(service, payment, 'dispute.won', disputeId, 'evt-one-b', '40'),
      send(service, payment, 'dispute.won', disputeId, 'evt-one-c', '40'),
    ]);
    expect(results).toHaveLength(3);
    expect(book.journal().filter((tx) => tx.reason === 'pay.chargeback.won')).toHaveLength(1);
    expect((await cases.get(disputeId))?.status).toBe('won');
    expect(book.reconcile()).toEqual({ ok: true });
  }, 15_000);

  it('a lost delivery with no amount books the recorded dispute amount after a refused open', async () => {
    const { merchantId, payment } = await settled();
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
    const disputeId = 'dp-lost-recorded';
    const opened = await deliver(payment, 'dispute.opened', disputeId, 'evt-rec-open', '40');
    expect(opened.applied).toBe(true);
    expect((await store.get(disputeId))?.ledgerWire).toBe('refused');
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(0);
    const before = amt(await proceedsOf(merchantId));
    await ledger.post({
      idempotencyKey: `test.insurance:${payment.id}`,
      module: 'pay',
      reason: 'test.insurance.funded',
      entries: [
        { account: railBoundary('test-seed', 'USDT'), direction: 'credit', amount: amt('40') },
        { account: insuranceFund('USDT'), direction: 'debit', amount: amt('40') },
      ],
    });
    const lost = await deliver(payment, 'dispute.lost', disputeId, 'evt-rec-lost');
    expect(lost.applied).toBe(true);
    const moved = debitTotal(ledger, 'pay.chargeback.opened') + debitTotal(ledger, 'pay.chargeback.shortfall.covered');
    expect(formatAmount(moved)).toBe('40');
    expect(before - amt(await proceedsOf(merchantId)) <= amt('40')).toBe(true);
    expect((await store.get(disputeId))?.status).toBe('lost');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a lost delivery with no amount finalises the booked opening without a conflict', async () => {
    const { merchantId, payment } = await settled();
    const disputeId = 'dp-lost-no-amount';
    await deliver(payment, 'dispute.opened', disputeId, 'evt-noamt-open', '40');
    expect(await proceedsOf(merchantId)).toBe('60');
    const lost = await deliver(payment, 'dispute.lost', disputeId, 'evt-noamt-lost');
    expect(lost.applied).toBe(true);
    expect((await store.get(disputeId))?.status).toBe('lost');
    const audit = await listControlAudit(sql, { limit: 10, merchantId, kind: 'pay.dispute_outcome_conflict' });
    expect(audit.entries).toHaveLength(0);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('records the opening when the shortfall post is refused for funds', async () => {
    const { merchantId, payment } = await settled();
    await ledger.post({
      idempotencyKey: `test.drain:${payment.id}`,
      module: 'pay',
      reason: 'test.proceeds.spent',
      entries: [
        { account: merchantProceeds(merchantId, 'USDT'), direction: 'credit', amount: amt('70') },
        { account: railBoundary('test-spend', 'USDT'), direction: 'debit', amount: amt('70') },
      ],
    });
    await ledger.post({
      idempotencyKey: `test.insurance:${payment.id}`,
      module: 'pay',
      reason: 'test.insurance.funded',
      entries: [
        { account: railBoundary('test-seed', 'USDT'), direction: 'credit', amount: amt('70') },
        { account: insuranceFund('USDT'), direction: 'debit', amount: amt('70') },
      ],
    });
    const realPost = ledger.post.bind(ledger);
    let refused = false;
    ledger.post = async (request: PostRequest) => {
      if (request.reason === 'pay.chargeback.shortfall.covered' && !refused) {
        refused = true;
        throw new InsufficientFundsError('house:insurance-fund', 'USDT', '70', '0');
      }
      return realPost(request);
    };
    const disputeId = 'dp-opening-kept';
    const opened = await deliver(payment, 'dispute.opened', disputeId, 'evt-kept-open', '100');
    expect(opened.applied).toBe(true);
    const opening = ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened');
    expect(opening).toHaveLength(1);
    const row = await store.get(disputeId);
    expect(row?.ledgerTxId).toBe(opening[0]!.id);
    expect(row?.ledgerRefuse?.message ?? '').not.toContain('No opening');
    const disputed = await sql<Array<{ payload: { ledgerTxId?: string | null } }>>`
      SELECT payload FROM pay.payment_events
       WHERE payment_id = ${payment.id} AND event = 'disputed'`;
    expect(disputed[0]?.payload.ledgerTxId).toBe(opening[0]!.id);
    const effects = await sql<Array<{ payload: { openingTxId?: string | null } }>>`
      SELECT payload FROM pay.payment_events
       WHERE payment_id = ${payment.id}
         AND event = 'chargeback.ledger_effect'
         AND payload->>'disputeId' = ${disputeId}`;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.payload.openingTxId).toBe(opening[0]!.id);
    ledger.post = realPost;
    const lost = await deliver(payment, 'dispute.lost', disputeId, 'evt-kept-lost', '100');
    expect(lost.applied).toBe(true);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.shortfall.covered')).toHaveLength(1);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(1);
    expect((await store.get(disputeId))?.status).toBe('lost');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
