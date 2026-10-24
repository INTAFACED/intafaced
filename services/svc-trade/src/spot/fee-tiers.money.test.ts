import { TradeService } from '../controls/test-admission.js';
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

  const service = (feeSchedule: OwnerFeeSchedule) =>
    new TradeService(sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
      marketLifecycle: READY_MARKET_LIFECYCLE,
      spotEnabled: true,
      feeSchedule,
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
    await sql`TRUNCATE trade.fee_tier_snapshot_runs, trade.fee_tier_snapshots, trade.copy_placed_mirrors, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
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
    const fill = async (clientOrderId: string, market: Market = btcusdt, qty = '1', price = '100') => {
      const maker =
        market === btcusdt
          ? await rest(BOB, market, 'sell', qty, price, `bob-maker-${sequence}`)
          : await rest(CAROL, market, 'sell', qty, price, `carol-maker-${sequence}`);
      const taker = await rest(ALICE, market, 'buy', qty, price, clientOrderId);
      await match(market, maker, taker, qty, price);
      return taker;
    };
    await fund(ALICE, 'BTC', '10');
    await fill('alice-own');
    await fill('algo:twap-1:0');
    await fill('parent/client/leg-0-0-abc');
    await fill('copy-flatten:follow-1:BTC/USDT');
    const mirrored = await fill('alice-mirrored');
    await sql`INSERT INTO trade.copy_placed_mirrors (follow_id, fill_id, order_id, client_order_id, price)
      VALUES ('follow-1', 'leader-fill-1', ${mirrored.id}, 'alice-mirrored', 100)`;
    const sub = await fill('alice-sub');
    await sql`UPDATE trade.orders SET sub_account_id = ${CAROL} WHERE id = ${sub.id}`;
    await fill('alice-eth', ethbtc, '1', '0.05');

    // Only the first fill counts: 100 USDT, once.
    expect(await countedVolume(sql, PROGRAMME, ALICE, from, to)).toEqual({ volume: '100', fills: 1 });
    // Bob made every BTC/USDT fill for himself: his maker side counts each one.
    expect((await countedVolume(sql, PROGRAMME, BOB, from, to)).fills).toBe(6);
  });
});
