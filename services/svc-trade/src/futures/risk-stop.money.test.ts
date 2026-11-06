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
  RISK_STOP_PRICE_UNKNOWN,
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
  /** The mark at which the ratio reaches a level, as the figures answer it. */
  let stopAt: bigint | null;

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
      stopPrice: level === null ? null : stopAt,
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
      sync: (input) => orders.syncRiskStop(input),
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
    stopAt = A('95.25');
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

  async function closeOrders() {
    const rows = await sql<
      { client_order_id: string; status: string; trigger_price: string | null; quantity: string; cancel_reason: string | null }[]
    >`
      SELECT client_order_id, status, trigger_price, quantity, cancel_reason FROM trade.futures_conditional_orders ORDER BY created_at, client_order_id
    `;
    return rows.map((r) => ({
      ...r,
      trigger_price: r.trigger_price === null ? null : formatAmount(A(r.trigger_price)),
      quantity: formatAmount(A(r.quantity)),
    }));
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
    // With no mark for the level there is no close order to place, so no stop.
    stopAt = null;
    expect(await refusal(set('50'))).toBe(RISK_STOP_PRICE_UNKNOWN);
    stopAt = A('95.25');
    expect(await stopRows()).toEqual([]);
    expect(await closeOrders()).toEqual([]);
    expect(await stops.get(ALICE, positionId)).toMatchObject({ status: 'none', level: null, triggerPrice: null, marginRatio: '5' });
  });

  it("a set stop rests its close order at once at the level's mark; the same request replays and a new one replaces it", async () => {
    const positionId = await aliceLong();
    const stops = stopService();
    const first = `risk-stop:${positionId}:1`;
    const armed = await stops.set(ALICE, positionId, { level: '62.5', clientRequestId: 'set-1' });
    expect(armed).toMatchObject({
      positionId,
      status: 'armed',
      level: '62.5',
      marginRatio: '5',
      triggerPrice: '95.25',
      liquidationPrice: '90.5',
      closeOrder: { clientOrderId: first, status: 'armed', triggerPrice: '95.25', orderId: null },
    });
    // A real order in the trader's conditional orders: reduce-only, stop-market, the whole position, on the mark.
    expect((await orders.list(ALICE)).find((o) => o.clientOrderId === first)).toMatchObject({
      positionId,
      kind: 'stop_market',
      side: 'sell',
      quantity: '1',
      reduceOnly: true,
      triggerSource: 'mark',
      triggerPrice: '95.25',
      status: 'armed',
    });
    expect(await stops.get(ALICE, positionId)).toMatchObject({ status: 'armed', level: '62.5', triggerPrice: '95.25' });
    // The same request id answers with the stop as it stands, even with another body, and writes no second order.
    expect(await stops.set(ALICE, positionId, { level: '70', clientRequestId: 'set-1' })).toMatchObject({ level: '62.5' });
    expect(await stopRows()).toEqual([{ status: 'armed', level: '0.625', generation: 1, close_client_order_id: first }]);
    expect(await closeOrders()).toHaveLength(1);
    stopAt = A('94');
    expect(await stops.set(ALICE, positionId, { level: '70', clientRequestId: 'set-2' })).toMatchObject({
      level: '70',
      closeOrder: { clientOrderId: `risk-stop:${positionId}:2`, status: 'armed', triggerPrice: '94' },
    });
    expect(await stopRows()).toEqual([
      { status: 'armed', level: '0.7', generation: 2, close_client_order_id: `risk-stop:${positionId}:2` },
    ]);
    expect(await closeOrders()).toMatchObject([
      { client_order_id: first, status: 'cancelled', cancel_reason: 'risk_stop_replaced' },
      { client_order_id: `risk-stop:${positionId}:2`, status: 'armed', trigger_price: '94' },
    ]);
    // Blank clears it: no stop, its close order comes off, and the tick has nothing to act on.
    const submitted = engine.submits.length;
    expect(await stops.set(ALICE, positionId, { level: null, clientRequestId: 'clear' })).toMatchObject({ status: 'none', level: null });
    expect((await closeOrders()).map((o) => [o.status, o.cancel_reason])).toEqual([
      ['cancelled', 'risk_stop_replaced'],
      ['cancelled', 'risk_stop_cleared'],
    ]);
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
    // One tick: the stop is claimed, and its resting close order is claimed and placed at once.
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
    expect(await closeOrders()).toMatchObject([{ client_order_id: `risk-stop:${positionId}:1`, status: 'armed' }]);

    // Next tick: the claimed stop's resting order is fired once, under the same id; a third tick places nothing more.
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    const rows = await sql<{ client_order_id: string }[]>`SELECT client_order_id FROM trade.futures_conditional_orders`;
    expect(rows.map((r) => r.client_order_id)).toEqual([`risk-stop:${positionId}:1`]);
    // The two opening orders, then the one close.
    expect(engine.submits).toHaveLength(3);
  });

  it('a close order the trader takes off after the claim and before it fires clears the stop; nothing reads fired', async () => {
    const positionId = await aliceLong();
    const stops = stopService({
      fire: async () => {
        throw new Error('process died after the claim');
      },
    });
    await stops.set(ALICE, positionId, { level: '50', clientRequestId: 'took-off-1' });
    ratio = A('0.75');
    await expect(stops.evaluate({ enabled: true })).rejects.toThrow('process died after the claim');
    const [order] = (await orders.list(ALICE)).filter((o) => o.clientOrderId === `risk-stop:${positionId}:1`);
    await orders.cancel(ALICE, order!.id);
    expect(await stopService().evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await stopRows()).toMatchObject([{ status: 'cleared', level: null }]);
    // The two opening orders only: nothing closed.
    expect(engine.submits).toHaveLength(2);
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
    expect(again).toMatchObject({
      status: 'armed',
      level: '40',
      closeOrder: { clientOrderId: `risk-stop:${positionId}:2`, status: 'armed' },
    });
    expect(await stopRows()).toMatchObject([{ status: 'armed', generation: 2, close_client_order_id: `risk-stop:${positionId}:2` }]);

    await sql`UPDATE trade.positions SET status = 'closed', closed_at = now() WHERE id = ${positionId}`;
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await stopRows()).toMatchObject([{ status: 'ended' }]);
    // Its resting close order comes off with it: no live order is left for a position that is gone.
    expect((await closeOrders()).filter((o) => o.client_order_id === `risk-stop:${positionId}:2`)).toMatchObject([
      { status: 'cancelled', cancel_reason: 'position_gone' },
    ]);
    expect(await refusal(stops.set(ALICE, positionId, { level: '40', clientRequestId: 'gen-3' }))).toBe('trade.position_not_open');
  });

  it("only the stop's own tick fires its resting order, with fresh figures; once, and the stop reads fired", async () => {
    const positionId = await aliceLong();
    const stops = stopService();
    await stops.set(ALICE, positionId, { level: '50', clientRequestId: 'cross-1' });
    const bid = await carolBid('1', '95');
    const submitted = engine.submits.length;
    // The mark falls through the resting trigger, but margin was added meanwhile and the ratio is under the level: the
    // conditional tick leaves the order alone, and the stop's tick moves its trigger instead.
    mark = A('95');
    stopAt = A('93.5');
    await orders.evaluate({ enabled: true });
    expect(await closeOrders()).toMatchObject([{ client_order_id: `risk-stop:${positionId}:1`, status: 'armed', trigger_price: '95.25' }]);
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await closeOrders()).toMatchObject([{ status: 'armed', trigger_price: '93.5' }]);
    expect(engine.submits.slice(submitted)).toHaveLength(0);
    // At the level the stop's tick fires that same order, for the size now.
    ratio = A('0.5');
    scriptFill(bid, '1', '95');
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 1 });
    expect(await closeOrders()).toMatchObject([{ client_order_id: `risk-stop:${positionId}:1`, status: 'filled', quantity: '1' }]);
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    await orders.evaluate({ enabled: true });
    expect(engine.submits.slice(submitted)).toHaveLength(1);
    expect(await stops.get(ALICE, positionId)).toMatchObject({ status: 'fired', closeOrder: { status: 'filled' } });
    expect((await POSITION_SQL(sql, positionId))[0]!.status).toBe('closed');
  });

  it("a tick that read an earlier stop leaves the newer stop's close order resting", async () => {
    const positionId = await aliceLong();
    const stops = stopService();
    await stops.set(ALICE, positionId, { level: '50', clientRequestId: 'stale-1' });
    await stops.set(ALICE, positionId, { level: '60', clientRequestId: 'stale-2' });
    // A tick still holding generation 1 syncs it after the new level was set.
    await orders.syncRiskStop({
      userId: ALICE,
      marketId: MARKET,
      positionId,
      clientOrderId: `risk-stop:${positionId}:1`,
      side: 'sell',
      quantity: A('1'),
      triggerPrice: A('95.25'),
      cancelReason: 'risk_stop_replaced',
    });
    expect((await closeOrders()).map((o) => [o.client_order_id, o.status])).toEqual([
      [`risk-stop:${positionId}:1`, 'cancelled'],
      [`risk-stop:${positionId}:2`, 'armed'],
    ]);
  });

  it("the resting order follows the level's mark and the size as they move; cancelling it clears the stop", async () => {
    const positionId = await aliceLong();
    const stops = stopService();
    await stops.set(ALICE, positionId, { level: '50', clientRequestId: 'move-1' });
    // Margin was added: the mark at which the ratio reaches 50% is lower now, and the order follows on the next tick.
    stopAt = A('93.5');
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await closeOrders()).toMatchObject([{ status: 'armed', trigger_price: '93.5', quantity: '1' }]);
    expect(await stops.get(ALICE, positionId)).toMatchObject({ triggerPrice: '93.5', closeOrder: { triggerPrice: '93.5' } });
    // The mark cannot be worked out on a tick: the order shows no trigger rather than the old one, and nothing fires.
    stopAt = null;
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await closeOrders()).toMatchObject([{ status: 'armed', trigger_price: null, quantity: '1' }]);
    expect(await stops.get(ALICE, positionId)).toMatchObject({ triggerPrice: null, closeOrder: { status: 'armed', triggerPrice: null } });
    stopAt = A('93.5');
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await closeOrders()).toMatchObject([{ status: 'armed', trigger_price: '93.5' }]);
    // The trader takes the close order off: the stop goes with it rather than show a stop that would not act.
    const [order] = (await orders.list(ALICE)).filter((o) => o.clientOrderId === `risk-stop:${positionId}:1`);
    await orders.cancel(ALICE, order!.id);
    expect(await stops.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await stopRows()).toMatchObject([{ status: 'cleared', level: null }]);
    expect(await stops.get(ALICE, positionId)).toMatchObject({ status: 'none', level: null });
  });

  it('a crash after the stop is stored and before its close order is written is mended on the next tick, once', async () => {
    const positionId = await aliceLong();
    const stops = stopService({
      sync: async () => {
        throw new Error('process died before the close order');
      },
    });
    await expect(stops.set(ALICE, positionId, { level: '50', clientRequestId: 'mend-1' })).rejects.toThrow('process died');
    expect(await stopRows()).toMatchObject([{ status: 'armed', close_client_order_id: `risk-stop:${positionId}:1` }]);
    expect(await closeOrders()).toEqual([]);
    const tick = stopService();
    expect(await tick.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await tick.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await closeOrders()).toMatchObject([{ client_order_id: `risk-stop:${positionId}:1`, status: 'armed', trigger_price: '95.25' }]);
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
