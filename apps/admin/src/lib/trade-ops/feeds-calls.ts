import 'server-only';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import type { Outcome } from './outcome';
import { parseFeedListView, parseFeedMarketView, type FeedListView, type FeedMarketView } from './feeds-model';

/** svc-trade `admin.feedHealth.list` through svc-edge: every spot market's candle stream. Server only. */
export function readFeeds(ctx: TradeCtx): Promise<Outcome<FeedListView>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.feedHealth.list', 'query', {}, parseFeedListView));
}

/** svc-trade `admin.feedHealth.market`: one market's stream, its candle gaps in the window, and its feed event journal. */
export function readFeedMarket(ctx: TradeCtx, symbol: string, gapWindowMinutes: number): Promise<Outcome<FeedMarketView>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.feedHealth.market', 'query', { symbol, gapWindowMinutes }, parseFeedMarketView));
}
