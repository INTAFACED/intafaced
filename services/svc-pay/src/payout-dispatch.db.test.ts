import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatAmount, MemoryLedger, merchantProceeds, parseAmount as amt, type LedgerClient } from '@intafaced/ledger-client';
import { PayService, type PaymentView } from './payment-service.js';
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
 * Merchant settlement payout must not send twice after a dispatch.
 * These cases fail on a payout path that reverses a resumed refusal.
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

describe('payout dispatch marker', { timeout: 30_000 }, () => {
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

  beforeEach(async () => {
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

  async function proceedsHeld(merchantId: string): Promise<string> {
    const all = await ledger.balances('module', `pay:proceeds:${merchantId}`);
    return formatAmount(
      all.filter((b) => b.account.kind === 'hold' && b.account.assetId === 'USDT').reduce((acc, b) => acc + b.amount, 0n),
    );
  }

  async function proceeds(merchantId: string): Promise<string> {
    return formatAmount((await ledger.balance(merchantProceeds(merchantId, 'USDT'))).amount);
  }

  function refuseSameKey(settlementId: string) {
    const original = crypto.payout.bind(crypto);
    crypto.payout = async (s) => {
      if (s.settlementId !== settlementId) return original(s);
      return railFailure({
        railRef: '',
        amount: s.amount,
        assetId: s.assetId,
        failureCode: 'chain.not_configured',
        failureReason: 'NO CHAIN IS CONFIGURED',
      });
    };
  }

  it('a crash after the rail send then a refusal does not send again', async () => {
    const { merchant, settlement } = await readySettlement('dispatch-crash-refuse');
    const original = crypto.payout.bind(crypto);
    crypto.payout = async (s) => {
      const result = await original(s);
      throw new Error('receipt wait timed out');
    };
    const call = request(settlement.id);
    await expect(pay.payoutSettlement(call)).rejects.toThrow('receipt wait timed out');
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(await sql`SELECT payload->>'idempotencyKey' AS key FROM pay.payout_outcomes WHERE kind='dispatched'`).toEqual([
      { key: `pay.payout:${settlement.id}` },
    ]);

    refuseSameKey(settlement.id);
    await expect(pay.payoutSettlement(call)).rejects.toMatchObject({
      code: 'pay.rail_outcome_unknown',
      detail: { state: 'dispatched', idempotencyKey: `pay.payout:${settlement.id}` },
    });
    const row = await pay.getSettlement(settlement.id);
    expect(row.status).toBe('posted');
    expect(row.payoutAttempts).toBe(0);
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(await proceedsHeld(merchant.id)).toBe(formatAmount(settlement.net));
    expect(await proceeds(merchant.id)).toBe('0');
    expect(await sql`SELECT kind FROM pay.payout_outcomes WHERE kind IN ('rail_refused','reversed')`).toHaveLength(0);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.proceeds.payout.reversed')).toHaveLength(0);
  });

  it('an undispatched resume still reverses a first refusal', async () => {
    const { merchant, settlement } = await readySettlement('dispatch-undispatched');
    const originalPost = ledger.post.bind(ledger);
    let crash = true;
    ledger.post = async (posted) => {
      const result = await originalPost(posted);
      if (crash && posted.reason === 'pay.proceeds.payout.held') {
        crash = false;
        throw new Error('test.hold_crash');
      }
      return result;
    };
    const call = request(settlement.id);
    await expect(pay.payoutSettlement(call)).rejects.toThrow('test.hold_crash');
    expect(await sql`SELECT kind FROM pay.payout_outcomes WHERE kind='dispatched'`).toHaveLength(0);
    ledger.post = originalPost;
    refuseSameKey(settlement.id);
    await expect(pay.payoutSettlement(call)).rejects.toMatchObject({ code: 'pay.rail_failed' });
    const row = await pay.getSettlement(settlement.id);
    expect(row.status).toBe('failed');
    expect(row.payoutAttempts).toBe(1);
    expect(chain.outboundTransfers()).toHaveLength(0);
    expect(await proceeds(merchant.id)).toBe(formatAmount(settlement.net));
    expect(await proceedsHeld(merchant.id)).toBe('0');
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.proceeds.payout.reversed')).toHaveLength(1);
  });

  it('a reconciler that confirms the original key was not sent reverses once', async () => {
    const { merchant, settlement } = await readySettlement('dispatch-not-sent');
    crypto.payout = async () => {
      throw new Error('died before broadcast');
    };
    const call = request(settlement.id);
    await expect(pay.payoutSettlement(call)).rejects.toThrow('died before broadcast');
    expect(chain.outboundTransfers()).toHaveLength(0);
    const seen: string[] = [];
    const originalQuery = crypto.queryPayout.bind(crypto);
    crypto.queryPayout = async (key) => {
      seen.push(key);
      return originalQuery(key);
    };
    const failed = await pay.reconcileDispatchedPayout(settlement.id);
    expect(failed.status).toBe('failed');
    expect(failed.payoutAttempts).toBe(1);
    expect(seen).toEqual([`pay.payout:${settlement.id}`]);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.proceeds.payout.reversed')).toHaveLength(1);
    expect(await proceeds(merchant.id)).toBe(formatAmount(settlement.net));
    const again = await pay.reconcileDispatchedPayout(settlement.id);
    expect(again.status).toBe('failed');
    expect(again.payoutAttempts).toBe(1);
    expect(seen).toEqual([`pay.payout:${settlement.id}`]);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.proceeds.payout.reversed')).toHaveLength(1);
    expect(chain.outboundTransfers()).toHaveLength(0);
  });

  it('a reconciler that confirms the original key was sent finalises once', async () => {
    const { settlement } = await readySettlement('dispatch-sent');
    const original = crypto.payout.bind(crypto);
    crypto.payout = async (s) => {
      const result = await original(s);
      throw new Error('receipt wait timed out');
    };
    const call = request(settlement.id);
    await expect(pay.payoutSettlement(call)).rejects.toThrow('receipt wait timed out');
    const seen: string[] = [];
    const originalQuery = crypto.queryPayout.bind(crypto);
    crypto.queryPayout = async (key) => {
      seen.push(key);
      return originalQuery(key);
    };
    const paid = await pay.reconcileDispatchedPayout(settlement.id);
    expect(paid.status).toBe('paid_out');
    expect(paid.payoutRef).toBe(chain.outboundTransfers()[0]?.txHash);
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(seen).toEqual([`pay.payout:${settlement.id}`]);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.proceeds.payout.settled')).toHaveLength(1);
    const again = await pay.reconcileDispatchedPayout(settlement.id);
    expect(again.status).toBe('paid_out');
    expect(again.payoutRef).toBe(paid.payoutRef);
    expect(seen).toEqual([`pay.payout:${settlement.id}`]);
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.proceeds.payout.settled')).toHaveLength(1);
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('concurrent resumes of a dispatched payout send once', async () => {
    const { merchant, settlement } = await readySettlement('dispatch-concurrent');
    const original = crypto.payout.bind(crypto);
    let crashed = false;
    crypto.payout = async (s) => {
      if (!crashed) {
        crashed = true;
        const result = await original(s);
        throw new Error('receipt wait timed out');
      }
      if (s.settlementId !== settlement.id) return original(s);
      return railFailure({
        railRef: '',
        amount: s.amount,
        assetId: s.assetId,
        failureCode: 'chain.not_configured',
        failureReason: 'NO CHAIN IS CONFIGURED',
      });
    };
    const call = request(settlement.id);
    await expect(pay.payoutSettlement(call)).rejects.toThrow('receipt wait timed out');
    const resumed = await Promise.allSettled([pay.payoutSettlement(call), pay.payoutSettlement(call)]);
    expect(resumed).toHaveLength(2);
    for (const result of resumed) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: 'pay.rail_outcome_unknown' });
    }
    const row = await pay.getSettlement(settlement.id);
    expect(row.status).toBe('posted');
    expect(row.payoutAttempts).toBe(0);
    expect(chain.outboundTransfers()).toHaveLength(1);
    expect(await proceedsHeld(merchant.id)).toBe(formatAmount(settlement.net));
  });

  it('a dispatched payout with no rail status query stays held', async () => {
    const { merchant, settlement } = await readySettlement('dispatch-no-query');
    crypto.payout = async () => {
      throw new Error('died before broadcast');
    };
    await expect(pay.payoutSettlement(request(settlement.id))).rejects.toThrow('died before broadcast');
    crypto.queryPayout = undefined as unknown as CryptoNativeAdapter['queryPayout'];
    await expect(pay.reconcileDispatchedPayout(settlement.id)).rejects.toMatchObject({
      code: 'pay.rail_outcome_unknown',
      detail: { state: 'dispatched' },
    });
    const row = await pay.getSettlement(settlement.id);
    expect(row.status).toBe('posted');
    expect(row.payoutAttempts).toBe(0);
    expect(await proceedsHeld(merchant.id)).toBe(formatAmount(settlement.net));
    expect(ledger.journal().filter((tx) => tx.reason === 'pay.proceeds.payout.reversed')).toHaveLength(0);
  });
});
