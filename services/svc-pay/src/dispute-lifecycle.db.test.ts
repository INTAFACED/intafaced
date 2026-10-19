import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, merchantProceeds, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresDisputeCaseStore } from './fraud/dispute-case-store.js';
import { memoryPayoutDestinations } from './merchant-payout-destination.js';
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
    .withDatabase('intafaced_dispute_lifecycle_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

/**
 * The dispute lifecycle against the real pay tables and MemoryLedger. A won
 * dispute returns the money, so the payment must go back to the status it
 * came from instead of staying terminal; a dispute that lands between a
 * window's freeze and its post must free the rest of the window.
 */
describe('dispute lifecycle and settlement windows', { timeout: 30_000 }, () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
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
    ledger = new MemoryLedger();
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

  function deliver(payment: PaymentView, type: string, disputeId: string, id: string, amount: string) {
    return pay.handleWebhook('card-sandbox', signed({ id, type, ref: payment.railRef, assetId: 'USDT', disputeId, amount }));
  }

  async function proceedsOf(merchantId: string): Promise<string> {
    return formatAmount((await ledger.balance(merchantProceeds(merchantId, 'USDT'))).amount);
  }

  async function merchant() {
    return pay.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 0 } });
  }

  async function captured(merchantId: string, amount = '100'): Promise<PaymentView> {
    const created = await pay.createPayment({
      merchantId,
      amount: amt(amount),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
      instrument: { kind: 'card', token: 'tok_ok' },
    });
    const authorized = await pay.authorize(created.id);
    await pay.capture(authorized.id);
    return pay.getPayment(authorized.id);
  }

  const wide = () => ({ from: new Date(Date.now() - 24 * 3600_000), to: new Date(Date.now() + 24 * 3600_000) });

  it('a payment whose dispute was won before settlement settles in a window', async () => {
    const m = await merchant();
    const payment = await captured(m.id);
    await deliver(payment, 'dispute.opened', 'dp-1', 'evt-open-1', '40');
    expect((await pay.getPayment(payment.id)).status).toBe('disputed');
    await deliver(payment, 'dispute.won', 'dp-1', 'evt-won-1', '40');
    expect((await pay.getPayment(payment.id)).status).toBe('captured');
    await pay.settleWindow({ merchantId: m.id, window: 'w-rejoin', assetId: 'USDT', ...wide() });
    expect(await proceedsOf(m.id)).toBe('100');
    expect((await pay.getPayment(payment.id)).status).toBe('settled');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a payment whose dispute was won after settlement returns to settled', async () => {
    const m = await merchant();
    const payment = await captured(m.id);
    await pay.settleWindow({ merchantId: m.id, window: 'w-first', assetId: 'USDT', ...wide() });
    await deliver(payment, 'dispute.opened', 'dp-2', 'evt-open-2', '40');
    expect((await pay.getPayment(payment.id)).status).toBe('disputed');
    await deliver(payment, 'dispute.won', 'dp-2', 'evt-won-2', '40');
    expect((await pay.getPayment(payment.id)).status).toBe('settled');
    expect(await proceedsOf(m.id)).toBe('100');
    await expect(pay.settleWindow({ merchantId: m.id, window: 'w-second', assetId: 'USDT', ...wide() })).rejects.toMatchObject({
      code: 'pay.nothing_to_settle',
    });
  });

  it('a payment stays disputed while another dispute on it is still open', async () => {
    const m = await merchant();
    const payment = await captured(m.id);
    await deliver(payment, 'dispute.opened', 'dp-3a', 'evt-open-3a', '30');
    await deliver(payment, 'dispute.opened', 'dp-3b', 'evt-open-3b', '30');
    await deliver(payment, 'dispute.won', 'dp-3a', 'evt-won-3a', '30');
    expect((await pay.getPayment(payment.id)).status).toBe('disputed');
    await deliver(payment, 'dispute.won', 'dp-3b', 'evt-won-3b', '30');
    expect((await pay.getPayment(payment.id)).status).toBe('captured');
  });

  it('a second dispute opening while the first is won keeps the payment disputed', async () => {
    const m = await merchant();
    const payment = await captured(m.id);
    await deliver(payment, 'dispute.opened', 'dp-r1', 'evt-open-r1', '30');

    // The second dispute's case row commits only after the first one's win has restored the payment.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    class GatedStore extends PostgresDisputeCaseStore {
      override async open(input: Parameters<PostgresDisputeCaseStore['open']>[0]) {
        if (input.disputeId === 'dp-r2') await gate;
        return super.open(input);
      }
    }
    const store = new GatedStore(sql);
    const card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
    const gated = new PayService(sql, ledger, new RailRegistry([card]), {
      payoutDestinations: memoryPayoutDestinations(),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
      disputeCases: store,
      chargebackOutcomeSlots: 4,
    });
    const send = (id: string, type: string, disputeId: string) =>
      gated.handleWebhook('card-sandbox', signed({ id, type, ref: payment.railRef, assetId: 'USDT', disputeId, amount: '30' }));

    const opening = send('evt-open-r2', 'dispute.opened', 'dp-r2');
    // Let the second delivery read the payment (still disputed) and book its opening before the first dispute is won.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await send('evt-won-r1', 'dispute.won', 'dp-r1');
    expect((await gated.getPayment(payment.id)).status).toBe('captured');
    release();
    await opening;

    expect((await store.get('dp-r2'))?.status).toBe('open');
    expect((await gated.getPayment(payment.id)).status).toBe('disputed');
  });

  it('a lost dispute leaves the payment disputed', async () => {
    const m = await merchant();
    const payment = await captured(m.id);
    await deliver(payment, 'dispute.opened', 'dp-4', 'evt-open-4', '40');
    await deliver(payment, 'dispute.lost', 'dp-4', 'evt-lost-4', '40');
    expect((await pay.getPayment(payment.id)).status).toBe('disputed');
  });

  it('a dispute between freeze and post releases the window and frees the other payments', async () => {
    const m = await merchant();
    const disputed = await captured(m.id, '100');
    const clean = await captured(m.id, '50');
    // Freeze without posting: the state a crash or a slow post leaves behind.
    const frozen = await (pay as unknown as { prepareSettlement(i: unknown): Promise<{ id: string; status: string }> }).prepareSettlement({
      merchantId: m.id,
      window: 'w-race',
      assetId: 'USDT',
      ...wide(),
    });
    expect(frozen.status).toBe('pending');
    await deliver(disputed, 'dispute.opened', 'dp-5', 'evt-open-5', '40');
    await expect(pay.settleWindow({ merchantId: m.id, window: 'w-race', assetId: 'USDT', ...wide() })).rejects.toMatchObject({
      code: 'pay.settlement_desynced',
    });
    const [row] = await sql<Array<{ status: string; failure_code: string | null }>>`
      SELECT status, failure_code FROM pay.settlements WHERE id = ${frozen.id}`;
    expect(row).toEqual({ status: 'failed', failure_code: 'pay.settlement_released' });
    await pay.settleWindow({ merchantId: m.id, window: 'w-after', assetId: 'USDT', ...wide() });
    expect(await proceedsOf(m.id)).toBe('50');
    expect((await pay.getPayment(clean.id)).status).toBe('settled');
    expect((await pay.getPayment(disputed.id)).status).toBe('disputed');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});
