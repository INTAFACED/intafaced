import 'server-only';
import { edgeCall, trpcSpec, type TradeCtx } from '../trade-ops/edge';
import type { Outcome } from '../trade-ops/outcome';
import { parseBuilderFeeRecon, type BuilderFeeRecon } from './builder-fee-recon-parse';

/** admin.builderFees.recon (svc-trade, J-derivatives-17 #1 #2): the venues' builder fees against the ledger's, for one period. */
export function readBuilderFeeRecon(ctx: TradeCtx, from: string, to: string): Promise<Outcome<BuilderFeeRecon>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.builderFees.recon', 'query', { from, to }, parseBuilderFeeRecon));
}
