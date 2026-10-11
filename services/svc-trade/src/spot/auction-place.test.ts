import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { type PlaceOrderInput } from './trade-service.js';
import {
  auctionIntentRefuse,
  auctionRefuse,
  benchmarkRefuse,
  bindAuction,
  installAuctionPlace,
  readAuction,
  readBenchmark,
} from './auction-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { EngineSubmitRequest } from './matching-client.js';
import type { Market } from './types.js';
import type { Principal } from '@intafaced/auth';

installAuctionPlace(TradeService);

describe('auction / benchmark place (no invented auction price)', () => {
  it('missing or false flags are not set', () => {
    expect(readAuction({})).toBe(false);
    expect(readAuction({ auction: null })).toBe(false);
    expect(readAuction({ auction: false })).toBe(false);
    expect(readAuction({ auction: true })).toBe(true);
    expect(readBenchmark({})).toBe(false);
    expect(readBenchmark({ benchmark: true })).toBe(true);
  });

  it('true flags refuse with matching codes wrapped as trade.*', () => {
    expect(auctionRefuse(false)).toBeNull();
    expect(benchmarkRefuse(false)).toBeNull();
    expect(auctionRefuse(true)).toMatchObject({ code: 'trade.auction_unsupported' });
    expect(benchmarkRefuse(true)).toMatchObject({ code: 'trade.benchmark_unsupported' });
    expect(auctionIntentRefuse({ auction: true })?.code).toBe('trade.auction_unsupported');
    expect(auctionIntentRefuse({ benchmark: true })?.code).toBe('trade.benchmark_unsupported');
    expect(auctionIntentRefuse({ auction: true, benchmark: true })?.code).toBe('trade.auction_unsupported');
    expect(auctionIntentRefuse({})).toBeNull();
    expect(auctionIntentRefuse({ auction: false, benchmark: false })).toBeNull();
  });

  it('place with auction/benchmark true refuses; missing/false stay unset', async () => {
    class Door {
      async placeOrder(_principal: Principal, input: PlaceOrderInput) {
        return { id: 'order', status: 'open', input };
      }
      toEngineRequest(...args: unknown[]): EngineSubmitRequest {
        const input = args[2] as PlaceOrderInput & { auction?: boolean | null };
        return { orderId: 'order', accountId: 'alice', type: 'limit', side: 'buy', qty: formatAmount(input.qty), tif: 'GTC' };
      }
    }
    installAuctionPlace(Door as unknown as typeof TradeService);
    const door = new Door();

    await expect(
      door.placeOrder(
        {} as Principal,
        {
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('100'),
          clientOrderId: 'auction-unit',
          auction: true,
        } as PlaceOrderInput & { auction: boolean },
      ),
    ).rejects.toMatchObject({ code: 'trade.auction_unsupported' });

    await expect(
      door.placeOrder(
        {} as Principal,
        {
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('100'),
          clientOrderId: 'bench-unit',
          benchmark: true,
        } as PlaceOrderInput & { benchmark: boolean },
      ),
    ).rejects.toMatchObject({ code: 'trade.benchmark_unsupported' });

    const forwardedAuction = door.toEngineRequest(
      'order',
      'alice',
      bindAuction({
        side: 'buy',
        type: 'limit',
        qty: amt('10'),
        price: amt('100'),
        clientOrderId: 'auction-wire-unit',
        auction: true,
      } as PlaceOrderInput & { auction: boolean }),
    );
    expect(forwardedAuction.auction).toBe(true);

    const forwardedBench = door.toEngineRequest(
      'order',
      'alice',
      bindAuction({
        side: 'buy',
        type: 'limit',
        qty: amt('10'),
        price: amt('100'),
        clientOrderId: 'bench-wire-unit',
        benchmark: true,
      } as PlaceOrderInput & { benchmark: boolean }),
    );
    expect(forwardedBench.benchmark).toBe(true);

    const falseBound = bindAuction({
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      clientOrderId: 'auction-false-unit',
      auction: false,
      benchmark: false,
    } as PlaceOrderInput & { auction: boolean; benchmark: boolean });
    expect(door.toEngineRequest('order', 'alice', falseBound).auction).toBeUndefined();
    expect(door.toEngineRequest('order', 'alice', falseBound).benchmark).toBeUndefined();

    const plain = bindAuction({
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      clientOrderId: 'gtc-plain-unit',
    });
    expect(door.toEngineRequest('order', 'alice', plain).auction).toBeUndefined();
    expect(door.toEngineRequest('order', 'alice', plain).benchmark).toBeUndefined();
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: svc-trade auction-place is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}
const ALICE = '11111111-1111-4111-8111-111111111111';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade auction-place (H8a PG-hard)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('auction / benchmark through matching', () => {
    let ledger: MemoryLedger;
    let matching: StubMatching;
    let trade: TradeService;
    let btcusdt: Market;

    async function fund(userId: string, assetId: string, amount: string) {
      await ledger.post(
        recipes.deposit({
          userId,
          assetId,
          amount: amt(amount),
          rail: 'test',
          railRef: `${userId}:${assetId}:${amount}:${Math.random()}`,
        }),
      );
    }
    const avail = async (userId: string, assetId: string) => formatAmount((await ledger.balance(userAvailable(userId, assetId))).amount);
    const postsWithReason = (reason: string) => ledger.journal().filter((tx) => tx.reason === reason);

    beforeEach(async () => {
      await sql`TRUNCATE trade.order_replace_requests, trade.fills, trade.orders, trade.markets RESTART IDENTITY CASCADE`;
      ledger = new MemoryLedger();
      matching = new StubMatching();
      trade = new TradeService(sql, ledger, matching, new StubPerks(), new MemoryEventBus('svc-trade'), {
        feeSchedule: PUBLISHED_TEST_FEE_SCHEDULE,
        marketLifecycle: READY_MARKET_LIFECYCLE,
        spotEnabled: true,
        marketSlippageCapBps: 200,
      });
      btcusdt = await trade.listMarket({
        symbol: 'BTC/USDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        tickSize: amt('0.01'),
        lotSize: amt('0.0001'),
        minQty: amt('0.0001'),
        maxQty: amt('1000'),
        minNotional: amt('1'),
        makerBps: 10,
        takerBps: 20,
      });
    });

    it('auction:true throws trade.auction_unsupported — no submit, no hold, no silent limit', async () => {
      await fund(ALICE, 'USDT', '2000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('100'),
          clientOrderId: 'auction-rest',
          auction: true,
        } as Parameters<TradeService['placeOrder']>[1] & { auction: boolean }),
      ).rejects.toMatchObject({ code: 'trade.auction_unsupported' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe('2000');
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    it('benchmark:true throws trade.benchmark_unsupported — no invented benchmark price', async () => {
      await fund(ALICE, 'USDT', '2000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('100'),
          clientOrderId: 'bench-rest',
          benchmark: true,
        } as Parameters<TradeService['placeOrder']>[1] & { benchmark: boolean }),
      ).rejects.toMatchObject({ code: 'trade.benchmark_unsupported' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe('2000');
    });

    it('false flags are a normal place — not set on the request', async () => {
      await fund(ALICE, 'USDT', '2000');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'auction-false',
        auction: false,
        benchmark: false,
      } as Parameters<TradeService['placeOrder']>[1] & { auction: boolean; benchmark: boolean });
      expect(order.status).toBe('open');
      expect(matching.submitted[0]?.request.auction).toBeUndefined();
      expect(matching.submitted[0]?.request.benchmark).toBeUndefined();
    });

    it('matching scriptRejection auction_unsupported rejects — hold released', async () => {
      await fund(ALICE, 'USDT', '2000');
      matching.scriptRejection('auction_unsupported', 'auction orders are unsupported; the engine does not invent an auction price');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('10'),
        price: amt('100'),
        clientOrderId: 'auction-engine',
      });
      expect(order.status).toBe('rejected');
      expect(order.rejectCode).toBe('auction_unsupported');
      expect(await avail(ALICE, 'USDT')).toBe('2000');
    });

    it('plain GTC does not invent auction or benchmark on the request', async () => {
      await fund(ALICE, 'USDT', '2000');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'gtc-plain',
      });
      expect(order.status).toBe('open');
      expect(matching.submitted[0]?.request.auction).toBeUndefined();
      expect(matching.submitted[0]?.request.benchmark).toBeUndefined();
    });
  });
});
