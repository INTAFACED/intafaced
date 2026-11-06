/**
 * A pre-liquidation stop (D-margin-04, J-derivatives-06 #5) against the real trade schema, MemoryLedger, the real
 * conditional-order book path and a scripted engine.
 *
 * Pinned here: a level at or above 100%, one already reached, an unknown ratio or a stop with the trigger job off is
 * refused and nothing is stored; the same request replays; below the level nothing is placed; at the level the stop
 * fires once, as one reduce-only market order for the whole position on the closing side, under the stop's own client
 * id; a crash between the claim and the order replays the same client id and places once; two ticks at once place
 * once; a closed position ends an armed stop; a stop set again after it fired is a new generation with a new id.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLedger, formatAmount, parseAmount, recipes } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { EngineSubmitRequest, EngineSubmitResult, MatchingClient } from '../spot/matching-client.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import { TradingControlError, type TradingAdmissionPort } from '../controls/trading-controls.js';
import { MatchedFuturesOrders, MatchedOrderError, type PlaceMatchedOrderInput } from './matched-orders.js';
import { matchedOrderIdFor } from './ids.js';
import { createConditionalOrderService, type ConditionalOrderService } from './conditional-orders/service.js';
import { FuturesError, type RiskStopFigures } from './position-service.js';
import {
  RISK_STOP_CLOSING,
  RISK_STOP_INVALID,
  RISK_STOP_RATIO_UNKNOWN,
  RISK_STOP_REACHED,
  RISK_STOP_TRIGGER_OFF,
  createRiskStopService,
  type RiskStopDeps,
  type RiskStopService,
} from './risk-stop.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_risk_stop_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`pre-liquidation stops need Postgres: TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
  }
}

const A = (s: string) => parseAmount(s);
const USDT = 'USDT';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SYMBOL = 'BTC/USDT:USDT';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const PROOF = { stub: true } as unknown as LifecycleAdmissionProof;

/** Scripted engine: each submit takes the next scripted answer, or rests the order untouched. */
class FakeEngine {
  readonly submits: EngineSubmitRequest[] = [];
  readonly script: Array<EngineSubmitResult | Error | ((request: EngineSubmitRequest) => EngineSubmitResult)> = [];
  private seq = 1000;

  async submit(_marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    this.submits.push(request);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(request);
    if (next) return next;
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

  async cancel(_marketId: string, orderId: string) {
    this.seq += 1;
    return { cancelled: true, orderId, sequence: this.seq, cancellation: null };
  }
}

const principal = (userId: string) => ({ userId, scopes: [] }) as unknown as Principal;

const POSITION_SQL = (sql: TestDatabase['sql'], id: string) =>
  sql<
    { id: string; user_id: string; market_id: string; side: 'long' | 'short'; status: string; margin_mode: string; size: string }[]
  >`SELECT id, user_id, market_id, side, status, margin_mode, size FROM trade.positions WHERE id = ${id}`;

describe('pre-liquidation stop', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'trade', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  let ledger: MemoryLedger;
  let engine: FakeEngine;
  let mark: bigint;
  let book: MatchedFuturesOrders;
  let orders: ConditionalOrderService;
  let seq: number;
  /** The ratio the figures answer with (maintenance over equity, 1 = 100%), or null with a reason. */
  let ratio: bigint | null;
  let ratioReason: string | null;

  async function figures(userId: string, positionId: string, level: bigint | null): Promise<RiskStopFigures> {
    const [row] = await POSITION_SQL(sql, positionId);
    if (!row || row.user_id !== userId) throw new FuturesError('position not found', 'trade.position_not_found', 404);
    return {
      positionId: row.id,
      userId: row.user_id,
      marketId: row.market_id,
      symbol: SYMBOL,
      side: row.side,
      status: row.status as RiskStopFigures['status'],
      marginMode: row.margin_mode as RiskStopFigures['marginMode'],
      size: A(row.size),
      markPrice: formatAmount(mark),
      liquidationPrice: '90.5',
      marginRatio: ratio,
      ratioReason: ratio === null ? ratioReason : null,
      stopPrice: level === null ? null : A('95.25'),
      stopPriceReason: null,
    };
  }

  function stopService(extra: Partial<RiskStopDeps> = {}): RiskStopService {
    return createRiskStopService({
      sql,
      triggerScheduled: true,
      figures,
      fire: (input) => orders.fireRiskStop(input),
      closeOrder: (userId, clientOrderId) => orders.getByClientId(userId, clientOrderId),
      ...extra,
    });
  }

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.futures_risk_stops, trade.futures_conditional_orders, trade.futures_protection_requests,
        trade.futures_entry_protection, trade.futures_order_fills, trade.futures_orders, trade.positions, trade.markets,
        trade.futures_payouts, trade.futures_fill_waits, trade.account_position_modes
      RESTART IDENTITY CASCADE
    `;
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, ${SYMBOL}, 'BTC', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'BTC perpetual', now()
      )
    `;
    ledger = new MemoryLedger();
    engine = new FakeEngine();
    mark = A('100');
    seq = 5000;
    ratio = A('0.05');
    ratioReason = null;
    book = new MatchedFuturesOrders({
      sql,
      ledger,
      matching: engine as unknown as MatchingClient,
      enabled: true,
      priceBand: A('0.05'),
      maxLeverage: A('10'),
      now: () => NOW,
      markFor: async () => mark,
      assertPositionIdle: async () => undefined,
      lifecycleProof: async () => PROOF,
      admission: { admit: vi.fn(async () => ({})), admitStanding: vi.fn(async () => ({})) } as unknown as TradingAdmissionPort,
      emailProof: { get: async () => 'accepted' },
      feeRates: async () => ({ makerBps: 0, takerBps: 0 }),
    });
    orders = createConditionalOrderService({
      sql,
      triggerScheduled: true,
      publishedMark: async () => formatAmount(mark),
      closeQuantity: async () => {
        throw new Error('the at-mark close is retired while futures orders go through the book');
      },
      placeLimit: async () => {
        throw new Error('a stop-limit places its limit in the book');
      },
      placeReduce: (input, instructionId) => book.placeOnInstruction({ ...input, leverage: 0n, reduceOnly: true }, instructionId),
    });
    for (const userId of [ALICE, BOB, CAROL]) {
      await ledger.post(
        recipes.deposit({ userId, assetId: USDT, amount: A('1000'), rail: 'test', railRef: `fund-${userId}-${randomUUID()}` }),
      );
    }
  });

  function limit(userId: string, side: 'buy' | 'sell', qty: string, price: string, clientOrderId: string): PlaceMatchedOrderInput {
    return { userId, symbol: SYMBOL, side, type: 'limit', qty: A(qty), limitPrice: A(price), leverage: A('10'), clientOrderId };
  }

  /** Alice long `qty` at 100 against Bob's short, both at 10x. */
  async function aliceLong(qty = '1'): Promise<string> {
    const a = await book.place(principal(ALICE), limit(ALICE, 'buy', qty, '100', `a-open-${seq}`));
    const b = await book.place(principal(BOB), limit(BOB, 'sell', qty, '100', `b-open-${seq}`));
    seq += 1;
    await book.settleFill({ marketId: MARKET, makerOrderId: a.orderId, takerOrderId: b.orderId, price: '100', qty, sequence: seq });
    const [pos] = await sql<{ id: string }[]>`SELECT id FROM trade.positions WHERE user_id = ${ALICE} AND status = 'open'`;
    return pos!.id;
  }

  async function carolBid(qty: string, price: string): Promise<string> {
    const c = await book.place(principal(CAROL), limit(CAROL, 'buy', qty, price, `c-bid-${seq}`));
    seq += 1;
    return c.orderId;
  }

  /** The engine fills the next order sent (the stop's close, whose id is written when it fires) against `makerOrderId`. */
  function scriptFill(makerOrderId: string, qty: string, price: string) {
    engine.script.push((request) => {
      seq += 1;
      return {
        accepted: true,
        sequence: seq,
        fills: [
          {
            sequence: seq,
            makerOrderId,
            makerAccountId: CAROL,
            takerOrderId: request.orderId,
            takerAccountId: ALICE,
            takerSide: 'sell',
            price,
            qty,
          },
        ],
        resting: null,
        rejected: null,
        cancellations: [],
        triggered: [],
      } as EngineSubmitResult;
    });
  }

  async function stopRows() {
    const rows = await sql<{ status: string; level: string | null; generation: number; close_client_order_id: string | null }[]>`
      SELECT status, level, generation, close_client_order_id FROM trade.futures_risk_stops
    `;
    return rows.map((r) => ({ ...r, level: r.level === null ? null : formatAmount(A(r.level)) }));
  }

  async function refusal(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (err) {
      if (err instanceof FuturesError) return err.code;
      throw err;
    }
    throw new Error('expected a refusal');
  }

  it('the level is a percent strictly between the ratio now and 100%, and every other ask is refused with nothing stored', async () => {
    const positionId = await aliceLong();
    const stops = stopService();
    const set = (level: unknown, id = randomUUID()) => stops.set(ALICE, positionId, { level, clientRequestId: id });
    expect(await refusal(set('100'))).toBe(RISK_STOP_INVALID);
    expect(await refusal(set('120'))).toBe(RISK_STOP_INVALID);
    expect(await refusal(set('0'))).toBe(RISK_STOP_INVALID);
    expect(await refusal(set(50))).toBe(RISK_STOP_INVALID);
    expect(await refusal(set('fifty'))).toBe(RISK_STOP_INVALID);
    // The ratio is 5% now: a stop at 5% or under would close the position at once.
    expect(await refusal(set('5'))).toBe(RISK_STOP_REACHED);
    expect(await refusal(set('4.99'))).toBe(RISK_STOP_REACHED);
    ratio = null;
    ratioReason = 'mark_missing';
    expect(await refusal(set('50'))).toBe(RISK_STOP_RATIO_UNKNOWN);
    ratio = A('0.05');
    expect(await refusal(stopService({ triggerScheduled: false }).set(ALICE, positionId, { level: '50', clientRequestId: 'off' }))).toBe(
      RISK_STOP_TRIGGER_OFF,
    );
    expect(await refusal(stops.set(BOB, positionId, { level: '50', clientRequestId: 'bob' }))).toBe('trade.position_not_found');
    expect(await refusal(stops.set(ALICE, positionId, { level: '50', clientRequestId: '' }))).toBe('trade.idempotency_key_required');
    expect(await stopRows()).toEqual([]);
    expect(await stops.get(ALICE, positionId)).toMatchObject({ status: 'none', level: null, triggerPrice: null, marginRatio: '5' });
  });

  it('a set stop shows its level, the close price and the ratio now; the same request replays and a new one replaces it', async () => {
    const positionId = await aliceLong();
    const stops = stopService();
    const armed = await stops.set(ALICE, positionId, { level: '62.5', clientRequestId: 'set-1' });
    expect(armed).toMatchObject({
      positionId,
      status: 'armed',
      level: '62.5',
      marginRatio: '5',
      triggerPrice: '95.25',
      liquidationPrice: '90.5',
      closeOrder: null,
    });
    expect(await stops.get(ALICE, positionId)).toMatchObject({ status: 'armed', level: '62.5', triggerPrice: '95.25' });
    // The same request id answers with the stop as it stands, even with another body.
    expect(await stops.set(ALICE, positionId, { level: '70', clientRequestId: 'set-1' })).toMatchObject({ level: '62.5' });
    expect(await stopRows()).toEqual([{ status: 'armed', level: '0.625', generation: 1, close_client_order_id: null }]);
    expect(await stops.set(ALICE, positionId, { level: '70', clientRequestId: 'set-2' })).toMatchObject({ level: '70' });
    expect(await stopRows()).toEqual([{ status: 'armed', level: '0.7', generation: 2, close_client_order_id: null }]);
    // Blank clears it: no stop, and the tick has nothing to act on.
    const submitted = engine.submits.length;
    expect(await stops.set(ALICE, positionId, { level: null, clientRequestId: 'clear' })).toMatchObject({ status: 'none', level: null });
    ratio = A('0.9');
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(engine.submits).toHaveLength(submitted);
  });

  it('at the level the stop fires once: one reduce-only market sell of the whole position, under the stop id, and the position closes', async () => {
    const positionId = await aliceLong();
    const stops = stopService();
    await stops.set(ALICE, positionId, { level: '50', clientRequestId: 'fire-1' });
    ratio = A('0.4999');
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await stops.evaluate({ enabled: false })).toEqual({ fired: 0 });
    const bid = await carolBid('1', '96');
    const submitted = engine.submits.length;

    ratio = A('0.5');
    mark = A('96');
    const clientOrderId = `risk-stop:${positionId}:1`;
    scriptFill(bid, '1', '96');
    // One tick: the stop is claimed, and its close order is written and placed at once.
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 1 });
    const [cond] = await sql<{ id: string; status: string; kind: string; side: string; quantity: string; reduce_only: boolean }[]>`
      SELECT id, status, kind, side, quantity, reduce_only FROM trade.futures_conditional_orders WHERE client_order_id = ${clientOrderId}
    `;
    expect(cond).toMatchObject({ kind: 'stop_market', side: 'sell', reduce_only: true, status: 'filled' });
    expect(formatAmount(A(cond!.quantity))).toBe('1');
    expect(await stopRows()).toEqual([{ status: 'fired', level: '0.5', generation: 1, close_client_order_id: clientOrderId }]);
    const taker = matchedOrderIdFor(ALICE, MARKET, `cond:${cond!.id}`);
    expect(engine.submits.slice(submitted).map((s) => s.orderId)).toEqual([taker]);
    expect(engine.submits.at(-1)).toMatchObject({ side: 'sell', qty: '1', tif: 'IOC' });
    const [placed] = await sql<{ reduce_only: boolean; order_type: string; status: string }[]>`
      SELECT reduce_only, order_type, status FROM trade.futures_orders WHERE id = ${taker}
    `;
    expect(placed).toEqual({ reduce_only: true, order_type: 'market', status: 'filled' });
    const [pos] = await POSITION_SQL(sql, positionId);
    expect(pos!.status).toBe('closed');
    expect(await stops.get(ALICE, positionId)).toMatchObject({ status: 'fired', level: '50', firedRatio: '50' });
    expect((await stops.get(ALICE, positionId)).closeOrder).toMatchObject({ clientOrderId, status: 'filled', orderId: taker });

    // It fires once: later ticks place nothing more, and with its close finished the stop is done and read no more.
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    await orders.evaluate({ enabled: true });
    expect(engine.submits.slice(submitted)).toHaveLength(1);
    expect(await stopRows()).toMatchObject([{ status: 'done', close_client_order_id: clientOrderId }]);
    expect(await stops.get(ALICE, positionId)).toMatchObject({ status: 'fired', level: '50' });
  });

  it('a crash after the claim and before the close order replays the same client id on the next tick and places once', async () => {
    const positionId = await aliceLong();
    let crash = true;
    const stops = stopService({
      fire: async (input) => {
        if (crash) {
          crash = false;
          throw new Error('process died after the claim');
        }
        return orders.fireRiskStop(input);
      },
    });
    await stops.set(ALICE, positionId, { level: '50', clientRequestId: 'crash-1' });
    ratio = A('0.75');
    await expect(stops.evaluate({ enabled: true })).rejects.toThrow('process died after the claim');
    expect(await stopRows()).toMatchObject([{ status: 'fired', close_client_order_id: `risk-stop:${positionId}:1` }]);
    expect(await sql`SELECT 1 FROM trade.futures_conditional_orders`).toHaveLength(0);

    // Next tick: the claimed stop's order is written once, under the same id; a third tick writes nothing more.
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    const rows = await sql<{ client_order_id: string }[]>`SELECT client_order_id FROM trade.futures_conditional_orders`;
    expect(rows.map((r) => r.client_order_id)).toEqual([`risk-stop:${positionId}:1`]);
    // The two opening orders, then the one close.
    expect(engine.submits).toHaveLength(3);
  });

  it('two ticks at once claim the stop once and write one close order', async () => {
    const positionId = await aliceLong();
    const stops = stopService();
    await stops.set(ALICE, positionId, { level: '50', clientRequestId: 'race-1' });
    ratio = A('0.6');
    const results = await Promise.all([stops.evaluate({ enabled: true }), stopService().evaluate({ enabled: true })]);
    expect(results.reduce((n, r) => n + r.fired, 0)).toBe(1);
    expect(await sql`SELECT 1 FROM trade.futures_conditional_orders`).toHaveLength(1);
  });

  it('equity at or below zero counts as reached, a closed position ends an armed stop, and a stop set after it fired is a new generation', async () => {
    const positionId = await aliceLong();
    const stops = stopService();
    await stops.set(ALICE, positionId, { level: '50', clientRequestId: 'gen-1' });
    ratio = null;
    ratioReason = 'equity_not_positive';
    // The engine refuses the close for good: the order is written failed and the position stays open.
    engine.script.push({
      accepted: false,
      sequence: 0,
      fills: [],
      resting: null,
      rejected: { reason: 'market_halted' },
      cancellations: [],
      triggered: [],
    } as unknown as EngineSubmitResult);
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 1 });
    ratio = A('0.05');
    const again = await stops.set(ALICE, positionId, { level: '40', clientRequestId: 'gen-2' });
    expect(again).toMatchObject({ status: 'armed', level: '40', closeOrder: null });
    expect(await stopRows()).toMatchObject([{ status: 'armed', generation: 2, close_client_order_id: null }]);

    await sql`UPDATE trade.positions SET status = 'closed', closed_at = now() WHERE id = ${positionId}`;
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await stopRows()).toMatchObject([{ status: 'ended' }]);
    expect(await refusal(stops.set(ALICE, positionId, { level: '40', clientRequestId: 'gen-3' }))).toBe('trade.position_not_open');
  });

  for (const level of ['70', null] as const) {
    it(`${level === null ? 'a clear' : 'a new level'} that read the stop before a tick claimed it refuses, and the fired stop and its close stand`, async () => {
      const positionId = await aliceLong();
      const tick = stopService();
      await tick.set(ALICE, positionId, { level: '50', clientRequestId: 'race-set-1' });
      // Between this set's read of the stop and its write, the tick finds the ratio at the level and claims it.
      let claimFirst = true;
      const racing = stopService({
        figures: async (userId, id, at) => {
          if (claimFirst) {
            claimFirst = false;
            ratio = A('0.55');
            expect(await tick.evaluate({ enabled: true })).toEqual({ fired: 1 });
            ratio = A('0.05');
          }
          return figures(userId, id, at);
        },
      });
      expect(await refusal(racing.set(ALICE, positionId, { level, clientRequestId: 'race-2' }))).toBe(RISK_STOP_CLOSING);
      expect(await stopRows()).toEqual([
        { status: 'fired', level: '0.5', generation: 1, close_client_order_id: `risk-stop:${positionId}:1` },
      ]);
      expect(await sql`SELECT 1 FROM trade.futures_conditional_orders`).toHaveLength(1);
    });
  }
});
