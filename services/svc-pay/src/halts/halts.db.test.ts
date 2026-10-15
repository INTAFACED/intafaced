import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayService } from '../payment-service.js';
import { truncatePayForTest } from '../payment-events-test-reset.js';
import { memoryPayoutDestinations } from '../merchant-payout-destination.js';
import { RailRegistry } from '../rails/registry.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { CryptoNativeAdapter } from '../rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from '../rails/bank-payout.js';
import { MemoryChain } from '../rails/chain-port.js';
import { railFailure } from '../rails/rail-adapter.js';
import { FRESH, composeGuards, type GuardReplay } from '../seams/guards.js';
import { createW5HaltsGuards } from '../seams/slots/w5-halts.js';
import { loadHaltAutoTripConfig } from './config.js';
import { createHaltGuards } from './guards.js';
import { PayHaltStore } from './store.js';

/**
 * W5 halts against a real Postgres. Two SEPARATE pools stand in for two replicas:
 * they share nothing but the database.
 */
const here = dirname(fileURLToPath(import.meta.url));
const migrations = [
  '0000_pay_init.sql',
  '0001_pay_user_money.sql',
  '0002_pay_payment_links.sql',
  '0003_pay_checkout_sessions.sql',
  '0005_pay_merchant_kyb.sql',
  '0006_pay_merchant_status_history.sql',
  '0014_pay_merchant_payout_destinations.sql',
  '0018_pay_founder_controls_admission.sql',
  '0058_pay_halts.sql',
  '0059_pay_treasury_exposure_indexes.sql',
].map((f) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8'));

const SECRET = 'svc-pay-halts-test-secret-at-least-32-characters';
const USER = '11111111-1111-4111-8111-111111111111';
const FOUNDER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOUNDER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEST = { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' };
const GLOBAL = { level: 'global' } as const;

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_halts_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const setInput = (over: Partial<Parameters<PayHaltStore['set']>[1]> = {}): Parameters<PayHaltStore['set']>[1] => ({
  requestId: randomUUID(),
  scope: 'intake',
  target: GLOBAL,
  halted: true,
  reason: 'drill',
  expectedVersion: '0',
  ...over,
});

describe('W5 halts store and guards (real Postgres, two replica pools)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let poolA!: postgres.Sql;
  let poolB!: postgres.Sql;
  let ledger: MemoryLedger;
  let chain: MemoryChain;
  let crypto: CryptoNativeAdapter;
  let rails: RailRegistry;
  let crashOnPayout = false;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    poolA = db.sql;
    poolB = postgres(db.url, { max: 3, connection: { search_path: 'pay,public' }, onnotice: () => undefined });
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(
      poolA,
      'pay',
      `TRUNCATE pay.halts, pay.halt_events, pay.halt_clear_requests, pay.halt_failure_streaks, pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants RESTART IDENTITY CASCADE`,
    );
    ledger = new MemoryLedger();
    chain = new MemoryChain();
    crypto = new CryptoNativeAdapter({ chain, secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 });
    // A process death AFTER the hold is on the ledger and BEFORE the rail answers.
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
    await poolB?.end({ timeout: 5 });
    await db?.drop();
    await adminStop();
  }, 30_000);

  const storeOn = (sql: postgres.Sql, env: Record<string, string> = {}) => new PayHaltStore(sql, loadHaltAutoTripConfig(env));
  /** A replica: its own pool, its own store and guards. */
  const replica = (sql: postgres.Sql, env: Record<string, string> = {}) => ({
    store: storeOn(sql, env),
    guards: composeGuards(createHaltGuards({ sql, store: storeOn(sql, env) })),
  });
  const payService = (guards: ReturnType<typeof composeGuards>, sql: postgres.Sql = poolA) =>
    new PayService(sql, ledger, rails, { payoutDestinations: memoryPayoutDestinations(), guards });

  async function capturedCryptoPayment(pay: PayService, merchantId: string, amount: string) {
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
    return created;
  }
  const settle = (pay: PayService, merchantId: string, window: string) =>
    pay.settleWindow({
      merchantId,
      window,
      assetId: 'USDT',
      from: new Date(Date.now() - 24 * 3600_000),
      to: new Date(Date.now() + 24 * 3600_000),
    });
  const paymentRows = async () => (await poolA`SELECT id FROM pay.payments`).length;

  const paymentCtx = (tx: postgres.Sql, merchantId: string, replay: GuardReplay = FRESH) => ({
    tx: tx as never,
    kind: 'payment.create' as const,
    paymentId: randomUUID(),
    merchantId,
    payload: {},
    replay,
  });

  describe('shared store', () => {
    it('a halt set through replica A is seen by replica B (separate pools)', async () => {
      const a = replica(poolA);
      const b = replica(poolB);
      const merchant = randomUUID();
      await expect(b.guards.beforePaymentAdmit(paymentCtx(poolB, merchant))).resolves.toBeUndefined();

      const result = await a.store.set(FOUNDER_A, setInput({ reason: 'venue incident' }));
      expect(result.outcome).toBe('changed');
      expect(result.state).toMatchObject({ halted: true, source: 'operator', actorUserId: FOUNDER_A, version: '1' });

      await expect(b.guards.beforePaymentAdmit(paymentCtx(poolB, merchant))).rejects.toMatchObject({
        code: 'pay.guard_halted',
        kind: 'unavailable',
      });
      expect((await b.store.status()).states.find((s) => s.scope === 'intake')).toMatchObject({ halted: true });
    });

    it('a direct call to svc-pay (no edge in front) is refused while halted, and leaves nothing behind', async () => {
      const a = replica(poolA);
      const pay = payService(a.guards);
      const m = await payService(composeGuards()).createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      await a.store.set(FOUNDER_A, setInput());
      await expect(
        pay.createPayment({ merchantId: m.id, amount: amt('5'), assetId: 'USDT', method: 'crypto', railAdapter: 'crypto-native' }),
      ).rejects.toMatchObject({ code: 'pay.guard_halted' });
      expect(await paymentRows()).toBe(0);
    });

    it('an unreadable halt store refuses (fail closed), with the store-unavailable code', async () => {
      const dead = postgres(db.url, { max: 1, connection: { search_path: 'pay,public' }, onnotice: () => undefined });
      await dead.end();
      const broken = replica(dead);
      await expect(broken.guards.beforePaymentAdmit(paymentCtx(dead, randomUUID()))).rejects.toMatchObject({
        code: 'pay.guard_halt_store_unavailable',
        kind: 'unavailable',
      });
      expect(await broken.store.status()).toMatchObject({ readable: false });
      expect((await broken.store.status()).states.every((s) => s.halted)).toBe(true);

      // And through the real service, with the halt table itself gone from under it.
      const m = await payService(composeGuards()).createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      await poolA`ALTER TABLE pay.halts RENAME TO halts_offline`;
      try {
        await expect(
          payService(replica(poolA).guards).createPayment({
            merchantId: m.id,
            amount: amt('5'),
            assetId: 'USDT',
            method: 'crypto',
            railAdapter: 'crypto-native',
          }),
        ).rejects.toMatchObject({ code: 'pay.guard_halt_store_unavailable' });
        expect(await paymentRows()).toBe(0);
      } finally {
        await poolA`ALTER TABLE pay.halts_offline RENAME TO halts`;
      }
    });

    it('a missing halts table (migration not applied) is also a refusal, not a pass', async () => {
      const bare = await createTestDatabase({ service: 'pay', url: db.url, migrations: [] });
      try {
        const g = replica(bare.sql);
        await expect(g.guards.beforePaymentAdmit(paymentCtx(bare.sql, randomUUID()))).rejects.toMatchObject({
          code: 'pay.guard_halt_store_unavailable',
        });
      } finally {
        await bare.drop();
      }
    });
  });

  describe('granularity', () => {
    it('halting conversion leaves intake, payout and settlement running', async () => {
      const g = replica(poolA);
      await g.store.set(FOUNDER_A, setInput({ scope: 'conversion' }));
      const merchant = randomUUID();
      const conversion = {
        sql: poolA as never,
        merchantId: merchant,
        settlementId: randomUUID(),
        fromAsset: 'USD',
        toAsset: 'USDT',
        fromAmount: 1n,
        replay: FRESH,
      };
      await expect(g.guards.beforeConversion(conversion)).rejects.toMatchObject({ code: 'pay.guard_halted' });
      await expect(g.guards.beforePaymentAdmit(paymentCtx(poolA, merchant))).resolves.toBeUndefined();
      await expect(
        g.guards.beforeSettlementRun({ sql: poolA as never, phase: 'prepare', merchantId: merchant, replay: FRESH }),
      ).resolves.toBeUndefined();
      await expect(
        g.guards.beforeUserMoneyWithdrawal({
          tx: poolA as never,
          userId: 'u',
          assetId: 'USDT',
          amount: 1n,
          rail: 'crypto-native',
          destination: DEST,
          clientRef: 'c',
          replay: FRESH,
        }),
      ).resolves.toBeUndefined();
    });

    it('a per-merchant halt stops that merchant only; the global switch stops everyone', async () => {
      const g = replica(poolA);
      const pay = payService(composeGuards());
      const m1 = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      const m2 = await pay.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 } });
      await g.store.set(FOUNDER_A, setInput({ target: { level: 'merchant', merchantId: m1.id } }));
      await expect(g.guards.beforePaymentAdmit(paymentCtx(poolA, m1.id))).rejects.toMatchObject({ code: 'pay.guard_halted' });
      await expect(g.guards.beforePaymentAdmit(paymentCtx(poolA, m2.id))).resolves.toBeUndefined();
      await g.store.set(FOUNDER_A, setInput({ scope: 'intake', target: GLOBAL }));
      await expect(g.guards.beforePaymentAdmit(paymentCtx(poolA, m2.id))).rejects.toMatchObject({ code: 'pay.guard_halted' });
    });

    it('a halt for a merchant that does not exist is refused, not silently stored', async () => {
      await expect(
        storeOn(poolA).set(FOUNDER_A, setInput({ target: { level: 'merchant', merchantId: randomUUID() } })),
      ).rejects.toMatchObject({
        code: 'pay.halt_target_not_found',
      });
    });
  });

  describe('replay and recovery pass through a halt; fresh work does not', () => {
    it('every scope halted: fresh refused, replay and recovery pass, refund is never halted', async () => {
      const g = replica(poolA);
      for (const scope of ['intake', 'conversion', 'payout', 'settlement'] as const) await g.store.set(FOUNDER_A, setInput({ scope }));
      const merchant = randomUUID();
      const replay: GuardReplay = { kind: 'replay', reason: 'payment_exists' };
      const recovery: GuardReplay = { kind: 'recovery', reason: 'payout_hold_booked' };
      const exec = (r: GuardReplay) => ({
        sql: poolA as never,
        settlementId: randomUUID(),
        merchantId: merchant,
        assetId: 'USDT',
        amount: 1n,
        railId: 'crypto-native',
        destination: DEST,
        attempt: 0,
        replay: r,
      });
      await expect(g.guards.beforePayoutExecute(exec(FRESH))).rejects.toMatchObject({ code: 'pay.guard_halted' });
      await expect(g.guards.beforePayoutExecute(exec(recovery))).resolves.toBeUndefined();
      await expect(g.guards.beforePaymentAdmit(paymentCtx(poolA, merchant, replay))).resolves.toBeUndefined();
      await expect(
        g.guards.beforeSettlementRun({
          sql: poolA as never,
          phase: 'post',
          merchantId: merchant,
          replay: { kind: 'recovery', reason: 'window_frozen_not_posted' },
        }),
      ).resolves.toBeUndefined();
      await expect(
        g.guards.beforeSettlementRun({ sql: poolA as never, phase: 'prepare', merchantId: merchant, replay: FRESH }),
      ).rejects.toMatchObject({ code: 'pay.guard_halted' });
      await expect(
        g.guards.beforeRefund({ tx: poolA as never, paymentId: 'p', merchantId: merchant, assetId: 'USDT', amount: 1n, replay: FRESH }),
      ).resolves.toBeUndefined();
    });

    it('a recovery does not even read the store, so an unreadable store cannot strand a booked hold', async () => {
      const dead = postgres(db.url, { max: 1, onnotice: () => undefined });
      await dead.end();
      const g = replica(dead);
      await expect(
        g.guards.beforePayoutExecute({
          sql: dead as never,
          settlementId: randomUUID(),
          merchantId: randomUUID(),
          assetId: 'USDT',
          amount: 1n,
          railId: 'crypto-native',
          destination: DEST,
          attempt: 0,
          replay: { kind: 'recovery', reason: 'payout_hold_booked' },
        }),
      ).resolves.toBeUndefined();
    });

    it('end to end: a payout that crashed after its hold finishes under a payout halt; a fresh payout is stopped', async () => {
      const g = replica(poolA);
      const pay = payService(g.guards);
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      await capturedCryptoPayment(pay, m.id, '10');
      const first = await settle(pay, m.id, 'w-first');
      crashOnPayout = true;
      await expect(pay.payoutSettlement({ settlementId: first.id, railId: 'crypto-native', destination: DEST })).rejects.toThrow(
        'process died',
      );
      expect(chain.outboundTransfers()).toHaveLength(0);

      await capturedCryptoPayment(pay, m.id, '7');
      const second = await settle(pay, m.id, 'w-second');
      await g.store.set(FOUNDER_A, setInput({ scope: 'payout' }));

      // New work is stopped...
      await expect(pay.payoutSettlement({ settlementId: second.id, railId: 'crypto-native', destination: DEST })).rejects.toMatchObject({
        code: 'pay.guard_halted',
      });
      // ...but the payout whose hold is already booked is allowed to finish.
      const done = await pay.payoutSettlement({ settlementId: first.id, railId: 'crypto-native', destination: DEST });
      expect(done.status).toBe('paid_out');
      expect(chain.outboundTransfers()).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  describe('auto-trip', () => {
    it('is OFF with no count configured: nothing trips and status says so', async () => {
      const store = storeOn(poolA);
      expect(store.autoTripPosture()).toEqual({ enabled: false, consecutiveFailures: null });
      for (let i = 0; i < 25; i++) expect(await store.recordFailure('conversion', GLOBAL, 'venue:x')).toMatchObject({ tripped: false });
      expect((await store.operatorStatus()).autoTrip).toEqual({ enabled: false, consecutiveFailures: null });
      expect(await poolA`SELECT 1 FROM pay.halts`).toHaveLength(0);
      for (const bad of ['', '0', '-3', 'three', '2.5'])
        expect(loadHaltAutoTripConfig({ PAY_HALT_AUTOTRIP_FAILURES: bad }).failures).toBeNull();
    });

    it('consecutive failures trip the scope at N, a success in between resets, and replicas share the count', async () => {
      const a = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '3' });
      const b = storeOn(poolB, { PAY_HALT_AUTOTRIP_FAILURES: '3' });
      expect(await a.recordFailure('conversion', GLOBAL, 'venue:binance')).toMatchObject({ tripped: false, consecutiveFailures: 1 });
      await b.recordSuccess('conversion', GLOBAL, 'venue:binance');
      expect(await a.recordFailure('conversion', GLOBAL, 'venue:binance')).toMatchObject({ consecutiveFailures: 1 });
      expect(await b.recordFailure('conversion', GLOBAL, 'venue:binance')).toMatchObject({ tripped: false, consecutiveFailures: 2 });
      expect(await a.recordFailure('conversion', GLOBAL, 'venue:binance')).toMatchObject({ tripped: true, consecutiveFailures: 3 });
      const op = await b.operatorStatus();
      expect(op.states.find((s) => s.scope === 'conversion')).toMatchObject({ halted: true, source: 'auto_trip', actorUserId: null });
      expect(op.autoTrip).toEqual({ enabled: true, consecutiveFailures: 3 });
      const history = await a.history({ limit: 10 });
      expect(history[0]).toMatchObject({ scope: 'conversion', halted: true, source: 'auto_trip', actorUserId: null });
    });

    it('a failure storm trips within N and the loop stops (no runaway), then a dual-controlled clear starts the count again', async () => {
      const N = 3;
      const env = { PAY_HALT_AUTOTRIP_FAILURES: String(N), PAY_TREASURY_EXPOSURE_LIMITS: JSON.stringify({ USDT: '1000000' }) };
      const guards = createW5HaltsGuards({ sql: poolA, env });
      const store = storeOn(poolA, env);
      const pay = payService(composeGuards(guards));
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      await capturedCryptoPayment(pay, m.id, '10');
      const settlement = await settle(pay, m.id, 'w-storm');

      // The rail answers every payout with a clean refusal, and counts how often it is asked.
      let railCalls = 0;
      crypto.payout = async (request) => {
        railCalls++;
        return railFailure({
          railRef: '',
          amount: request.amount,
          assetId: request.assetId,
          failureCode: 'rail.down',
          failureReason: 'rail down',
        });
      };
      let iterations = 0;
      let stoppedBy: unknown = null;
      while (iterations < 200) {
        iterations++;
        try {
          await pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST });
        } catch (error) {
          if ((error as { code?: string }).code === 'pay.guard_halted') {
            stoppedBy = error;
            break;
          }
        }
      }
      // N rail refusals reached the rail; the next attempt was stopped before it.
      expect(railCalls).toBe(N);
      expect(iterations).toBe(N + 1);
      expect(stoppedBy).toMatchObject({ code: 'pay.guard_halted' });
      const op = await store.operatorStatus();
      expect(op.states.find((s) => s.scope === 'payout' && s.target.level === 'global')).toMatchObject({
        halted: true,
        source: 'auto_trip',
        actorUserId: null,
      });
      expect(ledger.reconcile()).toEqual({ ok: true });

      // One founder cannot clear it; two can. Old failures do not re-trip it.
      const version = op.states.find((s) => s.scope === 'payout')!.version;
      const clearId = randomUUID();
      const clear = setInput({ requestId: clearId, scope: 'payout', halted: false, expectedVersion: version, reason: 'rail repaired' });
      expect((await store.set(FOUNDER_A, clear)).outcome).toBe('pending_confirmation');
      expect((await store.set(FOUNDER_B, clear)).outcome).toBe('changed');
      await expect(pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST })).rejects.toMatchObject(
        {
          code: 'pay.rail_failed',
        },
      );
      expect(railCalls).toBe(N + 1);
    });
  });

  describe('operator set and dual-controlled clear', () => {
    it('setting needs one founder and is immediate; a retry of the same request is a noop', async () => {
      const store = storeOn(poolA);
      const input = setInput({ scope: 'payout' });
      expect((await store.set(FOUNDER_A, input)).outcome).toBe('changed');
      expect((await store.set(FOUNDER_A, input)).outcome).toBe('noop');
      expect((await store.history({ limit: 10 })).filter((e) => e.scope === 'payout')).toHaveLength(1);
    });

    it('a stale expectedVersion is a conflict and changes nothing', async () => {
      const store = storeOn(poolA);
      await store.set(FOUNDER_A, setInput());
      const stale = await store.set(FOUNDER_B, setInput({ scope: 'intake', halted: true, expectedVersion: '0' }));
      expect(stale.outcome).toBe('conflict');
      expect((await store.history({ limit: 10 })).length).toBe(1);
    });

    it('clearing: one founder alone, or the same founder twice, does not clear; a second distinct founder does', async () => {
      const store = storeOn(poolA);
      await store.set(FOUNDER_A, setInput({ reason: 'incident' }));
      const clear = setInput({ halted: false, expectedVersion: '1', reason: 'all clear' });

      const first = await store.set(FOUNDER_A, clear);
      expect(first.outcome).toBe('pending_confirmation');
      expect(first.state.halted).toBe(true);
      expect((await store.set(FOUNDER_A, clear)).outcome).toBe('pending_confirmation');
      expect((await store.operatorStatus()).states.find((s) => s.scope === 'intake')!.halted).toBe(true);

      // A different request id is a new proposal, not a confirmation.
      expect((await store.set(FOUNDER_B, { ...clear, requestId: randomUUID() })).outcome).toBe('pending_confirmation');

      const second = await store.set(FOUNDER_B, clear);
      expect(second.outcome).toBe('changed');
      expect(second.state).toMatchObject({ halted: false, version: '2' });
      expect((await store.set(FOUNDER_B, clear)).outcome).toBe('noop');

      const history = await store.history({ scope: 'intake', limit: 10 });
      expect(history.map((e) => [e.halted, e.actorUserId, e.confirmedByUserId, e.source, e.reason])).toEqual([
        [false, FOUNDER_A, FOUNDER_B, 'operator', 'all clear'],
        [true, FOUNDER_A, null, 'operator', 'incident'],
      ]);
    });

    it('a confirmation of a changed target is a conflict, and an expired proposal cannot be confirmed', async () => {
      const store = storeOn(poolA);
      await store.set(FOUNDER_A, setInput());
      const clear = setInput({ halted: false, expectedVersion: '1' });
      await store.set(FOUNDER_A, clear);
      await poolA`UPDATE pay.halt_clear_requests SET requested_at = now() - interval '2 hours' WHERE request_id = ${clear.requestId}`;
      expect((await store.set(FOUNDER_B, clear)).outcome).toBe('conflict');
      expect((await store.operatorStatus()).states.find((s) => s.scope === 'intake')!.halted).toBe(true);
    });

    it('history is append-only in the database, and halt rows cannot be deleted', async () => {
      const store = storeOn(poolA);
      await store.set(FOUNDER_A, setInput());
      await expect(poolA`UPDATE pay.halt_events SET reason = 'edited'`).rejects.toThrow();
      await expect(poolA`DELETE FROM pay.halt_events`).rejects.toThrow();
      await expect(poolA`DELETE FROM pay.halts`).rejects.toThrow();
    });
  });
});
