import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatAmount, MemoryLedger, merchantProceeds, parseAmount as amt, type LedgerClient } from '@intafaced/ledger-client';
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
import {
  PayoutReconcilerError,
  publishedPayoutReconcileBatchLimit,
  publishedPayoutReconcileIntervalMs,
  resolvePayoutReconcilerConfig,
  runPayoutReconcilePass,
  startPayoutReconciler,
} from './payout-reconciler.js';

/**
 * A dispatched payout is finished by a scheduled job, not only by a hand call.
 * Blank interval or batch limit means off with a named blocker (no invented magnitude).
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

const SERVICE_DIR = join(here, '..');

describe('payout reconciler job', { timeout: 30_000 }, () => {
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

  async function readySettlement(window: string) {
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
    const settlement = await pay.settleWindow({
      merchantId: merchant.id,
      window,
      assetId: 'USDT',
      from: new Date(Date.now() - 24 * 3600_000),
      to: new Date(Date.now() + 24 * 3600_000),
    });
    return { merchant, settlement };
  }

  function request(settlementId: string) {
    return { settlementId, railId: 'crypto-native' as const, destination: DEST };
  }

  /** Crash after the rail send: the dispatched marker and the hold are committed, the answer is lost. */
  async function crashedAfterSend(window: string) {
    const made = await readySettlement(window);
    const original = crypto.payout.bind(crypto);
    crypto.payout = async (s) => {
      await original(s);
      throw new Error('receipt wait timed out');
    };
    await expect(pay.payoutSettlement(request(made.settlement.id))).rejects.toThrow('receipt wait timed out');
    crypto.payout = original;
    return made;
  }

  const log = { info: () => undefined, warn: () => undefined };

  it('a blank interval or batch limit is a typed refuse and the job stays off', () => {
    for (const blank of [undefined, null, 0, Number.NaN]) {
      expect(() => publishedPayoutReconcileIntervalMs(blank)).toThrow(PayoutReconcilerError);
      expect(() => publishedPayoutReconcileIntervalMs(blank)).toThrow(
        expect.objectContaining({ code: 'pay.payout_reconcile_interval_unset' }),
      );
      expect(() => publishedPayoutReconcileBatchLimit(blank)).toThrow(
        expect.objectContaining({ code: 'pay.payout_reconcile_batch_limit_unset' }),
      );
    }
    expect(resolvePayoutReconcilerConfig({ batchLimit: 10 })).toMatchObject({
      mode: 'off',
      blocker: 'pay.payout_reconcile_interval_unset',
    });
    expect(resolvePayoutReconcilerConfig({ intervalMs: 5000 })).toMatchObject({
      mode: 'off',
      blocker: 'pay.payout_reconcile_batch_limit_unset',
    });
    expect(resolvePayoutReconcilerConfig({ intervalMs: 5000, batchLimit: 10 })).toEqual({ mode: 'on', intervalMs: 5000, batchLimit: 10 });
    expect(startPayoutReconciler(sql, pay, { batchLimit: 10 }, log)).toBeNull();
  });

  it('a pass with a blank batch limit refuses before reading', async () => {
    await expect(runPayoutReconcilePass(sql, pay, { batchLimit: undefined })).rejects.toMatchObject({
      code: 'pay.payout_reconcile_batch_limit_unset',
    });
  });

  it('index.ts starts the job and env.ts has no default for either setting', () => {
    const index = readFileSync(join(SERVICE_DIR, 'src/index.ts'), 'utf8');
    expect(index).toMatch(/startPayoutReconciler\(/);
    const envTs = readFileSync(join(SERVICE_DIR, 'src/env.ts'), 'utf8');
    expect(envTs).toMatch(/PAY_PAYOUT_RECONCILE_INTERVAL_MS/);
    expect(envTs).toMatch(/PAY_PAYOUT_RECONCILE_BATCH_LIMIT/);
    expect(envTs).not.toMatch(/PAY_PAYOUT_RECONCILE_(?:INTERVAL_MS|BATCH_LIMIT):[^\n]*\.default\(/);
  });

  it('a pass finalises a payout whose send was confirmed, once', async () => {
    const { settlement } = await crashedAfterSend('recon-sent');
    const first = await runPayoutReconcilePass(sql, pay, { batchLimit: 10 });
    expect(first).toMatchObject({ examined: 1, paidOut: 1, reversed: 0, stillUnknown: 0, failed: [] });
    expect((await pay.getSettlement(settlement.id)).status).toBe('paid_out');
    const second = await runPayoutReconcilePass(sql, pay, { batchLimit: 10 });
    expect(second.examined).toBe(0);
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.proceeds.payout.settled')).toHaveLength(1);
  });

  it('a pass reverses a payout the rail confirms was never sent, once', async () => {
    const { merchant, settlement } = await readySettlement('recon-not-sent');
    crypto.payout = async () => {
      throw new Error('died before broadcast');
    };
    await expect(pay.payoutSettlement(request(settlement.id))).rejects.toThrow('died before broadcast');
    const first = await runPayoutReconcilePass(sql, pay, { batchLimit: 10 });
    expect(first).toMatchObject({ examined: 1, paidOut: 0, reversed: 1 });
    expect(await runPayoutReconcilePass(sql, pay, { batchLimit: 10 })).toMatchObject({ examined: 0 });
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.proceeds.payout.reversed')).toHaveLength(1);
    expect(formatAmount((await ledger.balance(merchantProceeds(merchant.id, 'USDT'))).amount)).toBe(formatAmount(settlement.net));
    expect(chain.outboundTransfers()).toHaveLength(0);
  });

  it('crash between the rail answer and the ledger settle: the next pass finishes it without a second post', async () => {
    const { settlement } = await crashedAfterSend('recon-crash-settle');
    const originalPost = ledger.post.bind(ledger);
    let crash = true;
    ledger.post = async (posted) => {
      const result = await originalPost(posted);
      if (crash && posted.reason === 'pay.proceeds.payout.settled') {
        crash = false;
        throw new Error('test.settle_crash');
      }
      return result;
    };
    const first = await runPayoutReconcilePass(sql, pay, { batchLimit: 10 });
    expect(first.failed).toEqual([{ settlementId: settlement.id, code: 'pay.failed' }]);
    expect((await pay.getSettlement(settlement.id)).status).toBe('posted');
    const second = await runPayoutReconcilePass(sql, pay, { batchLimit: 10 });
    expect(second).toMatchObject({ examined: 1, paidOut: 1, failed: [] });
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.proceeds.payout.settled')).toHaveLength(1);
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('a rail that cannot say keeps the hold and does not stop the other settlements', async () => {
    const a = await crashedAfterSend('recon-unknown-a');
    const b = await crashedAfterSend('recon-unknown-b');
    const originalQuery = crypto.queryPayout.bind(crypto);
    crypto.queryPayout = async (key) => {
      if (key === `pay.payout:${a.settlement.id}`) throw new Error('rail down');
      return originalQuery(key);
    };
    const report = await runPayoutReconcilePass(sql, pay, { batchLimit: 10 });
    expect(report).toMatchObject({ examined: 2, paidOut: 1, stillUnknown: 1, failed: [] });
    expect((await pay.getSettlement(a.settlement.id)).status).toBe('posted');
    expect((await pay.getSettlement(b.settlement.id)).status).toBe('paid_out');
    crypto.queryPayout = originalQuery;
    expect(await runPayoutReconcilePass(sql, pay, { batchLimit: 10 })).toMatchObject({ examined: 1, paidOut: 1 });
  });

  it('the batch limit bounds a pass', async () => {
    await crashedAfterSend('recon-limit-a');
    await crashedAfterSend('recon-limit-b');
    expect(await runPayoutReconcilePass(sql, pay, { batchLimit: 1 })).toMatchObject({ examined: 1, paidOut: 1 });
    expect(await runPayoutReconcilePass(sql, pay, { batchLimit: 1 })).toMatchObject({ examined: 1, paidOut: 1 });
  });
});
