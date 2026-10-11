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
  COLLAR_MISSING,
  COLLAR_OUTSIDE,
  bindCollar,
  collarIntentRefuse,
  installCollarPlace,
  matchingCollarRefuse,
  matchingSubmitCollarRefuse,
  missingCollarRefuse,
  outsideCollarRefuse,
  readCollar,
  readMax,
  readMin,
} from './collar-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { EngineSubmitRequest, EngineSubmitResult } from './matching-client.js';
import type { Market } from './types.js';
import type { Principal } from '@intafaced/auth';
import { toCcxtError } from '../ccxt-errors.js';
import { TradeError } from './types.js';

installCollarPlace(TradeService);

type CollarInput = PlaceOrderInput & { collar?: boolean | null; min?: ReturnType<typeof amt> | null; max?: ReturnType<typeof amt> | null };

describe('price collar place — caller min/max, never last or mid', () => {
  it('missing flags are not a collar; false is not set', () => {
    expect(readCollar({})).toBe(false);
    expect(readCollar({ collar: null })).toBe(false);
    expect(readCollar({ collar: false })).toBe(false);
    expect(readCollar({ collar: true })).toBe(true);
    expect(readMin({})).toBeNull();
    expect(readMin({ min: null })).toBeNull();
    expect(readMin({ min: amt('0') })).toBeNull();
    expect(readMin({ min: amt('90') })).toBe(amt('90'));
    expect(readMax({})).toBeNull();
    expect(readMax({ max: null })).toBeNull();
    expect(readMax({ max: amt('0') })).toBeNull();
    expect(readMax({ max: amt('110') })).toBe(amt('110'));
  });

  it('collar:true without both bounds refuses — no invented last or mid', () => {
    expect(missingCollarRefuse(null, amt('110'))?.code).toBe('trade.missing_collar');
    expect(missingCollarRefuse(amt('90'), null)?.code).toBe('trade.missing_collar');
    expect(missingCollarRefuse(amt('90'), amt('110'))).toBeNull();
    expect(collarIntentRefuse({ collar: true })?.code).toBe('trade.missing_collar');
    expect(collarIntentRefuse({ collar: true, min: amt('90') })?.code).toBe('trade.missing_collar');
    expect(collarIntentRefuse({ collar: true, max: amt('110') })?.code).toBe('trade.missing_collar');
    expect(collarIntentRefuse({})).toBeNull();
    expect(collarIntentRefuse({ collar: false, min: amt('90') })).toBeNull();
  });

  it('submit outside the band refuses; edges are inside', () => {
    expect(outsideCollarRefuse(amt('80'), amt('90'), amt('110'))?.code).toBe('trade.outside_collar');
    expect(outsideCollarRefuse(amt('120'), amt('90'), amt('110'))?.code).toBe('trade.outside_collar');
    expect(outsideCollarRefuse(null, amt('90'), amt('110'))?.code).toBe('trade.outside_collar');
    expect(outsideCollarRefuse(amt('90'), amt('90'), amt('110'))).toBeNull();
    expect(outsideCollarRefuse(amt('110'), amt('90'), amt('110'))).toBeNull();
    expect(collarIntentRefuse({ collar: true, min: amt('90'), max: amt('110'), price: amt('80') })?.code).toBe('trade.outside_collar');
    expect(collarIntentRefuse({ collar: true, min: amt('90'), max: amt('110'), price: amt('100') })).toBeNull();
  });

  it('matching missing_collar / outside_collar wrap as trade.*; other codes do not', () => {
    expect(COLLAR_MISSING).toBe('missing_collar');
    expect(COLLAR_OUTSIDE).toBe('outside_collar');
    expect(matchingCollarRefuse(null)).toBeNull();
    expect(matchingCollarRefuse(undefined)).toBeNull();
    expect(matchingCollarRefuse({ code: 'self_trade', message: 'own rest' })).toBeNull();
    expect(matchingCollarRefuse({ code: 'market_expired', message: 'expired' })).toBeNull();
    expect(matchingCollarRefuse({ code: 'missing_collar' })).toMatchObject({ code: 'trade.missing_collar' });
    expect(matchingCollarRefuse({ code: 'outside_collar' })).toMatchObject({ code: 'trade.outside_collar' });
    expect(matchingSubmitCollarRefuse(null)).toBeNull();
    expect(matchingSubmitCollarRefuse({ rejected: { code: 'self_trade' } })).toBeNull();
    expect(matchingSubmitCollarRefuse({ rejected: { code: 'missing_collar' } })).toMatchObject({
      code: 'trade.missing_collar',
    });
    expect(matchingSubmitCollarRefuse({ rejected: { code: 'outside_collar' } })).toMatchObject({
      code: 'trade.outside_collar',
    });
  });

  it('place that returns matching missing_collar / outside_collar throws — no silent rest', async () => {
    class Door {
      async placeOrder(_principal: Principal, _input: unknown) {
        return { id: 'take', status: 'rejected', rejectCode: 'missing_collar' };
      }
    }
    installCollarPlace(Door as unknown as typeof TradeService);
    const door = new Door();
    await expect(door.placeOrder({} as Principal, {})).rejects.toMatchObject({ code: 'trade.missing_collar' });

    class Outside {
      async placeOrder(_principal: Principal, _input: unknown) {
        return { id: 'take', status: 'rejected', rejectCode: 'outside_collar' };
      }
    }
    installCollarPlace(Outside as unknown as typeof TradeService);
    await expect(new Outside().placeOrder({} as Principal, {})).rejects.toMatchObject({ code: 'trade.outside_collar' });
  });

  it('collar submit with fills is refused — not swallowed as a fill', async () => {
    class Door {
      async placeOrder(_principal: Principal, _input: unknown) {
        return { id: 'take', status: 'filled', rejectCode: null };
      }
      async applySubmitResult(_market: unknown, _orderId: unknown, result: EngineSubmitResult) {
        if (result.fills.length > 0) {
          throw new Error('should have been converted before orig apply saw a fill');
        }
        expect(result.accepted).toBe(false);
        expect(result.rejected?.code).toBe('outside_collar');
      }
    }
    installCollarPlace(Door as unknown as typeof TradeService);
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
        rejected: { code: 'outside_collar', message: 'submit price is outside the caller collar' },
        cancellations: [],
        triggered: [],
      }),
    ).rejects.toMatchObject({ code: 'trade.outside_collar' });
  });

  it('maps collar refuses as InvalidOrder — not a fill, not a dropped symbol', () => {
    const missing = toCcxtError(new TradeError('collar requires caller min and max', 'trade.missing_collar'));
    expect(missing).not.toBeNull();
    expect(missing!.status).toBe(400);
    expect(missing!.body.code).toBe('InvalidOrder');
    expect(missing!.body.intafacedCode).toBe('trade.missing_collar');
    const outside = toCcxtError(new TradeError('submit price is outside the caller collar', 'trade.outside_collar'));
    expect(outside!.status).toBe(400);
    expect(outside!.body.code).toBe('InvalidOrder');
    expect(outside!.body.intafacedCode).toBe('trade.outside_collar');
  });

  it('place with collar:true and bounds reaches matching; missing/false stay unset', async () => {
    class Door {
      async placeOrder(_principal: Principal, input: PlaceOrderInput) {
        return { id: 'order', status: 'open', input };
      }
      toEngineRequest(...args: unknown[]): EngineSubmitRequest {
        const input = args[2] as CollarInput;
        return { orderId: 'order', accountId: 'alice', type: 'limit', side: 'buy', qty: formatAmount(input.qty), tif: 'GTC' };
      }
    }
    installCollarPlace(Door as unknown as typeof TradeService);
    const door = new Door();
    const origPlace = Door.prototype.placeOrder;
    let placed: PlaceOrderInput | null = null;
    Door.prototype.placeOrder = async function (this: Door, principal: Principal, input: PlaceOrderInput) {
      placed = input;
      return origPlace.call(this, principal, input);
    };

    await door.placeOrder(
      {} as Principal,
      {
        side: 'buy',
        type: 'limit',
        qty: amt('10'),
        price: amt('100'),
        clientOrderId: 'col-unit',
        collar: true,
        min: amt('90'),
        max: amt('110'),
      } as CollarInput,
    );
    const forwarded = door.toEngineRequest('order', 'alice', placed);
    expect(forwarded.collar).toBe(true);
    expect(forwarded.min).toBe('90');
    expect(forwarded.max).toBe('110');

    await expect(
      door.placeOrder(
        {} as Principal,
        {
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('100'),
          clientOrderId: 'col-miss-unit',
          collar: true,
        } as CollarInput,
      ),
    ).rejects.toMatchObject({ code: 'trade.missing_collar' });

    await expect(
      door.placeOrder(
        {} as Principal,
        {
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('80'),
          clientOrderId: 'col-out-unit',
          collar: true,
          min: amt('90'),
          max: amt('110'),
        } as CollarInput,
      ),
    ).rejects.toMatchObject({ code: 'trade.outside_collar' });

    const falseBound = bindCollar({
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      clientOrderId: 'col-false-unit',
      collar: false,
    } as CollarInput);
    expect(door.toEngineRequest('order', 'alice', falseBound).collar).toBeUndefined();
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
      `H8a: svc-trade collar-place is PG-hard (no skip-green). ` +
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

describe('svc-trade collar-place (H8a PG-hard)', () => {
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

  describe('matching collar through place', () => {
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

    it('collar:true without min/max throws trade.missing_collar — no submit, no hold, no invented band', async () => {
      await fund(ALICE, 'USDT', '2000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          clientOrderId: 'alice-miss',
          collar: true,
        } as CollarInput),
      ).rejects.toMatchObject({ code: 'trade.missing_collar' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe('2000');
      const rows = await sql`SELECT id FROM trade.orders WHERE client_order_id = 'alice-miss'`;
      expect(rows).toHaveLength(0);
    });

    it('submit below min throws trade.outside_collar — no rest, no fill', async () => {
      await fund(ALICE, 'USDT', '2000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('80'),
          clientOrderId: 'alice-lo',
          collar: true,
          min: amt('90'),
          max: amt('110'),
        } as CollarInput),
      ).rejects.toMatchObject({ code: 'trade.outside_collar' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe('2000');
      const fills = await sql`SELECT id FROM trade.fills`;
      expect(fills).toHaveLength(0);
    });

    it('submit above max throws trade.outside_collar — no rest, no fill', async () => {
      await fund(ALICE, 'BTC', '10');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'sell',
          type: 'limit',
          qty: amt('1'),
          price: amt('120'),
          clientOrderId: 'alice-hi',
          collar: true,
          min: amt('90'),
          max: amt('110'),
        } as CollarInput),
      ).rejects.toMatchObject({ code: 'trade.outside_collar' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'BTC')).toBe('10');
    });

    it('collar inside the band forwards min/max and takes at the caller price', async () => {
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
        clientOrderId: 'bob-col',
        collar: true,
        min: amt('90'),
        max: amt('110'),
      } as CollarInput);
      expect(take.status).toBe('filled');
      expect(matching.submitted.at(-1)?.request.collar).toBe(true);
      expect(matching.submitted.at(-1)?.request.min).toBe('90');
      expect(matching.submitted.at(-1)?.request.max).toBe('110');
      const fills = await sql`SELECT id FROM trade.fills`;
      expect(fills.length).toBeGreaterThan(0);
    });

    it('matching reject outside_collar throws trade.outside_collar — no fill, hold released, rest stays', async () => {
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

      matching.scriptRejection('outside_collar', 'submit price is outside the caller collar; the engine does not invent last or mid');

      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          clientOrderId: 'alice-take',
          collar: true,
          min: amt('90'),
          max: amt('110'),
        } as CollarInput),
      ).rejects.toMatchObject({ code: 'trade.outside_collar' });

      const take = await sql<Array<{ status: string; reject_code: string | null }>>`
        SELECT status, reject_code FROM trade.orders WHERE client_order_id = 'alice-take'
      `;
      expect(take).toHaveLength(1);
      expect(take[0]?.status).toBe('rejected');
      expect(take[0]?.reject_code).toBe('outside_collar');

      const still = await trade.getOrder(principalFor(ALICE, ['trade:read']), resting.id);
      expect(still.status).toBe('open');
      expect(still.filledQty).toBe(0n);

      const fills = await sql`SELECT id FROM trade.fills`;
      expect(fills).toHaveLength(0);

      expect(await avail(ALICE, 'USDT')).toBe('2000');
      expect(await avail(ALICE, 'BTC')).toBe('9');
    });

    it('matching reject missing_collar throws — cancel still works, rest stays', async () => {
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

      matching.scriptRejection('missing_collar', 'collar requires caller min and max; the engine does not invent last or mid');

      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('1'),
          price: amt('100'),
          clientOrderId: 'alice-cancel-take',
          collar: true,
          min: amt('90'),
          max: amt('110'),
        } as CollarInput),
      ).rejects.toMatchObject({ code: 'trade.missing_collar' });

      const cancelled = await trade.cancelOrder(principalFor(ALICE), resting.id);
      expect(cancelled.status).toBe('cancelled');
      expect(matching.cancelledOrders).toContain(resting.id);
      expect(await avail(ALICE, 'BTC')).toBe('10');
    });

    it('missing collar flags still fill — no invented band', async () => {
      await fund(ALICE, 'BTC', '10');
      await fund(BOB, 'USDT', '2000');

      const maker = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'sell',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'alice-plain',
      });
      matching.scriptFills([{ makerOrderId: maker.id, makerAccountId: ALICE, price: '100', qty: '1' }]);
      const take = await trade.placeOrder(principalFor(BOB), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('1'),
        price: amt('100'),
        clientOrderId: 'bob-plain',
      });
      expect(take.status).toBe('filled');
      expect(matching.submitted.at(-1)?.request.collar).toBeUndefined();
    });
  });
});
