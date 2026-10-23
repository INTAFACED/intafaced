/**
 * Futures job assembly (trade.futures residual).
 *
 * Wires loaders + stores + marks/rates + ticks into JobHost.
 * Default OFF — ops must enable. Never invents marks, rates, or market lists.
 * Dated settlement (`futures.dated_settlement`) posts owner-decimal recipes or
 * refuses blank TRADE_FUTURES_SETTLEMENT_FIXING — never last trade / mark.
 *
 * Marks: matching depth mid by default. When a venue fabric MarkSource is
 * injected (A-TRADE-VENUE-1), that public mid is preferred; depth remains the
 * fallback. Either path returns null rather than inventing.
 */
import type { Sql } from 'postgres';
import { formatAmount, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { EventBus } from '@intafaced/events';
import type { MatchingClient } from '../spot/matching-client.js';
import { createJobHost, type JobHost } from './job-host.js';
import { runFundingTick } from './funding-tick.js';
import {
  ABANDONED_PARKED,
  runLiquidationTick,
  type DepthNotionalSource,
  type LiquidationTickResult,
  type MarkSource,
  type MatchedLiquidationPort,
} from './liquidation-tick.js';
import { depthNotionalSourceFromDepth, markSourceFromDepth } from './mark-from-depth.js';
import { markSourcePrefer } from './mark-from-venue.js';
import { memoryFundingRateBook, preferFundingRateSource, type FundingRateEntry } from './funding-rate-source.js';
import {
  indexProviderFromFeed,
  indexHealthFromProvider,
  runFundingComputerJob,
  sqlFundingRatePeriodStore,
  sqlFundingSampleStore,
} from './funding-rate-computer.js';
import { currentFundingParams, currentIndexSources } from './funding-params.js';
import { notConnectedIndexFeed, type IndexFeed } from './index-construction.js';
import { markSourceWithConstruction, type MarkConstruction, type MarkConstructionInputs } from './mark-construction.js';
import type { VenueLatencyHealth } from './venue-latency-health.js';
import {
  sqlDatedSettlementMarketLoader,
  sqlDatedSettlementPositionLoader,
  sqlFundingPositionLoader,
  sqlLiquidationPositionLoader,
} from './position-loaders.js';
import {
  sqlDatedSettlementCloser,
  sqlFundingMarginApplier,
  sqlFundingPeriodStore,
  sqlLiquidationAttemptStore,
  sqlLiquidationRungStore,
  sqlPositionCloser,
  sqlPositionReducer,
} from './tick-stores.js';
import {
  runDatedFuturesSettlementScan,
  type DatedFuturesSettlementJobResult,
  type DatedSettlementMarkets,
  type DatedSettlementPositions,
} from './dated-futures-settlement.js';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';
import { sqlAcceptedMarkStore } from './accepted-mark.js';
import { durableMarginCallNotifier, sqlMarginCallStore, type MarginCallStore } from './margin-call-transport.js';
import { DEFAULT_FUTURES_MARK_POLICY, acceptableForMarking, type FuturesMarkProvenance } from './mark-policy.js';
import { liquidationJobAlerts } from './futures-jobs-health.js';
import { runPayoutTick } from './futures-payouts.js';
export { runDatedFuturesExpiryTick } from './dated-futures.js';

export interface FuturesJobsConfig {
  /** Master kill — false = host created but no intervals started. */
  enabled: boolean;
  /** Liquidation scan interval. Default 15s when enabled. */
  liqIntervalMs: number;
  /** D-margin-07: owner liquidation fee fraction (scaled) or null when unset. Recorded on rungs, never charged. */
  liquidationFeeFraction?: Amount | null;
  /**
   * Funding tick interval per market. Null = do not schedule funding
   * (D2: never invent an 8h period).
   */
  fundingIntervalMs: number | null;
  /**
   * Market ids to run funding for. Empty = funding job not scheduled
   * (never invent a market list).
   */
  fundingMarketIds: readonly string[];
  /**
   * Poll interval of the funding rate computer (D-instruments-01). Null / omitted = the computer is not scheduled
   * and the funding tick reads exactly what it read before. Owner numbers for the formula are in the database
   * (`admin.fundingParams`), not here, and a blank one refuses the period.
   */
  fundingComputerPollMs?: number | null;
  /**
   * Absolute max |period rate| (TRADE_FUTURES_FUNDING_MAX_ABS_RATE).
   * Null refuses settle/publish application. Required at boot when
   * fundingMarketIds non-empty — see funding-rate-bound.ts. No product default.
   */
  fundingMaxAbsRate: string | null;
  /**
   * TRADE_FUTURES_SETTLEMENT_FIXING. Empty refuses the dated settlement job.
   * Opaque stamp — never parsed as a price, never last trade / mark.
   */
  settlementFixing?: string | null;
}

export interface FuturesJobsDeps {
  sql: Sql;
  ledger: Pick<LedgerClient, 'post' | 'balance'>;
  matching: MatchingClient;
  bus: EventBus | null;
  config: FuturesJobsConfig;
  /**
   * Optional venue-fabric (or other external) mark source.
   * When set, preferred over matching depth mid. Null marks stay null.
   */
  venueMarkSource?: MarkSource | null;
  /**
   * Optional mark from our own spot book (`mark-from-spot-index.ts`, TRADE_FUTURES_INDEX_SPOT_MARKETS). Preferred over
   * the futures market's own depth mid, after a venue source. Null keeps today's sources.
   */
  indexMarkSource?: MarkSource | null;
  /**
   * Optional external rate publisher hook for tests.
   * Production ops publishes into memoryFundingRateBook via a real oracle later.
   */
  seedFundingRate?: (entry: FundingRateEntry) => void;
  /**
   * Public venue books for the index. Omitted: NotConnected `feed.market` (no source is configured on main), so the
   * computer samples gaps and refuses periods rather than publishing a number.
   */
  indexFeed?: IndexFeed | null;
  /** Venue health for the index. A red venue pauses the period. Omitted: not consulted. */
  venueHealth?: () => VenueLatencyHealth;
  /**
   * Owner-selected mark construction. Omitted or `selection: null` keeps today's mark source untouched.
   */
  markConstruction?: {
    selection: MarkConstruction | null;
    inputs: (request: { marketId: string; symbol?: string; at: Date }) => Promise<MarkConstructionInputs | null>;
  };
  now?: () => Date;
  onError?: (name: string, err: unknown) => void;
  /**
   * Maintenance ladder parameters. Omitted → liquidation tick skips
   * (`skipped_d3_unset`) rather than applying placeholder rungs.
   * Owner `DIRECTION` §8 names the table; this process does not.
   */
  ladderPolicy?: FuturesLadderPolicy;
  /**
   * Owner decimal settlement price per expired dated market.
   * Empty / omitted → mill refuses. NEVER last trade or mark.
   * Production omits this (refuse-closed until owner publishes a decimal).
   */
  ownerSettlementPriceFor?: (marketId: string) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Test-only passthrough so JobHost tests prove last-trade / mark are ignored.
   * Production omits.
   */
  lastTradePrice?: string | null;
  markPrice?: string | null;
  /** Override SQL loaders (hermetic JobHost tests). */
  datedSettlement?: {
    markets?: DatedSettlementMarkets;
    positions?: DatedSettlementPositions;
    markClosed?: (positionId: string) => Promise<void>;
  };
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  /**
   * Liquidation through the book (futures ADR slice 7). Bound after the position service is built, which is after the
   * jobs (it prices from their marks). The port's own switch decides whether NEW rungs go to the book; a live one is
   * always worked to its end. Unbound: every rung closes at the mark, as before.
   */
  matchedLiquidation?: { readonly current: MatchedLiquidationPort | null };
}

export interface FuturesJobsHandle {
  host: JobHost;
  /** Rate book so ops/oracle can publish without invent. */
  publishFundingRate: (entry: FundingRateEntry) => void;
  /** Peek published rate for a market — null if none/stale (never invent). */
  getPublishedRate: (marketId: string) => FundingRateEntry | null;
  /**
   * Mark for a market from the same source liquidation uses
   * (venue fabric preferred, then matching depth mid). Null when unknown.
   * Available even when jobs are disabled so public REST can serve mark honestly.
   */
  markPrice: (marketId: string, at?: Date) => Promise<string | null>;
  /** Mark suitable for display, retaining the physical source that won preference. */
  publicMark: (marketId: string, symbol: string, at?: Date) => Promise<{ price: string; source: FuturesMarkProvenance } | null>;
  /**
   * The assembled mark port itself.
   *
   * Exposed so the position open/close path prices from the SAME source
   * liquidation does. A second mark path for the money-moving routes is how
   * `entryPrice`/`exitPrice` ended up coming off the request in the first
   * place — there was no port there to read from.
   */
  marks: MarkSource;
  /**
   * Durable margin-call store — same instance the liquidation tick notifies
   * into, so private REST can observe a delivered call end-to-end.
   */
  marginCalls: MarginCallStore;
  /**
   * The ladder numbers and the book they are rated against — the same two things the liquidation
   * tick uses. Handed to `PositionService` so a margin withdrawal is refused when the LADDER would
   * liquidate what is left, not only when equity is gone. `policy` is undefined until the owner
   * publishes the D3 table (then nothing is rated, and the old equity-only gate applies).
   */
  ladderGate: { depth: DepthNotionalSource; policy?: FuturesLadderPolicy };
  /** Operator alerts. Non-empty while the liquidation tick is not scheduled. */
  alerts: ReturnType<typeof liquidationJobAlerts>;
  stop(): void;
}

/**
 * Surface what a liquidation tick would otherwise swallow, at error level, once
 * per position per tick, through the sink a failed job uses.
 *
 * - `errored`: that position threw; the tick scanned the rest (see
 *   `runLiquidationTick`), so without this line the failure would vanish.
 * - `skipped_already` on an open position: a claim exists yet the position is
 *   still open. Rungs that run through the rung store never leave one (a failed
 *   rung is replayed), so this is a closing rung claimed by the code that
 *   predates rung ids and parked after a crash — only an operator can clear it.
 *   It is logged EVERY tick so it cannot be scrolled past.
 *   The same item with reason `trade.liquidation_abandoned_parked` is a position
 *   whose latest rung was abandoned: its loss is booked and the row could not be
 *   reconciled, so nothing more is planned for it until an operator resolves it.
 */
export function reportLiquidationTick(tick: LiquidationTickResult, onError: (name: string, err: unknown) => void): void {
  for (const item of tick.items) {
    // An applied rung whose margin did not reconcile is a success AND an alert: the loss is
    // booked and the row moved, but ledger and row disagree by this amount (see the runbook).
    if (item.alert) {
      onError(
        'futures.liquidation',
        new Error(`${item.alert.code} positionId=${item.positionId} rungId=${item.alert.rungId} amount=${item.alert.amount}`),
      );
    }
    if (item.divergence) {
      // The row's margin and the ledger pot disagree. The rung (if any) was planned against the
      // smaller; the difference is an operator's to reconcile (runbook section 3). Error level, like
      // every other money alert here: there is no paging route behind it yet.
      onError(
        'futures.liquidation',
        new Error(
          `${item.divergence.code} positionId=${item.positionId} row=${item.divergence.row} pot=${item.divergence.pot} (the position row and the ledger collateral pot disagree; planned against the smaller)`,
        ),
      );
    }
    if (item.insuranceGrown) {
      onError(
        'futures.liquidation',
        new Error(
          `${item.insuranceGrown.code} positionId=${item.positionId} rungId=${item.insuranceGrown.rungId} amount=${item.insuranceGrown.amount} (a closing rung's loss was amended: the pot held less than planned, so the insurance fund paid this much more)`,
        ),
      );
    }
    if (item.lossShort) {
      onError(
        'futures.liquidation',
        new Error(
          `${item.lossShort.code} positionId=${item.positionId} rungId=${item.lossShort.rungId} amount=${item.lossShort.amount} (the loss was booked for less than planned: the pot held less)`,
        ),
      );
    }
    if (item.releaseShort) {
      onError(
        'futures.liquidation',
        new Error(
          `${item.releaseShort.code} positionId=${item.positionId} rungId=${item.releaseShort.rungId} amount=${item.releaseShort.amount} (the margin release was amended down to what the pot held)`,
        ),
      );
    }
    if (item.outcome === 'errored') {
      onError('futures.liquidation', new Error(`position ${item.positionId} errored (${item.reason}): ${item.summary ?? ''}`));
    } else if (item.outcome === 'skipped_already' && item.reason === ABANDONED_PARKED) {
      onError(
        'futures.liquidation',
        new Error(
          `liquidation parked: the latest rung was abandoned after its loss was booked (operator must reconcile, then mark the rung resolved) positionId=${item.positionId}`,
        ),
      );
    } else if (item.outcome === 'skipped_already') {
      onError(
        'futures.liquidation',
        new Error(`liquidation rung parked: claim exists but position still open (operator action needed) positionId=${item.positionId}`),
      );
    }
  }
}

/**
 * A dated-settlement position that could not be settled stays open and is retried every
 * tick; without this line the stuck winner would repeat silently.
 */
export function reportDatedSettlement(
  results: readonly DatedFuturesSettlementJobResult[],
  onError: (name: string, err: unknown) => void,
): void {
  for (const result of results) {
    if (result.status !== 'settled') continue;
    for (const item of result.unsettled) {
      onError('futures.dated_settlement', new Error(`${item.code} positionId=${item.positionId}: ${item.message}`));
    }
  }
}

/**
 * Assemble futures jobs. Does not invent markets or rates.
 * When disabled, returns a stopped host (list empty) but still exposes markPrice.
 */
export function startFuturesJobs(deps: FuturesJobsDeps): FuturesJobsHandle {
  const host = createJobHost({
    onError: deps.onError,
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  });
  const rates = memoryFundingRateBook({ now: () => (deps.now ?? (() => new Date()))().getTime() });

  const publishFundingRate = (entry: FundingRateEntry) => {
    rates.set(entry);
    deps.seedFundingRate?.(entry);
  };

  const getPublishedRate = (marketId: string) => rates.peek(marketId);

  // Mark path always assembled — public REST + liq share one non-inventing port.
  // Matching's depth read carries no timestamp. The engine answers from its live book, so the read time is the
  // observation time (as for the trailing mark in index.ts); without it no futures book could ever give a mark.
  const depthMarks = markSourceFromDepth(async (marketId) => ({
    ...(await deps.matching.depth(marketId, 1)),
    observedAt: deps.now ? deps.now() : new Date(),
  }));
  const bookMarks: MarkSource = deps.indexMarkSource ? markSourcePrefer(deps.indexMarkSource, depthMarks) : depthMarks;
  const baseMarks: MarkSource = deps.venueMarkSource ? markSourcePrefer(deps.venueMarkSource, bookMarks) : bookMarks;
  // Blank selection returns `baseMarks` itself: today's behaviour, untouched.
  const marks: MarkSource = deps.markConstruction
    ? markSourceWithConstruction(baseMarks, deps.markConstruction.selection, deps.markConstruction.inputs)
    : baseMarks;

  const ladderGate = {
    depth: depthNotionalSourceFromDepth((marketId) => deps.matching.depth(marketId, 1)),
    policy: deps.ladderPolicy,
  };

  const markPrice = async (marketId: string, at?: Date) => marks.markPrice({ marketId, at: at ?? (deps.now ? deps.now() : new Date()) });
  const publicMark = async (marketId: string, symbol: string, at?: Date) => {
    if (!marks.quote) return null;
    const observedAt = at ?? (deps.now ? deps.now() : new Date());
    const quote = await marks.quote({ marketId, symbol, at: observedAt });
    if (!quote || !quote.provenance || !acceptableForMarking(quote, observedAt, DEFAULT_FUTURES_MARK_POLICY).ok) return null;
    return { price: formatAmount(quote.price), source: quote.provenance };
  };

  /**
   * Margin-call transport is assembled even when jobs are OFF so the REST
   * observe door and a later manual tick share one store. Delivery does not
   * invent grace (D3).
   */
  const marginCalls = sqlMarginCallStore(deps.sql);
  const notifyMarginCall = durableMarginCallNotifier(marginCalls);

  if (!deps.config.enabled) {
    return {
      host,
      publishFundingRate,
      getPublishedRate,
      markPrice,
      publicMark,
      marks,
      marginCalls,
      ladderGate,
      alerts: liquidationJobAlerts(false),
      stop: () => host.stopAll(),
    };
  }

  const liqLoader = sqlLiquidationPositionLoader(deps.sql);
  const attempts = sqlLiquidationAttemptStore(deps.sql);
  const rungs = sqlLiquidationRungStore(deps.sql);
  const closer = sqlPositionCloser(deps.sql, deps.bus);
  const fundLoader = sqlFundingPositionLoader(deps.sql);
  const periods = sqlFundingPeriodStore(deps.sql);
  const margins = sqlFundingMarginApplier(deps.sql);
  /**
   * THE DEVIATION BREAKER'S BASIS, SUPPLIED.
   *
   * This is the wiring that was missing. `previousMarkFor` was an optional dep
   * and this call site never passed it, so `acceptableForLiquidation` received
   * `null` on every position on every tick and the breaker never fired. The
   * store is now a required argument for exactly that reason — see
   * `accepted-mark.ts`.
   */
  const acceptedMarks = sqlAcceptedMarkStore(deps.sql);

  /**
   * THE LADDER, WIRED — AND WIRED TO THE MATCHING BOOK, NOT THE VENUE'S.
   *
   * `marks` prefers an external venue mid when one is configured, and that is
   * right for VALUING a position: the venue's book is deeper and harder to push.
   * It is wrong for SIZING a rung. A rung is a fill on OUR book, so "how much can
   * be closed without moving the price" is a question about `deps.matching` and
   * nothing else. Rating a position against a venue's depth would authorise a
   * tranche this venue cannot absorb — which is the exact failure `DIRECTION` §1
   * warns about when it says "liquidating positions against a book that cannot
   * absorb them".
   */
  const ladder = {
    ...ladderGate,
    reducer: sqlPositionReducer(deps.sql),
  };

  const datedMarkets = deps.datedSettlement?.markets ?? sqlDatedSettlementMarketLoader(deps.sql);
  const datedPositions = deps.datedSettlement?.positions ?? sqlDatedSettlementPositionLoader(deps.sql);
  const datedCloser = deps.datedSettlement?.markClosed ?? sqlDatedSettlementCloser(deps.sql);

  host.every('futures.dated_settlement', deps.config.liqIntervalMs, async () => {
    const results = await runDatedFuturesSettlementScan({
      now: deps.now ? deps.now() : new Date(),
      settlementFixingConfigured: deps.config.settlementFixing ?? '',
      ownerSettlementPriceFor: deps.ownerSettlementPriceFor,
      lastTradePrice: deps.lastTradePrice ?? null,
      markPrice: deps.markPrice ?? null,
      markets: datedMarkets,
      positions: datedPositions,
      ledger: deps.ledger,
      markClosed: datedCloser,
    });
    reportDatedSettlement(results, deps.onError ?? ((name, err) => console.error(`[job-host] ${name}`, err)));
  });

  // Owed winners are paid as soon as the clearing pot holds their profit
  // (docs/adr/2026-10-20-futures-matched-traders.md section 4).
  host.every('futures.payouts', deps.config.liqIntervalMs, async () => {
    const tick = await runPayoutTick({ sql: deps.sql, ledger: deps.ledger });
    const onError = deps.onError ?? ((name, err) => console.error(`[job-host] ${name}`, err));
    for (const item of tick.errored) onError('futures.payouts', new Error(`profitId=${item.profitId}: ${item.message}`));
  });

  host.every('futures.liquidation', deps.config.liqIntervalMs, async () => {
    const tick = await runLiquidationTick({
      marks,
      positions: liqLoader,
      closer,
      attempts,
      // Rungs are a state machine on the position row (liquidation-rungs.ts): a failed
      // rung is replayed from its stored bodies, never re-planned at a new mark.
      rungs,
      acceptedMarks,
      ladder,
      ledger: deps.ledger,
      ...(deps.config.liquidationFeeFraction !== undefined ? { liquidationFeeFraction: deps.config.liquidationFeeFraction } : {}),
      now: deps.now,
      notifyMarginCall,
      // No owner publication of the liquidation age or deviation limit.
      // Compiled 300 / 60 / 2000 are not that publication (MKT-0057).
      publishedLiquidationLimits: null,
      // ADL omitted: owner policy unset. Tick defaults policy null →
      // trade.adl_unconfigured. Do not invent last-resort reduce magnitudes.
      // The matched-order book also pulls a position's resting increasing orders before any rung (both paths).
      ...(deps.matchedLiquidation?.current
        ? { matched: deps.matchedLiquidation.current, increasingOrders: deps.matchedLiquidation.current.increasingOrders }
        : {}),
    });
    reportLiquidationTick(tick, deps.onError ?? ((name, err) => console.error(`[job-host] ${name}`, err)));
  });

  // Funding rate computer (D-instruments-01). Off unless a poll interval is set. Its rates go into their own book,
  // and the funding tick asks that book first and the S2S-fed one second. A computed period is closed and its rate
  // frozen with it, so the book carries no age limit (maxAgeMs 0 is the explicit choice `FundingRatePolicy` asks for);
  // a stale index pauses the period instead, and nothing is published.
  const computerPollMs = deps.config.fundingComputerPollMs ?? null;
  const computedRates = memoryFundingRateBook({ now: () => (deps.now ?? (() => new Date()))().getTime(), policy: { maxAgeMs: 0 } });
  const fundingSource = computerPollMs != null ? preferFundingRateSource(computedRates.source(), rates.source()) : rates.source();
  if (computerPollMs != null) {
    const indexProvider = indexProviderFromFeed({
      feed: deps.indexFeed ?? notConnectedIndexFeed(),
      sources: (marketId) => currentIndexSources(deps.sql, marketId),
      ...(deps.venueHealth ? { venueHealth: deps.venueHealth } : {}),
    });
    const computerDeps = {
      params: (marketId: string) => currentFundingParams(deps.sql, marketId),
      samples: sqlFundingSampleStore(deps.sql),
      periods: sqlFundingRatePeriodStore(deps.sql),
      indexHealth: indexHealthFromProvider(indexProvider),
      index: indexProvider,
      marks,
      publish: (entry: FundingRateEntry) => computedRates.set(entry),
      maxAbsRate: deps.config.fundingMaxAbsRate,
      now: deps.now,
    };
    for (const marketId of deps.config.fundingMarketIds) {
      if (!marketId.trim()) continue;
      host.every(`futures.funding_rate.${marketId}`, computerPollMs, async () => {
        await runFundingComputerJob(computerDeps, marketId);
      });
    }
  }

  const fundingIntervalMs = deps.config.fundingIntervalMs;
  if (fundingIntervalMs != null) {
    for (const marketId of deps.config.fundingMarketIds) {
      if (!marketId.trim()) continue;
      host.every(`futures.funding.${marketId}`, fundingIntervalMs, async () => {
        await runFundingTick(
          {
            rates: fundingSource,
            positions: fundLoader,
            periods,
            ledger: deps.ledger,
            margins,
            maxAbsRate: deps.config.fundingMaxAbsRate,
            now: deps.now,
          },
          marketId,
        );
      });
    }
  }

  return {
    host,
    publishFundingRate,
    getPublishedRate,
    markPrice,
    publicMark,
    marks,
    marginCalls,
    ladderGate,
    alerts: liquidationJobAlerts(true),
    stop: () => host.stopAll(),
  };
}

/** Parse comma-separated market ids. Empty / whitespace → []. */
export function parseFundingMarketIds(raw: string | undefined): string[] {
  if (raw == null || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
