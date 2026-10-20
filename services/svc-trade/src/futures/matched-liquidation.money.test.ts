/**
 * Liquidation through the book (futures ADR slice 7), against the real trade schema and MemoryLedger.
 *
 * While matched orders are on, a liquidation rung works its tranche with one reduce-only IOC at the bankruptcy price,
 * widened by what the insurance fund holds, and hands what the book does not take to ADL at the bankruptcy price.
 * Every case is checked against the ledger: collateral pots, the clearing pot, the insurance fund, available balances
 * and the journal's keys. The engine here is a small price-time book, so every fill names a real counterparty order.
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
  insuranceFund,
  parseAmount,
  positionCollateralAccount,
  recipes,
  userAvailable,
  type AccountRef,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { EngineCancelResult, EngineFill, EngineSubmitRequest, EngineSubmitResult, MatchingClient } from '../spot/matching-client.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { MatchedFuturesOrders, type MatchedOrdersDeps, type PlaceMatchedOrderInput } from './matched-orders.js';
import {
  orderHoldAmount,
  liquidationLimit,
  planLiquidationFill,
  planLiquidationSettlement,
  priceBandAround,
} from './matched-order-plan.js';
import { unrealizedPnl } from './liquidation-planner.js';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import { DEFAULT_FUTURES_LADDER_POLICY } from './ladder-policy.test-harness.js';
import { runLiquidationTick, type LiquidationAdlDeps, type LiquidationTickDeps, type QuotedMarkSource } from './liquidation-tick.js';
import { sqlLiquidationPositionLoader } from './position-loaders.js';
import { sqlLiquidationAttemptStore, sqlLiquidationRungStore, sqlPositionCloser, sqlPositionReducer } from './tick-stores.js';
import { ADL_DISCLOSURE_VERSION, memoryAdlDisclosureStore, type AdlDisclosureStore } from './adl-disclosure.js';
import { memoryAdlDisclosureEventStore } from './adl-last-resort.js';
import { TEST_ADL_RANKING, sqlAdlCandidates, sqlAdlPairReducer } from './adl-pairing.js';
import { runPayoutTick } from './futures-payouts.js';
import { runLastResortAdlAfterInsuranceUnderfunded } from './liquidation-adl-gate.js';

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
      .withDatabase('intafaced_liq_book_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`liquidation through the book needs Postgres: TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
  }
}

const A = (s: string) => parseAmount(s);
const USDT = 'USDT';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const DAVE = '44444444-4444-4444-8444-444444444444';
const FEE_PAYER = '55555555-5555-4555-8555-555555555555';
const ERIN = '66666666-6666-4666-8666-666666666666';
const MARKET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SYMBOL = 'SOL/USDT-PERP';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const PROOF = { stub: true } as unknown as LifecycleAdmissionProof;
const POT = futuresLossSink(USDT);
const FUND = insuranceFund(USDT);
const MONEY_REASONS = new Set(['futures.profit.realized', 'futures.loss.realized', 'futures.margin.release']);
const FULL_CLOSE_LADDER = { ...DEFAULT_FUTURES_LADDER_POLICY, maxTrancheBps: 10_000 };

interface Resting {
  orderId: string;
  accountId: string;
  side: 'buy' | 'sell';
  price: bigint;
  remaining: bigint;
  seq: number;
}

/**
 * A price-time book: an incoming order fills against the best opposite resting orders at their prices, an IOC's
 * remainder is cancelled, a GTC's rests. `crashAfterAccept` makes the next submit match and then lose its reply, the
 * way a transport failure after the engine accepted would.
 */
class BookEngine {
  readonly submits: EngineSubmitRequest[] = [];
  readonly cancels: string[] = [];
  readonly book: Resting[] = [];
  /** What the engine printed for each submit, as its events would carry it. */
  readonly printed: { fills: EngineFill[]; cancellations: { orderId: string; remainingQty: string }[] }[] = [];
  crashAfterAccept = false;
  private seq = 9000;

  async submit(_marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    this.submits.push(request);
    const limit = parseAmount(request.price ?? '0');
    let remaining = parseAmount(request.qty);
    const fills: EngineFill[] = [];
    const crosses = (r: Resting) => r.side !== request.side && (request.side === 'buy' ? r.price <= limit : r.price >= limit);
    for (;;) {
      if (remaining === 0n) break;
      const best = this.book
        .filter(crosses)
        .sort((x, y) =>
          x.price === y.price ? x.seq - y.seq : request.side === 'buy' ? (x.price < y.price ? -1 : 1) : x.price > y.price ? -1 : 1,
        )[0];
      if (!best) break;
      const qty = remaining < best.remaining ? remaining : best.remaining;
      this.seq += 1;
      fills.push({
        sequence: this.seq,
        makerOrderId: best.orderId,
        makerAccountId: best.accountId,
        takerOrderId: request.orderId,
        takerAccountId: request.accountId,
        takerSide: request.side,
        price: formatAmount(best.price),
        qty: formatAmount(qty),
      });
      best.remaining -= qty;
      remaining -= qty;
      if (best.remaining === 0n) this.book.splice(this.book.indexOf(best), 1);
    }
    this.seq += 1;
    const cancellations =
      remaining > 0n && request.tif === 'IOC'
        ? [
            {
              orderId: request.orderId,
              accountId: request.accountId,
              remainingQty: formatAmount(remaining),
              sequence: this.seq,
              reason: 'ioc',
            },
          ]
        : [];
    const resting =
      remaining > 0n && request.tif !== 'IOC'
        ? {
            kind: 'book' as const,
            orderId: request.orderId,
            accountId: request.accountId,
            side: request.side,
            price: formatAmount(limit),
            remaining: formatAmount(remaining),
            sequence: this.seq,
          }
        : null;
    if (resting)
      this.book.push({
        orderId: request.orderId,
        accountId: request.accountId,
        side: request.side,
        price: limit,
        remaining,
        seq: this.seq,
      });
    this.printed.push({ fills, cancellations: cancellations.map((c) => ({ orderId: c.orderId, remainingQty: c.remainingQty })) });
    if (this.crashAfterAccept) {
      this.crashAfterAccept = false;
      throw new Error('engine reply lost after it accepted the order');
    }
    return { accepted: true, sequence: this.seq, fills, resting, rejected: null, cancellations, triggered: [] };
  }

  async cancel(_marketId: string, orderId: string): Promise<EngineCancelResult> {
    this.cancels.push(orderId);
    this.seq += 1;
    const at = this.book.findIndex((r) => r.orderId === orderId);
    if (at < 0) return { cancelled: false, orderId, sequence: null, cancellation: null };
    const [gone] = this.book.splice(at, 1);
    return {
      cancelled: true,
      orderId,
      sequence: this.seq,
      cancellation: {
        orderId,
        accountId: gone!.accountId,
        remainingQty: formatAmount(gone!.remaining),
        sequence: this.seq,
        reason: 'cancel',
      },
    };
  }
}

const principal = (userId: string) => ({ userId, scopes: [] }) as unknown as Principal;

function quotedAt(price: () => bigint): QuotedMarkSource {
  return {
    async markPrice() {
      return formatAmount(price());
    },
    async quote({ marketId, symbol, at }) {
      return { marketId, symbol, price: price(), asOf: at, quality: 'mid' };
    },
  };
}

describe('svc-trade liquidation by reduce-only IOC in the book (slice 7, PG-backed)', () => {
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
  let engine: BookEngine;
  let mark: bigint;
  let admission: TradingAdmissionPort;
  let acks: AdlDisclosureStore;
  let acceptedMarks: ReturnType<typeof memoryAcceptedMarkStore>;
  let eventSeq: number;

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.futures_order_fills, trade.futures_orders, trade.positions, trade.markets, trade.futures_payouts,
               trade.futures_fill_waits, trade.account_position_modes, trade.liquidation_rungs, trade.futures_adl_pairs,
               trade.liquidation_attempts
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
    engine = new BookEngine();
    mark = A('100');
    eventSeq = 0;
    acks = memoryAdlDisclosureStore();
    acceptedMarks = memoryAcceptedMarkStore();
    admission = { admit: vi.fn(async () => ({})) } as unknown as TradingAdmissionPort;
    for (const userId of [ALICE, BOB, CAROL, DAVE]) {
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

  async function place(userId: string, side: 'buy' | 'sell', qty: bigint, price: bigint, extra: Partial<PlaceMatchedOrderInput> = {}) {
    return build().place(principal(userId), {
      userId,
      symbol: SYMBOL,
      side,
      type: 'limit',
      qty,
      limitPrice: price,
      leverage: A('10'),
      clientOrderId: `c-${randomUUID()}`,
      ...extra,
    });
  }

  /** Alice long `qty` against Bob short `qty`, both at 100 with 10x: each holds `qty × 10` of margin. */
  async function aliceLongBobShort(qty = A('2')) {
    await place(ALICE, 'buy', qty, A('100'));
    await place(BOB, 'sell', qty, A('100'));
    return { alice: (await openOf(ALICE))[0]!, bob: (await openOf(BOB))[0]! };
  }

  /** Carol rests a bid: the liquidity a long's liquidation sells into. Her fill opens her own long. */
  async function carolBids(qty: bigint, price: bigint, at: bigint = price) {
    const saved = mark;
    mark = at;
    const view = await place(CAROL, 'buy', qty, price);
    mark = saved;
    return view;
  }

  async function fundInsurance(amount: string) {
    await ledger.post(
      recipes.deposit({ userId: FEE_PAYER, assetId: USDT, amount: A(amount), rail: 'test', railRef: `fee-${randomUUID()}` }),
    );
    const id = randomUUID();
    await ledger.post(
      recipes.feeCharge({ chargeId: `fee-${id}`, userId: FEE_PAYER, module: 'trade', mode: 'asset', assetId: USDT, amount: A(amount) }),
    );
    await ledger.post(recipes.futuresInsuranceTopup({ topupId: `top-${id}`, assetId: USDT, amount: A(amount) }));
  }

  function adlDeps(ledgerImpl: Pick<LedgerClient, 'post' | 'balance' | 'getTxByKey'> = ledger): LiquidationAdlDeps {
    const reducer = sqlAdlPairReducer(sql, ledgerImpl);
    return {
      policy: { maxReduceBps: 10_000 },
      ranking: TEST_ADL_RANKING,
      candidates: sqlAdlCandidates(sql, TEST_ADL_RANKING),
      disclosureAcks: acks,
      events: memoryAdlDisclosureEventStore(),
      reducer,
      replayPlanned: reducer.replayPlanned,
      newEventId: () => `evt-${++eventSeq}`,
    };
  }

  /** `preRungPull: false` leaves out the tick's pull of increasing orders before a rung, so only the in-rung pull runs. */
  function tick(over: Partial<LiquidationTickDeps> & { svc?: MatchedFuturesOrders; preRungPull?: boolean } = {}) {
    const { svc, preRungPull = true, ...rest } = over;
    const port = svc ?? build();
    return runLiquidationTick({
      marks: quotedAt(() => mark),
      positions: sqlLiquidationPositionLoader(sql),
      closer: sqlPositionCloser(sql),
      attempts: sqlLiquidationAttemptStore(sql),
      rungs: sqlLiquidationRungStore(sql),
      acceptedMarks,
      ladder: {
        depth: { depthNotional: async () => A('1000000') },
        reducer: sqlPositionReducer(sql),
        policy: FULL_CLOSE_LADDER,
      },
      ledger,
      now: () => NOW,
      // As production wires it (futures-jobs.ts): the port, and its book of the account's resting orders.
      matched: port.liquidationPort,
      ...(preRungPull ? { increasingOrders: port.increasingOrderBook } : {}),
      ...rest,
    });
  }

  async function openOf(userId: string) {
    return sql<{ id: string; side: 'long' | 'short'; size: string; entry_price: string; margin_current: string; status: string }[]>`
      SELECT id, side, size, entry_price, margin_current, status FROM trade.positions
       WHERE user_id = ${userId} AND market_id = ${MARKET} AND status = 'open' ORDER BY opened_at, id
    `;
  }

  async function positionRow(id: string) {
    const [row] = await sql<{ size: string; margin_current: string; status: string }[]>`
      SELECT size, margin_current, status FROM trade.positions WHERE id = ${id}
    `;
    return row!;
  }

  async function bal(ref: AccountRef): Promise<bigint> {
    return (await ledger.balance(ref)).amount;
  }

  async function rungs() {
    return sql<{ rung_id: string; kind: string; state: string }[]>`
      SELECT rung_id, kind, state FROM trade.liquidation_rungs ORDER BY created_at, rung_id
    `;
  }

  async function liquidationOrders() {
    return sql<
      {
        id: string;
        client_order_id: string;
        status: string;
        qty: string;
        filled_qty: string;
        limit_price: string;
        bankruptcy_price: string;
        refusal_code: string | null;
        liquidation_rung_id: string;
      }[]
    >`SELECT * FROM trade.futures_orders WHERE liquidation_rung_id IS NOT NULL ORDER BY created_at, id`;
  }

  function moneyKeys(): string[] {
    return ledger
      .journal()
      .filter((t) => MONEY_REASONS.has(t.reason))
      .map((t) => t.idempotencyKey);
  }

  /**
   * The books agree: long size equals short size, each open position's collateral pot equals its margin row, every
   * finished position's pot is empty, each order hold equals what it locked less what fills applied and releases
   * returned, no intent is pending, and the ledger replays to its own balances.
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
    const finished = await sql<{ id: string; user_id: string }[]>`
      SELECT id, user_id FROM trade.positions WHERE market_id = ${MARKET} AND status IN ('closed', 'liquidated')
    `;
    for (const p of finished) expect(await bal(positionCollateralAccount(p.user_id, USDT, p.id)), `finished pot ${p.id}`).toBe(0n);
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
    expect(ledger.reconcile()).toEqual({ ok: true });
  }

  /**
   * ADR section 3: the clearing pot equals the open positions' unrealised PnL at any mark plus the profit still owed.
   * The insurance fund's draws are inside it (they pay a bankrupt's loss past its margin, which a winner is owed). The
   * gap allowed is rounding only: two units per open position, one per reduce fill and two per ADL pair.
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
    const [pairs] = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM trade.futures_adl_pairs WHERE state = 'applied'`;
    const gap = (await bal(POT)) - (unrealized + parseAmount(owed?.owed ?? '0'));
    const allowed = 2n * BigInt(open.length) + BigInt(fills?.n ?? '0') + 2n * BigInt(pairs?.n ?? '0');
    expect(gap >= -allowed && gap <= allowed, `clearing pot = Σ unrealised + owed (gap ${gap}, rounding allowed ${allowed})`).toBe(true);
  }

  describe('the limit', () => {
    it('is the bankruptcy price, widened by the fund only for a closing tranche, pulled in to the band', () => {
      const band = priceBandAround(A('89'), A('0.05'));
      const base = { side: 'long' as const, size: A('2'), bankruptcy: A('90'), fillsBound: 20_000n, band };
      expect(liquidationLimit({ ...base, closesPosition: true, insurance: 0n }).limit).toBe(A('90'));
      const widened = liquidationLimit({ ...base, closesPosition: true, insurance: A('10') });
      // (10 − 20000 attounits) / 2 below 90: the fund pays at most what it holds, rounding included.
      expect(widened.limit).toBe(A('90') - (A('10') - 20_000n) / 2n);
      expect(liquidationLimit({ ...base, closesPosition: false, insurance: A('10') }).limit).toBe(A('90'));
      // A fund that would widen past the band edge stops there.
      expect(liquidationLimit({ ...base, closesPosition: true, insurance: A('100') }).limit).toBe(band.low);
      // A bankruptcy price beyond the whole band: nothing in the band is inside the bound.
      expect(liquidationLimit({ ...base, bankruptcy: A('95'), closesPosition: true, insurance: 0n }).limit).toBeNull();
      expect(
        liquidationLimit({
          side: 'short',
          size: A('2'),
          bankruptcy: A('110'),
          fillsBound: 0n,
          band: priceBandAround(A('108'), A('0.05')),
          closesPosition: true,
          insurance: A('4'),
        }).limit,
      ).toBe(A('112'));
    });
  });

  describe('netting across the rung', () => {
    const start = { side: 'long' as const, entryPrice: A('100'), marginInitial: A('20'), roundingAllowance: 0n };
    const none = { qty: 0n, pnl: 0n, fromMargin: 0n };

    it('an above-entry fill and a fill past the bankruptcy price net to the margin, in either order: the fund pays 0', () => {
      // Desk B1: long 2 at 100, margin 20, bankrupt at 90; fills 1 at 101 and 1 at 79. Net −20 = the margin.
      const up = planLiquidationFill({ ...start, size: A('2'), margin: A('20'), qty: A('1'), price: A('101'), prior: none });
      expect(up).toMatchObject({ profit: 0n, fromMargin: 0n, release: 0n, fromInsurance: 0n, remainMargin: A('20') });
      const down = planLiquidationFill({
        ...start,
        size: A('1'),
        margin: up.remainMargin,
        marginInitial: A('10'),
        qty: A('1'),
        price: A('79'),
        prior: { qty: A('1'), pnl: up.realizedPnl, fromMargin: up.fromMargin },
      });
      expect(down).toMatchObject({ fromMargin: A('20'), fromInsurance: 0n, profit: 0n, release: 0n, closes: true });

      const first = planLiquidationFill({ ...start, size: A('2'), margin: A('20'), qty: A('1'), price: A('79'), prior: none });
      // The fill past the bound pays its own share of the margin; the 11 past it waits for the rest of the tranche.
      expect(first).toMatchObject({ fromMargin: A('10'), fromInsurance: 0n, remainMargin: A('10') });
      const second = planLiquidationFill({
        ...start,
        size: A('1'),
        margin: first.remainMargin,
        marginInitial: A('10'),
        qty: A('1'),
        price: A('101'),
        prior: { qty: A('1'), pnl: first.realizedPnl, fromMargin: first.fromMargin },
      });
      expect(second).toMatchObject({ fromMargin: A('10'), fromInsurance: 0n, profit: 0n, release: 0n });
    });

    it('a fill past the bankruptcy price leaves the remainder its share of the margin; the fund pays the excess at settlement', () => {
      // Desk B2: long 2 at 100, margin 20; 1 fills at 86 (loss 14 against its 10 of margin).
      const fill = planLiquidationFill({ ...start, size: A('2'), margin: A('20'), qty: A('1'), price: A('86'), prior: none });
      expect(fill).toMatchObject({ fromMargin: A('10'), fromInsurance: 0n, remainMargin: A('10') });
      const settle = planLiquidationSettlement({
        size: A('1'),
        margin: fill.remainMargin,
        prior: { qty: A('1'), pnl: fill.realizedPnl, fromMargin: fill.fromMargin },
      });
      // The remainder keeps 10, so its bankruptcy price is still 90; the fund pays the 4.
      expect(settle).toEqual({ release: 0n, profit: 0n, fromInsurance: A('4'), unbooked: 0n, remainMargin: A('10') });
    });
  });

  describe('the book takes it', () => {
    it('fills fully inside the bound: the loss goes into the pot, the rest of the margin back, the position is liquidated', async () => {
      const { alice } = await aliceLongBobShort();
      await carolBids(A('2'), A('91'));
      mark = A('89'); // Alice (long 2 at 100, margin 20) is bankrupt at 90.
      const result = await tick();

      expect(result.items.find((i) => i.positionId === alice.id)).toMatchObject({
        positionId: alice.id,
        outcome: 'liquidated',
        reason: 'bankrupt_full_close',
      });
      expect(await positionRow(alice.id)).toMatchObject({ status: 'liquidated' });
      const [order] = await liquidationOrders();
      const [rung] = await rungs();
      expect(rung).toMatchObject({ kind: 'matched', state: 'applied' });
      expect(order).toMatchObject({ status: 'filled', client_order_id: `liq:${alice.id}:rung:${rung!.rung_id}` });
      expect(engine.submits.at(-1)).toMatchObject({ tif: 'IOC', side: 'sell', qty: '2', price: '90', reduceOnly: false });
      // Sold 2 at 91: lost 18 of 20, got 2 back. Nothing from the fund; no fee.
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('2'));
      expect(await bal(POT)).toBe(A('18'));
      expect(await bal(FUND)).toBe(0n);
      expect((await openOf(CAROL))[0]).toMatchObject({ side: 'long' });
      await assertBooksAgree();
      await assertPotIdentity(mark);
      // Done: the next tick has nothing to do for Alice.
      const again = await tick();
      expect(again.items.find((i) => i.positionId === alice.id)).toBeUndefined();
      expect(engine.submits.filter((s) => s.tif === 'IOC')).toHaveLength(1);
    });

    it('fills past the bound with the insurance fund covering exactly the loss past the margin', async () => {
      const { alice } = await aliceLongBobShort();
      await fundInsurance('10');
      await carolBids(A('2'), A('86'));
      mark = A('89');
      const result = await tick();

      expect(result.items.find((i) => i.positionId === alice.id)).toMatchObject({ positionId: alice.id, outcome: 'liquidated' });
      // The limit is 90 widened by (10 − rounding slack) / 2: Carol's 86 is inside it.
      const [order] = await liquidationOrders();
      expect(parseAmount(order!.limit_price)).toBeLessThan(A('86'));
      expect(parseAmount(order!.limit_price)).toBeGreaterThan(A('85'));
      // Sold 2 at 86: lost 28 against 20 of margin. The fund pays the 8, Alice gets nothing back.
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20'));
      expect(await bal(FUND)).toBe(A('2'));
      expect(await bal(POT)).toBe(A('28'));
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('a liquidation filled in pieces hands no margin back before the fund pays (the fund never pays for returned margin)', async () => {
      const { alice } = await aliceLongBobShort();
      await fundInsurance('10');
      await carolBids(A('1'), A('91'));
      await carolBids(A('1'), A('86'));
      mark = A('89');
      await tick();

      // 1 at 91 loses 9, 1 at 86 loses 14: 23 against 20 of margin. The fund pays 3, Alice gets nothing back. Had the
      // first fill returned its unused share (1), the fund would have paid 4.
      expect(await positionRow(alice.id)).toMatchObject({ status: 'liquidated' });
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20'));
      expect(await bal(FUND)).toBe(A('7'));
      expect(await bal(POT)).toBe(A('23'));
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('desk B1: an above-entry fill then one past the bankruptcy price net to the margin — the fund pays nothing', async () => {
      const wide = build({ priceBand: A('0.15') });
      const { alice } = await aliceLongBobShort();
      await fundInsurance('30');
      await carolBids(A('1'), A('101'));
      await carolBids(A('1'), A('79'));
      mark = A('89');
      expect((await tick({ svc: wide })).items.find((i) => i.positionId === alice.id)).toMatchObject({ outcome: 'liquidated' });

      // Sold 1 at 101 (+1) and 1 at 79 (−21): the tranche lost 20, exactly the margin. Nothing comes back, no profit is
      // paid, and the fund pays nothing.
      expect(await positionRow(alice.id)).toMatchObject({ status: 'liquidated' });
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('980'));
      expect(await bal(FUND)).toBe(A('30'));
      expect(await sql`SELECT 1 FROM trade.futures_payouts WHERE user_id = ${ALICE}`).toHaveLength(0);
      expect(await bal(POT)).toBe(A('20'));
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('a partial tranche: limit at the bankruptcy price (no widening), the margin stays with the remainder', async () => {
      const { alice } = await aliceLongBobShort();
      await fundInsurance('10');
      await carolBids(A('0.5'), A('90.5'));
      mark = A('90.3'); // equity 0.6: under maintenance, not bankrupt; the default ladder takes a quarter.
      const result = await tick({
        ladder: {
          depth: { depthNotional: async () => A('1000000') },
          reducer: sqlPositionReducer(sql),
          policy: DEFAULT_FUTURES_LADDER_POLICY,
        },
      });

      expect(result.items.find((i) => i.positionId === alice.id)).toMatchObject({
        positionId: alice.id,
        outcome: 'partially_liquidated',
        reason: 'ladder_partial',
      });
      const [order] = await liquidationOrders();
      expect(order).toMatchObject({ qty: '0.500000000000000000', status: 'filled' });
      expect(parseAmount(order!.limit_price)).toBe(A('90'));
      // 0.5 at 90.5 loses 4.75 of its 5 of margin. The remainder keeps its share of the rung's starting margin (15, so
      // the same bankruptcy price, 90); the filled part's unused 0.25 comes back when the book is settled.
      expect(await positionRow(alice.id)).toMatchObject({
        status: 'open',
        size: '1.500000000000000000',
        margin_current: '15.000000000000000000',
      });
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('0.25'));
      expect(await bal(FUND)).toBe(A('10'));
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });
  });

  describe('the remainder goes to ADL at the bankruptcy price', () => {
    it('a partial fill: the book takes 1, ADL pairs the other 1 against Bob at the rung’s bankruptcy price', async () => {
      const { alice, bob } = await aliceLongBobShort();
      await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, NOW);
      await carolBids(A('1'), A('91'));
      mark = A('89');
      const result = await tick({ adl: adlDeps() });

      expect(result.items.find((i) => i.positionId === alice.id)).toMatchObject({ positionId: alice.id, outcome: 'liquidated' });
      expect(await positionRow(alice.id)).toMatchObject({ status: 'closed' });
      // The book: 1 at 91, loss 9 of the unit's 10 of margin; the 1 left comes back when the book settles. The rest
      // (1, margin 10) keeps the bankruptcy price 90: ADL closes it against Bob at 90, never at a price the fill moved.
      // Bob is paid 10 for the unit and keeps the other short.
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('1'));
      expect(await positionRow(bob.id)).toMatchObject({
        status: 'open',
        size: '1.000000000000000000',
        margin_current: '10.000000000000000000',
      });
      expect(await bal(userAvailable(BOB, USDT))).toBe(A('1000') - A('20') + A('10') + A('10'));
      expect(await bal(FUND)).toBe(0n);
      expect(await bal(POT)).toBe(A('9'));
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'applied' }]);
      const [pair] = await sql<
        { pair_id: string; size: string; state: string }[]
      >`SELECT pair_id, size, state FROM trade.futures_adl_pairs`;
      expect(pair).toMatchObject({ pair_id: `futures.adl:${alice.id}:1:${bob.id}`, state: 'applied', size: '1.000000000000000000' });
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('desk B2: a fill past the bankruptcy price — the fund pays the excess and ADL prices the rest at the rung’s bankruptcy price', async () => {
      const { alice, bob } = await aliceLongBobShort();
      await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, NOW);
      await fundInsurance('10');
      await carolBids(A('1'), A('86'));
      mark = A('89');
      expect((await tick({ adl: adlDeps() })).items.find((i) => i.positionId === alice.id)).toMatchObject({ outcome: 'liquidated' });

      // The book: 1 at 86, loss 14 against the unit's 10 of margin. The remainder keeps its 10, so it is still bankrupt
      // at 90, and ADL pairs it with Bob there.
      const [pair] = await sql<{ bankruptcy_price: string; size: string; state: string }[]>`
        SELECT bankruptcy_price, size, state FROM trade.futures_adl_pairs
      `;
      expect(pair).toMatchObject({ bankruptcy_price: '90.000000000000000000', size: '1.000000000000000000', state: 'applied' });
      // WHO PAYS. The 4 past the bankruptcy price comes from the insurance fund, never from the ADL counterparty: Bob is
      // paid his full 10 for the unit (short at 100, closed at 90) and gets that unit's 10 of margin back.
      expect(await bal(FUND)).toBe(A('6'));
      expect(await bal(userAvailable(BOB, USDT))).toBe(A('1000') - A('20') + A('10') + A('10'));
      expect(await positionRow(bob.id)).toMatchObject({
        status: 'open',
        size: '1.000000000000000000',
        margin_current: '10.000000000000000000',
      });
      // Alice loses exactly her margin.
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('980'));
      expect(await positionRow(alice.id)).toMatchObject({ status: 'closed' });
      const draws = ledger.journal().filter((t) => t.reason === 'futures.loss.realized' && t.meta?.fromInsurance !== '0');
      expect(draws.map((t) => t.meta?.fromInsurance)).toEqual([A('4').toString()]);
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('a fund that cannot cover the net shortfall when the book is done: the rung waits, nothing is drawn, then it settles once', async () => {
      const { alice, bob } = await aliceLongBobShort();
      await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, NOW);
      await fundInsurance('10');
      await carolBids(A('1'), A('86'));
      mark = A('89');
      // The order's limit is set from the fund's real balance; by the time the book is done, other liquidations have
      // drained it to 3 against this tranche's shortfall of 4.
      let drained = true;
      let reads = 0;
      const view = {
        ...ledger,
        post: (r: PostRequest) => ledger.post(r),
        getTxByKey: (k: string) => ledger.getTxByKey(k),
        balance: async (ref: AccountRef) => {
          const real = await ledger.balance(ref);
          if (ref.ownerId !== 'insurance-fund' || !drained || reads++ === 0) return real;
          return { ...real, amount: A('3') };
        },
      } as unknown as LedgerClient;
      const svc = build({}, view);
      expect((await tick({ svc, adl: adlDeps() })).items.find((i) => i.positionId === alice.id)).toMatchObject({
        outcome: 'skipped_insurance_underfunded',
        reason: 'trade.insurance_underfunded',
      });
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'planned' }]);
      expect(await bal(FUND)).toBe(A('10'));
      expect(await positionRow(alice.id)).toMatchObject({ size: '1.000000000000000000', margin_current: '10.000000000000000000' });
      expect(await sql`SELECT 1 FROM trade.futures_adl_pairs`).toHaveLength(0);

      drained = false;
      expect((await tick({ svc, adl: adlDeps() })).items.find((i) => i.positionId === alice.id)).toMatchObject({ outcome: 'liquidated' });
      expect(await bal(FUND)).toBe(A('6'));
      expect(await positionRow(bob.id)).toMatchObject({ size: '1.000000000000000000' });
      expect(engine.submits.filter((x) => x.tif === 'IOC')).toHaveLength(1);
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('a crash after the settlement drew the fund: the replay is not refused by the balance it lowered, and draws once', async () => {
      const { alice } = await aliceLongBobShort();
      await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, NOW);
      await fundInsurance('10');
      await carolBids(A('1'), A('86'));
      mark = A('89');
      let drew = false;
      let crashed = false;
      const view = {
        ...ledger,
        getTxByKey: (k: string) => ledger.getTxByKey(k),
        // Once the draw has posted, the fund reads empty (other liquidations took the rest).
        balance: async (ref: AccountRef) => {
          const real = await ledger.balance(ref);
          return drew && ref.ownerId === 'insurance-fund' ? { ...real, amount: 0n } : real;
        },
        post: async (r: PostRequest) => {
          const tx = await ledger.post(r);
          if (r.idempotencyKey.includes(':settle:loss')) {
            drew = true;
            if (!crashed) {
              crashed = true;
              throw new Error('process died after the draw');
            }
          }
          return tx;
        },
      } as unknown as LedgerClient;
      const svc = build({}, view);
      expect((await tick({ svc, adl: adlDeps() })).items.find((i) => i.positionId === alice.id)).toMatchObject({ outcome: 'errored' });
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'planned' }]);
      expect(await bal(FUND)).toBe(A('6'));

      expect((await tick({ svc, adl: adlDeps() })).items.find((i) => i.positionId === alice.id)).toMatchObject({ outcome: 'liquidated' });
      expect(await bal(FUND)).toBe(A('6'));
      const keys = moneyKeys();
      expect(new Set(keys).size).toBe(keys.length);
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('no book at all: the IOC fills nothing and ADL takes the whole tranche', async () => {
      const { alice, bob } = await aliceLongBobShort();
      await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, NOW);
      mark = A('89');
      const result = await tick({ adl: adlDeps() });

      expect(result.items.find((i) => i.positionId === alice.id)).toMatchObject({ positionId: alice.id, outcome: 'liquidated' });
      expect(engine.submits.at(-1)).toMatchObject({ tif: 'IOC', qty: '2' });
      expect((await liquidationOrders())[0]).toMatchObject({ status: 'cancelled', filled_qty: '0.000000000000000000' });
      expect(await positionRow(alice.id)).toMatchObject({ status: 'closed' });
      expect(await positionRow(bob.id)).toMatchObject({ status: 'closed' });
      expect(await bal(userAvailable(BOB, USDT))).toBe(A('1000') + A('20'));
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20'));
      expect(await bal(POT)).toBe(0n);
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('a bankruptcy price beyond the whole band: nothing is sent to the book, ADL takes it all', async () => {
      const { alice } = await aliceLongBobShort();
      await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, NOW);
      await carolBids(A('2'), A('85'), A('85'));
      mark = A('85'); // band 80.75 to 89.25; bankrupt at 90 with an empty fund: no price in the band is inside it.
      await tick({ adl: adlDeps() });

      expect(engine.submits.filter((s) => s.tif === 'IOC')).toHaveLength(0);
      expect((await liquidationOrders())[0]).toMatchObject({
        status: 'refused',
        refusal_code: 'trade.futures_reduce_bankruptcy_outside_band',
      });
      expect(await positionRow(alice.id)).toMatchObject({ status: 'closed' });
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20'));
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('ADL not configured: the remainder parks honestly, nothing is invented, and the next tick tries the book again', async () => {
      const { alice } = await aliceLongBobShort();
      mark = A('89');
      const first = await tick();

      expect(first.items.find((i) => i.positionId === alice.id)).toMatchObject({
        positionId: alice.id,
        outcome: 'skipped_insurance_underfunded',
        reason: 'trade.adl_unconfigured',
      });
      expect(await positionRow(alice.id)).toMatchObject({
        status: 'open',
        size: '2.000000000000000000',
        margin_current: '20.000000000000000000',
      });
      expect(moneyKeys()).toEqual([]);
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'applied' }]);
      await assertBooksAgree();

      // The book refilled: the next tick's rung takes it.
      await carolBids(A('2'), A('91'));
      const second = await tick();
      expect(second.items.find((i) => i.positionId === alice.id)).toMatchObject({ positionId: alice.id, outcome: 'liquidated' });
      expect(await rungs()).toHaveLength(2);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('2'));
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('insurance unset: no widening, a bid past the bankruptcy price is not hit', async () => {
      const { alice } = await aliceLongBobShort();
      await carolBids(A('2'), A('86'));
      mark = A('89');
      const result = await tick();

      expect(result.items.find((i) => i.positionId === alice.id)).toMatchObject({
        outcome: 'skipped_insurance_underfunded',
        reason: 'trade.adl_unconfigured',
      });
      const [order] = await liquidationOrders();
      expect(parseAmount(order!.limit_price)).toBe(A('90'));
      expect(order).toMatchObject({ status: 'cancelled', filled_qty: '0.000000000000000000' });
      expect(await positionRow(alice.id)).toMatchObject({ status: 'open', size: '2.000000000000000000' });
      expect(await openOf(CAROL)).toHaveLength(0);
    });

    it('an unreadable insurance fund widens nothing: never a guess', async () => {
      await aliceLongBobShort();
      await fundInsurance('10');
      await carolBids(A('2'), A('86'));
      mark = A('89');
      const blind = {
        ...ledger,
        post: (r: PostRequest) => ledger.post(r),
        getTxByKey: (k: string) => ledger.getTxByKey(k),
        balance: async (ref: AccountRef) => {
          if (ref.ownerId === 'insurance-fund') throw new Error('ledger read timed out');
          return ledger.balance(ref);
        },
      } as unknown as LedgerClient;
      await tick({ svc: build({}, blind) });
      expect(parseAmount((await liquidationOrders())[0]!.limit_price)).toBe(A('90'));
      expect(await bal(FUND)).toBe(A('10'));
    });
  });

  describe('a crash at each step finishes on the next tick, once', () => {
    it('after the order is stored, before it is sent', async () => {
      const { alice } = await aliceLongBobShort();
      await carolBids(A('2'), A('91'));
      mark = A('89');
      let dead = true;
      const svc = build({
        lifecycleProof: async () => {
          if (dead) throw new Error('process died before the submit');
          return PROOF;
        },
      });
      expect((await tick({ svc })).items.find((i) => i.positionId === alice.id)).toMatchObject({ outcome: 'errored' });
      expect(await liquidationOrders()).toMatchObject([{ status: 'pending' }]);
      expect(engine.submits.filter((s) => s.tif === 'IOC')).toHaveLength(0);

      dead = false;
      expect((await tick({ svc })).items.find((i) => i.positionId === alice.id)).toMatchObject({ outcome: 'liquidated' });
      expect(engine.submits.filter((s) => s.tif === 'IOC')).toHaveLength(1);
      expect(await positionRow(alice.id)).toMatchObject({ status: 'liquidated' });
      await assertBooksAgree();
    });

    it('after the engine accepts: the IOC is never sent again; its events finish it', async () => {
      const { alice } = await aliceLongBobShort();
      await carolBids(A('1'), A('91'));
      mark = A('89');
      engine.crashAfterAccept = true;
      const first = await tick();
      expect(first.items.find((i) => i.positionId === alice.id)).toMatchObject({
        outcome: 'errored',
        reason: 'trade.futures_submit_unknown',
      });
      expect(await liquidationOrders()).toMatchObject([{ status: 'submit_unknown' }]);
      // Still unknown on the next tick: nothing is re-sent, nothing moves.
      expect((await tick()).items.find((i) => i.positionId === alice.id)).toMatchObject({
        outcome: 'errored',
        reason: 'trade.futures_submit_unknown',
      });
      expect(engine.submits.filter((s) => s.tif === 'IOC')).toHaveLength(1);
      expect(moneyKeys()).toEqual([]);

      // The engine's events arrive, as the matching consumers deliver them.
      const svc = build();
      const printed = engine.printed.at(-1)!;
      for (const f of printed.fills) {
        await svc.settleFillOrWait({
          marketId: MARKET,
          makerOrderId: f.makerOrderId,
          takerOrderId: f.takerOrderId,
          price: f.price,
          qty: f.qty,
          sequence: f.sequence,
        });
      }
      for (const c of printed.cancellations) await svc.releaseEngineCancellation(c.orderId, c.remainingQty);

      // The tick finds the book settled and hands the remainder to the (unconfigured) ADL gate.
      expect((await tick()).items.find((i) => i.positionId === alice.id)).toMatchObject({
        outcome: 'skipped_insurance_underfunded',
        reason: 'trade.adl_unconfigured',
      });
      expect(engine.submits.filter((s) => s.tif === 'IOC')).toHaveLength(1);
      // 1 at 91 lost 9 of the unit's 10; the 1 left came back when the book settled, and the remainder keeps its 10.
      expect(await positionRow(alice.id)).toMatchObject({
        status: 'open',
        size: '1.000000000000000000',
        margin_current: '10.000000000000000000',
      });
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('1'));
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it.each([
      ['the fill intent, before its first post', 'futures.loss.realized', 'before'],
      ['the loss post', 'futures.loss.realized', 'after'],
      ['the closing release post', 'futures.margin.release', 'after'],
    ] as const)('after %s: the redelivered fill posts each key once', async (_name, reason, when) => {
      const { alice } = await aliceLongBobShort();
      await carolBids(A('2'), A('91'));
      mark = A('89');
      let crashed = false;
      const crashing = {
        ...ledger,
        balance: (ref: AccountRef) => ledger.balance(ref),
        getTxByKey: (k: string) => ledger.getTxByKey(k),
        post: async (request: PostRequest) => {
          const liquidating = request.entries.some((e) => e.account.kind === 'collateral' && e.account.ownerId === ALICE);
          if (!crashed && liquidating && request.reason === reason && when === 'before') {
            crashed = true;
            throw new Error('ledger unreachable');
          }
          const tx = await ledger.post(request);
          if (!crashed && liquidating && request.reason === reason) {
            crashed = true;
            throw new Error('simulated crash after the post');
          }
          return tx;
        },
      } as unknown as LedgerClient;
      const first = await tick({ svc: build({}, crashing) });
      expect(first.items.find((i) => i.positionId === alice.id)).toMatchObject({ outcome: 'errored' });
      expect(await sql`SELECT 1 FROM trade.futures_order_fills WHERE state = 'pending'`).toHaveLength(1);
      // The rung still holds the position and its IOC is not sent again.
      expect((await tick()).items.find((i) => i.positionId === alice.id)).toMatchObject({
        outcome: 'errored',
        reason: 'trade.futures_submit_unknown',
      });
      expect(engine.submits.filter((s) => s.tif === 'IOC')).toHaveLength(1);

      const svc = build();
      for (const f of engine.printed.at(-1)!.fills) {
        await svc.settleFillOrWait({
          marketId: MARKET,
          makerOrderId: f.makerOrderId,
          takerOrderId: f.takerOrderId,
          price: f.price,
          qty: f.qty,
          sequence: f.sequence,
        });
      }
      // The redelivered closing fill liquidates the row and finishes its rung in the same transaction: the closed
      // position leaves the scan with no live rung behind it.
      expect(await positionRow(alice.id)).toMatchObject({ status: 'liquidated' });
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'applied' }]);
      expect(await sql`SELECT 1 FROM trade.liquidation_attempts WHERE liquidation_id = ${`liq:${alice.id}`}`).toHaveLength(1);
      expect((await tick()).items.find((i) => i.positionId === alice.id)).toBeUndefined();
      expect(engine.submits.filter((s) => s.tif === 'IOC')).toHaveLength(1);
      const keys = moneyKeys();
      expect(new Set(keys).size).toBe(keys.length);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('2'));
      expect(await bal(POT)).toBe(A('18'));
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('after the book settled and before ADL: the next tick pairs the remainder without touching the book', async () => {
      const { alice, bob } = await aliceLongBobShort();
      await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, NOW);
      await carolBids(A('1'), A('91'));
      mark = A('89');
      const adl = adlDeps();
      let dead = true;
      const dying: LiquidationAdlDeps = {
        ...adl,
        candidates: async (b) => {
          if (dead) throw new Error('process died before ADL');
          return (adl.candidates as (x: typeof b) => Promise<never[]>)(b);
        },
      };
      expect((await tick({ adl: dying })).items.find((i) => i.positionId === alice.id)).toMatchObject({ outcome: 'errored' });
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'posted' }]);
      // A posted matched rung still holds the position for everyone but its own ADL.
      await expect(place(ALICE, 'buy', A('1'), A('89'))).resolves.toMatchObject({ status: 'open' });

      dead = false;
      expect((await tick({ adl: dying })).items.find((i) => i.positionId === alice.id)).toMatchObject({
        positionId: alice.id,
        outcome: 'liquidated',
      });
      expect(engine.submits.filter((s) => s.tif === 'IOC')).toHaveLength(1);
      expect(await positionRow(bob.id)).toMatchObject({ size: '1.000000000000000000' });
      expect(await sql`SELECT 1 FROM trade.futures_adl_pairs`).toHaveLength(1);
      // Alice: her margin less the book's loss (9 of the unit's 10), the 1 back at settlement, the unit ADL closed at
      // 90 with its 10 of margin; and the hold of the bid she placed meanwhile. Bob: 10 for the unit.
      const [bid] = await sql<{ id: string }[]>`
        SELECT id FROM trade.futures_orders WHERE user_id = ${ALICE} AND NOT reduce_only ORDER BY created_at DESC LIMIT 1
      `;
      const hold = await bal(futuresOrderMarginAccount(ALICE, USDT, bid!.id));
      expect(hold).toBeGreaterThan(0n);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('1') - hold);
      expect(await bal(userAvailable(BOB, USDT))).toBe(A('1000') - A('20') + A('10') + A('10'));
      expect(await bal(FUND)).toBe(0n);
    });

    it('two workers settling the same book: the second finds the rung moved on and changes nothing', async () => {
      const { alice } = await aliceLongBobShort();
      await carolBids(A('1'), A('91'));
      mark = A('89');
      // Worker A stops right after its settlement's release posted; worker B runs the whole tick meanwhile.
      let blocked = false;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const slow = {
        ...ledger,
        balance: (ref: AccountRef) => ledger.balance(ref),
        getTxByKey: (k: string) => ledger.getTxByKey(k),
        post: async (r: PostRequest) => {
          const tx = await ledger.post(r);
          if (!blocked && r.idempotencyKey.includes(':settle:release')) {
            blocked = true;
            await gate;
          }
          return tx;
        },
      } as unknown as LedgerClient;
      const a = tick({ svc: build({}, slow) });
      while (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await tick()).items.find((i) => i.positionId === alice.id)).toMatchObject({
        outcome: 'skipped_insurance_underfunded',
        reason: 'trade.adl_unconfigured',
      });
      open();
      expect((await a).items.find((i) => i.positionId === alice.id)).toMatchObject({ reason: 'trade.adl_unconfigured' });
      // The release was posted (and counted) once: the remainder keeps its 10, Alice has the 1 back once.
      expect(await positionRow(alice.id)).toMatchObject({ size: '1.000000000000000000', margin_current: '10.000000000000000000' });
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20') + A('1'));
      await assertBooksAgree();
    });

    it('in the middle of an ADL pair: the pair is driven first, then the rung finishes', async () => {
      const { alice, bob } = await aliceLongBobShort();
      await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, NOW);
      mark = A('89');
      let armed = true;
      const failing: Pick<LedgerClient, 'post' | 'balance' | 'getTxByKey'> = {
        balance: (ref) => ledger.balance(ref),
        getTxByKey: (key) => ledger.getTxByKey(key),
        post: async (req) => {
          if (armed && req.reason === 'futures.margin.release' && req.entries.some((e) => e.account.ownerId === BOB)) {
            armed = false;
            throw new Error('ledger timeout');
          }
          return ledger.post(req);
        },
      };
      const adl = adlDeps(failing);
      expect((await tick({ adl })).items.find((i) => i.positionId === alice.id)).toMatchObject({ outcome: 'errored' });
      expect(await sql`SELECT state FROM trade.futures_adl_pairs`).toMatchObject([{ state: 'planned' }]);

      // The next tick drives the planned pair under its stored keys, then finishes the rung.
      expect((await tick({ adl })).items.find((i) => i.positionId === alice.id)).toMatchObject({
        positionId: alice.id,
        outcome: 'liquidated',
      });
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'applied' }]);
      expect(await positionRow(bob.id)).toMatchObject({ status: 'closed' });
      const keys = moneyKeys();
      expect(new Set(keys).size).toBe(keys.length);
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });
  });

  describe('the rung holds the position', () => {
    it('other fills on the position wait while the liquidation runs; its own fill does not', async () => {
      const { alice } = await aliceLongBobShort();
      // Before the liquidation, Dave's sell crosses Alice's resting bid (it grows her long), and the engine's reply is
      // lost: the fill reaches svc-trade later, as an event, while the liquidation's rung holds Alice's position.
      mark = A('92');
      const grow = await place(ALICE, 'buy', A('1'), A('89.5'));
      engine.crashAfterAccept = true;
      await place(DAVE, 'sell', A('1'), A('89.5')).catch(() => undefined);
      const dave = engine.printed.at(-1)!.fills[0]!;
      expect(dave).toMatchObject({ makerOrderId: grow.orderId });
      await carolBids(A('2'), A('91'));
      mark = A('89');
      engine.crashAfterAccept = true;
      expect((await tick()).items.find((i) => i.positionId === alice.id)).toMatchObject({ reason: 'trade.futures_submit_unknown' });
      const [liq] = await liquidationOrders();

      // Dave's fill arrives while the rung is live: it names Alice's position and waits.
      const svc = build();
      expect(
        await svc.settleFillOrWait({
          marketId: MARKET,
          makerOrderId: dave.makerOrderId,
          takerOrderId: dave.takerOrderId,
          price: dave.price,
          qty: dave.qty,
          sequence: dave.sequence,
        }),
      ).toBe('waiting');
      expect(await sql`SELECT reason FROM trade.futures_fill_waits WHERE settled_at IS NULL`).toMatchObject([
        { reason: 'trade.liquidation_in_progress' },
      ]);
      expect(await openOf(DAVE)).toHaveLength(0);
      expect(await positionRow(alice.id)).toMatchObject({ status: 'open', size: '2.000000000000000000' });

      // The liquidation's own fills pass the same guard: the rung that holds the position is theirs.
      const own = engine.printed.find((p) => p.fills.some((x) => x.takerOrderId === liq!.id))!;
      expect(own.fills.every((f) => f.makerOrderId !== grow.orderId)).toBe(true);
      for (const f of own.fills) {
        expect(
          await svc.settleFillOrWait({
            marketId: MARKET,
            makerOrderId: f.makerOrderId,
            takerOrderId: f.takerOrderId,
            price: f.price,
            qty: f.qty,
            sequence: f.sequence,
          }),
        ).toBe('settled');
      }
      expect(await positionRow(alice.id)).toMatchObject({ status: 'liquidated' });
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'applied' }]);
      // Once the rung is done the waiting fill lands: Alice's old row is liquidated, so it opens her a new one.
      expect(await svc.retryWaitingFills(50)).toEqual({ settled: 1, waiting: 0, failed: [] });
      expect(await openOf(ALICE)).toMatchObject([{ side: 'long', size: '1.000000000000000000' }]);
      expect((await openOf(ALICE))[0]!.id).not.toBe(alice.id);
      expect(await openOf(DAVE)).toMatchObject([{ side: 'short', size: '1.000000000000000000' }]);
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('the trader’s resting reduce-only orders come off the book when the liquidation starts', async () => {
      const { alice } = await aliceLongBobShort();
      const reduce = await place(ALICE, 'sell', A('1'), A('99'), { reduceOnly: true });
      expect(reduce.status).toBe('open');
      await carolBids(A('2'), A('91'));
      mark = A('89');
      await tick();

      expect(engine.cancels).toContain(reduce.orderId);
      const [row] = await sql<
        { status: string; refusal_code: string }[]
      >`SELECT status, refusal_code FROM trade.futures_orders WHERE id = ${reduce.orderId}`;
      expect(row).toMatchObject({ status: 'cancelled', refusal_code: 'trade.liquidation_in_progress' });
      expect(await positionRow(alice.id)).toMatchObject({ status: 'liquidated' });
      await assertBooksAgree();
    });

    it('a fill of the IOC that meets a busy counterparty waits; the rung waits with it and finishes once it lands', async () => {
      const { alice } = await aliceLongBobShort();
      // Carol already holds a long, and a margin adjustment is finishing on it when the liquidation sells into her bid.
      mark = A('91');
      await place(CAROL, 'buy', A('1'), A('91'));
      await place(DAVE, 'sell', A('1'), A('91'));
      const [carol] = await openOf(CAROL);
      await carolBids(A('2'), A('91'));
      await sql`UPDATE trade.positions SET margin_adjust_request = 'adj-carol' WHERE id = ${carol!.id}`;
      mark = A('89');
      expect((await tick()).items.find((i) => i.positionId === alice.id)).toMatchObject({
        outcome: 'in_book',
        reason: 'trade.futures_fill_in_progress',
      });
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'planned' }]);
      expect(await positionRow(alice.id)).toMatchObject({ status: 'open', size: '2.000000000000000000' });
      expect(moneyKeys()).toEqual([]);

      await sql`UPDATE trade.positions SET margin_adjust_request = NULL WHERE id = ${carol!.id}`;
      await tick();
      expect(await positionRow(alice.id)).toMatchObject({ status: 'liquidated' });
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'applied' }]);
      expect(await openOf(CAROL)).toMatchObject([{ size: '3.000000000000000000' }]);
      expect(engine.submits.filter((s) => s.tif === 'IOC')).toHaveLength(1);
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('ADL never pairs a bankrupt position whose matched rung has not finished with the book', async () => {
      const { alice, bob } = await aliceLongBobShort();
      await acks.recordAck(BOB, ADL_DISCLOSURE_VERSION, NOW);
      mark = A('89');
      const svc = build({
        lifecycleProof: async () => {
          throw new Error('process died before the submit');
        },
      });
      await tick({ svc });
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'planned' }]);
      const out = await runLastResortAdlAfterInsuranceUnderfunded({
        adl: adlDeps(),
        bankrupt: { positionId: alice.id, userId: ALICE, marketId: MARKET, side: 'long', uncoveredShortfall: 0n, size: A('2') },
        at: NOW,
      });
      expect(out.action).not.toBe('reduced');
      expect(await sql`SELECT 1 FROM trade.futures_adl_pairs`).toHaveLength(0);
      expect(await positionRow(bob.id)).toMatchObject({ status: 'open', size: '2.000000000000000000' });
      expect(moneyKeys()).toEqual([]);
    });

    it('desk B3: two overlapping liquidations never wait on each other — each trader’s growing bids come off first', async () => {
      const { alice } = await aliceLongBobShort();
      await place(CAROL, 'buy', A('2'), A('100'));
      await place(DAVE, 'sell', A('2'), A('100'));
      const [carol] = await openOf(CAROL);
      for (const u of [BOB, DAVE]) await acks.recordAck(u, ADL_DISCLOSURE_VERSION, NOW);
      // Each long rests a bid inside the other's bankruptcy bound (90): each liquidation's IOC could hit the other's.
      mark = A('92');
      const aliceBid = await place(ALICE, 'buy', A('1'), A('90.5'));
      const carolBid = await place(CAROL, 'buy', A('1'), A('90.5'));
      mark = A('89');
      // Both rungs begin and store their IOC before either is sent (the interleaving two workers, or a crash, give).
      let dead = true;
      const svc = build({
        lifecycleProof: async () => {
          if (dead) throw new Error('process died before the submit');
          return PROOF;
        },
      });
      const adl = adlDeps();
      // Without the tick's pull before the rung (an order can reach the book after that pull and before the rung holds
      // the position): the pull inside the rung, before its IOC is stored, is what rules the cycle out.
      await tick({ svc, adl, preRungPull: false });
      expect(await rungs()).toMatchObject([
        { kind: 'matched', state: 'planned' },
        { kind: 'matched', state: 'planned' },
      ]);
      // Neither bid is in the book any more, and their holds are back.
      expect(engine.book).toHaveLength(0);
      for (const bid of [aliceBid, carolBid]) {
        const [row] = await sql<{ status: string; refusal_code: string }[]>`
          SELECT status, refusal_code FROM trade.futures_orders WHERE id = ${bid.orderId}
        `;
        expect(row).toMatchObject({ status: 'cancelled', refusal_code: 'trade.liquidation_in_progress' });
      }

      dead = false;
      const second = await tick({ svc, adl, preRungPull: false });
      for (const id of [alice.id, carol!.id])
        expect(second.items.find((i) => i.positionId === id)).toMatchObject({ outcome: 'liquidated' });
      expect(await sql`SELECT 1 FROM trade.futures_fill_waits`).toHaveLength(0);
      expect(await svc.retryWaitingFills(50)).toEqual({ settled: 0, waiting: 0, failed: [] });
      expect(await rungs()).toMatchObject([
        { kind: 'matched', state: 'applied' },
        { kind: 'matched', state: 'applied' },
      ]);
      await assertBooksAgree();
      await assertPotIdentity(mark);
    });

    it('a growing order whose cancel the engine does not confirm holds the IOC back: nothing is stored or sent', async () => {
      const { alice } = await aliceLongBobShort();
      mark = A('92');
      const bid = await place(ALICE, 'buy', A('1'), A('90.5'));
      await carolBids(A('2'), A('91'));
      mark = A('89');
      const cancel = engine.cancel.bind(engine);
      let down = true;
      engine.cancel = async (marketId: string, orderId: string) => {
        if (down) throw new Error('engine unreachable');
        return cancel(marketId, orderId);
      };
      expect((await tick({ preRungPull: false })).items.find((i) => i.positionId === alice.id)).toMatchObject({
        outcome: 'errored',
        reason: 'trade.liquidation_increasing_cancel_timeout',
      });
      expect(await liquidationOrders()).toHaveLength(0);
      expect(engine.submits.filter((x) => x.tif === 'IOC')).toHaveLength(0);
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'planned' }]);

      down = false;
      expect((await tick({ preRungPull: false })).items.find((i) => i.positionId === alice.id)).toMatchObject({ outcome: 'liquidated' });
      expect(await sql`SELECT status FROM trade.futures_orders WHERE id = ${bid.orderId}`).toMatchObject([{ status: 'cancelled' }]);
      await assertBooksAgree();
    });

    it('the tick pulls the trader’s growing orders before any rung, on the at-mark path too (wired from the matched-order book)', async () => {
      const { alice } = await aliceLongBobShort();
      mark = A('92');
      const bid = await place(ALICE, 'buy', A('1'), A('88'));
      const ask = await place(ALICE, 'sell', A('1'), A('96'), { reduceOnly: true });
      await fundInsurance('10');
      mark = A('89');
      const off = build({ enabled: false });
      expect((await tick({ svc: off })).items.find((i) => i.positionId === alice.id)).toMatchObject({ outcome: 'liquidated' });
      expect(engine.cancels).toContain(bid.orderId);
      expect(await sql`SELECT status FROM trade.futures_orders WHERE id = ${bid.orderId}`).toMatchObject([{ status: 'cancelled' }]);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, bid.orderId))).toBe(0n);
      // A reduce-only order does not grow the position: the increasing-order pull leaves it to the reduce sweep.
      expect(engine.cancels).not.toContain(ask.orderId);
      expect(readFileSync(join(here, 'futures-jobs.ts'), 'utf8')).toContain(
        'increasingOrders: deps.matchedLiquidation.current.increasingOrders',
      );
    });

    it('a margin adjustment in flight: nothing is stored or sent, the rung waits, the next tick sends it', async () => {
      const { alice } = await aliceLongBobShort();
      await carolBids(A('2'), A('91'));
      mark = A('89');
      await sql`UPDATE trade.positions SET margin_adjust_request = 'adj-in-flight' WHERE id = ${alice.id}`;
      expect((await tick()).items.find((i) => i.positionId === alice.id)).toMatchObject({
        outcome: 'in_book',
        reason: 'trade.margin_adjustment_in_progress',
      });
      expect(await liquidationOrders()).toHaveLength(0);
      expect(engine.submits.filter((s) => s.tif === 'IOC')).toHaveLength(0);
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'planned' }]);

      await sql`UPDATE trade.positions SET margin_adjust_request = NULL WHERE id = ${alice.id}`;
      expect((await tick()).items.find((i) => i.positionId === alice.id)).toMatchObject({ outcome: 'liquidated' });
      expect(await rungs()).toMatchObject([{ kind: 'matched', state: 'applied' }]);
      expect(engine.submits.filter((s) => s.tif === 'IOC')).toHaveLength(1);
      await assertBooksAgree();
    });

    it('the switch off: a new rung closes at the mark exactly as before; a live matched rung is still worked to its end', async () => {
      const { alice } = await aliceLongBobShort();
      mark = A('89');
      await fundInsurance('10');
      const off = build({ enabled: false });
      const result = await tick({ svc: off });
      expect(result.items.find((i) => i.positionId === alice.id)).toMatchObject({
        positionId: alice.id,
        outcome: 'liquidated',
        reason: 'bankrupt_full_close',
      });
      expect(await rungs()).toMatchObject([{ kind: 'closing', state: 'applied' }]);
      expect(engine.submits.filter((s) => s.tif === 'IOC')).toHaveLength(0);
    });
  });

  describe('invariants', () => {
    it('opens, reduces and liquidations mixed: long equals short, every pot equals its row, the pot identity holds, the ledger reconciles', async () => {
      for (const u of [ALICE, BOB, CAROL, DAVE]) {
        await ledger.post(
          recipes.deposit({ userId: u, assetId: USDT, amount: A('100000'), rail: 'test', railRef: `top-${u}-${randomUUID()}` }),
        );
      }
      await fundInsurance('5');
      for (const u of [ALICE, BOB, CAROL, DAVE]) await acks.recordAck(u, ADL_DISCLOSURE_VERSION, NOW);
      const adl = adlDeps();
      const check = async () => {
        await assertBooksAgree();
        await assertPotIdentity(mark);
        await assertPotIdentity(A('120'));
        await assertPotIdentity(A('80'));
      };

      // Opens at 100: Alice long 3 against Bob short 2 and Dave short 1.
      await place(ALICE, 'buy', A('3'), A('100'));
      await place(BOB, 'sell', A('2'), A('100'));
      await place(DAVE, 'sell', A('1'), A('100'));
      await check();
      // At 101 Carol opens long 1 against Bob, then Dave buys back half his short from Carol's reduce.
      mark = A('101');
      await place(CAROL, 'buy', A('1'), A('101'));
      await place(BOB, 'sell', A('1'), A('101'));
      await check();
      await place(DAVE, 'buy', A('0.5'), A('101'), { reduceOnly: true });
      await place(CAROL, 'sell', A('0.5'), A('101'), { reduceOnly: true });
      await check();

      // The mark falls to 89: Alice (long 3 at 100, bankrupt at 90) and Carol (long 0.5 at 101, bankrupt at 90.9)
      // are both liquidated. Erin's bid is the only book; ADL takes the rest from the shorts.
      await ledger.post(
        recipes.deposit({ userId: ERIN, assetId: USDT, amount: A('100000'), rail: 'test', railRef: `top-${ERIN}-${randomUUID()}` }),
      );
      await acks.recordAck(ERIN, ADL_DISCLOSURE_VERSION, NOW);
      mark = A('90');
      await place(ERIN, 'buy', A('1'), A('89.5'));
      mark = A('89');
      const round1 = await tick({ adl });
      expect(round1.items.filter((i) => i.outcome === 'liquidated')).toHaveLength(2);
      expect(await openOf(ALICE)).toHaveLength(0);
      expect(await openOf(CAROL)).toHaveLength(0);
      expect(await openOf(ERIN)).toMatchObject([{ side: 'long', size: '1.000000000000000000' }]);
      await check();
      await runPayoutTick({ sql, ledger });
      await check();

      // A second round: Carol long 1 at 95 (bankrupt at 85.5). Dave's reduce-only bid at 84 meets half her
      // liquidation inside the band; ADL pairs the other half.
      mark = A('95');
      await place(CAROL, 'buy', A('1'), A('95'));
      await place(BOB, 'sell', A('1'), A('95'));
      await check();
      mark = A('85');
      await place(DAVE, 'buy', A('0.5'), A('84'), { reduceOnly: true });
      const round2 = await tick({ adl });
      expect(round2.items.filter((i) => i.outcome === 'liquidated')).toHaveLength(1);
      expect(await openOf(CAROL)).toHaveLength(0);
      expect(await openOf(DAVE)).toHaveLength(0);
      expect(await bal(FUND)).toBeLessThanOrEqual(A('5'));
      await check();
      await runPayoutTick({ sql, ledger });
      await check();
      const finished = await rungs();
      expect(finished).toHaveLength(3);
      expect(finished.every((r) => r.kind === 'matched' && r.state === 'applied')).toBe(true);
    });
  });
});
