import 'server-only';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import type { Outcome } from './outcome';
import { parseAlertEngineHealth, type AlertEngineHealth } from './alert-engine-model';

/** svc-notify `notify.opsAlertEngineHealth` through svc-edge, as the signed-in founder. Server only. */
export function readAlertEngineHealth(ctx: TradeCtx): Promise<Outcome<AlertEngineHealth>> {
  return edgeCall(ctx, trpcSpec('notify', 'notify.opsAlertEngineHealth', 'query', {}, parseAlertEngineHealth));
}
