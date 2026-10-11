import { TradeService } from '../controls/test-admission.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { formatAmount, MemoryLedger, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';

import {
  installMarketPostOnlyPlace,
  matchingMarketPostOnlyRefuse,
  matchingSubmitMarketPostOnlyRefuse,
  MARKET_POST_ONLY,
} from './market-post-only-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { Market } from './types.js';
import type { Principal } from '@intafaced/auth';
import { toCcxtError } from '../ccxt-errors.js';
import { TradeError } from './types.js';
import type { EngineSubmitResult } from './matching-client.js';

installMarketPostOnlyPlace(TradeService);

describe('market-post-only place wrap (no swallowed fill)', () => {
  it('matching market_post_only wraps as trade.market_post_only; other codes do not', () => {
    expect(MARKET_POST_ONLY).toBe('market_post_only');
    expect(matchingMarketPostOnlyRefuse(null)).toBeNull();
    expect(matchingMarketPostOnlyRefuse(undefined)).toBeNull();
    expect(matchingMarketPostOnlyRefuse({ code: 'self_trade', message: 'own rest' })).toBeNull();
    expect(matchingMarketPostOnlyRefuse({ code: 'market_halted', message: 'halted' })).toBeNull();
    expect(matchingMarketPostOnlyRefuse({ code: 'market_reduce_only', message: 'grow' })).toBeNull();
    expect(matchingMarketPostOnlyRefuse({ code: 'post_only_would_cross', message: 'cross' })).toBeNull();
    const refuse = matchingMarketPostOnlyRefuse({
      code: 'market_post_only',
      message: 'market BTC/USDT is post-only — non-post-only submits are refused',
    });
    expect(refuse).toMatchObject({ name: 'TradeError', code: 'trade.market_post_only' });
    expect(refuse?.message).toMatch(/post-only/);
  });

  it('submit reject market_post_only is a refuse; missing rejected still proceeds', () => {
    expect(matchingSubmitMarketPostOnlyRefuse(null)).toBeNull();
    expect(matchingSubmitMarketPostOnlyRefuse(undefined)).toBeNull();
    expect(matchingSubmitMarketPostOnlyRefuse({ rejected: null })).toBeNull();
    expect(matchingSubmitMarketPostOnlyRefuse({ rejected: { code: 'self_trade' } })).toBeNull();
    expect(matchingSubmitMarketPostOnlyRefuse({ rejected: { code: 'market_post_only' } })).toMatchObject({
      code: 'trade.market_post_only',
    });
  });

  it('place that returns matching market_post_only throws — no silent rest', async () => {
    class Door {
      async placeOrder(_principal: Principal, _input: unknown) {
        return { id: 'take', status: 'rejected', rejectCode: 'market_post_only' };
      }
    }
    installMarketPostOnlyPlace(Door as unknown as typeof TradeService);
    const door = new Door();
    await expect(door.placeOrder({} as Principal, {})).rejects.toMatchObject({ code: 'trade.market_post_only' });
  });

  it('post-only place that rests is not converted into a refuse', async () => {
    class Door {
      async placeOrder(_principal: Principal, _input: unknown) {
        return { id: 'maker', status: 'open', rejectCode: null };
      }
    }
    installMarketPostOnlyPlace(Door as unknown as typeof TradeService);
    const door = new Door();
    await expect(door.placeOrder({} as Principal, {})).resolves.toMatchObject({ status: 'open' });
  });

  it('post-only-market submit with fills is refused — not swallowed as a fill', async () => {
    class Door {
      async placeOrder(_principal: Principal, _input: unknown) {
        return { id: 'take', status: 'filled', rejectCode: null };
      }
      async applySubmitResult(_market: unknown, _orderId: unknown, result: EngineSubmitResult) {
        if (result.fills.length > 0) {
          throw new Error('should have been converted before orig apply saw a fill');
        }
        expect(result.accepted).toBe(false);
        expect(result.rejected?.code).toBe('market_post_only');
      }
    }
    installMarketPostOnlyPlace(Door as unknown as typeof TradeService);
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
        rejected: { code: 'market_post_only', message: 'market is post-only — order take is not post-only' },
        cancellations: [],
        triggered: [],
      }),
    ).rejects.toMatchObject({ code: 'trade.market_post_only' });
  });

  it('accepted post-only rest apply still settles — wrap does not invent a refuse', async () => {
    class Door {
      seen: EngineSubmitResult | null = null;
      async applySubmitResult(_market: unknown, _orderId: unknown, result: EngineSubmitResult) {
        this.seen = result;
      }
    }
    installMarketPostOnlyPlace(Door as unknown as typeof TradeService);
    const door = new Door();
    await door.applySubmitResult({}, 'maker', {
      accepted: true,
      sequence: 1,
      fills: [],
      resting: {
        kind: 'book',
        orderId: 'maker',
        accountId: 'alice',
        side: 'sell',
        price: '100',
        remaining: '1',
        sequence: 1,
      },
      rejected: null,
      cancellations: [],
      triggered: [],
    });
    expect(door.seen?.accepted).toBe(true);
    expect(door.seen?.rejected).toBeNull();
  });

  it('maps trade.market_post_only as InvalidOrder — not a fill, not a dropped symbol', () => {
    const mapped = toCcxtError(new TradeError('market is post-only', 'trade.market_post_only'));
    expect(mapped).not.toBeNull();
    expect(mapped!.status).toBe(403);
    expect(mapped!.body.code).toBe('InvalidOrder');
    expect(mapped!.body.intafacedCode).toBe('trade.market_post_only');
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
      `H8a: svc-trade market-post-only-place is PG-hard (no skip-green). ` +
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

describe('svc-trade market-post-only-place (H8a PG-hard)', () => {
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

  describe('matching market_post_only through place', () => {
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

    it('matching reject market_post_only throws trade.market_post_only — no rest, hold released, rest stays', async () => {
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

      matching.scriptRejection('market_post_only', 'market is post-only — non-post-only submits are refused');

      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          clientOrderId: 'alice-take',
        }),
      ).rejects.toMatchObject({ code: 'trade.market_post_only' });

      const take = await sql<Array<{ status: string; reject_code: string | null }>>`
        SELECT status, reject_code FROM trade.orders WHERE client_order_id = 'alice-take'
      `;
      expect(take).toHaveLength(1);
      expect(take[0]?.status).toBe('rejected');
      expect(take[0]?.reject_code).toBe('market_post_only');

      const still = await trade.getOrder(principalFor(ALICE, ['trade:read']), resting.id);
      expect(still.status).toBe('open');
      expect(still.filledQty).toBe(0n);

      const fills = await sql`SELECT id FROM trade.fills`;
      expect(fills).toHaveLength(0);

      expect(await avail(ALICE, 'USDT')).toBe('2000');
      expect(await avail(ALICE, 'BTC')).toBe('9');
    });

    it('post-only still rests while matching would refuse a taker', async () => {
      await fund(ALICE, 'BTC', '10');

      const resting = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'alice-po-rest',
      });
      expect(resting.status).toBe('open');

      matching.scriptRejection('market_post_only', 'market is post-only — non-post-only submits are refused');

      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          clientOrderId: 'alice-po-take',
        }),
      ).rejects.toMatchObject({ code: 'trade.market_post_only' });

      const maker = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        tif: 'PO',
        clientOrderId: 'alice-po-maker',
      });
      expect(maker.status).toBe('open');
      expect(maker.rejectCode).not.toBe('market_post_only');
    });

    it('cancel still works while matching would refuse a taker', async () => {
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

      matching.scriptRejection('market_post_only', 'market is post-only — non-post-only submits are refused');

      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          clientOrderId: 'alice-cancel-take',
        }),
      ).rejects.toMatchObject({ code: 'trade.market_post_only' });

      const cancelled = await trade.cancelOrder(principalFor(ALICE), resting.id);
      expect(cancelled.status).toBe('cancelled');
      expect(matching.cancelledOrders).toContain(resting.id);
      expect(await avail(ALICE, 'BTC')).toBe('10');
    });

    it('place against a different account still fills when matching is not post-only', async () => {
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
      expect(take.rejectCode).not.toBe('market_post_only');
      expect(take.status).toBe('filled');

      const fills = await sql`SELECT id FROM trade.fills`;
      expect(fills.length).toBeGreaterThan(0);
    });
  });
});
