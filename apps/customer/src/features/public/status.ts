// hand-declared-ok: the markets answer adds `lifecycle`, which the exchange-contract market schema does not carry
import { z } from 'zod';
import { marketSchema } from '@intafaced/exchange-contract/schemas';
import type { ApiClient, ApiResult } from '../../shared/api';
import type { Fetcher } from '../../data/poll';

/** One market's trading mode as the service reports it. `state` is null when the service reported none: never assumed open. */
export interface MarketMode {
  symbol: string;
  state: string | null;
  reasonCode: string | null;
}

const statusListingSchema = marketSchema.pick({ symbol: true, spot: true, paper: true }).extend({
  lifecycle: z.object({ state: z.string(), reasonCode: z.string().nullish() }).passthrough().nullish(),
});

/** The public markets read, kept to the fields /status shows. Spot, real (not paper) markets only. */
export function marketModesFetcher(api: ApiClient): Fetcher<MarketMode[]> {
  return async (signal): Promise<ApiResult<MarketMode[]>> => {
    const result = await api.rest('/markets', z.array(statusListingSchema), { query: { limit: 500 }, signal });
    if (!result.ok) return result;
    return {
      ok: true,
      data: result.data
        .filter((m) => m.spot && !m.paper)
        .map((m) => ({ symbol: m.symbol, state: m.lifecycle?.state ?? null, reasonCode: m.lifecycle?.reasonCode ?? null })),
    };
  };
}

export type ModeKey = 'OPEN' | 'POST_ONLY' | 'CANCEL_ONLY' | 'REDUCE_ONLY' | 'HALTED' | 'DELISTING' | 'PRELAUNCH' | 'REFUSED';

const KNOWN: ReadonlySet<string> = new Set<ModeKey>([
  'OPEN',
  'POST_ONLY',
  'CANCEL_ONLY',
  'REDUCE_ONLY',
  'HALTED',
  'DELISTING',
  'PRELAUNCH',
  'REFUSED',
]);

/** The mode we have words for, or null (no state reported, or a state this page does not describe). */
export function knownMode(state: string | null): ModeKey | null {
  return state !== null && KNOWN.has(state) ? (state as ModeKey) : null;
}
