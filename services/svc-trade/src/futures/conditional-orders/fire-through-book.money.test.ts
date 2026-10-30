/**
 * A fired futures conditional order closes through the book (J-derivatives-03 #6, D-orders-04), against real trade
 * schema, MemoryLedger and a scripted engine.
 *
 * While futures orders go through the book the at-mark close is retired, so a fired take-profit or stop-loss places
 * one reduce-only order there, on the trader's standing instruction. These tests pin: it fires once, it closes what
 * the position holds when it fires and never opens, the other leg of a position's pair is cancelled once one has
 * closed it, a crash at any step finds the same order again, and a refusal is either retried or written on the row.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  futuresOrderMarginAccount,
  parseAmount,
  positionCollateralAccount,
  recipes,
  userAvailable,
} from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { EngineSubmitRequest, EngineSubmitResult, MatchingClient } from '../../spot/matching-client.js';
import type { LifecycleAdmissionProof } from '../../lifecycle-proof.js';
import { TradingControlError, type TradingAdmissionPort } from '../../controls/trading-controls.js';
import { MatchedFuturesOrders, MatchedOrderError, type PlaceMatchedOrderInput } from '../matched-orders.js';
import { matchedOrderIdFor } from '../ids.js';
import { createConditionalOrderService, type ConditionalOrderDeps, type ConditionalOrderService } from './service.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_cond_book_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`conditional orders through the book need Postgres: TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
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
  readonly script: Array<EngineSubmitResult | Error> = [];
  private seq = 1000;

  async submit(_marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    this.submits.push(request);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
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

describe('futures conditional orders fire through the book', () => {
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
  let admitStanding: ReturnType<typeof vi.fn>;
  let book: MatchedFuturesOrders;
  let orders: ConditionalOrderService;
  let seq: number;

  function conditionalService(
    publishedMark = async () => formatAmount(mark),
    extra: Partial<ConditionalOrderDeps> = {},
  ): ConditionalOrderService {
    return createConditionalOrderService({
      sql,
      triggerScheduled: true,
      publishedMark,
      closeQuantity: async () => {
        throw new Error('the at-mark close is retired while futures orders go through the book');
      },
      placeLimit: async () => {
        throw new Error('a stop-limit places its limit in the book');
      },
      placeReduce: (input, instructionId) => book.placeOnInstruction({ ...input, leverage: 0n, reduceOnly: true }, instructionId),
      ...extra,
    });
  }

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.futures_conditional_orders, trade.futures_protection_requests, trade.futures_entry_protection, trade.futures_order_fills,
        trade.futures_orders, trade.positions, trade.markets, trade.futures_payouts, trade.futures_fill_waits,
        trade.account_position_modes
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
    admitStanding = vi.fn(async () => ({}));
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
      admission: { admit: vi.fn(async () => ({})), admitStanding } as unknown as TradingAdmissionPort,
      emailProof: { get: async () => 'accepted' },
      feeRates: async () => ({ makerBps: 0, takerBps: 0 }),
    });
    orders = conditionalService();
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

  /** Carol's resting buy at `price`, the liquidity a fired sell meets. */
  async function carolBid(qty: string, price: string): Promise<string> {
    const c = await book.place(principal(CAROL), limit(CAROL, 'buy', qty, price, `c-bid-${seq}`));
    seq += 1;
    return c.orderId;
  }

  /** The engine fills a fired sell of `conditionalId` against `makerOrderId`, `qty` at `price`. */
  function scriptFill(conditionalId: string, makerOrderId: string, qty: string, price: string, left?: string, attempt = 0) {
    seq += 1;
    const takerOrderId = matchedOrderIdFor(ALICE, MARKET, attempt > 0 ? `cond:${conditionalId}:${attempt}` : `cond:${conditionalId}`);
    engine.script.push({
      accepted: true,
      sequence: seq,
      fills: [{ sequence: seq, makerOrderId, makerAccountId: CAROL, takerOrderId, takerAccountId: ALICE, takerSide: 'sell', price, qty }],
      resting: null,
      rejected: null,
      cancellations: left ? [{ orderId: takerOrderId, accountId: ALICE, remainingQty: left, sequence: seq, reason: 'ioc' }] : [],
      triggered: [],
    } as EngineSubmitResult);
    return takerOrderId;
  }

  async function conditional(id: string) {
    return (await orders.list(ALICE)).find((o) => o.id === id)!;
  }

  async function positionOf(id: string) {
    const [row] = await sql<{ status: string; size: string; margin_current: string }[]>`
      SELECT status, size, margin_current FROM trade.positions WHERE id = ${id}
    `;
    return { status: row!.status, size: formatAmount(A(row!.size)), margin_current: formatAmount(A(row!.margin_current)) };
  }

  it('a crossed take-profit places one reduce-only market order for the whole position, closes it, and the stop-loss is cancelled with it', async () => {
    const positionId = await aliceLong();
    const pair = await orders.replaceProtection(ALICE, positionId, { takeProfit: '110', stopLoss: '90', clientRequestId: 'pair-1' });
    expect(pair.takeProfit).toMatchObject({ status: 'armed', triggerSource: 'mark', closeOrderId: null, firedQuantity: null });

    // Not crossed yet: nothing is placed.
    mark = A('109');
    expect(await orders.evaluate({ enabled: true })).toEqual({ fired: 0 });
    const bid = await carolBid('1', '110');
    const submitted = engine.submits.length;

    mark = A('111');
    const taker = scriptFill(pair.takeProfit!.id, bid, '1', '110');
    expect(await orders.evaluate({ enabled: true })).toEqual({ fired: 1 });

    // One order, sent once: a reduce-only IOC sell of the whole size, inside the band, admitted on the armed order.
    expect(engine.submits).toHaveLength(submitted + 1);
    expect(engine.submits.at(-1)).toMatchObject({ orderId: taker, side: 'sell', qty: '1', tif: 'IOC' });
    expect(admitStanding).toHaveBeenCalledTimes(1);
    expect(admitStanding.mock.calls[0]!.slice(0, 3)).toEqual([ALICE, pair.takeProfit!.id, `futures.order:${taker}`]);
    expect(admitStanding.mock.calls[0]![4]).toBe('svc-trade');
    const [placed] = await sql<{ reduce_only: boolean; order_type: string; status: string; position_id: string }[]>`
      SELECT reduce_only, order_type, status, position_id FROM trade.futures_orders WHERE id = ${taker}
    `;
    expect(placed).toEqual({ reduce_only: true, order_type: 'market', status: 'filled', position_id: positionId });

    expect(await conditional(pair.takeProfit!.id)).toMatchObject({
      status: 'filled',
      failureReason: null,
      closeOrderId: taker,
      firedQuantity: '1',
    });
    expect(await conditional(pair.stopLoss!.id)).toMatchObject({ status: 'cancelled', cancelReason: 'position_closed' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'closed' });
    expect(await ledger.balance(positionCollateralAccount(ALICE, USDT, positionId))).toMatchObject({ amount: 0n });
    // The margin is back, and the 10 of profit at 110 is owed through the same payout as a manual close: Bob's
    // matching loss is still open, so the clearing pot has nothing to pay it from yet.
    expect((await ledger.balance(userAvailable(ALICE, USDT))).amount).toBe(A('1000'));
    const owed = await sql<{ amount: string; state: string }[]>`
      SELECT amount, state FROM trade.futures_payouts WHERE user_id = ${ALICE} AND position_id = ${positionId}
    `;
    expect(owed.map((p) => ({ amount: formatAmount(A(p.amount)), state: p.state }))).toEqual([{ amount: '10', state: 'pending' }]);

    // It fires once: later ticks place nothing more.
    expect(await orders.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(engine.submits).toHaveLength(submitted + 1);
  });

  it('a part take-profit closes only its own quantity, and its part stop-loss is cancelled with it (linked)', async () => {
    const positionId = await aliceLong();
    const pair = await orders.replaceProtection(ALICE, positionId, {
      takeProfit: { price: '110', quantity: '0.4' },
      stopLoss: { price: '90', quantity: '0.4' },
      clientRequestId: 'part-pair',
    });
    expect(pair.takeProfit).toMatchObject({ quantity: '0.4', wholePosition: false, status: 'armed' });
    expect(pair.stopLoss).toMatchObject({ quantity: '0.4', wholePosition: false, status: 'armed' });
    mark = A('109');
    const bid = await carolBid('1', '110');
    const submitted = engine.submits.length;
    mark = A('111');
    const taker = scriptFill(pair.takeProfit!.id, bid, '0.4', '110');
    expect(await orders.evaluate({ enabled: true })).toEqual({ fired: 1 });

    expect(engine.submits).toHaveLength(submitted + 1);
    expect(engine.submits.at(-1)).toMatchObject({ orderId: taker, side: 'sell', qty: '0.4' });
    expect(await conditional(pair.takeProfit!.id)).toMatchObject({ status: 'filled', firedQuantity: '0.4', closedQuantity: '0.4' });
    expect(await conditional(pair.stopLoss!.id)).toMatchObject({ status: 'cancelled', cancelReason: 'linked' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'open', size: '0.6' });
    expect(await orders.evaluate({ enabled: true })).toEqual({ fired: 0 });
  });

  it('a part take-profit beside a whole-position stop-loss leaves the stop-loss guarding what is left', async () => {
    const positionId = await aliceLong();
    const pair = await orders.replaceProtection(ALICE, positionId, {
      takeProfit: { price: '110', quantity: '0.4' },
      stopLoss: '93',
      clientRequestId: 'part-whole',
    });
    expect(pair.stopLoss).toMatchObject({ quantity: '1', wholePosition: true });
    mark = A('109');
    const bid = await carolBid('1', '110');
    mark = A('111');
    scriptFill(pair.takeProfit!.id, bid, '0.4', '110');
    expect(await orders.evaluate({ enabled: true })).toEqual({ fired: 1 });
    expect(await conditional(pair.stopLoss!.id)).toMatchObject({ status: 'armed' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'open', size: '0.6' });

    // The stop-loss then closes the 0.6 left, not the 1 it was armed beside (above the 10x long's bankruptcy price).
    mark = A('95');
    const low = await carolBid('1', '92');
    mark = A('92');
    const taker = scriptFill(pair.stopLoss!.id, low, '0.6', '92');
    expect(await orders.evaluate({ enabled: true })).toEqual({ fired: 1 });
    expect(engine.submits.at(-1)).toMatchObject({ orderId: taker, qty: '0.6' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'closed' });
  });

  it("while a part leg is still closing, its linked sibling waits; a later request's leg is never cancelled as linked", async () => {
    const positionId = await aliceLong();
    const first = await orders.replaceProtection(ALICE, positionId, {
      takeProfit: { price: '104', quantity: '0.4' },
      stopLoss: { price: '97', quantity: '0.4' },
      clientRequestId: 'pair-wait',
    });
    const tpId = first.takeProfit!.id;
    /** The book has nothing inside the band for the take-profit's attempt `n`: it comes off, and the next tick tries again. */
    const nothing = (n: number) => {
      const taker = matchedOrderIdFor(ALICE, MARKET, n > 0 ? `cond:${tpId}:${n}` : `cond:${tpId}`);
      engine.script.push({
        accepted: true,
        sequence: 7100 + n,
        fills: [],
        resting: null,
        rejected: null,
        cancellations: [{ orderId: taker, accountId: ALICE, remainingQty: '0.4', sequence: 7100 + n, reason: 'ioc' }],
        triggered: [],
      } as EngineSubmitResult);
    };
    // The take-profit crosses with nothing inside the band: it stays triggered and keeps trying.
    nothing(0);
    mark = A('105');
    expect(await orders.evaluate({ enabled: true })).toEqual({ fired: 1 });
    expect(await conditional(tpId)).toMatchObject({ status: 'triggered' });

    // The mark swings through the stop-loss: it is not claimed while its linked take-profit is closing.
    nothing(1);
    mark = A('96');
    expect(await orders.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await conditional(first.stopLoss!.id)).toMatchObject({ status: 'armed' });

    // A new request arms a new part stop-loss: the old armed one is replaced, the triggered take-profit keeps working.
    mark = A('100');
    const second = await orders.replaceProtection(ALICE, positionId, {
      stopLoss: { price: '95', quantity: '0.4' },
      clientRequestId: 'pair-later',
    });
    expect(await conditional(first.stopLoss!.id)).toMatchObject({ status: 'cancelled', cancelReason: 'replaced' });
    expect(await conditional(tpId)).toMatchObject({ status: 'triggered' });

    // The take-profit's next attempt fills: the later request's stop-loss is not its sibling and stays armed.
    mark = A('105');
    const bid = await carolBid('1', '104');
    scriptFill(tpId, bid, '0.4', '104', undefined, 2);
    await orders.evaluate({ enabled: true });
    expect(await conditional(tpId)).toMatchObject({ status: 'filled', closedQuantity: '0.4' });
    expect(await conditional(second.stopLoss!.id)).toMatchObject({ status: 'armed' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'open', size: '0.6' });
  });

  it('two workers that see the two legs of a linked pair cross at once claim only one of them', async () => {
    const positionId = await aliceLong();
    const pair = await orders.replaceProtection(ALICE, positionId, {
      takeProfit: { price: '104', quantity: '0.4' },
      stopLoss: { price: '97', quantity: '0.4' },
      clientRequestId: 'pair-race',
    });
    // One worker reads a mark through the take-profit, the other through the stop-loss. Admission stays out of
    // reach, so whichever leg is claimed stays triggered (closing) and its sibling must wait.
    admitStanding.mockRejectedValue(new TradingControlError('authority.unavailable'));
    mark = A('105');
    const low = conditionalService(async () => '96');
    for (let round = 0; round < 5; round += 1) {
      await sql`
        UPDATE trade.futures_conditional_orders SET status = 'armed', trigger_key = NULL, result = NULL
         WHERE id IN (${pair.takeProfit!.id}, ${pair.stopLoss!.id})
      `;
      const [one, two] = await Promise.all([orders.evaluate({ enabled: true }), low.evaluate({ enabled: true })]);
      expect(one.fired + two.fired).toBe(1);
      const rows = await sql<{ status: string }[]>`
        SELECT status FROM trade.futures_conditional_orders WHERE id IN (${pair.takeProfit!.id}, ${pair.stopLoss!.id})
      `;
      expect(rows.map((r) => r.status).sort()).toEqual(['armed', 'triggered']);
    }
  });

  it('a part leg is refused above the position or off the lot, and nothing is stored', async () => {
    const positionId = await aliceLong();
    await expect(
      orders.replaceProtection(ALICE, positionId, { takeProfit: { price: '110', quantity: '1.5' }, clientRequestId: 'too-big' }),
    ).rejects.toMatchObject({ code: 'trade.close_quantity_exceeds_size' });
    await expect(
      orders.replaceProtection(ALICE, positionId, { stopLoss: { price: '90', quantity: '0.00005' }, clientRequestId: 'off-lot' }),
    ).rejects.toMatchObject({ code: 'trade.close_quantity_lot_step' });
    await expect(
      orders.replaceProtection(ALICE, positionId, { takeProfit: { quantity: '0.4' }, clientRequestId: 'no-price' }),
    ).rejects.toMatchObject({ code: 'trade.conditional_amount_invalid' });
    expect(await orders.list(ALICE)).toEqual([]);
  });

  it('two workers on a crossed stop place one order', async () => {
    const positionId = await aliceLong();
    const pair = await orders.replaceProtection(ALICE, positionId, { stopLoss: '95', clientRequestId: 'stop-race' });
    const bid = await carolBid('1', '96');
    const submitted = engine.submits.length;
    mark = A('94');
    scriptFill(pair.stopLoss!.id, bid, '1', '96');
    const other = conditionalService();
    const [one, two] = await Promise.all([orders.evaluate({ enabled: true }), other.evaluate({ enabled: true })]);
    expect(one.fired + two.fired).toBe(1);
    expect(engine.submits).toHaveLength(submitted + 1);
    const rows = await sql`SELECT 1 FROM trade.futures_orders WHERE user_id = ${ALICE} AND client_order_id LIKE 'cond:%'`;
    expect(rows).toHaveLength(1);
    expect(await conditional(pair.stopLoss!.id)).toMatchObject({ status: 'filled' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'closed' });
  });

  it('a position that grew after it was protected is closed whole, at its size when the stop fires', async () => {
    const positionId = await aliceLong('1');
    const pair = await orders.replaceProtection(ALICE, positionId, { stopLoss: '95', clientRequestId: 'grow' });
    await aliceLong('1');
    expect(await positionOf(positionId)).toMatchObject({ size: '2' });
    const bid = await carolBid('2', '96');
    mark = A('94');
    const taker = scriptFill(pair.stopLoss!.id, bid, '2', '96');
    await orders.evaluate({ enabled: true });
    expect(engine.submits.at(-1)).toMatchObject({ orderId: taker, qty: '2' });
    expect(await conditional(pair.stopLoss!.id)).toMatchObject({ status: 'filled', firedQuantity: '2' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'closed' });
  });

  it('a crash after the claim, before the order is placed: the next tick places it', async () => {
    const positionId = await aliceLong();
    const pair = await orders.replaceProtection(ALICE, positionId, { stopLoss: '95', clientRequestId: 'crash-1' });
    const id = pair.stopLoss!.id;
    // The claim committed and the process died.
    await sql`UPDATE trade.futures_conditional_orders SET status = 'triggered', trigger_key = ${`book:${id}`} WHERE id = ${id}`;
    const bid = await carolBid('1', '96');
    mark = A('94');
    scriptFill(id, bid, '1', '96');
    expect(await orders.evaluate({ enabled: true })).toEqual({ fired: 0 });
    expect(await conditional(id)).toMatchObject({ status: 'filled', firedQuantity: '1' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'closed' });
  });

  it('a crash after the order is placed, before the row says so: the next tick finds the same order and sends nothing new', async () => {
    const positionId = await aliceLong();
    const pair = await orders.replaceProtection(ALICE, positionId, { stopLoss: '95', clientRequestId: 'crash-2' });
    const id = pair.stopLoss!.id;
    const bid = await carolBid('1', '96');
    mark = A('94');
    const taker = scriptFill(id, bid, '1', '96');
    // The claim and the fixed quantity committed, the order was placed and filled, and the process died.
    await sql`
      UPDATE trade.futures_conditional_orders SET status = 'triggered', trigger_key = ${`book:${id}`}, result = ${sql.json({ qty: '1' })}
       WHERE id = ${id}
    `;
    await book.placeOnInstruction(
      {
        userId: ALICE,
        symbol: SYMBOL,
        side: 'sell',
        type: 'market',
        qty: A('1'),
        leverage: 0n,
        reduceOnly: true,
        clientOrderId: `cond:${id}`,
      },
      id,
    );
    const submitted = engine.submits.length;
    await orders.evaluate({ enabled: true });
    expect(engine.submits).toHaveLength(submitted);
    expect(await conditional(id)).toMatchObject({ status: 'filled', closeOrderId: taker });
  });

  it('a book with nothing inside the band: nothing closes, the take-profit stays armed, and the next tick tries again', async () => {
    const positionId = await aliceLong();
    const pair = await orders.replaceProtection(ALICE, positionId, { takeProfit: '110', stopLoss: '95', clientRequestId: 'empty' });
    const id = pair.stopLoss!.id;
    const taker = matchedOrderIdFor(ALICE, MARKET, `cond:${id}`);
    engine.script.push({
      accepted: true,
      sequence: 7001,
      fills: [],
      resting: null,
      rejected: null,
      cancellations: [{ orderId: taker, accountId: ALICE, remainingQty: '1', sequence: 7001, reason: 'ioc' }],
      triggered: [],
    } as EngineSubmitResult);
    mark = A('94');
    await orders.evaluate({ enabled: true });
    expect(await conditional(id)).toMatchObject({ status: 'triggered', failureReason: null, closeOrderId: taker, closedQuantity: '0' });
    expect(await conditional(pair.takeProfit!.id)).toMatchObject({ status: 'armed' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'open', size: '1', margin_current: '10' });
    expect((await ledger.balance(futuresOrderMarginAccount(ALICE, USDT, taker))).amount).toBe(0n);

    // Liquidity comes back: the second attempt, a new order for what is left, closes the position.
    const bid = await carolBid('1', '96');
    const second = scriptFill(id, bid, '1', '96', undefined, 1);
    await orders.evaluate({ enabled: true });
    expect(engine.submits.at(-1)).toMatchObject({ orderId: second, qty: '1' });
    expect(await conditional(id)).toMatchObject({ status: 'filled', closeOrderId: second, closedQuantity: '1' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'closed' });
  });

  it('a part fill keeps the stop working: the next attempt closes the rest, and the other leg stays armed meanwhile', async () => {
    const positionId = await aliceLong('2');
    const pair = await orders.replaceProtection(ALICE, positionId, { takeProfit: '110', stopLoss: '95', clientRequestId: 'part' });
    const id = pair.stopLoss!.id;
    const first = await carolBid('1', '96');
    mark = A('94');
    scriptFill(id, first, '1', '96', '1');
    await orders.evaluate({ enabled: true });
    expect(await conditional(id)).toMatchObject({ status: 'triggered', failureReason: null, firedQuantity: null, closedQuantity: '1' });
    expect(await conditional(pair.takeProfit!.id)).toMatchObject({ status: 'armed' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'open', size: '1' });

    const rest = await carolBid('1', '95.5');
    const second = scriptFill(id, rest, '1', '95.5', undefined, 1);
    await orders.evaluate({ enabled: true });
    expect(engine.submits.at(-1)).toMatchObject({ orderId: second, qty: '1' });
    expect(await conditional(id)).toMatchObject({ status: 'filled', firedQuantity: '1', closedQuantity: '2' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'closed' });
    expect(await conditional(pair.takeProfit!.id)).toMatchObject({ status: 'cancelled', cancelReason: 'position_closed' });
  });

  it('a fill still settling when an attempt leaves the book is waited for: a stop never closes more than its own quantity', async () => {
    const positionId = await aliceLong('10');
    const { order: stop } = await orders.create(ALICE, {
      market: SYMBOL,
      kind: 'stop_market',
      side: 'sell',
      quantity: '4',
      triggerPrice: '95',
      clientOrderId: 'late-fill',
    });
    const bid = await carolBid('3', '96');
    mark = A('94');
    // Attempt 0 asks for 4. The engine fills 3 and cancels 1, but only 1 of the 3 has settled when the cancel is read.
    const taker = scriptFill(stop.id, bid, '1', '96', '1');
    await orders.evaluate({ enabled: true });
    expect(await conditional(stop.id)).toMatchObject({ status: 'triggered', closedQuantity: null });
    const submitted = engine.submits.length;
    await orders.evaluate({ enabled: true });
    expect(engine.submits).toHaveLength(submitted);
    expect(await positionOf(positionId)).toMatchObject({ size: '9' });

    // The rest of the engine's fill lands: the attempt counts 3, and the next one asks only for the 1 left.
    seq += 1;
    await book.settleFill({ marketId: MARKET, makerOrderId: bid, takerOrderId: taker, price: '96', qty: '2', sequence: seq });
    await orders.evaluate({ enabled: true });
    expect(await conditional(stop.id)).toMatchObject({ status: 'triggered', closedQuantity: '3' });
    const more = await carolBid('1', '95.5');
    const second = scriptFill(stop.id, more, '1', '95.5', undefined, 1);
    await orders.evaluate({ enabled: true });
    expect(engine.submits.at(-1)).toMatchObject({ orderId: second, qty: '1' });
    expect(await conditional(stop.id)).toMatchObject({ status: 'filled', closedQuantity: '4' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'open', size: '6' });
  });

  it('a position-wide stop closes what the position’s other reduce-only orders do not already claim', async () => {
    const positionId = await aliceLong('2');
    const pair = await orders.replaceProtection(ALICE, positionId, { stopLoss: '95', clientRequestId: 'room' });
    // A resting reduce-only take-profit limit the trader placed by hand claims 1 of the 2.
    const resting = await book.place(principal(ALICE), {
      ...limit(ALICE, 'sell', '1', '104', 'manual-tp'),
      reduceOnly: true,
    });
    expect(resting.status).toBe('open');
    const bid = await carolBid('1', '96');
    mark = A('94');
    const taker = scriptFill(pair.stopLoss!.id, bid, '1', '96');
    await orders.evaluate({ enabled: true });
    expect(engine.submits.at(-1)).toMatchObject({ orderId: taker, qty: '1' });
    expect(await conditional(pair.stopLoss!.id)).toMatchObject({ status: 'filled', firedQuantity: '1' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'open', size: '1' });
  });

  it('while a liquidation step holds the position the stop waits, then places once it is idle', async () => {
    const positionId = await aliceLong();
    const pair = await orders.replaceProtection(ALICE, positionId, { stopLoss: '95', clientRequestId: 'rung' });
    const id = pair.stopLoss!.id;
    let busy = true;
    book = new MatchedFuturesOrders({
      ...(book as unknown as { deps: ConstructorParameters<typeof MatchedFuturesOrders>[0] }).deps,
      assertPositionIdle: async () => {
        if (busy) throw new MatchedOrderError('a liquidation of this position is in progress', 'trade.liquidation_in_progress', 409);
      },
    });
    const bid = await carolBid('1', '96');
    mark = A('94');
    const submitted = engine.submits.length;
    expect(await orders.evaluate({ enabled: true })).toEqual({ fired: 1 });
    expect(await conditional(id)).toMatchObject({ status: 'triggered', failureReason: null });
    expect(engine.submits).toHaveLength(submitted);
    busy = false;
    scriptFill(id, bid, '1', '96');
    await orders.evaluate({ enabled: true });
    expect(await conditional(id)).toMatchObject({ status: 'filled' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'closed' });
  });

  it('a fired stop-limit places its reduce-only limit in the book', async () => {
    const positionId = await aliceLong();
    const created = await orders.create(ALICE, {
      market: SYMBOL,
      kind: 'stop_limit',
      side: 'sell',
      quantity: '1',
      triggerPrice: '95',
      limitPrice: '94.5',
      reduceOnly: true,
      clientOrderId: 'stop-limit-1',
    });
    mark = A('94');
    await orders.evaluate({ enabled: true });
    const taker = matchedOrderIdFor(ALICE, MARKET, `cond:${created.order.id}`);
    expect(engine.submits.at(-1)).toMatchObject({ orderId: taker, side: 'sell', qty: '1', price: '94.5', tif: 'GTC' });
    expect(await conditional(created.order.id)).toMatchObject({ status: 'filled', closeOrderId: taker, firedQuantity: '1' });
    const [row] = await sql<{ reduce_only: boolean; order_type: string; status: string }[]>`
      SELECT reduce_only, order_type, status FROM trade.futures_orders WHERE id = ${taker}
    `;
    expect(row).toEqual({ reduce_only: true, order_type: 'limit', status: 'open' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'open', size: '1' });
  });

  it('a row the at-mark path claimed is never placed in the book', async () => {
    const positionId = await aliceLong();
    const pair = await orders.replaceProtection(ALICE, positionId, { stopLoss: '95', clientRequestId: 'legacy' });
    const id = pair.stopLoss!.id;
    // Claimed before matching was switched on; its at-mark close may already have run.
    await sql`UPDATE trade.futures_conditional_orders SET status = 'triggered', trigger_key = ${`fire:${id}`} WHERE id = ${id}`;
    const submitted = engine.submits.length;
    await orders.evaluate({ enabled: true });
    expect(engine.submits).toHaveLength(submitted);
    expect(await conditional(id)).toMatchObject({ status: 'triggered' });
  });

  it('admission that cannot be reached leaves the stop triggered, and the next tick places it', async () => {
    const positionId = await aliceLong();
    const pair = await orders.replaceProtection(ALICE, positionId, { stopLoss: '95', clientRequestId: 'auth-down' });
    const id = pair.stopLoss!.id;
    admitStanding.mockRejectedValueOnce(new TradingControlError('authority.unavailable'));
    const bid = await carolBid('1', '96');
    mark = A('94');
    expect(await orders.evaluate({ enabled: true })).toEqual({ fired: 1 });
    expect(await conditional(id)).toMatchObject({ status: 'triggered', failureReason: null, firedQuantity: '1' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'open' });

    scriptFill(id, bid, '1', '96');
    await orders.evaluate({ enabled: true });
    expect(await conditional(id)).toMatchObject({ status: 'filled' });
    expect(await positionOf(positionId)).toMatchObject({ status: 'closed' });
  });

  // Identity's trading restriction and this service's own each refuse by their own code; neither is retried.
  it.each(['trade.account_restricted', 'trade.desk_restricted'] as const)(
    'a refusal that will not pass (%s) is written on the row, and nothing moves',
    async (code) => {
      const positionId = await aliceLong();
      const pair = await orders.replaceProtection(ALICE, positionId, { stopLoss: '95', clientRequestId: 'restricted' });
      admitStanding.mockRejectedValue(new TradingControlError(code));
      const submitted = engine.submits.length;
      const before = (await ledger.balance(userAvailable(ALICE, USDT))).amount;
      mark = A('94');
      await orders.evaluate({ enabled: true });
      expect(await conditional(pair.stopLoss!.id)).toMatchObject({ status: 'failed', failureReason: code });
      await orders.evaluate({ enabled: true });
      expect(engine.submits).toHaveLength(submitted);
      expect((await ledger.balance(userAvailable(ALICE, USDT))).amount).toBe(before);
      expect(await positionOf(positionId)).toMatchObject({ status: 'open', size: '1' });
    },
  );

  it('a stop on a position closed by hand meanwhile is cancelled as gone and places nothing', async () => {
    const positionId = await aliceLong();
    const pair = await orders.replaceProtection(ALICE, positionId, { stopLoss: '95', clientRequestId: 'gone' });
    const id = pair.stopLoss!.id;
    await sql`UPDATE trade.futures_conditional_orders SET status = 'triggered', trigger_key = ${`book:${id}`} WHERE id = ${id}`;
    await sql`UPDATE trade.positions SET status = 'closed' WHERE id = ${positionId}`;
    const submitted = engine.submits.length;
    await orders.evaluate({ enabled: true });
    expect(await conditional(id)).toMatchObject({ status: 'cancelled', cancelReason: 'position_gone' });
    expect(engine.submits).toHaveLength(submitted);
  });

  describe('the price a stop is judged on (J-derivatives-03 #5)', () => {
    /** Bob sells 0.1 to Carol at `price`: the book's last trade. */
    async function tradeAt(price: string) {
      const sell = await book.place(principal(BOB), limit(BOB, 'sell', '0.1', price, `b-last-${seq}`));
      const buy = await book.place(principal(CAROL), limit(CAROL, 'buy', '0.1', price, `c-last-${seq}`));
      seq += 1;
      await book.settleFill({ marketId: MARKET, makerOrderId: sell.orderId, takerOrderId: buy.orderId, price, qty: '0.1', sequence: seq });
    }

    it('a stop judged on the last trade fires when the book trades through it, not when the mark does', async () => {
      const positionId = await aliceLong('1');
      const { order: stop } = await orders.create(ALICE, {
        market: SYMBOL,
        kind: 'stop_market',
        side: 'sell',
        quantity: '1',
        triggerPrice: '95',
        clientOrderId: 'last-stop',
        triggerSource: 'last',
      });
      expect(stop).toMatchObject({ status: 'armed', triggerSource: 'last' });
      mark = A('94');
      await orders.evaluate({ enabled: true });
      expect(await conditional(stop.id)).toMatchObject({ status: 'armed' });

      mark = A('100');
      await tradeAt('95');
      const bid = await carolBid('1', '96');
      scriptFill(stop.id, bid, '1', '96');
      await orders.evaluate({ enabled: true });
      expect(await conditional(stop.id)).toMatchObject({ status: 'filled', closedQuantity: '1' });
      expect(await positionOf(positionId)).toMatchObject({ status: 'closed' });
    });

    it('a trailing stop on the last trade trails the trades, and a mark stop beside it does not move', async () => {
      await aliceLong('2');
      const { order: trail } = await orders.create(ALICE, {
        market: SYMBOL,
        kind: 'trailing_stop',
        side: 'sell',
        quantity: '1',
        trailingDistance: '2',
        clientOrderId: 'last-trail',
        triggerSource: 'last',
      });
      expect(trail).toMatchObject({ triggerPrice: '98', trailExtreme: '100', triggerSource: 'last' });
      const { order: onMark } = await orders.create(ALICE, {
        market: SYMBOL,
        kind: 'trailing_stop',
        side: 'sell',
        quantity: '1',
        trailingDistance: '2',
        clientOrderId: 'mark-trail',
      });
      expect(onMark).toMatchObject({ triggerSource: 'mark' });
      await tradeAt('103');
      await orders.evaluate({ enabled: true });
      expect(await conditional(trail.id)).toMatchObject({ status: 'armed', trailExtreme: '103', triggerPrice: '101' });
      expect(await conditional(onMark.id)).toMatchObject({ status: 'armed', trailExtreme: '100', triggerPrice: '98' });
    });

    it('a trigger already reached on its own source is refused; a trade still waiting to settle counts as the last trade', async () => {
      await aliceLong('1');
      const stopAt = (trigger: string, triggerSource: 'mark' | 'last', clientOrderId: string) =>
        orders.create(ALICE, {
          market: SYMBOL,
          kind: 'stop_market',
          side: 'sell',
          quantity: '1',
          triggerPrice: trigger,
          clientOrderId,
          triggerSource,
        });
      await expect(stopAt('101', 'mark', 'crossed-mark')).rejects.toMatchObject({ code: 'trade.conditional_already_crossed' });
      await expect(stopAt('101', 'last', 'crossed-last')).rejects.toMatchObject({ code: 'trade.conditional_already_crossed' });
      expect(await stopAt('95', 'last', 'below-last')).toMatchObject({ order: { status: 'armed' } });
      // The book traded at 94, but that fill is parked behind a liquidation step: it is still the last trade.
      seq += 1;
      await sql`
        INSERT INTO trade.futures_fill_waits (market_id, engine_sequence, maker_order_id, taker_order_id, price, qty, reason)
        VALUES (${MARKET}, ${seq}, ${randomUUID()}, ${randomUUID()}, 94, 0.1, 'trade.liquidation_in_progress')
      `;
      await expect(stopAt('95', 'last', 'parked-last')).rejects.toMatchObject({ code: 'trade.conditional_already_crossed' });
    });

    it('a last-trade trigger with no trade yet, the unpublished index, and an exit that would enlarge are refused; nothing is stored', async () => {
      await aliceLong('1');
      await expect(
        orders.create(ALICE, {
          market: SYMBOL,
          kind: 'stop_market',
          side: 'sell',
          quantity: '1',
          triggerPrice: '95',
          clientOrderId: 'index-stop',
          triggerSource: 'index',
        }),
      ).rejects.toMatchObject({ code: 'trade.trigger_source_unset' });
      await expect(
        orders.create(ALICE, {
          market: SYMBOL,
          kind: 'stop_market',
          side: 'buy',
          quantity: '1',
          triggerPrice: '105',
          clientOrderId: 'enlarge-stop',
          triggerSource: 'last',
        }),
      ).rejects.toMatchObject({ code: 'trade.conditional_would_increase' });
      await sql`DELETE FROM trade.futures_order_fills WHERE market_id = ${MARKET}`;
      await expect(
        orders.create(ALICE, {
          market: SYMBOL,
          kind: 'stop_market',
          side: 'sell',
          quantity: '1',
          triggerPrice: '95',
          clientOrderId: 'no-trade-stop',
          triggerSource: 'last',
        }),
      ).rejects.toMatchObject({ code: 'trade.last_price_missing' });
      expect(await orders.list(ALICE)).toEqual([]);
    });
  });

  describe('protection attached to an opening order (J-derivatives-03 #4)', () => {
    /** Records the protection first, as the route does before it places the order. */
    async function entryWith(clientOrderId: string, legs: { takeProfit?: string; stopLoss?: string }, side: 'buy' | 'sell' = 'buy') {
      return orders.recordEntryProtection(ALICE, { symbol: SYMBOL, side, reduceOnly: false, clientOrderId, ...legs });
    }
    async function fill(makerOrderId: string, takerOrderId: string, qty: string) {
      seq += 1;
      await book.settleFill({ marketId: MARKET, makerOrderId, takerOrderId, price: '100', qty, sequence: seq });
    }
    async function openLong(): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        SELECT id FROM trade.positions WHERE user_id = ${ALICE} AND side = 'long' AND status = 'open'
      `;
      return row!.id;
    }
    const legsOf = async () => Object.fromEntries((await orders.list(ALICE)).map((o) => [o.clientOrderId, o]));
    const entryRow = async (clientOrderId: string) =>
      (await orders.listEntryProtection(ALICE)).find((e) => e.clientOrderId === clientOrderId);

    it('arms on what fills, grows as more fills, and is done when the order is', async () => {
      const recorded = await entryWith('entry-1', { takeProfit: '110', stopLoss: '90' });
      expect(recorded).toMatchObject({ status: 'waiting', takeProfit: '110', stopLoss: '90', armedQuantity: '0' });
      // The same request recorded again is the same row.
      expect(await entryWith('entry-1', { takeProfit: '110', stopLoss: '90' })).toMatchObject({ id: recorded!.id });
      const entry = await book.place(principal(ALICE), limit(ALICE, 'buy', '1', '100', 'entry-1'));

      await orders.evaluate({ enabled: true });
      expect(await orders.list(ALICE)).toEqual([]);

      const bob = await book.place(principal(BOB), limit(BOB, 'sell', '1', '100', 'entry-1-bob'));
      await fill(entry.orderId, bob.orderId, '0.4');
      await orders.evaluate({ enabled: true });
      const positionId = await openLong();
      const tp = `entry:${positionId}:entry-1:tp`;
      const sl = `entry:${positionId}:entry-1:sl`;
      expect((await legsOf())[tp]).toMatchObject({
        status: 'armed',
        kind: 'take_profit',
        quantity: '0.4',
        wholePosition: false,
        triggerPrice: '110',
      });
      expect((await legsOf())[sl]).toMatchObject({
        status: 'armed',
        kind: 'stop_market',
        quantity: '0.4',
        wholePosition: false,
        triggerPrice: '90',
      });
      expect(await entryRow('entry-1')).toMatchObject({ status: 'armed', armedQuantity: '0.4', takeProfitClientOrderId: tp });

      await fill(entry.orderId, bob.orderId, '0.6');
      await orders.evaluate({ enabled: true });
      expect((await legsOf())[tp]).toMatchObject({ status: 'armed', quantity: '1' });
      expect((await legsOf())[sl]).toMatchObject({ status: 'armed', quantity: '1' });
      expect(await entryRow('entry-1')).toMatchObject({ status: 'done', armedQuantity: '1' });

      // Its take-profit closes what the entry opened, and its linked stop-loss goes with it.
      mark = A('109');
      const bid = await carolBid('1', '110');
      mark = A('111');
      const leg = (await legsOf())[tp]!;
      scriptFill(leg.id, bid, '1', '110');
      await orders.evaluate({ enabled: true });
      expect((await legsOf())[tp]).toMatchObject({ status: 'filled', closedQuantity: '1' });
      expect((await legsOf())[sl]).toMatchObject({ status: 'cancelled' });
    });

    it('fills after a fired leg get a fresh pair on the same position, and a leg the trader cancelled is left alone', async () => {
      const positionId = await aliceLong('1');
      await entryWith('entry-refire', { takeProfit: '110', stopLoss: '90' });
      const entry = await book.place(principal(ALICE), limit(ALICE, 'buy', '1', '100', 'entry-refire'));
      const bob = await book.place(principal(BOB), limit(BOB, 'sell', '1', '100', 'entry-refire-bob'));
      await fill(entry.orderId, bob.orderId, '0.4');
      await orders.evaluate({ enabled: true });
      const tp = `entry:${positionId}:entry-refire:tp`;
      const sl = `entry:${positionId}:entry-refire:sl`;
      expect((await legsOf())[tp]).toMatchObject({ status: 'armed', quantity: '0.4' });

      // The take profit fires on its 0.4; the position stays open on the earlier 1, and the linked stop loss goes.
      mark = A('109');
      const bid = await carolBid('0.4', '110');
      mark = A('111');
      scriptFill((await legsOf())[tp]!.id, bid, '0.4', '110');
      await orders.evaluate({ enabled: true });
      expect((await legsOf())[tp]).toMatchObject({ status: 'filled', closedQuantity: '0.4' });
      expect((await legsOf())[sl]).toMatchObject({ status: 'cancelled', cancelReason: 'linked' });
      expect(await positionOf(positionId)).toMatchObject({ status: 'open', size: '1' });

      // The order fills on into the same position: those fills get a pair of their own, sized to them alone.
      mark = A('100');
      await fill(entry.orderId, bob.orderId, '0.3');
      await orders.evaluate({ enabled: true });
      const tp1 = `entry:${positionId}:entry-refire:1:tp`;
      const sl1 = `entry:${positionId}:entry-refire:1:sl`;
      expect((await legsOf())[tp1]).toMatchObject({ status: 'armed', quantity: '0.3', triggerPrice: '110', wholePosition: false });
      expect((await legsOf())[sl1]).toMatchObject({ status: 'armed', quantity: '0.3', triggerPrice: '90', wholePosition: false });
      expect(await entryRow('entry-refire')).toMatchObject({
        status: 'armed',
        armedQuantity: '0.7',
        takeProfitClientOrderId: tp1,
        stopLossClientOrderId: sl1,
      });
      // The new pair grows with the fills after it, and the fired pair stays as it ended.
      await fill(entry.orderId, bob.orderId, '0.1');
      await orders.evaluate({ enabled: true });
      expect((await legsOf())[sl1]).toMatchObject({ status: 'armed', quantity: '0.4' });
      expect((await legsOf())[tp]).toMatchObject({ status: 'filled', quantity: '0.4' });

      // The trader cancels the new stop loss and the new take profit fires: that was their choice, so the last fill
      // gets no third pair.
      await orders.cancel(ALICE, (await legsOf())[sl1]!.id);
      mark = A('109');
      const bid2 = await carolBid('0.4', '110');
      mark = A('111');
      scriptFill((await legsOf())[tp1]!.id, bid2, '0.4', '110');
      await orders.evaluate({ enabled: true });
      expect((await legsOf())[tp1]).toMatchObject({ status: 'filled' });
      mark = A('100');
      await fill(entry.orderId, bob.orderId, '0.2');
      await orders.evaluate({ enabled: true });
      expect((await legsOf())[`entry:${positionId}:entry-refire:2:tp`]).toBeUndefined();
      expect((await legsOf())[`entry:${positionId}:entry-refire:2:sl`]).toBeUndefined();
      expect(await entryRow('entry-refire')).toMatchObject({ status: 'done', armedQuantity: '1', takeProfitClientOrderId: tp1 });
    });

    it('covers only what the order filled, not the position it added to', async () => {
      const positionId = await aliceLong('1');
      await entryWith('entry-add', { stopLoss: '90' });
      const entry = await book.place(principal(ALICE), limit(ALICE, 'buy', '0.5', '100', 'entry-add'));
      const bob = await book.place(principal(BOB), limit(BOB, 'sell', '0.5', '100', 'entry-add-bob'));
      await fill(entry.orderId, bob.orderId, '0.5');
      await orders.evaluate({ enabled: true });
      expect(await positionOf(positionId)).toMatchObject({ size: '1.5' });
      const [leg] = await orders.list(ALICE);
      expect(leg).toMatchObject({ attachment: 'stop_loss', quantity: '0.5', wholePosition: false, positionId });
    });

    it('an order that ends with no fill arms nothing', async () => {
      await entryWith('entry-none', { takeProfit: '110' });
      const entry = await book.place(principal(ALICE), limit(ALICE, 'buy', '1', '99', 'entry-none'));
      await sql`UPDATE trade.futures_orders SET status = 'cancelled', engine_filled_qty = 0 WHERE id = ${entry.orderId}`;
      await orders.evaluate({ enabled: true });
      expect(await orders.list(ALICE)).toEqual([]);
      expect(await entryRow('entry-none')).toMatchObject({ status: 'not_filled' });
    });

    it('a cancelled order with a fill still settling waits for it before it is done', async () => {
      await entryWith('entry-late', { stopLoss: '90' });
      const entry = await book.place(principal(ALICE), limit(ALICE, 'buy', '1', '100', 'entry-late'));
      const bob = await book.place(principal(BOB), limit(BOB, 'sell', '1', '100', 'entry-late-bob'));
      await fill(entry.orderId, bob.orderId, '0.3');
      // The engine filled 0.7 in all before the rest came off; 0.4 of it has not settled yet.
      await sql`UPDATE trade.futures_orders SET status = 'cancelled', engine_filled_qty = 0.7 WHERE id = ${entry.orderId}`;
      await orders.evaluate({ enabled: true });
      expect(await entryRow('entry-late')).toMatchObject({ status: 'armed', armedQuantity: '0.3' });
      await fill(entry.orderId, bob.orderId, '0.4');
      await orders.evaluate({ enabled: true });
      expect(await entryRow('entry-late')).toMatchObject({ status: 'done', armedQuantity: '0.7' });
      expect((await orders.list(ALICE))[0]).toMatchObject({ quantity: '0.7' });
    });

    it('a position closed before the fill was armed leaves nothing armed once the order is over', async () => {
      await entryWith('entry-gone', { takeProfit: '110' });
      const entry = await book.place(principal(ALICE), limit(ALICE, 'buy', '1', '100', 'entry-gone'));
      const bob = await book.place(principal(BOB), limit(BOB, 'sell', '1', '100', 'entry-gone-bob'));
      await fill(entry.orderId, bob.orderId, '1');
      await sql`UPDATE trade.positions SET status = 'closed' WHERE user_id = ${ALICE}`;
      await orders.evaluate({ enabled: true });
      expect(await orders.list(ALICE)).toEqual([]);
      expect(await entryRow('entry-gone')).toMatchObject({ status: 'no_position' });
    });

    it('stays live while the order works with nothing open, and arms a new pair for the fills in a new position only', async () => {
      await entryWith('entry-again', { takeProfit: '110', stopLoss: '90' });
      const entry = await book.place(principal(ALICE), limit(ALICE, 'buy', '1', '100', 'entry-again'));
      const bob = await book.place(principal(BOB), limit(BOB, 'sell', '1', '100', 'entry-again-bob'));
      await fill(entry.orderId, bob.orderId, '0.3');
      await orders.evaluate({ enabled: true });
      const first = await openLong();
      expect((await legsOf())[`entry:${first}:entry-again:tp`]).toMatchObject({ status: 'armed', quantity: '0.3' });

      // The trader closes the position by hand (its legs go with it); the order is still working.
      await sql`UPDATE trade.positions SET status = 'closed' WHERE id = ${first}`;
      await sql`
        UPDATE trade.futures_conditional_orders SET status = 'cancelled', cancel_reason = 'position_closed'
        WHERE position_id = ${first}
      `;
      await fill(entry.orderId, bob.orderId, '0.2');
      const second = await openLong();
      expect(second).not.toBe(first);
      expect(await aliceLong('2')).toBe(second);
      await orders.evaluate({ enabled: true });
      // The new position holds 0.2 of this order's fills (and 2 from another order): the new pair covers the 0.2.
      expect((await legsOf())[`entry:${second}:entry-again:tp`]).toMatchObject({ status: 'armed', quantity: '0.2' });
      expect((await legsOf())[`entry:${second}:entry-again:sl`]).toMatchObject({ status: 'armed', quantity: '0.2' });
      expect(await entryRow('entry-again')).toMatchObject({
        status: 'armed',
        armedQuantity: '0.5',
        takeProfitClientOrderId: `entry:${second}:entry-again:tp`,
      });

      // Nothing open on its side while the order still works: the row is not final.
      await sql`UPDATE trade.positions SET status = 'closed' WHERE id = ${second}`;
      await fill(entry.orderId, bob.orderId, '0.1');
      await sql`UPDATE trade.positions SET status = 'closed' WHERE user_id = ${ALICE} AND status = 'open'`;
      await orders.evaluate({ enabled: true });
      expect(await entryRow('entry-again')).toMatchObject({ status: 'armed', armedQuantity: '0.6' });
    });

    it('an order that never appears closes the row not_placed, and the same request sent again reopens it', async () => {
      const waiting = conditionalService(undefined, { entryOrderWaitMs: 0 });
      await entryWith('entry-never', { stopLoss: '90' });
      await waiting.evaluate({ enabled: true });
      expect(await entryRow('entry-never')).toMatchObject({ status: 'not_placed' });
      expect(await entryWith('entry-never', { stopLoss: '90' })).toMatchObject({ status: 'waiting' });
      // While it waits for an order being placed, the default wait keeps it open.
      await orders.evaluate({ enabled: true });
      expect(await entryRow('entry-never')).toMatchObject({ status: 'waiting' });
      const entry = await book.place(principal(ALICE), limit(ALICE, 'buy', '1', '100', 'entry-never'));
      const bob = await book.place(principal(BOB), limit(BOB, 'sell', '1', '100', 'entry-never-bob'));
      await fill(entry.orderId, bob.orderId, '1');
      await waiting.evaluate({ enabled: true });
      expect(await entryRow('entry-never')).toMatchObject({ status: 'done', armedQuantity: '1' });
    });

    it('one entry that cannot be worked does not stop the others', async () => {
      await entryWith('entry-stuck', { stopLoss: '90' });
      await entryWith('entry-ok', { stopLoss: '90' });
      const stuck = await book.place(principal(ALICE), limit(ALICE, 'buy', '0.5', '100', 'entry-stuck'));
      const ok = await book.place(principal(ALICE), limit(ALICE, 'buy', '0.5', '100', 'entry-ok'));
      const bob = await book.place(principal(BOB), limit(BOB, 'sell', '1', '100', 'entry-ok-bob'));
      await fill(stuck.orderId, bob.orderId, '0.5');
      await fill(ok.orderId, bob.orderId, '0.5');
      const held = await sql.reserve();
      try {
        await held`BEGIN`;
        await held`SELECT id FROM trade.futures_entry_protection WHERE client_order_id = 'entry-stuck' FOR UPDATE`;
        await expect(orders.evaluate({ enabled: true })).rejects.toBeDefined();
        expect(await entryRow('entry-ok')).toMatchObject({ status: 'done', armedQuantity: '0.5' });
        expect(await entryRow('entry-stuck')).toMatchObject({ status: 'waiting' });
      } finally {
        await held`ROLLBACK`;
        held.release();
      }
      await orders.evaluate({ enabled: true });
      expect(await entryRow('entry-stuck')).toMatchObject({ status: 'done', armedQuantity: '0.5' });
    });

    it('is refused before anything is placed: wrong side, reduce-only, no price, a reused client id', async () => {
      await expect(entryWith('bad-tp', { takeProfit: '95' })).rejects.toMatchObject({ code: 'trade.protection_wrong_side' });
      await expect(entryWith('bad-sl', { stopLoss: '120', takeProfit: '130' }, 'sell')).rejects.toMatchObject({
        code: 'trade.protection_wrong_side',
      });
      await expect(
        orders.recordEntryProtection(ALICE, { symbol: SYMBOL, side: 'sell', reduceOnly: true, clientOrderId: 'ro', stopLoss: '120' }),
      ).rejects.toMatchObject({ code: 'trade.entry_protection_reduce_only' });
      await expect(entryWith('nan', { takeProfit: 'abc' })).rejects.toMatchObject({ code: 'trade.conditional_amount_invalid' });
      expect(await entryWith('none', {})).toBeNull();
      await entryWith('reused', { takeProfit: '110' });
      await expect(entryWith('reused', { takeProfit: '111' })).rejects.toMatchObject({ code: 'trade.client_order_id_conflict' });
      // The same request again is not checked against a mark that has moved since.
      mark = A('115');
      expect(await entryWith('reused', { takeProfit: '110' })).toMatchObject({ clientOrderId: 'reused' });
      // An order already placed under the id without protection is not given protection by a later request.
      mark = A('100');
      await book.place(principal(ALICE), limit(ALICE, 'buy', '1', '99', 'placed-bare'));
      await expect(entryWith('placed-bare', { stopLoss: '90' })).rejects.toMatchObject({ code: 'trade.client_order_id_conflict' });
      // Two different requests under one id at once: one is recorded, the other refused.
      const both = await Promise.allSettled([entryWith('race', { takeProfit: '110' }), entryWith('race', { takeProfit: '112' })]);
      expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(both.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'trade.client_order_id_conflict' } });
      expect(await orders.list(ALICE)).toEqual([]);
    });
  });

  it('the instruction door never opens a position', async () => {
    await expect(
      book.placeOnInstruction(
        { userId: ALICE, symbol: SYMBOL, side: 'buy', type: 'market', qty: A('1'), leverage: A('10'), clientOrderId: 'cond:open' },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'trade.conditional_would_increase' });
    await expect(
      book.placeOnInstruction(
        {
          userId: ALICE,
          symbol: SYMBOL,
          side: 'sell',
          type: 'market',
          qty: A('1'),
          leverage: 0n,
          reduceOnly: true,
          clientOrderId: 'cond:none',
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'trade.futures_reduce_only_no_position' });
    expect(await sql`SELECT 1 FROM trade.futures_orders`).toHaveLength(0);
  });
});
