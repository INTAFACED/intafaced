/**
 * Cancel-on-disconnect for futures (J-derivatives-04 step 5, D-orders-02), against the real trade schema and
 * MemoryLedger: when the dead-man switch fires, every live futures order of that trader is cancelled through the
 * ordinary cancel, each hold released once, a liquidation's order left alone, and another trader's orders untouched. A
 * transport fault on one order is raised after the rest are tried, so the switch stays armed and the next pass finishes.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLedger, formatAmount, futuresOrderMarginAccount, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { EngineCancelResult, EngineSubmitRequest, EngineSubmitResult, MatchingClient } from '../spot/matching-client.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { MatchedFuturesOrders, type MatchedOrdersDeps, type PlaceMatchedOrderInput } from './matched-orders.js';
import type { FeeRates } from './matched-order-plan.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const files = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const migrations = files.map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_cancel_every_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`the dead-man futures cancel needs Postgres: TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
  }
}

const A = (s: string) => parseAmount(s);
const USDT = 'USDT';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const MARKET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SYMBOL = 'SOL/USDT-PERP';
const OTHER_MARKET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER = 'ETH/USDT-PERP';
const NOW = new Date('2026-10-24T06:00:00.000Z');
const PROOF = { stub: true } as unknown as LifecycleAdmissionProof;

/** Engine that rests every order untouched; fills are delivered by the test with `settleFill`, as the event path does. */
class RestingEngine {
  readonly submits: EngineSubmitRequest[] = [];
  readonly cancels: string[] = [];
  private seq = 7000;

  async submit(_marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    this.submits.push(request);
    this.seq += 1;
    return {
      accepted: true,
      sequence: this.seq,
      fills: [],
      resting: {
        kind: 'book',
        orderId: request.orderId,
        accountId: request.accountId,
        side: request.side,
        price: request.price ?? '0',
        remaining: request.qty,
        sequence: this.seq,
      },
      rejected: null,
      cancellations: [],
      triggered: [],
    };
  }

  async cancel(_marketId: string, orderId: string): Promise<EngineCancelResult> {
    this.cancels.push(orderId);
    this.seq += 1;
    const sent = this.submits.find((s) => s.orderId === orderId);
    const cancellation = { orderId, accountId: 'fake', remainingQty: sent?.qty ?? '0', sequence: this.seq, reason: 'cancel' };
    return { cancelled: true, orderId, sequence: this.seq, cancellation };
  }
}

const principal = (userId: string) => ({ userId, scopes: [] }) as unknown as Principal;

describe('svc-trade futures orders cleared by the dead-man switch (PG-backed)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];

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

  let ledger: MemoryLedger;
  let engine: RestingEngine;
  let admission: TradingAdmissionPort;

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.futures_order_fills, trade.futures_orders, trade.positions, trade.markets, trade.futures_payouts,
               trade.futures_fill_waits, trade.account_position_modes, trade.liquidation_rungs, trade.futures_adl_pairs,
               trade.futures_conditional_orders, trade.futures_reverse_requests
      RESTART IDENTITY CASCADE
    `;
    for (const [id, symbol, base] of [
      [MARKET, SYMBOL, 'SOL'],
      [OTHER_MARKET, OTHER, 'ETH'],
    ] as const) {
      await sql`
        INSERT INTO trade.markets (
          id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
          maker_bps, taker_bps, status, display_name, listed_at
        ) VALUES (
          ${id}, ${symbol}, ${base}, 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', ${symbol}, now()
        )
      `;
    }
    ledger = new MemoryLedger();
    engine = new RestingEngine();
    admission = { admit: vi.fn(async () => ({})), admitStanding: vi.fn(async () => ({})) } as unknown as TradingAdmissionPort;
    for (const userId of [ALICE, BOB]) {
      await ledger.post(
        recipes.deposit({ userId, assetId: USDT, amount: A('1000'), rail: 'test', railRef: `fund-${userId}-${randomUUID()}` }),
      );
    }
  });

  function build(overrides: Partial<MatchedOrdersDeps> = {}): MatchedFuturesOrders {
    return new MatchedFuturesOrders({
      sql,
      ledger,
      matching: engine as unknown as MatchingClient,
      enabled: true,
      priceBand: A('0.05'),
      maxLeverage: A('10'),
      now: () => NOW,
      markFor: async () => A('100'),
      assertPositionIdle: async () => undefined,
      lifecycleProof: async () => PROOF,
      admission,
      emailProof: { get: async () => 'accepted' },
      feeRates: async () => ({ makerBps: 2, takerBps: 5 }),
      ...overrides,
    });
  }

  function order(
    overrides: Partial<PlaceMatchedOrderInput> & Pick<PlaceMatchedOrderInput, 'userId' | 'side' | 'qty'>,
  ): PlaceMatchedOrderInput {
    return { symbol: SYMBOL, type: 'limit', limitPrice: A('100'), leverage: A('10'), clientOrderId: `c-${randomUUID()}`, ...overrides };
  }

  const free = async (userId: string) => (await ledger.balance(userAvailable(userId, USDT))).amount;
  const statusOf = async (orderId: string) =>
    (await sql<{ status: string }[]>`SELECT status FROM trade.futures_orders WHERE id = ${orderId}`)[0]!.status;

  it('every live order of the trader, on every contract, cancelled and released once; nobody else’s', async () => {
    const svc = build();
    const a = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const b = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), symbol: OTHER, orderLabel: 'bot' }));
    const bobs = await svc.place(principal(BOB), order({ userId: BOB, side: 'buy', qty: A('1') }));
    expect(await free(ALICE)).toBeLessThan(A('1000'));
    expect((await svc.cancelEveryOrder(principal(ALICE))).sort()).toEqual([a.orderId, b.orderId].sort());
    expect(await free(ALICE)).toBe(A('1000'));
    expect(await statusOf(bobs.orderId)).toBe('open');
    // A second pass moves nothing.
    expect(await svc.cancelEveryOrder(principal(ALICE))).toEqual([]);
    expect(await free(ALICE)).toBe(A('1000'));
    expect(engine.cancels).toHaveLength(2);
  });

  it('an order not yet sent is cancelled before it can reach the book: released, the engine not asked', async () => {
    const svc = build();
    const a = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    // As an order whose hold is posted but which no submit has claimed yet.
    await sql`UPDATE trade.futures_orders SET status = 'held' WHERE id = ${a.orderId}`;
    expect(await svc.cancelEveryOrder(principal(ALICE))).toEqual([a.orderId]);
    expect(await statusOf(a.orderId)).toBe('cancelled');
    expect(await free(ALICE)).toBe(A('1000'));
    expect(engine.cancels).toEqual([]);
  });

  it('an order the book does not confirm off, one still pending its hold, or no engine at all keeps the switch armed', async () => {
    const svc = build();
    const a = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const real = engine.cancel.bind(engine);
    engine.cancel = async (_m, orderId) => ({ cancelled: false, orderId, sequence: null, cancellation: null }) as never;
    await expect(svc.cancelEveryOrder(principal(ALICE))).rejects.toMatchObject({ code: 'trade.futures_cancel_unresolved' });
    expect(await statusOf(a.orderId)).toBe('open');
    engine.cancel = real;

    await sql`UPDATE trade.futures_orders SET status = 'pending' WHERE id = ${a.orderId}`;
    await expect(svc.cancelEveryOrder(principal(ALICE))).rejects.toMatchObject({ code: 'trade.futures_cancel_unresolved' });
    await sql`UPDATE trade.futures_orders SET status = 'open' WHERE id = ${a.orderId}`;

    await expect(build({ matching: undefined }).cancelEveryOrder(principal(ALICE))).rejects.toMatchObject({
      code: 'trade.futures_matching_unconfigured',
    });
    expect(await statusOf(a.orderId)).toBe('open');
    expect(await svc.cancelEveryOrder(principal(ALICE))).toEqual([a.orderId]);
    expect(await free(ALICE)).toBe(A('1000'));
  });

  it('a fault on one order is raised once the rest are cancelled, so the next pass finishes it', async () => {
    const svc = build();
    const a = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const b = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const real = engine.cancel.bind(engine);
    engine.cancel = async (marketId, orderId) => {
      if (orderId === a.orderId) throw new Error('engine timed out');
      return real(marketId, orderId);
    };
    await expect(svc.cancelEveryOrder(principal(ALICE))).rejects.toThrow('engine timed out');
    expect(await statusOf(a.orderId)).toBe('open');
    expect(await statusOf(b.orderId)).toBe('cancelled');
    engine.cancel = real;
    expect(await svc.cancelEveryOrder(principal(ALICE))).toEqual([a.orderId]);
    expect(await free(ALICE)).toBe(A('1000'));
  });
});
