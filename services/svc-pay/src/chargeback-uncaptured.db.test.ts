import { readdirSync, readFileSync } from 'node:fs';
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
// Main loads every up migration. That includes 0009_pay_submerchant_tree.sql,
// which createMerchant needs for parent_merchant_id.
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

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

describe('a dispute opened on a payment that was never captured', { timeout: 30_000 }, () => {
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

  async function authorizedOnly(merchantId: string, amount = '40'): Promise<PaymentView> {
    const created = await pay.createPayment({
      merchantId,
      amount: amt(amount),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    const authorized = await pay.authorize(created.id);
    const payment = await pay.getPayment(authorized.id);
    if (!payment.railRef) throw new Error('authorized card payment has no rail ref');
    return payment;
  }

  it('does not debit the merchant: no money was ever captured for that payment', async () => {
    const { merchantId } = await settled('100');
    const uncaptured = await authorizedOnly(merchantId, '40');
    expect(uncaptured.status).toBe('authorized');
    expect(await proceedsOf(merchantId)).toBe('100');
    await deliver(uncaptured, 'dispute.opened', 'dp-uncaptured-1', 'evt-uncaptured-open', '40');
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(0);
    expect(await proceedsOf(merchantId)).toBe('100');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
