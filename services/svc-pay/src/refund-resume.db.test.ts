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
 * A refund whose rail reply was lost is finished by the same refund id, and by nothing else.
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

describe('refund resumed after a lost rail reply', { timeout: 30_000 }, () => {
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

  /** The rail sends, then the reply is lost before the core records it. */
  function loseNextReply(): void {
    const real = crypto.refund.bind(crypto);
    let lose = true;
    crypto.refund = async (ref, amount, opts) => {
      const result = await real(ref, amount, opts);
      if (lose) {
        lose = false;
        throw new Error('reply lost after the rail sent');
      }
      return result;
    };
  }

  it('the same refundId finishes the refund with one chain send and one ledger move', async () => {
    const { merchant, payment } = await capturedPayment();
    loseNextReply();
    await expect(pay.refund(payment.id, amt('10'), { refundId: 'r-2' })).rejects.toThrow('reply lost');
    expect(chain.outboundTransfers()).toHaveLength(1);

    const view = await pay.refund(payment.id, amt('10'), { refundId: 'r-2' });
    expect(view.status).toBe('refunded');
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(ledger.journal().filter((tx) => tx.reason === 'payment.refunded')).toHaveLength(1);
    expect(formatAmount((await ledger.balance(merchantClearing(merchant.id, 'USDT'))).amount)).toBe('0');
    expect((await pay.history(payment.id, 50)).filter((e) => e.event === 'refunded')).toHaveLength(1);
  });

  it('two concurrent retries of the same refundId record one outcome', async () => {
    const { payment } = await capturedPayment();
    loseNextReply();
    await expect(pay.refund(payment.id, amt('10'), { refundId: 'r-3' })).rejects.toThrow('reply lost');
    const both = await Promise.allSettled([
      pay.refund(payment.id, amt('10'), { refundId: 'r-3' }),
      pay.refund(payment.id, amt('10'), { refundId: 'r-3' }),
    ]);
    expect(both.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect((await pay.history(payment.id, 50)).filter((e) => e.event === 'refunded')).toHaveLength(1);
  });

  it('a different refundId, or none, stays refused while one is in flight', async () => {
    const { payment } = await capturedPayment();
    loseNextReply();
    await expect(pay.refund(payment.id, amt('10'), { refundId: 'r-4' })).rejects.toThrow('reply lost');
    await expect(pay.refund(payment.id, amt('10'), { refundId: 'r-other' })).rejects.toMatchObject({ code: 'pay.refund_in_flight' });
    await expect(pay.refund(payment.id, amt('10'))).rejects.toMatchObject({ code: 'pay.refund_in_flight' });
    expect(chain.outboundTransfers()).toHaveLength(1);
  });

  it('the same refundId with a different amount is a conflict, not a resume', async () => {
    const { payment } = await capturedPayment();
    loseNextReply();
    await expect(pay.refund(payment.id, amt('10'), { refundId: 'r-5' })).rejects.toThrow('reply lost');
    await expect(pay.refund(payment.id, amt('4'), { refundId: 'r-5' })).rejects.toMatchObject({ code: 'pay.refund_id_conflict' });
    expect(chain.outboundTransfers()).toHaveLength(1);
  });

  it('a rail that does not answer a repeated id with its first result is never asked again', async () => {
    const { payment } = await capturedPayment();
    loseNextReply();
    (crypto as { refundIsIdempotentByRefundId?: boolean }).refundIsIdempotentByRefundId = false;
    await expect(pay.refund(payment.id, amt('10'), { refundId: 'r-6' })).rejects.toThrow('reply lost');
    await expect(pay.refund(payment.id, amt('10'), { refundId: 'r-6' })).rejects.toMatchObject({ code: 'pay.refund_in_flight' });
    expect(chain.outboundTransfers()).toHaveLength(1);
  });

  it('a retry of a completed full refund replays it, even after the payment shows refunded', async () => {
    const { payment } = await capturedPayment();
    loseNextReply();
    await expect(pay.refund(payment.id, amt('10'), { refundId: 'r-7' })).rejects.toThrow('reply lost');
    const winner = await pay.refund(payment.id, amt('10'), { refundId: 'r-7' });
    expect(winner.status).toBe('refunded');
    // A later retry of the same id (a second lost reply) finds the payment already refunded: it gets the refund, not a refusal.
    const again = await pay.refund(payment.id, amt('10'), { refundId: 'r-7' });
    expect(again.status).toBe('refunded');
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(ledger.journal().filter((tx) => tx.reason === 'payment.refunded')).toHaveLength(1);
    expect((await pay.history(payment.id, 50)).filter((e) => e.event === 'refunded')).toHaveLength(1);
  });

  it('a completed full refund retried with another amount is a conflict, and a new id is still refused', async () => {
    const { payment } = await capturedPayment();
    expect((await pay.refund(payment.id, amt('10'), { refundId: 'r-8' })).status).toBe('refunded');
    await expect(pay.refund(payment.id, amt('4'), { refundId: 'r-8' })).rejects.toMatchObject({ code: 'pay.refund_id_conflict' });
    await expect(pay.refund(payment.id, amt('10'), { refundId: 'r-9' })).rejects.toMatchObject({ code: 'pay.nothing_captured' });
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect((await pay.history(payment.id, 50)).filter((e) => e.event === 'refunded')).toHaveLength(1);
  });
});
