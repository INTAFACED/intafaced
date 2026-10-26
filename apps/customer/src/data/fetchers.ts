/**
 * The only place the data layer talks to the service, through the existing
 * client (`shared/api.ts`) and the existing market schema (`features/trade/trade-api.ts`).
 * Rules from DATA-GAPS.md are honoured here: `limit` is always sent, symbols are
 * URL-encoded, nothing is parsed into a float.
 */
import { z } from 'zod';
import { balancesSchema, ohlcvSchema, tickerSchema } from '@intafaced/exchange-contract/schemas';
import type { ApiClient, ApiResult } from '../shared/api';
import { decimalSchema } from '../shared/money';
import { listingSchema } from '../features/trade/listing';
import type { BalanceEntry, OhlcvRow, RawTicker } from './derive';
import type { Fetcher } from './poll';
import type { MarketRow, Timeframe } from './types';

/** What the market list sends today, plus the fields the unlocks (U4) will add. */
const marketListingSchema = listingSchema.extend({
  lifecycle: z.object({ state: z.string() }).passthrough().nullish(),
  listedAt: z.string().nullish(),
});

const rawTickerSchema = tickerSchema.extend({ sparkline: z.array(z.string()).nullish(), windowStart: z.number().nullish() });

const balancesResponseSchema = balancesSchema.extend({
  balances: z.record(z.string(), z.object({ free: decimalSchema, used: decimalSchema, total: decimalSchema })),
});

function mapResult<A, B>(result: ApiResult<A>, map: (value: A) => B): ApiResult<B> {
  return result.ok ? { ok: true, data: map(result.data) } : result;
}

/** Spot, real (not paper) markets. `orderable` is true only when the service says so AND the market is OPEN. */
export function marketsFetcher(api: ApiClient): Fetcher<MarketRow[]> {
  return async (signal) =>
    mapResult(await api.rest('/markets', z.array(marketListingSchema), { query: { limit: 500 }, signal }), (rows) =>
      rows
        .filter((m) => m.spot && !m.paper)
        .map((m): MarketRow => ({
          symbol: m.symbol,
          base: m.base,
          quote: m.quote,
          orderable: m.orderable && (m.lifecycle ? m.lifecycle.state === 'OPEN' : true),
          tickSize: m.precision.price,
          lotSize: m.precision.amount,
          minAmount: m.limits.amount.min,
          listedAt: m.listedAt ?? null,
        })),
    );
}

export function tickersFetcher(api: ApiClient): Fetcher<Record<string, RawTicker>> {
  return (signal) =>
    api.rest('/tickers', z.record(z.string(), rawTickerSchema), { query: { limit: 500 }, signal }) as Promise<
      ApiResult<Record<string, RawTicker>>
    >;
}

export function tickerFetcher(api: ApiClient, symbol: string): Fetcher<RawTicker> {
  return (signal) => api.rest(`/ticker/${encodeURIComponent(symbol)}`, rawTickerSchema, { signal }) as Promise<ApiResult<RawTicker>>;
}

export function ohlcvFetcher(api: ApiClient, symbol: string, timeframe: Timeframe, limit: number): Fetcher<OhlcvRow[]> {
  return (signal) =>
    api.rest(`/ohlcv/${encodeURIComponent(symbol)}`, z.array(ohlcvSchema), { query: { timeframe, limit }, signal }) as Promise<
      ApiResult<OhlcvRow[]>
    >;
}

export function balancesFetcher(api: ApiClient): Fetcher<Record<string, BalanceEntry>> {
  return async (signal) =>
    mapResult(await api.rest('/account/balance', balancesResponseSchema, { signal }), (response) => response.balances);
}
