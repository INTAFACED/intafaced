import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  formatAmount,
  MemoryLedger,
  merchantClearing,
  merchantProceeds,
  parseAmount as amt,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { PostgresDisputeCaseStore } from './fraud/dispute-case-store.js';
import { PayService, type PaymentView } from './payment-service.js';
import { installPayoutDestinationShim } from './payout-destination-test-shim.js';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { memoryPayoutDestinations } from './merchant-payout-destination.js';
import { RailRegistry } from './rails/registry.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { CryptoNativeAdapter } from './rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from './rails/bank-payout.js';
import { MemoryChain } from './rails/chain-port.js';
import { railFailure } from './rails/rail-adapter.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from './routing/decide.js';

/**
 * A payout whose frozen net a refund has drawn below is refused before it is admitted.
 */
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-pay-payout-dispatch-secret-at-least-32';
const MERCHANT_USER = '11111111-1111-4111-8111-111111111111';
const DEST = { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' };

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_payout_dispatch_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

describe('refund of a settled payment before its payout', { timeout: 30_000 }, () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let crypto: CryptoNativeAdapter;
  let pay: PayService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  let restorePayoutShim: (() => void) | undefined;
  afterEach(() => {
    restorePayoutShim?.();
    restorePayoutShim = undefined;
  });

  beforeEach(async () => {
    restorePayoutShim = installPayoutDestinationShim(sql);
    await truncatePayForTest(
      sql,
      'pay',
      `TRUNCATE pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants, pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    crypto = new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 });
    const rails = new RailRegistry([
      new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 }),
      crypto,
      new BankPayoutAbsentAdapter(),
    ]);
    pay = new PayService(sql, ledger as LedgerClient, rails, {
      disputeCases: new PostgresDisputeCaseStore(sql),
      payoutDestinations: memoryPayoutDestinations(),
      checkoutRiskBand: 'low',
      routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) =>
        p.railId === 'crypto-native'
          ? { ...p, successRate: '0.90' }
          : p.railId === 'card-sandbox'
            ? { ...p, successRate: '0.88' }
            : { ...p },
      ),
      linkDefaultTtlDays: 30,
      linkMaxTtlDays: 365,
      checkoutSessionTtlSeconds: 900,
      maxOpenSessionsPerLink: 25,
    });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function capturedPayment() {
    const merchant = await pay.createMerchant({ userId: MERCHANT_USER, pricing: { feeBps: 0 } });
    const payment = await pay.createPayment({
      merchantId: merchant.id,
      amount: amt('10'),
      assetId: 'USDT',
      method: 'crypto',
      railAdapter: 'crypto-native',
    });
    const address = await chain.acceptanceAddress(payment.id, 'USDT');
    chain.credit({ address, assetId: 'USDT', amount: amt('10'), from: '0xbuyer', confirmations: 12 });
    const authorized: PaymentView = await pay.authorize(payment.id);
    await pay.capture(authorized.id);
    return { merchant, payment };
  }

  async function settledPayment() {
    const { merchant, payment } = await capturedPayment();
    const settlement = await pay.settleWindow({
      merchantId: merchant.id,
      window: 'refund-then-payout',
      assetId: 'USDT',
      from: new Date(Date.now() - 24 * 3600_000),
      to: new Date(Date.now() + 24 * 3600_000),
    });
    return { merchant, payment, settlement };
  }

  const payoutOf = (settlementId: string) => pay.payoutSettlement({ settlementId, railId: 'crypto-native', destination: DEST });
  const payoutHoldsAndAdmissions = async () => {
    const [admissions] = await sql`SELECT count(*)::int AS n FROM pay.payout_admissions`;
    return admissions?.n;
  };

  it('pays out the net less a refund drawn on it, and records the reduced net', async () => {
    const { merchant, payment, settlement } = await settledPayment();
    await pay.refund(payment.id, amt('4'), { refundId: 'r-p1' });
    expect(formatAmount((await ledger.balance(merchantProceeds(merchant.id, 'USDT'))).amount)).toBe('6');

    const paid = await payoutOf(settlement.id);

    expect(paid.status).toBe('paid_out');
    expect(formatAmount(paid.net)).toBe('6');
    expect(formatAmount(paid.gross)).toBe('6');
    expect(formatAmount((await ledger.balance(merchantProceeds(merchant.id, 'USDT'))).amount)).toBe('0');
    expect(chain.outboundTransfers().map((t) => formatAmount(t.amount))).toEqual(['4', '6']);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses a payout with nothing left after refunds, before any admission or hold', async () => {
    const { payment, settlement } = await settledPayment();
    await pay.refund(payment.id, amt('10'), { refundId: 'r-all' });

    for (let i = 0; i < 2; i++) {
      await expect(payoutOf(settlement.id)).rejects.toMatchObject({ code: 'pay.settlement_exceeds_proceeds' });
    }
    expect(await payoutHoldsAndAdmissions()).toBe(0);
    expect(chain.outboundTransfers()).toHaveLength(1); // only the refund
    expect((await pay.getSettlement(settlement.id)).status).toBe('posted');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('does not cut the net while a refund may still be reversed', async () => {
    const { payment, settlement } = await settledPayment();
    const realSend = chain.send.bind(chain);
    chain.send = async () => {
      throw new Error('rpc timeout after the broadcast');
    };
    await expect(pay.refund(payment.id, amt('4'), { refundId: 'r-unk' })).rejects.toThrow();
    chain.send = realSend;

    await expect(payoutOf(settlement.id)).rejects.toMatchObject({ code: 'pay.refund_in_flight' });
    expect(await payoutHoldsAndAdmissions()).toBe(0);
    const unchanged = await pay.getSettlement(settlement.id);
    expect(formatAmount(unchanged.net)).toBe('10');
    expect(unchanged.status).toBe('posted');
  });

  it('does not cut the net while a dispute is open, since a won dispute returns the money', async () => {
    const { merchant, payment, settlement } = await settledPayment();
    await pay.openChargeback({ disputeId: 'd-1', paymentId: payment.id, merchantId: merchant.id, amount: '4', assetId: 'USDT' });
    await pay.markDisputed(payment.id, { disputeId: 'd-1' });
    expect(formatAmount((await ledger.balance(merchantProceeds(merchant.id, 'USDT'))).amount)).toBe('6');

    await expect(payoutOf(settlement.id)).rejects.toMatchObject({ code: 'pay.refund_in_flight' });
    expect(await payoutHoldsAndAdmissions()).toBe(0);
    expect(formatAmount((await pay.getSettlement(settlement.id)).net)).toBe('10');
  });

  it('cuts the net once the only dispute is lost, but not while it is open', async () => {
    const { merchant, payment, settlement } = await settledPayment();
    const store = new PostgresDisputeCaseStore(sql);
    await pay.openChargeback({ disputeId: 'd-2', paymentId: payment.id, merchantId: merchant.id, amount: '4', assetId: 'USDT' });
    await pay.markDisputed(payment.id, { disputeId: 'd-2' });
    await store.open({
      disputeId: 'd-2',
      paymentId: payment.id,
      merchantId: merchant.id,
      amount: '4',
      assetId: 'USDT',
      paymentMarkedDisputed: true,
    });
    await expect(payoutOf(settlement.id)).rejects.toMatchObject({ code: 'pay.refund_in_flight' });

    await store.markLost('d-2');
    expect((await pay.getPayment(payment.id)).status).toBe('disputed');

    const paid = await payoutOf(settlement.id);
    expect(paid.status).toBe('paid_out');
    expect(formatAmount(paid.net)).toBe('6');
  });
});
