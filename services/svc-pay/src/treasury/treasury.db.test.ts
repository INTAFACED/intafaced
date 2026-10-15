import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayService } from '../payment-service.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { memoryPayoutDestinations } from '../merchant-payout-destination.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { MemoryChain } from '../rails/chain-port.js';
import { FRESH, composeGuards } from '../seams/guards.js';
import { createW5HaltsGuards } from '../seams/slots/w5-halts.js';
import { loadTreasuryLimits } from './config.js';
import { treasuryExposureView, type ConversionInventorySource } from './exposure.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = [
  '0000_pay_init.sql',
  '0002_pay_payment_links.sql',
  '0003_pay_checkout_sessions.sql',
  '0005_pay_merchant_kyb.sql',
  '0006_pay_merchant_status_history.sql',
  '0014_pay_merchant_payout_destinations.sql',
  '0018_pay_founder_controls_admission.sql',
  '0058_pay_halts.sql',
  '0059_pay_treasury_exposure_indexes.sql',
].map((f) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8'));

const SECRET = 'svc-pay-treasury-test-secret-at-least-32-characters';
const USER = '11111111-1111-4111-8111-111111111111';
const DEST = { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' };

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_treasury_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('W5 treasury exposure (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let crypto: CryptoNativeAdapter;
  let rails: RailRegistry;
  let crashOnPayout = false;

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
      `TRUNCATE pay.halts, pay.halt_events, pay.halt_clear_requests, pay.halt_failure_streaks, pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    crypto = new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 });
    const realPayout = crypto.payout.bind(crypto);
    crashOnPayout = false;
    crypto.payout = async (request) => {
      if (crashOnPayout) {
        crashOnPayout = false;
        throw new Error('process died');
      }
      return realPayout(request);
    };
    rails = new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 }), crypto, new BankPayoutAbsentAdapter()]);
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const limitsEnv = (limits: Record<string, string>) => ({ PAY_TREASURY_EXPOSURE_LIMITS: JSON.stringify(limits) });
  const service = (env: Record<string, string>, conversionInventory?: ConversionInventorySource) =>
    new PayService(sql, ledger, rails, {
      payoutDestinations: memoryPayoutDestinations(),
      guards: composeGuards(createW5HaltsGuards({ sql, env, conversionInventory })),
    });
  const open = () => new PayService(sql, ledger, rails, { payoutDestinations: memoryPayoutDestinations(), guards: composeGuards() });

  async function settledWindow(merchantId: string, amount: string, window: string) {
    const pay = open();
    const created = await pay.createPayment({
      merchantId,
      amount: amt(amount),
      assetId: 'USDT',
      method: 'crypto',
      railAdapter: 'crypto-native',
    });
    const address = await chain.acceptanceAddress(created.id, 'USDT');
    chain.credit({ address, assetId: 'USDT', amount: amt(amount), from: '0xbuyer', confirmations: 12 });
    await pay.authorize(created.id);
    await pay.capture(created.id);
    return pay.settleWindow({
      merchantId,
      window,
      assetId: 'USDT',
      from: new Date(Date.now() - 24 * 3600_000),
      to: new Date(Date.now() + 24 * 3600_000),
    });
  }
  const admissions = async () => (await sql`SELECT id FROM pay.payout_admissions`).length;

  it('limits unset (no env, blank, malformed, non-positive) refuse a payout with a typed error and admit nothing', async () => {
    const m = await open().createMerchant({ userId: USER, pricing: { feeBps: 0 } });
    const settlement = await settledWindow(m.id, '10', 'w-unset');
    for (const env of [
      {},
      { PAY_TREASURY_EXPOSURE_LIMITS: '' },
      { PAY_TREASURY_EXPOSURE_LIMITS: 'not json' },
      limitsEnv({ USDT: '0' }),
      limitsEnv({ USDT: '-5' }),
      limitsEnv({ BTC: '100' }),
    ]) {
      await expect(
        service(env).payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST }),
      ).rejects.toMatchObject({
        code: 'pay.guard_treasury_limit_unset',
        kind: 'refused',
      });
    }
    expect(await admissions()).toBe(0);
    expect(chain.outboundTransfers()).toHaveLength(0);
    expect(loadTreasuryLimits({ PAY_TREASURY_EXPOSURE_LIMITS: JSON.stringify({ USDT: 'abc', BTC: '1' }) }).invalid).toEqual(['USDT']);
  });

  it('a payout exactly AT the limit is admitted; one minor unit over is refused (pending payouts counted from the admission book)', async () => {
    const m = await open().createMerchant({ userId: USER, pricing: { feeBps: 0 } });
    const first = await settledWindow(m.id, '10', 'w-1');
    // Leave the first payout pending: process dies after the hold, before the rail answers.
    crashOnPayout = true;
    await expect(
      service(limitsEnv({ USDT: '25' })).payoutSettlement({ settlementId: first.id, railId: 'crypto-native', destination: DEST }),
    ).rejects.toThrow('process died');
    const view = await treasuryExposureView(sql, loadTreasuryLimits(limitsEnv({ USDT: '25' })), {
      wired: false,
      openInventory: async () => 0n,
    });
    expect(view).toEqual([{ assetCode: 'USDT', openConversionInventory: '0', pendingPayouts: '10', limit: '25' }]);

    const over = await settledWindow(m.id, `15.${'0'.repeat(17)}1`, 'w-over');
    expect(formatAmount(over.net)).toBe(`15.${'0'.repeat(17)}1`);
    await expect(
      service(limitsEnv({ USDT: '25' })).payoutSettlement({ settlementId: over.id, railId: 'crypto-native', destination: DEST }),
    ).rejects.toMatchObject({ code: 'pay.guard_treasury_exposure_exceeded', kind: 'refused' });
    expect(await admissions()).toBe(1);

    // The same payout under a limit raised by exactly one minor unit is admitted.
    const raised = formatAmount(amt('25') + 1n);
    expect(raised).toBe(`25.${'0'.repeat(17)}1`);
    const paid = await service(limitsEnv({ USDT: raised })).payoutSettlement({
      settlementId: over.id,
      railId: 'crypto-native',
      destination: DEST,
    });
    expect(paid.status).toBe('paid_out');
  });

  it('finishing an already-admitted (pending) payout is never refused by exposure, even if the limit was lowered since', async () => {
    const m = await open().createMerchant({ userId: USER, pricing: { feeBps: 0 } });
    const first = await settledWindow(m.id, '10', 'w-resume');
    crashOnPayout = true;
    await expect(
      service(limitsEnv({ USDT: '10' })).payoutSettlement({ settlementId: first.id, railId: 'crypto-native', destination: DEST }),
    ).rejects.toThrow('process died');
    const done = await service(limitsEnv({ USDT: '1' })).payoutSettlement({
      settlementId: first.id,
      railId: 'crypto-native',
      destination: DEST,
    });
    expect(done.status).toBe('paid_out');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('two concurrent payouts racing for the last headroom: exactly one is admitted', async () => {
    const m = await open().createMerchant({ userId: USER, pricing: { feeBps: 0 } });
    const a = await settledWindow(m.id, '10', 'w-a');
    const b = await settledWindow(m.id, '10', 'w-b');
    // Both pay out the moment they pass the guard; hold each admitted one open by crashing at the rail.
    crypto.payout = async () => {
      throw new Error('process died');
    };
    const svc = service(limitsEnv({ USDT: '10' }));
    const results = await Promise.allSettled([
      svc.payoutSettlement({ settlementId: a.id, railId: 'crypto-native', destination: DEST }),
      svc.payoutSettlement({ settlementId: b.id, railId: 'crypto-native', destination: DEST }),
    ]);
    const reasons = results.map((r) => (r.status === 'rejected' ? (r.reason as { code?: string; message?: string }) : null));
    expect(reasons.filter((r) => r?.code === 'pay.guard_treasury_exposure_exceeded')).toHaveLength(1);
    expect(reasons.filter((r) => r?.message === 'process died')).toHaveLength(1);
    expect(await admissions()).toBe(1);
  });

  it('conversion: refused while the inventory reader is unwired; with one wired, at-limit passes and one minor unit over is refused', async () => {
    const ctx = (fromAmount: bigint, replay = FRESH) => ({
      sql: sql as never,
      merchantId: randomUUID(),
      settlementId: randomUUID(),
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount,
      replay,
    });
    const unwired = composeGuards(createW5HaltsGuards({ sql, env: limitsEnv({ USD: '10' }) }));
    await expect(unwired.beforeConversion(ctx(1n))).rejects.toMatchObject({
      code: 'pay.guard_treasury_inventory_unwired',
      kind: 'unavailable',
    });

    const inventory: ConversionInventorySource = { wired: true, openInventory: async () => amt('7') };
    const wired = composeGuards(createW5HaltsGuards({ sql, env: limitsEnv({ USD: '10' }), conversionInventory: inventory }));
    await expect(wired.beforeConversion(ctx(amt('3')))).resolves.toBeUndefined();
    await expect(wired.beforeConversion(ctx(amt('3') + 1n))).rejects.toMatchObject({ code: 'pay.guard_treasury_exposure_exceeded' });
    // A replay or recovery is not new exposure.
    await expect(wired.beforeConversion(ctx(amt('99'), { kind: 'recovery', reason: 'ledger_already_booked' }))).resolves.toBeUndefined();

    const noLimit = composeGuards(createW5HaltsGuards({ sql, env: {}, conversionInventory: inventory }));
    await expect(noLimit.beforeConversion(ctx(1n))).rejects.toMatchObject({ code: 'pay.guard_treasury_limit_unset' });
  });
});
