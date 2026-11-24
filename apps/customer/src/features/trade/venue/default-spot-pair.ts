import { useMemo } from 'react';
import { defaultDeskPair } from '../../../app/navigation';
import { useSession } from '../../session';
import { useResource } from '../../../shared/resource';
import { useVenueMode } from '../use-venue-mode';
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

/** The spot desk pair for menu links: the venue's default spot market when venue mode is on, else `defaultDeskPair`. */
export function useDefaultSpotPair(): string {
  const mode = useVenueMode();
  const { api } = useSession();
  const client = useMemo(() => venueApi(api), [api]);
  const read = useResource(
    (signal) => (mode.mode === 'on' ? client.markets(signal) : Promise.resolve({ ok: true as const, data: null })),
    `default-spot-pair:${mode.mode === 'on' ? 'on' : 'off'}`,
  );
  if (mode.mode !== 'on' || read.resource.status !== 'ready' || !read.resource.data) return defaultDeskPair;
  return pickDefaultVenueSpotPair(read.resource.data.value);
}
