import type { FastifyInstance, FastifyReply } from 'fastify';
import { isScheduleKey, isScheduleOpen, nextScheduleTransition, TRADING_SCHEDULES, type TradingSchedule } from '@intafaced/contracts';
import { TIMEFRAMES, timeframeSchema, RATE_LIMITS, type Timeframe } from '@intafaced/exchange-contract';
import type { MarketStateSnapshot } from '@intafaced/exchange-contract';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { presentAlgoCapabilityNote } from './algo/algo-capability.js';
import { presentFuturesJobsCapabilityNote } from './futures/futures-jobs-capability.js';
import { readTradePlanes } from './futures/plane-capabilities.js';
import { isPremarket } from './futures/premarket.js';
import { visibleOnPublicBoard } from './futures/futures-reads.js';
import { badRequest, badSymbol, notSupported, toCcxtError, type CcxtErrorResponse } from './ccxt-errors.js';
import type { EngineDepth } from './spot/matching-client.js';
import { MatchingNoBookError, MatchingUnavailableError } from './spot/matching-client.js';
import { fxNamedDegrade, isFxProduct } from './spot/fx-product.js';
import { percentageOf, type TickerStats24h } from './spot/ticker-stats.js';
import type { Candle, Market, PublicTapePrint } from './spot/types.js';
import { publicMarketLifecycle } from './public-market-lifecycle.js';
import type { PairHalt, PairRisk, PairRules } from './spot/pair-rules.js';
import { logRefusalSpec } from './refusal-spec-log.js';
import type { ChartOwnerValuesPublicReader } from './admin/chart-owner-values.js';
import { publicRead } from './route-inventory.js';

/**
 * Public CCXT-style REST slice (trade.ccxt-api — market data).
 *
 * Paths match `REST_ROUTES` in `@intafaced/exchange-contract`:
 *   GET /api/v1/markets?limit=
 *   GET /api/v1/orderbook/:symbol?limit=
 *   GET /api/v1/ticker/:symbol
 *   GET /api/v1/tickers?limit=
 *   GET /api/v1/trades/:symbol?limit=&since=
 *   GET /api/v1/ohlcv/:symbol?timeframe=&since=&limit=
 *   GET /api/v1/funding-rate/:symbol
 *   GET /api/v1/charts/owner-values?symbol=   (charts owner values, C-ops-04; plain JSON like ohlcv)
 *
 * No auth — public market data. Amounts are decimal strings on the wire.
 * Private routes live in `private-rest.ts` (edge-signed principal).
 *
 * Every failure leaves here in the CCXT error shape (`ccxt-errors.ts`), because
 * a client branches on the error class to decide whether to retry.
 */

const MAX_DEPTH = 500;
const MAX_TRADES = 500;
const MAX_CANDLES = 1000;
const MAX_MARKETS = 500;

/** Blank / non-integer / out of 1..max refuses. Never invent 50 / 100 / 500. */
export const TRADE_ORDERBOOK_LIMIT_UNSET = 'trade.orderbook_limit_unset' as const;
export const TRADE_TRADES_LIMIT_UNSET = 'trade.trades_limit_unset' as const;
export const TRADE_OHLCV_LIMIT_UNSET = 'trade.ohlcv_limit_unset' as const;
export const TRADE_MARKETS_LIMIT_UNSET = 'trade.markets_limit_unset' as const;
export const TRADE_TICKERS_LIMIT_UNSET = 'trade.tickers_limit_unset' as const;
/** Blank / missing timeframe refuses. Never invent 1m. */
export const TRADE_OHLCV_TIMEFRAME_UNSET = 'trade.ohlcv_timeframe_unset' as const;
export interface PublicRestDeps {
  /** Listed markets page. Limit required at GET /markets — never invent 50. */
  markets(limit: number): Promise<Market[]>;
  marketBySymbol(symbol: string): Promise<Market | null>;
  /** Charts owner values (C-ops-04). Absent: the owner-values read refuses, it never answers with a default. */
  chartOwnerValues?: ChartOwnerValuesPublicReader;
  /** Optional PX-S01 snapshot; absent means this bounded mount has no authority publisher. */
  lifecycleForMarket?(market: Market): MarketStateSnapshot | null | Promise<MarketStateSnapshot | null>;
  /**
   * The matching book's halt for one market and for the whole venue, read from matching's board. Absent, or throwing,
   * answers 503 (trade.book_halt_unavailable): a halt that cannot be read is never read as open. It also passes on when
   * each standing halt began, as matching serves it (absent from an older engine); the route decides what it shows.
   */
  bookHalt?(
    market: Market,
  ): Promise<{ halted: boolean; venueHalted: boolean; haltedSince?: string | null; venueHaltedSince?: string | null }>;
  /**
   * SP-order-entry-03: TEST-ONLY per-market reader (one read per market — the
   * N+1 the batched readers replace). Production must not mount it; kept for
   * existing tests only. Absent means `pairRules: null` on the wire.
   */
  pairRulesForMarket?(market: Market): Promise<PairRules>;
  /**
   * SP-order-entry-03: batched reader, one query for the whole list. Preferred
   * over `pairRulesForMarket` when both are mounted. A market missing from the
   * map gets `pairRules: null`.
   */
  pairRulesForMarkets?(markets: readonly Market[]): Promise<ReadonlyMap<string, PairRules>>;
  /**
   * SP-order-entry-03 review fix: batched rules AND circuit-breaker state from
   * one operator-risk read. Preferred over both readers above when mounted
   * (production mounts this one). A missing market gets `pairRules`/`pairHalt` null.
   */
  pairRiskForMarkets?(markets: readonly Market[]): Promise<ReadonlyMap<string, PairRisk>>;
  /** Warn sink for a failed pair-rules read (the listing degrades, never fails). Defaults to console.warn. */
  onPairRulesReadError?(err: unknown): void;
  depth(marketId: string, limit: number): Promise<EngineDepth>;
  /**
   * Recent public prints for a market (no user/order ids). Empty when nothing
   * has traded — callers return honest 200 + [].
   * Optional sinceMs (unix ms) filters fills.ts >= since in SQL.
   */
  publicTape(marketId: string, limit: number, sinceMs?: number): Promise<PublicTapePrint[]>;
  /**
   * Candles aggregated from the real taker fill tape. Empty when the market has
   * never traded — an honest empty chart, not a fabricated one.
   */
  candles(marketId: string, timeframe: Timeframe, limit: number, sinceMs?: number): Promise<Candle[]>;
  /**
   * Rolling-24 h ticker stats + hourly sparkline for many markets in ONE query
   * (`spot/ticker-stats.ts`). Optional: a mount without it serves the old
   * top-of-book ticker with null rollups — never invented numbers.
   */
  tickerStats?(marketIds: readonly string[], nowMs: number): Promise<Map<string, TickerStats24h>>;
  /** Injectable clock for tests. */
  now?: () => number;
  /**
   * Published funding rate for a futures market. Null → not served (never invent zero).
   * Spot markets never call this.
   */
  fundingRateForMarket?: (
    marketId: string,
    symbol: string,
  ) =>
    | Promise<{
        fundingRate: string;
        fundingTimestamp: number;
        fundingDatetime: string;
        nextFundingTimestamp: number | null;
        markPrice: string | null;
        indexPrice: string | null;
      } | null>
    | {
        fundingRate: string;
        fundingTimestamp: number;
        fundingDatetime: string;
        nextFundingTimestamp: number | null;
        markPrice: string | null;
        indexPrice: string | null;
      }
    | null;
  /**
   * Algo create vs slice-scheduler flags for the capabilities note.
   * Omitted → shipped defaults (create on, jobs off). Callers that have env
   * should pass it so a live enable is not hidden.
   */
  algo?: { readonly createEnabled: boolean; readonly jobsEnabled: boolean };
  /**
   * Futures liq/funding job flag for the capabilities note.
   * Omitted → shipped default (jobs off). Does not start ticks.
   */
  futures?: {
    readonly jobsEnabled: boolean;
    readonly orderableEnabled?: boolean;
    readonly profitSourceConfigured?: boolean;
    readonly fundingMaxAbsRateConfigured?: boolean;
    readonly fundingMarketCount?: number;
    readonly venueMarkConfigured?: boolean;
    readonly fundingIntervalConfigured?: boolean;
    /** Explicit owner/listing cap. Null means futures leverage is refuse-closed. */
    readonly maxLeverage?: string | null;
  };
  /**
   * TRADE_FUTURES_TEST_SEED. Default off. The only switch that lets a `test: true`
   * listing appear on GET /markets. Does not enable TRADE_FUTURES_ENABLED.
   */
  futuresTestSeed?: boolean;
  /** TRADE_FUTURES_MATCHING_ENABLED: the order-type catalogue follows the futures book instead of the at-mark doors. */
  futuresMatchingEnabled?: boolean;
}

/** Send an already-mapped CCXT error. */
function sendCcxt(reply: FastifyReply, res: CcxtErrorResponse): FastifyReply {
  return reply.code(res.status).send(res.body);
}

/**
 * Map a throw to the CCXT shape, or rethrow. An unrecognised error must reach
 * Fastify's handler as a 500 rather than be relabelled into something a client
 * will confidently retry forever.
 */
function sendMapped(reply: FastifyReply, err: unknown): FastifyReply {
  const mapped = toCcxtError(err);
  if (!mapped) throw err;
  return sendCcxt(reply, mapped);
}

/** 10 bps → "0.001". Integer bps only; no float money path. */
export function bpsToRate(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) return '0';
  const whole = Math.floor(bps / 10_000);
  const frac = bps % 10_000;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(4, '0')}`.replace(/0+$/, '');
}

/**
 * Decimal places of a decimal-string amount.
 *
 * NOT used for CCXT `precision` any more — see `presentCcxtMarket`. Kept
 * because it is still the right answer for display rounding, where being one
 * place out costs a pixel rather than a rejected order.
 */
export function decimalPlaces(amount: string): number {
  const dot = amount.indexOf('.');
  if (dot < 0) return 0;
  // Strip trailing zeros so "0.010000" → 2.
  const frac = amount.slice(dot + 1).replace(/0+$/, '');
  return frac.length;
}

/**
 * Wire hours for a market — same table the order path evaluates.
 *
 * Unknown key → continuous-shaped refusal cannot be honest, so we emit a
 * sessions payload that is never open (empty windows forbidden by schema).
 * Callers pass through TRADING_SCHEDULES; unknown keys are handled by
 * `sessionStateForMarket` returning sessionOpen false.
 */
function presentMarketHours(schedule: TradingSchedule):
  | {
      kind: 'continuous';
    }
  | {
      kind: 'sessions';
      timezone: string;
      windows: ReadonlyArray<{ open: { day: number; time: string }; close: { day: number; time: string } }>;
      holidays: readonly string[];
    } {
  if (schedule.kind === 'continuous') return { kind: 'continuous' };
  return {
    kind: 'sessions',
    timezone: schedule.timezone,
    windows: schedule.windows.map((w) => ({
      open: { day: w.open.day, time: w.open.time },
      close: { day: w.close.day, time: w.close.time },
    })),
    // Empty holidays fail OPEN in the schedule table. FX order path names that
    // as unpublished (`trade.fx_holiday_calendar_unpublished`) — never invent days.
    holidays: [...schedule.holidays],
  };
}

/**
 * Session open + next flip at `atMs`, from the same predicates as
 * `assertMarketOpen` (risk.ts). Unknown schedule key → closed, no transition
 * guess (fail closed on the public wire for the open flag).
 *
 * Order path refuses unknown keys with `trade.unknown_schedule` (D26-P1-T9) —
 * distinct from session-shut `trade.market_closed`. Public market data cannot
 * invent hours for a key outside `TRADING_SCHEDULES`, so sessionOpen=false.
 */
export function sessionStateForMarket(
  market: Pick<Market, 'schedule'>,
  atMs: number,
): {
  sessionOpen: boolean;
  nextSessionChange: { open: boolean; timestamp: number; datetime: string } | null;
  hours: ReturnType<typeof presentMarketHours>;
  schedule: Market['schedule'];
} {
  const scheduleKey = market.schedule;
  // Authority guard first (same set as requireTradingSchedule) — never index
  // TRADING_SCHEDULES with a drifted key and treat undefined as a soft open.
  if (!isScheduleKey(scheduleKey)) {
    // Unknown key: order path → trade.unknown_schedule. Public wire says
    // closed and publishes a zero-width window so `hours.kind` never claims
    // continuous (always open) when we cannot evaluate hours.
    return {
      schedule: scheduleKey,
      sessionOpen: false,
      nextSessionChange: null,
      hours: {
        kind: 'sessions',
        timezone: 'UTC',
        windows: [{ open: { day: 0, time: '00:00' }, close: { day: 0, time: '00:00' } }],
        holidays: [],
      },
    };
  }
  const schedule = TRADING_SCHEDULES[scheduleKey];
  if (!schedule) {
    // Defensive — isScheduleKey already proved the key; keep fail-closed.
    return {
      schedule: scheduleKey,
      sessionOpen: false,
      nextSessionChange: null,
      hours: {
        kind: 'sessions',
        timezone: 'UTC',
        windows: [{ open: { day: 0, time: '00:00' }, close: { day: 0, time: '00:00' } }],
        holidays: [],
      },
    };
  }

  const at = new Date(atMs);
  const sessionOpen = isScheduleOpen(schedule, at);
  const next = nextScheduleTransition(schedule, at);
  return {
    schedule: scheduleKey,
    sessionOpen,
    nextSessionChange: next
      ? {
          open: next.open,
          timestamp: next.at.getTime(),
          datetime: next.at.toISOString(),
        }
      : null,
    hours: presentMarketHours(schedule),
  };
}

/**
 * Present a listing in the CCXT market shape.
 *
 * PRECISION IS REPORTED AS TICK SIZE, NOT DECIMAL PLACES.
 *
 * This surface used to publish `precision: { amount: decimalPlaces(lotSize),
 * price: decimalPlaces(tickSize) }`, which is only ever correct when the tick
 * and lot are powers of ten — and seven of our sixteen live listings are not:
 *
 *   EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CHF, USD/CAD   lot 1000
 *   NATGAS/USD                                             lot 10
 *
 * As a decimal-place count each of those collapses to `0`, so a client doing
 * the documented thing — round the amount to `precision.amount` places before
 * submitting — builds `1500` units of EUR/USD. The engine enforces the lot as a
 * *multiple*, so it rejects it, and every order that client ever builds on
 * those markets is rejected for a reason it cannot see from the market data.
 *
 * `precisionMode: 'TICK_SIZE'` with the tick and lot themselves is what our
 * engine actually enforces (`snapToTick`, and the lot check in risk.ts), so it
 * is the only report a client can build a fillable order from.
 */

/**
 * GET /capabilities note — must name every open-door refuse a bot cannot
 * discover from a happy-path 200. Unnamed pot is 403 NotSupported (same class
 * as `trade.futures_disabled`) — not a retryable 503.
 */
export const OPEN_POSITION_GATES_NOTE =
  'caller price 400 · cross margin 400 · leverage required 400 (no silent 1x) · unnamed profit pot 403 NotSupported';

/** Listing status vs kill-switch. Paper options are orderable; live options are not. */
export function orderableForListedMarket(market: Market, futuresOrderable: boolean, nowMs: number = Date.now()): boolean {
  if (market.status !== 'active') return false;
  if (market.kind === 'options') return market.paper === true;
  if (market.kind === 'futures') {
    if (market.futuresContractStyle === 'dated') {
      const expiry = market.futuresExpiryAt;
      if (!(expiry instanceof Date) || Number.isNaN(expiry.getTime())) return false;
      if (nowMs >= expiry.getTime()) return false;
    }
    return futuresOrderable === true;
  }
  // FX is listed as kind=spot but is not the crypto spot book (R-fx).
  // Holiday calendar + rails unpublished → not orderable. Never silent-zero.
  if (isFxProduct(market)) return false;
  return true;
}

/**
 * HOURS / SESSION — published so a bot can tell "venue shut" from "exchange
 * down" or "empty book". `active` stays listing status; `sessionOpen` is the
 * schedule gate the order path already enforces via `assertMarketOpen`.
 *
 * `orderable` is the kill-switch the order path already enforces. A listed
 * active perp with TRADE_FUTURES_ENABLED off is still `active: true` (it is
 * on the board) and `orderable: false` (place/open refuse). Options stay
 * unorderable — engine still `trade.market_kind_unsupported`.
 *
 * @param nowMs response clock — injectable so sessionOpen is testable at a boundary.
 */
export function presentCcxtMarket(
  market: Market,
  nowMs: number = Date.now(),
  flags: {
    readonly futuresOrderable?: boolean;
    readonly futuresMaxLeverage?: string | null;
    readonly lifecycle?: MarketStateSnapshot | null;
    readonly pairRules?: PairRules | null;
    readonly pairHalt?: PairHalt | null;
  } = {},
) {
  const tick = formatAmount(market.tickSize);
  const lot = formatAmount(market.lotSize);
  const isSpot = market.kind === 'spot';
  const dated = market.kind === 'futures' && market.futuresContractStyle === 'dated';
  const listedExpiry =
    dated && market.futuresExpiryAt instanceof Date && !Number.isNaN(market.futuresExpiryAt.getTime()) ? market.futuresExpiryAt : null;
  const type = dated
    ? ('future' as const)
    : market.kind === 'futures'
      ? ('swap' as const)
      : market.kind === 'options'
        ? ('option' as const)
        : ('spot' as const);
  const session = sessionStateForMarket(market, nowMs);
  // Contract terms come only from the stored listing. A row that never recorded them stays null: nothing is
  // inferred from the symbol or the quote asset.
  const isFutures = market.kind === 'futures';
  const family = isFutures ? (market.futuresFamily ?? null) : null;
  const settleAsset = isFutures ? (market.futuresSettleAsset ?? null) : null;

  return {
    id: market.id,
    symbol: market.symbol,
    base: market.baseAsset,
    quote: market.quoteAsset,
    settle: settleAsset,
    baseId: market.baseAsset,
    quoteId: market.quoteAsset,
    type,
    spot: isSpot,
    swap: market.kind === 'futures' && !dated,
    future: dated,
    option: market.kind === 'options',
    contract: !isSpot,
    /**
     * Linear/inverse are the stored listing family. A row that never recorded one stays null — claiming
     * `linear: true` for it would be an invented USDT-margined book. Inverse never lists today.
     */
    linear: family === null ? (null as boolean | null) : family === 'linear',
    inverse: family === null ? (null as boolean | null) : family === 'inverse',
    /** Stored contract family (`linear`|`inverse`); null on spot, options and futures rows that recorded none. */
    family: family as 'linear' | 'inverse' | null,
    /** Asset this futures market settles in, as stored; null where none is recorded. */
    settleAsset: settleAsset as string | null,
    /** TRUE = a futures market still in prelaunch (`pending`): shown to customers as "Pre-market"; orders refuse. */
    premarket: isPremarket(market),
    active: market.status === 'active',
    /**
     * TRUE = the order path will accept a new order/open here (subject to
     * session, paper, risk). FALSE = listed but refused — futures kill-switch
     * or options until an engine exists. Distinct from `active` (listing).
     */
    orderable: orderableForListedMarket(
      market,
      flags.futuresOrderable === true && flags.futuresMaxLeverage != null && flags.futuresMaxLeverage.trim() !== '',
      nowMs,
    ),
    /**
     * TRUE = orders here are SIMULATED. No hold is taken, nothing posts to the
     * ledger, and the position a fill implies does not exist.
     *
     * This is not a CCXT field, and it is emitted anyway because the honest
     * alternatives were worse. `markets(limit)` still includes paper rows in
     * the published page, so a paper market already appears in `fetchMarkets` as an
     * ordinary `active: true` spot market; `placeOrder` then routes it to
     * `placePaperOrderIsolated` and returns a 201 that looks like any other
     * order. A bot books a position it does not have, and nothing in the
     * response tells it otherwise.
     *
     * A client that does not know the field ignores it and is no worse off
     * than today. One that reads it can refuse to trade simulated markets in
     * one line at startup, instead of guessing from every response.
     *
     * Whether paper markets belong in the PUBLIC listing at all is a separate
     * and larger question — it is a product call with a compliance edge, and
     * it is Nitro's. This change does not answer it; it stops the listing
     * being silently untrue while it is open.
     */
    paper: market.paper === true,
    /** Local TEST listing. Production rows are false. Hidden unless the seed flag is on. */
    test: market.test === true,
    displayName: market.displayName ?? market.symbol,
    /** Explicit TEST seed values. Null when this listing did not record them. */
    markFeed: market.test === true ? (market.testFixture?.markFeed ?? null) : null,
    liquidationPolicy: market.test === true ? (market.testFixture?.liquidationPolicy ?? null) : null,
    /** Not stock CCXT — names FX vs crypto so a shared pair label is not fungible. */
    assetClass: market.assetClass,
    ...(isFxProduct(market) ? { product: 'fx' as const, degrade: fxNamedDegrade() } : {}),
    schedule: session.schedule,
    sessionOpen: session.sessionOpen,
    nextSessionChange: session.nextSessionChange,
    hours: session.hours,
    /** PX-S01 authority state; null is explicit when this mount has no publisher. */
    lifecycle: publicMarketLifecycle(flags.lifecycle),
    lifecycleReasonCode: flags.lifecycle?.reasonCode ?? null,
    /** SP-order-entry-03 pair rules in words; null when this mount has no risk reader. */
    pairRules: flags.pairRules ?? null,
    /** Operator circuit-breaker state; null when unread. `refusesAllOrders` true means no order is accepted. */
    pairHalt: flags.pairHalt ?? null,
    taker: bpsToRate(market.takerBps),
    maker: bpsToRate(market.makerBps),
    contractSize: isFutures && market.contractSize != null ? formatAmount(market.contractSize) : (null as string | null),
    expiry: listedExpiry ? listedExpiry.getTime() : (null as number | null),
    expiryDatetime: listedExpiry ? listedExpiry.toISOString() : (null as string | null),
    strike: null as string | null,
    optionType: null as 'call' | 'put' | null,
    precisionMode: 'TICK_SIZE' as const,
    precision: {
      // Round quantity to a multiple of this, not to N decimal places.
      amount: lot,
      // Round price to a multiple of this.
      price: tick,
    },
    limits: {
      amount: {
        min: formatAmount(market.minQty),
        max: market.maxQty === null ? null : formatAmount(market.maxQty),
      },
      // The smallest non-zero price the engine can represent IS one tick — a
      // price below it rounds to zero. Max is unbounded and stays null rather
      // than guessing a ceiling a client would clamp against.
      price: { min: tick, max: null as string | null },
      cost: { min: formatAmount(market.minNotional), max: null as string | null },
      /**
       * Only an explicit owner/listing cap is publishable. Spot/options and an
       * unconfigured futures listing stay null rather than advertising 10×.
       */
      leverage: {
        min: null as string | null,
        max:
          market.kind !== 'futures'
            ? null
            : market.test === true && market.testFixture?.leverageCap
              ? market.testFixture.leverageCap
              : (flags.futuresMaxLeverage ?? null),
      },
    },
  };
}

export function presentOrderBook(symbol: string, depth: EngineDepth, nowMs: number) {
  return {
    symbol,
    bids: depth.bids.map(([p, q]) => [p, q] as [string, string]),
    asks: depth.asks.map(([p, q]) => [p, q] as [string, string]),
    timestamp: nowMs,
    datetime: new Date(nowMs).toISOString(),
    nonce: depth.sequence,
  };
}

/**
 * Best bid/ask from the book + last print, plus rolling-24 h stats when given.
 *
 * CCXT meaning, all from real (non-seeded) taker fills:
 *   open        first trade price at or after now − 24 h (null: no trade in window)
 *   high / low  extremes over the window
 *   baseVolume  Σ amount, quoteVolume Σ cost, vwap = quoteVolume / baseVolume
 *   change      last − open
 *   percentage  change / open × 100   (percent, not a ratio)
 * Without `stats` the rollups stay null — bots still get a usable top-of-book
 * ticker without inventing numbers.
 *
 * Not stock CCXT, additive: `windowStart` (unix ms the stats really start at —
 * `now − 24 h` for a full window, the first trade's time for a younger market,
 * null if it never traded) and, on `/tickers` only, `sparkline`: up to 24 hourly
 * closes, oldest first, silent hours repeat the previous real close, never null.
 */
export function presentTicker(
  symbol: string,
  depth: EngineDepth,
  last: PublicTapePrint | null,
  nowMs: number,
  stats?: TickerStats24h | null,
  opts: { sparkline?: boolean } = {},
) {
  const bestBid = depth.bids[0] ?? null;
  const bestAsk = depth.asks[0] ?? null;
  const lastPrice = last ? formatAmount(last.price) : null;
  const open = stats?.open ?? null;
  const change = last && open !== null ? last.price - open : null;
  const percentage = change !== null && open !== null ? percentageOf(change, open) : null;
  const dec = (v: Amount | null | undefined) => (v === null || v === undefined ? null : formatAmount(v));

  return {
    symbol,
    timestamp: nowMs,
    datetime: new Date(nowMs).toISOString(),
    high: dec(stats?.high),
    low: dec(stats?.low),
    bid: bestBid ? bestBid[0] : null,
    bidVolume: bestBid ? bestBid[1] : null,
    ask: bestAsk ? bestAsk[0] : null,
    askVolume: bestAsk ? bestAsk[1] : null,
    vwap: dec(stats?.vwap),
    open: dec(open),
    close: lastPrice,
    last: lastPrice,
    previousClose: null as string | null,
    change: dec(change),
    percentage: dec(percentage),
    average: null as string | null,
    baseVolume: dec(stats?.baseVolume),
    quoteVolume: dec(stats?.quoteVolume),
    /** Not stock CCXT: where the 24 h stats really begin (ms), null if never traded. */
    windowStart: stats?.windowStart ?? (null as number | null),
    ...(opts.sparkline ? { sparkline: (stats?.sparkline ?? []).map((v) => formatAmount(v)) } : {}),
  };
}

/**
 * Public tape print — no order id, no fee, no user identity.
 * `side` is the taker's side (the aggressor), CCXT public-trade convention.
 */
export function presentPublicTrade(symbol: string, print: PublicTapePrint) {
  const ts = print.ts.getTime();
  return {
    id: print.id,
    order: null as string | null,
    timestamp: ts,
    datetime: new Date(ts).toISOString(),
    symbol,
    type: null as string | null,
    side: print.side,
    takerOrMaker: null as 'taker' | 'maker' | null,
    price: formatAmount(print.price),
    amount: formatAmount(print.qty),
    cost: formatAmount(print.quoteAmount),
    fee: null as { cost: string; currency: string; rate: string | null } | null,
  };
}

/**
 * CCXT OHLCV row: `[timestamp, open, high, low, close, volume]`.
 *
 * `timestamp` is the bucket's OPEN time in ms — CCXT's convention, and the one
 * every charting client assumes. Labelling a candle with its close time shifts
 * every series by one bar, which is invisible until someone backtests against
 * it. Volume is base-asset volume, matching `Ticker.baseVolume`.
 */
export function presentOhlcv(candle: Candle): [number, string, string, string, string, string] {
  return [
    candle.openTimeMs,
    formatAmount(candle.open),
    formatAmount(candle.high),
    formatAmount(candle.low),
    formatAmount(candle.close),
    formatAmount(candle.volume),
  ];
}

/**
 * Owner/query-published window. Missing / blank / non-integer / out of 1..max
 * is unpublished — never invent 50/100/500, never clamp a too-large window.
 */
export function parsePublicRestLimit(raw: unknown, max: number): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > max) return undefined;
  return n;
}

/** The last instant a JavaScript Date holds; one more reaches the database as an invalid date. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * Optional CCXT `since` (unix ms). Absent/empty → no filter.
 * NaN, negative or past the last Date → invalid (caller returns 400). Zero is valid (epoch).
 */
export function parseSince(raw: unknown): { ok: true; sinceMs?: number } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, sinceMs: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_DATE_MS) {
    return { ok: false, message: 'since must be a non-negative unix timestamp in milliseconds' };
  }
  return { ok: true, sinceMs: Math.floor(n) };
}

/**
 * Register the public REST routes on a Fastify instance.
 * Mount alongside `/trpc` — no auth middleware.
 */
export function registerPublicRest(app: FastifyInstance, deps: PublicRestDeps): void {
  const now = deps.now ?? (() => Date.now());

  /**
   * Bot-ready capability inventory (trade.ccxt-api Done bar deepen).
   * Same rows as `ccxt-capability-matrix.ts` — claim ≡ wire, discoverable
   * without reading source or probing 501s. Never invents mids/rates.
   */
  app.get('/api/v1/time', publicRead, async (_req, reply) => {
    return reply.code(200).send({ serverTime: now() });
  });

  app.get('/api/v1/capabilities', publicRead, async (_req, reply) => {
    logRefusalSpec('paperListPolicy');
    logRefusalSpec('trade.leverage_too_high');
    const { CCXT_CAPABILITY_MATRIX, CCXT_REFUSE_ARMS } = await import('./ccxt-capability-matrix.js');
    const planes = readTradePlanes(process.env);
    return reply.code(200).send({
      asOfMs: now(),
      spot: planes.spot,
      futures: planes.futures,
      routes: CCXT_CAPABILITY_MATRIX,
      refuseArms: CCXT_REFUSE_ARMS,
      notes: {
        paperListPolicy: 'Paper markets stay listed with paper:true. Hiding them from this list is a separate product decision.',
        rateLimit: {
          enforcedBy: 'edge',
          publicPerMinute: RATE_LIMITS.publicPerMinute,
          privatePerMinute: RATE_LIMITS.privatePerMinute,
          windowMs: 60_000,
        },
        neverInvent: 'mids, funding rates, candles, leverage live re-set',
        openPositionGates: OPEN_POSITION_GATES_NOTE,
        algo: presentAlgoCapabilityNote(deps.algo ?? {}),
        futures: presentFuturesJobsCapabilityNote(deps.futures ?? {}),
      },
    });
  });

  /**
   * Futures order-type catalogue (D-orders-01): every type, time in force and
   * flag per listed futures market, with its typed refusal. Derived from the
   * capability matrix; no market listed → an empty list, never a sample one.
   * The market window is the caller's `limit`, as on `/api/v1/markets`; blank refuses.
   */
  app.get<{ Querystring: { limit?: string } }>('/api/v1/futures/order-types', publicRead, async (req, reply) => {
    const limit = parsePublicRestLimit(req.query.limit, MAX_MARKETS);
    if (limit === undefined) {
      return sendCcxt(reply, badRequest('order-types limit is unset — refuse to invent a market window', TRADE_MARKETS_LIMIT_UNSET));
    }
    const { buildFuturesOrderTypeCatalogue } = await import('./futures/order-type-catalogue.js');
    const markets = (await deps.markets(limit)).filter(
      (m) => m.kind === 'futures' && visibleOnPublicBoard(m, deps.futuresTestSeed === true),
    );
    return reply.code(200).send({
      asOfMs: now(),
      markets: markets.map((m) =>
        buildFuturesOrderTypeCatalogue(m.symbol, undefined, { throughBook: deps.futuresMatchingEnabled === true }),
      ),
    });
  });

  /**
   * GET /api/v1/charts/owner-values[?symbol=] — the charts module's owner values (C-ops-04, LD-14).
   * Plain JSON, no envelope, like /api/v1/ohlcv. Every count is the owner's number or null (not set). `dataClass`
   * is the symbol's data class when `?symbol=` is given, else null. An unknown symbol is trade.market_not_found.
   * Nothing here falls back to a default: an unwired reader refuses 503, a DB error is not swallowed.
   */
  app.get<{ Querystring: { symbol?: string } }>('/api/v1/charts/owner-values', publicRead, async (req, reply) => {
    const reader = deps.chartOwnerValues;
    if (!reader) {
      return sendCcxt(reply, {
        status: 503,
        body: {
          code: 'ExchangeNotAvailable',
          message: 'charts owner values are not wired on this service',
          intafacedCode: 'trade.charts_owner_values_unconfigured',
        },
      });
    }
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
    try {
      let dataClass: string | null = null;
      if (symbol !== '') {
        // A symbol longer than any listed market's key is not a market: refuse before the lookup, same shape.
        if (symbol.length > 64) return sendCcxt(reply, badSymbol(symbol));
        const market = await deps.marketBySymbol(symbol);
        if (!market) return sendCcxt(reply, badSymbol(symbol));
        dataClass = await reader.dataClassFor(market.symbol);
      }
      const values = await reader.scalars();
      return reply.code(200).send({ ...values, dataClass });
    } catch (err) {
      return sendMapped(reply, err);
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/api/v1/markets', publicRead, async (req, reply) => {
    const limit = parsePublicRestLimit(req.query.limit, MAX_MARKETS);
    if (limit === undefined) {
      return sendCcxt(reply, badRequest('markets limit is unset — refuse to invent 50', TRADE_MARKETS_LIMIT_UNSET));
    }
    const markets = (await deps.markets(limit)).filter((m) => visibleOnPublicBoard(m, deps.futuresTestSeed === true));
    const ts = now();
    const futuresOrderable = deps.futures?.orderableEnabled === true;
    // Pair rules are additive: a failed risk read degrades to null for the
    // affected markets (logged), never fails the listing.
    let rulesFailed = false;
    const failRules = (err: unknown) => {
      rulesFailed = true;
      (deps.onPairRulesReadError ?? ((e) => req.log.warn({ err: e }, 'pair rules read failed; pairRules null')))(err);
    };
    let batchedRisk: ReadonlyMap<string, PairRisk> | null = null;
    let batchedRules: ReadonlyMap<string, PairRules> | null = null;
    try {
      if (deps.pairRiskForMarkets) batchedRisk = await deps.pairRiskForMarkets(markets);
      else if (deps.pairRulesForMarkets) batchedRules = await deps.pairRulesForMarkets(markets);
    } catch (err) {
      failRules(err);
    }
    const rulesFor = async (m: Market): Promise<PairRules | null> => {
      if (rulesFailed) return null;
      if (batchedRisk) return batchedRisk.get(m.id)?.rules ?? null;
      if (batchedRules) return batchedRules.get(m.id) ?? null;
      if (!deps.pairRulesForMarket) return null;
      try {
        return await deps.pairRulesForMarket(m);
      } catch (err) {
        failRules(err);
        return null;
      }
    };
    const presented = await Promise.all(
      markets.map(async (m) =>
        presentCcxtMarket(m, ts, {
          futuresOrderable,
          futuresMaxLeverage: deps.futures?.maxLeverage ?? null,
          lifecycle: deps.lifecycleForMarket ? await deps.lifecycleForMarket(m) : null,
          pairRules: await rulesFor(m),
          pairHalt: !rulesFailed && batchedRisk ? (batchedRisk.get(m.id)?.halt ?? null) : null,
        }),
      ),
    );
    return reply.code(200).send(presented);
  });

  /** PX-S01 projection. Missing authority is a typed 503, never an OPEN default. */
  app.get<{ Params: { symbol: string } }>('/api/v1/market-halt/:symbol', publicRead, async (req, reply) => {
    const symbol = decodeURIComponent(req.params.symbol);
    const market = await deps.marketBySymbol(symbol);
    if (!market) return sendCcxt(reply, badSymbol(symbol));
    const unavailable = { error: 'matching halt state is not readable', code: 'trade.book_halt_unavailable' };
    if (!deps.bookHalt) return reply.code(503).send(unavailable);
    try {
      const halt = await deps.bookHalt(market);
      // When each halt in force began, as matching journaled it. Null when that halt is not in force, or when matching
      // did not say (an older engine, or a start it could not read): a reader shows "time unknown", never a guess.
      const haltedSince = halt.halted ? isoOrNull(halt.haltedSince) : null;
      const venueHaltedSince = halt.venueHalted ? isoOrNull(halt.venueHaltedSince) : null;
      return reply
        .code(200)
        .send({ symbol, halted: halt.halted, venueHalted: halt.venueHalted, haltedSince, venueHaltedSince, serverTime: now() });
    } catch {
      return reply.code(503).send(unavailable);
    }
  });

  app.get<{ Params: { symbol: string } }>('/api/v1/market-lifecycle/:symbol', publicRead, async (req, reply) => {
    const symbol = decodeURIComponent(req.params.symbol);
    const market = await deps.marketBySymbol(symbol);
    if (!market) return sendCcxt(reply, badSymbol(symbol));
    if (!deps.lifecycleForMarket) {
      return reply.code(503).send({
        error: 'market lifecycle authority is not configured',
        code: 'trade.lifecycle_authority_unavailable',
        state: 'REFUSED',
        recovery: { required: true, evidenceRefs: [] },
      });
    }
    const snapshot = await deps.lifecycleForMarket(market);
    if (!snapshot) {
      return reply.code(503).send({
        error: 'market lifecycle authority returned no evidence',
        code: 'trade.lifecycle_authority_unavailable',
        state: 'REFUSED',
        recovery: { required: true, evidenceRefs: [] },
      });
    }
    return reply.code(200).send(snapshot);
  });

  app.get<{ Params: { symbol: string }; Querystring: { limit?: string } }>('/api/v1/orderbook/:symbol', publicRead, async (req, reply) => {
    // Fastify already percent-decodes params (BTC%2FUSDT → BTC/USDT).
    const symbol = decodeURIComponent(req.params.symbol);
    const market = await deps.marketBySymbol(symbol);
    if (!market) return sendCcxt(reply, badSymbol(symbol));

    const limit = parsePublicRestLimit(req.query.limit, MAX_DEPTH);
    if (limit === undefined) {
      return sendCcxt(reply, badRequest('orderbook limit is unset — refuse to invent 50', TRADE_ORDERBOOK_LIMIT_UNSET));
    }
    try {
      const depth = await deps.depth(market.id, limit);
      return reply.code(200).send(presentOrderBook(market.symbol, depth, now()));
    } catch (err) {
      // MatchingNoBookError → 404 trade.no_book. MatchingUnavailable → 502.
      // Matching 200 empty stays 200 empty.
      return sendMapped(reply, err);
    }
  });

  app.get<{ Params: { symbol: string } }>('/api/v1/ticker/:symbol', publicRead, async (req, reply) => {
    const symbol = decodeURIComponent(req.params.symbol);
    const market = await deps.marketBySymbol(symbol);
    if (!market) return sendCcxt(reply, badSymbol(symbol));

    try {
      // Top of book only — ticker is BBO + last, not full depth.
      const ts = now();
      const [depth, tape, stats] = await Promise.all([
        deps.depth(market.id, 1),
        deps.publicTape(market.id, 1),
        // Stats are best effort: a failed stats query serves null rollups, never a 5xx ticker.
        deps.tickerStats ? deps.tickerStats([market.id], ts).catch(() => undefined) : Promise.resolve(undefined),
      ]);
      return reply.code(200).send(presentTicker(market.symbol, depth, tape[0] ?? null, ts, stats?.get(market.id) ?? null));
    } catch (err) {
      // MatchingNoBookError → 404 trade.no_book. MatchingUnavailable → 502.
      return sendMapped(reply, err);
    }
  });

  /**
   * All-market tickers. Record keyed by unified symbol (CCXT `fetchTickers`).
   *
   * Matching 200 empty ladder is included as empty BBO. Matching 404 (no book)
   * and hop-down are omitted — never an empty BBO as if live. 24 h stats and the
   * hourly `sparkline` come from real fills, for ALL listed markets in one query
   * (not one per market); a market with no trades gets null rollups and `[]`.
   * One dead market must not 502 the map. Limit is required.
   */
  app.get<{ Querystring: { limit?: string } }>('/api/v1/tickers', publicRead, async (req, reply) => {
    const limit = parsePublicRestLimit(req.query.limit, MAX_MARKETS);
    if (limit === undefined) {
      return sendCcxt(reply, badRequest('tickers limit is unset — refuse to invent 500', TRADE_TICKERS_LIMIT_UNSET));
    }
    const markets = await deps.markets(limit);
    const ts = now();
    const out: Record<string, ReturnType<typeof presentTicker>> = {};
    // Stats are best effort: a failed stats query serves null rollups, never a 5xx map.
    const stats = deps.tickerStats
      ? await deps
          .tickerStats(
            markets.map((m) => m.id),
            ts,
          )
          .catch(() => undefined)
      : undefined;

    await Promise.all(
      markets.map(async (market) => {
        let depth: EngineDepth;
        try {
          depth = await deps.depth(market.id, 1);
        } catch (err) {
          if (err instanceof MatchingUnavailableError || err instanceof MatchingNoBookError) return;
          throw err;
        }
        const tape = await deps.publicTape(market.id, 1);
        out[market.symbol] = presentTicker(market.symbol, depth, tape[0] ?? null, ts, stats?.get(market.id) ?? null, { sparkline: true });
      }),
    );

    return reply.code(200).send(out);
  });

  app.get<{ Params: { symbol: string }; Querystring: { limit?: string; since?: string } }>(
    '/api/v1/trades/:symbol',
    publicRead,
    async (req, reply) => {
      const symbol = decodeURIComponent(req.params.symbol);
      const market = await deps.marketBySymbol(symbol);
      if (!market) return sendCcxt(reply, badSymbol(symbol));

      const limit = parsePublicRestLimit(req.query.limit, MAX_TRADES);
      if (limit === undefined) {
        return sendCcxt(reply, badRequest('trades limit is unset — refuse to invent 100', TRADE_TRADES_LIMIT_UNSET));
      }
      const sinceParsed = parseSince(req.query.since);
      if (!sinceParsed.ok) return sendCcxt(reply, badRequest(sinceParsed.message, 'trade.invalid_since'));
      // since → SQL on fills.ts (timestamptz) via publicTape.sinceMs.
      const tape = await deps.publicTape(market.id, limit, sinceParsed.sinceMs);
      return reply.code(200).send(tape.map((print) => presentPublicTrade(market.symbol, print)));
    },
  );

  /**
   * GET /api/v1/ohlcv/:symbol — REST_ROUTES.fetchOHLCV.
   *
   * Candles are AGGREGATED FROM THE REAL TAKER FILL TAPE, in SQL, over
   * `trade.fills` — the same rows `/api/v1/trades/:symbol` publishes. Every
   * open/high/low/close is a price something actually traded at, and volume is
   * the summed quantity of those fills. Nothing here is modelled, interpolated,
   * or carried forward from a previous bucket.
   *
   * This route previously returned `[]` unconditionally. That is a worse
   * failure than it looks: a charting client cannot tell "this market has never
   * traded" from "this venue does not implement candles", so it renders an
   * empty chart for a market with a live tape and the integrator concludes the
   * data is broken.
   *
   * A bucket with no fills is ABSENT, not zero-filled. CCXT consumers treat a
   * gap as a gap; a zero-volume candle at price 0 would be a fabricated print,
   * and a client computing an indicator over it gets a number we invented.
   *
   * Query: timeframe (required — never invent 1m), since (ms), limit (required, max 1000).
   * Missing / blank / non-integer limit refuses — never invent 500.
   */
  app.get<{
    Params: { symbol: string };
    Querystring: { timeframe?: string; since?: string; limit?: string };
  }>('/api/v1/ohlcv/:symbol', publicRead, async (req, reply) => {
    const symbol = decodeURIComponent(req.params.symbol);
    const market = await deps.marketBySymbol(symbol);
    if (!market) return sendCcxt(reply, badSymbol(symbol));

    const rawTf = typeof req.query.timeframe === 'string' ? req.query.timeframe.trim() : '';
    if (rawTf === '') {
      return sendCcxt(reply, badRequest('ohlcv timeframe is unset — refuse to invent 1m', TRADE_OHLCV_TIMEFRAME_UNSET));
    }
    const tf = timeframeSchema.safeParse(rawTf);
    if (!tf.success) {
      return sendCcxt(reply, badRequest(`timeframe must be one of: ${TIMEFRAMES.join(', ')}`, 'trade.invalid_timeframe'));
    }

    const sinceParsed = parseSince(req.query.since);
    if (!sinceParsed.ok) return sendCcxt(reply, badRequest(sinceParsed.message, 'trade.invalid_since'));
    const limit = parsePublicRestLimit(req.query.limit, MAX_CANDLES);
    if (limit === undefined) {
      return sendCcxt(reply, badRequest('ohlcv limit is unset — refuse to invent 500', TRADE_OHLCV_LIMIT_UNSET));
    }

    try {
      const candles = await deps.candles(market.id, tf.data, limit, sinceParsed.sinceMs);
      return reply.code(200).send(candles.map(presentOhlcv));
    } catch (err) {
      return sendMapped(reply, err);
    }
  });

  /**
   * GET /api/v1/funding-rate/:symbol — REST_ROUTES.fetchFundingRate.
   *
   * Declared in the contract and, until now, not mounted at all: a CCXT client
   * calling it got Fastify's generic 404, which reads as "wrong URL" and sends
   * an integrator looking for a path typo that does not exist.
   *
   * A funding rate is a perpetual-swap mechanism. This venue lists spot only,
   * so there is no funding rate to report and there never will be for a spot
   * market. The honest answer is `NotSupported` — stop calling — and NOT a
   * fabricated `fundingRate: "0"`, which a client would treat as a real number
   * and carry into a basis calculation.
   *
   * When trade.futures lands, swap markets answer here with a real rate and
   * spot markets keep this refusal.
   */
  app.get<{ Params: { symbol: string } }>('/api/v1/funding-rate/:symbol', publicRead, async (req, reply) => {
    const symbol = decodeURIComponent(req.params.symbol);
    const market = await deps.marketBySymbol(symbol);
    if (!market) return sendCcxt(reply, badSymbol(symbol));

    // Guard on the listing kind, not on "we have no futures yet", so this arm
    // keeps telling the truth once swap markets exist.
    if (market.kind === 'spot') {
      return sendCcxt(reply, notSupported(`${market.symbol} is a spot market and has no funding rate`, 'trade.funding_rate_spot_market'));
    }

    // Futures: only answer when an external rate has been published. Never invent "0".
    if (!deps.fundingRateForMarket) {
      return sendCcxt(reply, notSupported(`funding rates are not served yet for ${market.symbol}`, 'trade.funding_rate_unavailable'));
    }
    const quote = await deps.fundingRateForMarket(market.id, market.symbol);
    if (!quote) {
      return sendCcxt(reply, notSupported(`no published funding rate for ${market.symbol}`, 'trade.funding_rate_unavailable'));
    }
    return reply.code(200).send({
      symbol: market.symbol,
      markPrice: quote.markPrice,
      indexPrice: quote.indexPrice,
      fundingRate: quote.fundingRate,
      fundingTimestamp: quote.fundingTimestamp,
      fundingDatetime: quote.fundingDatetime,
      nextFundingTimestamp: quote.nextFundingTimestamp,
    });
  });
}

/** Test helper — build a minimal Market without a DB. */
export function fakeMarket(partial: {
  id?: string;
  symbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
  kind?: Market['kind'];
  status?: Market['status'];
  tickSize?: Amount;
  lotSize?: Amount;
  minQty?: Amount;
  maxQty?: Amount | null;
  minNotional?: Amount;
  makerBps?: number;
  takerBps?: number;
  paper?: boolean;
  schedule?: Market['schedule'];
  assetClass?: Market['assetClass'];
}): Market {
  return {
    id: partial.id ?? '00000000-0000-4000-8000-000000000001',
    symbol: partial.symbol ?? 'BTC/USDT',
    baseAsset: partial.baseAsset ?? 'BTC',
    quoteAsset: partial.quoteAsset ?? 'USDT',
    kind: partial.kind ?? 'spot',
    tickSize: partial.tickSize ?? parseAmount('0.01'),
    lotSize: partial.lotSize ?? parseAmount('0.0001'),
    minQty: partial.minQty ?? parseAmount('0.0001'),
    maxQty: partial.maxQty === undefined ? null : partial.maxQty,
    minNotional: partial.minNotional ?? parseAmount('1'),
    status: partial.status ?? 'active',
    makerBps: partial.makerBps ?? 10,
    takerBps: partial.takerBps ?? 20,
    listedAt: null,
    assetClass: partial.assetClass ?? 'crypto',
    schedule: partial.schedule ?? 'crypto-24x7',
    paper: partial.paper ?? false,
  };
}

/** Test helper — one public print. */
export function fakePrint(partial: {
  id?: string;
  side?: PublicTapePrint['side'];
  price?: Amount;
  qty?: Amount;
  quoteAmount?: Amount;
  sequence?: number;
  ts?: Date;
}): PublicTapePrint {
  return {
    id: partial.id ?? '00000000-0000-4000-8000-0000000000aa',
    side: partial.side ?? 'buy',
    price: partial.price ?? parseAmount('100.5'),
    qty: partial.qty ?? parseAmount('1.2'),
    quoteAmount: partial.quoteAmount ?? parseAmount('120.6'),
    sequence: partial.sequence ?? 1,
    ts: partial.ts ?? new Date('2023-11-14T22:13:20.000Z'),
  };
}

/** A start time the route may show: an ISO timestamp that parses. Anything else (blank, malformed) is unknown. */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}
