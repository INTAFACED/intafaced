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
  bindPeg,
  installPegPlace,
  midpointRefuse,
  pegIntentRefuse,
  pegRefuse,
  readMidpoint,
  readPeg,
  readRelative,
  relativeRefuse,
} from './peg-place.js';
import { READY_MARKET_LIFECYCLE, StubMatching, StubPerks, principalFor, PUBLISHED_TEST_FEE_SCHEDULE } from './testing.js';
import type { EngineSubmitRequest } from './matching-client.js';
import type { Market } from './types.js';
import type { Principal } from '@intafaced/auth';

installPegPlace(TradeService);

describe('peg / midpoint / relative place (no invented mid)', () => {
  it('missing or false flags are not set', () => {
    expect(readPeg({})).toBe(false);
    expect(readPeg({ peg: null })).toBe(false);
    expect(readPeg({ peg: false })).toBe(false);
    expect(readPeg({ peg: true })).toBe(true);
    expect(readMidpoint({})).toBe(false);
    expect(readMidpoint({ midpoint: true })).toBe(true);
    expect(readRelative({})).toBe(false);
    expect(readRelative({ relative: true })).toBe(true);
  });

  it('true flags refuse with matching codes wrapped as trade.*', () => {
    expect(pegRefuse(false)).toBeNull();
    expect(midpointRefuse(false)).toBeNull();
    expect(relativeRefuse(false)).toBeNull();
    expect(pegRefuse(true)).toMatchObject({ code: 'trade.peg_unsupported' });
    expect(midpointRefuse(true)).toMatchObject({ code: 'trade.midpoint_unsupported' });
    expect(relativeRefuse(true)).toMatchObject({ code: 'trade.relative_unsupported' });
    expect(pegIntentRefuse({ peg: true })?.code).toBe('trade.peg_unsupported');
    expect(pegIntentRefuse({ midpoint: true })?.code).toBe('trade.midpoint_unsupported');
    expect(pegIntentRefuse({ relative: true })?.code).toBe('trade.relative_unsupported');
    expect(pegIntentRefuse({})).toBeNull();
    expect(pegIntentRefuse({ peg: false, midpoint: false, relative: false })).toBeNull();
  });

  it('place with peg/midpoint/relative true refuses; missing/false stay unset', async () => {
    class Door {
      async placeOrder(_principal: Principal, input: PlaceOrderInput) {
        return { id: 'order', status: 'open', input };
      }
      toEngineRequest(...args: unknown[]): EngineSubmitRequest {
        const input = args[2] as PlaceOrderInput & { peg?: boolean | null };
        return { orderId: 'order', accountId: 'alice', type: 'limit', side: 'buy', qty: formatAmount(input.qty), tif: 'GTC' };
      }
    }
    installPegPlace(Door as unknown as typeof TradeService);
    const door = new Door();

    await expect(
      door.placeOrder(
        {} as Principal,
        {
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('100'),
          clientOrderId: 'peg-unit',
          peg: true,
        } as PlaceOrderInput & { peg: boolean },
      ),
    ).rejects.toMatchObject({ code: 'trade.peg_unsupported' });

    await expect(
      door.placeOrder(
        {} as Principal,
        {
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('100'),
          clientOrderId: 'mid-unit',
          midpoint: true,
        } as PlaceOrderInput & { midpoint: boolean },
      ),
    ).rejects.toMatchObject({ code: 'trade.midpoint_unsupported' });

    await expect(
      door.placeOrder(
        {} as Principal,
        {
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('100'),
          clientOrderId: 'rel-unit',
          relative: true,
        } as PlaceOrderInput & { relative: boolean },
      ),
    ).rejects.toMatchObject({ code: 'trade.relative_unsupported' });

    const forwardedPeg = door.toEngineRequest(
      'order',
      'alice',
      bindPeg({
        side: 'buy',
        type: 'limit',
        qty: amt('10'),
        price: amt('100'),
        clientOrderId: 'peg-wire-unit',
        peg: true,
      } as PlaceOrderInput & { peg: boolean }),
    );
    expect(forwardedPeg.peg).toBe(true);

    const falseBound = bindPeg({
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      clientOrderId: 'peg-false-unit',
      peg: false,
      midpoint: false,
      relative: false,
    } as PlaceOrderInput & { peg: boolean; midpoint: boolean; relative: boolean });
    expect(door.toEngineRequest('order', 'alice', falseBound).peg).toBeUndefined();
    expect(door.toEngineRequest('order', 'alice', falseBound).midpoint).toBeUndefined();
    expect(door.toEngineRequest('order', 'alice', falseBound).relative).toBeUndefined();

    const plain = bindPeg({
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('100'),
      clientOrderId: 'gtc-plain-unit',
    });
    expect(door.toEngineRequest('order', 'alice', plain).peg).toBeUndefined();
    expect(door.toEngineRequest('order', 'alice', plain).midpoint).toBeUndefined();
    expect(door.toEngineRequest('order', 'alice', plain).relative).toBeUndefined();
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
      `H8a: svc-trade peg-place is PG-hard (no skip-green). ` +
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

describe('svc-trade peg-place (H8a PG-hard)', () => {
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

  describe('peg / midpoint / relative through matching', () => {
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

    it('peg:true throws trade.peg_unsupported — no submit, no hold, no silent limit', async () => {
      await fund(ALICE, 'USDT', '2000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('100'),
          clientOrderId: 'peg-rest',
          peg: true,
        } as Parameters<TradeService['placeOrder']>[1] & { peg: boolean }),
      ).rejects.toMatchObject({ code: 'trade.peg_unsupported' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe('2000');
      expect(postsWithReason('order.hold')).toHaveLength(0);
    });

    it('midpoint:true throws trade.midpoint_unsupported — no invented mid', async () => {
      await fund(ALICE, 'USDT', '2000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('100'),
          clientOrderId: 'mid-rest',
          midpoint: true,
        } as Parameters<TradeService['placeOrder']>[1] & { midpoint: boolean }),
      ).rejects.toMatchObject({ code: 'trade.midpoint_unsupported' });
      expect(matching.submitted).toHaveLength(0);
      expect(await avail(ALICE, 'USDT')).toBe('2000');
    });

    it('relative:true throws trade.relative_unsupported — no invented reference', async () => {
      await fund(ALICE, 'USDT', '2000');
      await expect(
        trade.placeOrder(principalFor(ALICE), {
          marketId: btcusdt.id,
          side: 'buy',
          type: 'limit',
          qty: amt('10'),
          price: amt('100'),
          clientOrderId: 'rel-rest',
          relative: true,
        } as Parameters<TradeService['placeOrder']>[1] & { relative: boolean }),
      ).rejects.toMatchObject({ code: 'trade.relative_unsupported' });
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
        clientOrderId: 'peg-false',
        peg: false,
        midpoint: false,
        relative: false,
      } as Parameters<TradeService['placeOrder']>[1] & { peg: boolean; midpoint: boolean; relative: boolean });
      expect(order.status).toBe('open');
      expect(matching.submitted[0]?.request.peg).toBeUndefined();
      expect(matching.submitted[0]?.request.midpoint).toBeUndefined();
      expect(matching.submitted[0]?.request.relative).toBeUndefined();
    });

    it('matching scriptRejection peg_unsupported rejects — hold released', async () => {
      await fund(ALICE, 'USDT', '2000');
      matching.scriptRejection('peg_unsupported', 'pegged orders are unsupported; the engine does not invent a reference price');
      const order = await trade.placeOrder(principalFor(ALICE), {
        marketId: btcusdt.id,
        side: 'buy',
        type: 'limit',
        qty: amt('10'),
        price: amt('100'),
        clientOrderId: 'peg-engine',
      });
      expect(order.status).toBe('rejected');
      expect(order.rejectCode).toBe('peg_unsupported');
      expect(await avail(ALICE, 'USDT')).toBe('2000');
    });

    it('plain GTC does not invent peg, midpoint, or relative on the request', async () => {
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
      expect(matching.submitted[0]?.request.peg).toBeUndefined();
      expect(matching.submitted[0]?.request.midpoint).toBeUndefined();
      expect(matching.submitted[0]?.request.relative).toBeUndefined();
    });
  });
});
