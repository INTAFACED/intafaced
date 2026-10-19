import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { founderDisputeListSchema } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import {
  InsufficientFundsError,
  merchantClearing,
  type LedgerClient,
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
 * A dispute opens on a payment that is already frozen into a pending settlement. Its clearing left through the
 * opening post, so the frozen gross is no longer all there. Posting it would take other payments' clearing.
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
    .withDatabase('intafaced_settlement_chargeback_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('a dispute on a payment frozen into a pending settlement', { timeout: 30_000 }, () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let base: MemoryLedger;
  let gate: { blockSettle: boolean; lostReply?: boolean };
  let pay: PayService;

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
    base = new MemoryLedger();
    gate = { blockSettle: true };
    const ledger: LedgerClient = {
      post: async (request: PostRequest) => {
        if (gate.lostReply && request.reason === 'pay.settled') {
          await base.post(request);
          throw new Error('simulated lost reply after the settlement post committed');
        }
        if (gate.blockSettle && request.reason === 'pay.settled') throw new Error('simulated ledger outage during settlement post');
        return base.post(request);
      },
      balance: (ref) => base.balance(ref),
      balances: (ownerType, ownerId) => base.balances(ownerType, ownerId),
      getTx: (txId) => base.getTx(txId),
      getTxByKey: (key) => base.getTxByKey(key),
    };
    const card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    pay = new PayService(sql, ledger, new RailRegistry([card]), {
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

  function signed(payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return {
      headers: { 'x-sandbox-signature': signPayload(SECRET, timestamp, body), 'x-sandbox-timestamp': timestamp },
      body,
    };
  }

  async function captured(merchantId: string, amount: string): Promise<PaymentView> {
    const created = await pay.createPayment({
      merchantId,
      amount: amt(amount),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    await pay.authorize(created.id);
    await pay.capture(created.id);
    const payment = await pay.getPayment(created.id);
    if (!payment.railRef) throw new Error('captured card payment has no rail ref');
    return payment;
  }

  const window = () => ({
    window: 'w-dispute-pending',
    assetId: 'USDT',
    from: new Date(Date.now() - 24 * 3600_000),
    to: new Date(Date.now() + 24 * 3600_000),
  });

  it('refuses to post the frozen gross, so other payments keep their clearing', async () => {
    const merchant = await pay.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 0 } });
    const disputed = await captured(merchant.id, '100');
    await captured(merchant.id, '50');

    // Freeze both into a window; the ledger post fails, so the window stays pending.
    await expect(pay.settleWindow({ merchantId: merchant.id, ...window() })).rejects.toThrow(/simulated ledger outage/);

    // A later payment is not in the window. Its clearing is what a bad post would take.
    await captured(merchant.id, '100');

    await pay.handleWebhook(
      'card-sandbox',
      signed({
        id: 'evt-pending-open',
        type: 'dispute.opened',
        ref: disputed.railRef,
        assetId: 'USDT',
        disputeId: 'dp-pending-1',
        amount: '100',
      }),
    );
    expect(base.journal().filter((tx) => tx.reason === 'pay.chargeback.opened')).toHaveLength(1);

    gate.blockSettle = false;
    await expect(pay.settleWindow({ merchantId: merchant.id, ...window() })).rejects.toMatchObject({ code: 'pay.settlement_desynced' });

    expect(base.journal().filter((tx) => tx.reason === 'pay.settled')).toHaveLength(0);
    expect(formatAmount((await base.balance(merchantClearing(merchant.id, 'USDT'))).amount)).toBe('150');
    expect(formatAmount((await base.balance(merchantProceeds(merchant.id, 'USDT'))).amount)).toBe('0');
    expect(base.reconcile()).toEqual({ ok: true });
  });

  it('adopts a settlement the ledger already booked, so release cannot pay the window twice', async () => {
    const merchant = await pay.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 0 } });
    const disputed = await captured(merchant.id, '100');
    await captured(merchant.id, '50');

    // The ledger books the settlement, but the reply is lost, so the window stays pending.
    gate.blockSettle = false;
    gate.lostReply = true;
    await expect(pay.settleWindow({ merchantId: merchant.id, ...window() })).rejects.toThrow(/lost reply/);
    expect(base.journal().filter((tx) => tx.reason === 'pay.settled')).toHaveLength(1);

    await pay.handleWebhook(
      'card-sandbox',
      signed({
        id: 'evt-booked-open',
        type: 'dispute.opened',
        ref: disputed.railRef,
        assetId: 'USDT',
        disputeId: 'dp-booked-1',
        amount: '100',
      }),
    );

    gate.lostReply = false;
    const settlement = await pay.settleWindow({ merchantId: merchant.id, ...window() });
    expect(settlement.status).toBe('posted');
    expect(base.journal().filter((tx) => tx.reason === 'pay.settled')).toHaveLength(1);
  });
});
