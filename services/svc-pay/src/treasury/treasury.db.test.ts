import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayService } from '../payment-service.js';
import { UserMoneyService } from '../user-money-service.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { memoryPayoutDestinations } from '../merchant-payout-destination.js';
import { installPayoutDestinationShim } from '../payout-destination-test-shim.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { MemoryChain } from '../rails/chain-port.js';
import { FRESH, composeGuards } from '../seams/guards.js';
import { createW5HaltsGuards } from '../seams/slots/w5-halts.js';
import { loadTreasuryLimits, loadTreasuryMode } from './config.js';
import { treasuryExposureView, type ConversionInventorySource } from './exposure.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

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
      `TRUNCATE pay.halts, pay.halt_events, pay.halt_clear_requests, pay.halt_failure_streaks, pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants, pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`,
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

  const limitsEnv = (limits: Record<string, string>) => ({
    PAY_TREASURY_LIMITS: 'required',
    PAY_TREASURY_EXPOSURE_LIMITS: JSON.stringify(limits),
  });
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
    const required = { PAY_TREASURY_LIMITS: 'required' };
    for (const env of [
      required,
      { ...required, PAY_TREASURY_EXPOSURE_LIMITS: '' },
      { ...required, PAY_TREASURY_EXPOSURE_LIMITS: 'not json' },
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
    expect(view).toEqual([{ assetCode: 'USDT', openConversionInventory: null, pendingPayouts: '10', limit: '25' }]);

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
      tx: sql as never,
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

    const noLimit = composeGuards(createW5HaltsGuards({ sql, env: { PAY_TREASURY_LIMITS: 'required' }, conversionInventory: inventory }));
    await expect(noLimit.beforeConversion(ctx(1n))).rejects.toMatchObject({ code: 'pay.guard_treasury_limit_unset' });
  });

  describe('user-money withdrawals', () => {
    const withdrawalCtx = (
      over: Partial<{ userId: string; assetId: string; amount: bigint; clientRef: string; replay: typeof FRESH }> = {},
    ) => ({
      tx: sql as never,
      userId: 'u-new',
      assetId: 'USDT',
      amount: amt('3'),
      rail: 'crypto-native',
      destination: DEST,
      clientRef: 'c-new',
      replay: FRESH as never,
      ...over,
    });
    const seedInFlight = () =>
      sql`INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status) VALUES
        ('u1', 'USDT', 4, 'crypto-native', '{}'::jsonb, 'c1', 'held'),
        ('u2', 'USDT', 3, 'crypto-native', '{}'::jsonb, 'c2', 'pending')`;

    it('required: a withdrawal that would take exposure over the limit is refused; at the limit it passes', async () => {
      await seedInFlight(); // 7 in flight
      const guards = composeGuards(createW5HaltsGuards({ sql, env: limitsEnv({ USDT: '10' }) }));
      await expect(guards.beforeUserMoneyWithdrawal(withdrawalCtx({ amount: amt('3') + 1n }))).rejects.toMatchObject({
        code: 'pay.guard_treasury_exposure_exceeded',
        kind: 'refused',
      });
      await expect(guards.beforeUserMoneyWithdrawal(withdrawalCtx({ amount: amt('3') }))).resolves.toBeUndefined();
    });

    it('required: under the limit passes, an unset limit refuses, replay and recovery never count', async () => {
      const guards = composeGuards(createW5HaltsGuards({ sql, env: limitsEnv({ USDT: '10' }) }));
      await expect(guards.beforeUserMoneyWithdrawal(withdrawalCtx({ amount: amt('1') }))).resolves.toBeUndefined();
      const unset = composeGuards(createW5HaltsGuards({ sql, env: limitsEnv({ BTC: '10' }) }));
      await expect(unset.beforeUserMoneyWithdrawal(withdrawalCtx())).rejects.toMatchObject({ code: 'pay.guard_treasury_limit_unset' });
      await seedInFlight();
      for (const replay of [
        { kind: 'recovery', reason: 'withdrawal_hold_booked' },
        { kind: 'replay', reason: 'withdrawal_already_sent' },
      ] as const)
        await expect(
          guards.beforeUserMoneyWithdrawal(withdrawalCtx({ amount: amt('99'), replay: replay as never })),
        ).resolves.toBeUndefined();
    });

    it('required: a retry of a pending claim (no hold yet) is not counted twice against itself', async () => {
      await seedInFlight(); // 7 in flight, of which u2/c2 is 3 and pending
      const guards = composeGuards(createW5HaltsGuards({ sql, env: limitsEnv({ USDT: '7' }) }));
      await expect(
        guards.beforeUserMoneyWithdrawal(withdrawalCtx({ userId: 'u2', clientRef: 'c2', amount: amt('3') })),
      ).resolves.toBeUndefined();
      await expect(
        guards.beforeUserMoneyWithdrawal(withdrawalCtx({ userId: 'u-other', clientRef: 'c2', amount: amt('3') })),
      ).rejects.toMatchObject({ code: 'pay.guard_treasury_exposure_exceeded' });
    });

    it('required: limit enforcement runs end to end through UserMoneyService and leaves no claim behind', async () => {
      const money = new UserMoneyService(sql, ledger, rails, {
        operatorCreditRails: ['card-sandbox'],
        guards: composeGuards(createW5HaltsGuards({ sql, env: limitsEnv({ USDT: '10' }) })),
      });
      await money.credit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('50'),
        rail: 'card-sandbox',
        railRef: 'seed',
        creditedBy: '99999999-9999-4999-8999-999999999999',
      });
      const request = (amount: string, clientRef: string) => ({
        userId: USER,
        assetId: 'USDT',
        amount: amt(amount),
        rail: 'card-sandbox',
        destination: { kind: 'bank', ref: 'DE89370400440532013000' },
        clientRef,
      });
      await expect(money.withdraw(request('11', 'too-big'))).rejects.toMatchObject({ code: 'pay.guard_treasury_exposure_exceeded' });
      expect(await sql`SELECT 1 FROM pay.withdrawals`).toHaveLength(0);
      expect((await money.withdraw(request('10', 'fits'))).status).toBe('sent');
    });

    it('required: a failed withdrawal retried while a fresh one arrives at the limit admits exactly one', async () => {
      const PAUSE_KEY = 4_242_424;
      const retrier = '22222222-2222-4222-8222-222222222222';
      const fresher = '33333333-3333-4333-8333-333333333333';
      // Exposure counts money IN FLIGHT (`pending`/`held`); a `sent` withdrawal has left and no
      // longer counts. So "exactly one" only holds while the retry is still in flight when the fresh
      // reads exposure. Hold the retry at its rail call until the fresh has its answer. Without this
      // gate a slow runner can let the retry reach `sent` first, and the fresh is then (correctly)
      // admitted: CI run 38740465686.
      let releaseRetryRail!: () => void;
      const retryRailGate = new Promise<void>((resolve) => (releaseRetryRail = resolve));
      const card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
      const cardPayout = card.payout.bind(card);
      card.payout = async (request) => {
        if (request.merchantId === retrier) await retryRailGate;
        return cardPayout(request);
      };
      const money = new UserMoneyService(sql, ledger, new RailRegistry([card, crypto, new BankPayoutAbsentAdapter()]), {
        operatorCreditRails: ['card-sandbox'],
        guards: composeGuards(createW5HaltsGuards({ sql, env: limitsEnv({ USDT: '10' }) })),
      });
      for (const userId of [retrier, fresher])
        await money.credit({
          userId,
          assetId: 'USDT',
          amount: amt('50'),
          rail: 'card-sandbox',
          railRef: `seed-${userId}`,
          creditedBy: '99999999-9999-4999-8999-999999999999',
        });
      const bank = { kind: 'bank', ref: 'DE89370400440532013000' };
      // The retrier's earlier attempt was refused by the rail: terminal `failed`, attempts advanced.
      await sql`INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status, attempts, failure_code)
        VALUES (${retrier}, 'USDT', 10, 'card-sandbox', ${sql.json(bank)}, 'retry-me', 'failed', 1, 'rail.failed')`;

      // Test-only barrier. The failed -> pending reset parks on a session advisory lock this test
      // holds. Wherever the reset runs, the paused retry is observable and deterministic: inside the
      // claim transaction (the fix) it still holds the treasury lock; outside it (the bug) it does not.
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION pay.test_pause_failed_retry() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.status = 'failed' AND NEW.status = 'pending' THEN
            PERFORM pg_advisory_lock(${PAUSE_KEY});
            PERFORM pg_advisory_unlock(${PAUSE_KEY});
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_pause_failed_retry BEFORE UPDATE ON pay.withdrawals
          FOR EACH ROW EXECUTE FUNCTION pay.test_pause_failed_retry();`);
      const holder = postgres(db.url, { max: 1, onnotice: () => undefined });
      const held = await holder.reserve();
      const waiters = async (atLeast: number) => {
        for (let i = 0; i < 250; i++) {
          const [row] = await sql<Array<{ n: number }>>`
            SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
          if (row!.n >= atLeast) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`fewer than ${atLeast} sessions are waiting on an advisory lock`);
      };
      const request = (userId: string, clientRef: string) => ({
        userId,
        assetId: 'USDT',
        amount: amt('10'),
        rail: 'card-sandbox',
        destination: bank,
        clientRef,
      });
      try {
        await held`SELECT pg_advisory_lock(${PAUSE_KEY})`;
        const retry = money.withdraw(request(retrier, 'retry-me')).then(
          (r) => r.status,
          (e: { code?: string }) => `refused ${e.code}`,
        );
        await waiters(1); // the retry is parked at the reset, past the guard
        const fresh = money.withdraw(request(fresher, 'fresh')).then(
          (r) => r.status,
          (e: { code?: string }) => `refused ${e.code}`,
        );
        // The fresh withdrawal must be QUEUED behind the retry's treasury lock. Under the bug it is not
        // (the retry's lock is already gone), so this never reaches two and the test fails here.
        await waiters(2);
        await held`SELECT pg_advisory_unlock(${PAUSE_KEY})`;

        // The retry is parked at its rail call (claimed, held, still counted), so the fresh one,
        // which reads exposure once the retry's claim commits, must see it and be refused.
        expect(await fresh).toBe('refused pay.guard_treasury_exposure_exceeded');
        releaseRetryRail();
        expect(await retry).toBe('sent');
      } finally {
        releaseRetryRail();
        await held`SELECT pg_advisory_unlock_all()`;
        held.release();
        await holder.end({ timeout: 5 });
        await sql.unsafe(
          `DROP TRIGGER IF EXISTS test_pause_failed_retry ON pay.withdrawals; DROP FUNCTION IF EXISTS pay.test_pause_failed_retry();`,
        );
      }
      const sent = await sql<
        Array<{ total: string }>
      >`SELECT COALESCE(SUM(amount), 0)::text AS total FROM pay.withdrawals WHERE status = 'sent'`;
      expect(sent[0]!.total).toBe('10.000000000000000000');
      expect(await sql`SELECT 1 FROM pay.withdrawals WHERE user_id = ${fresher}`).toHaveLength(0);
      // Longer than the ~5 s `waiters` budget, so a regression fails with its message, not a timeout.
    }, 15_000);

    it('off (the default): withdrawals are not limit-checked, with no limits or with limits that would be exceeded', async () => {
      await seedInFlight();
      for (const env of [{}, { PAY_TREASURY_EXPOSURE_LIMITS: JSON.stringify({ USDT: '1' }) }]) {
        const guards = composeGuards(createW5HaltsGuards({ sql, env }));
        await expect(guards.beforeUserMoneyWithdrawal(withdrawalCtx({ amount: amt('999999') }))).resolves.toBeUndefined();
      }
    });
  });

  describe('PAY_TREASURY_LIMITS flag', () => {
    it('defaults to off, accepts only off or required, and any other value fails boot', () => {
      expect(loadTreasuryMode({})).toBe('off');
      expect(loadTreasuryMode({ PAY_TREASURY_LIMITS: 'off' })).toBe('off');
      expect(loadTreasuryMode({ PAY_TREASURY_LIMITS: 'required' })).toBe('required');
      for (const bad of ['', 'on', 'true', 'Required', 'OFF', ' required']) {
        expect(() => loadTreasuryMode({ PAY_TREASURY_LIMITS: bad })).toThrow(/off.*required/);
        expect(() => createW5HaltsGuards({ sql, env: { PAY_TREASURY_LIMITS: bad } })).toThrow();
      }
    });

    it('off: payouts and conversions are not limit-checked (no limits, or limits that would be exceeded), halts still apply, exposure is still readable', async () => {
      const m = await open().createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      const settlement = await settledWindow(m.id, '10', 'w-off');
      // Limit of 1 would refuse a 10 payout under `required`.
      const env = { PAY_TREASURY_EXPOSURE_LIMITS: JSON.stringify({ USDT: '1' }) };
      crashOnPayout = true;
      await expect(
        service(env).payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST }),
      ).rejects.toThrow('process died');
      const view = await treasuryExposureView(sql, loadTreasuryLimits(env), { wired: false, openInventory: async () => 0n });
      expect(view).toEqual([{ assetCode: 'USDT', openConversionInventory: null, pendingPayouts: '10', limit: '1' }]);
      const paid = await service({}).payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST });
      expect(paid.status).toBe('paid_out');

      const conv = composeGuards(createW5HaltsGuards({ sql, env: {} }));
      await expect(
        conv.beforeConversion({
          sql: sql as never,
          tx: sql as never,
          merchantId: randomUUID(),
          settlementId: randomUUID(),
          fromAsset: 'USD',
          toAsset: 'USDT',
          fromAmount: amt('999999'),
          replay: FRESH,
        }),
      ).resolves.toBeUndefined();

      // Halts are always on, whatever the flag says.
      await sql`INSERT INTO pay.halts (scope, target, halted, reason, source, actor_user_id, version) VALUES ('conversion', 'global', true, 'drill', 'operator', ${USER}, 1)`;
      await expect(
        conv.beforeConversion({
          sql: sql as never,
          tx: sql as never,
          merchantId: randomUUID(),
          settlementId: randomUUID(),
          fromAsset: 'USD',
          toAsset: 'USDT',
          fromAmount: 1n,
          replay: FRESH,
        }),
      ).rejects.toMatchObject({ code: 'pay.guard_halted' });
    });

    it('required: unset limits refuse (covered above) and a user withdrawal in flight counts toward exposure', async () => {
      await sql`INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, status, rail_ref) VALUES
        ('u1', 'USDT', 4, 'crypto-native', '{}'::jsonb, 'c1', 'held', NULL),
        ('u2', 'USDT', 3, 'crypto-native', '{}'::jsonb, 'c2', 'pending', NULL),
        ('u3', 'USDT', 100, 'crypto-native', '{}'::jsonb, 'c3', 'sent', 'ref-3'),
        ('u4', 'USDT', 100, 'crypto-native', '{}'::jsonb, 'c4', 'failed', NULL)`;
      const view = await treasuryExposureView(sql, loadTreasuryLimits(limitsEnv({ USDT: '10' })), {
        wired: false,
        openInventory: async () => 0n,
      });
      expect(view).toEqual([{ assetCode: 'USDT', openConversionInventory: null, pendingPayouts: '7', limit: '10' }]);
      const m = await open().createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      const settlement = await settledWindow(m.id, `3.${'0'.repeat(17)}1`, 'w-wd');
      await expect(
        service(limitsEnv({ USDT: '10' })).payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST }),
      ).rejects.toMatchObject({ code: 'pay.guard_treasury_exposure_exceeded' });
    });
  });
});
