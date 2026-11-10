import 'server-only';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import type { Outcome } from './outcome';
import { parseVenueRouting, type VenueRoutingView } from './venue-routing-model';

/** The operator's routing view (J-derivatives-28 #6) through svc-edge: svc-trade `admin.venueRouting.report`. Read only. */
export const readVenueRouting = (ctx: TradeCtx, period: { from: string; to: string }): Promise<Outcome<VenueRoutingView>> =>
  edgeCall(ctx, trpcSpec('trade', 'admin.venueRouting.report', 'query', period, parseVenueRouting));
