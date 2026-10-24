/**
 * The futures orders room's reads (J-derivatives-04 steps 1 and 2, D-orders-03), against the real trade schema and
 * MemoryLedger: where each order came from, the trader's own label, open and ended orders a page at a time, and the
 * executions their fills and ADL pairs made. None of it moves money, so each money check here is that a read or a
 * refused write moved none: a liquidation order cannot be cancelled by its trader, and a label never changes a hold.
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
import { decodeExecutionCursor, listFuturesExecutions } from './futures-executions.js';
import { readListQuery } from './matched-orders-rest.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const files = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort();
const migrations = files.map((f) => readFileSync(join(drizzle, f), 'utf8'));
const ORIGIN_MIGRATION = readFileSync(join(drizzle, '20261024062001_futures_order_origin_label.sql'), 'utf8');

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('intafaced_orders_room_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`the futures orders room needs Postgres: TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
  }
}

const A = (s: string) => parseAmount(s);
const USDT = 'USDT';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const MARKET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SYMBOL = 'SOL/USDT-PERP';
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

describe('svc-trade futures orders room: origin, label, pages and executions (PG-backed)', () => {
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
  let feeRates: FeeRates;
  let sequence: number;
  let admission: TradingAdmissionPort;

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.futures_order_fills, trade.futures_orders, trade.positions, trade.markets, trade.futures_payouts,
               trade.futures_fill_waits, trade.account_position_modes, trade.liquidation_rungs, trade.futures_adl_pairs,
               trade.futures_conditional_orders, trade.futures_reverse_requests
      RESTART IDENTITY CASCADE
    `;
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, ${SYMBOL}, 'SOL', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'SOL perpetual', now()
      )
    `;
    ledger = new MemoryLedger();
    engine = new RestingEngine();
    feeRates = { makerBps: 2, takerBps: 5 };
    sequence = 0;
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
      feeRates: async () => feeRates,
      ...overrides,
    });
  }

  function order(
    overrides: Partial<PlaceMatchedOrderInput> & Pick<PlaceMatchedOrderInput, 'userId' | 'side' | 'qty'>,
  ): PlaceMatchedOrderInput {
    return { symbol: SYMBOL, type: 'limit', limitPrice: A('100'), leverage: A('10'), clientOrderId: `c-${randomUUID()}`, ...overrides };
  }

  async function settle(maker: { orderId: string }, taker: { orderId: string }, price: bigint, qty: bigint) {
    await build().settleFill({
      marketId: MARKET,
      makerOrderId: maker.orderId,
      takerOrderId: taker.orderId,
      price: formatAmount(price),
      qty: formatAmount(qty),
      sequence: ++sequence,
    });
  }

  async function openPosition(userId: string) {
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM trade.positions WHERE user_id = ${userId} AND market_id = ${MARKET} AND status = 'open'
    `;
    return row!;
  }

  describe('origin and label', () => {
    it("a trader's own order is `user` and keeps its label; the label filter returns only it", async () => {
      const svc = build();
      const tagged = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), orderLabel: 'grid-7' }));
      await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
      expect(tagged).toMatchObject({ origin: 'user', originRef: null, orderLabel: 'grid-7' });

      const byLabel = await svc.listForUser(ALICE, { scope: 'all', limit: 50, label: 'grid-7' });
      expect(byLabel.map((o) => o.orderId)).toEqual([tagged.orderId]);
      expect(await svc.listForUser(BOB, { scope: 'all', limit: 50, label: 'grid-7' })).toEqual([]);
    });

    it('the same clientOrderId with another label is a different order: refused, nothing more held', async () => {
      const svc = build();
      const first = order({ userId: ALICE, side: 'buy', qty: A('1'), orderLabel: 'a' });
      const placed = await svc.place(principal(ALICE), first);
      const free = (await ledger.balance(userAvailable(ALICE, USDT))).amount;
      await expect(svc.place(principal(ALICE), { ...first, orderLabel: 'b' })).rejects.toMatchObject({
        code: 'trade.client_order_id_conflict',
      });
      // The retry with the same label finds the first order.
      expect((await svc.place(principal(ALICE), first)).orderId).toBe(placed.orderId);
      expect((await ledger.balance(userAvailable(ALICE, USDT))).amount).toBe(free);
      expect(engine.submits).toHaveLength(1);
    });

    it('a label outside 1-36 of letters, digits and . _ : - refuses before anything is held', async () => {
      const svc = build();
      for (const orderLabel of ['', 'x'.repeat(37), 'has space', 'semi;colon']) {
        await expect(svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), orderLabel }))).rejects.toMatchObject({
          code: 'trade.order_label_invalid',
        });
      }
      expect(engine.submits).toHaveLength(0);
      expect((await ledger.balance(userAvailable(ALICE, USDT))).amount).toBe(A('1000'));
    });

    it('the trader door never places a stop or a liquidation order', async () => {
      const svc = build();
      for (const kind of ['stop', 'liquidation', 'take_profit'] as const) {
        await expect(
          svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), origin: { kind } })),
        ).rejects.toMatchObject({ code: 'trade.futures_order_origin_invalid' });
      }
      expect(engine.submits).toHaveLength(0);
    });

    it('a fired conditional order places under its own origin and names the conditional order', async () => {
      const svc = build();
      const buy = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2') }));
      const sell = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('2') }));
      await settle(buy, sell, A('100'), A('2'));
      const instruction = randomUUID();
      const stop = await svc.placeOnInstruction(
        {
          userId: ALICE,
          symbol: SYMBOL,
          side: 'sell',
          type: 'market',
          qty: A('1'),
          leverage: 0n,
          reduceOnly: true,
          clientOrderId: `cond:${instruction}`,
          origin: { kind: 'stop_loss' },
        },
        instruction,
      );
      expect(stop).toMatchObject({ origin: 'stop_loss', originRef: instruction, reduceOnly: true });
      const listed = await svc.listForUser(ALICE, { scope: 'open', limit: 50, origin: 'stop_loss' });
      expect(listed.map((o) => o.orderId)).toEqual([stop.orderId]);
      // A conditional caller that names no kind is a stop; it can never name a liquidation.
      await expect(
        svc.placeOnInstruction(
          {
            userId: ALICE,
            symbol: SYMBOL,
            side: 'sell',
            type: 'market',
            qty: A('1'),
            leverage: 0n,
            reduceOnly: true,
            clientOrderId: 'x',
            origin: { kind: 'liquidation' },
          },
          instruction,
        ),
      ).rejects.toMatchObject({ code: 'trade.futures_order_origin_invalid' });
    });

    it('a liquidation order is listed with its origin, and its trader cannot cancel it: the engine is not asked', async () => {
      const svc = build();
      const buy = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2') }));
      const sell = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('2') }));
      await settle(buy, sell, A('100'), A('2'));
      const position = await openPosition(ALICE);
      const rung = randomUUID();
      const liquidation = randomUUID();
      await sql`
        INSERT INTO trade.futures_orders (
          id, user_id, market_id, client_order_id, side, order_type, qty, limit_price, mark_price, band_low, band_high,
          leverage, hold_asset, status, reduce_only, position_id, bankruptcy_price, liquidation_rung_id, origin, origin_ref
        ) VALUES (
          ${liquidation}, ${ALICE}, ${MARKET}, ${`liq:${rung}`}, 'sell', 'market', '2', '95', '100', '95', '105',
          '10', ${USDT}, 'open', true, ${position.id}, '90', ${rung}, 'liquidation', ${rung}
        )
      `;
      const listed = await svc.listForUser(ALICE, { scope: 'open', limit: 50 });
      expect(listed.find((o) => o.orderId === liquidation)).toMatchObject({ origin: 'liquidation', originRef: rung });
      const cancelsBefore = engine.cancels.length;
      await expect(svc.cancel(principal(ALICE), liquidation)).rejects.toMatchObject({ code: 'trade.futures_order_not_cancellable' });
      expect(engine.cancels).toHaveLength(cancelsBefore);
      const [row] = await sql<{ status: string }[]>`SELECT status FROM trade.futures_orders WHERE id = ${liquidation}`;
      expect(row!.status).toBe('open');
    });

    it('the migration names the orders placed before it: a fired conditional order, and the trader’s own', async () => {
      const svc = build();
      const buy = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2') }));
      const sell = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('2') }));
      await settle(buy, sell, A('100'), A('2'));
      const position = await openPosition(ALICE);
      const conditional = randomUUID();
      await sql`
        INSERT INTO trade.futures_conditional_orders (
          id, user_id, market_id, position_id, client_order_id, kind, side, quantity, trigger_price, reduce_only,
          attachment, status, request_hash
        ) VALUES (
          ${conditional}, ${ALICE}, ${MARKET}, ${position.id}, 'tp-1', 'take_profit', 'sell', '1', '110', true,
          'take_profit', 'triggered', 'h'
        )
      `;
      const fired = await svc.placeOnInstruction(
        {
          userId: ALICE,
          symbol: SYMBOL,
          side: 'sell',
          type: 'market',
          qty: A('1'),
          leverage: 0n,
          reduceOnly: true,
          clientOrderId: `cond:${conditional}:1`,
        },
        conditional,
      );
      const own = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
      // As an order written before origin existed: every row back to `user`, then the migration's own statements.
      await sql`UPDATE trade.futures_orders SET origin = 'user', origin_ref = NULL`;
      await sql.unsafe(ORIGIN_MIGRATION);
      const origins = await sql<{ id: string; origin: string; origin_ref: string | null }[]>`
        SELECT id, origin, origin_ref FROM trade.futures_orders
      `;
      const by = new Map(origins.map((r) => [r.id, r]));
      expect(by.get(fired.orderId)).toMatchObject({ origin: 'take_profit', origin_ref: conditional });
      expect(by.get(own.orderId)).toMatchObject({ origin: 'user', origin_ref: null });
    });
  });

  describe('pages', () => {
    it('open and history split by state, newest first, and a cursor never repeats or skips an order', async () => {
      const svc = build();
      const placed: string[] = [];
      for (let n = 0; n < 5; n += 1) {
        placed.push((await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }))).orderId);
      }
      await svc.cancel(principal(ALICE), placed[1]!);
      await svc.cancel(principal(ALICE), placed[3]!);

      const open = await svc.listForUser(ALICE, { scope: 'open', limit: 50 });
      const history = await svc.listForUser(ALICE, { scope: 'history', limit: 50 });
      expect(new Set(open.map((o) => o.orderId))).toEqual(new Set([placed[0], placed[2], placed[4]]));
      expect(new Set(history.map((o) => o.orderId))).toEqual(new Set([placed[1], placed[3]]));
      expect(history.every((o) => o.status === 'cancelled')).toBe(true);

      const seen: string[] = [];
      let before: string | null = null;
      for (;;) {
        const page = await svc.listForUser(ALICE, { scope: 'all', limit: 2, before });
        seen.push(...page.map((o) => o.orderId));
        if (page.length < 2) break;
        before = page[page.length - 1]!.orderId;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen)).toEqual(new Set(placed));
      const all = await svc.listForUser(ALICE, { scope: 'all', limit: 50 });
      expect(seen).toEqual(all.map((o) => o.orderId));
    });

    it("a cursor that is not the caller's own order refuses rather than starting over", async () => {
      const svc = build();
      const bobs = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('1') }));
      await expect(svc.listForUser(ALICE, { scope: 'all', limit: 10, before: bobs.orderId })).rejects.toMatchObject({
        code: 'trade.invalid_cursor',
      });
      await expect(svc.listForUser(ALICE, { scope: 'all', limit: 10, before: 'not-an-id' })).rejects.toMatchObject({
        code: 'trade.invalid_cursor',
      });
    });

    it('one order is read only by its own trader', async () => {
      const svc = build();
      const mine = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), orderLabel: 'mine' }));
      expect(await svc.getForUser(ALICE, mine.orderId)).toMatchObject({ orderId: mine.orderId, symbol: SYMBOL, orderLabel: 'mine' });
      expect(await svc.getForUser(BOB, mine.orderId)).toBeNull();
      expect(await svc.getForUser(ALICE, 'cond:abc')).toBeNull();
    });
  });

  describe('executions', () => {
    it('opening fills, a closing fill and its realised result, newest first, with fee and maker or taker', async () => {
      const svc = build();
      const buy = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2'), orderLabel: 'entry' }));
      const sell = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('2') }));
      await settle(buy, sell, A('100'), A('2'));
      // Alice closes half at 104 against a new buy from Bob: a reduce fill that realises a profit.
      const close = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'sell', qty: A('1'), limitPrice: A('104'), reduceOnly: true }),
      );
      const bobBuy = await svc.place(
        principal(BOB),
        order({ userId: BOB, side: 'buy', qty: A('1'), limitPrice: A('104'), reduceOnly: true }),
      );
      await settle(close, bobBuy, A('104'), A('1'));

      const { executions, next } = await listFuturesExecutions(sql, ALICE, { limit: 50 });
      expect(next).toBeNull();
      expect(executions.map((e) => e.kind)).toEqual(['close', 'open']);
      const [closed, opened] = executions;
      expect(opened).toMatchObject({
        side: 'buy',
        qty: '2',
        price: '100',
        feeRole: 'maker',
        orderId: buy.orderId,
        orderLabel: 'entry',
        origin: 'user',
        symbol: SYMBOL,
      });
      expect(closed).toMatchObject({ side: 'sell', qty: '1', price: '104', feeRole: 'maker', orderId: close.orderId });
      expect(parseAmount(closed!.realizedPnl!)).toBeGreaterThan(0n);
      expect(parseAmount(opened!.fee!)).toBeGreaterThan(0n);
      // Bob's side of the same fills is his own; Alice never sees it.
      const bob = await listFuturesExecutions(sql, BOB, { limit: 50 });
      expect(bob.executions.every((e) => e.orderId !== buy.orderId && e.orderId !== close.orderId)).toBe(true);
      expect(await listFuturesExecutions(sql, ALICE, { limit: 50, kind: 'open' })).toMatchObject({ executions: [{ kind: 'open' }] });
      expect((await listFuturesExecutions(sql, ALICE, { limit: 50, orderId: close.orderId })).executions.map((e) => e.kind)).toEqual([
        'close',
      ]);
    });

    it('pages by cursor without repeating a row, and a cursor it did not give refuses', async () => {
      const svc = build();
      for (let n = 0; n < 3; n += 1) {
        const buy = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
        const sell = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('1') }));
        await settle(buy, sell, A('100'), A('1'));
      }
      const first = await listFuturesExecutions(sql, ALICE, { limit: 2 });
      expect(first.executions).toHaveLength(2);
      expect(first.next).not.toBeNull();
      expect(decodeExecutionCursor(first.next!)).not.toBeNull();
      const second = await listFuturesExecutions(sql, ALICE, { limit: 2, before: first.next });
      expect(second.executions).toHaveLength(1);
      expect(second.next).toBeNull();
      const ids = [...first.executions, ...second.executions].map((e) => e.id);
      expect(new Set(ids).size).toBe(3);
      await expect(listFuturesExecutions(sql, ALICE, { limit: 2, before: 'garbage' })).rejects.toMatchObject({
        code: 'trade.invalid_cursor',
      });
    });

    it('an applied ADL pair is an execution on both sides at its bankruptcy price', async () => {
      const svc = build();
      const buy = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
      const sell = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('1') }));
      await settle(buy, sell, A('100'), A('1'));
      const alice = await openPosition(ALICE);
      const bob = await openPosition(BOB);
      await sql`
        INSERT INTO trade.futures_adl_pairs (
          pair_id, ordinal, bankrupt_position_id, bankrupt_user_id, candidate_position_id, candidate_user_id, asset_id,
          size, bankruptcy_price, bankrupt_margin_taken, bankrupt_initial_taken, candidate_margin_released,
          candidate_initial_released, candidate_release_sequence, candidate_profit, disclosure_event_id, state, applied_at
        ) VALUES (
          'pair-1', 1, ${alice.id}, ${ALICE}, ${bob.id}, ${BOB}, ${USDT}, '1', '91', '9', '10', '10', '10', 1, '9', 'ev-1', 'applied', now()
        )
      `;
      const aliceAdl = (await listFuturesExecutions(sql, ALICE, { limit: 50, kind: 'adl' })).executions;
      const bobAdl = (await listFuturesExecutions(sql, BOB, { limit: 50, kind: 'adl' })).executions;
      expect(aliceAdl).toEqual([
        expect.objectContaining({ kind: 'adl', side: 'sell', qty: '1', price: '91', realizedPnl: null, fee: null }),
      ]);
      expect(bobAdl).toEqual([expect.objectContaining({ kind: 'adl', side: 'buy', qty: '1', price: '91', realizedPnl: '9' })]);
    });
  });

  describe('the list query', () => {
    it('reads scope, label, origin and status, and refuses an unknown one rather than reading it as all', () => {
      expect(readListQuery({ scope: 'history', limit: '20', label: 'grid-7', origin: 'stop', status: 'cancelled' })).toEqual({
        ok: true,
        input: { scope: 'history', limit: 20, symbol: null, label: 'grid-7', origin: 'stop', status: 'cancelled', before: null },
      });
      expect(readListQuery({ scope: 'closed', limit: '20' })).toMatchObject({ ok: false, code: 'trade.futures_orders_scope_invalid' });
      expect(readListQuery({ scope: 'all' })).toMatchObject({ ok: false, code: 'trade.futures_orders_limit_unset' });
      expect(readListQuery({ scope: 'all', limit: '20', origin: 'house' })).toMatchObject({ ok: false, code: 'trade.invalid_filter' });
      expect(readListQuery({ scope: 'all', limit: '20', status: 'done' })).toMatchObject({ ok: false, code: 'trade.invalid_filter' });
      expect(readListQuery({ scope: 'all', limit: '20', label: 'no spaces' })).toMatchObject({
        ok: false,
        code: 'trade.order_label_invalid',
      });
    });
  });

  it('a label never changes what an order holds', async () => {
    const svc = build();
    const plain = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1') }));
    const tagged = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), orderLabel: 'x' }));
    expect(tagged.holdAmount).toBe(plain.holdAmount);
    expect((await ledger.balance(futuresOrderMarginAccount(ALICE, USDT, tagged.orderId))).amount).toBe(
      (await ledger.balance(futuresOrderMarginAccount(ALICE, USDT, plain.orderId))).amount,
    );
  });
});
