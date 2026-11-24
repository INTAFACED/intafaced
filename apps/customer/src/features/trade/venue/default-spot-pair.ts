import { useMemo } from 'react';
import { defaultDeskPair } from '../../../app/navigation';
import { useOptionalSession } from '../../session';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { venueApi, type VenueMarket } from '../venue-api';

/**
 * Picks the spot pair for menu links (`Trade › Spot`, phone Pro `Trade` tab, and `TradeSubNav`) when the user-venue
 * door is on: prefers the venue's spot market on the default base asset (e.g. `BTC-USDC`), else its first listed spot
 * market, else `defaultDeskPair` (`BTC-USDT`). Explicit `/trade/spot/<pair>` URLs stay untouched.
 */
export function pickDefaultVenueSpotPair(markets: readonly Pick<VenueMarket, 'kind' | 'symbol' | 'baseAsset'>[]): string {
  const spot = markets.filter((m) => m.kind === 'spot');
  const exact = spot.find((m) => m.symbol === defaultDeskPair);
  if (exact) return exact.symbol;
  const base = defaultDeskPair.split('-')[0];
  return (spot.find((m) => m.baseAsset === base) ?? spot[0])?.symbol ?? defaultDeskPair;
}

/**
 * The spot desk pair for menu links: the venue's default spot market when signed in and venue mode is on, else
 * `defaultDeskPair`. Safe to call outside `SessionProvider` (returns `defaultDeskPair` without fetching).
 */
export function useDefaultSpotPair(): string {
  const ctx = useOptionalSession();
  const api = ctx?.api ?? null;
  const userId = ctx?.userId ?? null;
  const client = useMemo(() => (api ? venueApi(api) : null), [api]);
  const read = useResource<readonly VenueMarket[] | null>(
    async (signal): Promise<ApiResult<readonly VenueMarket[] | null>> => {
      if (!client || !userId) return { ok: true, data: null };
      const status = await client.status(signal);
      if (!status.ok || !status.data.enabled) return { ok: true, data: null };
      const markets = await client.markets(signal);
      return markets.ok ? { ok: true, data: markets.data.value } : markets;
    },
    `default-spot-pair:${userId ?? 'guest'}`,
  );
  if (read.resource.status !== 'ready' || !read.resource.data) return defaultDeskPair;
  return pickDefaultVenueSpotPair(read.resource.data);
}
