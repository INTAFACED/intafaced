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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { MatchedFuturesOrders, splitRequestTag, type MatchedOrdersDeps, type PlaceMatchedOrderInput } from './matched-orders.js';
import type { FeeRates } from './matched-order-plan.js';
import { PositionService } from './position-service.js';
import { memoryMarkBook } from './mark-source.js';
import { matchedOrderIdFor } from './ids.js';
import { orderFeeReserve, orderHoldAmount, marginNeed } from './matched-order-plan.js';

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
  /** The perpetual rates the injected schedule gives every account. */
  let feeRates: FeeRates;

  beforeEach(async () => {
    await sql`TRUNCATE trade.futures_order_fills, trade.futures_orders, trade.positions, trade.markets, trade.futures_payouts, trade.futures_fill_waits, trade.account_position_modes RESTART IDENTITY CASCADE`;
    // The listing row's maker_bps/taker_bps are not a fee schedule and are never charged: the rates come from `feeRates`
    // (the owner's perpetual schedule in production). They are zero here, so these tests prove the margin path and a zero
    // fee posts exactly what it did before fees; the trading-fee tests publish rates themselves.
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
    feeRates = { makerBps: 0, takerBps: 0 };
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
      emailProof: { get: async () => 'accepted' },
      feeRates: async () => feeRates,
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
        band_high: string;
        maker_fee_bps: string;
        taker_fee_bps: string;
        fee_charged: string;
        reduce_only: boolean;
        status: string;
      }[]
    >`
      SELECT id, user_id, side, qty, limit_price, mark_price, leverage, applied_amount, released_amount,
             band_high, maker_fee_bps::text, taker_fee_bps::text, fee_charged, reduce_only, status
        FROM trade.futures_orders WHERE market_id = ${MARKET}
    `;
    for (const o of orders) {
      const held = await bal(futuresOrderMarginAccount(o.user_id, USDT, o.id));
      // The hold an order locked is a function of its terms; nothing stores it as a figure. It is the margin part
      // and the fee reserve at the rates the order kept (a reduce-only order locks neither, and a refused order was
      // refused before its hold was posted: an unfunded hold or the owner's haircut).
      const locked =
        o.reduce_only || o.status === 'refused'
          ? 0n
          : orderHoldAmount({
              side: o.side,
              qty: parseAmount(o.qty),
              limit: parseAmount(o.limit_price),
              mark: parseAmount(o.mark_price),
              leverage: parseAmount(o.leverage),
            }) +
            orderFeeReserve({
              side: o.side,
              qty: parseAmount(o.qty),
              limit: parseAmount(o.limit_price),
              bandHigh: parseAmount(o.band_high),
              rates: { makerBps: Number(o.maker_fee_bps), takerBps: Number(o.taker_fee_bps) },
            });
      expect(held, `hold of ${o.id} is what it locked less applied, fees paid and released`).toBe(
        locked - parseAmount(o.applied_amount) - parseAmount(o.fee_charged) - parseAmount(o.released_amount),
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

    it('an account that has not proved its email is refused before any hold, like every other new order', async () => {
      const svc = build({ emailProof: { get: async () => 'missing' } });
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'no-email' })),
      ).rejects.toMatchObject({ code: 'trade.email_proof_required' });
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

    it('a reduce-only order with no position to reduce is refused before anything is sent', async () => {
      // Slice 6b builds reduce-only orders; this pinned the phase-1 refusal, and now pins the refusal that remains.
      const svc = build();
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'sell', qty: A('1'), reduceOnly: true, clientOrderId: 'ro' })),
      ).rejects.toMatchObject({ code: 'trade.futures_reduce_only_no_position' });
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
        throw Object.assign(new Error('identity level insufficient'), { code: 'trade.identity_level_insufficient' });
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
      ).rejects.toMatchObject({ code: 'trade.identity_level_insufficient' });
      expect(gate).toHaveBeenCalledWith({ userId: ALICE, tier: 'full', region: 'DE' });
      expect(engine.submits).toHaveLength(0);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
    });

    it('a retry of an order that was already accepted is not gated again', async () => {
      const input = order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'gate-replay' });
      const first = await build().place(principal(ALICE), input);
      // New rules are published after the order was accepted: the retry still returns the order.
      const gate = vi.fn(async () => {
        throw Object.assign(new Error('identity level insufficient'), { code: 'trade.identity_level_insufficient' });
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
      // The order carries the caller's id, so a client that lost the first answer can find it by reading.
      expect([first.clientOrderId, second.clientOrderId]).toEqual(['twice', 'twice']);
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

    it('a fill stuck on a parked position does not starve a newer waiting fill whose position is free', async () => {
      const DAVE = '44444444-4444-4444-8444-444444444444';
      await ledger.post(recipes.deposit({ userId: DAVE, assetId: USDT, amount: A('1000'), rail: 'test', railRef: 'fund-dave-starve' }));
      const { svc, positionId, bobPosition, a2, c1 } = await aliceLongWithAnotherBuy();
      // Alice's position is parked: her fill waits however often it is retried.
      await rung(positionId, 'abandoned');
      const stuck = { marketId: MARKET, makerOrderId: a2.orderId, takerOrderId: c1.orderId, price: '100', qty: '1', sequence: 20 };
      expect(await svc.settleFillOrWait(stuck)).toBe('waiting');

      // A newer fill meets Bob's position while a rung runs on it, then the rung goes and Bob's position is free.
      const b2 = await rest(BOB, 'sell', 'starve-b2');
      const d1 = await rest(DAVE, 'buy', 'starve-d1');
      await rung(bobPosition, 'planned');
      const free = { marketId: MARKET, makerOrderId: d1.orderId, takerOrderId: b2.orderId, price: '100', qty: '1', sequence: 21 };
      expect(await svc.settleFillOrWait(free)).toBe('waiting');
      await sql`DELETE FROM trade.liquidation_rungs WHERE position_id = ${bobPosition}`;

      // One row per tick: the stuck fill is tried, then the free one settles instead of the stuck one again.
      expect(await svc.retryWaitingFills(1)).toEqual({ settled: 0, waiting: 1, failed: [] });
      expect(await svc.retryWaitingFills(1)).toEqual({ settled: 1, waiting: 0, failed: [] });
      expect((await orderRow(d1.orderId)).status).toBe('filled');
      expect(await bal(futuresOrderMarginAccount(DAVE, USDT, d1.orderId))).toBe(0n);
      // The stuck fill is still kept and its holds are intact.
      expect(await svc.retryWaitingFills(1)).toEqual({ settled: 0, waiting: 1, failed: [] });
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, a2.orderId))).toBe(A('10'));
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

    it('a spot OCO leg id (<parent>:tp, <parent>:sl) is not ours and does not reach the uuid column', async () => {
      const svc = build();
      const parent = randomUUID();
      expect(await svc.ownsFill({ makerOrderId: `${parent}:tp`, takerOrderId: randomUUID() })).toBe(false);
      expect(await svc.ownsFill({ makerOrderId: `${parent}:sl`, takerOrderId: `${randomUUID()}:tp` })).toBe(false);
      expect(await svc.releaseEngineCancellation(`${parent}:sl`, '1')).toBe(false);
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

    it('a wider band in force takes a limit the static band refuses, sends that band as the collar, and a narrower band later does not cancel it (D-instruments-08)', async () => {
      // Mark 100: the static 5% band is 95 to 105; the dynamic range has widened it to 20%, 80 to 120.
      const wide = build({ priceBandFor: async () => A('0.2') });
      await expect(
        build().place(
          principal(ALICE),
          order({ userId: ALICE, side: 'buy', qty: A('1'), limitPrice: A('110'), clientOrderId: 'dyn-static' }),
        ),
      ).rejects.toMatchObject({ code: 'trade.futures_price_outside_band', message: expect.stringContaining('95 to 105') });
      await expect(
        wide.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), limitPrice: A('125'), clientOrderId: 'dyn-out' })),
      ).rejects.toMatchObject({ code: 'trade.futures_price_outside_band', message: expect.stringContaining('80 to 120') });
      expect(engine.submits).toHaveLength(0);
      const placed = await wide.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('1'), limitPrice: A('110'), clientOrderId: 'dyn-in' }),
      );
      const [stored] = await sql<{ band_low: string; band_high: string }[]>`
        SELECT band_low::numeric::text AS band_low, band_high::numeric::text AS band_high FROM trade.futures_orders WHERE id = ${placed.orderId}`;
      expect([A(stored!.band_low), A(stored!.band_high)]).toEqual([A('80'), A('120')]);
      expect(engine.submits[0]).toMatchObject({ price: '110', collar: true, min: '80', max: '120' });
      // The band narrows back to the static one for new orders; the sweep holds the resting order to the band it was
      // accepted under (its stored 20%), so it stays on the book.
      const narrowed = build({ priceBandFor: async () => A('0.05') });
      expect(await narrowed.cancelOutsideBand()).toEqual({ cancelled: [], skipped: [] });
      expect((await orderRow(placed.orderId)).status).toBe('open');
      // Past its own band it comes off, as any resting order does: mark 92 is 73.6 to 110.4, mark 91 is 72.8 to 109.2.
      mark = A('92');
      expect((await narrowed.cancelOutsideBand()).cancelled).toEqual([]);
      mark = A('91');
      expect((await narrowed.cancelOutsideBand()).cancelled).toEqual([placed.orderId]);
      await assertBooksAgree();
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
      // Each user places several resting orders on both sides, inside the band. Opening both sides is hedge mode
      // (slice 6b refuses it in one-way mode), so the accounts say so.
      for (const u of users) {
        await sql`
          INSERT INTO trade.account_position_modes (user_id, mode, source, client_mode_id)
          VALUES (${u}, 'hedge', 'test', ${`inv-${u}`})
          ON CONFLICT (user_id) DO UPDATE SET mode = 'hedge'
        `;
      }
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

  describe('size and price controls (D-orders-06): slippage cap, price correction, split', () => {
    const saved: Record<string, string | undefined> = {};
    const ENV = ['TRADE_MAX_ORDER', 'TRADE_MAX_POSITION', 'TRADE_MAX_LOSS'] as const;
    beforeEach(() => {
      for (const key of ENV) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });
    afterEach(() => {
      for (const key of ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    async function held(userId: string): Promise<bigint> {
      return A('1000') - (await bal(userAvailable(userId, USDT)));
    }

    it('a blank slippage cap refuses a market open before any hold, and a limit open still places', async () => {
      const svc = build({ slippageCapBps: async () => null });
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', type: 'market', qty: A('1'), clientOrderId: 'cap-blank' })),
      ).rejects.toMatchObject({ code: 'trade.slippage_cap_unset', status: 503 });
      expect(engine.submits).toHaveLength(0);
      expect(await held(ALICE)).toBe(0n);
      // Out of the cap's own range is not a cap either: it never means "no cap".
      const odd = build({ slippageCapBps: async () => 0 });
      await expect(
        odd.place(principal(ALICE), order({ userId: ALICE, side: 'buy', type: 'market', qty: A('1'), clientOrderId: 'cap-zero' })),
      ).rejects.toMatchObject({ code: 'trade.slippage_cap_unset' });
      await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'cap-blank-limit' }));
      expect(engine.submits).toHaveLength(1);
    });

    it('a set cap tighter than the band sends and holds a market open at the cap, not the band edge', async () => {
      const svc = build({ slippageCapBps: async () => 50 });
      const buy = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', type: 'market', qty: A('1'), clientOrderId: 'cap-buy' }),
      );
      expect(buy.limitPrice).toBe('100.5');
      expect(engine.submits[0]!.price).toBe('100.5');
      const hold = orderHoldAmount({ side: 'buy', qty: A('1'), limit: A('100.5'), mark: A('100'), leverage: A('10') });
      expect(buy.holdAmount).toBe(formatAmount(hold));
      expect(await held(ALICE)).toBe(hold);
      const sell = await svc.place(
        principal(BOB),
        order({ userId: BOB, side: 'sell', type: 'market', qty: A('1'), clientOrderId: 'cap-sell' }),
      );
      expect(sell.limitPrice).toBe('99.5');
      // The same request again is the same order: no second submit, no second hold.
      await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', type: 'market', qty: A('1'), clientOrderId: 'cap-buy' }));
      expect(engine.submits).toHaveLength(2);
      expect(await held(ALICE)).toBe(hold);
    });

    it('a limit outside the band refuses naming both edges; adjust moves it to the edge and a retry replays it', async () => {
      const svc = build();
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), limitPrice: A('120'), clientOrderId: 'pc-reject' })),
      ).rejects.toMatchObject({ code: 'trade.futures_price_outside_band', message: expect.stringContaining('95 to 105') });
      await expect(
        svc.place(
          principal(ALICE),
          order({ userId: ALICE, side: 'buy', qty: A('1'), limitPrice: A('120'), priceCorrection: 'nudge', clientOrderId: 'pc-bad' }),
        ),
      ).rejects.toMatchObject({ code: 'trade.price_correction_invalid' });
      expect(engine.submits).toHaveLength(0);
      expect(await held(ALICE)).toBe(0n);

      const asked = order({
        userId: ALICE,
        side: 'buy',
        qty: A('1'),
        limitPrice: A('120'),
        priceCorrection: 'adjust',
        clientOrderId: 'pc-adj',
      });
      const placed = await svc.place(principal(ALICE), asked);
      expect(placed.limitPrice).toBe('105');
      expect(engine.submits[0]!.price).toBe('105');
      // The mark moved since: the retry still names the same order (it is moved with the band it was stored with).
      mark = A('102');
      const again = await svc.place(principal(ALICE), asked);
      expect(again.orderId).toBe(placed.orderId);
      expect(engine.submits).toHaveLength(1);
      // A limit inside the band is never moved by adjust.
      const inside = await svc.place(
        principal(BOB),
        order({ userId: BOB, side: 'sell', qty: A('1'), limitPrice: A('101'), priceCorrection: 'adjust', clientOrderId: 'pc-in' }),
      );
      expect(inside.limitPrice).toBe('101');
    });

    it('an order above the max-order is placed as children keyed :1..N within the cap, and the same request never places twice', async () => {
      process.env.TRADE_MAX_ORDER = '1050';
      const svc = build();
      const big = order({ userId: ALICE, side: 'buy', qty: A('25'), clientOrderId: 'split-a' });
      // One order of 25 at 100 is 2500 against a max-order of 1050; children are sized at the band's high edge (105).
      await expect(svc.place(principal(ALICE), big)).rejects.toMatchObject({ code: 'trade.limit_max_order' });
      expect(engine.submits).toHaveLength(0);

      const out = await svc.placeSplit(principal(ALICE), big);
      expect(out.parts).toBe(3);
      expect(out.stopped).toBeNull();
      const tag = splitRequestTag(big);
      expect(tag).toMatch(/^[0-9a-f]{8}$/);
      expect(out.orders.map((o) => [o.clientOrderId, o.qty])).toEqual([
        [`split-a:1:${tag}`, '10'],
        [`split-a:2:${tag}`, '10'],
        [`split-a:3:${tag}`, '5'],
      ]);
      const hold = out.orders.reduce((sum, o) => sum + A(o.holdAmount), 0n);
      expect(await held(ALICE)).toBe(hold);
      await assertBooksAgree();

      // The same request after the mark moved: the same three children, nothing sent or held again.
      mark = A('125');
      const again = await svc.placeSplit(principal(ALICE), big);
      expect(again.orders.map((o) => o.orderId)).toEqual(out.orders.map((o) => o.orderId));
      expect(engine.submits).toHaveLength(3);
      expect(await held(ALICE)).toBe(hold);
    });

    it('the mark rising inside the band between the plan and a child does not refuse that child for size', async () => {
      process.env.TRADE_MAX_ORDER = '1050';
      // The plan reads 100; every child's own check reads 104, still inside the 5 percent band.
      let reads = 0;
      const svc = build({ markFor: async () => (reads++ === 0 ? A('100') : A('104')) });
      const out = await svc.placeSplit(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('20'), clientOrderId: 'drift' }));
      expect(out.orders.map((o) => [o.qty, o.markPrice])).toEqual([
        ['10', '104'],
        ['10', '104'],
      ]);
    });

    it('a crash after child 2 of 3: the same request places only child 3', async () => {
      process.env.TRADE_MAX_ORDER = '1050';
      const svc = build();
      const whole = order({ userId: ALICE, side: 'buy', qty: A('25'), clientOrderId: 'crash' });
      const tag = splitRequestTag(whole);
      // What a crashed attempt left behind: the first two children, placed by key.
      await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('10'), clientOrderId: `crash:1:${tag}` }));
      await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('10'), clientOrderId: `crash:2:${tag}` }));
      const out = await svc.placeSplit(principal(ALICE), whole);
      expect(out.orders.map((o) => o.qty)).toEqual(['10', '10', '5']);
      expect(engine.submits).toHaveLength(3);
      expect(engine.submits[2]!.qty).toBe('5');
      await assertBooksAgree();
    });

    it('children that would not all pass together place none: free balance, max-position', async () => {
      process.env.TRADE_MAX_ORDER = '1050';
      const svc = build();
      // 120 at 100 and 10x holds 1200 together; each child of 10 holds about 100, and 1000 is free.
      await expect(
        svc.placeSplit(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('120'), clientOrderId: 'too-much' })),
      ).rejects.toMatchObject({ code: 'trade.futures_margin_insufficient' });
      process.env.TRADE_MAX_POSITION = '5000';
      await expect(
        svc.placeSplit(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('60'), clientOrderId: 'too-big' })),
      ).rejects.toMatchObject({ code: 'trade.limit_max_position' });
      expect(engine.submits).toHaveLength(0);
      expect(await held(ALICE)).toBe(0n);
      expect(await sql`SELECT 1 FROM trade.futures_orders`).toHaveLength(0);
    });

    it('a split refuses what it cannot split: reduce-only, a lot over the cap, too many children, no key', async () => {
      process.env.TRADE_MAX_ORDER = '1050';
      const svc = build();
      await expect(
        svc.placeSplit(principal(ALICE), order({ userId: ALICE, side: 'sell', qty: A('25'), reduceOnly: true, clientOrderId: 'ro' })),
      ).rejects.toMatchObject({ code: 'trade.split_opening_only' });
      await expect(
        svc.placeSplit(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('25'), clientOrderId: '  ' })),
      ).rejects.toMatchObject({ code: 'trade.client_order_id_required' });
      await expect(
        svc.placeSplit(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('25'), leverage: A('0'), clientOrderId: 'lev0' })),
      ).rejects.toMatchObject({ code: 'trade.leverage_invalid' });
      // 260 is 26 children of 10 (1050 at 105): more than one request places.
      await expect(
        svc.placeSplit(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('260'), clientOrderId: 'many' })),
      ).rejects.toMatchObject({ code: 'trade.limit_max_order', message: expect.stringContaining('26 orders') });
      process.env.TRADE_MAX_ORDER = '0';
      await expect(
        svc.placeSplit(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'zero' })),
      ).rejects.toMatchObject({ code: 'trade.limit_max_order', message: expect.stringContaining('one lot') });
      expect(await held(ALICE)).toBe(0n);
    });

    it('an order within the max-order through the split door is one order under its own key', async () => {
      process.env.TRADE_MAX_ORDER = '1050';
      const svc = build();
      const small = order({ userId: ALICE, side: 'buy', qty: A('5'), clientOrderId: 'small' });
      const out = await svc.placeSplit(principal(ALICE), small);
      expect(out).toMatchObject({ parts: 1, orders: [{ clientOrderId: `small:1:${splitRequestTag(small)}`, qty: '5' }], stopped: null });
    });

    it('a key names one request: another size, price or side under it, or a single order under it, refuses before anything', async () => {
      process.env.TRADE_MAX_ORDER = '1050';
      const svc = build();
      // A crash after child 1 of a 25 split; then the same key with 40, a new price, or the other side.
      const first = order({ userId: ALICE, side: 'buy', qty: A('25'), clientOrderId: 'k' });
      await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('10'), clientOrderId: `k:1:${splitRequestTag(first)}` }),
      );
      for (const other of [
        { ...first, qty: A('40') },
        { ...first, limitPrice: A('99') },
        { ...first, priceCorrection: 'adjust' },
        { ...first, side: 'sell' as const },
      ]) {
        await expect(svc.placeSplit(principal(ALICE), other)).rejects.toMatchObject({
          code: 'trade.client_order_id_conflict',
          status: 409,
        });
      }
      await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'single' }));
      await expect(
        svc.placeSplit(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('25'), clientOrderId: 'single' })),
      ).rejects.toMatchObject({ code: 'trade.client_order_id_conflict' });
      expect(engine.submits).toHaveLength(2);
      // A key that only shares the prefix is not a child: `k:x` is its own request.
      const prefixed = await svc.placeSplit(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('5'), clientOrderId: 'k:x' }));
      expect(prefixed.orders).toHaveLength(1);
      // And the first request finishes: child 1 replays, children 2 and 3 are placed.
      const done = await svc.placeSplit(principal(ALICE), first);
      expect(done.orders.map((o) => o.qty)).toEqual(['10', '10', '5']);
      expect(engine.submits).toHaveLength(5);
    });

    it('a whole order off the lot step refuses before any child; a child refused later names the children already live', async () => {
      process.env.TRADE_MAX_ORDER = '1050';
      const svc = build();
      await expect(
        svc.placeSplit(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('25.00005'), clientOrderId: 'off-lot' })),
      ).rejects.toMatchObject({ code: 'trade.close_quantity_lot_step' });
      expect(engine.submits).toHaveLength(0);

      // Child 2's own check reads a mark past the band its size was planned at (100 at the plan, 110 after child 1).
      let reads = 0;
      const drifting = build({ markFor: async () => (reads++ < 2 ? A('100') : A('110')) });
      const out = await drifting.placeSplit(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('25'), clientOrderId: 'stops' }));
      expect(out.orders.map((o) => o.qty)).toEqual(['10']);
      expect(out.stopped).toMatchObject({ child: 2, code: expect.stringMatching(/^trade\./) });
      expect(await held(ALICE)).toBe(A(out.orders[0]!.holdAmount));
      await assertBooksAgree();
    });
  });

  describe('collateral (D-margin-02): what an opening order is posted from, and the owner’s haircut', () => {
    const saved: Record<string, string | undefined> = {};
    const ENV = ['TRADE_COLLATERAL_HAIRCUT_BPS', 'TRADE_FUTURES_ENABLED', 'TRADE_FUTURES_JOBS_ENABLED'] as const;
    beforeEach(() => {
      for (const key of ENV) saved[key] = process.env[key];
      process.env.TRADE_FUTURES_ENABLED = 'true';
      process.env.TRADE_FUTURES_JOBS_ENABLED = 'true';
      delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
    });
    afterEach(() => {
      for (const key of ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    /** The production wiring: book orders through the position service, which supplies the haircut check. */
    function positions(ledgerPort: LedgerClient = ledger): PositionService {
      const marks = memoryMarkBook();
      marks.set({ marketId: MARKET, symbol: SYMBOL, price: '100', quality: 'mid', asOfMs: NOW.getTime() });
      marks.set({ marketId: ETH_MARKET, symbol: ETH_SYMBOL, price: '100', quality: 'mid', asOfMs: NOW.getTime() });
      return new PositionService(sql, ledgerPort, {
        marks: marks.source(),
        profitSource: null,
        maxLeverage: A('10'),
        now: () => NOW,
        accountAdmission: admission,
        emailProof: { get: async () => 'accepted' } as never,
        matchedOrders: {
          matching: engine as unknown as MatchingClient,
          enabled: true,
          priceBand: A('0.05'),
          lifecycleProof: async () => PROOF,
          feeRates: async () => feeRates,
        },
      });
    }

    const ordersOf = (userId: string) =>
      sql<{ client_order_id: string; status: string; refusal_code: string | null }[]>`
        SELECT client_order_id, status, refusal_code FROM trade.futures_orders WHERE user_id = ${userId} ORDER BY client_order_id
      `;

    it('a blank haircut refuses an opening order with trade.haircut_unset and holds nothing', async () => {
      const svc = positions();
      await expect(
        svc.placeMatchedOrder(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2'), clientOrderId: 'blank' })),
      ).rejects.toMatchObject({ code: 'trade.haircut_unset' });
      // The row records the refusal, as an unfunded hold does; nothing was held.
      expect(await ordersOf(ALICE)).toEqual([{ client_order_id: 'blank', status: 'refused', refusal_code: 'trade.haircut_unset' }]);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
      const figures = await svc.collateralFigures(ALICE, USDT);
      expect(figures).toMatchObject({ free: A('1000'), haircutBps: null, credit: null, buyingPower: null });
    });

    it('the hold must fit inside posted cash less the haircut, counting what is already committed', async () => {
      process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '1000';
      const svc = positions();
      // 2 at 100, 10x: a hold of 20. Credit is 1000 less 10% = 900.
      const first = await svc.placeMatchedOrder(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2'), clientOrderId: 'c1' }));
      expect(first.holdAmount).toBe('20');
      // Posted is still 1000 (980 free and 20 held), committed is 20, so 880 is left to hold.
      expect(await svc.collateralFigures(ALICE, USDT)).toEqual({
        free: A('980'),
        posted: A('1000'),
        committed: A('20'),
        haircutBps: 1000,
        credit: A('900'),
        buyingPower: A('880'),
      });
      // A hold of 890 is past what is left: refused, nothing held, although 980 is free.
      await expect(
        svc.placeMatchedOrder(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('89'), clientOrderId: 'c2' })),
      ).rejects.toMatchObject({ code: 'trade.haircut_credit_short' });
      expect((await ordersOf(ALICE)).map((o) => [o.client_order_id, o.status, o.refusal_code])).toEqual([
        ['c1', 'open', null],
        ['c2', 'refused', 'trade.haircut_credit_short'],
      ]);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('980'));
      // A hold of exactly 880 fits.
      const third = await svc.placeMatchedOrder(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('88'), clientOrderId: 'c3' }));
      expect(third.holdAmount).toBe('880');
      expect((await svc.collateralFigures(ALICE, USDT)).buyingPower).toBe(0n);
      await assertBooksAgree();
    });

    it('two opens placed together cannot both pass on credit that covers only one', async () => {
      process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '1000';
      const svc = positions();
      // Credit is 900. Each hold is 500 (50 at 100, 10x): either fits alone, both together do not.
      const results = await Promise.allSettled(
        ['p1', 'p2'].map((clientOrderId) =>
          svc.placeMatchedOrder(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('50'), clientOrderId })),
        ),
      );
      const refused = results.filter((r) => r.status === 'rejected');
      expect(refused.length).toBeGreaterThanOrEqual(1);
      for (const r of refused) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'trade.haircut_credit_short' });
      const figures = await svc.collateralFigures(ALICE, USDT);
      expect(figures.committed <= figures.credit!).toBe(true);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('500') * BigInt(2 - refused.length));
      await assertBooksAgree();
    });

    it('a leverage change counts what live opening orders hold and commit, so it cannot spend credit they rely on', async () => {
      process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '1000';
      const svc = positions();
      // Posted is 1000 (120 free, 20 in the position, 860 held), committed 880, credit 900: 20 of buying power left.
      const target = await aliceWithRestingOrder(svc);
      expect(await svc.collateralFigures(ALICE, USDT)).toMatchObject({ free: A('120'), committed: A('880'), buyingPower: A('20') });
      // 2x needs 80 more. The 120 free covers it, and so would the haircut without the order (126 against 100), but not
      // with it: 900 against 960. Nothing moves.
      await expect(svc.setLeverage({ ...target, leverage: A('2'), clientAdjustmentId: 'lev-2x' }, principal(ALICE))).rejects.toMatchObject({
        code: 'trade.haircut_credit_short',
      });
      expect(parseAmount((await positionsOf(ALICE))[0]!.margin_current)).toBe(A('20'));
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('120'));
      // 5x needs exactly the 20 left: it fits.
      await svc.setLeverage({ ...target, leverage: A('5'), clientAdjustmentId: 'lev-5x' }, principal(ALICE));
      expect(parseAmount((await positionsOf(ALICE))[0]!.margin_current)).toBe(A('40'));
      expect((await svc.collateralFigures(ALICE, USDT)).buyingPower).toBe(0n);
      await assertBooksAgree();
    });

    /** Alice with a 2 at 100, 10x position (initial margin 20) and an opening order resting on 860: 20 of credit left. */
    async function aliceWithRestingOrder(svc: PositionService) {
      const buy = await svc.placeMatchedOrder(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('2'), clientOrderId: 'pos-open' }),
      );
      const sell = await build().place(
        principal(BOB),
        order({ userId: BOB, side: 'sell', qty: A('2'), limitPrice: A('100'), clientOrderId: 'pos-bob' }),
      );
      await build().settleFill({
        marketId: MARKET,
        makerOrderId: buy.orderId,
        takerOrderId: sell.orderId,
        price: '100',
        qty: '2',
        sequence: 1,
      });
      await svc.placeMatchedOrder(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('86'), clientOrderId: 'pos-rest' }));
      const [position] = await positionsOf(ALICE);
      return { userId: ALICE, symbol: SYMBOL, positionId: position!.id };
    }

    const ETH_MARKET = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const ETH_SYMBOL = 'ETH/USDT-PERP';

    it('an opening order checked while a leverage change is still writing waits for it, so both cannot take the last of the credit', async () => {
      process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '1000';
      await sql`
        INSERT INTO trade.markets (
          id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
          maker_bps, taker_bps, status, display_name, listed_at
        ) VALUES (
          ${ETH_MARKET}, ${ETH_SYMBOL}, 'ETH', 'USDT', 'futures', '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', 'ETH perpetual', now()
        )
      `;
      const target = await aliceWithRestingOrder(positions());
      // The leverage change has passed its check and stops at its margin post, its new initial margin not yet written.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let posting!: () => void;
      const reachedPost = new Promise<void>((resolve) => (posting = resolve));
      const slowPost = withLedger({
        post: async (req: Parameters<LedgerClient['post']>[0]) => {
          posting();
          await gate;
          return ledger.post(req);
        },
      });
      // 5x needs 20 more; an order of 2 at 100, 10x, on another market holds 20. Either fits alone, both do not.
      const leverage = positions(slowPost).setLeverage({ ...target, leverage: A('5'), clientAdjustmentId: 'race-5x' }, principal(ALICE));
      await reachedPost;
      const placing = positions().placeMatchedOrder(
        principal(ALICE),
        order({ userId: ALICE, symbol: ETH_SYMBOL, side: 'buy', qty: A('2'), clientOrderId: 'race-eth' }),
      );
      // Given time, an order that did not wait would be placed on credit the leverage change has already taken.
      await Promise.race([placing.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
      release();
      await leverage;
      await expect(placing).rejects.toMatchObject({ code: 'trade.haircut_credit_short' });
      expect(parseAmount((await positionsOf(ALICE))[0]!.margin_current)).toBe(A('40'));
      const figures = await positions().collateralFigures(ALICE, USDT);
      expect(figures).toMatchObject({ committed: A('900'), credit: A('900'), buyingPower: 0n });
      await assertBooksAgree();
    });

    it('a leverage change whose collateral read fails refuses trade.collateral_unreadable (503) and moves nothing', async () => {
      process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '1000';
      const target = await aliceWithRestingOrder(positions());
      const down = positions(withLedger({ balances: async () => Promise.reject(new Error('ledger down')) }));
      await expect(
        down.setLeverage({ ...target, leverage: A('5'), clientAdjustmentId: 'down-5x' }, principal(ALICE)),
      ).rejects.toMatchObject({
        code: 'trade.collateral_unreadable',
        status: 503,
      });
      expect(parseAmount((await positionsOf(ALICE))[0]!.margin_current)).toBe(A('20'));
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('120'));
      // The same request goes through once the ledger reads again.
      await positions().setLeverage({ ...target, leverage: A('5'), clientAdjustmentId: 'down-5x' }, principal(ALICE));
      expect(parseAmount((await positionsOf(ALICE))[0]!.margin_current)).toBe(A('40'));
      await assertBooksAgree();
    });

    /** The ledger with some of its methods replaced; everything else is the real one. */
    function withLedger(overrides: Partial<Record<keyof LedgerClient, unknown>>): LedgerClient {
      return new Proxy(ledger, {
        get(target, key) {
          if (key in overrides) return overrides[key as keyof LedgerClient];
          const value = Reflect.get(target, key) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    }

    it('a hold that posts while the figures are read is counted once, never in free and in the hold both', async () => {
      process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '1000';
      // Order B's hold post waits on a gate: B is a pending row whose 500 is still in free.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let posting!: () => void;
      const reachedPost = new Promise<void>((resolve) => (posting = resolve));
      const slowPost = withLedger({
        post: async (req: Parameters<LedgerClient['post']>[0]) => {
          posting();
          await gate;
          return ledger.post(req);
        },
      });
      const placingB = positions(slowPost).placeMatchedOrder(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('50'), clientOrderId: 'race-b' }),
      );
      await reachedPost;
      // The figures read the ledger, then B's hold posts and B is held, then the figures read the rows.
      const racing = withLedger({
        balances: async (...args: Parameters<LedgerClient['balances']>) => {
          const read = await ledger.balances(...args);
          release();
          await placingB;
          return read;
        },
      });
      const figures = await positions(racing).collateralFigures(ALICE, USDT);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('500'));
      // 1000 of cash in all: 1000 free when it was read, B's 500 not yet in its hold. B's 500 is committed once.
      expect(figures).toMatchObject({ posted: A('1000'), committed: A('500'), credit: A('900'), buyingPower: A('400') });
      // So a second 500 does not fit, with B's posted.
      await expect(
        positions().placeMatchedOrder(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('50'), clientOrderId: 'race-a' })),
      ).rejects.toMatchObject({ code: 'trade.haircut_credit_short' });
      await assertBooksAgree();
    });

    it('a ledger that cannot be read refuses with trade.collateral_unreadable (503), holds nothing, and leaves the order to retry', async () => {
      process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '0';
      const down = new Proxy(ledger, {
        get(target, key) {
          if (key === 'balance' || key === 'balances') return async () => Promise.reject(new Error('ledger read timed out'));
          const value = Reflect.get(target, key) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      await expect(
        positions(down).placeMatchedOrder(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2'), clientOrderId: 'u1' })),
      ).rejects.toMatchObject({ code: 'trade.collateral_unreadable', status: 503 });
      expect(await ordersOf(ALICE)).toEqual([{ client_order_id: 'u1', status: 'pending', refusal_code: null }]);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
      // With the ledger back, the same request resumes the order and holds it once.
      const resumed = await positions().placeMatchedOrder(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('2'), clientOrderId: 'u1' }),
      );
      expect(resumed.holdAmount).toBe('20');
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('980'));
    });

    it('a filled position counts its initial margin as committed and its pot as posted', async () => {
      process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '0';
      const svc = positions();
      const buy = await svc.placeMatchedOrder(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('2'), clientOrderId: 'f1' }));
      const sell = await svc.placeMatchedOrder(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('2'), clientOrderId: 'f2' }));
      await build().settleFill({
        marketId: MARKET,
        makerOrderId: buy.orderId,
        takerOrderId: sell.orderId,
        price: '100',
        qty: '2',
        sequence: 900,
      });
      expect(await svc.collateralFigures(ALICE, USDT)).toMatchObject({
        free: A('980'),
        posted: A('1000'),
        committed: A('20'),
        buyingPower: A('980'),
      });
    });

    it('a non-cash class refuses an opening order on its code; omitted or cash is margin from cash', async () => {
      process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '0';
      const svc = positions();
      for (const collateralClass of ['yield_bearing', 'staked', 'lending_idle', 'bonds']) {
        await expect(
          svc.placeMatchedOrder(
            principal(ALICE),
            order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: `k-${collateralClass}`, collateralClass }),
          ),
        ).rejects.toMatchObject({ code: 'trade.unsupported_collateral_class' });
      }
      // Refused before any row is written: the class is checked with the request's other fields.
      expect(await ordersOf(ALICE)).toHaveLength(0);
      await svc.placeMatchedOrder(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'k-cash', collateralClass: 'cash' }),
      );
      expect(await ordersOf(ALICE)).toHaveLength(1);
    });
  });

  describe('the confirm step before a higher margin tier (D-orders-10, J-derivatives-02 #6)', () => {
    // Depth 1,000 USDT: tier 1 holds up to 50 USDT of notional (0.5 at 100), tier 2 up to 200 (2), tier 3 the rest.
    const POLICY = {
      tiers: [
        { uptoDepthBps: 500, maintenanceBps: 50 },
        { uptoDepthBps: 2_000, maintenanceBps: 100 },
        { uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 },
      ],
      marginCallBps: 12_000,
      targetBps: 15_000,
      maxTrancheBps: 2_500,
    };
    let depth: bigint | null;
    beforeEach(() => {
      depth = A('1000');
    });

    function tiered(overrides: Partial<MatchedOrdersDeps> = {}): MatchedFuturesOrders {
      const positions = new PositionService(sql, ledger, {
        marks: memoryMarkBook().source(),
        profitSource: null,
        maxLeverage: A('10'),
        now: () => NOW,
        ladder: {
          depth: {
            depthNotional: async () => {
              if (depth === null) throw new Error('depth read failed');
              return depth;
            },
          },
          policy: POLICY,
        },
      });
      return build({ riskTier: (input) => positions.riskTierCrossing(input), ...overrides });
    }

    async function ordersOf(userId: string) {
      return sql<{ client_order_id: string; qty: string }[]>`
        SELECT client_order_id, qty FROM trade.futures_orders WHERE user_id = ${userId} ORDER BY created_at, client_order_id
      `;
    }

    it('an order that stays in tier 1 places without a confirm', async () => {
      const placed = await tiered().place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.4'), clientOrderId: 't1' }));
      expect(placed.status).toBe('open');
      expect(engine.submits).toHaveLength(1);
    });

    it('adding size past the tier the side sits in refuses naming the new tier and its leverage; nothing is held', async () => {
      const svc = tiered();
      await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.4'), clientOrderId: 'add-1' }));
      const free = await bal(userAvailable(ALICE, USDT));
      // The resting 0.4 can still fill into the position, so 0.4 more is 80 USDT: tier 2.
      const add = order({ userId: ALICE, side: 'buy', qty: A('0.4'), clientOrderId: 'add-2' });
      const refused = svc.place(principal(ALICE), add);
      await expect(refused).rejects.toMatchObject({ code: 'trade.risk_limit_confirm_required', status: 409 });
      await expect(refused).rejects.toThrow(
        'this order moves the position from tier 1 into tier 2 (maintenance 1.00%) at 10x leverage; every tier answers to the listing cap of 10x. Send confirmTier 2 to place it',
      );
      expect(engine.submits).toHaveLength(1);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(free);
      expect((await ordersOf(ALICE)).map((o) => o.client_order_id)).toEqual(['add-1']);

      // A confirm for a lower tier is no confirm for this one.
      await expect(svc.place(principal(ALICE), { ...add, confirmTier: 1 })).rejects.toMatchObject({
        code: 'trade.risk_limit_confirm_required',
      });
      // The same request naming tier 2 goes ahead under the same key.
      const placed = await svc.place(principal(ALICE), { ...add, confirmTier: 2 });
      expect(placed.clientOrderId).toBe('add-2');
      expect(engine.submits).toHaveLength(2);
      await assertBooksAgree();

      // Inside tier 2 no confirm is asked again; past it, the next tier is.
      await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.5'), clientOrderId: 'add-3' }));
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'add-4', confirmTier: 2 })),
      ).rejects.toThrow('from tier 2 into tier 3 (maintenance 5.00%)');
    });

    it('a filled position counts, and the other side and other accounts do not', async () => {
      const svc = tiered();
      const a = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.4'), clientOrderId: 'pos-a' }));
      const b = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('0.4'), clientOrderId: 'pos-b' }));
      await svc.settleFill({ marketId: MARKET, makerOrderId: a.orderId, takerOrderId: b.orderId, price: '100', qty: '0.4', sequence: 7 });
      expect(parseAmount((await positionsOf(ALICE))[0]!.size)).toBe(A('0.4'));
      // Carol has nothing: her 0.4 stays in tier 1 whatever Alice holds.
      await svc.place(principal(CAROL), order({ userId: CAROL, side: 'buy', qty: A('0.4'), clientOrderId: 'pos-c' }));
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.2'), clientOrderId: 'pos-a2' })),
      ).rejects.toMatchObject({ code: 'trade.risk_limit_confirm_required' });
      await assertBooksAgree();
    });

    it('a first order straight into a high tier asks too, naming the tier it opens in', async () => {
      const big = order({ userId: ALICE, side: 'buy', qty: A('3'), clientOrderId: 'big' });
      await expect(tiered().place(principal(ALICE), big)).rejects.toThrow('this order opens the position in tier 3 (maintenance 5.00%)');
      expect(engine.submits).toHaveLength(0);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
      expect((await tiered().place(principal(ALICE), { ...big, confirmTier: 3 })).status).toBe('open');
    });

    it('two orders placed together cannot each stay inside the tier and together cross it: the later rating refuses', async () => {
      const positions = new PositionService(sql, ledger, {
        marks: memoryMarkBook().source(),
        profitSource: null,
        maxLeverage: A('10'),
        now: () => NOW,
        ladder: { depth: { depthNotional: async () => A('1000') }, policy: POLICY },
      });
      // Order B (0.3) is placed in full while order A (0.3) is between its first rating and writing its row: each alone
      // stays in tier 1 (30 of 50), together they are 60, tier 2.
      let racing = true;
      const svc: MatchedFuturesOrders = build({
        riskTier: async (input) => {
          const crossing = await positions.riskTierCrossing(input);
          if (racing && input.excludeOrderId === undefined) {
            racing = false;
            await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.3'), clientOrderId: 'race-b' }));
          }
          return crossing;
        },
      });
      const a = order({ userId: ALICE, side: 'buy', qty: A('0.3'), clientOrderId: 'race-a' });
      await expect(svc.place(principal(ALICE), a)).rejects.toMatchObject({ code: 'trade.risk_limit_confirm_required', status: 409 });
      // A's row is kept, refused before its hold posted; only B rests and holds.
      const rows = await sql<{ client_order_id: string; status: string; refusal_code: string | null }[]>`
        SELECT client_order_id, status, refusal_code FROM trade.futures_orders WHERE user_id = ${ALICE} ORDER BY client_order_id
      `;
      expect(rows).toEqual([
        { client_order_id: 'race-a', status: 'refused', refusal_code: 'trade.risk_limit_confirm_required' },
        { client_order_id: 'race-b', status: 'open', refusal_code: null },
      ]);
      expect(engine.submits).toHaveLength(1);
      await assertBooksAgree();
    });

    it('a confirmTier above the ladder names no tier and refuses before any hold', async () => {
      await expect(
        tiered().place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.1'), clientOrderId: 'tier-9', confirmTier: 9 })),
      ).rejects.toMatchObject({ code: 'trade.confirm_tier_invalid', status: 400 });
      expect(engine.submits).toHaveLength(0);
      expect(await ordersOf(ALICE)).toHaveLength(0);
    });

    it('an unreadable depth refuses before any hold: no tier can be named', async () => {
      depth = null;
      await expect(
        tiered().place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.1'), clientOrderId: 'no-depth' })),
      ).rejects.toMatchObject({ code: 'trade.depth_unknown', status: 503 });
      expect(engine.submits).toHaveLength(0);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
      expect(await ordersOf(ALICE)).toHaveLength(0);
    });

    it('a reduce-only order is never asked to confirm a tier', async () => {
      const svc = tiered();
      const a = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'buy', qty: A('3'), clientOrderId: 'ro-a', confirmTier: 3 }),
      );
      const b = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('3'), clientOrderId: 'ro-b', confirmTier: 3 }));
      await svc.settleFill({ marketId: MARKET, makerOrderId: a.orderId, takerOrderId: b.orderId, price: '100', qty: '3', sequence: 9 });
      const close = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'sell', qty: A('1'), clientOrderId: 'ro-close', reduceOnly: true, type: 'market' }),
      );
      expect(close.reduceOnly).toBe(true);
    });

    describe('through the split door', () => {
      const saved = process.env.TRADE_MAX_ORDER;
      afterEach(() => {
        if (saved === undefined) delete process.env.TRADE_MAX_ORDER;
        else process.env.TRADE_MAX_ORDER = saved;
      });

      it('the whole order is rated before any child is placed, and a confirm places every child', async () => {
        process.env.TRADE_MAX_ORDER = '105';
        const svc = tiered();
        const whole = order({ userId: ALICE, side: 'buy', qty: A('3'), clientOrderId: 'split-tier' });
        await expect(svc.placeSplit(principal(ALICE), whole)).rejects.toMatchObject({
          code: 'trade.risk_limit_confirm_required',
          status: 409,
        });
        expect(engine.submits).toHaveLength(0);
        expect(await ordersOf(ALICE)).toHaveLength(0);

        const out = await svc.placeSplit(principal(ALICE), { ...whole, confirmTier: 3 });
        expect(out.stopped).toBeNull();
        expect(out.orders.map((o) => o.qty)).toEqual(['1', '1', '1']);
        // The confirm is not part of the request's identity: the same request again replays the same children.
        const tag = splitRequestTag(whole);
        expect(out.orders.map((o) => o.clientOrderId)).toEqual([1, 2, 3].map((n) => `split-tier:${n}:${tag}`));
        await assertBooksAgree();
      });
    });
  });

  describe('open-interest and share limits (D-margin-05, J-derivatives-02 #7)', () => {
    // A market limit of 10 BTC, and at most 10% of it (1 BTC) per account.
    let limits: { limit: bigint; shareBps: number } | null;
    beforeEach(() => {
      limits = { limit: A('10'), shareBps: 1_000 };
    });

    function positionsWithLimits(): PositionService {
      return new PositionService(sql, ledger, {
        marks: memoryMarkBook().source(),
        profitSource: null,
        maxLeverage: A('10'),
        now: () => NOW,
        matchedOrders: {
          matching: null,
          enabled: false,
          priceBand: null,
          lifecycleProof: null,
          openInterestLimits: async () => limits as never,
        },
      });
    }

    function limited(overrides: Partial<MatchedOrdersDeps> = {}): MatchedFuturesOrders {
      const positions = positionsWithLimits();
      return build({ openInterest: (input) => positions.openInterestRoom(input), ...overrides });
    }

    async function liveOrders(userId: string) {
      return sql<{ client_order_id: string; status: string; refusal_code: string | null }[]>`
        SELECT client_order_id, status, refusal_code FROM trade.futures_orders WHERE user_id = ${userId} ORDER BY client_order_id
      `;
    }

    it('an open past the account share refuses with the room left; nothing is held or written', async () => {
      const svc = limited();
      await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.6'), clientOrderId: 'oi-1' }));
      const free = await bal(userAvailable(ALICE, USDT));
      // The resting 0.6 counts: 0.5 more is 1.1 of a 1 BTC share.
      const over = svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.5'), clientOrderId: 'oi-2' }));
      await expect(over).rejects.toMatchObject({ code: 'trade.oi_share_limit', status: 422 });
      await expect(over).rejects.toThrow(
        "this order would take your open interest on this market to 1.1 BTC, past the 1 BTC one account may hold (10% of the market's limit of 10 BTC); room left 0.4 BTC",
      );
      expect(engine.submits).toHaveLength(1);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(free);
      expect((await liveOrders(ALICE)).map((o) => o.client_order_id)).toEqual(['oi-1']);
      // The room it named places; exactly at the share is allowed.
      await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.4'), clientOrderId: 'oi-3' }));
      expect(engine.submits).toHaveLength(2);
      await assertBooksAgree();
    });

    it("filled positions count on both sides, and another account's share is its own", async () => {
      const svc = limited();
      const a = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'oi-pa' }));
      const b = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('1'), clientOrderId: 'oi-pb' }));
      await svc.settleFill({ marketId: MARKET, makerOrderId: a.orderId, takerOrderId: b.orderId, price: '100', qty: '1', sequence: 11 });
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.0001'), clientOrderId: 'oi-pa2' })),
      ).rejects.toMatchObject({ code: 'trade.oi_share_limit' });
      await expect(
        svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('0.0001'), clientOrderId: 'oi-pb2' })),
      ).rejects.toMatchObject({ code: 'trade.oi_share_limit' });
      // Carol holds nothing yet: her whole share is open to her.
      await svc.place(principal(CAROL), order({ userId: CAROL, side: 'buy', qty: A('1'), clientOrderId: 'oi-pc' }));
      await assertBooksAgree();
    });

    it("the market's limit refuses with the market's room when it is the nearer one", async () => {
      limits = { limit: A('2'), shareBps: 10_000 };
      const svc = limited();
      await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('1.5'), clientOrderId: 'oi-mb' }));
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.6'), clientOrderId: 'oi-ma' })),
      ).rejects.toThrow("this order would take the market's open interest to 2.1 BTC, past its limit of 2 BTC; room left 0.5 BTC");
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.6'), clientOrderId: 'oi-ma' })),
      ).rejects.toMatchObject({ code: 'trade.oi_limit', status: 422 });
    });

    it('a blank limit refuses every open on the market before any hold; a close still goes', async () => {
      const svc = limited();
      const a = await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.5'), clientOrderId: 'oi-ua' }));
      const b = await svc.place(principal(BOB), order({ userId: BOB, side: 'sell', qty: A('0.5'), clientOrderId: 'oi-ub' }));
      await svc.settleFill({ marketId: MARKET, makerOrderId: a.orderId, takerOrderId: b.orderId, price: '100', qty: '0.5', sequence: 12 });
      limits = null;
      const free = await bal(userAvailable(CAROL, USDT));
      await expect(
        svc.place(principal(CAROL), order({ userId: CAROL, side: 'buy', qty: A('0.1'), clientOrderId: 'oi-uc' })),
      ).rejects.toMatchObject({ code: 'trade.oi_limit_unset', status: 503 });
      expect(await bal(userAvailable(CAROL, USDT))).toBe(free);
      expect(await liveOrders(CAROL)).toHaveLength(0);
      // Reduce-only never meets the limit: a trader can always leave.
      const close = await svc.place(
        principal(ALICE),
        order({ userId: ALICE, side: 'sell', qty: A('0.5'), clientOrderId: 'oi-close', reduceOnly: true, type: 'market' }),
      );
      expect(close.reduceOnly).toBe(true);
    });

    it('two opens placed together near the share: the later check, after its row is written, refuses', async () => {
      const positions = positionsWithLimits();
      let racing = true;
      const svc: MatchedFuturesOrders = build({
        openInterest: async (input) => {
          const room = await positions.openInterestRoom(input);
          if (racing && input.excludeOrderId === undefined) {
            racing = false;
            await svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.6'), clientOrderId: 'oi-race-b' }));
          }
          return room;
        },
      });
      // Each 0.6 alone fits the 1 BTC share; together they are 1.2.
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.6'), clientOrderId: 'oi-race-a' })),
      ).rejects.toMatchObject({ code: 'trade.oi_share_limit' });
      expect(await liveOrders(ALICE)).toEqual([
        { client_order_id: 'oi-race-a', status: 'refused', refusal_code: 'trade.oi_share_limit' },
        { client_order_id: 'oi-race-b', status: 'open', refusal_code: null },
      ]);
      expect(engine.submits).toHaveLength(1);
      await assertBooksAgree();
    });

    it('a limit blanked between the first check and the row check refuses the order and keeps its row, refused', async () => {
      const positions = positionsWithLimits();
      const svc = build({
        openInterest: async (input) => {
          if (input.excludeOrderId !== undefined) limits = null;
          return positions.openInterestRoom(input);
        },
      });
      await expect(
        svc.place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('0.1'), clientOrderId: 'oi-blanked' })),
      ).rejects.toMatchObject({ code: 'trade.oi_limit_unset', status: 503 });
      // Refused, so it no longer counts in anyone's open interest, and nothing was held.
      expect(await liveOrders(ALICE)).toEqual([{ client_order_id: 'oi-blanked', status: 'refused', refusal_code: 'trade.oi_limit_unset' }]);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
      await assertBooksAgree();
    });

    describe('through the split door', () => {
      const saved = process.env.TRADE_MAX_ORDER;
      afterEach(() => {
        if (saved === undefined) delete process.env.TRADE_MAX_ORDER;
        else process.env.TRADE_MAX_ORDER = saved;
      });

      it('the whole order is checked before any child is placed', async () => {
        process.env.TRADE_MAX_ORDER = '50';
        const svc = limited();
        await expect(
          svc.placeSplit(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1.2'), clientOrderId: 'oi-split' })),
        ).rejects.toMatchObject({ code: 'trade.oi_share_limit' });
        expect(engine.submits).toHaveLength(0);
        expect(await liveOrders(ALICE)).toHaveLength(0);
        const out = await svc.placeSplit(
          principal(ALICE),
          order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'oi-split-ok' }),
        );
        expect(out.stopped).toBeNull();
        expect(out.orders.length).toBeGreaterThan(1);
        await assertBooksAgree();
      });
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
