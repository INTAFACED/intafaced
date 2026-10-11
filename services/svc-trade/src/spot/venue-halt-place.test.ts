import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';

import { installVenueHaltPlace, matchingVenueHaltedRefuse, matchingSubmitVenueHaltedRefuse, VENUE_HALTED } from './venue-halt-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { Market } from './types.js';
import type { Principal } from '@intafaced/auth';
import { toCcxtError } from '../ccxt-errors.js';
import { TradeError } from './types.js';
import type { EngineSubmitResult } from './matching-client.js';

installVenueHaltPlace(TradeService);

describe('venue-halt place wrap (no swallowed fill)', () => {
  it('matching venue_halted wraps as trade.venue_halted; other codes do not', () => {
    expect(VENUE_HALTED).toBe('venue_halted');
    expect(matchingVenueHaltedRefuse(null)).toBeNull();
    expect(matchingVenueHaltedRefuse(undefined)).toBeNull();
    expect(matchingVenueHaltedRefuse({ code: 'self_trade', message: 'own rest' })).toBeNull();
    expect(matchingVenueHaltedRefuse({ code: 'market_halted', message: 'one market' })).toBeNull();
    expect(matchingVenueHaltedRefuse({ code: 'market_post_only', message: 'cross' })).toBeNull();
    expect(matchingVenueHaltedRefuse({ code: 'fok_unfillable', message: 'short' })).toBeNull();
    const refuse = matchingVenueHaltedRefuse({
      code: 'venue_halted',
      message: 'all markets are halted — new submits are refused',
    });
    expect(refuse).toMatchObject({ name: 'TradeError', code: 'trade.venue_halted' });
    expect(refuse?.message).toMatch(/halted/);
  });

  it('submit reject venue_halted is a refuse; missing rejected still proceeds', () => {
    expect(matchingSubmitVenueHaltedRefuse(null)).toBeNull();
    expect(matchingSubmitVenueHaltedRefuse(undefined)).toBeNull();
    expect(matchingSubmitVenueHaltedRefuse({ rejected: null })).toBeNull();
    expect(matchingSubmitVenueHaltedRefuse({ rejected: { code: 'self_trade' } })).toBeNull();
    expect(matchingSubmitVenueHaltedRefuse({ rejected: { code: 'market_halted' } })).toBeNull();
    expect(matchingSubmitVenueHaltedRefuse({ rejected: { code: 'venue_halted' } })).toMatchObject({
      code: 'trade.venue_halted',
    });
  });

  it('place that returns matching venue_halted throws — no silent rest', async () => {
    class Door {
      async placeOrder(_principal: Principal, _input: unknown) {
        return { id: 'take', status: 'rejected', rejectCode: 'venue_halted' };
      }
    }
    installVenueHaltPlace(Door as unknown as typeof TradeService);
    const door = new Door();
    await expect(door.placeOrder({} as Principal, {})).rejects.toMatchObject({ code: 'trade.venue_halted' });
  });

  it('halt-all submit with fills is refused — not swallowed as a fill', async () => {
    class Door {
      async placeOrder(_principal: Principal, _input: unknown) {
        return { id: 'take', status: 'filled', rejectCode: null };
      }
      async applySubmitResult(_market: unknown, _orderId: unknown, result: EngineSubmitResult) {
        if (result.fills.length > 0) {
          throw new Error('should have been converted before orig apply saw a fill');
        }
        expect(result.accepted).toBe(false);
        expect(result.rejected?.code).toBe('venue_halted');
      }
    }
    installVenueHaltPlace(Door as unknown as typeof TradeService);
    const door = new Door();
    const fill = {
      sequence: 1,
      makerOrderId: 'rest',
      makerAccountId: 'alice',
      takerOrderId: 'take',
      takerAccountId: 'bob',
      takerSide: 'buy' as const,
      price: '100',
      qty: '1',
    };
    await expect(
      door.applySubmitResult({}, 'take', {
        accepted: true,
        sequence: 1,
        fills: [fill],
        resting: null,
        rejected: { code: 'venue_halted', message: 'all markets are halted — order take not processed' },
        cancellations: [],
        triggered: [],
      }),
    ).rejects.toMatchObject({ code: 'trade.venue_halted' });
  });

  it('maps trade.venue_halted as InvalidOrder — not a fill, not a dropped symbol', () => {
    const mapped = toCcxtError(new TradeError('all markets are halted', 'trade.venue_halted'));
    expect(mapped).not.toBeNull();
    expect(mapped!.status).toBe(403);
    expect(mapped!.body.code).toBe('InvalidOrder');
    expect(mapped!.body.intafacedCode).toBe('trade.venue_halted');
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
      `H8a: svc-trade venue-halt-place is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

describe('H8a money suite is not skip-green', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-trade venue-halt-place (H8a PG-hard)', () => {
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

  describe('matching venue_halted through place', () => {
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

    it('matching reject venue_halted throws trade.venue_halted — no rest, hold released, rest stays', async () => {
      await fund(ALICE, 'BTC', '10');
      await fund(ALICE, 'USDT', '2000');

      const resting = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'alice-rest',
      });
      expect(resting.status).toBe('open');

      matching.scriptRejection('venue_halted', 'all markets are halted — new submits are refused');

      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          clientOrderId: 'alice-take',
        }),
      ).rejects.toMatchObject({ code: 'trade.venue_halted' });

      const take = await sql<Array<{ status: string; reject_code: string | null }>>`
        SELECT status, reject_code FROM trade.orders WHERE client_order_id = 'alice-take'
      `;
      expect(take).toHaveLength(1);
      expect(take[0]?.status).toBe('rejected');
      expect(take[0]?.reject_code).toBe('venue_halted');

      const still = await trade.getOrder(principalFor(ALICE, ['trade:read']), resting.id);
      expect(still.status).toBe('open');
      expect(still.filledQty).toBe(0n);

      const fills = await sql`SELECT id FROM trade.fills`;
      expect(fills).toHaveLength(0);

      expect(await avail(ALICE, 'USDT')).toBe('2000');
      expect(await avail(ALICE, 'BTC')).toBe('9');
    });

    it('cancel still works while matching would refuse a new submit', async () => {
      await fund(ALICE, 'BTC', '10');

      const resting = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'alice-cancel-rest',
      });
      expect(resting.status).toBe('open');

      matching.scriptRejection('venue_halted', 'all markets are halted — new submits are refused');

      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          clientOrderId: 'alice-cancel-take',
        }),
      ).rejects.toMatchObject({ code: 'trade.venue_halted' });

      const cancelled = await trade.cancelOrder(principalFor(ALICE), resting.id);
      expect(cancelled.status).toBe('cancelled');
      expect(matching.cancelledOrders).toContain(resting.id);
      expect(await avail(ALICE, 'BTC')).toBe('10');
    });

    it('place against a different account still fills when matching is not halt-all', async () => {
      await fund(ALICE, 'BTC', '10');
      await fund(BOB, 'USDT', '2000');

      const maker = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'alice-make',
      });
      expect(maker.status).toBe('open');

      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: ALICE, price: '100', qty: '1' }]);

      const take = await trade.placeOrder(principalFor(BOB), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'bob-take',
      });
      expect(take.status).not.toBe('rejected');
      expect(take.rejectCode).not.toBe('venue_halted');
      expect(take.status).toBe('filled');

      const fills = await sql`SELECT id FROM trade.fills`;
      expect(fills.length).toBeGreaterThan(0);
    });
  });
});
