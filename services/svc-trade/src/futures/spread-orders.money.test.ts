/**
 * Futures calendar spread orders through svc-matching's spread book (CB-otc-16), against the real trade schema and
 * MemoryLedger.
 *
 * Every money step is checked against the ledger, not against a row alone: the hold account, the position collateral
 * pots and the available balances move by exactly what the plan computes. The invariant suite at the end runs many
 * random orders between several accounts while the marks drift, and asserts after every step that no fill ever
 * printed outside the hold, that long equals short, that pots equal rows and that the ledger reconciles.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createMarketLifecycleAdmissionProof } from '@intafaced/exchange-contract';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryLedger,
  futuresOrderMarginAccount,
  parseAmount,
  positionCollateralAccount,
  recipes,
  userAvailable,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type {
  EngineCancelResult,
  EngineSpreadFill,
  EngineSpreadListingWire,
  EngineSpreadSubmitRequest,
  EngineSpreadSubmitResult,
  EngineSubmitRequest,
  EngineSubmitResult,
  MatchingClient,
} from '../spot/matching-client.js';
import type { LifecycleAdmissionProof } from '../lifecycle-proof.js';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { MatchedFuturesOrders } from './matched-orders.js';
import {
  LEDGER_IDEMPOTENCY_KEY_MAX,
  MAX_SPREAD_ID_LENGTH,
  SpreadFuturesOrders,
  type PlaceSpreadOrderInput,
  type SpreadFillInput,
  type SpreadOrderView,
} from './spread-orders.js';
import { spreadLegFillKey, spreadOrderIdFor } from './ids.js';
import { PositionService } from './position-service.js';
import { memoryMarkBook } from './mark-source.js';
import { sqlLiquidationRungStore } from './tick-stores.js';
import { TEST_ADL_RANKING, sqlAdlCandidates, sqlAdlPairReducer } from './adl-pairing.js';
import { ADL_DISCLOSURE_BEFORE_ACTION } from './adl-last-resort.js';
import { sqlDatedSettlementPositionLoader, sqlFundingPositionLoader } from './position-loaders.js';
import { engineLegPrices, orderLegSides, spreadHoldAmount, type OrderSide, type SpreadOrderTerms } from './spread-order-plan.js';

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
      .withDatabase('intafaced_spread_test')
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
    throw new Error(`spread futures orders need Postgres: TEST_DATABASE_URL unset and Testcontainers failed: ${msg}`);
  }
}

const A = (s: string) => parseAmount(s);
const USDT = 'USDT';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const DAVE = '44444444-4444-4444-8444-444444444444';
const FAR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NEAR = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FAR_SYMBOL = 'BTC/USDT-DEC';
const NEAR_SYMBOL = 'BTC/USDT-NOV';
const SPOT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_QUOTE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SPREAD = 'CAL-DEC-NOV';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const BAND = A('0.05');

const principal = (userId: string) => ({ userId, scopes: [] }) as unknown as Principal;

function legProof(marketId: string): LifecycleAdmissionProof {
  return createMarketLifecycleAdmissionProof(
    {
      marketId,
      ruleVersion: `rules-${marketId}`,
      instrumentId: marketId,
      instrumentVersion: `instrument-${marketId}`,
      state: 'OPEN',
      reasonCategory: 'NORMAL',
      reasonCode: 'trade.lifecycle.ready',
      effectiveAt: '2026-10-20T11:00:00.000Z',
      observedAt: '2026-10-20T11:59:00.000Z',
      lastGoodState: 'OPEN',
      allowedActions: ['PLACE'],
      transitionId: `transition-${marketId}`,
      evidenceRefs: [`evidence-${marketId}`],
    },
    'PLACE',
    '2026-10-20T11:59:00.000Z',
  );
}

const LISTING: EngineSpreadListingWire = {
  spreadId: SPREAD,
  kind: 'calendar',
  legs: [
    { symbol: FAR, side: 'buy', ratio: '1' },
    { symbol: NEAR, side: 'sell', ratio: '1' },
  ],
  tick: '0.01',
  lot: '1',
};

interface Resting {
  orderId: string;
  accountId: string;
  side: OrderSide;
  price: bigint;
  remaining: bigint;
  seq: number;
  /** The anchor reference the order was sent with: its own fills as a taker print leg 0 here. */
  anchor?: bigint;
}

/**
 * A faithful stand-in for the engine's spread book: price-time priority, fills at the maker's spread price, leg 0 at
 * the TAKER's anchor, leg 1 the exact residual (`engineLegPrices` is the port of the engine's rule), a fill sequence of
 * the spread book's own, and the remainder of a taker rests. Switches reproduce the doors a test needs.
 */
class FakeSpreadEngine {
  listings: EngineSpreadListingWire[] = [LISTING];
  readonly submits: EngineSpreadSubmitRequest[] = [];
  readonly script: Array<EngineSpreadSubmitResult | Error> = [];
  readonly fills: EngineSpreadFill[] = [];
  readonly cancels: string[] = [];
  book: Resting[] = [];
  /** When false every order rests untouched; a test then prints fills itself with `print`. */
  matching = true;
  /** The engine's `spread_fill_event_unwired` refusal. */
  unwired = false;
  /** An anchor the engine uses regardless of what it was sent: a hostile or divergent engine. */
  forceAnchor: bigint | null = null;
  delayMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  private seq = 0;
  private fillSeq = 0;

  async listSpreads() {
    return { instruments: this.listings };
  }

  private legs() {
    const wire = this.listings[0]!;
    return {
      legs: [
        { marketId: wire.legs[0]!.symbol, side: wire.legs[0]!.side as OrderSide, ratio: A(wire.legs[0]!.ratio) },
        { marketId: wire.legs[1]!.symbol, side: wire.legs[1]!.side as OrderSide, ratio: A(wire.legs[1]!.ratio) },
      ] as const,
    };
  }

  private fillOf(maker: Resting, taker: Resting, qty: bigint, anchor: bigint): EngineSpreadFill {
    const listing = this.legs();
    const prices = engineLegPrices(listing, anchor, maker.price);
    if (!prices) throw new Error('spread_leg_unfillable');
    const sides = orderLegSides(taker.side, listing);
    this.fillSeq += 1;
    const fill: EngineSpreadFill = {
      sequence: this.fillSeq,
      makerOrderId: maker.orderId,
      makerAccountId: maker.accountId,
      takerOrderId: taker.orderId,
      takerAccountId: taker.accountId,
      takerSide: taker.side,
      price: fmt(maker.price),
      qty: fmt(qty),
      legs: [0, 1].map((i) => ({
        symbol: listing.legs[i]!.marketId,
        takerSide: sides[i as 0 | 1],
        qty: fmt((qty * listing.legs[i]!.ratio) / A('1')),
        price: fmt(prices[i as 0 | 1]),
      })),
    };
    this.fills.push(fill);
    return fill;
  }

  /** The engine matches `maker` against `taker` for `qty` right now, as an event the service has not seen yet. */
  print(makerId: string, takerId: string, qty: string, anchor?: bigint): SpreadFillInput {
    const maker = this.book.find((o) => o.orderId === makerId)!;
    const taker = this.book.find((o) => o.orderId === takerId)!;
    const q = A(qty);
    const fill = this.fillOf(maker, taker, q, anchor ?? this.forceAnchor ?? taker.anchor!);
    maker.remaining -= q;
    taker.remaining -= q;
    this.book = this.book.filter((o) => o.remaining > 0n);
    return asInput(fill);
  }

  async submitSpread(_spreadId: string, request: EngineSpreadSubmitRequest): Promise<EngineSpreadSubmitResult> {
    this.submits.push(request);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      const next = this.script.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
      if (this.unwired) return rejectedReply('spread_fill_event_unwired');
      this.seq += 1;
      const taker: Resting = {
        orderId: request.orderId,
        accountId: request.accountId,
        side: request.side as OrderSide,
        price: A(request.price),
        remaining: A(request.qty),
        seq: this.seq,
        anchor: A(request.anchorReference),
      };
      const fills: EngineSpreadFill[] = [];
      if (this.matching) {
        const anchor = this.forceAnchor ?? A(request.anchorReference);
        const crossing = this.book
          .filter((m) => m.side !== taker.side && (taker.side === 'buy' ? m.price <= taker.price : m.price >= taker.price))
          .sort((a, b) =>
            a.price === b.price ? a.seq - b.seq : taker.side === 'buy' ? Number(a.price - b.price) : Number(b.price - a.price),
          );
        for (const maker of crossing) {
          if (engineLegPrices(this.legs(), anchor, maker.price) === null) return rejectedReply('spread_leg_unfillable');
        }
        for (const maker of crossing) {
          if (taker.remaining === 0n) break;
          const qty = maker.remaining < taker.remaining ? maker.remaining : taker.remaining;
          fills.push(this.fillOf(maker, taker, qty, anchor));
          maker.remaining -= qty;
          taker.remaining -= qty;
        }
        this.book = this.book.filter((o) => o.remaining > 0n);
      }
      if (taker.remaining > 0n) this.book.push(taker);
      return {
        accepted: true,
        sequence: this.seq,
        fills,
        resting:
          taker.remaining > 0n
            ? {
                kind: 'book',
                orderId: taker.orderId,
                accountId: taker.accountId,
                side: taker.side,
                price: request.price,
                remaining: fmt(taker.remaining),
                sequence: this.seq,
              }
            : null,
        rejected: null,
        cancellations: [],
      };
    } finally {
      this.inFlight -= 1;
    }
  }

  async cancel(_marketId: string, orderId: string): Promise<EngineCancelResult> {
    this.cancels.push(orderId);
    this.seq += 1;
    const resting = this.book.find((o) => o.orderId === orderId);
    if (!resting) return { cancelled: false, orderId, sequence: null, cancellation: null };
    this.book = this.book.filter((o) => o.orderId !== orderId);
    return {
      cancelled: true,
      orderId,
      sequence: this.seq,
      cancellation: { orderId, accountId: resting.accountId, remainingQty: fmt(resting.remaining), sequence: this.seq, reason: 'cancel' },
    };
  }
}

const fmt = (v: bigint): string => {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / A('1');
  const frac = (abs % A('1')).toString().padStart(18, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
};

function rejectedReply(code: string): EngineSpreadSubmitResult {
  return { accepted: false, sequence: null, fills: [], resting: null, rejected: { code, message: code }, cancellations: [] };
}

const asInput = (fill: EngineSpreadFill, spreadId = SPREAD): SpreadFillInput => ({
  spreadId,
  makerOrderId: fill.makerOrderId,
  takerOrderId: fill.takerOrderId,
  takerSide: fill.takerSide as OrderSide,
  price: fill.price,
  qty: fill.qty,
  sequence: fill.sequence,
  legs: fill.legs!.map((l) => ({ symbol: l.symbol, takerSide: l.takerSide as OrderSide, qty: l.qty, price: l.price })),
});

/** The matched-order door only rests (outright orders are not under test here). */
class RestingOutrightEngine {
  async submit(_marketId: string, request: EngineSubmitRequest): Promise<EngineSubmitResult> {
    return {
      accepted: true,
      sequence: 1,
      fills: [],
      resting: {
        kind: 'book',
        orderId: request.orderId,
        accountId: request.accountId,
        side: request.side,
        price: request.price ?? '0',
        remaining: request.qty,
        sequence: 1,
      },
      rejected: null,
      cancellations: [],
      triggered: [],
    };
  }
  async cancel(_marketId: string, orderId: string): Promise<EngineCancelResult> {
    return { cancelled: true, orderId, sequence: 1, cancellation: null };
  }
}

describe('svc-trade futures spread orders (CB-otc-16, PG-backed)', () => {
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
  let engine: FakeSpreadEngine;
  let marks: Record<string, bigint>;
  let admission: TradingAdmissionPort;
  let posts: PostRequest[];
  /** What each user paid in: the ledger must still hold exactly this across available, holds and pots. */
  let funded: bigint;

  const USERS = [ALICE, BOB, CAROL, DAVE];

  beforeEach(async () => {
    await sql`
      TRUNCATE trade.futures_spread_fills, trade.futures_spread_fill_waits, trade.futures_spread_orders,
               trade.futures_order_fills, trade.futures_orders, trade.positions, trade.markets, trade.futures_payouts,
               trade.futures_fill_waits, trade.account_position_modes, trade.liquidation_rungs, trade.futures_adl_pairs
        RESTART IDENTITY CASCADE
    `;
    const market = async (id: string, symbol: string, kind: string, quote: string) => sql`
      INSERT INTO trade.markets (
        id, symbol, base_asset, quote_asset, kind, tick_size, lot_size, min_qty, min_notional,
        maker_bps, taker_bps, status, display_name, listed_at
      ) VALUES (${id}, ${symbol}, 'BTC', ${quote}, ${kind}, '0.01', '0.0001', '0.0001', '1', 10, 20, 'active', ${symbol}, now())
    `;
    await market(FAR, FAR_SYMBOL, 'futures', 'USDT');
    await market(NEAR, NEAR_SYMBOL, 'futures', 'USDT');
    await market(SPOT, 'BTC/USDT', 'spot', 'USDT');
    await market(OTHER_QUOTE, 'BTC/USDC-PERP', 'futures', 'USDC');
    ledger = new MemoryLedger();
    engine = new FakeSpreadEngine();
    marks = { [FAR]: A('105'), [NEAR]: A('100'), [OTHER_QUOTE]: A('100'), [SPOT]: A('100') };
    admission = { admit: vi.fn(async () => ({})) } as unknown as TradingAdmissionPort;
    posts = [];
    funded = A('1000');
    for (const userId of USERS) {
      await ledger.post(
        recipes.deposit({ userId, assetId: USDT, amount: A('1000'), rail: 'test', railRef: `fund-${userId}-${randomUUID()}` }),
      );
    }
  });

  function recording(
    inner: LedgerClient,
    hook?: (request: PostRequest) => Promise<void> | void,
    after?: (request: PostRequest) => void,
  ): LedgerClient {
    return {
      ...inner,
      post: async (request: PostRequest) => {
        posts.push(request);
        await hook?.(request);
        const tx = await inner.post(request);
        after?.(request);
        return tx;
      },
      balance: (ref: Parameters<LedgerClient['balance']>[0]) => inner.balance(ref),
    } as LedgerClient;
  }

  function build(
    overrides: Partial<ConstructorParameters<typeof SpreadFuturesOrders>[0]> = {},
    ledgerImpl: LedgerClient = recording(ledger),
  ): SpreadFuturesOrders {
    const matched = new MatchedFuturesOrders({
      sql,
      ledger: ledgerImpl,
      matching: new RestingOutrightEngine() as unknown as MatchingClient,
      enabled: true,
      priceBand: BAND,
      maxLeverage: A('10'),
      now: () => NOW,
      markFor: async (marketId) => marks[marketId]!,
      assertPositionIdle: async () => undefined,
      lifecycleProof: async (marketId) => legProof(marketId),
      admission,
    });
    matchedService = matched;
    return new SpreadFuturesOrders({
      sql,
      ledger: ledgerImpl,
      matching: engine as unknown as ConstructorParameters<typeof SpreadFuturesOrders>[0]['matching'],
      enabled: true,
      priceBand: BAND,
      maxLeverage: A('10'),
      now: () => NOW,
      markFor: async (marketId) => marks[marketId]!,
      assertPositionIdle: async () => undefined,
      lifecycleProof: async (marketId) => legProof(marketId),
      admission,
      matched,
      ...overrides,
    });
  }
  let matchedService: MatchedFuturesOrders;

  function order(
    overrides: Partial<PlaceSpreadOrderInput> & Pick<PlaceSpreadOrderInput, 'userId' | 'side' | 'qty' | 'clientOrderId'>,
  ): PlaceSpreadOrderInput {
    return { spreadId: SPREAD, limitPrice: A('5'), leverage: A('10'), ...overrides };
  }

  const place = (svc: SpreadFuturesOrders, userId: string, side: OrderSide, qty: string, clientOrderId: string, limit = '5') =>
    svc.place(principal(userId), order({ userId, side, qty: A(qty), limitPrice: A(limit), clientOrderId }));

  async function orderRow(orderId: string) {
    const [row] = await sql<
      {
        status: string;
        filled_qty: string;
        applied_amount: string;
        released_amount: string;
        refusal_code: string | null;
        anchor_ref: string | null;
        engine_filled_qty: string | null;
      }[]
    >`
      SELECT status, filled_qty, applied_amount, released_amount, refusal_code, anchor_ref, engine_filled_qty
        FROM trade.futures_spread_orders WHERE id = ${orderId}
    `;
    return row!;
  }

  async function positionsOf(userId: string, marketId: string) {
    return sql<{ id: string; side: string; size: string; entry_price: string; margin_current: string; status: string }[]>`
      SELECT id, side, size, entry_price, margin_current, status FROM trade.positions
       WHERE user_id = ${userId} AND market_id = ${marketId} ORDER BY opened_at, id
    `;
  }

  async function bal(ref: Parameters<LedgerClient['balance']>[0]): Promise<bigint> {
    return (await ledger.balance(ref)).amount;
  }

  /** The hold of a spread order, recomputed from the terms its row stores: independent of the service's own helper. */
  async function holdOfRow(orderId: string): Promise<bigint> {
    const [r] = await sql<Record<string, string>[]>`SELECT * FROM trade.futures_spread_orders WHERE id = ${orderId}`;
    const row = r!;
    const terms: SpreadOrderTerms = {
      side: row.side as OrderSide,
      qty: A(row.qty!),
      limit: A(row.limit_price!),
      leverage: A(row.leverage!),
      listing: {
        legs: [
          { marketId: row.leg0_market_id!, side: row.leg0_side as OrderSide, ratio: A(row.leg0_ratio!) },
          { marketId: row.leg1_market_id!, side: row.leg1_side as OrderSide, ratio: A(row.leg1_ratio!) },
        ],
      },
      legs: [
        { ratio: A(row.leg0_ratio!), mark: A(row.leg0_mark!), delta: A(row.leg0_delta!) },
        { ratio: A(row.leg1_ratio!), mark: A(row.leg1_mark!), delta: A(row.leg1_delta!) },
      ],
    };
    return spreadHoldAmount(terms);
  }

  /**
   * The books agree. Per leg market, long size equals short size; each position's collateral pot equals its row; each
   * order's hold account holds what it locked less what fills applied and releases returned; the fills' margin adds up
   * to what the order says it applied; and every user's money is conserved (available + holds + pots = what was paid in).
   */
  async function assertBooksAgree(): Promise<void> {
    for (const marketId of [FAR, NEAR]) {
      const open = await sql<{ id: string; user_id: string; side: string; size: string; margin_current: string }[]>`
        SELECT id, user_id, side, size, margin_current FROM trade.positions WHERE market_id = ${marketId} AND status = 'open'
      `;
      let long = 0n;
      let short = 0n;
      for (const p of open) {
        if (p.side === 'long') long += parseAmount(p.size);
        else short += parseAmount(p.size);
        expect(await bal(positionCollateralAccount(p.user_id, USDT, p.id)), `pot of ${p.id} equals its margin row`).toBe(
          parseAmount(p.margin_current),
        );
      }
      expect(long, `long equals short on ${marketId}`).toBe(short);
    }
    const orders = await sql<{ id: string; user_id: string; applied_amount: string; released_amount: string; filled_qty: string }[]>`
      SELECT id, user_id, applied_amount, released_amount, filled_qty FROM trade.futures_spread_orders
    `;
    for (const o of orders) {
      const held = await bal(futuresOrderMarginAccount(o.user_id, USDT, o.id));
      const locked =
        (await ledger.balance(futuresOrderMarginAccount(o.user_id, USDT, o.id))).amount +
        parseAmount(o.applied_amount) +
        parseAmount(o.released_amount);
      const status = (await orderRow(o.id)).status;
      if (status === 'refused' || status === 'pending') continue;
      expect(locked, `${o.id}: hold less applied less released`).toBe(await holdOfRow(o.id));
      expect(held).toBeGreaterThanOrEqual(0n);
      const [fillSum] = await sql<{ total: string | null }[]>`
        SELECT COALESCE(sum(amount), 0)::text AS total FROM trade.futures_spread_fills WHERE order_id = ${o.id} AND state = 'applied'
      `;
      expect(parseAmount(fillSum!.total!), `${o.id}: applied margin is the sum of its fills`).toBe(parseAmount(o.applied_amount));
    }
    for (const userId of USERS) {
      let total = await bal(userAvailable(userId, USDT));
      for (const o of orders.filter((x) => x.user_id === userId)) total += await bal(futuresOrderMarginAccount(userId, USDT, o.id));
      const pots = await sql<{ id: string }[]>`SELECT id FROM trade.positions WHERE user_id = ${userId}`;
      for (const p of pots) total += await bal(positionCollateralAccount(userId, USDT, p.id));
      expect(total, `money of ${userId} is conserved`).toBe(funded);
    }
  }

  // ── refusals ────────────────────────────────────────────────────────────────

  describe('refusals before anything is locked', () => {
    const untouched = async () => {
      expect(engine.submits).toHaveLength(0);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
      expect(posts.filter((p) => p.reason === 'futures.order.margin.hold')).toHaveLength(0);
    };

    it('the switch off refuses a new order and touches no ledger and no engine', async () => {
      await expect(place(build({ enabled: false }), ALICE, 'buy', '1', 'off')).rejects.toMatchObject({
        code: 'trade.futures_matching_disabled',
      });
      await untouched();
    });

    it('an unset price band refuses with the typed code and invents no band', async () => {
      await expect(place(build({ priceBand: null }), ALICE, 'buy', '1', 'band')).rejects.toMatchObject({
        code: 'trade.futures_price_band_unset',
      });
      await untouched();
    });

    it('an unset leverage cap refuses; nothing is invented', async () => {
      await expect(place(build({ maxLeverage: null }), ALICE, 'buy', '1', 'cap')).rejects.toMatchObject({
        code: 'trade.leverage_cap_unset',
      });
      await untouched();
    });

    it('a caller cannot place an order for another account', async () => {
      await expect(
        build().place(principal(BOB), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: 'x' })),
      ).rejects.toMatchObject({
        status: 403,
      });
      await untouched();
    });

    it('a missing clientOrderId refuses: omitting it would double-lock margin on a retry', async () => {
      await expect(
        build().place(principal(ALICE), order({ userId: ALICE, side: 'buy', qty: A('1'), clientOrderId: '  ' })),
      ).rejects.toMatchObject({ code: 'trade.client_order_id_required' });
      await untouched();
    });

    it('a spread the engine does not list refuses, typed', async () => {
      engine.listings = [];
      await expect(place(build(), ALICE, 'buy', '1', 'unlisted')).rejects.toMatchObject({ code: 'trade.spread_unlisted', status: 404 });
      await untouched();
    });

    it('an inter-coin spread refuses: only calendar spreads of futures are taken', async () => {
      engine.listings = [{ ...LISTING, kind: 'inter_coin' }];
      await expect(place(build(), ALICE, 'buy', '1', 'inter')).rejects.toMatchObject({ code: 'trade.spread_kind_unsupported' });
      await untouched();
    });

    it('a leg that is a spot market, or not a market of this service, refuses with a typed code', async () => {
      engine.listings = [{ ...LISTING, legs: [{ symbol: SPOT, side: 'buy', ratio: '1' }, LISTING.legs[1]!] }];
      await expect(place(build(), ALICE, 'buy', '1', 'spot')).rejects.toMatchObject({ code: 'trade.spread_leg_not_futures' });
      engine.listings = [{ ...LISTING, legs: [{ symbol: 'BTC-DEC', side: 'buy', ratio: '1' }, LISTING.legs[1]!] }];
      await expect(place(build(), ALICE, 'buy', '1', 'name')).rejects.toMatchObject({ code: 'trade.spread_leg_not_futures' });
      engine.listings = [{ ...LISTING, legs: [{ symbol: randomUUID(), side: 'buy', ratio: '1' }, LISTING.legs[1]!] }];
      await expect(place(build(), ALICE, 'buy', '1', 'unknown')).rejects.toMatchObject({ code: 'trade.spread_leg_not_futures' });
      await untouched();
    });

    it('legs that settle in different quote assets refuse: one hold cannot fund both', async () => {
      engine.listings = [{ ...LISTING, legs: [LISTING.legs[0]!, { symbol: OTHER_QUOTE, side: 'sell', ratio: '1' }] }];
      await expect(place(build(), ALICE, 'buy', '1', 'quote')).rejects.toMatchObject({ code: 'trade.spread_leg_quote_mismatch' });
      await untouched();
    });

    it('a quantity off the lot and a price off the tick refuse before any hold', async () => {
      await expect(place(build(), ALICE, 'buy', '1.5', 'lot')).rejects.toMatchObject({ code: 'trade.spread_qty_off_lot' });
      await expect(place(build(), ALICE, 'buy', '1', 'tick', '5.005')).rejects.toMatchObject({ code: 'trade.spread_price_off_tick' });
      await untouched();
    });

    it('a price at which a leg could print outside its band refuses: no anchor keeps both legs inside', async () => {
      await expect(place(build(), ALICE, 'buy', '1', 'wide', '40')).rejects.toMatchObject({ code: 'trade.spread_price_outside_band' });
      await expect(place(build(), ALICE, 'sell', '1', 'wide-s', '-40')).rejects.toMatchObject({ code: 'trade.spread_price_outside_band' });
      await untouched();
    });

    it('a leg whose lifecycle is not open refuses, and nothing is held', async () => {
      const svc = build({
        lifecycleProof: async (marketId) => {
          if (marketId === NEAR) throw Object.assign(new Error('near is halted'), { code: 'trade.market_halted', status: 409 });
          return legProof(marketId);
        },
      });
      await expect(place(svc, ALICE, 'buy', '1', 'halted')).rejects.toThrow('near is halted');
      await untouched();
    });

    it('an account whose available balance cannot cover the hold is refused, never sent, and replays the same refusal', async () => {
      const poor = build();
      const broke = '55555555-5555-4555-8555-555555555555';
      await ledger.post(recipes.deposit({ userId: broke, assetId: USDT, amount: A('10'), rail: 'test', railRef: 'fund-broke' }));
      const input = order({ userId: broke, side: 'buy', qty: A('2'), clientOrderId: 'poor' });
      await expect(poor.place(principal(broke), input)).rejects.toMatchObject({ code: 'trade.futures_margin_insufficient' });
      expect(engine.submits).toHaveLength(0);
      expect(await bal(userAvailable(broke, USDT))).toBe(A('10'));
      const id = spreadOrderIdFor(broke, SPREAD, 'poor');
      expect((await orderRow(id)).status).toBe('refused');
      await expect(poor.place(principal(broke), input)).rejects.toMatchObject({ code: 'trade.futures_margin_insufficient' });
      expect(engine.submits).toHaveLength(0);
    });
  });

  // ── placement ───────────────────────────────────────────────────────────────

  describe('placement', () => {
    it('takes one hold sized for the worst fill before it sends, and sends inside the anchor window', async () => {
      const view = await place(build(), ALICE, 'buy', '2', 'a1');
      // Far: 2 x 105 / 10 = 21 initial margin + 2 x 5.25 band = 10.5. Near: 2 x 100 / 10 = 20 + 2 x 5 = 10.
      expect(view.holdAmount).toBe('61.5');
      expect(view.status).toBe('open');
      const id = spreadOrderIdFor(ALICE, SPREAD, 'a1');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, id))).toBe(A('61.5'));
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('938.5'));
      expect(await holdOfRow(id)).toBe(A('61.5'));

      // The hold was taken before the engine heard of the order; the engine got the spread's own proof and a GTC order.
      expect(engine.submits).toHaveLength(1);
      const sent = engine.submits[0]!;
      expect(sent).toMatchObject({ orderId: id, accountId: ALICE, side: 'buy', qty: '2', price: '5', tif: 'GTC' });
      expect(sent.lifecycleProof.snapshot).toMatchObject({ marketId: SPREAD, instrumentId: SPREAD, state: 'OPEN' });
      expect(sent.lifecycleProof.action).toBe('PLACE');
      expect(Number(view.anchorLow)).toBeLessThanOrEqual(Number(sent.anchorReference));
      expect(Number(sent.anchorReference)).toBeLessThanOrEqual(Number(view.anchorHigh));
      expect(view.legs.map((l) => l.side)).toEqual(['buy', 'sell']);
      const holdIndex = posts.findIndex((p) => p.reason === 'futures.order.margin.hold');
      expect(holdIndex).toBeGreaterThanOrEqual(0);
      await assertBooksAgree();
    });

    it('a sell takes the opposite side of each leg and holds for the same worst fill', async () => {
      const view = await place(build(), BOB, 'sell', '2', 'b1');
      expect(view.legs.map((l) => l.side)).toEqual(['sell', 'buy']);
      expect(view.holdAmount).toBe('61.5');
    });

    it('a retry of the same clientOrderId places nothing twice: one hold, one submit; a different request conflicts', async () => {
      const svc = build();
      const first = await place(svc, ALICE, 'buy', '1', 'dup');
      const again = await place(svc, ALICE, 'buy', '1', 'dup');
      expect(again.orderId).toBe(first.orderId);
      expect(engine.submits).toHaveLength(1);
      expect(posts.filter((p) => p.reason === 'futures.order.margin.hold')).toHaveLength(1);
      await expect(place(svc, ALICE, 'buy', '2', 'dup')).rejects.toMatchObject({ code: 'trade.client_order_id_conflict', status: 409 });
      await expect(place(svc, ALICE, 'sell', '1', 'dup')).rejects.toMatchObject({ code: 'trade.client_order_id_conflict' });
      expect(engine.submits).toHaveLength(1);
    });

    it('a hold post that fails after it lands is finished by the retry, with one hold on the books', async () => {
      let lostOnce = true;
      const lossy = recording(ledger, undefined, (request) => {
        if (request.reason === 'futures.order.margin.hold' && lostOnce) {
          lostOnce = false;
          throw new Error('reply lost after the hold posted');
        }
      });
      const svc = build({}, lossy);
      await expect(place(svc, ALICE, 'buy', '1', 'lost')).rejects.toThrow('reply lost after the hold posted');
      const id = spreadOrderIdFor(ALICE, SPREAD, 'lost');
      expect((await orderRow(id)).status).toBe('pending');
      expect(engine.submits).toHaveLength(0);

      const view = await place(svc, ALICE, 'buy', '1', 'lost');
      expect(view.status).toBe('open');
      expect(engine.submits).toHaveLength(1);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, id))).toBe(await holdOfRow(id));
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - (await holdOfRow(id)));
      await assertBooksAgree();
    });

    it('an engine that does not answer leaves the hold, marks the order, and never sends it again', async () => {
      engine.script.push(new Error('socket hang up'));
      const svc = build();
      await expect(place(svc, ALICE, 'buy', '1', 'hang')).rejects.toMatchObject({ code: 'trade.futures_submit_unknown', status: 503 });
      const id = spreadOrderIdFor(ALICE, SPREAD, 'hang');
      expect((await orderRow(id)).status).toBe('submit_unknown');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, id))).toBe(await holdOfRow(id));
      await expect(place(svc, ALICE, 'buy', '1', 'hang')).rejects.toMatchObject({ code: 'trade.futures_submit_unknown' });
      expect(engine.submits).toHaveLength(1);
      // A process that died after the claim and before the send leaves `submitting`: counted live, never resent.
      await sql`UPDATE trade.futures_spread_orders SET status = 'submitting' WHERE id = ${id}`;
      await expect(place(svc, ALICE, 'buy', '1', 'hang')).rejects.toMatchObject({ code: 'trade.futures_submit_unknown' });
      expect(engine.submits).toHaveLength(1);
    });

    it('the engine rejecting the order releases the whole hold and says why', async () => {
      engine.script.push(rejectedReply('spread_qty_off_lot'));
      await expect(place(build(), ALICE, 'buy', '1', 'rej')).rejects.toMatchObject({ code: 'trade.spread_qty_off_lot', status: 400 });
      const id = spreadOrderIdFor(ALICE, SPREAD, 'rej');
      const row = await orderRow(id);
      expect(row.status).toBe('rejected');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, id))).toBe(0n);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
      await assertBooksAgree();
    });

    it('until the engine announces spread fills, placement refuses as unwired and the hold comes straight back', async () => {
      engine.unwired = true;
      const svc = build();
      await expect(place(svc, ALICE, 'buy', '2', 'unwired')).rejects.toMatchObject({
        code: 'trade.spread_fill_event_unwired',
        status: 503,
      });
      const id = spreadOrderIdFor(ALICE, SPREAD, 'unwired');
      expect((await orderRow(id)).status).toBe('rejected');
      expect((await orderRow(id)).refusal_code).toBe('trade.spread_fill_event_unwired');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, id))).toBe(0n);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
      expect(engine.book).toHaveLength(0);
      // The retry says the same thing and does not hold or send again.
      await expect(place(svc, ALICE, 'buy', '2', 'unwired')).rejects.toMatchObject({ code: 'trade.spread_fill_event_unwired' });
      expect(engine.submits).toHaveLength(1);
      expect(posts.filter((p) => p.reason === 'futures.order.margin.hold')).toHaveLength(1);
      await assertBooksAgree();
    });
  });

  // ── fills ───────────────────────────────────────────────────────────────────

  describe('settlement', () => {
    it('two orders cross: each side opens both legs, long equals short, and each hold is spent to the unit', async () => {
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '2', 'a');
      const bob = await place(svc, BOB, 'sell', '2', 'b');
      expect(engine.fills).toHaveLength(1);
      // Bob's anchor is the grid point nearest the far mark inside both windows; the far leg prints there, the near at the residual.
      expect(engine.fills[0]!.legs!.map((l) => l.price)).toEqual(['105', '100']);

      const aFar = await positionsOf(ALICE, FAR);
      const aNear = await positionsOf(ALICE, NEAR);
      const bFar = await positionsOf(BOB, FAR);
      const bNear = await positionsOf(BOB, NEAR);
      expect([aFar[0]!.side, aNear[0]!.side, bFar[0]!.side, bNear[0]!.side]).toEqual(['long', 'short', 'short', 'long']);
      for (const p of [aFar, aNear, bFar, bNear]) expect(parseAmount(p[0]!.size)).toBe(A('2'));
      expect(parseAmount(aFar[0]!.margin_current)).toBe(A('21'));
      expect(parseAmount(aNear[0]!.margin_current)).toBe(A('20'));
      expect(parseAmount(aFar[0]!.entry_price)).toBe(A('105'));
      expect((await orderRow(alice.orderId)).status).toBe('filled');
      expect((await orderRow(bob.orderId)).status).toBe('filled');
      // 61.5 held, 41 applied, 20.5 back.
      expect((await orderRow(alice.orderId)).released_amount).toMatch(/^20\.5/);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(0n);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('959'));
      expect(await bal(userAvailable(BOB, USDT))).toBe(A('959'));
      await assertBooksAgree();
    });

    it('a fill at a better spread price than the limit still stays inside the hold', async () => {
      const svc = build();
      // Alice rests a buy at 5.00; Bob sells into it at 4.00 and so takes the better price for Alice at her own limit 5.
      const alice = await place(svc, ALICE, 'buy', '1', 'bp-a', '5');
      const bob = await place(svc, BOB, 'sell', '1', 'bp-b', '4');
      expect(engine.fills[0]!.price).toBe('5');
      expect((await orderRow(bob.orderId)).status).toBe('filled');
      expect((await orderRow(alice.orderId)).status).toBe('filled');
      await assertBooksAgree();
    });

    it('a replayed fill posts nothing twice and moves no row twice', async () => {
      const svc = build();
      await place(svc, ALICE, 'buy', '2', 'r-a');
      await place(svc, BOB, 'sell', '2', 'r-b');
      const fill = asInput(engine.fills[0]!);
      const before = {
        posts: posts.length,
        a: await positionsOf(ALICE, FAR),
        b: await positionsOf(BOB, NEAR),
        availableA: await bal(userAvailable(ALICE, USDT)),
      };
      await svc.settleFill(fill);
      await svc.settleFill(fill);
      expect(await positionsOf(ALICE, FAR)).toEqual(before.a);
      expect(await positionsOf(BOB, NEAR)).toEqual(before.b);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(before.availableA);
      expect(await sql`SELECT 1 FROM trade.futures_spread_fills`).toHaveLength(4);
      // A replay may re-ask the ledger for a key it already holds, but never with a new key.
      const keys = new Set(posts.filter((p) => p.reason === 'futures.order.margin.applied').map((p) => p.idempotencyKey));
      expect(keys.size).toBe(4);
      await assertBooksAgree();
    });

    it('an outright fill and a spread-leg fill at the same sequence on the same position both apply', async () => {
      const svc = build();
      // Alice and Bob trade the FAR market outright (sequence 1), giving Alice a long FAR position.
      const outA = await matchedService.place(principal(ALICE), {
        userId: ALICE,
        symbol: FAR_SYMBOL,
        side: 'buy',
        type: 'limit',
        qty: A('1'),
        limitPrice: A('105'),
        leverage: A('10'),
        clientOrderId: 'outright-a',
      });
      const outB = await matchedService.place(principal(BOB), {
        userId: BOB,
        symbol: FAR_SYMBOL,
        side: 'sell',
        type: 'limit',
        qty: A('1'),
        limitPrice: A('105'),
        leverage: A('10'),
        clientOrderId: 'outright-b',
      });
      await matchedService.settleFill({
        marketId: FAR,
        makerOrderId: outA.orderId,
        takerOrderId: outB.orderId,
        price: '105',
        qty: '1',
        sequence: 1,
      });
      const [slot] = await positionsOf(ALICE, FAR);
      expect(parseAmount(slot!.size)).toBe(A('1'));

      // The spread book's first fill is also sequence 1. Its legs land on the same two positions.
      await place(svc, ALICE, 'buy', '2', 's-a');
      await place(svc, BOB, 'sell', '2', 's-b');
      expect(engine.fills[0]!.sequence).toBe(1);
      const far = await positionsOf(ALICE, FAR);
      expect(far).toHaveLength(1);
      expect(far[0]!.id).toBe(slot!.id);
      expect(parseAmount(far[0]!.size)).toBe(A('3'));
      const keys = posts.filter((p) => p.reason === 'futures.order.margin.applied').map((p) => p.idempotencyKey);
      expect(keys.some((k) => k === `futures.fill:${FAR}:1:${slot!.id}`)).toBe(true);
      expect(keys.some((k) => k === `futures.fill:spread:${SPREAD}:1:0:${slot!.id}`)).toBe(true);
      expect(new Set(keys).size).toBe(keys.length);
      await assertBooksAgree();
    });

    it('a partial fill leaves the order open; a cancel then releases exactly the hold the fills did not use', async () => {
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '4', 'p-a');
      await place(svc, BOB, 'sell', '1', 'p-b');
      const mid = await orderRow(alice.orderId);
      expect(mid.status).toBe('open');
      expect(parseAmount(mid.filled_qty)).toBe(A('1'));
      expect(parseAmount(mid.applied_amount)).toBe(A('20.5'));
      const cancelled = await svc.cancel(principal(ALICE), alice.orderId);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.holdAmount).toBe('123');
      expect(cancelled.releasedAmount).toBe('102.5');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(0n);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20.5'));
      expect(engine.cancels).toEqual([alice.orderId]);
      await assertBooksAgree();
    });

    it('a fill the engine printed before a cancel settles after it, and only then is the rest of the hold released', async () => {
      engine.matching = false;
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '4', 'race-a');
      const bob = await place(svc, BOB, 'sell', '1', 'race-b');
      // The engine matched 1 of Alice's 4 before her cancel arrived; the fill's event has not reached this service.
      const fill = engine.print(alice.orderId, bob.orderId, '1');
      const cancelled = await svc.cancel(principal(ALICE), alice.orderId);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.releasedAmount).toBe('0');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(await holdOfRow(alice.orderId));

      await svc.settleFill(fill);
      const after = await orderRow(alice.orderId);
      expect(after.status).toBe('cancelled');
      expect(parseAmount(after.filled_qty)).toBe(A('1'));
      expect(parseAmount(after.applied_amount)).toBe(A('20.5'));
      expect(parseAmount(after.released_amount)).toBe(A('102.5'));
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000') - A('20.5'));
      await assertBooksAgree();

      // The engine said 1 was filled in all: a second fill cannot be funded from anywhere else.
      const carol = await place(svc, CAROL, 'sell', '1', 'race-c');
      const late = { ...asInput(engine.fills[0]!), makerOrderId: alice.orderId, takerOrderId: carol.orderId, sequence: 9 };
      await expect(svc.settleFill(late)).rejects.toMatchObject({ code: 'trade.futures_hold_released' });
    });

    it('an engine cancellation event that overtakes a fill holds the rest of the hold until the fill settles', async () => {
      engine.matching = false;
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '2', 'evt-a');
      const bob = await place(svc, BOB, 'sell', '1', 'evt-b');
      const fill = engine.print(alice.orderId, bob.orderId, '1');
      expect(await svc.releaseEngineCancellation(alice.orderId, '1')).toBe(true);
      // Replayed, the event changes nothing: the first remainder recorded stands.
      expect(await svc.releaseEngineCancellation(alice.orderId, '2')).toBe(true);
      expect(parseAmount((await orderRow(alice.orderId)).released_amount)).toBe(0n);
      await svc.settleFill(fill);
      expect(parseAmount((await orderRow(alice.orderId)).released_amount)).toBe((await holdOfRow(alice.orderId)) - A('20.5'));
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(0n);
      expect(await svc.releaseEngineCancellation(randomUUID(), '1')).toBe(false);
      await assertBooksAgree();
    });

    it('cancelling an order that is already gone from the book releases nothing it did not own', async () => {
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '1', 'gone');
      await svc.cancel(principal(ALICE), alice.orderId);
      const again = await svc.cancel(principal(ALICE), alice.orderId);
      expect(again.status).toBe('cancelled');
      expect(posts.filter((p) => p.reason === 'futures.order.margin.release')).toHaveLength(1);
      await expect(svc.cancel(principal(BOB), alice.orderId)).rejects.toMatchObject({ status: 404 });
      await assertBooksAgree();
    });

    it.each([1, 2, 3, 4])(
      'a crash after the %i-th leg post: the intent stays pending, the retry finishes once with the same amounts',
      async (crashAfter) => {
        let applied = 0;
        const crashing = recording(ledger, undefined, (request) => {
          if (request.reason === 'futures.order.margin.applied') {
            applied += 1;
            if (applied === crashAfter) throw new Error('simulated crash after the post');
          }
        });
        const svc = build({}, crashing);
        await place(svc, ALICE, 'buy', '2', 'c-a');
        await expect(place(svc, BOB, 'sell', '2', 'c-b')).rejects.toThrow('simulated crash after the post');
        const fill = asInput(engine.fills[0]!);
        const pending = await sql<{ state: string }[]>`SELECT state FROM trade.futures_spread_fills WHERE state = 'pending'`;
        expect(pending.length).toBeGreaterThan(0);
        // The side that crashed has not moved its rows: they move only after both of its legs have posted.
        const crashedSide = crashAfter <= 2 ? BOB : ALICE;
        expect(await positionsOf(crashedSide, FAR)).toHaveLength(0);

        // The matching event arrives: the intents replay with their stored amounts.
        await svc.settleFill(fill);
        await svc.settleFill(fill);
        for (const [userId, farSide] of [
          [ALICE, 'long'],
          [BOB, 'short'],
        ] as const) {
          const far = await positionsOf(userId, FAR);
          expect(far).toHaveLength(1);
          expect(far[0]!.side).toBe(farSide);
          expect(parseAmount(far[0]!.size)).toBe(A('2'));
          expect(parseAmount(far[0]!.margin_current)).toBe(A('21'));
        }
        expect(await sql`SELECT 1 FROM trade.futures_spread_fills WHERE state = 'pending'`).toHaveLength(0);
        expect((await orderRow(spreadOrderIdFor(BOB, SPREAD, 'c-b'))).status).toBe('filled');
        expect((await orderRow(spreadOrderIdFor(ALICE, SPREAD, 'c-a'))).status).toBe('filled');
        await assertBooksAgree();
      },
    );

    it('a ledger that refuses a leg for want of funds cannot reach the rows: the intents stay pending, no position is created', async () => {
      engine.matching = false;
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '2', 'nf-a');
      const bob = await place(svc, BOB, 'sell', '2', 'nf-b');
      const fill = engine.print(alice.orderId, bob.orderId, '2');
      // Drain Alice's hold behind the service's back, as a bug elsewhere would.
      const drain = await ledger.balance(futuresOrderMarginAccount(ALICE, USDT, alice.orderId));
      expect(drain.amount).toBeGreaterThan(0n);
      const failing = recording(ledger, (request) => {
        if (
          request.reason === 'futures.order.margin.applied' &&
          JSON.stringify(request, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).includes(ALICE)
        ) {
          throw new Error('insufficient hold');
        }
      });
      await expect(build({}, failing).settleFill(fill)).rejects.toThrow('insufficient hold');
      expect(await positionsOf(ALICE, FAR)).toHaveLength(0);
      expect(await positionsOf(ALICE, NEAR)).toHaveLength(0);
      // The retry on the healthy ledger completes both.
      await svc.settleFill(fill);
      expect(await positionsOf(ALICE, FAR)).toHaveLength(1);
      await assertBooksAgree();
    });

    it('a fill on a busy position waits durably, past any redelivery, and settles exactly once', async () => {
      const svc = build();
      await place(svc, ALICE, 'buy', '1', 'busy-a1');
      await place(svc, BOB, 'sell', '1', 'busy-b1');
      const [held] = await positionsOf(ALICE, FAR);
      const plan = { recipes: [], reason: 'closing', fromInsurance: '0', marginAsset: USDT };
      await sql`
        INSERT INTO trade.liquidation_rungs (rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state)
        VALUES (${randomUUID()}, ${held!.id}, ${`liq:${held!.id}`}, 'closing', '1', '10', ${sql.json(plan as never)}, 'planned')
      `;
      const alice = await place(svc, ALICE, 'buy', '1', 'busy-a2');
      // Carol sells into it: the engine prints the fill in her reply; Alice's FAR position is being closed.
      const carol = await place(svc, CAROL, 'sell', '1', 'busy-c');
      const waiting = await sql<{ attempts: number; reason: string; settled_at: Date | null }[]>`
        SELECT attempts, reason, settled_at FROM trade.futures_spread_fill_waits WHERE engine_sequence = 2
      `;
      expect(waiting[0]).toMatchObject({ attempts: 1, reason: 'trade.liquidation_in_progress', settled_at: null });
      expect(await sql`SELECT 1 FROM trade.futures_spread_fills WHERE engine_sequence = 2`).toHaveLength(0);
      expect(await positionsOf(CAROL, FAR)).toHaveLength(0);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(await holdOfRow(alice.orderId));
      expect(await bal(futuresOrderMarginAccount(CAROL, USDT, carol.orderId))).toBe(await holdOfRow(carol.orderId));

      // Redelivered by the event while the rung runs: the same wait, not another.
      expect(await svc.settleFillOrWait(asInput(engine.fills[1]!))).toBe('waiting');
      expect(await svc.retryWaitingFills(50)).toEqual({ settled: 0, waiting: 1, failed: [] });
      expect(await sql`SELECT 1 FROM trade.futures_spread_fill_waits`).toHaveLength(1);

      await sql`UPDATE trade.liquidation_rungs SET state = 'applied' WHERE position_id = ${held!.id}`;
      await sql`UPDATE trade.positions SET status = 'liquidated' WHERE id = ${held!.id}`;
      // Alice's NEAR leg is a short whose twin Bob still holds; the liquidated FAR long leaves the book uneven, so the
      // equality check below runs after the rung's own books are closed out.
      expect(await svc.retryWaitingFills(50)).toEqual({ settled: 1, waiting: 0, failed: [] });
      expect(await svc.retryWaitingFills(50)).toEqual({ settled: 0, waiting: 0, failed: [] });
      expect((await orderRow(alice.orderId)).status).toBe('filled');
      expect((await orderRow(carol.orderId)).status).toBe('filled');
      expect((await positionsOf(CAROL, FAR))[0]!.side).toBe('short');
      expect(await sql`SELECT 1 FROM trade.futures_spread_fills WHERE engine_sequence = 2`).toHaveLength(4);
    });

    it('a hostile or divergent engine that prints a leg outside the band is refused whole, and nothing posts', async () => {
      engine.matching = false;
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '1', 'h-a');
      const bob = await place(svc, BOB, 'sell', '1', 'h-b');
      const before = posts.length;
      const fill = engine.print(alice.orderId, bob.orderId, '1', A('200'));
      await expect(svc.settleFill(fill)).rejects.toMatchObject({ code: 'trade.spread_fill_outside_cover', status: 500 });
      expect(posts.length).toBe(before);
      expect(await sql`SELECT 1 FROM trade.futures_spread_fills`).toHaveLength(0);
      expect(await positionsOf(ALICE, FAR)).toHaveLength(0);
      expect(await positionsOf(BOB, FAR)).toHaveLength(0);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(await holdOfRow(alice.orderId));
      await assertBooksAgree();
    });

    it('a fill whose legs disagree with the listing, or that names an order we did not place, is refused', async () => {
      engine.matching = false;
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '1', 'm-a');
      const bob = await place(svc, BOB, 'sell', '1', 'm-b');
      const good = engine.print(alice.orderId, bob.orderId, '1');
      const swapped = { ...good, legs: [good.legs[1]!, good.legs[0]!] };
      await expect(svc.settleFill(swapped)).rejects.toMatchObject({ code: 'trade.spread_fill_legs_mismatch' });
      const wrongQty = { ...good, legs: [{ ...good.legs[0]!, qty: '2' }, good.legs[1]!] };
      await expect(svc.settleFill(wrongQty)).rejects.toMatchObject({ code: 'trade.spread_fill_legs_mismatch' });
      const notSum = { ...good, legs: [good.legs[0]!, { ...good.legs[1]!, price: '99' }] };
      await expect(svc.settleFill(notSum)).rejects.toMatchObject({ code: 'trade.spread_fill_legs_mismatch' });
      await expect(svc.settleFill({ ...good, takerOrderId: randomUUID() })).rejects.toMatchObject({
        code: 'trade.spread_fill_unknown_order',
      });
      await expect(svc.settleFill({ ...good, qty: '2', legs: good.legs.map((l) => ({ ...l, qty: '2' })) })).rejects.toBeTruthy();
      expect(await sql`SELECT 1 FROM trade.futures_spread_fills`).toHaveLength(0);
      await svc.settleFill(good);
      await assertBooksAgree();
    });

    it('a fill outside the order limit is refused before anything posts', async () => {
      engine.matching = false;
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '1', 'l-a', '5');
      const bob = await place(svc, BOB, 'sell', '1', 'l-b', '5');
      const fill = engine.print(alice.orderId, bob.orderId, '1');
      const dearer = { ...fill, price: '6', legs: [fill.legs[0]!, { ...fill.legs[1]!, price: '99' }] };
      await expect(svc.settleFill(dearer)).rejects.toMatchObject({ code: 'trade.futures_fill_outside_limit' });
      expect(await sql`SELECT 1 FROM trade.futures_spread_fills`).toHaveLength(0);
    });
  });

  // ── the anchor ──────────────────────────────────────────────────────────────

  describe('the anchor reference', () => {
    it('is refused, typed, when a resting order it crosses cannot be covered at any anchor; nothing is sent and the hold is back', async () => {
      const svc = build();
      await place(svc, ALICE, 'buy', '1', 'st-a');
      // The market moves a long way while Alice rests; her window no longer meets a fresh seller's.
      marks[FAR] = A('125');
      marks[NEAR] = A('120');
      await expect(place(svc, BOB, 'sell', '1', 'st-b')).rejects.toMatchObject({ code: 'trade.spread_anchor_uncovered', status: 409 });
      expect(engine.submits).toHaveLength(1);
      const id = spreadOrderIdFor(BOB, SPREAD, 'st-b');
      expect((await orderRow(id)).status).toBe('rejected');
      expect(await bal(futuresOrderMarginAccount(BOB, USDT, id))).toBe(0n);
      expect(await bal(userAvailable(BOB, USDT))).toBe(A('1000'));
      // Alice's order is untouched and still cancellable.
      const cancelled = await svc.cancel(principal(ALICE), spreadOrderIdFor(ALICE, SPREAD, 'st-a'));
      expect(cancelled.status).toBe('cancelled');
      await assertBooksAgree();
    });

    it('orders that do not cross do not constrain each other', async () => {
      const svc = build();
      await place(svc, ALICE, 'buy', '1', 'nc-a', '4');
      marks[FAR] = A('125');
      marks[NEAR] = A('120');
      // Bob wants 6 or better: Alice's 4 does not cross it.
      await place(svc, BOB, 'sell', '1', 'nc-b', '6');
      expect(engine.submits).toHaveLength(2);
      expect(engine.fills).toHaveLength(0);
    });

    it('is picked under one lock per spread: concurrent placements are sent one at a time', async () => {
      engine.delayMs = 20;
      const svc = build();
      const [a, b] = await Promise.all([place(svc, ALICE, 'buy', '1', 'lk-a'), place(svc, BOB, 'sell', '1', 'lk-b')]);
      expect(engine.maxInFlight).toBe(1);
      expect(engine.fills).toHaveLength(1);
      const rows = await sql<{ status: string }[]>`SELECT status FROM trade.futures_spread_orders`;
      expect(rows.map((r) => r.status)).toEqual(['filled', 'filled']);
      expect([a.orderId, b.orderId]).toHaveLength(2);
      await assertBooksAgree();
    });
  });

  // ── one-way mode and liquidation ────────────────────────────────────────────

  describe('one-way mode and the liquidation sweep', () => {
    it("a live spread order blocks an opening order on a leg's other side, and the reverse", async () => {
      const svc = build();
      await place(svc, ALICE, 'buy', '1', 'ow-a', '4');
      // The spread buy is long FAR and short NEAR. An outright sell of FAR would open the other side.
      await expect(
        matchedService.place(principal(ALICE), {
          userId: ALICE,
          symbol: FAR_SYMBOL,
          side: 'sell',
          type: 'limit',
          qty: A('1'),
          limitPrice: A('105'),
          leverage: A('10'),
          clientOrderId: 'ow-out',
        }),
      ).rejects.toMatchObject({ code: 'trade.futures_one_way_flip_refused' });
      // And the spread sell (short FAR, long NEAR) opens both legs' other sides.
      await expect(place(svc, ALICE, 'sell', '1', 'ow-s', '9')).rejects.toMatchObject({ code: 'trade.futures_one_way_flip_refused' });
      // The reverse: an outright buy of NEAR, which the spread buy sells, is refused too.
      await expect(
        matchedService.place(principal(ALICE), {
          userId: ALICE,
          symbol: NEAR_SYMBOL,
          side: 'buy',
          type: 'limit',
          qty: A('1'),
          limitPrice: A('100'),
          leverage: A('10'),
          clientOrderId: 'ow-near',
        }),
      ).rejects.toMatchObject({ code: 'trade.futures_one_way_flip_refused' });
      // A live outright order refuses the spread that would flip it.
      await matchedService.place(principal(CAROL), {
        userId: CAROL,
        symbol: FAR_SYMBOL,
        side: 'buy',
        type: 'limit',
        qty: A('1'),
        limitPrice: A('105'),
        leverage: A('10'),
        clientOrderId: 'ow-c',
      });
      await expect(place(svc, CAROL, 'sell', '1', 'ow-cs', '5')).rejects.toMatchObject({ code: 'trade.futures_one_way_flip_refused' });
      // Hedge mode allows it.
      await sql`INSERT INTO trade.account_position_modes (user_id, mode, source, client_mode_id) VALUES (${CAROL}, 'hedge', 'user', 'm1')`;
      await place(svc, CAROL, 'sell', '1', 'ow-cs', '5');
    });

    it('the liquidation sweep pulls a growing spread order off the book and returns its hold', async () => {
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '2', 'lq-a', '4');
      const port = svc.liquidationPort;
      expect(await port.owns(alice.orderId)).toBe(true);
      expect(await port.owns(randomUUID())).toBe(false);
      // The buy grows a long FAR position and a short NEAR position, and nothing else.
      expect(await port.growing(FAR, ALICE)).toEqual([{ orderId: alice.orderId, side: 'buy' }]);
      expect(await port.growing(NEAR, ALICE)).toEqual([{ orderId: alice.orderId, side: 'sell' }]);
      expect(await port.growing(FAR, BOB)).toEqual([]);

      expect(await port.cancelForLiquidation(alice.orderId)).toBe('cancelled');
      expect(engine.book).toHaveLength(0);
      const row = await orderRow(alice.orderId);
      expect(row.status).toBe('cancelled');
      expect(row.refusal_code).toBe('trade.liquidation_in_progress');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(0n);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
      expect(await port.growing(FAR, ALICE)).toEqual([]);
      expect(await port.cancelForLiquidation(alice.orderId)).toBe('not_resting');
      await assertBooksAgree();
    });

    it("the liquidation tick's order book lists a growing spread order beside the matched ones and pulls it through the engine", async () => {
      const svc = build();
      matchedService.attachSpreads(svc.liquidationPort);
      const alice = await place(svc, ALICE, 'buy', '1', 'lq-book', '4');
      const outright = await matchedService.place(principal(ALICE), {
        userId: ALICE,
        symbol: FAR_SYMBOL,
        side: 'buy',
        type: 'limit',
        qty: A('1'),
        limitPrice: A('105'),
        leverage: A('10'),
        clientOrderId: 'lq-out',
      });
      const book = matchedService.increasingOrderBook;
      const listed = await book.list(FAR, ALICE);
      expect(listed.map((o) => o.orderId).sort()).toEqual([alice.orderId, outright.orderId].sort());
      expect(listed.every((o) => o.side === 'buy' && !o.reduceOnly)).toBe(true);
      expect(await book.cancelAndRelease(FAR, alice.orderId)).toBe('released');
      expect(engine.cancels).toEqual([alice.orderId]);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(0n);
      expect((await orderRow(alice.orderId)).status).toBe('cancelled');
      expect((await book.list(FAR, ALICE)).map((o) => o.orderId)).toEqual([outright.orderId]);
      // An engine that does not confirm the cancel holds the liquidation back.
      const again = await place(svc, ALICE, 'buy', '1', 'lq-book2', '4');
      engine.cancel = async () => {
        throw new Error('timeout');
      };
      expect(await book.cancelAndRelease(FAR, again.orderId)).toBe('timeout');
      expect((await orderRow(again.orderId)).status).toBe('open');
    });

    it('a spread order not yet sent is cancelled before any send can claim it', async () => {
      const svc = build();
      engine.script.push(new Error('boom'));
      await expect(place(svc, ALICE, 'buy', '1', 'lq-h', '4')).rejects.toBeTruthy();
      const id = spreadOrderIdFor(ALICE, SPREAD, 'lq-h');
      await sql`UPDATE trade.futures_spread_orders SET status = 'held' WHERE id = ${id}`;
      expect(await svc.liquidationPort.cancelForLiquidation(id)).toBe('cancelled');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, id))).toBe(0n);
      // The retry finds it cancelled and does not send it.
      expect((await place(svc, ALICE, 'buy', '1', 'lq-h', '4')).status).toBe('cancelled');
      expect(engine.submits).toHaveLength(1);
    });

    it('an engine that does not answer the cancel reports a timeout and leaves the hold', async () => {
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '1', 'lq-t', '4');
      engine.cancel = async () => {
        throw new Error('timeout');
      };
      expect(await svc.liquidationPort.cancelForLiquidation(alice.orderId)).toBe('timeout');
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(await holdOfRow(alice.orderId));
    });
  });

  // ── the guards inside settlement ────────────────────────────────────────────

  function recordIntentsDirect(svc: SpreadFuturesOrders, orderId: string, fill: SpreadFillInput, isTaker: boolean): Promise<unknown> {
    const s = svc as unknown as {
      deps: { sql: typeof sql };
      recordIntents(tx: unknown, orderId: string, fill: unknown, isTaker: boolean): Promise<unknown>;
    };
    const parsed = {
      spreadId: fill.spreadId,
      makerOrderId: fill.makerOrderId,
      takerOrderId: fill.takerOrderId,
      takerSide: fill.takerSide,
      sequence: fill.sequence,
      price: A(fill.price),
      qty: A(fill.qty),
      legs: fill.legs.map((l) => ({ symbol: l.symbol, takerSide: l.takerSide, qty: A(l.qty), price: A(l.price) })),
    };
    return s.deps.sql.begin(async (tx) => s.recordIntents(tx, orderId, parsed, isTaker));
  }

  // ── a pending spread leg holds its position (review of PR 5614) ─────────────

  describe('a spread leg that has posted and not yet written its row', () => {
    interface Fixture {
      svc: SpreadFuturesOrders;
      fill: SpreadFillInput;
      bobFar: string;
      bobNear: string;
      aliceFar: string;
      reduce?: { orderId: string };
      carol?: { orderId: string };
    }

    /**
     * Alice long / Bob short a calendar spread of 1 (settled). Then a second fill is recorded and CRASHES after its first leg
     * posted: Bob's two leg intents are `pending` on his existing positions, his FAR pot already holds the first leg's margin
     * and the rows have not caught up. Alice's side of that fill has not been recorded yet.
     */
    async function pendingLeg(options: { withReduce?: boolean } = {}): Promise<Fixture> {
      const svc = build();
      await place(svc, ALICE, 'buy', '1', 'pg-a1');
      await place(svc, BOB, 'sell', '1', 'pg-b1');
      const bobFar = (await positionsOf(BOB, FAR))[0]!.id;
      const bobNear = (await positionsOf(BOB, NEAR))[0]!.id;
      const aliceFar = (await positionsOf(ALICE, FAR))[0]!.id;
      let reduce: { orderId: string } | undefined;
      let carol: { orderId: string } | undefined;
      if (options.withReduce) {
        const outright = (userId: string, side: 'buy' | 'sell', clientOrderId: string, reduceOnly = false) => ({
          userId,
          symbol: FAR_SYMBOL,
          side,
          type: 'limit' as const,
          qty: A('1'),
          limitPrice: A('105'),
          leverage: A('10'),
          reduceOnly,
          clientOrderId,
        });
        reduce = await matchedService.place(principal(BOB), outright(BOB, 'buy', 'pg-reduce', true));
        carol = await matchedService.place(principal(CAROL), outright(CAROL, 'sell', 'pg-carol'));
      }
      await place(svc, ALICE, 'buy', '1', 'pg-a2');
      let crashed = false;
      const crashing = recording(ledger, undefined, (request) => {
        if (request.reason === 'futures.order.margin.applied' && !crashed) {
          crashed = true;
          throw new Error('simulated crash after the post');
        }
      });
      await expect(place(build({}, crashing), BOB, 'sell', '1', 'pg-b2')).rejects.toThrow('simulated crash after the post');
      expect(
        await sql`SELECT 1 FROM trade.futures_spread_fills WHERE state = 'pending' AND position_id IN (${bobFar}, ${bobNear})`,
      ).toHaveLength(2);
      const fill = asInput(engine.fills[1]!);
      return { svc: build(), fill, bobFar, bobNear, aliceFar, reduce, carol };
    }

    const recover = async (f: Fixture) => {
      await f.svc.settleFill(f.fill);
      expect(await sql`SELECT 1 FROM trade.futures_spread_fills WHERE state = 'pending'`).toHaveLength(0);
    };

    // The blocker: an outright reduce fill must wait for a pending spread leg on the same position.
    it('an outright reduce fill waits for it: the position is not closed from under the leg that has posted into its pot', async () => {
      const f = await pendingLeg({ withReduce: true });
      const reduceFill = {
        marketId: FAR,
        makerOrderId: f.reduce!.orderId,
        takerOrderId: f.carol!.orderId,
        price: '105',
        qty: '1',
        sequence: 77,
      };
      const potBefore = await bal(positionCollateralAccount(BOB, USDT, f.bobFar));
      expect(potBefore).toBeGreaterThan(parseAmount((await positionsOf(BOB, FAR))[0]!.margin_current));

      // Refused whole and kept to retry: nothing is recorded, nothing posts, the position stays open.
      await expect(matchedService.settleFill(reduceFill)).rejects.toMatchObject({ code: 'trade.futures_fill_in_progress', status: 409 });
      expect(await matchedService.settleFillOrWait(reduceFill)).toBe('waiting');
      expect(await sql`SELECT 1 FROM trade.futures_order_fills WHERE engine_sequence = 77`).toHaveLength(0);
      expect((await positionsOf(BOB, FAR))[0]).toMatchObject({ status: 'open' });
      expect(await bal(positionCollateralAccount(BOB, USDT, f.bobFar))).toBe(potBefore);

      // The spread's own second transaction lands, and then the reduce fill settles against the grown row.
      await recover(f);
      const grown = (await positionsOf(BOB, FAR))[0]!;
      expect(grown.status).toBe('open');
      expect(parseAmount(grown.size)).toBe(A('2'));
      expect(await bal(positionCollateralAccount(BOB, USDT, f.bobFar))).toBe(parseAmount(grown.margin_current));
      expect(await matchedService.retryWaitingFills(50)).toEqual({ settled: 1, waiting: 0, failed: [] });
      const reduced = (await positionsOf(BOB, FAR))[0]!;
      expect(reduced.status).toBe('open');
      expect(parseAmount(reduced.size)).toBe(A('1'));
      expect(await bal(positionCollateralAccount(BOB, USDT, f.bobFar))).toBe(parseAmount(reduced.margin_current));
      // Nothing is left pending or stranded: the spread's orders ended with their holds returned.
      expect(await sql`SELECT 1 FROM trade.futures_spread_fills WHERE state = 'pending'`).toHaveLength(0);
      expect(await bal(futuresOrderMarginAccount(BOB, USDT, spreadOrderIdFor(BOB, SPREAD, 'pg-b2')))).toBe(0n);
    });

    it('the same guard runs under the position lock, where the reduce intent is recorded', async () => {
      const f = await pendingLeg({ withReduce: true });
      const m = matchedService as unknown as {
        deps: { sql: typeof sql };
        recordReduceIntent(
          tx: unknown,
          input: { marketId: string; orderId: string; sequence: number; price: bigint; qty: bigint },
        ): Promise<unknown>;
      };
      await expect(
        m.deps.sql.begin(async (tx) =>
          m.recordReduceIntent(tx, { marketId: FAR, orderId: f.reduce!.orderId, sequence: 78, price: A('105'), qty: A('1') }),
        ),
      ).rejects.toMatchObject({ code: 'trade.futures_fill_in_progress' });
      expect(await sql`SELECT 1 FROM trade.futures_order_fills`).toHaveLength(0);
      await recover(f);
    });

    it('a leg that only grows the position does not hold back an outright fill that also only grows it', async () => {
      const f = await pendingLeg();
      const outright = (userId: string, side: 'buy' | 'sell', clientOrderId: string) => ({
        userId,
        symbol: FAR_SYMBOL,
        side,
        type: 'limit' as const,
        qty: A('1'),
        limitPrice: A('105'),
        leverage: A('10'),
        clientOrderId,
      });
      const bobSell = await matchedService.place(principal(BOB), outright(BOB, 'sell', 'pg-bob-open'));
      const dave = await matchedService.place(principal(DAVE), outright(DAVE, 'buy', 'pg-dave'));
      await matchedService.settleFill({
        marketId: FAR,
        makerOrderId: bobSell.orderId,
        takerOrderId: dave.orderId,
        price: '105',
        qty: '1',
        sequence: 79,
      });
      // Bob's short grew by the outright fill while his spread leg was still pending; the leg then lands on top of it.
      expect(parseAmount((await positionsOf(BOB, FAR))[0]!.size)).toBe(A('2'));
      await recover(f);
      expect(parseAmount((await positionsOf(BOB, FAR))[0]!.size)).toBe(A('3'));
      expect(await bal(positionCollateralAccount(BOB, USDT, f.bobFar))).toBe(parseAmount((await positionsOf(BOB, FAR))[0]!.margin_current));
    });

    // The other direction: the spread waits for a pending outright reduce intent on its leg positions.
    describe('and the spread settlement waits for a pending outright reduce intent', () => {
      async function pendingOutrightReduce(positionId: string, userId: string) {
        const orderId = randomUUID();
        await sql`
          INSERT INTO trade.futures_orders (
            id, user_id, market_id, client_order_id, side, order_type, qty, limit_price, mark_price, band_low, band_high,
            leverage, hold_asset, status, reduce_only, position_id, bankruptcy_price
          ) VALUES (${orderId}, ${userId}, ${FAR}, ${`pending-${orderId}`}, 'sell', 'limit', '1', '105', '105', '99.75', '110.25', '10', 'USDT', 'open', true, ${positionId}, '0')
        `;
        await sql`
          INSERT INTO trade.futures_order_fills (
            fill_key, order_id, market_id, engine_sequence, position_id, qty, price, amount, new_filled, new_adverse, new_applied, state,
            kind, realized_pnl, loss_from_margin, loss_from_insurance, loss_unbooked, profit, margin_release, pot_out, initial_out, closes_position
          ) VALUES (${`${FAR}:5:${positionId}`}, ${orderId}, ${FAR}, 5, ${positionId}, '1', '105', '0', '1', '0', '0', 'pending',
            'reduce', '0', '0', '0', '0', '0', '5', '5', '5', false)
        `;
      }

      async function nextFill(): Promise<{ fill: SpreadFillInput; alice: SpreadOrderView }> {
        engine.matching = false;
        const svc = build();
        const alice = await place(svc, ALICE, 'buy', '1', 'ox-a');
        const dave = await place(svc, DAVE, 'sell', '1', 'ox-d');
        return { fill: engine.print(alice.orderId, dave.orderId, '1'), alice };
      }

      it('refuses the fill whole before either side records, and settles once the reduce intent is applied', async () => {
        const svc = build();
        await place(svc, ALICE, 'buy', '1', 'ox-first');
        await place(svc, BOB, 'sell', '1', 'ox-first-b');
        const aliceFar = (await positionsOf(ALICE, FAR))[0]!.id;
        await pendingOutrightReduce(aliceFar, ALICE);
        const { fill } = await nextFill();
        const before = posts.length;
        await expect(svc.settleFill(fill)).rejects.toMatchObject({ code: 'trade.futures_fill_in_progress', status: 409 });
        // Whole: Dave's side (the taker, checked first) recorded and posted nothing either.
        expect(posts.length).toBe(before);
        expect(await sql`SELECT 1 FROM trade.futures_spread_fills WHERE engine_sequence = ${fill.sequence}`).toHaveLength(0);
        expect(await svc.settleFillOrWait(fill)).toBe('waiting');
        await sql`UPDATE trade.futures_order_fills SET state = 'applied', applied_at = now() WHERE position_id = ${aliceFar}`;
        expect(await svc.retryWaitingFills(50)).toEqual({ settled: 1, waiting: 0, failed: [] });
        expect(parseAmount((await positionsOf(ALICE, FAR))[0]!.size)).toBe(A('2'));
      });

      it('and under the lock where the leg intents are recorded', async () => {
        const svc = build();
        await place(svc, ALICE, 'buy', '1', 'ox2-first');
        await place(svc, BOB, 'sell', '1', 'ox2-first-b');
        const aliceFar = (await positionsOf(ALICE, FAR))[0]!.id;
        await pendingOutrightReduce(aliceFar, ALICE);
        const { fill, alice } = await nextFill();
        await expect(recordIntentsDirect(svc, alice.orderId, fill, false)).rejects.toMatchObject({
          code: 'trade.futures_fill_in_progress',
        });
        expect(await sql`SELECT 1 FROM trade.futures_spread_fills WHERE engine_sequence = ${fill.sequence}`).toHaveLength(0);
      });

      it('a live liquidation rung on a leg position refuses the fill whole before either side records, and again under the lock', async () => {
        const svc = build();
        await place(svc, ALICE, 'buy', '1', 'rg-first');
        await place(svc, BOB, 'sell', '1', 'rg-first-b');
        const aliceFar = (await positionsOf(ALICE, FAR))[0]!.id;
        const plan = { recipes: [], reason: 'closing', fromInsurance: '0', marginAsset: USDT };
        await sql`
          INSERT INTO trade.liquidation_rungs (rung_id, position_id, liquidation_id, kind, from_size, from_margin, plan, state)
          VALUES (${randomUUID()}, ${aliceFar}, ${`liq:${aliceFar}`}, 'closing', '1', '10', ${sql.json(plan as never)}, 'planned')
        `;
        const { fill, alice } = await nextFill();
        const before = posts.length;
        await expect(svc.settleFill(fill)).rejects.toMatchObject({ code: 'trade.liquidation_in_progress', status: 409 });
        expect(posts.length).toBe(before);
        expect(await sql`SELECT 1 FROM trade.futures_spread_fills WHERE engine_sequence = ${fill.sequence}`).toHaveLength(0);
        await expect(recordIntentsDirect(svc, alice.orderId, fill, false)).rejects.toMatchObject({ code: 'trade.liquidation_in_progress' });
        expect(await sql`SELECT 1 FROM trade.futures_spread_fills WHERE engine_sequence = ${fill.sequence}`).toHaveLength(0);
      });
    });

    // Every other operation that must not move a position under a pending leg.
    it('refuses a close', async () => {
      const f = await pendingLeg();
      const positions = new PositionService(sql, ledger, {
        marks: memoryMarkBook().source(),
        profitSource: null,
        maxLeverage: A('10'),
        now: () => NOW,
      });
      await expect(positions.close(BOB, f.bobFar)).rejects.toMatchObject({ code: 'trade.futures_fill_in_progress', status: 409 });
      await expect(positions.close(BOB, f.bobNear)).rejects.toMatchObject({ code: 'trade.futures_fill_in_progress', status: 409 });
      expect((await positionsOf(BOB, FAR))[0]!.status).toBe('open');
    });

    it('keeps a liquidation rung from beginning', async () => {
      const f = await pendingLeg();
      const row = (await positionsOf(BOB, FAR))[0]!;
      const plan = {
        recipes: [],
        sizeClosed: parseAmount(row.size),
        marginRemaining: 0n,
        marginTaken: parseAmount(row.margin_current),
        releaseShort: 0n,
        lossShort: 0n,
        reason: 'bankrupt_full_close',
        fromInsurance: 0n,
        marginAsset: USDT,
      };
      const begin = (rungId: string, size: string, margin: string) =>
        sqlLiquidationRungStore(sql).begin({
          rungId,
          positionId: f.bobFar,
          liquidationId: `liq:${f.bobFar}`,
          kind: 'closing',
          fromSize: parseAmount(size),
          fromMargin: parseAmount(margin),
          plan,
        });
      // The row still shows the settled fill only, so size and margin match: only the pending leg stands in the way.
      expect(await begin(randomUUID(), row.size, row.margin_current)).toEqual({ status: 'changed' });
      expect(await sql`SELECT 1 FROM trade.liquidation_rungs`).toHaveLength(0);
      await recover(f);
      const grown = (await positionsOf(BOB, FAR))[0]!;
      expect((await begin(randomUUID(), grown.size, grown.margin_current)).status).toBe('created');
    });

    it('keeps the position out of an ADL pair, as the candidate', async () => {
      const f = await pendingLeg();
      // Carol is bankrupt long on FAR with a bankruptcy price (104) under Bob's short entry (105): Bob would be a candidate.
      const carol = randomUUID();
      await sql`
        INSERT INTO trade.positions (id, user_id, market_id, side, status, size, entry_price, margin_initial, margin_current, margin_asset)
        VALUES (${carol}, ${CAROL}, ${FAR}, 'long', 'open', '1', '105', '1', '1', 'USDT')
      `;
      const candidates = () =>
        sqlAdlCandidates(sql, TEST_ADL_RANKING)({ positionId: carol, userId: CAROL, marketId: FAR, side: 'long', uncoveredShortfall: 1n });
      expect((await candidates()).map((c) => c.positionId)).toEqual([]);
      await recover(f);
      expect((await candidates()).map((c) => c.positionId)).toEqual([f.bobFar]);
    });

    it('keeps the position out of an ADL pair, as the bankrupt side', async () => {
      const f = await pendingLeg();
      // Bob's FAR short is the bankrupt one (bankruptcy price 115.5); Carol's long, funded and in profit there, is the candidate.
      const carol = randomUUID();
      await ledger.post(recipes.futuresMarginLock({ positionId: carol, userId: CAROL, assetId: USDT, amount: A('1') }));
      await sql`
        INSERT INTO trade.positions (id, user_id, market_id, side, status, size, entry_price, margin_initial, margin_current, margin_asset)
        VALUES (${carol}, ${CAROL}, ${FAR}, 'long', 'open', '1', '50', '1', '1', 'USDT')
      `;
      const reduce = () =>
        sqlAdlPairReducer(sql, ledger).reduce({
          positionId: carol,
          bankruptPositionId: f.bobFar,
          sizeClosed: A('1'),
          reason: ADL_DISCLOSURE_BEFORE_ACTION,
          disclosureEventId: 'd1',
        });
      const refused = await reduce();
      expect(refused?.sizeClosed ?? 0n).toBe(0n);
      expect(await sql`SELECT 1 FROM trade.futures_adl_pairs`).toHaveLength(0);
      await recover(f);
      const paired = await reduce();
      expect(paired?.sizeClosed ?? 0n).toBeGreaterThan(0n);
      expect(await sql`SELECT 1 FROM trade.futures_adl_pairs`).toHaveLength(1);
    });

    it('keeps the position out of funding', async () => {
      const f = await pendingLeg();
      const listed = async () => (await sqlFundingPositionLoader(sql).listOpenForMarket(FAR)).map((p) => p.positionId);
      // Alice's FAR long has no pending leg and is listed; Bob's short is not.
      expect(await listed()).toEqual([f.aliceFar]);
      await recover(f);
      expect((await listed()).sort()).toEqual([f.aliceFar, f.bobFar].sort());
    });

    it('keeps the position out of dated settlement', async () => {
      const f = await pendingLeg();
      const listed = async () => (await sqlDatedSettlementPositionLoader(sql).listOpenForMarket(FAR)).map((p) => p.positionId);
      expect(await listed()).toEqual([f.aliceFar]);
      await recover(f);
      expect((await listed()).sort()).toEqual([f.aliceFar, f.bobFar].sort());
    });
  });

  describe('an intent that is already applied', () => {
    it('is not posted again and not applied again: a replay of a settled fill makes no ledger call at all', async () => {
      const svc = build();
      await place(svc, ALICE, 'buy', '2', 'ap-a');
      await place(svc, BOB, 'sell', '2', 'ap-b');
      const fill = asInput(engine.fills[0]!);
      const before = posts.length;
      const rows = await positionsOf(ALICE, FAR);
      await svc.settleFill(fill);
      expect(posts.length).toBe(before);
      expect(await positionsOf(ALICE, FAR)).toEqual(rows);
    });

    it('is not applied to the rows again when the second transaction is run twice', async () => {
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '2', 'ap2-a');
      await place(svc, BOB, 'sell', '2', 'ap2-b');
      const fill = asInput(engine.fills[0]!);
      const rows = await positionsOf(ALICE, FAR);
      const inner = svc as unknown as {
        deps: { sql: typeof sql };
        applyIntents(tx: unknown, orderId: string, sequence: number): Promise<string[]>;
      };
      const again = await inner.deps.sql.begin(async (tx) => inner.applyIntents(tx, alice.orderId, fill.sequence));
      expect(again.sort()).toEqual([rows[0]!.id, (await positionsOf(ALICE, NEAR))[0]!.id].sort());
      expect(await positionsOf(ALICE, FAR)).toEqual(rows);
      expect(parseAmount((await orderRow(alice.orderId)).filled_qty)).toBe(A('2'));
      await assertBooksAgree();
    });

    it('a fill with no intent has nothing to apply: it refuses rather than guess', async () => {
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '1', 'ap3-a');
      const inner = svc as unknown as {
        deps: { sql: typeof sql };
        applyIntents(tx: unknown, orderId: string, sequence: number): Promise<string[]>;
      };
      await expect(inner.deps.sql.begin(async (tx) => inner.applyIntents(tx, alice.orderId, 99))).rejects.toMatchObject({
        code: 'trade.futures_fill_missing',
      });
    });
  });

  describe('releasing the unused hold', () => {
    const releases = () => posts.filter((p) => p.reason === 'futures.order.margin.release');
    const releaseNow = (svc: SpreadFuturesOrders, orderId: string) =>
      (svc as unknown as { releaseWhenDone(orderId: string): Promise<void> }).releaseWhenDone(orderId);

    it('waits while the order may still fill: a live order releases nothing', async () => {
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '2', 'rl-live');
      await sql`UPDATE trade.futures_spread_orders SET engine_filled_qty = '0' WHERE id = ${alice.orderId}`;
      await releaseNow(svc, alice.orderId);
      expect(releases()).toHaveLength(0);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(await holdOfRow(alice.orderId));
    });

    it('waits for the engine to say how much it filled: a cancelled order with no remainder yet releases nothing', async () => {
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '2', 'rl-unknown');
      await sql`UPDATE trade.futures_spread_orders SET status = 'cancelled' WHERE id = ${alice.orderId}`;
      await releaseNow(svc, alice.orderId);
      expect(releases()).toHaveLength(0);
    });

    it('waits until every fill the engine printed has settled', async () => {
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '2', 'rl-short');
      await sql`UPDATE trade.futures_spread_orders SET status = 'cancelled', engine_filled_qty = '1' WHERE id = ${alice.orderId}`;
      await releaseNow(svc, alice.orderId);
      expect(releases()).toHaveLength(0);
    });

    it('waits while a fill of the order is still pending, even when the counts already agree', async () => {
      const svc = build();
      await place(svc, ALICE, 'buy', '1', 'rl-p-a');
      const f = await (async () => {
        await place(svc, BOB, 'sell', '1', 'rl-p-b');
        return null;
      })();
      expect(f).toBeNull();
      const aliceOrder = spreadOrderIdFor(ALICE, SPREAD, 'rl-p-a');
      // Put a leg back to pending, as a crash between the post and the row write leaves it.
      await sql`UPDATE trade.futures_spread_fills SET state = 'pending', applied_at = NULL WHERE order_id = ${aliceOrder} AND leg_index = 1`;
      await sql`UPDATE trade.futures_spread_orders SET status = 'cancelled', engine_filled_qty = '1', released_amount = 0 WHERE id = ${aliceOrder}`;
      const before = releases().length;
      await releaseNow(svc, aliceOrder);
      expect(releases().length).toBe(before);
    });

    it('never releases more than the hold less what the fills used', async () => {
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '1', 'rl-over');
      await sql`
        UPDATE trade.futures_spread_orders
           SET status = 'cancelled', engine_filled_qty = '0', leg0_applied = 1000, applied_amount = 1000 + leg1_applied WHERE id = ${alice.orderId}
      `;
      await expect(releaseNow(svc, alice.orderId)).rejects.toMatchObject({ code: 'trade.futures_hold_exceeded' });
      expect(releases()).toHaveLength(0);
    });

    it('releases the remainder once, however many times it is asked', async () => {
      const svc = build();
      const alice = await place(svc, ALICE, 'buy', '2', 'rl-once');
      await svc.cancel(principal(ALICE), alice.orderId);
      expect(releases()).toHaveLength(1);
      await releaseNow(svc, alice.orderId);
      await releaseNow(svc, alice.orderId);
      await svc.cancel(principal(ALICE), alice.orderId);
      expect(releases()).toHaveLength(1);
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(0n);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
    });

    it('a crash after the release posted and before the row was written is finished by the retry, once, on the same key', async () => {
      let crash = true;
      const crashing = recording(ledger, undefined, (request) => {
        if (request.reason === 'futures.order.margin.release' && crash) {
          crash = false;
          throw new Error('simulated crash after the release posted');
        }
      });
      const svc = build({}, crashing);
      const alice = await place(svc, ALICE, 'buy', '2', 'rl-crash');
      await expect(svc.cancel(principal(ALICE), alice.orderId)).rejects.toThrow('simulated crash after the release posted');
      // The ledger has the release; the row does not know yet.
      expect(await bal(futuresOrderMarginAccount(ALICE, USDT, alice.orderId))).toBe(0n);
      expect(parseAmount((await orderRow(alice.orderId)).released_amount)).toBe(0n);

      const view = await svc.cancel(principal(ALICE), alice.orderId);
      expect(view.status).toBe('cancelled');
      expect(view.releasedAmount).toBe(view.holdAmount);
      const keys = releases().map((r) => r.idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
      expect(await bal(userAvailable(ALICE, USDT))).toBe(A('1000'));
      // And nothing more on a third ask.
      await svc.cancel(principal(ALICE), alice.orderId);
      expect(releases()).toHaveLength(2);
      await assertBooksAgree();
    });
  });

  describe('the orders a new send must stay clear of', () => {
    it.each(['submitting', 'open', 'submit_unknown'])(
      'an order that is %s may rest in the book, so a crossing order cannot be sent past it',
      async (status) => {
        engine.matching = false;
        const svc = build();
        const alice = await place(svc, ALICE, 'buy', '1', 'cs-a');
        await sql`UPDATE trade.futures_spread_orders SET status = ${status} WHERE id = ${alice.orderId}`;
        marks[FAR] = A('125');
        marks[NEAR] = A('120');
        await expect(place(svc, BOB, 'sell', '1', 'cs-b')).rejects.toMatchObject({ code: 'trade.spread_anchor_uncovered' });
        expect(engine.submits).toHaveLength(1);
        expect(await bal(userAvailable(BOB, USDT))).toBe(A('1000'));
      },
    );

    it.each(['pending', 'held', 'filled', 'cancelled', 'rejected', 'refused'])(
      'an order that is %s is not in the book, so it does not constrain a crossing order',
      async (status) => {
        engine.matching = false;
        const svc = build();
        const alice = await place(svc, ALICE, 'buy', '1', 'cs2-a');
        await sql`UPDATE trade.futures_spread_orders SET status = ${status} WHERE id = ${alice.orderId}`;
        marks[FAR] = A('125');
        marks[NEAR] = A('120');
        await place(svc, BOB, 'sell', '1', 'cs2-b');
        expect(engine.submits).toHaveLength(2);
      },
    );

    it('a send waits for the one before it: the window check and the send are one step per spread', async () => {
      engine.matching = false;
      engine.delayMs = 30;
      const svc = build();
      // Alice and Bob cross; the second to take the lock must see the first, which is `submitting` until it is answered.
      const results = await Promise.allSettled([place(svc, ALICE, 'buy', '1', 'lk2-a'), place(svc, BOB, 'sell', '1', 'lk2-b')]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(engine.maxInFlight).toBe(1);
      const anchors = await sql<{ anchor_ref: string }[]>`SELECT anchor_ref FROM trade.futures_spread_orders ORDER BY created_at`;
      expect(anchors).toHaveLength(2);
    });
  });

  describe('a long spread id', () => {
    it('is refused at placement when its fill keys could exceed the ledger key limit, before anything is held', async () => {
      const long = 'S'.repeat(MAX_SPREAD_ID_LENGTH + 1);
      engine.listings = [{ ...LISTING, spreadId: long }];
      await expect(
        build().place(principal(ALICE), order({ userId: ALICE, spreadId: long, side: 'buy', qty: A('1'), clientOrderId: 'long' })),
      ).rejects.toMatchObject({ code: 'trade.spread_id_too_long', status: 400 });
      expect(engine.submits).toHaveLength(0);
      expect(posts.filter((p) => p.reason === 'futures.order.margin.hold')).toHaveLength(0);
    });

    it('the longest id that is taken still gives a fill key the ledger accepts', async () => {
      const longest = 'S'.repeat(MAX_SPREAD_ID_LENGTH);
      const key = `futures.fill:${spreadLegFillKey(longest, Number.MAX_SAFE_INTEGER, 1, randomUUID())}`;
      expect(key.length).toBeLessThanOrEqual(LEDGER_IDEMPOTENCY_KEY_MAX);
      engine.listings = [{ ...LISTING, spreadId: longest }];
      const view = await build().place(
        principal(ALICE),
        order({ userId: ALICE, spreadId: longest, side: 'buy', qty: A('1'), clientOrderId: 'longest' }),
      );
      expect(view.status).toBe('open');
    });
  });

  // ── invariants ──────────────────────────────────────────────────────────────

  describe('invariants', () => {
    /** A small deterministic generator, so a failing run is the same run next time. */
    function lcg(seed: number) {
      let s = seed >>> 0;
      return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 2 ** 32;
      };
    }

    it.each([20261020, 7, 424242, 99991])(
      'across many random orders with drifting marks (seed %i), no fill prints outside its hold and every book agrees after every step',
      async (seed) => {
        const svc = build();
        const rnd = lcg(seed);
        const users = USERS;
        for (const u of users) {
          await ledger.post(
            recipes.deposit({ userId: u, assetId: USDT, amount: A('100000'), rail: 'test', railRef: `top-${u}-${randomUUID()}` }),
          );
        }
        funded = A('101000');
        const live: Array<{ user: string; id: string }> = [];
        let fills = 0;
        const allowed = new Set([
          'trade.spread_anchor_uncovered',
          'trade.spread_price_outside_band',
          'trade.futures_one_way_flip_refused',
          'trade.futures_margin_insufficient',
        ]);
        for (let step = 0; step < 80; step += 1) {
          // The marks drift between steps; a resting order keeps the band of the mark it was placed at.
          marks[FAR] = A('105') + BigInt(Math.round((rnd() - 0.5) * 8)) * A('0.5');
          marks[NEAR] = A('100') + BigInt(Math.round((rnd() - 0.5) * 8)) * A('0.5');
          const action = rnd();
          if (action < 0.8 || live.length === 0) {
            const user = users[Math.floor(rnd() * users.length)]!;
            const side: OrderSide = rnd() < 0.5 ? 'buy' : 'sell';
            const qty = String(1 + Math.floor(rnd() * 3));
            const spread = marks[FAR]! - marks[NEAR]!;
            const limit = spread + BigInt(Math.round((rnd() - 0.5) * 6)) * A('0.01') * 10n;
            const clientOrderId = `rnd-${step}`;
            try {
              const view = await svc.place(principal(user), order({ userId: user, side, qty: A(qty), limitPrice: limit, clientOrderId }));
              live.push({ user, id: view.orderId });
            } catch (err) {
              const code = (err as { code?: string }).code;
              expect(allowed.has(code ?? ''), `unexpected refusal ${code}: ${(err as Error).message}`).toBe(true);
            }
          } else {
            const pick = live.splice(Math.floor(rnd() * live.length), 1)[0]!;
            await svc.cancel(principal(pick.user), pick.id);
          }
          fills = engine.fills.length;
          await assertBooksAgree();
        }
        for (const { user, id } of live) await svc.cancel(principal(user), id);
        await assertBooksAgree();
        expect(fills).toBeGreaterThan(0);
        // Nothing is left held, and every order that was ever sent reached an end.
        const open = await sql<{ id: string; user_id: string }[]>`
        SELECT id, user_id FROM trade.futures_spread_orders WHERE status NOT IN ('filled', 'cancelled', 'rejected', 'refused')
      `;
        expect(open).toEqual([]);
        for (const row of await sql<{ id: string; user_id: string }[]>`SELECT id, user_id FROM trade.futures_spread_orders`) {
          expect(await bal(futuresOrderMarginAccount(row.user_id, USDT, row.id))).toBe(0n);
        }
        expect(await sql`SELECT 1 FROM trade.futures_spread_fills WHERE state = 'pending'`).toHaveLength(0);
      },
      120_000,
    );
  });
});
