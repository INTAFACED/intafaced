import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { RailRegistry } from '../rails/registry.js';
import { ChangeService } from '../control/changes.js';
import { applyChange, migrations, openAdmin, resetControl, TEST_GLOBAL_RULE, TEST_TIER } from '../control/control.testkit.js';
import { FRESH } from './guards.js';
import { buildPayGuards } from './registry.js';

/**
 * LOCK ORDER ACROSS SLOTS. The seams doc fixes it: merchant row, then halts (W5), then the treasury advisory lock
 * (W5), then W9 screening, then the W1 cap counters (row locks). This pins the last two links with BOTH slots live
 * in the real registry: a payout admission takes the per-asset treasury lock BEFORE it touches a W1 counter, and a
 * payout the treasury refuses never reaches the counters at all.
 */
describe('guard seams: W5 treasury lock comes before W1 counter locks', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let changes!: ChangeService;
  let merchantId = '';
  let ownerUserId = '';
  let ledger!: MemoryLedger;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['PAY_MERCHANT_CONTROLS', 'PAY_TREASURY_LIMITS', 'PAY_TREASURY_EXPOSURE_LIMITS'] as const;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    changes = new ChangeService(sql);
  }, 120_000);

  beforeEach(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.PAY_MERCHANT_CONTROLS = 'required';
    process.env.PAY_TREASURY_LIMITS = 'required';
    process.env.PAY_TREASURY_EXPOSURE_LIMITS = '{"USDT":"1000"}';
    await resetControl(sql);
    ledger = new MemoryLedger();
    const pay = new PayService(sql, ledger, new RailRegistry([]), {});
    ownerUserId = randomUUID();
    merchantId = (await pay.createMerchant({ userId: ownerUserId, pricing: { feeBps: 0 } })).id;
    // A pending row with no settlement post. A reader reports it absent, so it
    // does not put the owner's personal withdrawal under the payout cap.
    await sql`INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net) VALUES (${merchantId}, 'lock-order', 'USDT', 10, 0, 10)`;
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: TEST_TIER } });
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
    });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
    });
  }, 30_000);

  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  /** Run one payout admission in a transaction whose every statement is recorded in order. */
  async function admit(amount: string, seen: string[] = []): Promise<string[]> {
    const guards = buildPayGuards({ sql, ledger });
    await sql.begin(async (tx) => {
      const spy = new Proxy(tx, {
        apply: (target, thisArg, args: unknown[]) => {
          if (Array.isArray(args[0])) seen.push((args[0] as string[]).join('?').replace(/\s+/g, ' ').trim());
          return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
        },
        get: (target, prop, receiver) => {
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      await guards.beforePayoutAdmit({
        tx: spy as never,
        settlementId: randomUUID(),
        merchantId,
        assetId: 'USDT',
        amount: amt(amount),
        railId: 'crypto-native',
        destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
        attempt: 0,
        replay: FRESH,
      });
    });
    return seen;
  }

  const used = async () =>
    (
      await sql<
        Array<{ used: string }>
      >`SELECT used FROM pay.control_cap_usage WHERE merchant_id = ${merchantId} AND cap_kind = 'daily_payout'`
    )[0]?.used;

  it('the treasury advisory lock is the first lock taken, ahead of every W1 counter statement', async () => {
    const statements = await admit('10');
    const treasury = statements.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    const firstCounter = statements.findIndex((s) => s.includes('pay.control_cap_usage'));
    expect(treasury, `no treasury lock in: ${JSON.stringify(statements)}`).toBeGreaterThanOrEqual(0);
    expect(firstCounter, `W1 took no counter in: ${JSON.stringify(statements)}`).toBeGreaterThanOrEqual(0);
    expect(treasury).toBeLessThan(firstCounter);
    // Exactly one treasury lock for the one asset, and nothing in W1 takes an advisory lock of its own that could invert the order.
    expect(statements.filter((s) => s.includes('pg_advisory_xact_lock'))).toHaveLength(1);
    expect(Number(await used())).toBe(10);
  });

  it('a payout the treasury refuses never reaches the W1 counters (nothing is counted, no counter row locked)', async () => {
    process.env.PAY_TREASURY_EXPOSURE_LIMITS = '{"USDT":"5"}';
    const seen: string[] = [];
    await expect(admit('10', seen)).rejects.toMatchObject({ code: 'pay.guard_treasury_exposure_exceeded' });
    expect(seen.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(seen.some((s) => s.includes('pay.control_cap_usage'))).toBe(false);
    expect(await used()).toBeUndefined();
  });

  it('parallel admissions on two merchants through both slots all finish: the order is the same everywhere, so no deadlock', async () => {
    const pay = new PayService(sql, new MemoryLedger(), new RailRegistry([]), {});
    const other = (await pay.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 } })).id;
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId: other,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
    });
    const guards = buildPayGuards({ sql, ledger });
    const run = (m: string, ref: string) =>
      sql.begin((tx) =>
        guards.beforePayoutAdmit({
          tx: tx as never,
          settlementId: randomUUID(),
          merchantId: m,
          assetId: 'USDT',
          amount: amt('10'),
          railId: 'crypto-native',
          destination: { kind: 'crypto', ref },
          attempt: 0,
          replay: FRESH,
        }),
      );
    const jobs = Array.from({ length: 10 }, (_, i) =>
      run(i % 2 === 0 ? merchantId : other, `0x00000000000000000000000000000000000000${i % 2 === 0 ? '0a' : '0b'}`),
    );
    const results = await Promise.allSettled(jobs);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason)).toEqual([]);
    expect(Number(await used())).toBe(50);
  });
  /** One user-money withdrawal admission by the merchant's owner, every statement recorded in order. */
  async function withdraw(amount: string, seen: string[] = []): Promise<string[]> {
    const guards = buildPayGuards({ sql, ledger });
    await sql.begin(async (tx) => {
      const spy = new Proxy(tx, {
        apply: (target, thisArg, args: unknown[]) => {
          if (Array.isArray(args[0])) seen.push((args[0] as string[]).join('?').replace(/\s+/g, ' ').trim());
          return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
        },
        get: (target, prop, receiver) => {
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      await guards.beforeUserMoneyWithdrawal({
        tx: spy as never,
        userId: ownerUserId,
        assetId: 'USDT',
        amount: amt(amount),
        rail: 'card-sandbox',
        destination: { kind: 'bank', ref: 'DE89370400440532013000' },
        clientRef: randomUUID(),
        replay: FRESH,
      });
    });
    return seen;
  }

  it('an owner withdrawal takes the treasury lock and does not count a merchant payout cap', async () => {
    const statements = await withdraw('10');
    expect(statements.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(statements.some((s) => s.includes('pay.control_cap_usage'))).toBe(false);
    expect(await used()).toBeUndefined();
  });

  it('a withdrawal the treasury refuses never reaches the W1 counters', async () => {
    process.env.PAY_TREASURY_EXPOSURE_LIMITS = '{"USDT":"5"}';
    const seen: string[] = [];
    await expect(withdraw('10', seen)).rejects.toMatchObject({ code: 'pay.guard_treasury_exposure_exceeded' });
    expect(seen.some((s) => s.includes('pay.control_cap_usage'))).toBe(false);
    expect(await used()).toBeUndefined();
  });

  it('payout admissions and owner withdrawals racing on one merchant all finish and add up: no deadlock', async () => {
    const guards = buildPayGuards({ sql, ledger });
    const payout = (i: number) =>
      sql.begin((tx) =>
        guards.beforePayoutAdmit({
          tx: tx as never,
          settlementId: randomUUID(),
          merchantId,
          assetId: 'USDT',
          amount: amt('10'),
          railId: 'crypto-native',
          destination: { kind: 'crypto', ref: `0x00000000000000000000000000000000000000${i % 2 === 0 ? '0a' : '0b'}` },
          attempt: 0,
          replay: FRESH,
        }),
      );
    const jobs = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? payout(i) : withdraw('10').then(() => undefined)));
    const results = await Promise.allSettled(jobs);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason)).toEqual([]);
    // Five payout admissions of 10. The interleaved withdrawals are personal and do not count.
    expect(Number(await used())).toBe(50);
  });
  it('a capture takes its counters last, after a bounded lock timeout is set, and no advisory lock; daily intake before monthly', async () => {
    const guards = buildPayGuards({ sql, ledger });
    const seen: string[] = [];
    const paymentId = randomUUID();
    await sql.begin(async (tx) => {
      const spy = new Proxy(tx, {
        apply: (target, thisArg, args: unknown[]) => {
          if (Array.isArray(args[0])) seen.push((args[0] as string[]).join('?').replace(/\s+/g, ' ').trim());
          return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
        },
        get: (target, prop, receiver) => {
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      await guards.afterPaymentCaptureBooked({ tx: spy as never, paymentId, merchantId, assetId: 'USDT', amount: amt('10') });
    });
    const timeout = seen.findIndex((st) => st.includes("set_config('lock_timeout'"));
    const firstCounter = seen.findIndex((st) => st.includes('pay.control_cap_usage'));
    expect(timeout).toBeGreaterThanOrEqual(0);
    expect(firstCounter).toBeGreaterThan(timeout);
    expect(seen.some((st) => st.includes('pg_advisory_xact_lock'))).toBe(false);
    const rows = await sql<
      Array<{ cap_kind: string }>
    >`SELECT cap_kind FROM pay.control_cap_events WHERE event_key = ${`payment.capture:${paymentId}`} ORDER BY created_at, cap_kind`;
    expect(rows.map((r) => r.cap_kind).sort()).toEqual(['daily_intake', 'monthly_intake']);
  });
});
