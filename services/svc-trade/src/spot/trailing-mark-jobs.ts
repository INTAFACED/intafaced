/**
 * Trailing-stop mark pump (spot).
 *
 * Default OFF. Reads a labelled mark for each configured market from the book trade already has a source for, and
 * posts it to svc-matching, which walks that market's trailing stops. A market with no usable mark (stale, one-sided
 * or thin book) is skipped; the pump never posts a stand-in. The mark comes from this service, never from a customer.
 *
 * Matching only tightens a trigger and journals only a mark that moved something, so a repeated tick is cheap.
 */
import { formatAmount } from '@intafaced/ledger-client';
import { createJobHost, type JobHost } from '../futures/job-host.js';
import type { QuotedMarkSource } from '../futures/liquidation-tick.js';
import { MatchingNoBookError, MatchingUnavailableError, type EngineMarkResult } from './matching-client.js';

/** Enabled + markets with a blank / invalid interval refuses at boot. Never invent a tick rate. */
export const TRADE_TRAILING_MARK_JOBS_INTERVAL_UNSET = 'trade.trailing_mark_jobs_interval_unset' as const;

export class TrailingMarkJobsUnsetError extends Error {
  readonly code = TRADE_TRAILING_MARK_JOBS_INTERVAL_UNSET;
  constructor(message: string) {
    super(message);
    this.name = 'TrailingMarkJobsUnsetError';
  }
}

export interface TrailingMarkJobsConfig {
  /** Master kill — false = host created, no intervals. */
  enabled: boolean;
  /** Tick interval. Owner-published: null / non-positive refuses when enabled with markets. */
  intervalMs: number | null;
  /** Explicit markets. Empty = not scheduled even when enabled (never invent a market list). */
  marketIds: readonly string[];
}

export type TrailingMarkOutcome = 'posted' | 'no_mark' | 'refused' | 'unreachable';

export interface TrailingMarkTickResult {
  marketId: string;
  outcome: TrailingMarkOutcome;
  /** True only when matching reports a peak or trigger actually moved. */
  applied: boolean;
}

export interface TrailingMarkJobsDeps {
  config: TrailingMarkJobsConfig;
  source: QuotedMarkSource;
  postMark(marketId: string, mark: string): Promise<EngineMarkResult>;
  now?: () => Date;
  onError?: (name: string, err: unknown) => void;
  onResult?: (result: TrailingMarkTickResult) => void;
}

export interface TrailingMarkJobsHandle {
  host: JobHost;
  /** One pass over every configured market. The scheduled job runs exactly this. */
  tick(): Promise<TrailingMarkTickResult[]>;
  stop(): void;
}

export function publishedTrailingMarkInterval(value: number | null | undefined): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1) {
    throw new TrailingMarkJobsUnsetError('trailing mark interval is unset — refuse to invent a tick rate');
  }
  return value;
}

export function startTrailingMarkJobs(deps: TrailingMarkJobsDeps): TrailingMarkJobsHandle {
  const host = createJobHost({ onError: deps.onError });
  const now = deps.now ?? (() => new Date());
  const marketIds = deps.config.marketIds.filter((id) => id.trim().length > 0);

  async function tick(): Promise<TrailingMarkTickResult[]> {
    const results: TrailingMarkTickResult[] = [];
    for (const marketId of marketIds) {
      const result = await oneMarket(marketId);
      results.push(result);
      deps.onResult?.(result);
    }
    return results;
  }

  async function oneMarket(marketId: string): Promise<TrailingMarkTickResult> {
    let quote;
    try {
      quote = await deps.source.quote({ marketId, at: now() });
    } catch (err) {
      // A market that has no book yet has no stops to walk and no mark; that is quiet, not an error.
      if (err instanceof MatchingNoBookError) return { marketId, outcome: 'no_mark', applied: false };
      deps.onError?.('spot.trailing_mark', err);
      return { marketId, outcome: 'unreachable', applied: false };
    }
    if (!quote) return { marketId, outcome: 'no_mark', applied: false };
    try {
      const result = await deps.postMark(marketId, formatAmount(quote.price));
      if (!result.accepted) return { marketId, outcome: 'refused', applied: false };
      return { marketId, outcome: 'posted', applied: result.applied };
    } catch (err) {
      if (!(err instanceof MatchingUnavailableError)) throw err;
      deps.onError?.('spot.trailing_mark', err);
      return { marketId, outcome: 'unreachable', applied: false };
    }
  }

  if (deps.config.enabled && marketIds.length > 0) {
    const intervalMs = publishedTrailingMarkInterval(deps.config.intervalMs);
    host.every('spot.trailing_mark', intervalMs, async () => {
      await tick();
    });
  }

  return { host, tick, stop: () => host.stopAll() };
}
