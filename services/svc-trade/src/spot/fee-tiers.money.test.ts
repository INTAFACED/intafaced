import { TradeService, readyTestAdmission } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, houseFees, parseAmount as amt, recipes } from '@intafaced/ledger-client';

import type { Market } from './types.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor } from './testing.js';
import { parseFeeScheduleJson, type OwnerFeeSchedule } from './fee-schedule.js';
import { countedVolume, feeTierAt, runTierSnapshot, snapshotsOf } from './fee-tier-store.js';
import { startFeeTierJobs } from './fee-tier-jobs.js';
import { copyFlattenClientOrderId, copyMirrorClientOrderId } from '../copy/index.js';
import type { SubAccountOwnership } from '@intafaced/contracts';
import type { FeeTierProgram } from './fee-tiers.js';

/**
 * Fee tiers by 30-day volume, on Postgres and the ledger (SP-fees-vip-03, J-cex-spot-10 #5-#6).
 *
 * A snapshot counts each account's own spot fills and writes its tier once per snapshot instant. An order takes the
 * tier of the last finished snapshot when it is placed and keeps it: the fill posts that tier's rate even when a
 * snapshot taken after placement changed the tier. A re-run of a snapshot writes nothing, and a crash half way through
 * one is finished by the next run without writing a row twice. PG-hard like fee-schedule-blank.money.test.ts.
 *
 * Rates and thresholds are TEST values: regular 3/7 bps, TEST VIP 1/5 bps from 150 USDT of 30-day volume.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';

const ROWS = [
  { pairGroup: 'all-others', tierId: 'regular', zeroFee: false, makerBps: '3', takerBps: '7', minFee: null },
  { pairGroup: 'all-others', tierId: 'test-vip', zeroFee: false, makerBps: '1', takerBps: '5', minFee: null },
];
const TIERED = parseFeeScheduleJson(
  JSON.stringify({
    published: true,
    version: 'test-tiers',
    defaultPairGroup: 'all-others',
    rows: ROWS,
    tierProgram: {
      thresholds: [{ tierId: 'test-vip', minVolume30d: '150' }],
      volumeQuotes: ['USDT'],
      snapshotTimeUtc: '07:00',
      downgradeGraceDays: null,
      subAccounts: null,
      botsAndCopy: null,
    },
  }),
);
/** The same rates with no programme: every account regular, "Thresholds not set". */
const NO_PROGRAMME = parseFeeScheduleJson(
  JSON.stringify({ published: true, version: 'test-flat-tiers', defaultPairGroup: 'all-others', rows: ROWS }),
);
const PROGRAMME = (TIERED as Extract<OwnerFeeSchedule, { published: true }>).tierProgram as FeeTierProgram;

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_fee_tiers_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('svc-trade fee tiers money', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let matching: StubMatching;
  let trade: TradeService;
  let btcusdt: Market;
  let ethbtc: Market;
  let sequence = 0;

  /** Carol's sub-account belongs to Alice. */
  const SUB = '44444444-4444-4444-8444-444444444444';
  const subAccounts = {
    get: async (id: string) => (id === SUB ? ({ id: SUB, parentUserId: ALICE, revoked: false } as unknown as SubAccountOwnership) : null),
  };
  /** The test authority, which also knows Alice's TEST follow as an admitted copy relationship. */
  const FOLLOW = '55555555-5555-4555-8555-555555555555';
  const admission = () => {
    const ready = readyTestAdmission();
    return {
      ...ready,
      admit: ready.admit.bind(ready),
      async original(userId: string, businessId: string) {
        if (userId !== ALICE || businessId !== `copy.follow:${FOLLOW}`) return ready.original(userId, businessId);
        const admitted = await ready.admit(principalFor(ALICE), 'copy.follow' as never, businessId, { follow: FOLLOW });
        return { payload: { follow: FOLLOW }, admission: admitted, grantId: admitted.admissionId };
      },
    };
  };
  const service = (feeSchedule: OwnerFeeSchedule) =>
    new TradeService(sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      feeSchedule,
      subAccounts,
      accountAdmission: admission() as never,
    });

  async function fund(userId: string, assetId: string, amount: string) {
    await ledger.post(
      recipes.deposit({
        userId,
        assetId,
        amount: amt(amount),
        rail: 'test',
        railRef: `${userId}:${assetId}:${amount}:${sequence}:${Math.random()}`,
      }),
    );
  }

  const rest = (userId: string, market: Market, side: 'buy' | 'sell', qty: string, price: string, clientOrderId: string) =>
    trade.placeOrder(principalFor(userId), { marketId: market.id, side, type: 'limit', qty: amt(qty), price: amt(price), clientOrderId });

  /** One engine match of `maker` by `taker`, at the maker's price. */
  async function match(
    market: Market,
    maker: { id: string; userId: string },
    taker: { id: string; userId: string },
    qty: string,
    price: string,
  ) {
    sequence += 1;
    await trade.settleFillEvent({
      marketId: market.id,
      makerOrderId: maker.id,
      takerOrderId: taker.id,
      price,
      qty,
      sequence,
      makerAccountId: maker.userId,
      takerAccountId: taker.userId,
    });
  }

  const feeBps = async (orderId: string) => {
    const [row] = await sql<Array<{ fee_bps: string }>>`SELECT fee_bps::text FROM trade.fills WHERE order_id = ${orderId}`;
    return Number(row?.fee_bps);
  };
  const tierOf = async (orderId: string) =>
    (await sql<Array<{ fee_tier: string }>>`SELECT fee_tier FROM trade.orders WHERE id = ${orderId}`)[0]?.fee_tier;
  const snapshotRows = async () => (await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM trade.fee_tier_snapshots`)[0]!.n;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE trade.fee_tier_snapshot_runs, trade.fee_tier_snapshots, trade.fee_schedule_versions, trade.copy_placed_mirrors, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
    ledger = new MemoryLedger();
    matching = new StubMatching();
    // Fill sequences stay behind the stub engine's own, which counts every submit.
    sequence = 0;
    trade = service(TIERED);
    const listing = {
      tickSize: amt('0.01'),
      lotSize: amt('0.0001'),
      minQty: amt('0.0001'),
      maxQty: amt('1000'),
      makerBps: 10,
      takerBps: 20,
    };
    btcusdt = await trade.listMarket({ symbol: 'BTC/USDT', baseAsset: 'BTC', quoteAsset: 'USDT', minNotional: amt('1'), ...listing });
    ethbtc = await trade.listMarket({ symbol: 'ETH/BTC', baseAsset: 'ETH', quoteAsset: 'BTC', minNotional: amt('0.0001'), ...listing });
    await fund(ALICE, 'USDT', '10000');
    await fund(BOB, 'BTC', '10');
    await fund(CAROL, 'USDT', '10000');
    await fund(CAROL, 'BTC', '10');
    await fund(CAROL, 'ETH', '100');
  });

  it('an order keeps the tier it was placed at: a snapshot after placement re-prices only orders placed after it', async () => {
    // 200 USDT each of counted volume, at regular rates: maker 3, taker 7.
    const bob1 = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-1');
    const alice1 = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-1');
    await match(btcusdt, bob1, alice1, '2', '100');
    expect([await feeBps(bob1.id), await feeBps(alice1.id)]).toEqual([3, 7]);

    // Bob rests again before the snapshot: regular, and it stays regular.
    const bob2 = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-2');
    expect(await tierOf(bob2.id)).toBe('regular');

    const instant = new Date(Date.now() + 60_000);
    expect(await runTierSnapshot(sql, PROGRAMME, 'test-tiers', instant)).toEqual({ accounts: 2, written: true });
    expect((await snapshotsOf(sql, ALICE, 10))[0]).toMatchObject({ tierId: 'test-vip', volume30d: '200', countedFills: 1 });
    expect(await trade.feeTierAt(ALICE)).toBe('test-vip');

    // Alice places after it: TEST VIP taker 5. Bob's earlier order is still charged regular maker 3.
    const feesBefore = (await ledger.balance(houseFees('trade', 'BTC'))).amount;
    const alice2 = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-2');
    expect(await tierOf(alice2.id)).toBe('test-vip');
    await match(btcusdt, bob2, alice2, '2', '100');
    expect([await feeBps(bob2.id), await feeBps(alice2.id)]).toEqual([3, 5]);
    // The ledger took 5 bps of the 2 BTC Alice received: 0.001 BTC, not the regular 0.0014.
    expect(formatAmount((await ledger.balance(houseFees('trade', 'BTC'))).amount - feesBefore)).toBe('0.001');

    // A snapshot that runs again writes nothing new.
    expect(await runTierSnapshot(sql, PROGRAMME, 'test-tiers', instant)).toEqual({ accounts: 2, written: false });
    expect(await snapshotRows()).toBe(2);
  });

  it('a snapshot that crashed half way is finished by the next run, and is not in force until then', async () => {
    const bob1 = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-crash');
    const alice1 = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-crash');
    await match(btcusdt, bob1, alice1, '2', '100');
    const instant = new Date(Date.now() + 60_000);
    await runTierSnapshot(sql, PROGRAMME, 'test-tiers', instant);
    // As if the run had written Bob's row and crashed before Alice's and before the run row.
    await sql`DELETE FROM trade.fee_tier_snapshot_runs`;
    await sql`DELETE FROM trade.fee_tier_snapshots WHERE user_id = ${ALICE}`;
    expect(await trade.feeTierAt(BOB)).toBe('regular');

    expect(await runTierSnapshot(sql, PROGRAMME, 'test-tiers', instant)).toEqual({ accounts: 2, written: true });
    expect(await snapshotRows()).toBe(2);
    expect([await trade.feeTierAt(ALICE), await trade.feeTierAt(BOB)]).toEqual(['test-vip', 'test-vip']);
  });

  it('a tier goes down at the next snapshot when the volume does, and with no programme every account is regular', async () => {
    const bob1 = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-down');
    const alice1 = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-down');
    await match(btcusdt, bob1, alice1, '2', '100');
    await runTierSnapshot(sql, PROGRAMME, 'test-tiers', new Date(Date.now() + 60_000));
    expect(await trade.feeTierAt(ALICE)).toBe('test-vip');

    // 31 days on, the fills are outside the window: Alice's row says regular with nothing counted.
    await runTierSnapshot(sql, PROGRAMME, 'test-tiers', new Date(Date.now() + 31 * 86_400_000));
    expect((await snapshotsOf(sql, ALICE, 10))[0]).toMatchObject({ tierId: 'regular', volume30d: '0', countedFills: 0 });
    expect(await trade.feeTierAt(ALICE)).toBe('regular');

    // A programme removed: the snapshots stay, the tier is regular ("Thresholds not set").
    await runTierSnapshot(sql, PROGRAMME, 'test-tiers', new Date(Date.now() + 32 * 86_400_000 - 1));
    expect(await feeTierAt(sql, NO_PROGRAMME, BOB, new Date())).toBe('regular');
    expect(await service(NO_PROGRAMME).feeTierAt(BOB)).toBe('regular');
  });

  it('counts only own spot fills in the named quotes: bots, algorithms, copy trading and sub-accounts are excluded', async () => {
    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 60_000);
    const fill = async (place: () => Promise<{ id: string; userId: string }>, market: Market = btcusdt, qty = '1', price = '100') => {
      const maker =
        market === btcusdt
          ? await rest(BOB, market, 'sell', qty, price, `bob-maker-${sequence}`)
          : await rest(CAROL, market, 'sell', qty, price, `carol-maker-${sequence}`);
      const taker = await place();
      await match(market, maker, taker, qty, price);
      return taker;
    };
    const buy =
      (clientOrderId: string, extra: Record<string, unknown> = {}) =>
      () =>
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          clientOrderId,
          ...extra,
        });
    // Copy trading places mirrors and flattens through its own door; their real ids are hashed past 64 characters, so
    // nothing in the id says copy.
    const follow = FOLLOW;
    const mirrorId = copyMirrorClientOrderId(follow, '66666666-6666-4666-8666-666666666666');
    const flattenId = copyFlattenClientOrderId(follow, 'BTC/USDT-LONG-SYMBOL-NAME');
    expect([mirrorId, flattenId].every((id) => /^[0-9a-f]{64}$/.test(id))).toBe(true);
    const copied = (clientOrderId: string) => () =>
      trade.placeCopyMirror(
        principalFor(ALICE),
        { marketId: btcusdt.id, side: 'buy', type: 'limit', qty: amt('1'), price: amt('100'), clientOrderId },
        follow,
      );

    await fund(ALICE, 'BTC', '10');
    await fill(buy('alice-own'));
    await fill(buy('algo:twap-1:0'));
    await fill(buy('parent/client/leg-0-0-abc'));
    const mirrored = await fill(copied(mirrorId));
    await fill(copied(flattenId));
    await fill(buy('alice-sub', { subAccountId: SUB }));
    await fill(() => rest(ALICE, ethbtc, 'buy', '1', '0.05', 'alice-eth'), ethbtc, '1', '0.05');
    await sql`INSERT INTO trade.copy_placed_mirrors (follow_id, fill_id, order_id, client_order_id, price)
      VALUES (${follow}, 'leader-fill-1', ${mirrored.id}, ${mirrorId}, 100)`;

    // Only the first fill counts: 100 USDT, once.
    expect(await countedVolume(sql, PROGRAMME, ALICE, from, to)).toEqual({ volume: '100', fills: 1 });
    // Unfollowing deletes the mirror claims; the mirror's fills still do not count, since the order row says so.
    await sql`DELETE FROM trade.copy_placed_mirrors`;
    expect(await countedVolume(sql, PROGRAMME, ALICE, from, to)).toEqual({ volume: '100', fills: 1 });
    // Bob made every BTC/USDT fill for himself: his maker side counts each one.
    expect((await countedVolume(sql, PROGRAMME, BOB, from, to)).fills).toBe(6);
  });

  it('a sub-account order is charged regular, never at its parent’s tier', async () => {
    const bob1 = await rest(BOB, btcusdt, 'sell', '2', '100', 'bob-parent');
    const alice1 = await rest(ALICE, btcusdt, 'buy', '2', '100', 'alice-parent');
    await match(btcusdt, bob1, alice1, '2', '100');
    await runTierSnapshot(sql, PROGRAMME, 'test-tiers', new Date(Date.now() + 60_000));
    expect(await trade.feeTierAt(ALICE)).toBe('test-vip');

    const own = await rest(ALICE, btcusdt, 'buy', '1', '90', 'alice-own-vip');
    const sub = await trade.placeOrder(principalFor(ALICE), {
      marketId: btcusdt.id,
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('90'),
      clientOrderId: 'alice-sub-regular',
      subAccountId: SUB,
    });
    expect([await tierOf(own.id), await tierOf(sub.id)]).toEqual(['test-vip', 'regular']);
  });

  describe('the snapshot job', () => {
    const day = new Date(Date.now() + 2 * 86_400_000);
    const at = (time: string) => new Date(`${day.toISOString().slice(0, 10)}T${time}Z`);
    let stored = 0;
    const store = async (schedule: Record<string, unknown>, effectiveAt: Date) => {
      stored += 1;
      await sql`INSERT INTO trade.fee_schedule_versions (id, version, schedule, effective_at, operator_id, approver_id, reason, approval_id)
        VALUES (gen_random_uuid(), ${stored}, ${sql.json(schedule as never)}, ${effectiveAt.toISOString()}, 'op-a', 'op-b', 'TEST', ${`approval-${stored}-${Math.random()}`})`;
    };
    const tiered = (makerBps: string) => ({
      published: true,
      version: `test-tiers-${makerBps}`,
      defaultPairGroup: 'all-others',
      rows: ROWS.map((row) => (row.tierId === 'regular' ? { ...row, makerBps } : row)),
      tierProgram: { ...PROGRAMME, downgradeGraceDays: null, subAccounts: null, botsAndCopy: null },
    });
    const tickAt = async (now: Date, boot: OwnerFeeSchedule = NO_PROGRAMME) => {
      const { feeScheduleAt } = await import('./fee-schedule-store.js');
      const jobs = startFeeTierJobs({
        sql,
        scheduleAt: (when) => feeScheduleAt(sql, boot, when),
        bootSchedule: boot,
        intervalMs: null,
        now: () => now,
      });
      return jobs.tick();
    };
    beforeEach(() => {
      stored = 0;
    });

    it('does not skip the day’s snapshot after a restart or a rates-only version past the snapshot time', async () => {
      await store(tiered('3'), at('05:00:00'));
      // A rates-only version took effect ten seconds after 07:00, and the service restarted at 07:00:30.
      await store(tiered('2'), at('07:00:10'));
      expect(await tickAt(at('07:00:30'))).toMatchObject({ outcome: 'written', instant: at('07:00:00').toISOString() });
    });

    it('never snapshots a moment before the programme came into force', async () => {
      await store(JSON.parse(JSON.stringify({ ...tiered('3'), tierProgram: undefined })), at('05:00:00'));
      await store(tiered('3'), at('07:00:10'));
      expect(await tickAt(at('07:00:30'))).toEqual({ outcome: 'not_due' });
      // A boot schedule with a programme has been in force since before anything stored: no bound.
      expect(await tickAt(at('07:00:30'), TIERED)).toMatchObject({ outcome: 'not_due' });
      await sql`TRUNCATE trade.fee_schedule_versions`;
      expect(await tickAt(at('07:00:30'), TIERED)).toMatchObject({ outcome: 'written', instant: at('07:00:00').toISOString() });
    });
  });
});
