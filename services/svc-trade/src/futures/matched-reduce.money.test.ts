/**
 * Reduce-only futures orders through svc-matching (futures ADR slice 6b), against the real trade schema and MemoryLedger.
 *
 * A reduce fill closes part of a position at the fill price: its margin share goes back to the trader, a loss goes
 * into the clearing pot, a profit comes out of it (or is owed until the pot holds it). Every case is checked against
 * the ledger: the position collateral pots, the clearing pot, the available balances and the journal's keys. The
 * invariant suite runs mixed open and reduce fills and checks after every one that long size equals short size,
 * that each pot equals its row, and the clearing pot identity of ADR section 3.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryLedger,
  formatAmount,
  futuresLossSink,
  futuresOrderMarginAccount,
  parseAmount,
  positionCollateralAccount,
  recipes,
  userAvailable,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { EngineCancelResult, EngineSubmitRequest, EngineSubmitResult, MatchingClient } from '../spot/matching-client.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { MatchedFuturesOrders, type MatchedOrdersDeps, type PlaceMatchedOrderInput } from './matched-orders.js';
import { PositionService } from './position-service.js';
import { memoryMarkBook } from './mark-source.js';
import { orderHoldAmount } from './matched-order-plan.js';
import { unrealizedPnl } from './liquidation-planner.js';
import { runPayoutTick } from './futures-payouts.js';

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
      .withDatabase('intafaced_reduce_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`reduce-only futures orders need Postgres: TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
  }
}

const A = (s: string) => parseAmount(s);
const USDT = 'USDT';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const MARKET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SYMBOL = 'ETH/USDT-PERP';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const PROOF = { stub: true } as unknown as LifecycleAdmissionProof;
const POT = futuresLossSink(USDT);
const REDUCE_REASONS = new Set(['futures.profit.realized', 'futures.loss.realized', 'futures.margin.release']);

/** Engine that rests every order untouched; fills are delivered by the test with `settleFill`, as the event path does. */
class RestingEngine {
  readonly submits: EngineSubmitRequest[] = [];
  readonly cancels: string[] = [];
  private seq = 9000;

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

describe('svc-trade reduce-only matched futures orders (slice 6b, PG-backed)', () => {
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
  let mark: bigint;
  let admission: TradingAdmissionPort;
  let sequence: number;

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.futures_order_fills, trade.futures_orders, trade.positions, trade.markets, trade.futures_payouts, trade.futures_fill_waits,
               trade.account_position_modes, trade.liquidation_rungs, trade.futures_adl_pairs, trade.liquidation_attempts
      RESTART IDENTITY CASCADE
    `;
    await sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (
        ${MARKET}, ${SYMBOL}, 'ETH', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'ETH perpetual', now()
      )
    `;
    ledger = new MemoryLedger();
    engine = new RestingEngine();
    mark = A('100');
    sequence = 0;
    admission = { admit: vi.fn(async () => ({})) } as unknown as TradingAdmissionPort;
    for (const userId of [ALICE, BOB, CAROL]) {
      await ledger.post(
        recipes.deposit({ userId, assetId: USDT, amount: A('1000'), rail: 'test', railRef: `fund-${userId}-${randomUUID()}` }),
      );
    }
  });

  function build(overrides: Partial<MatchedOrdersDeps> = {}, ledgerImpl: LedgerClient = ledger): MatchedFuturesOrders {
    return new MatchedFuturesOrders({
      sql,
      ledger: ledgerImpl,
      matching: engine as unknown as MatchingClient,
      enabled: true,
      priceBand: A('0.05'),
      maxLeverage: A('10'),
      now: () => NOW,
      markFor: async () => mark,
      assertPositionIdle: async () => undefined,
      lifecycleProof: async () => PROOF,
      admission,
      ...overrides,
    });
  }

  function order(
    overrides: Partial<PlaceMatchedOrderInput> & Pick<PlaceMatchedOrderInput, 'userId' | 'side' | 'qty' | 'clientOrderId'>,
  ): PlaceMatchedOrderInput {
    const base = { symbol: SYMBOL, type: 'limit' as const, limitPrice: mark, leverage: A('10'), ...overrides };
    return base.type === 'market' && overrides.limitPrice === undefined ? { ...base, limitPrice: undefined } : base;
  }

  async function place(userId: string, side: 'buy' | 'sell', qty: bigint, extra: Partial<PlaceMatchedOrderInput> = {}) {
    return build().place(principal(userId), order({ userId, side, qty, clientOrderId: `c-${randomUUID()}`, ...extra }));
  }

  async function reduce(userId: string, side: 'buy' | 'sell', qty: bigint, extra: Partial<PlaceMatchedOrderInput> = {}) {
    return place(userId, side, qty, { reduceOnly: true, ...extra });
  }

  async function settle(maker: { orderId: string }, taker: { orderId: string }, price: bigint, qty: bigint, svc = build(), seq?: number) {
    const fill = {
      marketId: MARKET,
      makerOrderId: maker.orderId,
      takerOrderId: taker.orderId,
      price: formatAmount(price),
      qty: formatAmount(qty),
      sequence: seq ?? ++sequence,
    };
    await svc.settleFill(fill);
    return fill;
  }

  /** Alice long `qty` against Bob short `qty`, both at `price`. */
  async function aliceLongBobShort(qty = A('2'), price = A('100')) {
    const buy = await place(ALICE, 'buy', qty, { limitPrice: price });
    const sell = await place(BOB, 'sell', qty, { limitPrice: price });
    await settle(buy, sell, price, qty);
    return { alice: (await openOf(ALICE))[0]!, bob: (await openOf(BOB))[0]! };
  }

  async function openOf(userId: string) {
    return sql<{ id: string; side: 'long' | 'short'; size: string; entry_price: string; margin_current: string; status: string }[]>`
      SELECT id, side, size, entry_price, margin_current, status FROM trade.positions
       WHERE user_id = ${userId} AND market_id = ${MARKET} AND status = 'open' ORDER BY opened_at, id
    `;
  }

  async function positionRow(id: string) {
    const [row] = await sql<{ size: string; margin_current: string; margin_initial: string; status: string }[]>`
      SELECT size, margin_current, margin_initial, status FROM trade.positions WHERE id = ${id}
    `;
    return row!;
  }

  async function bal(ref: Parameters<LedgerClient['balance']>[0]): Promise<bigint> {
    return (await ledger.balance(ref)).amount;
  }

  function reducePosts(): string[] {
    return ledger
      .journal()
      .filter((t) => REDUCE_REASONS.has(t.reason))
      .map((t) => t.idempotencyKey);
  }

  async function payouts() {
    return sql<{ profit_id: string; amount: string; state: string }[]>`
      SELECT profit_id, amount, state FROM trade.futures_payouts ORDER BY created_at, profit_id
    `;
  }

  /**
   * The books agree: long size equals short size, each open position's collateral pot equals its margin row, each
   * order hold equals what it locked less what fills applied and releases returned, and no intent is left pending.
   */
  async function assertBooksAgree(): Promise<void> {
    const open = await sql<{ id: string; user_id: string; side: string; size: string; margin_current: string }[]>`
      SELECT id, user_id, side, size, margin_current FROM trade.positions WHERE market_id = ${MARKET} AND status = 'open'
    `;
    let long = 0n;
    let short = 0n;
    for (const p of open) {
      if (p.side === 'long') long += parseAmount(p.size);
      else short += parseAmount(p.size);
      expect(await bal(positionCollateralAccount(p.user_id, USDT, p.id)), `pot of ${p.id}`).toBe(parseAmount(p.margin_current));
    }
    expect(long, 'long size equals short size').toBe(short);
    const closed = await sql<{ id: string; user_id: string }[]>`
      SELECT id, user_id FROM trade.positions WHERE market_id = ${MARKET} AND status = 'closed'
    `;
    for (const p of closed) expect(await bal(positionCollateralAccount(p.user_id, USDT, p.id)), `closed pot ${p.id}`).toBe(0n);
    const orders = await sql<
      {
        id: string;
        user_id: string;
        side: 'buy' | 'sell';
        qty: string;
        limit_price: string;
        mark_price: string;
        leverage: string;
        applied_amount: string;
        released_amount: string;
        reduce_only: boolean;
      }[]
    >`SELECT * FROM trade.futures_orders WHERE market_id = ${MARKET}`;
    for (const o of orders) {
      const held = await bal(futuresOrderMarginAccount(o.user_id, USDT, o.id));
      const locked = o.reduce_only
        ? 0n
        : orderHoldAmount({
            side: o.side,
            qty: parseAmount(o.qty),
            limit: parseAmount(o.limit_price),
            mark: parseAmount(o.mark_price),
            leverage: parseAmount(o.leverage),
          });
      expect(held, `hold of ${o.id}`).toBe(locked - parseAmount(o.applied_amount) - parseAmount(o.released_amount));
    }
    expect(await sql`SELECT 1 FROM trade.futures_order_fills WHERE state = 'pending'`).toHaveLength(0);
  }

  /**
   * ADR section 3: with every position from a fill, the clearing pot equals the open positions' unrealised PnL at
   * any mark plus the profit still owed. Fill prices and sizes here are exact, so the only gap is rounding: a grown
   * position's weighted entry is floored (which moves a long's PnL up and a short's down by under a unit),
   * unrealised PnL is floored, and each realised loss is charged up and each realised profit credited down. So the
   * two sides may differ by at most two units (10^-18) per open position and one per reduce fill so far, and by
   * nothing more: a missing or doubled post moves the pot by a whole fill's PnL.
   */
  async function assertPotIdentity(at: bigint): Promise<void> {
    const open = await sql<{ side: 'long' | 'short'; size: string; entry_price: string }[]>`
      SELECT side, size, entry_price FROM trade.positions WHERE market_id = ${MARKET} AND status = 'open'
    `;
    let unrealized = 0n;
    for (const p of open) unrealized += unrealizedPnl(p.side, parseAmount(p.size), parseAmount(p.entry_price), at);
    const [owed] = await sql<
      { owed: string | null }[]
    >`SELECT sum(amount)::text AS owed FROM trade.futures_payouts WHERE state = 'pending'`;
    const [fills] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM trade.futures_order_fills WHERE kind = 'reduce'`;
    const gap = (await bal(POT)) - (unrealized + parseAmount(owed?.owed ?? '0'));
    const allowed = 2n * BigInt(open.length) + BigInt(fills?.n ?? '0');
    expect(gap >= -allowed && gap <= allowed, `clearing pot = Σ unrealised + owed (gap ${gap}, rounding allowed ${allowed})`).toBe(true);
  }

  describe('placement', () => {
    it('a reduce-only order locks nothing, names its position and its bankruptcy price, and is not the engine’s reduce-only', async () => {
      const { alice } = await aliceLongBobShort();
      const before = await bal(userAvailable(ALICE, USDT));
      const view = await reduce(ALICE, 'sell', A('1'), { limitPrice: A('99') });
      expect(view).toMatchObject({ reduceOnly: true, positionId: alice.id, bankruptcyPrice: '90', holdAmount: '0', status: 'open' });
      expect(await bal(userAvailable(ALICE, USDT))).toBe(before);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, view.orderId))).toBe(0n);
      expect(engine.submits.at(-1)!.reduceOnly).toBe(false);
      await assertBooksAgree();
    });

    it('a reduce-only order is never gated, so a lapsed acceptance cannot trap a position; an opening order still is', async () => {
      const { alice } = await aliceLongBobShort();
      const gate = vi.fn(async () => {
        throw Object.assign(new Error('agreement required'), { code: 'trade.agreement_required', status: 403 });
      });
      const svc = build({ assertDerivativesAccess: gate });
      const view = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'sell', qty: A('1'), reduceOnly: true, clientOrderId: 'lapsed-reduce' }),
      );
      expect(view).toMatchObject({ reduceOnly: true, positionId: alice.id, status: 'open' });
      expect(gate).not.toHaveBeenCalled();
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'lapsed-open' })),
      ).rejects.toMatchObject({ code: 'trade.agreement_required' });
      expect(gate).toHaveBeenCalledTimes(1);
    });

    it('needs an open position on the other side', async () => {
      await aliceLongBobShort();
      await expect(reduce(ALICE, 'buy', A('1'))).rejects.toMatchObject({ code: 'trade.futures_reduce_only_no_position' });
      await expect(reduce(CAROL, 'sell', A('1'))).rejects.toMatchObject({ code: 'trade.futures_reduce_only_no_position' });
    });

    it('may not ask for more than the position less its other live reduce-only orders', async () => {
      await aliceLongBobShort();
      await expect(reduce(ALICE, 'sell', A('2.0001'))).rejects.toMatchObject({ code: 'trade.futures_reduce_only_exceeds_position' });
      await reduce(ALICE, 'sell', A('1.5'));
      await expect(reduce(ALICE, 'sell', A('1'))).rejects.toMatchObject({ code: 'trade.futures_reduce_only_exceeds_position' });
      const fits = await reduce(ALICE, 'sell', A('0.5'));
      expect(fits.status).toBe('open');
    });

    it('a limit past the bankruptcy price refuses; a market reduce gets that price as its limit', async () => {
      await aliceLongBobShort();
      // Alice is long 2 at 100 with 20 margin: bankrupt at 90. Mark 93, band 88.35 to 97.65.
      mark = A('93');
      await expect(reduce(ALICE, 'sell', A('1'), { limitPrice: A('89.99') })).rejects.toMatchObject({
        code: 'trade.futures_reduce_past_bankruptcy',
      });
      expect((await reduce(ALICE, 'sell', A('0.5'), { limitPrice: A('90') })).limitPrice).toBe('90');
      const market = await reduce(ALICE, 'sell', A('0.5'), { type: 'market' });
      expect(market.limitPrice).toBe('90');
      expect(engine.submits.at(-1)).toMatchObject({ price: '90', tif: 'IOC' });
      // Bob is short 2 at 100, bankrupt at 110. Mark 107, band 101.65 to 112.35: his market buy stops at 110.
      mark = A('107');
      expect((await reduce(BOB, 'buy', A('1'), { type: 'market' })).limitPrice).toBe('110');
      // Inside the band, the band edge is nearer than the bound and is kept.
      mark = A('100');
      expect((await reduce(BOB, 'buy', A('1'), { type: 'market' })).limitPrice).toBe('105');
    });

    it('a market reduce whose bankruptcy price is beyond the whole band refuses: nothing valid remains', async () => {
      await aliceLongBobShort();
      mark = A('80');
      await expect(reduce(ALICE, 'sell', A('1'), { type: 'market' })).rejects.toMatchObject({
        code: 'trade.futures_reduce_bankruptcy_outside_band',
      });
      expect(await sql`SELECT 1 FROM trade.futures_orders WHERE reduce_only`).toHaveLength(0);
    });

    it('in one-way mode an opening order against an open position or a live opening order refuses; hedge mode allows it', async () => {
      await aliceLongBobShort();
      await expect(place(ALICE, 'sell', A('1'))).rejects.toMatchObject({ code: 'trade.futures_one_way_flip_refused' });
      await place(CAROL, 'buy', A('1'));
      await expect(place(CAROL, 'sell', A('1'))).rejects.toMatchObject({ code: 'trade.futures_one_way_flip_refused' });
      // Growing the same side and reducing stay allowed.
      await place(ALICE, 'buy', A('1'));
      await reduce(ALICE, 'sell', A('1'));
      await sql`INSERT INTO trade.account_position_modes (user_id, mode, source, client_mode_id) VALUES (${ALICE}, 'hedge', 'test', 'h')`;
      expect((await place(ALICE, 'sell', A('1'))).status).toBe('open');
    });
  });

  describe('reduce fills', () => {
    it('at a profit with the pot covering it: the loser pays in first, the winner is paid, both keep half', async () => {
      const { alice, bob } = await aliceLongBobShort();
      mark = A('102');
      const aR = await reduce(ALICE, 'sell', A('1'), { limitPrice: A('102') });
      const bR = await reduce(BOB, 'buy', A('1'), { limitPrice: A('102') });
      // Bob is the taker, so his side settles first and his loss is in the pot before Alice's profit leaves it.
      const fill = await settle(aR, bR, A('102'), A('1'));

      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('10') + A('2'));
      expect(await bal(userAvailable(BOB, USDT))).toBe(A('1000') - A('20') + A('8'));
      expect(await bal(POT)).toBe(0n);
      expect(await positionRow(alice.id)).toMatchObject({ status: 'open' });
      expect(parseAmount((await positionRow(alice.id)).size)).toBe(A('1'));
      expect(parseAmount((await positionRow(bob.id)).margin_current)).toBe(A('10'));
      expect((await payouts()).map((p) => p.state)).toEqual(['paid']);
      await assertBooksAgree();
      await assertPotIdentity(mark);

      // Replayed, it posts nothing and moves nothing.
      const posted = reducePosts();
      await build().settleFill(fill);
      await build().settleFill(fill);
      expect(reducePosts()).toEqual(posted);
      expect(parseAmount((await positionRow(alice.id)).size)).toBe(A('1'));
      await assertBooksAgree();
    });

    it('at a profit with the pot short: the position still shrinks, the profit is owed, and the payout tick pays it once', async () => {
      const { alice } = await aliceLongBobShort();
      mark = A('102');
      const aR = await reduce(ALICE, 'sell', A('1'), { limitPrice: A('102') });
      const bR = await reduce(BOB, 'buy', A('1'), { limitPrice: A('102') });
      // Alice is the taker: her profit is asked of the pot before Bob's loss is in it.
      const svc = build();
      await settle(bR, aR, A('102'), A('1'), svc);
      expect(parseAmount((await positionRow(alice.id)).size)).toBe(A('1'));
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('10'));
      const [owed] = await payouts();
      expect(owed).toMatchObject({ state: 'pending', profit_id: expect.stringMatching(/^fill:.*:profit$/) });
      expect(parseAmount(owed!.amount)).toBe(A('2'));
      expect(await bal(POT)).toBe(A('2'));
      await assertBooksAgree();
      await assertPotIdentity(mark);

      const tick = await runPayoutTick({ sql, ledger });
      expect(tick.paid).toEqual([owed!.profit_id]);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('10') + A('2'));
      expect(await bal(POT)).toBe(0n);
      expect((await runPayoutTick({ sql, ledger })).paid).toEqual([]);
      expect(reducePosts().filter((k) => k.startsWith('futures.profit:'))).toHaveLength(1);
      await assertPotIdentity(mark);
    });

    it('at a loss, against a trader who opens: the loss goes into the pot and long still equals short', async () => {
      const { alice } = await aliceLongBobShort();
      mark = A('98');
      const aR = await reduce(ALICE, 'sell', A('1'), { limitPrice: A('98') });
      const carol = await place(CAROL, 'buy', A('1'), { limitPrice: A('98') });
      const fill = await settle(aR, carol, A('98'), A('1'));
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('8'));
      expect(await bal(POT)).toBe(A('2'));
      expect(parseAmount((await positionRow(alice.id)).margin_current)).toBe(A('10'));
      const [carolPos] = await openOf(CAROL);
      expect(parseAmount(carolPos!.size)).toBe(A('1'));
      await assertBooksAgree();
      await assertPotIdentity(mark);
      const [intent] = await sql<{ realized_pnl: string; loss_from_margin: string; margin_release: string; kind: string }[]>`
        SELECT kind, realized_pnl, loss_from_margin, margin_release FROM trade.futures_order_fills WHERE order_id = ${aR.orderId}
      `;
      expect(intent).toMatchObject({ kind: 'reduce' });
      expect(parseAmount(intent!.realized_pnl)).toBe(-A('2'));
      expect(parseAmount(intent!.loss_from_margin)).toBe(A('2'));
      expect(parseAmount(intent!.margin_release)).toBe(A('8'));

      const posted = reducePosts();
      await build().settleFill(fill);
      expect(reducePosts()).toEqual(posted);
    });

    it('a partial reduce then the rest: the row closes, every pot is empty, and every unit of margin is back', async () => {
      const { alice, bob } = await aliceLongBobShort();
      const aR = await reduce(ALICE, 'sell', A('2'));
      const bR = await reduce(BOB, 'buy', A('2'));
      const first = await settle(aR, bR, A('100'), A('0.5'));
      expect(parseAmount((await positionRow(alice.id)).size)).toBe(A('1.5'));
      expect(
        (
          await build()
            .place(principal(ALICE), order({ userId: ALICE, side: 'sell', qty: A('2'), clientOrderId: 'x' }))
            .catch((e) => e)
        ).code,
      ).toBe('trade.futures_one_way_flip_refused');
      await assertBooksAgree();
      const second = await settle(aR, bR, A('100'), A('1.5'));
      expect((await positionRow(alice.id)).status).toBe('closed');
      expect((await positionRow(bob.id)).status).toBe('closed');
      expect(await bal(positionCollateralAccount(ALICE, USDT, alice.id))).toBe(0n);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
      expect(await bal(userAvailable(BOB, USDT))).toBe(A('1000'));
      expect(
        await sql`SELECT status FROM trade.futures_orders WHERE id IN (${aR.orderId}, ${bR.orderId}) AND status = 'filled'`,
      ).toHaveLength(2);
      await assertBooksAgree();
      await assertPotIdentity(mark);

      const posted = reducePosts();
      await build().settleFill(first);
      await build().settleFill(second);
      expect(reducePosts()).toEqual(posted);
      expect((await positionRow(alice.id)).status).toBe('closed');
    });

    describe('a crash after each post: the retry finishes with one post per key', () => {
      it.each([
        ['the loss', 'futures.loss.realized', 'after'],
        ['the profit', 'futures.profit.realized', 'after'],
        ['the release', 'futures.margin.release', 'after'],
        ['the loss, before it reaches the ledger', 'futures.loss.realized', 'before'],
      ] as const)('%s', async (_name, reason, when) => {
        const { alice, bob } = await aliceLongBobShort();
        mark = A('102');
        const aR = await reduce(ALICE, 'sell', A('1'), { limitPrice: A('102') });
        const bR = await reduce(BOB, 'buy', A('1'), { limitPrice: A('102') });
        let crashed = false;
        const crashing = {
          ...ledger,
          post: async (request: PostRequest) => {
            if (!crashed && request.reason === reason && when === 'before') {
              crashed = true;
              throw new Error('ledger unreachable');
            }
            const tx = await ledger.post(request);
            if (!crashed && request.reason === reason) {
              crashed = true;
              throw new Error('simulated crash after the post');
            }
            return tx;
          },
          balance: (ref: Parameters<LedgerClient['balance']>[0]) => ledger.balance(ref),
        } as LedgerClient;
        const fill = {
          marketId: MARKET,
          makerOrderId: aR.orderId,
          takerOrderId: bR.orderId,
          price: '102',
          qty: '1',
          sequence: 777,
        };
        await expect(build({}, crashing).settleFill(fill)).rejects.toThrow();
        expect(await sql`SELECT 1 FROM trade.futures_order_fills WHERE state = 'pending'`).toHaveLength(1);
        // The position has not moved while its intent is pending, whatever has already posted.
        expect(parseAmount((await positionRow(reason === 'futures.profit.realized' ? alice.id : bob.id)).size)).toBe(A('2'));

        await build().settleFill(fill);
        const keys = reducePosts();
        expect(new Set(keys).size).toBe(keys.length);
        // Bob's loss, Alice's profit, and both margin shares: four posts, one per key.
        expect(keys).toHaveLength(4);
        expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('10') + A('2'));
        expect(await bal(userAvailable(BOB, USDT))).toBe(A('1000') - A('20') + A('8'));
        expect((await payouts()).map((p) => p.state)).toEqual(['paid']);
        await assertBooksAgree();
        await assertPotIdentity(mark);
      });
    });
  });

  it('a process that dies right after the intent commits has already recorded the profit as owed', async () => {
    await aliceLongBobShort();
    mark = A('102');
    const aR = await reduce(ALICE, 'sell', A('1'), { limitPrice: A('102') });
    const bR = await reduce(BOB, 'buy', A('1'), { limitPrice: A('102') });
    // Alice (the winner) is the taker, so her intent is the first transaction; the process dies as it commits.
    const original = sql.begin.bind(sql);
    let calls = 0;
    const spy = vi.spyOn(sql, 'begin').mockImplementation(((fn: never) => {
      calls += 1;
      if (calls === 1) {
        return original(fn).then(() => {
          throw new Error('process died after the intent');
        });
      }
      return original(fn);
    }) as never);
    const fill = { marketId: MARKET, makerOrderId: bR.orderId, takerOrderId: aR.orderId, price: '102', qty: '1', sequence: 900 };
    try {
      await expect(build().settleFill(fill)).rejects.toThrow('process died after the intent');
    } finally {
      spy.mockRestore();
    }
    // Nothing has posted, and the profit is already owed: the intent and the payout row committed together.
    expect(reducePosts()).toEqual([]);
    const [owed] = await payouts();
    expect(owed).toMatchObject({ state: 'pending' });
    expect(parseAmount(owed!.amount)).toBe(A('2'));

    // The redelivered fill finishes both sides; the profit is paid once, by whichever gets there first.
    await build().settleFill(fill);
    await runPayoutTick({ sql, ledger });
    expect(reducePosts().filter((k) => k.startsWith('futures.profit:'))).toHaveLength(1);
    expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('10') + A('2'));
    expect((await payouts()).map((p) => p.state)).toEqual(['paid']);
    await assertBooksAgree();
  });

  describe('busy positions and pending fills cover reduce fills', () => {
    async function aliceReducingAgainstCarol() {
      const { alice } = await aliceLongBobShort();
      const aR = await reduce(ALICE, 'sell', A('1'));
      const carol = await place(CAROL, 'buy', A('1'));
      return { alice, aR, carol };
    }

    it('a live liquidation rung on the position refuses the reduce fill with 409, whole', async () => {
      const { alice, aR, carol } = await aliceReducingAgainstCarol();
      const plan = { recipes: [], reason: 'closing', fromInsurance: '0', marginAsset: USDT };
      await sql`
        INSERT INTO trade.liquidation_rungs (rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state)
        VALUES (${randomUUID()}, ${alice.id}, ${`liq:${alice.id}`}, 'closing', '2', '20', ${sql.json(plan as never)}, 'planned')
      `;
      await expect(settle(aR, carol, A('100'), A('1'))).rejects.toMatchObject({ code: 'trade.liquidation_in_progress', status: 409 });
      expect(await sql`SELECT 1 FROM trade.futures_order_fills WHERE order_id IN (${aR.orderId}, ${carol.orderId})`).toHaveLength(0);
      expect(reducePosts()).toEqual([]);
    });

    it('a margin adjustment in flight refuses the reduce fill with 409; the fill waits and settles once it finishes', async () => {
      const { alice, aR, carol } = await aliceReducingAgainstCarol();
      await sql`UPDATE trade.positions SET margin_adjust_request = 'adj-1' WHERE id = ${alice.id}`;
      await expect(settle(aR, carol, A('100'), A('1'))).rejects.toMatchObject({
        code: 'trade.margin_adjustment_in_progress',
        status: 409,
      });
      expect(reducePosts()).toEqual([]);

      const svc = build();
      const fill = {
        marketId: MARKET,
        makerOrderId: aR.orderId,
        takerOrderId: carol.orderId,
        price: '100',
        qty: '1',
        sequence: ++sequence,
      };
      expect(await svc.settleFillOrWait(fill)).toBe('waiting');
      expect(await svc.retryWaitingFills(50)).toEqual({ settled: 0, waiting: 1, failed: [] });
      await sql`UPDATE trade.positions SET margin_adjust_request = NULL WHERE id = ${alice.id}`;
      expect(await svc.retryWaitingFills(50)).toEqual({ settled: 1, waiting: 0, failed: [] });
      expect(parseAmount((await positionRow(alice.id)).size)).toBe(A('1'));
      await assertBooksAgree();
    });

    it('an opening fill still being recorded on the position holds the reduce fill, and a pending reduce holds the rest', async () => {
      const { alice, aR, carol } = await aliceReducingAgainstCarol();
      // Alice grows the position; that fill's apply post crashes, so its intent stays pending.
      const grow = await place(ALICE, 'buy', A('1'));
      const bobSell = await place(BOB, 'sell', A('1'));
      const failing = {
        ...ledger,
        post: async (request: PostRequest) => {
          if (request.reason === 'futures.order.margin.applied') throw new Error('crash after intent');
          return ledger.post(request);
        },
        balance: (ref: Parameters<LedgerClient['balance']>[0]) => ledger.balance(ref),
      } as LedgerClient;
      // Alice's order is the taker, so her side records first and is the one left pending.
      const growFill = {
        marketId: MARKET,
        makerOrderId: bobSell.orderId,
        takerOrderId: grow.orderId,
        price: '100',
        qty: '1',
        sequence: 50,
      };
      await expect(build({}, failing).settleFill(growFill)).rejects.toThrow('crash after intent');
      await expect(settle(aR, carol, A('100'), A('1'))).rejects.toMatchObject({ code: 'trade.futures_fill_in_progress', status: 409 });
      // Refused whole: Carol's side did not open a position while Alice's waits.
      expect(await openOf(CAROL)).toHaveLength(0);
      await build().settleFill(growFill);

      // Now a reduce intent crashes before its first post and stays pending: an opening fill on the same
      // position, and the position service's own changes, wait for it.
      const throwing = {
        ...ledger,
        post: async (request: PostRequest) => {
          if (REDUCE_REASONS.has(request.reason)) throw new Error('ledger unreachable');
          return ledger.post(request);
        },
        balance: (ref: Parameters<LedgerClient['balance']>[0]) => ledger.balance(ref),
      } as LedgerClient;
      const reduceFill = { marketId: MARKET, makerOrderId: aR.orderId, takerOrderId: carol.orderId, price: '100', qty: '1', sequence: 51 };
      await expect(build({}, throwing).settleFill(reduceFill)).rejects.toThrow('ledger unreachable');
      const pending = await sql<{ kind: string }[]>`SELECT kind FROM trade.futures_order_fills WHERE state = 'pending'`;
      expect(pending.map((p) => p.kind)).toEqual(['reduce']);

      const grow2 = await place(ALICE, 'buy', A('1'));
      const bobSell2 = await place(BOB, 'sell', A('1'));
      await expect(settle(grow2, bobSell2, A('100'), A('1'))).rejects.toMatchObject({
        code: 'trade.futures_fill_in_progress',
        status: 409,
      });
      const positions = new PositionService(sql, ledger, {
        marks: memoryMarkBook().source(),
        profitSource: null,
        maxLeverage: A('10'),
        now: () => NOW,
      });
      await expect(positions.close(ALICE, alice.id)).rejects.toMatchObject({ code: 'trade.futures_fill_in_progress', status: 409 });

      await build().settleFill(reduceFill);
      await settle(grow2, bobSell2, A('100'), A('1'));
      expect(parseAmount((await positionRow(alice.id)).size)).toBe(A('3'));
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('a reduce fill on a position that is no longer open refuses whole, for an operator', async () => {
      const { alice, aR, carol } = await aliceReducingAgainstCarol();
      await sql`UPDATE trade.positions SET status = 'liquidated' WHERE id = ${alice.id}`;
      await expect(settle(aR, carol, A('100'), A('1'))).rejects.toMatchObject({ code: 'trade.futures_reduce_fill_unmatched', status: 500 });
      expect(await sql`SELECT 1 FROM trade.futures_order_fills WHERE order_id IN (${aR.orderId}, ${carol.orderId})`).toHaveLength(0);
    });
  });

  describe('resting reduce orders follow the margin', () => {
    it('a fill that grows the position takes a resting reduce order past the new bankruptcy price off the book', async () => {
      await aliceLongBobShort(A('1'));
      // Long 1 at 100 with 10 margin: bankrupt at 90. A reduce rests right there.
      mark = A('95');
      const rest = await reduce(ALICE, 'sell', A('1'), { limitPrice: A('90.5') });
      // Alice grows by 1 at 104 with the mark at 104: entry 102, margin 20.4, bankrupt at 91.8.
      mark = A('104');
      const grow = await place(ALICE, 'buy', A('1'), { limitPrice: A('104') });
      const carol = await place(CAROL, 'sell', A('1'), { limitPrice: A('104') });
      await settle(grow, carol, A('104'), A('1'));
      expect(engine.cancels).toContain(rest.orderId);
      const [row] = await sql<{ status: string; refusal_code: string }[]>`
        SELECT status, refusal_code FROM trade.futures_orders WHERE id = ${rest.orderId}
      `;
      expect(row).toEqual({ status: 'cancelled', refusal_code: 'trade.futures_reduce_past_bankruptcy' });
      await assertBooksAgree();
    });

    it('the sweep takes off reduce orders past the bound after funding, and those whose position has gone', async () => {
      const { alice, bob } = await aliceLongBobShort();
      const atBound = await reduce(ALICE, 'sell', A('1'), { limitPrice: A('99') });
      mark = A('93');
      const deep = await reduce(ALICE, 'sell', A('1'), { limitPrice: A('90') });
      const bobs = await reduce(BOB, 'buy', A('1'), { limitPrice: A('97') });
      // Alice pays 5 of funding to Bob: margin 15, bankrupt at 92.5. Her order at 90 is now past it.
      await ledger.post(
        recipes.futuresFundingPay({
          fundingId: 'f-1',
          payerUserId: ALICE,
          payerPositionId: alice.id,
          payeeUserId: BOB,
          payeePositionId: bob.id,
          assetId: USDT,
          amount: A('5'),
        }),
      );
      await sql`UPDATE trade.positions SET margin_current = '15' WHERE id = ${alice.id}`;
      mark = A('100');
      const sweep = await build().cancelOutsideBand();
      expect(sweep.cancelled).toEqual([deep.orderId]);
      expect((await sql<{ status: string }[]>`SELECT status FROM trade.futures_orders WHERE id = ${atBound.orderId}`)[0]!.status).toBe(
        'open',
      );

      // Bob's position goes some other way (a rung, here by hand): his resting reduce comes off too.
      await sql`UPDATE trade.positions SET status = 'liquidated' WHERE id = ${bob.id}`;
      const again = await build().cancelOutsideBand();
      expect(again.cancelled).toEqual([bobs.orderId]);
      const [code] = await sql<{ refusal_code: string }[]>`SELECT refusal_code FROM trade.futures_orders WHERE id = ${bobs.orderId}`;
      expect(code!.refusal_code).toBe('trade.futures_reduce_only_no_position');
    });
  });

  describe('the at-mark close is retired while matching is on', () => {
    it('close, partial close, close-all and a reduce-only open all refuse; nothing moves', async () => {
      const { alice } = await aliceLongBobShort();
      const positions = new PositionService(sql, ledger, {
        marks: memoryMarkBook().source(),
        profitSource: null,
        maxLeverage: A('10'),
        now: () => NOW,
        matchedOrders: { matching: null, enabled: true, priceBand: A('0.05'), lifecycleProof: null },
      });
      const retired = { code: 'trade.futures_close_at_mark_retired', status: 409 };
      await expect(positions.close(ALICE, alice.id)).rejects.toMatchObject(retired);
      await expect(positions.closeQuantity(ALICE, alice.id, { quantity: A('1'), clientCloseId: 'cq' })).rejects.toMatchObject(retired);
      await expect(positions.closeAll(ALICE, { clientBatchId: 'all' })).rejects.toMatchObject(retired);
      await expect(
        positions.open({
          userId: ALICE,
          symbol: SYMBOL,
          side: 'short',
          size: A('1'),
          leverage: A('10'),
          clientOpenId: 'ro',
          reduceOnly: true,
        } as never),
      ).rejects.toMatchObject(retired);
      expect(await sql`SELECT 1 FROM trade.position_close_batches WHERE client_batch_id = 'all'`).toHaveLength(0);
      expect((await positionRow(alice.id)).status).toBe('open');
      expect(await bal(positionCollateralAccount(ALICE, USDT, alice.id))).toBe(A('20'));
      expect(reducePosts()).toEqual([]);
    });
  });

  describe('invariants', () => {
    it('after every fill of a mixed open and reduce sequence: long equals short, every pot equals its row, and the clearing pot identity holds', async () => {
      const users = [ALICE, BOB, CAROL];
      for (const u of users) {
        await ledger.post(
          recipes.deposit({ userId: u, assetId: USDT, amount: A('100000'), rail: 'test', railRef: `top-${u}-${randomUUID()}` }),
        );
      }
      let seed = 4242;
      const next = (max: number) => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed % max;
      };
      let reduces = 0;
      let opens = 0;
      for (let step = 0; step < 60; step++) {
        mark = A('100') + BigInt(next(13) - 6) * A('0.5');
        const buyer = users[next(3)]!;
        const seller = users[next(3)]!;
        if (buyer === seller) continue;
        const price = mark + BigInt(next(5) - 2) * A('0.5');
        const plans: Array<{ userId: string; side: 'buy' | 'sell'; reduceOnly: boolean; cap: bigint }> = [];
        for (const [userId, side] of [
          [buyer, 'buy'],
          [seller, 'sell'],
        ] as const) {
          const [opposite] = await sql<{ size: string }[]>`
            SELECT size FROM trade.positions WHERE user_id = ${userId} AND market_id = ${MARKET} AND status = 'open'
              AND side = ${side === 'buy' ? 'short' : 'long'}
          `;
          plans.push({ userId, side, reduceOnly: !!opposite, cap: opposite ? parseAmount(opposite.size) : A('2') });
        }
        const qty = [A('0.5'), A('1'), A('1.5')][next(3)]!;
        const take = plans.reduce((q, p) => (p.cap < q ? p.cap : q), qty);
        const placed: { orderId: string }[] = [];
        let refused = false;
        for (const p of plans) {
          try {
            placed.push(await place(p.userId, p.side, take, { limitPrice: price, reduceOnly: p.reduceOnly }));
          } catch (err) {
            // A reduce past its bankruptcy price is refused at placement, as it must be; the step is skipped.
            expect((err as { code?: string }).code).toBe('trade.futures_reduce_past_bankruptcy');
            refused = true;
          }
        }
        if (refused) {
          for (const o of placed)
            await build().cancel(
              principal((await sql<{ user_id: string }[]>`SELECT user_id FROM trade.futures_orders WHERE id = ${o.orderId}`)[0]!.user_id),
              o.orderId,
            );
          continue;
        }
        if (plans.some((p) => p.reduceOnly)) reduces += 1;
        else opens += 1;
        await settle(placed[0]!, placed[1]!, price, take);
        await assertBooksAgree();
        await assertPotIdentity(mark);
      }
      await runPayoutTick({ sql, ledger });
      await assertPotIdentity(mark);
      expect(reduces).toBeGreaterThan(5);
      expect(opens).toBeGreaterThan(5);
      expect(ledger.reconcile()).toEqual({ ok: true });
    });
  });
});
