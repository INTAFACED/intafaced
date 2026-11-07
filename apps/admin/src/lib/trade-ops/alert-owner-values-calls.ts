import 'server-only';
import { createHash } from 'node:crypto';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import type { Outcome } from './outcome';
import { parseAlertOwnerValuesView, type AlertOwnerKey, type AlertOwnerValuesView, type AlertPlan } from './alert-owner-values-model';

/** svc-notify `notify.opsAlertOwnerValues.get`: every alert owner value, its source, and the change history. Server only. */
export function readAlertOwnerValues(ctx: TradeCtx): Promise<Outcome<AlertOwnerValuesView>> {
  return edgeCall(ctx, trpcSpec('notify', 'notify.opsAlertOwnerValues.get', 'query', {}, parseAlertOwnerValuesView));
}

export interface AlertOwnerValueWrite {
  readonly key: AlertOwnerKey;
  readonly plan: AlertPlan | null;
  readonly value: number | null;
  readonly expectedVersion: string;
  readonly reason: string;
}

/** The business key of one write: the same change sent twice is written once. */
export function alertOwnerClientRequestId(input: AlertOwnerValueWrite): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([input.key, input.plan, input.value, input.expectedVersion, input.reason]))
    .digest('hex');
  return `alert-owner:${input.key}:${input.plan ?? '-'}:v${input.expectedVersion}:${digest.slice(0, 24)}`;
}

/** svc-notify `notify.opsAlertOwnerValues.set` for one value. A null value clears it to not set. */
export function writeAlertOwnerValue(ctx: TradeCtx, input: AlertOwnerValueWrite): Promise<Outcome<AlertOwnerValuesView>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'notify',
      'notify.opsAlertOwnerValues.set',
      'mutation',
      { ...input, clientRequestId: alertOwnerClientRequestId(input) },
      parseAlertOwnerValuesView,
    ),
  );
}
