import 'server-only';
import { edgeCall, type TradeCtx } from './edge';
import { parseAdapterStatus, type AdapterStatus } from './adapters-model';
import type { Outcome } from './outcome';

/** svc-edge's door onto svc-fix's and svc-ws's own status (J-cex-spot-20 #3), with the founder's own session token. */
export const readAdapterStatus = (ctx: TradeCtx): Promise<Outcome<AdapterStatus>> =>
  edgeCall(ctx, { method: 'GET', path: '/admin/trade-ops/adapters/status', parse: parseAdapterStatus });
