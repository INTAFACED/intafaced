import 'server-only';

/**
 * The trade desk feature's entry: another console feature imports it only from here
 * (`garden/no-cross-feature-import`); a piece it needs that is not listed is exported here first.
 * This entry is for server code: its calls go through svc-edge as the signed-in founder.
 */
export { edgeCall, trpcSpec, type TradeCtx } from './edge';
export type { Outcome } from './outcome';
