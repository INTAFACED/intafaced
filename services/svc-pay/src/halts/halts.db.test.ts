import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, merchantClearing, parseAmount as amt, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PayService } from '../payment-service.js';
import { UserMoneyService } from '../user-money-service.js';
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
import { autoTripAccountErrorCount, resetAutoTripAccountErrors } from './autotrip-log.js';
import { loadHaltAutoTripConfig } from './config.js';
import { createHaltGuards } from './guards.js';
import { PayHaltStore, userHaltKey } from './store.js';

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
  '0037_pay_withdrawal_rail_attempts.sql',
  '0058_pay_halts.sql',
  '0059_pay_treasury_exposure_indexes.sql',
  '0071_pay_merchant_names.sql',
  '0079_pay_halt_autotrip_window.sql',
].map((f) => readFileSync(join(here, '..', '..', 'drizzle', f), 'utf8'));

const SECRET = 'svc-pay-halts-test-secret-at-least-32-characters';
const USER = '11111111-1111-4111-8111-111111111111';
const FOUNDER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOUNDER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEST = { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' };
const BANK = { kind: 'bank', ref: 'DE89370400440532013000' };
const GLOBAL = { level: 'global' } as const;
const MERCHANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MERCHANT_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const merchantTarget = (merchantId: string) => ({ level: 'merchant' as const, merchantId });

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
      `TRUNCATE pay.halts, pay.halt_events, pay.halt_clear_requests, pay.halt_failure_streaks, pay.halt_autotrip_window, pay.halt_autotrip_counted, pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants, pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`,
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
  function openSpy() {
    const queries: string[] = [];
    const sql = postgres(db.url, {
      max: 2,
      connection: { search_path: 'pay,public' },
      onnotice: () => undefined,
      debug: (_connection, query, parameters) => {
        queries.push(`${String(query)} ${JSON.stringify(parameters ?? [])}`);
      },
    });
    return { sql, queries, end: () => sql.end({ timeout: 5 }) };
  }
  async function holdAutoTripLock(): Promise<() => Promise<void>> {
    const holder = postgres(db.url, { max: 1, onnotice: () => undefined });
    await holder`SELECT pg_advisory_lock(hashtext('pay.halt:autotrip'))`;
    return async () => {
      await holder`SELECT pg_advisory_unlock_all()`.catch(() => undefined);
      await holder.end({ timeout: 5 });
    };
  }
  /** A replica: its own pool, its own store and guards. */
  const replica = (sql: postgres.Sql, env: Record<string, string> = {}) => ({
    store: storeOn(sql, env),
    guards: composeGuards(createHaltGuards({ sql, ledger })),
  });
  const payService = (guards: ReturnType<typeof composeGuards>, sql: postgres.Sql = poolA, haltStore?: PayHaltStore) =>
    new PayService(sql, ledger, rails, { payoutDestinations: memoryPayoutDestinations(), guards, haltStore });

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

  describe('a halt stops fresh work and rail sends; bookkeeping recoveries and replays finish', () => {
    it('every scope halted: fresh refused, replay passes, bookkeeping recovery passes, a payout recovery (rail send) waits, refund is never halted', async () => {
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
      // A recovery that would call the rail is paused by a payout halt (its hold stays booked).
      await expect(g.guards.beforePayoutExecute(exec(recovery))).rejects.toMatchObject({ code: 'pay.guard_halted', kind: 'unavailable' });
      await expect(g.guards.beforePayoutExecute(exec(replay))).resolves.toBeUndefined();
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

    it('a bookkeeping recovery does not even read the store; a rail-send recovery needs a readable store', async () => {
      const dead = postgres(db.url, { max: 1, onnotice: () => undefined });
      await dead.end();
      const g = replica(dead);
      await expect(
        g.guards.beforeSettlementRun({
          sql: dead as never,
          phase: 'post',
          merchantId: randomUUID(),
          replay: { kind: 'recovery', reason: 'window_frozen_not_posted' },
        }),
      ).resolves.toBeUndefined();
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
      ).rejects.toMatchObject({ code: 'pay.guard_halt_store_unavailable' });
    });

    it('end to end: a payout that crashed after its hold is PAUSED by a payout halt (no rail call, still retryable) and finishes once the halt clears', async () => {
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
      const statusBefore = (await poolA`SELECT status, payout_attempts FROM pay.settlements WHERE id = ${first.id}`)[0]!;

      await capturedCryptoPayment(pay, m.id, '7');
      const second = await settle(pay, m.id, 'w-second');
      await g.store.set(FOUNDER_A, setInput({ scope: 'payout' }));
      const journalBefore = ledger.journal().length;

      // New work is stopped, and so is the resumed payout: both would call the rail.
      await expect(pay.payoutSettlement({ settlementId: second.id, railId: 'crypto-native', destination: DEST })).rejects.toMatchObject({
        code: 'pay.guard_halted',
      });
      let railCalls = 0;
      const realPayout = crypto.payout.bind(crypto);
      crypto.payout = async (request) => {
        railCalls += 1;
        return realPayout(request);
      };
      await expect(pay.payoutSettlement({ settlementId: first.id, railId: 'crypto-native', destination: DEST })).rejects.toMatchObject({
        code: 'pay.guard_halted',
      });
      expect(railCalls).toBe(0);
      expect(chain.outboundTransfers()).toHaveLength(0);
      // Paused, not failed: same status and attempt, no release or reverse, no outcome row.
      expect((await poolA`SELECT status, payout_attempts FROM pay.settlements WHERE id = ${first.id}`)[0]).toEqual(statusBefore);
      expect(ledger.journal().length).toBe(journalBefore);
      expect(
        await poolA`SELECT 1 FROM pay.payout_outcomes o JOIN pay.payout_admissions a ON a.id = o.admission_id WHERE a.settlement_id = ${first.id}`,
      ).toHaveLength(0);

      // The halt clears (two founders): the very same call completes.
      const clear = setInput({ scope: 'payout', halted: false, expectedVersion: '1', reason: 'rail repaired' });
      await g.store.set(FOUNDER_A, clear);
      expect((await g.store.set(FOUNDER_B, clear)).outcome).toBe('changed');
      const done = await pay.payoutSettlement({ settlementId: first.id, railId: 'crypto-native', destination: DEST });
      expect(done.status).toBe('paid_out');
      expect(railCalls).toBe(1);
      expect(chain.outboundTransfers()).toHaveLength(1);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  describe('user-money withdrawal and the payout halt', () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    const withdrawalCtx = (userId: string, replay: GuardReplay = FRESH, tx: postgres.Sql = poolA) => ({
      tx: tx as never,
      userId,
      assetId: 'USDT',
      amount: 1n,
      rail: 'crypto-native',
      destination: DEST,
      clientRef: randomUUID(),
      replay,
    });

    it('a global payout halt refuses every personal withdrawal; a merchant halt does not, until that merchant has a legacy settlement', async () => {
      const g = replica(poolA);
      const pay = payService(composeGuards());
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      await g.store.set(FOUNDER_A, setInput({ scope: 'payout', target: { level: 'merchant', merchantId: m.id } }));
      await expect(g.guards.beforeUserMoneyWithdrawal(withdrawalCtx(USER))).resolves.toBeUndefined();
      await expect(g.guards.beforeUserMoneyWithdrawal(withdrawalCtx(OTHER))).resolves.toBeUndefined();
      await capturedCryptoPayment(pay, m.id, '10');
      await settle(pay, m.id, 'proceeds-only');
      await expect(g.guards.beforeUserMoneyWithdrawal(withdrawalCtx(USER))).resolves.toBeUndefined();
      // An intake halt is not a payout halt.
      await poolA`TRUNCATE pay.halts, pay.halt_events RESTART IDENTITY CASCADE`;
      await g.store.set(FOUNDER_A, setInput({ scope: 'intake', target: { level: 'merchant', merchantId: m.id } }));
      await expect(g.guards.beforeUserMoneyWithdrawal(withdrawalCtx(USER))).resolves.toBeUndefined();
      await g.store.set(FOUNDER_A, setInput({ scope: 'payout' }));
      await expect(g.guards.beforeUserMoneyWithdrawal(withdrawalCtx(USER))).rejects.toMatchObject({
        code: 'pay.guard_halted',
        kind: 'unavailable',
      });
      await expect(g.guards.beforeUserMoneyWithdrawal(withdrawalCtx(OTHER))).rejects.toMatchObject({ code: 'pay.guard_halted' });
    });

    it('a dead halt store refuses a personal withdrawal', async () => {
      const dead = postgres(db.url, { max: 1, onnotice: () => undefined });
      await dead.end();
      await expect(replica(dead).guards.beforeUserMoneyWithdrawal(withdrawalCtx(USER, FRESH, dead))).rejects.toMatchObject({
        code: 'pay.guard_halt_store_unavailable',
        kind: 'unavailable',
      });
      await poolA`ALTER TABLE pay.merchants RENAME TO merchants_offline`;
      try {
        await expect(replica(poolA).guards.beforeUserMoneyWithdrawal(withdrawalCtx(USER))).rejects.toMatchObject({
          code: 'pay.guard_halt_store_unavailable',
        });
      } finally {
        await poolA`ALTER TABLE pay.merchants_offline RENAME TO merchants`;
      }
    });

    it('a recovery withdrawal waits for the clear; a replay (already sent) still returns', async () => {
      const g = replica(poolA);
      await g.store.set(FOUNDER_A, setInput({ scope: 'payout' }));
      await expect(
        g.guards.beforeUserMoneyWithdrawal(withdrawalCtx(OTHER, { kind: 'recovery', reason: 'withdrawal_hold_booked' })),
      ).rejects.toMatchObject({ code: 'pay.guard_halted' });
      await expect(
        g.guards.beforeUserMoneyWithdrawal(withdrawalCtx(OTHER, { kind: 'replay', reason: 'withdrawal_already_sent' })),
      ).resolves.toBeUndefined();
    });

    it('end to end: a merchant owner can withdraw a personal deposit while their merchant is payout-halted', async () => {
      const g = replica(poolA);
      const pay = payService(composeGuards());
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      const money = new UserMoneyService(poolA, ledger, rails, { operatorCreditRails: ['card-sandbox'], guards: g.guards });
      await money.credit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('50'),
        rail: 'card-sandbox',
        railRef: 'seed_1',
        creditedBy: FOUNDER_A,
      });
      await g.store.set(FOUNDER_A, setInput({ scope: 'payout', target: { level: 'merchant', merchantId: m.id } }));
      const request = { userId: USER, assetId: 'USDT', amount: amt('20'), rail: 'card-sandbox', destination: BANK, clientRef: 'w-halted' };
      const sent = await money.withdraw(request);
      expect(sent.status).toBe('sent');
      expect((await ledger.balance(userAvailable(USER, 'USDT'))).amount).toBe(amt('30'));
    });

    it('a merchant payout halt refuses the owner while a legacy settlement still debits their personal balance', async () => {
      const g = replica(poolA);
      const pay = payService(composeGuards());
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      await capturedCryptoPayment(pay, m.id, '10');
      const window = 'legacy-halt';
      await ledger.post({
        idempotencyKey: `settlement:${m.id}:${window}:USDT`,
        module: 'pay',
        reason: 'pay.settled',
        meta: { merchantId: m.id, window, assetId: 'USDT' },
        entries: [
          { account: merchantClearing(m.id, 'USDT'), direction: 'credit', amount: amt('10') },
          { account: userAvailable(USER, 'USDT'), direction: 'debit', amount: amt('10') },
        ],
      });
      const posted = await settle(pay, m.id, window);
      expect(posted.status).toBe('posted');
      await g.store.set(FOUNDER_A, setInput({ scope: 'payout', target: { level: 'merchant', merchantId: m.id } }));
      await expect(g.guards.beforeUserMoneyWithdrawal(withdrawalCtx(USER))).rejects.toMatchObject({ code: 'pay.guard_halted' });
      await expect(g.guards.beforeUserMoneyWithdrawal(withdrawalCtx(OTHER))).resolves.toBeUndefined();
    });

    it('a merchant payout halt refuses the owner while a pending row still has a pre-cutover post', async () => {
      const g = replica(poolA);
      const pay = payService(composeGuards());
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      await capturedCryptoPayment(pay, m.id, '10');
      const window = 'legacy-pending-halt';
      await ledger.post({
        idempotencyKey: `settlement:${m.id}:${window}:USDT`,
        module: 'pay',
        reason: 'pay.settled',
        meta: { merchantId: m.id, window, assetId: 'USDT' },
        entries: [
          { account: merchantClearing(m.id, 'USDT'), direction: 'credit', amount: amt('10') },
          { account: userAvailable(USER, 'USDT'), direction: 'debit', amount: amt('10') },
        ],
      });
      await poolA`
        INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status)
        VALUES (${m.id}, ${window}, 'USDT', 10, 0, 10, 'pending')
      `;
      await g.store.set(FOUNDER_A, setInput({ scope: 'payout', target: { level: 'merchant', merchantId: m.id } }));
      await expect(g.guards.beforeUserMoneyWithdrawal(withdrawalCtx(USER))).rejects.toMatchObject({ code: 'pay.guard_halted' });
      await expect(g.guards.beforeUserMoneyWithdrawal(withdrawalCtx(OTHER))).resolves.toBeUndefined();
    });
  });

  describe('a payout halt pauses rail sends, never withdrawal bookkeeping', () => {
    const request = { userId: USER, assetId: 'USDT', amount: amt('20'), rail: 'card-sandbox', destination: BANK, clientRef: 'w-recover' };
    let card: CardSandboxAdapter;
    let railCalls: number;
    let money: UserMoneyService;

    const available = async () => (await ledger.balance(userAvailable(USER, 'USDT'))).amount;
    const haltPayout = (g: ReturnType<typeof replica>) => g.store.set(FOUNDER_A, setInput({ scope: 'payout', reason: 'rail outage' }));
    const attemptOutcome = async () => (await poolA`SELECT outcome FROM pay.withdrawal_rail_attempts`).map((r) => r.outcome);
    const rowStatus = async () => (await poolA`SELECT status FROM pay.withdrawals`).map((r) => r.status);

    beforeEach(async () => {
      card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
      railCalls = 0;
      const realPayout = card.payout.bind(card);
      card.payout = async (instruction) => {
        railCalls++;
        return realPayout(instruction);
      };
      money = new UserMoneyService(poolA, ledger, new RailRegistry([card]), {
        operatorCreditRails: ['card-sandbox'],
        guards: replica(poolA).guards,
      });
      await money.credit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('50'),
        rail: 'card-sandbox',
        railRef: 'seed_recover',
        creditedBy: FOUNDER_A,
      });
    });

    it('rail accepted, settle lost, then halted: the retry settles from the receipt and the rail is not asked again', async () => {
      const realPost = ledger.post.bind(ledger);
      let lost = false;
      ledger.post = async (req) => {
        if (req.reason === 'withdraw.settled' && !lost) {
          lost = true;
          throw new Error('settle lost');
        }
        return realPost(req);
      };
      await expect(money.withdraw(request)).rejects.toMatchObject({ code: 'pay.ledger_outcome_unknown' });
      expect(await rowStatus()).toEqual(['held']);
      expect(await attemptOutcome()).toEqual(['accepted']);
      expect(railCalls).toBe(1);

      const g = replica(poolA);
      await haltPayout(g);
      // Fresh withdrawals are still refused, so the halt is genuinely on.
      await expect(money.withdraw({ ...request, clientRef: 'w-fresh' })).rejects.toMatchObject({ code: 'pay.guard_halted' });

      const done = await money.withdraw(request);
      expect(done.status).toBe('sent');
      expect(await rowStatus()).toEqual(['sent']);
      expect(railCalls).toBe(1);
      expect(await available()).toBe(amt('30'));
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('rail refused, reverse lost, then halted: the retry reverses the hold and the rail is not asked again', async () => {
      card.payout = async (instruction) => {
        railCalls++;
        return railFailure({
          railRef: 'refused_1',
          amount: instruction.amount,
          assetId: instruction.assetId,
          failureCode: 'card.declined',
          failureReason: 'declined',
        });
      };
      const realPost = ledger.post.bind(ledger);
      let lost = false;
      ledger.post = async (req) => {
        if (req.reason === 'withdraw.reversed' && !lost) {
          lost = true;
          throw new Error('process died before the reverse');
        }
        return realPost(req);
      };
      await expect(money.withdraw(request)).rejects.toThrow('process died before the reverse');
      expect(await rowStatus()).toEqual(['held']);
      expect(await attemptOutcome()).toEqual(['refused']);
      expect(await available()).toBe(amt('30'));

      await haltPayout(replica(poolA));
      await expect(money.withdraw(request)).rejects.toMatchObject({ code: 'pay.rail_failed' });
      expect(await rowStatus()).toEqual(['failed']);
      expect(railCalls).toBe(1);
      expect(await available()).toBe(amt('50'));
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('held with no rail outcome: a global payout halt refuses the retry that would call the rail', async () => {
      const realPayout = card.payout.bind(card);
      let died = false;
      card.payout = async (instruction) => {
        if (!died) {
          died = true;
          railCalls++;
          throw new Error('process died');
        }
        return realPayout(instruction); // the counting wrapper from beforeEach
      };
      await expect(money.withdraw(request)).rejects.toThrow('process died');
      expect(await rowStatus()).toEqual(['held']);
      expect(await attemptOutcome()).toEqual(['requested']);
      expect(railCalls).toBe(1);

      const g = replica(poolA);
      await haltPayout(g);
      // No rail receipt yet, so the retry would send. A global payout halt refuses that.
      await expect(money.withdraw(request)).rejects.toMatchObject({ code: 'pay.guard_halted' });
      expect(railCalls).toBe(1);
      expect(await rowStatus()).toEqual(['held']);
      expect(await available()).toBe(amt('30'));
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });

  describe('auto-trip', () => {
    const venue = merchantTarget(MERCHANT);

    it('is OFF with no count configured: nothing trips, nothing is armed, and status says so', async () => {
      const store = storeOn(poolA);
      expect(store.autoTripPosture()).toEqual({ enabled: false, consecutiveFailures: null });
      for (let i = 0; i < 25; i++) expect(await store.recordFailure('conversion', venue, 'venue:x')).toMatchObject({ tripped: false });
      expect((await store.operatorStatus()).autoTrip).toEqual({ enabled: false, consecutiveFailures: null });
      expect(await poolA`SELECT 1 FROM pay.halts`).toHaveLength(0);
      expect(await poolA`SELECT 1 FROM pay.halt_failure_streaks`).toHaveLength(0);
      expect(await poolA`SELECT 1 FROM pay.halt_autotrip_window`).toHaveLength(0);
      for (const bad of ['', '0', '-3', 'three', '2.5'])
        expect(loadHaltAutoTripConfig({ PAY_HALT_AUTOTRIP_FAILURES: bad }).failures).toBeNull();
    });

    it('a global target does not count and does not arm, even when a count is configured', async () => {
      const store = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '2' });
      expect(await store.recordFailure('payout', GLOBAL, 'rail:crypto-native')).toMatchObject({ tripped: false, consecutiveFailures: 0 });
      expect(await store.recordFailure('payout', GLOBAL, 'rail:crypto-native')).toMatchObject({ tripped: false, consecutiveFailures: 0 });
      expect(await poolA`SELECT 1 FROM pay.halts`).toHaveLength(0);
      expect(await poolA`SELECT 1 FROM pay.halt_failure_streaks`).toHaveLength(0);
      expect(await poolA`SELECT 1 FROM pay.halt_autotrip_window`).toHaveLength(0);
    });

    it('counts per merchant and per rail, and only the merchant that reached N is halted', async () => {
      const store = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '2' });
      const a = merchantTarget(MERCHANT);
      const b = merchantTarget(MERCHANT_B);
      expect(await store.recordFailure('payout', a, 'rail:crypto-native')).toMatchObject({ tripped: false, consecutiveFailures: 1 });
      expect(await store.recordFailure('payout', b, 'rail:crypto-native')).toMatchObject({ tripped: false, consecutiveFailures: 1 });
      expect(await store.recordFailure('payout', a, 'rail:card-sandbox')).toMatchObject({ tripped: false, consecutiveFailures: 1 });
      expect(await store.recordFailure('payout', a, 'rail:crypto-native')).toMatchObject({ tripped: true, consecutiveFailures: 2 });
      const op = await store.operatorStatus();
      expect(
        op.states.find((s) => s.scope === 'payout' && s.target.level === 'merchant' && s.target.merchantId === MERCHANT),
      ).toMatchObject({
        halted: true,
        source: 'auto_trip',
      });
      expect(
        op.states.find((s) => s.scope === 'payout' && s.target.level === 'merchant' && s.target.merchantId === MERCHANT_B),
      ).toBeUndefined();
      expect(op.states.find((s) => s.scope === 'payout' && s.target.level === 'global')).toMatchObject({ halted: false });
      const streaks = await poolA<{ source_key: string; consecutive_failures: string }[]>`
        SELECT source_key, consecutive_failures::text FROM pay.halt_failure_streaks WHERE target = ${MERCHANT} ORDER BY source_key
      `;
      expect(streaks).toEqual([
        { source_key: 'rail:card-sandbox', consecutive_failures: '1' },
        { source_key: 'rail:crypto-native', consecutive_failures: '2' },
      ]);
    });

    it('counts from the stored config time: a new process with the same count keeps it, and older failures do not add', async () => {
      const first = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '4' });
      await first.recordFailure('payout', venue, 'rail:crypto-native');
      await poolA`UPDATE pay.halt_autotrip_window SET effective_at = now() - interval '2 days'`;
      await poolA`
        UPDATE pay.halt_failure_streaks
           SET consecutive_failures = 9, last_failure_at = now() - interval '3 days'
         WHERE target = ${MERCHANT} AND source_key = 'rail:crypto-native'
      `;
      const beforeRows = await poolA<{ epoch: string }[]>`
        SELECT extract(epoch FROM effective_at)::text AS epoch FROM pay.halt_autotrip_window
      `;
      const before = beforeRows[0]?.epoch;
      const restarted = storeOn(poolB, { PAY_HALT_AUTOTRIP_FAILURES: '4' });
      expect(await restarted.recordFailure('payout', venue, 'rail:crypto-native')).toMatchObject({
        tripped: false,
        consecutiveFailures: 1,
      });
      const afterRows = await poolA<{ epoch: string }[]>`
        SELECT extract(epoch FROM effective_at)::text AS epoch FROM pay.halt_autotrip_window
      `;
      expect(afterRows[0]?.epoch).toBe(before);
      expect(before).toBeTruthy();
      expect(await poolA`SELECT 1 FROM pay.halts WHERE halted`).toHaveLength(0);
    });

    it('a different configured count starts a new window and does not keep the old streak', async () => {
      const first = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '3' });
      await first.recordFailure('payout', venue, 'rail:crypto-native');
      await first.recordFailure('payout', venue, 'rail:crypto-native');
      const next = storeOn(poolB, { PAY_HALT_AUTOTRIP_FAILURES: '5' });
      expect(await next.recordFailure('payout', venue, 'rail:crypto-native')).toMatchObject({
        tripped: false,
        consecutiveFailures: 1,
      });
      const [window] = await poolA<{ failures: string }[]>`SELECT failures::text FROM pay.halt_autotrip_window`;
      expect(window?.failures).toBe('5');
    });

    it('consecutive failures trip that merchant at N, a success in between resets, and replicas share the count', async () => {
      const a = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '3' });
      const b = storeOn(poolB, { PAY_HALT_AUTOTRIP_FAILURES: '3' });
      expect(await a.recordFailure('conversion', venue, 'venue:binance')).toMatchObject({ tripped: false, consecutiveFailures: 1 });
      await b.recordSuccess('conversion', venue, 'venue:binance');
      expect(await a.recordFailure('conversion', venue, 'venue:binance')).toMatchObject({ consecutiveFailures: 1 });
      expect(await b.recordFailure('conversion', venue, 'venue:binance')).toMatchObject({ tripped: false, consecutiveFailures: 2 });
      expect(await a.recordFailure('conversion', venue, 'venue:binance')).toMatchObject({ tripped: true, consecutiveFailures: 3 });
      const op = await b.operatorStatus();
      expect(op.states.find((s) => s.scope === 'conversion' && s.target.level === 'merchant')).toMatchObject({
        halted: true,
        source: 'auto_trip',
        actorUserId: null,
        target: { level: 'merchant', merchantId: MERCHANT },
      });
      expect(op.states.find((s) => s.scope === 'conversion' && s.target.level === 'global')).toMatchObject({ halted: false });
      expect(op.autoTrip).toEqual({ enabled: true, consecutiveFailures: 3 });
      const history = await a.history({ limit: 10 });
      expect(history[0]).toMatchObject({
        scope: 'conversion',
        halted: true,
        source: 'auto_trip',
        actorUserId: null,
        target: { level: 'merchant', merchantId: MERCHANT },
      });
    });

    it('a failure storm trips within N and the loop stops (no runaway), then a dual-controlled clear starts the count again', async () => {
      const N = 3;
      const env = { PAY_HALT_AUTOTRIP_FAILURES: String(N), PAY_TREASURY_EXPOSURE_LIMITS: JSON.stringify({ USDT: '1000000' }) };
      const guards = createW5HaltsGuards({ sql: poolA, env });
      const store = storeOn(poolA, env);
      const pay = payService(composeGuards(guards), poolA, store);
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
      const halted = op.states.find(
        (s) => s.scope === 'payout' && s.target.level === 'merchant' && s.target.merchantId === m.id.toLowerCase(),
      );
      expect(halted).toMatchObject({ halted: true, source: 'auto_trip', actorUserId: null });
      expect(op.states.find((s) => s.scope === 'payout' && s.target.level === 'global')).toMatchObject({ halted: false });
      expect(ledger.reconcile()).toEqual({ ok: true });

      // One founder cannot clear it; two can. Old failures do not re-trip it.
      const clearId = randomUUID();
      const clear = setInput({
        requestId: clearId,
        scope: 'payout',
        target: { level: 'merchant', merchantId: m.id },
        halted: false,
        expectedVersion: halted!.version,
        reason: 'rail repaired',
      });
      expect((await store.set(FOUNDER_A, clear)).outcome).toBe('pending_confirmation');
      expect((await store.set(FOUNDER_B, clear)).outcome).toBe('changed');
      await expect(pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST })).rejects.toMatchObject(
        {
          code: 'pay.rail_failed',
        },
      );
      expect(railCalls).toBe(N + 1);
    });

    it('a refused payout feeds that merchant and rail, and a later acceptance resets the streak', async () => {
      const store = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '5' });
      const pay = payService(composeGuards(createHaltGuards({ sql: poolA })), poolA, store);
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      const other = await pay.createMerchant({ userId: '22222222-2222-4222-8222-222222222222', pricing: { feeBps: 0 } });
      const wrapped = crypto.payout.bind(crypto);
      crypto.payout = async (request) =>
        railFailure({
          railRef: '',
          amount: request.amount,
          assetId: request.assetId,
          failureCode: 'rail.down',
          failureReason: 'rail down',
        });
      await capturedCryptoPayment(pay, m.id, '10');
      const failed = await settle(pay, m.id, 'w-fail');
      await expect(pay.payoutSettlement({ settlementId: failed.id, railId: 'crypto-native', destination: DEST })).rejects.toMatchObject({
        code: 'pay.rail_failed',
      });
      const streak = (merchantId: string) =>
        poolA<{ consecutive_failures: string }[]>`
          SELECT consecutive_failures::text FROM pay.halt_failure_streaks
           WHERE target = ${merchantId.toLowerCase()} AND source_key = 'rail:crypto-native'
        `;
      expect(await streak(m.id)).toEqual([{ consecutive_failures: '1' }]);
      expect(await streak(other.id)).toEqual([]);

      crypto.payout = wrapped;
      await capturedCryptoPayment(pay, m.id, '10');
      const paid = await settle(pay, m.id, 'w-ok');
      expect((await pay.payoutSettlement({ settlementId: paid.id, railId: 'crypto-native', destination: DEST })).status).toBe('paid_out');
      expect(await streak(m.id)).toEqual([{ consecutive_failures: '0' }]);
      expect(await poolA`SELECT 1 FROM pay.halts WHERE halted`).toHaveLength(0);
    });

    it('an adapter throw counts as rail health and the thrown error is unchanged', async () => {
      const store = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '1' });
      const pay = payService(composeGuards(createHaltGuards({ sql: poolA })), poolA, store);
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      crypto.payout = async () => {
        throw new Error('process died');
      };
      await capturedCryptoPayment(pay, m.id, '10');
      const settlement = await settle(pay, m.id, 'w-died');
      await expect(pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST })).rejects.toThrow(
        'process died',
      );
      expect(await pay.getSettlement(settlement.id)).toMatchObject({ status: 'posted' });
      const streaks = await poolA<{ target: string; consecutive_failures: string }[]>`
        SELECT target, consecutive_failures::text FROM pay.halt_failure_streaks
      `;
      expect(streaks).toEqual([{ target: m.id.toLowerCase(), consecutive_failures: '1' }]);
      expect(await poolA`SELECT 1 FROM pay.halt_autotrip_window WHERE failures IS NOT NULL`).toHaveLength(1);
      const op = await store.operatorStatus();
      expect(
        op.states.find((s) => s.scope === 'payout' && s.target.level === 'merchant' && s.target.merchantId === m.id.toLowerCase()),
      ).toMatchObject({ halted: true, source: 'auto_trip' });
    });

    it('booting with the count unset disarms the window, so the same count later starts again', async () => {
      const armed = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '3' });
      const venue = merchantTarget(MERCHANT);
      expect(await armed.recordFailure('payout', venue, 'rail:crypto-native')).toMatchObject({ tripped: false, consecutiveFailures: 1 });
      expect(await armed.recordFailure('payout', venue, 'rail:crypto-native')).toMatchObject({ tripped: false, consecutiveFailures: 2 });
      const off = storeOn(poolB, {});
      await off.adoptConfig();
      const [disarmed] = await poolA<{ failures: string | null; disarmed_at: Date | null }[]>`
        SELECT failures::text, disarmed_at FROM pay.halt_autotrip_window
      `;
      expect(disarmed?.failures ?? null).toBeNull();
      expect(disarmed?.disarmed_at).toBeTruthy();
      const again = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '3' });
      expect(await again.recordFailure('payout', venue, 'rail:crypto-native')).toMatchObject({
        tripped: false,
        consecutiveFailures: 1,
      });
      expect(await poolA`SELECT 1 FROM pay.halts WHERE halted`).toHaveLength(0);
    });

    it('the same durable outcome does not count twice', async () => {
      const store = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '3' });
      const venue = merchantTarget(MERCHANT);
      expect(await store.recordFailure('payout', venue, 'rail:crypto-native', undefined, 'payout:once')).toMatchObject({
        consecutiveFailures: 1,
      });
      expect(await store.recordFailure('payout', venue, 'rail:crypto-native', undefined, 'payout:once')).toMatchObject({
        tripped: false,
        consecutiveFailures: 1,
      });
    });

    it('a clear and a count change both finish (advisory lock, then the window row)', async () => {
      const pay = payService(composeGuards());
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      const venue = merchantTarget(m.id);
      const first = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '4' });
      await first.recordFailure('payout', venue, 'rail:crypto-native');
      await first.set(FOUNDER_A, setInput({ scope: 'payout', target: venue, reason: 'incident' }));
      const clear = setInput({ scope: 'payout', target: venue, halted: false, expectedVersion: '1', reason: 'repaired' });
      expect((await first.set(FOUNDER_A, clear)).outcome).toBe('pending_confirmation');
      const next = storeOn(poolB, { PAY_HALT_AUTOTRIP_FAILURES: '8' });
      const [cleared, counted] = await Promise.all([
        first.set(FOUNDER_B, clear),
        next.recordFailure('payout', venue, 'rail:crypto-native'),
      ]);
      expect(cleared.outcome).toBe('changed');
      expect(counted.consecutiveFailures).toBeGreaterThanOrEqual(1);
    }, 20_000);

    it('a user withdrawal rail-health refusal counts once for that user, and the halt stops the next send', async () => {
      const store = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '2' });
      const guards = composeGuards(createHaltGuards({ sql: poolA }));
      const pay = payService(guards);
      const owned = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      const otherUser = '22222222-2222-4222-8222-222222222222';
      await pay.createMerchant({ userId: otherUser, pricing: { feeBps: 0 } });
      const card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
      const realPayout = card.payout.bind(card);
      let calls = 0;
      let fail = true;
      card.payout = async (instruction) => {
        calls++;
        if (fail) {
          return railFailure({
            railRef: 'refused',
            amount: instruction.amount,
            assetId: instruction.assetId,
            failureCode: 'rail.unavailable',
            failureReason: 'down',
          });
        }
        return realPayout(instruction);
      };
      const money = new UserMoneyService(poolA, ledger, new RailRegistry([card]), {
        operatorCreditRails: ['card-sandbox'],
        guards,
        haltStore: store,
      });
      await money.credit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('50'),
        rail: 'card-sandbox',
        railRef: 'seed_trip',
        creditedBy: FOUNDER_A,
      });
      const withdraw = (clientRef: string) =>
        money.withdraw({
          userId: USER,
          assetId: 'USDT',
          amount: amt('10'),
          rail: 'card-sandbox',
          destination: BANK,
          clientRef,
        });
      await expect(withdraw('w1')).rejects.toMatchObject({ code: 'pay.rail_failed' });
      fail = false;
      expect((await withdraw('w2')).status).toBe('sent');
      fail = true;
      await expect(withdraw('w3')).rejects.toMatchObject({ code: 'pay.rail_failed' });
      await expect(withdraw('w4')).rejects.toMatchObject({ code: 'pay.rail_failed' });
      expect(calls).toBe(4);
      await expect(withdraw('w5')).rejects.toMatchObject({ code: 'pay.guard_halted' });
      expect(calls).toBe(4);
      const streaks = await poolA<{ target: string; consecutive_failures: string }[]>`
        SELECT target, consecutive_failures::text FROM pay.halt_failure_streaks ORDER BY target
      `;
      expect(streaks).toEqual([{ target: userHaltKey(USER), consecutive_failures: '2' }]);
      const op = await store.operatorStatus();
      expect(op.states.find((s) => s.scope === 'payout' && s.target.level === 'user' && s.target.userId === USER)).toMatchObject({
        halted: true,
        source: 'auto_trip',
      });
      expect(
        op.states.find((s) => s.scope === 'payout' && s.target.level === 'merchant' && s.target.merchantId === owned.id.toLowerCase()),
      ).toBeUndefined();
      expect(op.states.find((s) => s.scope === 'payout' && s.target.level === 'global')).toMatchObject({ halted: false });
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a declined card does not count toward a user or merchant halt', async () => {
      const store = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '1' });
      const guards = composeGuards(createHaltGuards({ sql: poolA }));
      const pay = payService(guards, poolA, store);
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      crypto.payout = async (request) =>
        railFailure({
          railRef: '',
          amount: request.amount,
          assetId: request.assetId,
          failureCode: 'card.declined',
          failureReason: 'declined',
        });
      await capturedCryptoPayment(pay, m.id, '10');
      const settlement = await settle(pay, m.id, 'w-decline');
      await expect(pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST })).rejects.toMatchObject(
        {
          code: 'pay.rail_failed',
        },
      );
      expect(await poolA`SELECT 1 FROM pay.halt_failure_streaks`).toHaveLength(0);
      expect(await poolA`SELECT 1 FROM pay.halts WHERE halted`).toHaveLength(0);
    });

    it('a streak-store throw does not change a paid_out result or a rail refusal', async () => {
      resetAutoTripAccountErrors();
      const store = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '2' });
      store.recordFailure = async () => {
        throw new Error('streak store down');
      };
      store.recordSuccess = async () => {
        throw new Error('streak store down');
      };
      const pay = payService(composeGuards(createHaltGuards({ sql: poolA })), poolA, store);
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      const wrapped = crypto.payout.bind(crypto);
      crypto.payout = async (request) =>
        railFailure({
          railRef: '',
          amount: request.amount,
          assetId: request.assetId,
          failureCode: 'rail.unavailable',
          failureReason: 'down',
        });
      await capturedCryptoPayment(pay, m.id, '10');
      const failed = await settle(pay, m.id, 'w-account-fail');
      await expect(pay.payoutSettlement({ settlementId: failed.id, railId: 'crypto-native', destination: DEST })).rejects.toMatchObject({
        code: 'pay.rail_failed',
      });
      expect(autoTripAccountErrorCount()).toBe(1);
      crypto.payout = wrapped;
      await capturedCryptoPayment(pay, m.id, '10');
      const paid = await settle(pay, m.id, 'w-account-ok');
      expect((await pay.payoutSettlement({ settlementId: paid.id, railId: 'crypto-native', destination: DEST })).status).toBe('paid_out');
      expect(autoTripAccountErrorCount()).toBe(2);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('a refund rail-health failure counts, a customer decline does not, and a throw counts without replacing the error', async () => {
      const store = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '5' });
      const pay = payService(composeGuards(createHaltGuards({ sql: poolA })), poolA, store);
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      const streak = () =>
        poolA<{ consecutive_failures: string }[]>`
          SELECT consecutive_failures::text FROM pay.halt_failure_streaks
           WHERE target = ${m.id.toLowerCase()} AND source_key = 'rail:crypto-native'
        `;
      crypto.refund = async (_ref, amount) =>
        railFailure({ railRef: '', amount, assetId: 'USDT', failureCode: 'card.declined', failureReason: 'declined' });
      const declined = await capturedCryptoPayment(pay, m.id, '10');
      await expect(pay.refund(declined.id, amt('10'))).rejects.toMatchObject({ code: 'pay.rail_failed' });
      expect(await streak()).toEqual([]);

      crypto.refund = async (_ref, amount) =>
        railFailure({ railRef: '', amount, assetId: 'USDT', failureCode: 'rail.timeout', failureReason: 'timed out' });
      const timedOut = await capturedCryptoPayment(pay, m.id, '10');
      await expect(pay.refund(timedOut.id, amt('10'))).rejects.toMatchObject({ code: 'pay.rail_failed' });
      expect(await streak()).toEqual([{ consecutive_failures: '1' }]);

      crypto.refund = async () => {
        throw new Error('refund adapter down');
      };
      const thrown = await capturedCryptoPayment(pay, m.id, '10');
      await expect(pay.refund(thrown.id, amt('10'))).rejects.toThrow('refund adapter down');
      expect(await streak()).toEqual([{ consecutive_failures: '2' }]);
    });

    it('a per-rail count trips that rail for every merchant and leaves other rails running', async () => {
      const env = { PAY_HALT_AUTOTRIP_FAILURES: '10', PAY_HALT_AUTOTRIP_RAIL_FAILURES: '2' };
      const store = storeOn(poolA, env);
      const guards = composeGuards(createHaltGuards({ sql: poolA }));
      const pay = payService(guards, poolA, store);
      const users = [USER, '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
      const merchants = [];
      for (const userId of users) merchants.push(await pay.createMerchant({ userId, pricing: { feeBps: 0 } }));
      let calls = 0;
      crypto.payout = async (request) => {
        calls++;
        return railFailure({
          railRef: '',
          amount: request.amount,
          assetId: request.assetId,
          failureCode: 'rail.unavailable',
          failureReason: 'down',
        });
      };
      for (const [index, merchant] of merchants.slice(0, 2).entries()) {
        await capturedCryptoPayment(pay, merchant.id, '10');
        const settlement = await settle(pay, merchant.id, `w-rail-${index}`);
        await expect(
          pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST }),
        ).rejects.toMatchObject({ code: 'pay.rail_failed' });
      }
      expect(calls).toBe(2);
      await capturedCryptoPayment(pay, merchants[2]!.id, '10');
      const third = await settle(pay, merchants[2]!.id, 'w-rail-2');
      await expect(pay.payoutSettlement({ settlementId: third.id, railId: 'crypto-native', destination: DEST })).rejects.toMatchObject({
        code: 'pay.guard_halted',
      });
      expect(calls).toBe(2);
      const op = await store.operatorStatus();
      expect(op.states.find((s) => s.target.level === 'rail' && s.target.railId === 'crypto-native')).toMatchObject({
        halted: true,
        source: 'auto_trip',
      });
      expect(op.states.find((s) => s.scope === 'payout' && s.target.level === 'global')).toMatchObject({ halted: false });
      expect(op.states.filter((s) => s.target.level === 'merchant' && s.halted)).toEqual([]);
      const cardExec = {
        sql: poolA as never,
        settlementId: randomUUID(),
        merchantId: merchants[2]!.id,
        assetId: 'USDT',
        amount: 1n,
        railId: 'card-sandbox',
        destination: BANK,
        attempt: 0,
        replay: FRESH,
      };
      await expect(guards.beforePayoutExecute(cardExec)).resolves.toBeUndefined();
    });

    it('a refusal recovered after a crash counts once when it is rail health', async () => {
      const store = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '4' });
      const guards = composeGuards(createHaltGuards({ sql: poolA }));
      const card = new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
      card.payout = async (instruction) =>
        railFailure({
          railRef: 'refused',
          amount: instruction.amount,
          assetId: instruction.assetId,
          failureCode: 'rail.timeout',
          failureReason: 'timed out',
        });
      const money = new UserMoneyService(poolA, ledger, new RailRegistry([card]), {
        operatorCreditRails: ['card-sandbox'],
        guards,
        haltStore: store,
      });
      await money.credit({
        userId: USER,
        assetId: 'USDT',
        amount: amt('40'),
        rail: 'card-sandbox',
        railRef: 'seed_recover_count',
        creditedBy: FOUNDER_A,
      });
      const realPost = ledger.post.bind(ledger);
      let lost = false;
      ledger.post = async (req) => {
        if (req.reason === 'withdraw.reversed' && !lost) {
          lost = true;
          throw new Error('process died before the reverse');
        }
        return realPost(req);
      };
      const request = {
        userId: USER,
        assetId: 'USDT',
        amount: amt('10'),
        rail: 'card-sandbox',
        destination: BANK,
        clientRef: 'w-recover-count',
      };
      await expect(money.withdraw(request)).rejects.toThrow('process died before the reverse');
      expect(await poolA`SELECT 1 FROM pay.halt_failure_streaks`).toHaveLength(0);
      ledger.post = realPost;
      await expect(money.withdraw(request)).rejects.toMatchObject({ code: 'pay.rail_failed' });
      const streaks = await poolA<{ target: string; consecutive_failures: string }[]>`
        SELECT target, consecutive_failures::text FROM pay.halt_failure_streaks
      `;
      expect(streaks).toEqual([{ target: userHaltKey(USER), consecutive_failures: '1' }]);
      expect((await ledger.balance(userAvailable(USER, 'USDT'))).amount).toBe(amt('40'));
      expect(ledger.reconcile()).toEqual({ ok: true });
    });

    it('with both counts unset, recordSuccess and recordFailure issue no auto-trip lock or window query', async () => {
      const spy = openSpy();
      try {
        const store = new PayHaltStore(spy.sql, loadHaltAutoTripConfig({}));
        const venue = merchantTarget(MERCHANT);
        const reserved = await spy.sql.reserve();
        try {
          await store.recordSuccess('payout', venue, 'rail:crypto-native');
          await store.recordFailure('payout', venue, 'rail:crypto-native', undefined, 'payout:none');
          await store.recordSuccess('payout', venue, 'rail:crypto-native', reserved);
          await store.recordFailure('payout', { level: 'user', userId: USER }, 'rail:crypto-native', reserved);
        } finally {
          reserved.release();
        }
        expect(spy.queries.join('\n')).not.toMatch(/pg_advisory|halt_autotrip|lock_timeout/);
      } finally {
        await spy.end();
      }
    });

    it('a held auto-trip lock does not delay a payout when both counts are unset', async () => {
      const store = storeOn(poolA);
      const pay = payService(composeGuards(createHaltGuards({ sql: poolA })), poolA, store);
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      await capturedCryptoPayment(pay, m.id, '10');
      const baselineSettlement = await settle(pay, m.id, 'w-base');
      const baselineStarted = Date.now();
      expect((await pay.payoutSettlement({ settlementId: baselineSettlement.id, railId: 'crypto-native', destination: DEST })).status).toBe(
        'paid_out',
      );
      const baseline = Date.now() - baselineStarted;

      await capturedCryptoPayment(pay, m.id, '10');
      const heldSettlement = await settle(pay, m.id, 'w-held');
      const release = await holdAutoTripLock();
      try {
        const started = Date.now();
        expect((await pay.payoutSettlement({ settlementId: heldSettlement.id, railId: 'crypto-native', destination: DEST })).status).toBe(
          'paid_out',
        );
        expect(Date.now() - started - baseline).toBeLessThan(1000);
      } finally {
        await release();
      }
    });

    it('a held auto-trip lock stops accounting within about a second, and the payout still completes', async () => {
      resetAutoTripAccountErrors();
      const store = storeOn(poolA, { PAY_HALT_AUTOTRIP_FAILURES: '3' });
      const pay = payService(composeGuards(createHaltGuards({ sql: poolA })), poolA, store);
      const m = await pay.createMerchant({ userId: USER, pricing: { feeBps: 0 } });
      await capturedCryptoPayment(pay, m.id, '10');
      const settlement = await settle(pay, m.id, 'w-lock-timeout');
      const release = await holdAutoTripLock();
      try {
        const started = Date.now();
        expect((await pay.payoutSettlement({ settlementId: settlement.id, railId: 'crypto-native', destination: DEST })).status).toBe(
          'paid_out',
        );
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(900);
        expect(elapsed).toBeLessThan(4000);
      } finally {
        await release();
      }
      expect(autoTripAccountErrorCount()).toBe(1);
      expect(await poolA`SELECT 1 FROM pay.halt_failure_streaks`).toHaveLength(0);
    }, 15_000);

    it('an armed count sets a one second lock timeout before the auto-trip lock', async () => {
      const spy = openSpy();
      try {
        const store = new PayHaltStore(spy.sql, loadHaltAutoTripConfig({ PAY_HALT_AUTOTRIP_FAILURES: '4' }));
        await store.recordFailure('payout', merchantTarget(MERCHANT), 'rail:crypto-native');
        const text = spy.queries.join('\n');
        const timeoutAt = text.indexOf('lock_timeout');
        const lockAt = text.indexOf('pay.halt:autotrip');
        expect(timeoutAt).toBeGreaterThanOrEqual(0);
        expect(lockAt).toBeGreaterThan(timeoutAt);
      } finally {
        await spy.end();
      }
    });
  });

  describe('operator set and dual-controlled clear', () => {
    it('an emergency halt does not take the auto-trip lock, and a clear takes it first', async () => {
      const spy = openSpy();
      try {
        const store = new PayHaltStore(spy.sql, loadHaltAutoTripConfig({}));
        await store.set(FOUNDER_A, setInput({ reason: 'stop now' }));
        expect(spy.queries.join('\n')).not.toContain('pay.halt:autotrip');

        spy.queries.length = 0;
        expect((await store.set(FOUNDER_A, setInput({ halted: false, expectedVersion: '1', reason: 'lift' }))).outcome).toBe(
          'pending_confirmation',
        );
        const text = spy.queries.join('\n');
        const auto = text.indexOf('pay.halt:autotrip');
        const target = text.indexOf('pay.halt:intake:global');
        expect(auto).toBeGreaterThanOrEqual(0);
        expect(target).toBeGreaterThan(auto);
      } finally {
        await spy.end();
      }
    });

    it('an emergency halt does not wait while accounting holds the auto-trip lock', async () => {
      const store = storeOn(poolA);
      const release = await holdAutoTripLock();
      try {
        const started = Date.now();
        expect((await store.set(FOUNDER_A, setInput({ reason: 'stop now' }))).outcome).toBe('changed');
        expect(Date.now() - started).toBeLessThan(1000);
      } finally {
        await release();
      }
    });

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
      await poolA`INSERT INTO pay.halt_autotrip_window (singleton, failures, effective_at) VALUES ('autotrip', 3, now())`;
      await expect(poolA`DELETE FROM pay.halt_autotrip_window`).rejects.toThrow();
    });

    it('downgrade writes a cleared-by-migration event for each user and rail halt it deletes', async () => {
      const down = readFileSync(join(here, '..', '..', 'drizzle', '0079_pay_halt_autotrip_window.down.sql'), 'utf8');
      const up = readFileSync(join(here, '..', '..', 'drizzle', '0079_pay_halt_autotrip_window.sql'), 'utf8');
      await poolA`
        INSERT INTO pay.halts (scope, target, halted, reason, source, actor_user_id, version) VALUES
          ('payout', ${`user:${USER}`}, true, 'user stop', 'auto_trip', NULL, 1),
          ('payout', 'rail:crypto-native', true, 'rail stop', 'auto_trip', NULL, 3),
          ('intake', 'global', true, 'keep', 'operator', ${FOUNDER_A}, 1),
          ('settlement', ${MERCHANT}, true, 'merchant stop', 'operator', ${FOUNDER_A}, 2)
      `;
      let dropped = false;
      try {
        await poolA.unsafe(down);
        dropped = true;
        const left = await poolA<{ target: string }[]>`SELECT target FROM pay.halts ORDER BY target`;
        expect(left.map((row) => row.target).sort()).toEqual([MERCHANT, 'global'].sort());
        const events = await poolA<{ target: string; halted: boolean; reason: string; source: string; version: string }[]>`
          SELECT target, halted, reason, source, version::text AS version FROM pay.halt_events
           WHERE reason = 'cleared by migration'
           ORDER BY target
        `;
        expect(events).toEqual([
          { target: 'rail:crypto-native', halted: false, reason: 'cleared by migration', source: 'auto_trip', version: '4' },
          { target: `user:${USER}`, halted: false, reason: 'cleared by migration', source: 'auto_trip', version: '2' },
        ]);
      } finally {
        if (dropped) await poolA.unsafe(up);
      }
    });
  });
});
