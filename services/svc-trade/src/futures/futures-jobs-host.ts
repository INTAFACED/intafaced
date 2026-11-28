/**
 * What the live service hands the futures jobs, made from its env and the parts it built. `index.ts` boots at import,
 * so it cannot be called from a test; this can. Its return type has no owner settlement price, last trade, mark or SQL
 * loader override: those slots on `FuturesJobsDeps` are for hermetic tests, and the live host must never fill them
 * (a dated market settles only at an owner decimal, never at last trade or mark).
 */
import type { Env } from '../env.js';
import type { FuturesJobsConfig, FuturesJobsDeps } from './futures-jobs.js';
import { ownerLadderPolicy } from './futures-ladder-owner-gate.js';
import { publishedLiquidationLimitsFrom } from './liquidation-limits.js';

/** The slots only a hermetic test fills. */
type TestOnlySlots = 'ownerSettlementPriceFor' | 'lastTradePrice' | 'markPrice' | 'datedSettlement';

type LiveFuturesJobsDeps = Omit<FuturesJobsDeps, TestOnlySlots>;

type FuturesJobsHostEnv = Pick<
  Env,
  | 'TRADE_FUTURES_MATCHING_ENABLED'
  | 'TRADE_FUTURES_LADDER_POLICY'
  | 'TRADE_FUTURES_JOBS_ENABLED'
  | 'TRADE_FUTURES_LIQ_INTERVAL_MS'
  | 'TRADE_FUTURES_LIQUIDATION_LIMITS'
  | 'TRADE_FUTURES_FUNDING_INTERVAL_MS'
  | 'TRADE_FUTURES_FUNDING_COMPUTER_POLL_MS'
  | 'TRADE_FUTURES_SETTLEMENT_FIXING'
>;

type FuturesJobsHostParts = Pick<
  FuturesJobsDeps,
  'sql' | 'ledger' | 'matching' | 'bus' | 'venueMarkSource' | 'markBookFor' | 'onError' | 'matchedLiquidation'
> &
  Pick<FuturesJobsConfig, 'liquidationFeeFraction' | 'fundingMarketIds' | 'fundingMaxAbsRate'>;

export function futuresJobsHostDeps(env: FuturesJobsHostEnv, parts: FuturesJobsHostParts): LiveFuturesJobsDeps {
  const { liquidationFeeFraction, fundingMarketIds, fundingMaxAbsRate, ...wired } = parts;
  return {
    ...wired,
    // Only futures orders through the book need a book mark; off, a depth read with no time still gives none.
    stampDepthReads: env.TRADE_FUTURES_MATCHING_ENABLED,
    // The owner's maintenance ladder (D3). Blank: no ladder, as before; a value that is not a coherent policy stops boot.
    ladderPolicy: ownerLadderPolicy(env.TRADE_FUTURES_LADDER_POLICY),
    config: {
      enabled: env.TRADE_FUTURES_JOBS_ENABLED,
      liqIntervalMs: env.TRADE_FUTURES_LIQ_INTERVAL_MS,
      liquidationFeeFraction,
      // Blank: unpublished, every liquidation refuses; a malformed value stops boot.
      liquidationLimits: publishedLiquidationLimitsFrom(env.TRADE_FUTURES_LIQUIDATION_LIMITS),
      fundingIntervalMs: env.TRADE_FUTURES_FUNDING_INTERVAL_MS,
      fundingComputerPollMs: env.TRADE_FUTURES_FUNDING_COMPUTER_POLL_MS,
      fundingMarketIds,
      fundingMaxAbsRate,
      settlementFixing: env.TRADE_FUTURES_SETTLEMENT_FIXING,
    },
  };
}
