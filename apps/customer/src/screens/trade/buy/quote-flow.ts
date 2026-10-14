/**
 * Pieces Buy and Convert share (UI-SPEC 5.8 "Shared logic"): the published limits of a market, a balance from the
 * data layer, and the plain-words reading of a refused or failed answer.
 */
import { useMemo } from 'react';
import {
  classifyRefusal,
  createTradeApi,
  defaultPoller,
  refusalCopy,
  useDataEnv,
  usePortfolio,
  useSource,
  type ApiResult,
  type Loadable,
  type RefusalContext,
} from './deps';
import type { RefusalCopy } from '../../../data/types';

export interface MarketLimits {
  /** Smallest order size in the coin, and smallest order value in the paying asset. Null when none is published. */
  minAmount: string | null;
  minCost: string | null;
}

/**
 * `limits.cost.min` (the smallest order value) is not in the data layer's market rows, so it is read from the same
 * market list the old desk uses, once, and refreshed every five minutes like the data layer's own markets.
 */
export function useMarketLimits(): Loadable<Record<string, MarketLimits>> {
  const env = useDataEnv();
  const source = useMemo(() => {
    const api = createTradeApi(env.api);
    return defaultPoller().source<Record<string, MarketLimits>>(
      'trade-screens:limits',
      async (signal) => {
        const result = await api.markets(signal);
        if (!result.ok) return result;
        const table: Record<string, MarketLimits> = {};
        for (const market of result.data) table[market.symbol] = { minAmount: market.limits.amount.min, minCost: market.limits.cost.min };
        return { ok: true, data: table };
      },
      { intervalMs: 300_000 },
    );
  }, [env]);
  return useSource(source);
}

/** What the customer can spend of an asset: the free balance from the data layer, or null while it is unknown. */
export function useAvailable(asset: string | null): { state: 'loading' | 'error' | 'ready'; value: string | null; retry?: () => void } {
  const portfolio = usePortfolio();
  if (portfolio.status === 'loading') return { state: 'loading', value: null };
  if (portfolio.status === 'error') return { state: 'error', value: null, retry: portfolio.retry };
  if (portfolio.status === 'refused') return { state: 'error', value: null };
  if (portfolio.status === 'empty') return { state: 'ready', value: '0' };
  const held = asset ? portfolio.data.holdings.find((row) => row.asset === asset) : undefined;
  // A coin the account has never held is a true zero here: the balance call answered and did not list it.
  return { state: 'ready', value: held ? held.available : '0' };
}

/**
 * Codes the service sends that the data layer's table does not sort yet. Until it does, they are read here as the kind
 * they mean, so a customer sees "Amount is too small" and not a generic failure. (A request to the data layer's owner.)
 */
const LOCAL_CODES: Readonly<Record<string, string>> = {
  'trade.below_min_notional': 'bank.below_minimum',
};
export const readableCode = (code: string | null | undefined): string => (code ? (LOCAL_CODES[code] ?? code) : '');

/** A refused or failed answer in plain words, with the way forward (Verify, Use Spot) when there is one. Never the raw code. */
export function plainRefusal(failure: Extract<ApiResult<unknown>, { ok: false }>, context: RefusalContext = {}): RefusalCopy {
  if (failure.code) return refusalCopy(readableCode(failure.code), context);
  // Some refusals carry only an HTTP answer: sorted the same way the typed ones are.
  if (failure.reason === 'unauthorized' || failure.status === 401) return refusalCopy('auth.required', context);
  if (failure.status === 429) return refusalCopy('edge.rate_limited', context);
  return refusalCopy('', context);
}

export type FailureKind = ReturnType<typeof classifyRefusal>;

/** A network or server failure, not a typed refusal: nothing was changed on our side that we know of. */
export function isNetworkFailure(failure: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  return failure.reason === 'unreachable' || failure.reason === 'invalid_response' || failure.reason === 'aborted';
}
