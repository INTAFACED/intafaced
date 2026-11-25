/**
 * Historical market data jobs (RC-cex-spot-05; J-cex-spot-15 #10):
 *   1. Book snapshot capture — captures order book depth into `trade.history_book_snapshots` every
 *      `TRADE_HISTORY_BOOK_INTERVAL_MS`. Blank interval = never scheduled, no book dataset built.
 *   2. Dataset materializer — builds gzipped NDJSON datasets (trades, candles, and book_snapshots when configured) for
 *      UTC days with real prints or snapshots, idempotently under `history:<symbol>:<kind>:<day>`.
 */
import { createJobHost, type JobHost } from '../futures/job-host.js';
import type { EngineDepth } from './matching-client.js';
import { MatchingNoBookError, MatchingUnavailableError } from './matching-client.js';
import type { SqlHistoryDatasets } from './history-datasets.js';
import type { Market } from './types.js';

export interface HistoryJobsDeps {
  readonly history: SqlHistoryDatasets;
  readonly markets: () => Promise<readonly Market[]>;
  readonly depth: (marketId: string, limit: number) => Promise<EngineDepth>;
  /** Owner-set book snapshot interval (ms). Null = disabled (refuses book_snapshots). */
  readonly bookIntervalMs: number | null;
  /** How often to materialize datasets (ms). Null = disabled. */
  readonly buildIntervalMs: number | null;
  readonly depthLevels?: number;
  readonly now?: () => Date;
  readonly onError?: (name: string, err: unknown) => void;
}

export interface HistoryJobsHandle {
  readonly host: JobHost;
  stop(): void;
}

async function runHistoryBookCaptureOnce(
  deps: Pick<HistoryJobsDeps, 'history' | 'markets' | 'depth' | 'depthLevels' | 'now'>,
): Promise<number> {
  if (deps.history.bookIntervalMs === null) return 0;
  const levels = deps.depthLevels ?? 20;
  const markets = await deps.markets();
  const capturedAt = deps.now ? deps.now() : new Date();
  let captured = 0;
  for (const market of markets) {
    if (market.kind !== 'spot' || market.paper) continue;
    try {
      const depth = await deps.depth(market.id, levels);
      if (depth.bids.length === 0 && depth.asks.length === 0) continue;
      await deps.history.captureBookSnapshot(market, depth, capturedAt);
      captured += 1;
    } catch (err) {
      if (err instanceof MatchingNoBookError || err instanceof MatchingUnavailableError) continue;
      throw err;
    }
  }
  return captured;
}

async function runHistoryBuildOnce(deps: Pick<HistoryJobsDeps, 'history' | 'markets'>): Promise<number> {
  const markets = await deps.markets();
  let built = 0;
  for (const market of markets) {
    if (market.kind !== 'spot' || market.paper) continue;
    const { tradeDays, bookDays } = await deps.history.activeDaysForMarket(market.id);
    for (const day of tradeDays) {
      if (await deps.history.buildTradesDataset(market, day)) built += 1;
      if (await deps.history.buildCandlesDataset(market, day)) built += 1;
    }
    if (deps.history.bookIntervalMs !== null) {
      for (const day of bookDays) {
        if (await deps.history.buildBookSnapshotsDataset(market, day)) built += 1;
      }
    }
  }
  return built;
}

export function startHistoryJobs(deps: HistoryJobsDeps): HistoryJobsHandle {
  const host = createJobHost({ onError: deps.onError });
  if (deps.bookIntervalMs !== null) {
    host.every('spot.history.book_capture', deps.bookIntervalMs, async () => {
      await runHistoryBookCaptureOnce(deps);
    });
  }
  if (deps.buildIntervalMs !== null) {
    host.every('spot.history.datasets', deps.buildIntervalMs, async () => {
      // Ensure at least one snapshot exists before building book datasets on a fresh stack.
      if (deps.bookIntervalMs !== null) {
        await runHistoryBookCaptureOnce(deps);
      }
      await runHistoryBuildOnce(deps);
    });
  }
  return { host, stop: () => host.stopAll() };
}
