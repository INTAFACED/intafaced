import { createContext, useContext } from 'react';
import type { VenueChartMarket } from '@intafaced/contracts/trade-venue-door';

/**
 * Which backend feeds the chart workbench: the outside venue (`GET /api/v1/venue/chart-markets` and
 * `/api/v1/venue/chart-candles`) when the user-venue door is on, or our own engine (`/api/v1/markets` and
 * `/api/v1/ohlcv`) when the door is off. Kept in its own leaf file so `candles.ts`, `history.ts` and `charts/` share it
 * without circular imports.
 */
export type ChartSource =
  | { readonly kind: 'engine' }
  | {
      readonly kind: 'venue';
      readonly venueId: string;
      readonly venueName: string;
      readonly test: boolean;
      readonly intervals: readonly string[];
      readonly asOf: number;
      readonly markets: readonly VenueChartMarket[];
    };

export const ENGINE_CHART_SOURCE: ChartSource = { kind: 'engine' };

export const ChartSourceContext = createContext<ChartSource>(ENGINE_CHART_SOURCE);

export function useChartSource(): ChartSource {
  return useContext(ChartSourceContext);
}
