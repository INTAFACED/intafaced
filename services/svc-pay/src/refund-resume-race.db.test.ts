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

describe('refund resume race: a concurrent retry of the same refundId replays (D96)', { timeout: 30_000 }, () => {
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

  /** Gate the next rail refund call: it waits until `release()` is called. */
  function gateNextRefund(): { entered: Promise<void>; release: () => void } {
    const real = crypto.refund.bind(crypto);
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => (markEntered = r));
    const gate = new Promise<void>((r) => (release = r));
    let used = false;
    crypto.refund = async (ref, amount, opts) => {
      if (!used) {
        used = true;
        markEntered();
        await gate;
      }
      return real(ref, amount, opts);
    };
    return { entered, release };
  }

  it('the losing retry that arrives after the winner recorded the refund replays, it is not refused nothing_captured', async () => {
    const { payment } = await capturedPayment();
    loseNextReply();
    await expect(pay.refund(payment.id, amt('10'), { refundId: 'race-1' })).rejects.toThrow('reply lost');
    // Winner: resumes and records the full refund (payment -> refunded).
    const winner = await pay.refund(payment.id, amt('10'), { refundId: 'race-1' });
    expect(winner.status).toBe('refunded');
    // Loser: deterministic worst interleaving -- its Phase 1 runs after the winner's Phase 3 committed.
    const loser = await pay.refund(payment.id, amt('10'), { refundId: 'race-1' });
    expect(loser.status).toBe('refunded');
    expect(loser.id).toBe(winner.id);
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect((await pay.history(payment.id, 50)).filter((e) => e.event === 'refunded')).toHaveLength(1);
    expect(ledger.journal().filter((tx) => tx.reason === 'payment.refunded')).toHaveLength(1);
  });

  it('barrier: retry B starts while retry A is inside the rail call; both return the one refund, one send, one event', async () => {
    const { payment } = await capturedPayment();
    loseNextReply();
    await expect(pay.refund(payment.id, amt('10'), { refundId: 'race-2' })).rejects.toThrow('reply lost');
    const gate = gateNextRefund();
    const a = pay.refund(payment.id, amt('10'), { refundId: 'race-2' });
    await gate.entered; // A has passed Phase 1 and holds no transaction while it waits at the rail
    let bDone = false;
    const b = pay.refund(payment.id, amt('10'), { refundId: 'race-2' }).finally(() => (bDone = true));
    // B is not blocked by A: no transaction or row lock is held across A's rail call.
    const bView = await b;
    expect(bDone).toBe(true);
    gate.release();
    const aView = await a;
    expect([aView.status, bView.status]).toEqual(['refunded', 'refunded']);
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect((await pay.history(payment.id, 50)).filter((e) => e.event === 'refunded')).toHaveLength(1);
    // A third retry after both: replay.
    expect((await pay.refund(payment.id, amt('10'), { refundId: 'race-2' })).status).toBe('refunded');
    expect(chain.outboundTransfers()).toHaveLength(1);
  });

  it('a completed refundId retried with a different amount is still a conflict, never a second refund', async () => {
    const { payment } = await capturedPayment();
    await pay.refund(payment.id, amt('10'), { refundId: 'race-3' });
    await expect(pay.refund(payment.id, amt('4'), { refundId: 'race-3' })).rejects.toMatchObject({ code: 'pay.refund_id_conflict' });
    expect(chain.outboundTransfers()).toHaveLength(1);
  });
});
