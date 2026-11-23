import 'server-only';
import { type FounderCallContext, partFrom, type PartLabels, founderRecordRead } from '@/lib/desk';
import { DELIVERIES_PAGE, readDeliveries, readHealth, type NotifyView } from './model';
import { NOTIFY_OPERATOR_DELIVERIES } from '@intafaced/contracts/notify-notify-procedures';
import { NOTIFY_HEALTH } from '@intafaced/contracts/notify-health-procedures';

/**
 * svc-notify's operator read (`notify.operatorDeliveries`, scope `admin:read`) and its public health, read as the
 * signed-in founder. Founder sign-in does not carry `admin:read` today, so the service answers 403 and the desk says
 * so (admin-BACKEND-NEEDS.md). Read-only: this desk can change nothing.
 */

const LABELS: PartLabels = {
  service: 'svc-notify',
  forbiddenMessage:
    'svc-notify did not accept your founder session. Delivery outcomes need the operator read permission (admin:read), and founder sign-in does not carry it.',
};

export async function loadNotify(ctx: FounderCallContext, now: Date = new Date()): Promise<NotifyView> {
  const [deliveries, health] = await Promise.all([
    founderRecordRead(ctx, NOTIFY_OPERATOR_DELIVERIES, { limit: DELIVERIES_PAGE }, (raw) => readDeliveries(raw, DELIVERIES_PAGE)),
    founderRecordRead(ctx, NOTIFY_HEALTH, undefined, readHealth),
  ]);
  return { asOf: now.toISOString(), deliveries: partFrom(deliveries, (d) => d, LABELS), health: partFrom(health, (d) => d, LABELS) };
}
