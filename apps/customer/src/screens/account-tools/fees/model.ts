import { z } from 'zod';
import type { ApiClient, ApiResult } from '../../../shared/api';
import { dec, str } from '../../../data/decimal';
import type { MarketRow } from '../../../data/types';

/**
 * Fee schedule (M9). Checked on origin/main:
 *  - `GET /api/v1/account/fees` (trade:read) -> { [market]: { symbol, maker, taker, percentage } } of the rates the owner
 *    has published per market. A market with no published rate is simply absent; nothing is invented.
 *  - `identity rank.get` and `rank.perks` give the person's rank and the fee discount it earns (basis points).
 * There is NO volume-based level ladder and NO 30-day volume figure anywhere on the back end yet (svc-trade README,
 * "SOCKET §13"), so those are shown as "—" with a caption instead of being worked out here.
 */

const rate = z.object({ maker: z.string(), taker: z.string() }).passthrough();
const feesSchema = z.record(z.string(), rate);
export type Fees = z.infer<typeof feesSchema>;

export function readFees(api: ApiClient, signal: AbortSignal): Promise<ApiResult<Fees>> {
  return api.rest('/account/fees', feesSchema, { signal });
}

export const DASH = '—';

/** "0.001" -> "0.10%". Exact decimal arithmetic, at least two decimals, no float. A malformed rate is "—", never 0. */
export function ratePercent(value: string | null | undefined): string {
  const scaled = dec(value ?? null);
  if (scaled === null || scaled < 0n) return DASH;
  const text = str(scaled * 100n);
  const [whole, fraction = ''] = text.split('.');
  return `${whole}.${fraction.padEnd(2, '0')}%`;
}

/** Basis points of a fee discount as a percent: 50 -> "0.50%". */
export function discountPercent(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) return DASH;
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;
}

export interface RateRow {
  symbol: string;
  market: string;
  maker: string;
  taker: string;
  /** True when the owner has not published a rate for this market. */
  unset: boolean;
}

/** One row per market, in the order given; published rates where there are some, dashes where there are none. */
export function rateRows(markets: readonly MarketRow[], fees: Fees): RateRow[] {
  return markets.map((market) => {
    const found = fees[market.symbol] ?? fees[`${market.base}/${market.quote}`] ?? fees[`${market.base}-${market.quote}`];
    const maker = ratePercent(found?.maker);
    const taker = ratePercent(found?.taker);
    return { symbol: market.symbol, market: `${market.base}/${market.quote}`, maker, taker, unset: maker === DASH && taker === DASH };
  });
}
