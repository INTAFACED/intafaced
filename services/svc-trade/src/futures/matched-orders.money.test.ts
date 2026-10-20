/**
 * Futures orders through svc-matching (futures ADR slice 6), against real trade schema and MemoryLedger.
 *
 * Every money step is checked against the ledger, not against the row alone: the hold account, the position
 * collateral pots and the available balances move by exactly the amounts the planner computes. The invariant
 * suite at the end runs many fills between many accounts and asserts the books agree after every one.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InsufficientFundsError,
  MemoryLedger,
  formatAmount,
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
import { matchedOrderIdFor } from './ids.js';
import { orderHoldAmount, marginNeed } from './matched-order-plan.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const PG_IMAGE = 'postgres:16-alpine';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(PG_IMAGE)
      .withDatabase('intafaced_matched_test')
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
    throw new Error(`matched futures orders need Postgres: TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
  }
}

const A = (s: string) => parseAmount(s);
const USDT = 'USDT';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const MARKET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SYMBOL = 'BTC/USDT-PERP';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const PROOF = { stub: true } as unknown as LifecycleAdmissionProof;

/** Scripted engine: each submit takes the next scripted answer, or rests the order untouched. */
class FakeEngine {
  readonly submits: EngineSubmitRequest[] = [];
  readonly script: Array<EngineSubmitResult | Error> = [];
  readonly cancels: string[] = [];
  /** What the engine would say is left of each order when it is cancelled. A test that fills an order sets it. */
  readonly remaining = new Map<string, string>();
  private seq = 1000;

  async submit(_marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    this.submits.push(request);
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    this.remaining.set(request.orderId, request.qty);
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
    const cancellation = {
      orderId,
      accountId: 'fake',
      remainingQty: this.remaining.get(orderId) ?? '0',
      sequence: this.seq,
      reason: 'cancel',
    };
    return { cancelled: true, orderId, sequence: this.seq, cancellation };
  }
}

const principal = (userId: string) => ({ userId, scopes: [] }) as unknown as Principal;

describe('svc-trade matched futures orders (slice 6, PG-backed)', () => {
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
  let engine: FakeEngine;
  let mark: bigint;
  let admission: TradingAdmissionPort;

  beforeEach(async () => {
    await sql`TRUNCATE trade.futures_order_fills, trade.futures_orders, trade.positions, trade.markets, trade.futures_payouts RESTART IDENTITY CASCADE`;
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
    const base = { symbol: SYMBOL, type: 'limit' as const, limitPrice: A('100'), leverage: A('10'), ...overrides };
    // A market order carries no limit price: the band edge is its price. The helper must not add one.
    return base.type === 'market' && overrides.limitPrice === undefined ? { ...base, limitPrice: undefined } : base;
  }

  async function orderRow(orderId: string) {
    const [row] = await sql<
      {
        status: string;
        filled_qty: string;
        applied_amount: string;
        released_amount: string;
        refusal_code: string | null;
      }[]
    >`
      SELECT status, filled_qty, applied_amount, released_amount, refusal_code FROM trade.futures_orders WHERE id = ${orderId}
    `;
    return row!;
  }

  async function positionsOf(userId: string) {
    return sql<
      { id: string; side: string; size: string; entry_price: string; margin_current: string; margin_initial: string; status: string }[]
    >`
      SELECT id, side, size, entry_price, margin_current, margin_initial, status FROM trade.positions
       WHERE user_id = ${userId} AND market_id = ${MARKET} ORDER BY opened_at, id
    `;
  }

  async function bal(ref: Parameters<LedgerClient['balance']>[0]): Promise<bigint> {
    return (await ledger.balance(ref)).amount;
  }

  /**
   * The books agree. Long size equals short size in the market; each position's collateral pot equals its row's
   * margin; each order's hold equals what it locked less what fills applied and releases returned.
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
      const pot = await bal(positionCollateralAccount(p.user_id, USDT, p.id));
      expect(pot, `collateral pot of ${p.id} equals its margin row`).toBe(parseAmount(p.margin_current));
    }
    expect(long, 'long size equals short size in the market').toBe(short);

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
      }[]
    >`
      SELECT id, user_id, side, qty, limit_price, mark_price, leverage, applied_amount, released_amount
        FROM trade.futures_orders WHERE market_id = ${MARKET}
    `;
    for (const o of orders) {
      const held = await bal(futuresOrderMarginAccount(o.user_id, USDT, o.id));
      // The hold an order locked is a function of its terms; nothing stores it as a figure.
      const locked = orderHoldAmount({
        side: o.side,
        qty: parseAmount(o.qty),
        limit: parseAmount(o.limit_price),
        mark: parseAmount(o.mark_price),
        leverage: parseAmount(o.leverage),
      });
      expect(held, `hold of ${o.id} is what it locked less applied and released`).toBe(
        locked - parseAmount(o.applied_amount) - parseAmount(o.released_amount),
      );
    }
  }

  describe('refusals before anything is locked', () => {
    it('the switch off refuses a new order and touches no ledger and no engine', async () => {
      const svc = build({ enabled: false });
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'off-1' })),
      ).rejects.toMatchObject({ code: 'trade.futures_matching_disabled' });
      expect(engine.submits).toHaveLength(0);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
    });

    it('an unset price band refuses with the typed code and invents no band', async () => {
      const svc = build({ priceBand: null });
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'band-unset' })),
      ).rejects.toMatchObject({ code: 'trade.futures_price_band_unset' });
      expect(engine.submits).toHaveLength(0);
    });

    it('a limit outside the band around the mark refuses before any hold', async () => {
      const svc = build();
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), limitPrice: A('106'), clientOrderId: 'far' })),
      ).rejects.toMatchObject({ code: 'trade.futures_price_outside_band' });
      expect(engine.submits).toHaveLength(0);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
    });

    it('a reduce-only order is refused in this phase, with the slice that builds it named', async () => {
      const svc = build();
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'sell', qty: A('1'), reduceOnly: true, clientOrderId: 'ro' })),
      ).rejects.toMatchObject({ code: 'trade.futures_reduce_only_unsupported' });
      expect(engine.submits).toHaveLength(0);
    });

    it('a market order that names a limit price is refused: the band edge is its only price', async () => {
      const svc = build();
      await expect(
        svc.place(
          principal(ALICE),
          order({ userId: ALICE, side: 'buy', qty: A('1'), type: 'market', limitPrice: A('100'), clientOrderId: 'mk-px' }),
        ),
      ).rejects.toMatchObject({ code: 'trade.limit_price_on_market_order' });
    });

    it('a leverage with more than two decimals is refused: the row stores two', async () => {
      const svc = build();
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), leverage: A('10.005'), clientOrderId: 'lev-dp' })),
      ).rejects.toMatchObject({ code: 'trade.leverage_invalid' });
    });

    it('an unset leverage cap refuses; nothing is invented', async () => {
      const svc = build({ maxLeverage: null });
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'cap-unset' })),
      ).rejects.toMatchObject({ code: 'trade.leverage_cap_unset' });
    });

    it('the derivatives gate refuses a new order before anything is locked, with the caller tier and region', async () => {
      const gate = vi.fn(async () => {
        throw Object.assign(new Error('agreement required'), { code: 'trade.agreement_required' });
      });
      const svc = build({ assertDerivativesAccess: gate });
      await expect(
        svc.place(
          { ...principal(ALICE), tier: 'full' } as Principal,
          order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'gated' }),
          {
            region: 'DE',
          },
        ),
      ).rejects.toMatchObject({ code: 'trade.agreement_required' });
      expect(gate).toHaveBeenCalledWith({ userId: ALICE, tier: 'full', region: 'DE' });
      expect(engine.submits).toHaveLength(0);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
    });

    it('a retry of an order that was already accepted is not gated again', async () => {
      const input = order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'gate-replay' });
      const first = await build().place(principal(ALICE), input);
      // A new agreement version is published after the order was accepted: the retry still returns the order.
      const gate = vi.fn(async () => {
        throw Object.assign(new Error('agreement required'), { code: 'trade.agreement_required' });
      });
      const again = await build({ assertDerivativesAccess: gate }).place(principal(ALICE), input);
      expect(again.orderId).toBe(first.orderId);
      expect(gate).not.toHaveBeenCalled();
      expect(engine.submits).toHaveLength(1);
    });

    it('a caller cannot place an order for another account', async () => {
      const svc = build();
      await expect(
        svc.place(principal(BOB), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'other' })),
      ).rejects.toMatchObject({ code: 'auth.credential_denied' });
    });

    it('an order whose hold the available balance cannot cover is refused, and never submitted', async () => {
      await ledger.post(recipes.futuresOrderMarginHold({ orderId: 'drain', userId: CAROL, assetId: USDT, amount: A('999') }));
      const svc = build();
      await expect(
        svc.place(principal(CAROL), order({ userId: CAROL, side: 'buy', qty: A('5'), clientOrderId: 'broke' })),
      ).rejects.toMatchObject({ code: 'trade.futures_margin_insufficient' });
      expect(engine.submits).toHaveLength(0);
      const row = await sql<{ status: string; refusal_code: string }[]>`
        SELECT status, refusal_code FROM trade.futures_orders WHERE id = ${matchedOrderIdFor(CAROL, MARKET, 'broke')}
      `;
      expect(row[0]).toEqual({ status: 'refused', refusal_code: 'trade.futures_margin_insufficient' });
    });
  });

  /** Counts the futures margin applies that reach the ledger, so a replay can be shown to post none. */
  function countingLedger(inner: MemoryLedger): { ledger: LedgerClient; applies: () => number } {
    let applies = 0;
    const counted = {
      ...inner,
      post: async (request: PostRequest) => {
        if (request.reason === 'futures.order.margin.applied') applies += 1;
        return inner.post(request);
      },
      balance: (ref: Parameters<LedgerClient['balance']>[0]) => inner.balance(ref),
    } as LedgerClient;
    return { ledger: counted, applies: () => applies };
  }

  describe('placement', () => {
    it('a hold post that fails after it lands is finished by the retry, with one hold on the books', async () => {
      // The hold posts, then the reply is lost. The order row is still `pending`; the retry posts the same hold
      // key, which returns the original, and the order goes on to the engine exactly once.
      let lostOnce = true;
      const lossy = {
        ...ledger,
        post: async (request: PostRequest) => {
          const tx = await ledger.post(request);
          if (request.reason === 'futures.order.margin.hold' && lostOnce) {
            lostOnce = false;
            throw new Error('reply lost after the hold posted');
          }
          return tx;
        },
        balance: (ref: Parameters<LedgerClient['balance']>[0]) => ledger.balance(ref),
      } as LedgerClient;
      const input = order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'lost-hold' });
      await expect(build({}, lossy).place(principal(ALICE), input)).rejects.toThrow('reply lost after the hold posted');
      const orderId = matchedOrderIdFor(ALICE, MARKET, 'lost-hold');
      expect((await orderRow(orderId)).status).toBe('pending');
      expect(engine.submits).toHaveLength(0);

      const view = await build({}, lossy).place(principal(ALICE), input);
      expect(view.status).toBe('open');
      expect(engine.submits).toHaveLength(1);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, orderId))).toBe(A('10'));
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('990'));
    });

    it('a market order is an IOC limit at the band edge, with the band as the engine collar', async () => {
      const svc = build();
      const view = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('1'), type: 'market', clientOrderId: 'mkt' }),
      );
      expect(view.status).toBe('open');
      const sent = engine.submits[0]!;
      expect(sent.price).toBe('105');
      expect(sent.tif).toBe('IOC');
      expect(sent.collar).toBe(true);
      expect(sent.min).toBe('95');
      expect(sent.max).toBe('105');
      expect(sent.reduceOnly).toBe(false);
      expect(sent.accountId).toBe(ALICE);
    });

    it('a limit order locks the initial margin plus the adverse distance, before it is submitted', async () => {
      const svc = build();
      const view = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('2'), limitPrice: A('104'), clientOrderId: 'lim' }),
      );
      const expected = orderHoldAmount({ side: 'buy', qty: A('2'), limit: A('104'), mark: mark, leverage: A('10') });
      expect(view.holdAmount).toBe(formatAmount(expected));
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, view.orderId))).toBe(expected);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - expected);
      expect(engine.submits[0]!.tif).toBe('GTC');
      expect(view.status).toBe('open');
      await assertBooksAgree();
    });

    it('a retry of the same clientOrderId places nothing twice: one hold, one submit', async () => {
      const svc = build();
      const input = order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'twice' });
      const first = await svc.place(principal(ALICE), input);
      const second = await svc.place(principal(ALICE), input);
      expect(second.orderId).toBe(first.orderId);
      expect(engine.submits).toHaveLength(1);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, first.orderId))).toBe(A('10'));
    });

    it('a retry that names a different order refuses', async () => {
      const svc = build();
      await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'same' }));
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2'), clientOrderId: 'same' })),
      ).rejects.toMatchObject({ code: 'trade.client_order_id_conflict' });
    });

    it('the engine rejecting the order releases the whole hold', async () => {
      engine.script.push({
        accepted: false,
        sequence: null,
        fills: [],
        resting: null,
        rejected: { code: 'market_halted', message: 'halted' },
        cancellations: [],
        triggered: [],
      });
      const svc = build();
      const view = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'halt' }));
      expect(view.status).toBe('rejected');
      expect(view.refusalCode).toBe('market_halted');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, view.orderId))).toBe(0n);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
    });

    it('an order whose submit started and never recorded an answer is never sent again', async () => {
      // The process died after the engine may have accepted the order: the row is `submitting`. A retry must not
      // send the same order id again, because the engine may already hold it; it refuses and the fills settle.
      const svc = build();
      const input = order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'mid-submit' });
      const view = await svc.place(principal(ALICE), input);
      expect(view.status).toBe('open');
      await sql`UPDATE trade.futures_orders SET status = 'submitting' WHERE id = ${view.orderId}`;
      await expect(svc.place(principal(ALICE), input)).rejects.toMatchObject({ code: 'trade.futures_submit_unknown' });
      expect(engine.submits).toHaveLength(1);
      // Cancelling it asks the engine, and releases only if the engine says it was live and is now gone.
      const cancelled = await svc.cancel(principal(ALICE), view.orderId);
      expect(cancelled.status).toBe('cancelled');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, view.orderId))).toBe(0n);
    });

    it('an engine that does not answer leaves the hold in place, marks the order, and does not send it again', async () => {
      engine.script.push(new Error('connection reset'));
      const svc = build();
      const input = order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'unknown' });
      await expect(svc.place(principal(ALICE), input)).rejects.toMatchObject({ code: 'trade.futures_submit_unknown' });
      const orderId = matchedOrderIdFor(ALICE, MARKET, 'unknown');
      expect((await orderRow(orderId)).status).toBe('submit_unknown');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, orderId))).toBe(A('10'));
      await expect(svc.place(principal(ALICE), input)).rejects.toMatchObject({ code: 'trade.futures_submit_unknown' });
      expect(engine.submits).toHaveLength(1);
    });
  });

  describe('fills, release and replay', () => {
    it('two orders match: both positions open, long equals short, and each hold is spent exactly', async () => {
      const svc = build();
      const buy = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('2'), limitPrice: A('100'), clientOrderId: 'a-buy' }),
      );
      const sell = await svc.place(
        principal(BOB),
        order({ userId: BOB, side: 'sell', qty: A('2'), limitPrice: A('100'), clientOrderId: 'b-sell' }),
      );
      // Bob's sell rests; a fill between them arrives as the engine prints it.
      await svc.settleFill({
        marketId: MARKET,
        makerOrderId: buy.orderId,
        takerOrderId: sell.orderId,
        price: '100',
        qty: '2',
        sequence: 1,
      });

      const alice = await positionsOf(ALICE);
      const bob = await positionsOf(BOB);
      expect(alice).toHaveLength(1);
      expect(bob).toHaveLength(1);
      expect(alice[0]!.side).toBe('long');
      expect(bob[0]!.side).toBe('short');
      expect(alice[0]!.size).toBe(formatAmount(A('2')) === '2' ? alice[0]!.size : alice[0]!.size);
      expect(parseAmount(alice[0]!.size)).toBe(A('2'));
      expect(parseAmount(bob[0]!.size)).toBe(A('2'));
      expect(parseAmount(alice[0]!.margin_current)).toBe(A('20'));
      expect(parseAmount(bob[0]!.margin_current)).toBe(A('20'));
      expect((await orderRow(buy.orderId)).status).toBe('filled');
      expect((await orderRow(sell.orderId)).status).toBe('filled');
      await assertBooksAgree();
    });

    it('a fill at a better price than the limit releases the unused part when the order is finished', async () => {
      const svc = build();
      // Bob rests a sell at 102, which is inside Alice's band; Alice's buy at 105 takes it at 102, inside her limit.
      const bobSell = await svc.place(
        principal(BOB),
        order({ userId: BOB, side: 'sell', qty: A('1'), limitPrice: A('102'), clientOrderId: 'bob-102' }),
      );
      engine.script.push({
        accepted: true,
        sequence: 2001,
        fills: [
          {
            sequence: 2001,
            makerOrderId: bobSell.orderId,
            makerAccountId: BOB,
            takerOrderId: matchedOrderIdFor(ALICE, MARKET, 'alice-105'),
            takerAccountId: ALICE,
            takerSide: 'buy',
            price: '102',
            qty: '1',
          },
        ],
        resting: null,
        rejected: null,
        cancellations: [],
        triggered: [],
      });
      const alice = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('1'), limitPrice: A('105'), clientOrderId: 'alice-105' }),
      );
      expect(alice.holdAmount).toBe('15');
      expect(alice.appliedAmount).toBe('12');
      expect(alice.releasedAmount).toBe('3');
      expect(alice.status).toBe('filled');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(0n);
      expect(parseAmount((await positionsOf(ALICE))[0]!.margin_current)).toBe(A('12'));
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('12'));
      await assertBooksAgree();
    });

    it('a cancel after a partial fill releases exactly the hold the fill did not use', async () => {
      const svc = build();
      const alice = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('4'), limitPrice: A('100'), clientOrderId: 'partial' }),
      );
      expect(alice.holdAmount).toBe('40');
      const bob = await svc.place(
        principal(BOB),
        order({ userId: BOB, side: 'sell', qty: A('1'), limitPrice: A('100'), clientOrderId: 'bob-part' }),
      );
      await svc.settleFill({
        marketId: MARKET,
        makerOrderId: alice.orderId,
        takerOrderId: bob.orderId,
        price: '100',
        qty: '1',
        sequence: 7,
      });
      expect((await orderRow(alice.orderId)).status).toBe('open');
      engine.remaining.set(alice.orderId, '3');
      const cancelled = await svc.cancel(principal(ALICE), alice.orderId);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.releasedAmount).toBe('30');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(0n);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('10'));
      await assertBooksAgree();
    });

    it('an engine cancellation of a resting order releases its hold; a non-futures order is left to the spot path', async () => {
      const svc = build();
      const alice = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'engine-cancel' }));
      expect(await svc.releaseEngineCancellation(alice.orderId, '1')).toBe(true);
      expect((await orderRow(alice.orderId)).status).toBe('cancelled');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(0n);
      expect(await svc.releaseEngineCancellation(randomUUID(), '1')).toBe(false);
    });

    it('a fill the engine printed before a cancel settles after it, and only then is the rest of the hold released', async () => {
      const svc = build();
      const alice = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('4'), clientOrderId: 'race-a' }));
      const bob = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('1'), clientOrderId: 'race-b' }));
      // The engine matched 1 of Alice's 4 before her cancel; the fill's event has not reached this service yet.
      engine.remaining.set(alice.orderId, '3');
      const cancelled = await svc.cancel(principal(ALICE), alice.orderId);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.releasedAmount).toBe('0');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(A('40'));

      await svc.settleFill({
        marketId: MARKET,
        makerOrderId: alice.orderId,
        takerOrderId: bob.orderId,
        price: '100',
        qty: '1',
        sequence: 51,
      });
      const after = await orderRow(alice.orderId);
      expect(after.status).toBe('cancelled');
      expect(parseAmount(after.filled_qty)).toBe(A('1'));
      expect(parseAmount(after.applied_amount)).toBe(A('10'));
      expect(parseAmount(after.released_amount)).toBe(A('30'));
      expect(parseAmount((await positionsOf(ALICE))[0]!.size)).toBe(A('1'));
      expect(parseAmount((await positionsOf(BOB))[0]!.size)).toBe(A('1'));
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('10'));
      await assertBooksAgree();

      // Nothing more fits: the engine said 1 was filled, and the rest of the hold is back.
      const carol = await svc.place(principal(CAROL), order({ userId: CAROL, side: 'sell', qty: A('1'), clientOrderId: 'race-c' }));
      await expect(
        svc.settleFill({
          marketId: MARKET,
          makerOrderId: alice.orderId,
          takerOrderId: carol.orderId,
          price: '100',
          qty: '1',
          sequence: 52,
        }),
      ).rejects.toMatchObject({ code: 'trade.futures_hold_released' });
    });

    it('an engine cancellation event that overtakes a fill holds the rest of the hold until the fill settles', async () => {
      const svc = build();
      const alice = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2'), clientOrderId: 'evt-a' }));
      const bob = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('1'), clientOrderId: 'evt-b' }));
      expect(await svc.releaseEngineCancellation(alice.orderId, '1')).toBe(true);
      // Replayed, the event changes nothing: the first remainder recorded stands.
      expect(await svc.releaseEngineCancellation(alice.orderId, '2')).toBe(true);
      expect(parseAmount((await orderRow(alice.orderId)).released_amount)).toBe(0n);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(A('20'));

      await svc.settleFill({
        marketId: MARKET,
        makerOrderId: alice.orderId,
        takerOrderId: bob.orderId,
        price: '100',
        qty: '1',
        sequence: 61,
      });
      expect(parseAmount((await orderRow(alice.orderId)).released_amount)).toBe(A('10'));
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(0n);
      await assertBooksAgree();
    });

    it('a cancel the engine answers without a remainder waits for the cancellation event to release', async () => {
      const svc = build();
      const alice = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'no-rem' }));
      engine.cancel = async (_marketId: string, orderId: string) => ({ cancelled: true, orderId, sequence: 1, cancellation: null });
      const cancelled = await svc.cancel(principal(ALICE), alice.orderId);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.releasedAmount).toBe('0');
      expect(await svc.releaseEngineCancellation(alice.orderId, '1')).toBe(true);
      expect(parseAmount((await orderRow(alice.orderId)).released_amount)).toBe(A('10'));
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(0n);
    });

    it('a replayed fill posts nothing twice and moves no row twice', async () => {
      const svc = build();
      const alice = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2'), clientOrderId: 'replay-a' }));
      const bob = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('2'), clientOrderId: 'replay-b' }));
      const fill = { marketId: MARKET, makerOrderId: alice.orderId, takerOrderId: bob.orderId, price: '100', qty: '2', sequence: 11 };
      const counted = countingLedger(ledger);
      const replaySvc = build({}, counted.ledger);
      await replaySvc.settleFill(fill);
      const firstPosts = counted.applies();
      expect(firstPosts).toBe(2);
      const before = {
        alice: await bal(positionCollateralAccount(ALICE, USDT, (await positionsOf(ALICE))[0]!.id)),
        rows: await positionsOf(ALICE),
      };
      await replaySvc.settleFill(fill);
      await replaySvc.settleFill(fill);
      // The same fill again: no apply is posted, the pot and the rows do not move.
      expect(counted.applies()).toBe(firstPosts);
      expect(await bal(positionCollateralAccount(ALICE, USDT, before.rows[0]!.id))).toBe(before.alice);
      expect(await positionsOf(ALICE)).toEqual(before.rows);
      await assertBooksAgree();
    });

    it('a crash between the ledger post and the row write: the retry finishes once, with the same amount', async () => {
      // The apply posts, then the process dies before the rows move. Simulated: the first apply post goes through
      // and then throws, exactly as a lost reply would.
      let crashOnce = true;
      const crashing: LedgerClient = {
        ...ledger,
        post: async (request: PostRequest) => {
          const tx = await ledger.post(request);
          if (request.reason === 'futures.order.margin.applied' && crashOnce) {
            crashOnce = false;
            throw new Error('simulated crash after the post');
          }
          return tx;
        },
        balance: (ref) => ledger.balance(ref),
      } as LedgerClient;
      const svc = build({}, crashing);
      const alice = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2'), clientOrderId: 'crash-a' }));
      const bob = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('2'), clientOrderId: 'crash-b' }));
      const fill = { marketId: MARKET, makerOrderId: alice.orderId, takerOrderId: bob.orderId, price: '100', qty: '2', sequence: 21 };

      await expect(svc.settleFill(fill)).rejects.toThrow('simulated crash after the post');
      // The intent is still pending, and nothing moved on the rows.
      const pending = await sql<
        { state: string }[]
      >`SELECT state FROM trade.futures_order_fills WHERE engine_sequence = 21 AND order_id = ${bob.orderId}`;
      expect(pending[0]?.state).toBe('pending');
      expect(await positionsOf(BOB)).toHaveLength(0);

      await svc.settleFill(fill);
      const bobRows = await positionsOf(BOB);
      expect(bobRows).toHaveLength(1);
      expect(parseAmount(bobRows[0]!.margin_current)).toBe(A('20'));
      expect(parseAmount(bobRows[0]!.size)).toBe(A('2'));
      expect(await bal(positionCollateralAccount(BOB, USDT, bobRows[0]!.id))).toBe(A('20'));
      await assertBooksAgree();
    });

    it('a fill that prices outside its own limit is refused before anything posts', async () => {
      const svc = build();
      const alice = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('1'), limitPrice: A('100'), clientOrderId: 'out-a' }),
      );
      const bob = await svc.place(
        principal(BOB),
        order({ userId: BOB, side: 'sell', qty: A('1'), limitPrice: A('100'), clientOrderId: 'out-b' }),
      );
      await expect(
        svc.settleFill({ marketId: MARKET, makerOrderId: alice.orderId, takerOrderId: bob.orderId, price: '101', qty: '1', sequence: 31 }),
      ).rejects.toMatchObject({ code: 'trade.futures_fill_outside_limit' });
      // Both sides are checked before either posts: neither side gets an intent, neither gets a position.
      expect(await positionsOf(ALICE)).toHaveLength(0);
      expect(await positionsOf(BOB)).toHaveLength(0);
      expect(await sql`SELECT 1 FROM trade.futures_order_fills WHERE engine_sequence = 31`).toHaveLength(0);
    });

    it('a fill on an order whose hold was released is refused, not funded from anywhere else', async () => {
      const svc = build();
      const alice = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'late-a' }));
      await svc.cancel(principal(ALICE), alice.orderId);
      const bob = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('1'), clientOrderId: 'late-b' }));
      await expect(
        svc.settleFill({ marketId: MARKET, makerOrderId: alice.orderId, takerOrderId: bob.orderId, price: '100', qty: '1', sequence: 41 }),
      ).rejects.toMatchObject({ code: 'trade.futures_hold_released' });
    });

    it('a pending fill on an open position refuses its close until the fill is recorded', async () => {
      // The real guard: PositionService.close runs assertLiquidationHold, which refuses while any intent on the
      // position is pending. Set up an open position from one applied fill, then a second fill that crashes.
      const svc = build();
      const a1 = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'g-a1' }));
      const b1 = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('1'), clientOrderId: 'g-b1' }));
      await svc.settleFill({ marketId: MARKET, makerOrderId: a1.orderId, takerOrderId: b1.orderId, price: '100', qty: '1', sequence: 50 });
      const [open] = await positionsOf(ALICE);
      expect(open?.status).toBe('open');

      const a2 = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'g-a2' }));
      const b2 = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('1'), clientOrderId: 'g-b2' }));
      const crashing: LedgerClient = {
        ...ledger,
        post: async (request: PostRequest) => {
          if (request.reason === 'futures.order.margin.applied') throw new Error('crash after intent');
          return ledger.post(request);
        },
        balance: (ref) => ledger.balance(ref),
      } as LedgerClient;
      await expect(
        build({}, crashing).settleFill({
          marketId: MARKET,
          makerOrderId: b2.orderId,
          takerOrderId: a2.orderId,
          price: '100',
          qty: '1',
          sequence: 51,
        }),
      ).rejects.toThrow('crash after intent');

      const pending = await sql<
        { n: number }[]
      >`SELECT 1 AS n FROM trade.futures_order_fills WHERE position_id = ${open!.id} AND state = 'pending'`;
      expect(pending).toHaveLength(1);

      const positions = new PositionService(sql, ledger, {
        marks: memoryMarkBook().source(),
        profitSource: null,
        maxLeverage: A('10'),
        now: () => NOW,
      });
      await expect(positions.close(ALICE, open!.id)).rejects.toMatchObject({ code: 'trade.futures_fill_in_progress', status: 409 });
      // Nothing moved: the pot still holds exactly the first fill's margin.
      expect(await bal(positionCollateralAccount(ALICE, USDT, open!.id))).toBe(A('10'));

      // Recording the fill (the event redelivers it) clears the guard.
      await svc.settleFill({ marketId: MARKET, makerOrderId: b2.orderId, takerOrderId: a2.orderId, price: '100', qty: '1', sequence: 51 });
      const stillPending = await sql<
        { n: number }[]
      >`SELECT 1 AS n FROM trade.futures_order_fills WHERE position_id = ${open!.id} AND state = 'pending'`;
      expect(stillPending).toHaveLength(0);
      expect(parseAmount((await positionsOf(ALICE))[0]!.size)).toBe(A('2'));
      await assertBooksAgree();
    });

    it('an insufficient balance on a fill cannot reach the rows: the intent stays pending, the position is not created', async () => {
      const svc = build();
      const alice = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'short-a' }));
      const bob = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('1'), clientOrderId: 'short-b' }));
      const failing: LedgerClient = {
        ...ledger,
        post: async (request: PostRequest) => {
          if (request.reason === 'futures.order.margin.applied') throw new InsufficientFundsError('test', 'USDT', '1000', '0');
          return ledger.post(request);
        },
        balance: (ref) => ledger.balance(ref),
      } as LedgerClient;
      await expect(
        build({}, failing).settleFill({
          marketId: MARKET,
          makerOrderId: alice.orderId,
          takerOrderId: bob.orderId,
          price: '100',
          qty: '1',
          sequence: 61,
        }),
      ).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(await positionsOf(ALICE)).toHaveLength(0);
    });
  });

  describe('busy positions, fill routing, the band on resting orders, the hold round trip', () => {
    async function rest(userId: string, side: 'buy' | 'sell', clientOrderId: string, limitPrice = A('100'), qty = A('1')) {
      return build().place(principal(userId), order({ userId, side, qty, limitPrice, clientOrderId }));
    }

    /** Alice long 1 against Bob short 1, then a second resting buy from Alice and a resting sell from Carol. */
    async function aliceLongWithAnotherBuy() {
      const svc = build();
      const a1 = await rest(ALICE, 'buy', 'busy-a1');
      const b1 = await rest(BOB, 'sell', 'busy-b1');
      await svc.settleFill({ marketId: MARKET, makerOrderId: a1.orderId, takerOrderId: b1.orderId, price: '100', qty: '1', sequence: 1 });
      const [held] = await positionsOf(ALICE);
      const a2 = await rest(ALICE, 'buy', 'busy-a2');
      const c1 = await rest(CAROL, 'sell', 'busy-c1');
      return { svc, positionId: held!.id, bobPosition: (await positionsOf(BOB))[0]!.id, a2, c1 };
    }

    async function rung(positionId: string, state: string) {
      const plan = { recipes: [], reason: 'closing', fromInsurance: '0', marginAsset: USDT };
      await sql`
        INSERT INTO trade.liquidation_rungs (rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state)
        VALUES (${randomUUID()}, ${positionId}, ${`liq:${positionId}`}, 'closing', '1', '10', ${sql.json(plan as never)}, ${state})
      `;
    }

    beforeEach(async () => {
      await sql`TRUNCATE trade.liquidation_rungs, trade.futures_adl_pairs, trade.liquidation_attempts RESTART IDENTITY CASCADE`;
    });

    it('a fill on a position a live rung is closing refuses 409 and posts nothing; redelivered after the rung, it opens a new position', async () => {
      const { svc, positionId, a2, c1 } = await aliceLongWithAnotherBuy();
      await rung(positionId, 'planned');
      const fill = { marketId: MARKET, makerOrderId: a2.orderId, takerOrderId: c1.orderId, price: '100', qty: '1', sequence: 2 };

      await expect(svc.settleFill(fill)).rejects.toMatchObject({ code: 'trade.liquidation_in_progress', status: 409 });
      // Refused whole: neither side recorded or posted anything, and both holds are intact.
      expect(await sql`SELECT 1 FROM trade.futures_order_fills WHERE engine_sequence = 2`).toHaveLength(0);
      expect(await positionsOf(CAROL)).toHaveLength(0);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, a2.orderId))).toBe(A('10'));
      expect(await bal(futuresOrderMarginAccount(CAROL, USDT, c1.orderId))).toBe(A('10'));

      // The rung finishes and closes the row; the event comes again and the fill lands on a fresh position.
      await sql`UPDATE trade.liquidation_rungs SET state = 'applied' WHERE position_id = ${positionId}`;
      await sql`UPDATE trade.positions SET status = 'liquidated' WHERE id = ${positionId}`;
      await svc.settleFill(fill);
      const open = (await positionsOf(ALICE)).filter((p) => p.status === 'open');
      expect(open).toHaveLength(1);
      expect(open[0]!.id).not.toBe(positionId);
      expect(await bal(positionCollateralAccount(ALICE, USDT, open[0]!.id))).toBe(parseAmount(open[0]!.margin_current));
      expect((await orderRow(a2.orderId)).status).toBe('filled');
    });

    it('a fill refused because its position is busy waits durably, past any redelivery, and settles exactly once', async () => {
      const { svc, positionId, a2, c1 } = await aliceLongWithAnotherBuy();
      await rung(positionId, 'planned');
      const fill = { marketId: MARKET, makerOrderId: a2.orderId, takerOrderId: c1.orderId, price: '100', qty: '1', sequence: 8 };

      // The event is acknowledged: the fill is kept, nothing is posted, both holds stay.
      expect(await svc.settleFillOrWait(fill)).toBe('waiting');
      expect(await svc.settleFillOrWait(fill)).toBe('waiting');
      const [waitRow] = await sql<{ attempts: number; reason: string; settled_at: Date | null }[]>`
        SELECT attempts, reason, settled_at FROM trade.futures_fill_waits WHERE engine_sequence = 8
      `;
      expect(waitRow).toMatchObject({ attempts: 2, reason: 'trade.liquidation_in_progress', settled_at: null });
      expect(await sql`SELECT 1 FROM trade.futures_order_fills WHERE engine_sequence = 8`).toHaveLength(0);

      // However many ticks pass while the rung runs, the fill keeps waiting.
      for (let tick = 0; tick < 3; tick += 1) {
        expect(await svc.retryWaitingFills(50)).toEqual({ settled: 0, waiting: 1, failed: [] });
      }
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, a2.orderId))).toBe(A('10'));

      // The rung closes the row; the next tick settles the fill on a fresh position.
      await sql`UPDATE trade.liquidation_rungs SET state = 'applied' WHERE position_id = ${positionId}`;
      await sql`UPDATE trade.positions SET status = 'liquidated' WHERE id = ${positionId}`;
      expect(await svc.retryWaitingFills(50)).toEqual({ settled: 1, waiting: 0, failed: [] });
      const carolPot = (await positionsOf(CAROL))[0]!;
      expect(parseAmount(carolPot.size)).toBe(A('1'));
      expect((await orderRow(a2.orderId)).status).toBe('filled');
      expect((await orderRow(c1.orderId)).status).toBe('filled');
      const alicePosition = (await positionsOf(ALICE)).find((p) => p.status === 'open')!;
      const aliceMargin = await bal(positionCollateralAccount(ALICE, USDT, alicePosition.id));

      // Nothing settles twice: not another tick, not a late redelivery of the same event.
      expect(await svc.retryWaitingFills(50)).toEqual({ settled: 0, waiting: 0, failed: [] });
      expect(await svc.settleFillOrWait(fill)).toBe('settled');
      expect(await bal(positionCollateralAccount(ALICE, USDT, alicePosition.id))).toBe(aliceMargin);
      expect(await sql`SELECT 1 FROM trade.futures_order_fills WHERE engine_sequence = 8`).toHaveLength(2);
    });

    it('a fill the engine prints while placing a taker into a busy position waits, and the placement still answers', async () => {
      const { positionId, a2 } = await aliceLongWithAnotherBuy();
      await rung(positionId, 'planned');
      const takerId = matchedOrderIdFor(CAROL, MARKET, 'busy-taker');
      engine.script.push({
        accepted: true,
        sequence: 3001,
        fills: [
          {
            sequence: 3001,
            makerOrderId: a2.orderId,
            makerAccountId: ALICE,
            takerOrderId: takerId,
            takerAccountId: CAROL,
            takerSide: 'sell',
            price: '100',
            qty: '1',
          },
        ],
        resting: null,
        rejected: null,
        cancellations: [],
        triggered: [],
      });
      const svc = build();
      const view = await svc.place(principal(CAROL), order({ userId: CAROL, side: 'sell', qty: A('1'), clientOrderId: 'busy-taker' }));
      expect(view.orderId).toBe(takerId);
      expect(await sql`SELECT 1 FROM trade.futures_fill_waits WHERE engine_sequence = 3001 AND settled_at IS NULL`).toHaveLength(1);
      expect(await bal(futuresOrderMarginAccount(CAROL, USDT, takerId))).toBe(A('10'));

      await sql`UPDATE trade.liquidation_rungs SET state = 'applied' WHERE position_id = ${positionId}`;
      await sql`UPDATE trade.positions SET status = 'liquidated' WHERE id = ${positionId}`;
      expect(await svc.retryWaitingFills(50)).toEqual({ settled: 1, waiting: 0, failed: [] });
      expect((await orderRow(takerId)).status).toBe('filled');
      expect(await bal(futuresOrderMarginAccount(CAROL, USDT, takerId))).toBe(0n);
    });

    it('a refusal that is not about a busy position is still thrown, and nothing is kept', async () => {
      const svc = build();
      await expect(
        svc.settleFillOrWait({
          marketId: MARKET,
          makerOrderId: randomUUID(),
          takerOrderId: randomUUID(),
          price: '100',
          qty: '1',
          sequence: 9,
        }),
      ).rejects.toMatchObject({ code: 'trade.futures_order_not_found' });
      expect(await sql`SELECT 1 FROM trade.futures_fill_waits`).toHaveLength(0);
    });

    it('the check also runs under the position lock when the intent is recorded', async () => {
      const { svc, positionId, a2, c1 } = await aliceLongWithAnotherBuy();
      // The rung starts after the whole-fill check and before the intent: Carol's side records first, Alice's refuses.
      const original = sql.begin.bind(sql);
      let calls = 0;
      const spy = vi.spyOn(sql, 'begin').mockImplementation(((fn: never) => {
        calls += 1;
        if (calls === 2) return rung(positionId, 'planned').then(() => original(fn));
        return original(fn);
      }) as never);
      try {
        await expect(
          svc.settleFill({ marketId: MARKET, makerOrderId: a2.orderId, takerOrderId: c1.orderId, price: '100', qty: '1', sequence: 3 }),
        ).rejects.toMatchObject({ code: 'trade.liquidation_in_progress', status: 409 });
      } finally {
        spy.mockRestore();
      }
      const fills = await sql<{ order_id: string }[]>`SELECT order_id FROM trade.futures_order_fills WHERE engine_sequence = 3`;
      expect(fills.map((f) => f.order_id)).toEqual([c1.orderId]);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, a2.orderId))).toBe(A('10'));
    });

    it('a planned ADL pair on the position refuses the fill with 409', async () => {
      const { svc, positionId, bobPosition, a2, c1 } = await aliceLongWithAnotherBuy();
      await sql`
        INSERT INTO trade.futures_adl_pairs (pair_id, ordinal, bankrupt_position_id, bankrupt_user_id, candidate_position_id, candidate_user_id,
          asset_id, size, bankruptcy_price, bankrupt_margin_taken, bankrupt_initial_taken, candidate_margin_released,
          candidate_initial_released, candidate_release_sequence, candidate_profit, disclosure_event_id)
        VALUES (${`futures.adl:${positionId}:1:${bobPosition}`}, 1, ${positionId}, ${ALICE}, ${bobPosition}, ${BOB}, 'USDT', '1', '90',
          '10', '10', '10', '10', 2, '10', 'evt-1')
      `;
      await expect(
        svc.settleFill({ marketId: MARKET, makerOrderId: a2.orderId, takerOrderId: c1.orderId, price: '100', qty: '1', sequence: 4 }),
      ).rejects.toMatchObject({ code: 'trade.liquidation_in_progress', status: 409 });
      expect(await sql`SELECT 1 FROM trade.futures_order_fills WHERE engine_sequence = 4`).toHaveLength(0);
    });

    it('a position under review after an abandoned rung refuses the fill with 409', async () => {
      const { svc, positionId, a2, c1 } = await aliceLongWithAnotherBuy();
      await rung(positionId, 'abandoned');
      await expect(
        svc.settleFill({ marketId: MARKET, makerOrderId: a2.orderId, takerOrderId: c1.orderId, price: '100', qty: '1', sequence: 5 }),
      ).rejects.toMatchObject({ code: 'trade.position_under_review', status: 409 });
    });

    it('a fill is routed by its orders: two matched orders are ours, two others are the spot path, one of each refuses', async () => {
      const svc = build();
      const a = await rest(ALICE, 'buy', 'route-a');
      const b = await rest(BOB, 'sell', 'route-b');
      expect(await svc.ownsFill({ makerOrderId: a.orderId, takerOrderId: b.orderId })).toBe(true);
      expect(await svc.ownsFill({ makerOrderId: randomUUID(), takerOrderId: randomUUID() })).toBe(false);
      await expect(svc.ownsFill({ makerOrderId: a.orderId, takerOrderId: randomUUID() })).rejects.toMatchObject({
        code: 'trade.futures_fill_crosses_order_paths',
      });
    });

    it('a resting order whose limit leaves the band around the new mark is cancelled and its hold returned', async () => {
      const alice = await rest(ALICE, 'buy', 'band-a', A('104'));
      const bob = await rest(BOB, 'sell', 'band-b', A('96'));
      // Mark 98 with a 5% band is 93.1 to 102.9: Alice's 104 is outside, Bob's 96 is inside.
      mark = A('98');
      const sweep = await build().cancelOutsideBand();
      expect(sweep).toEqual({ cancelled: [alice.orderId], skipped: [] });
      expect(engine.cancels).toEqual([alice.orderId]);
      expect(await orderRow(alice.orderId)).toMatchObject({ status: 'cancelled', refusal_code: 'trade.futures_price_outside_band' });
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(0n);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
      expect((await orderRow(bob.orderId)).status).toBe('open');
      await assertBooksAgree();
    });

    it('a market whose mark cannot be read is skipped and reported, and nothing is cancelled', async () => {
      const alice = await rest(ALICE, 'buy', 'band-dark', A('104'));
      const svc = build({
        markFor: async () => {
          throw Object.assign(new Error('no acceptable mark'), { code: 'trade.mark_stale' });
        },
      });
      expect(await svc.cancelOutsideBand()).toEqual({ cancelled: [], skipped: [{ marketId: MARKET, reason: 'trade.mark_stale' }] });
      expect(engine.cancels).toEqual([]);
      expect((await orderRow(alice.orderId)).status).toBe('open');
    });

    it.each([
      ['buy', '0.0007', '7.77'],
      ['sell', '0.0013', '3.33'],
    ] as const)('a %s market order at the band edge holds exactly what its stored terms give back', async (side, qty, leverage) => {
      mark = A('100.37');
      const svc = build();
      const view = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side, qty: A(qty), leverage: A(leverage), type: 'market', clientOrderId: `edge-${side}` }),
      );
      const sent = engine.submits.at(-1)!;
      const posted = await bal(futuresOrderMarginAccount(ALICE, USDT, view.orderId));
      // The hold posted at placement, from the terms in memory.
      expect(posted).toBe(orderHoldAmount({ side, qty: A(qty), limit: A(sent.price!), mark: A('100.37'), leverage: A(leverage) }));
      // The same hold, from the terms after a round trip through the row.
      const [row] = await sql<{ qty: string; limit_price: string; mark_price: string; leverage: string }[]>`
        SELECT qty, limit_price, mark_price, leverage FROM trade.futures_orders WHERE id = ${view.orderId}
      `;
      expect(
        orderHoldAmount({
          side,
          qty: parseAmount(row!.qty),
          limit: parseAmount(row!.limit_price),
          mark: parseAmount(row!.mark_price),
          leverage: parseAmount(row!.leverage),
        }),
      ).toBe(posted);
      expect(parseAmount(view.holdAmount)).toBe(posted);
      // Cancelled untouched, it gives back every unit it locked.
      engine.remaining.set(view.orderId, qty);
      await svc.cancel(principal(ALICE), view.orderId);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, view.orderId))).toBe(0n);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
    });
  });

  describe('invariants', () => {
    it('after every fill across many accounts, long size equals short size and every pot and hold agrees with its row', async () => {
      const svc = build();
      const users = [ALICE, BOB, CAROL];
      for (const u of users) {
        await ledger.post(
          recipes.deposit({ userId: u, assetId: USDT, amount: A('100000'), rail: 'test', railRef: `top-${u}-${randomUUID()}` }),
        );
      }
      // Each user places several resting orders on both sides, inside the band.
      const placed: Array<{ userId: string; orderId: string; side: 'buy' | 'sell'; limit: bigint; remaining: bigint }> = [];
      let seed = 97;
      const next = (max: number) => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed % max;
      };
      for (let i = 0; i < 18; i++) {
        const userId = users[i % 3]!;
        const side: 'buy' | 'sell' = i % 2 === 0 ? 'buy' : 'sell';
        const limit = side === 'buy' ? A('100') + BigInt(next(5)) * A('0.5') : A('100') - BigInt(next(5)) * A('0.5');
        const qty = A('1') + BigInt(next(4)) * A('0.5');
        const view = await svc.place(principal(userId), order({ userId, side, qty, limitPrice: limit, clientOrderId: `inv-${i}` }));
        placed.push({ userId, orderId: view.orderId, side, limit, remaining: qty });
      }

      let sequence = 5000;
      for (let step = 0; step < 40; step++) {
        const buys = placed.filter((p) => p.side === 'buy' && p.remaining > 0n);
        const sells = placed.filter((p) => p.side === 'sell' && p.remaining > 0n);
        if (buys.length === 0 || sells.length === 0) break;
        const b = buys[next(buys.length)]!;
        const s = sells[next(sells.length)]!;
        if (b.userId === s.userId) continue;
        // A price both orders accept: between the sell's limit and the buy's limit.
        if (s.limit > b.limit) continue;
        const span = b.limit - s.limit;
        const price = s.limit + (span === 0n ? 0n : BigInt(next(Number(span / A('0.01')) + 1)) * A('0.01'));
        const qty = b.remaining < s.remaining ? b.remaining : s.remaining;
        const fillQty = qty > A('1') ? A('1') : qty;
        sequence += 1;
        await svc.settleFill({
          marketId: MARKET,
          makerOrderId: b.orderId,
          takerOrderId: s.orderId,
          price: formatAmount(price),
          qty: formatAmount(fillQty),
          sequence,
        });
        b.remaining -= fillQty;
        s.remaining -= fillQty;
        await assertBooksAgree();
      }
      const open = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM trade.positions WHERE market_id = ${MARKET}`;
      expect(Number(open[0]!.n)).toBeGreaterThan(0);
    });

    it('the marginNeed of the whole order equals the sum of what its fills posted', async () => {
      const svc = build();
      const alice = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('3'), limitPrice: A('102'), clientOrderId: 'sum-a' }),
      );
      const bob = await svc.place(
        principal(BOB),
        order({ userId: BOB, side: 'sell', qty: A('3'), limitPrice: A('99'), clientOrderId: 'sum-b' }),
      );
      await svc.settleFill({
        marketId: MARKET,
        makerOrderId: bob.orderId,
        takerOrderId: alice.orderId,
        price: '99',
        qty: '1',
        sequence: 71,
      });
      await svc.settleFill({
        marketId: MARKET,
        makerOrderId: bob.orderId,
        takerOrderId: alice.orderId,
        price: '101',
        qty: '2',
        sequence: 72,
      });
      const applied = (await orderRow(alice.orderId)).applied_amount;
      const expected = marginNeed({
        filled: A('3'),
        adverseNum: A('2') * (A('101') - mark) + A('1') * 0n,
        mark,
        leverage: A('10'),
      });
      expect(parseAmount(applied)).toBe(expected);
      await assertBooksAgree();
    });
  });
});

describe('the at-mark open is retired while matched mode is on', () => {
  it('a new at-mark open refuses before anything is read or locked when the matching switch is on', async () => {
    const { PositionService: Positions } = await import('./position-service.js');
    const fake = {} as unknown as LedgerClient;
    const positions = new Positions({} as never, fake, {
      marks: memoryMarkBook().source(),
      profitSource: null,
      maxLeverage: A('10'),
      matchedOrders: { matching: null, enabled: true, priceBand: A('0.05'), lifecycleProof: null },
    });
    await expect(
      positions.open({
        userId: ALICE,
        symbol: SYMBOL,
        side: 'long',
        size: A('1'),
        leverage: A('10'),
        clientOpenId: 'at-mark',
      } as never),
    ).rejects.toMatchObject({ code: 'trade.futures_open_at_mark_retired', status: 409 });
  });
});
