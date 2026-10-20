import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type PartLabels } from '@/lib/desk/part';
import { readChannelSettings, readTemplates, type NotifyConfigView } from './config-model';

/**
 * svc-notify's owner settings reads (`notify.channelSettings`, `notify.templates`, scope `admin:read`) as the
 * signed-in founder. Founder sign-in does not carry `admin:read` today, so the service may answer 403 and the desk
 * says so. Read-only: changing either needs a second person's approval.
 */

const LABELS: PartLabels = {
  service: 'svc-notify',
  forbiddenMessage:
    'svc-notify did not accept your founder session. Channel and template settings need the operator read permission (admin:read), and founder sign-in does not carry it.',
};

export async function loadNotifyConfig(ctx: FounderCallContext, now: Date = new Date()): Promise<NotifyConfigView> {
  const [channels, templates] = await Promise.all([
    founderCall(ctx, 'notify', 'notify.channelSettings', 'GET', {}, readChannelSettings),
    founderCall(ctx, 'notify', 'notify.templates', 'GET', {}, readTemplates),
  ]);
  return { asOf: now.toISOString(), channels: partFrom(channels, (d) => d, LABELS), templates: partFrom(templates, (d) => d, LABELS) };
}
