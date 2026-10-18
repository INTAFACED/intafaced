import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { DELIVERIES_PAGE, readDeliveries, readHealth, type NotifyView } from './model';

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
    founderCall(ctx, 'notify', 'notify.operatorDeliveries', 'GET', { limit: DELIVERIES_PAGE }, (raw) =>
      readDeliveries(raw, DELIVERIES_PAGE),
    ),
    founderCall(ctx, 'notify', 'health', 'GET', {}, readHealth),
  ]);
  return { asOf: now.toISOString(), deliveries: partFrom(deliveries, (d) => d, LABELS), health: partFrom(health, (d) => d, LABELS) };
}
