/**
 * Futures job assembly (trade.futures residual).
 *
 * Wires loaders + stores + marks/rates + ticks into JobHost.
 * Default OFF — ops must enable. Never invents marks, rates, or market lists.
 *
 * Marks: matching depth mid by default. When a venue fabric MarkSource is
 * injected (A-TRADE-VENUE-1), that public mid is preferred; depth remains the
 * fallback. Either path returns null rather than inventing.
 */
import type { Sql } from 'postgres';
import { formatAmount, type LedgerClient } from '@intafaced/ledger-client';
import type { EventBus } from '@intafaced/events';
import type { MatchingClient } from '../spot/matching-client.js';
import { createJobHost, type JobHost } from './job-host.js';
import { runFundingTick } from './funding-tick.js';
import { runLiquidationTick, type MarkSource } from './liquidation-tick.js';
import { depthNotionalSourceFromDepth, markSourceFromDepth } from './mark-from-depth.js';
import { markSourcePrefer } from './mark-from-venue.js';
import { memoryFundingRateBook, type FundingRateEntry } from './funding-rate-source.js';
import { sqlFundingPositionLoader, sqlLiquidationPositionLoader } from './position-loaders.js';
import {
  sqlFundingMarginApplier,
  sqlFundingPeriodStore,
  sqlLiquidationAttemptStore,
  sqlPositionCloser,
  sqlPositionReducer,
} from './tick-stores.js';
import type { FuturesLadderPolicy } from './maintenance-ladder.js';
import { sqlAcceptedMarkStore } from './accepted-mark.js';
import { durableMarginCallNotifier, sqlMarginCallStore, type MarginCallStore } from './margin-call-transport.js';
import { DEFAULT_FUTURES_MARK_POLICY, acceptableForMarking, type FuturesMarkProvenance } from './mark-policy.js';
export { runDatedFuturesExpiryTick } from './dated-futures.js';

export interface FuturesJobsConfig {
  /** Master kill — false = host created but no intervals started. */
  enabled: boolean;
  /** Liquidation scan interval. Default 15s when enabled. */
  liqIntervalMs: number;
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
   * Absolute max |period rate| (TRADE_FUTURES_FUNDING_MAX_ABS_RATE).
   * Null refuses settle/publish application. Required at boot when
   * fundingMarketIds non-empty — see funding-rate-bound.ts. No product default.
   */
  fundingMaxAbsRate: string | null;
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
   * Optional external rate publisher hook for tests.
   * Production ops publishes into memoryFundingRateBook via a real oracle later.
   */
  seedFundingRate?: (entry: FundingRateEntry) => void;
  now?: () => Date;
  onError?: (name: string, err: unknown) => void;
  /**
   * Maintenance ladder parameters. Omitted → liquidation tick skips
   * (`skipped_d3_unset`) rather than applying placeholder rungs.
   * Owner `DIRECTION` §8 names the table; this process does not.
   */
  ladderPolicy?: FuturesLadderPolicy;
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
  stop(): void;
}

/**
 * Assemble futures jobs. Does not invent markets or rates.
 * When disabled, returns a stopped host (list empty) but still exposes markPrice.
 */
export function startFuturesJobs(deps: FuturesJobsDeps): FuturesJobsHandle {
  const host = createJobHost({ onError: deps.onError });
  const rates = memoryFundingRateBook({ now: () => (deps.now ?? (() => new Date()))().getTime() });

  const publishFundingRate = (entry: FundingRateEntry) => {
    rates.set(entry);
    deps.seedFundingRate?.(entry);
  };

  const getPublishedRate = (marketId: string) => rates.peek(marketId);

  // Mark path always assembled — public REST + liq share one non-inventing port.
  const depthMarks = markSourceFromDepth((marketId) => deps.matching.depth(marketId));
  const marks: MarkSource = deps.venueMarkSource ? markSourcePrefer(deps.venueMarkSource, depthMarks) : depthMarks;

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
      stop: () => host.stopAll(),
    };
  }

  const liqLoader = sqlLiquidationPositionLoader(deps.sql);
  const attempts = sqlLiquidationAttemptStore(deps.sql);
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
    depth: depthNotionalSourceFromDepth((marketId) => deps.matching.depth(marketId)),
    reducer: sqlPositionReducer(deps.sql),
    policy: deps.ladderPolicy,
  };

  host.every('futures.liquidation', deps.config.liqIntervalMs, async () => {
    await runLiquidationTick({
      marks,
      positions: liqLoader,
      closer,
      attempts,
      acceptedMarks,
      ladder,
      ledger: deps.ledger,
      now: deps.now,
      notifyMarginCall,
      // ADL omitted: owner policy unset. Tick defaults policy null →
      // trade.adl_unconfigured. Do not invent last-resort reduce magnitudes.
    });
  });

  const fundingIntervalMs = deps.config.fundingIntervalMs;
  if (fundingIntervalMs != null) {
    for (const marketId of deps.config.fundingMarketIds) {
      if (!marketId.trim()) continue;
      host.every(`futures.funding.${marketId}`, fundingIntervalMs, async () => {
        await runFundingTick(
          {
            rates: rates.source(),
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
