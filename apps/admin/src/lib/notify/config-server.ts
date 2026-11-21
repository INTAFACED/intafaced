import 'server-only';
import { type FounderCallContext, partFrom, type PartLabels, founderRecordRead } from '@/lib/desk';
import { readChannelSettings, readTemplates, type NotifyConfigView } from './config-model';
import { NOTIFY_CHANNEL_SETTINGS, NOTIFY_TEMPLATES } from '@intafaced/contracts/notify-notify-procedures';

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
    founderRecordRead(ctx, NOTIFY_CHANNEL_SETTINGS, undefined, readChannelSettings),
    founderRecordRead(ctx, NOTIFY_TEMPLATES, undefined, readTemplates),
  ]);
  return { asOf: now.toISOString(), channels: partFrom(channels, (d) => d, LABELS), templates: partFrom(templates, (d) => d, LABELS) };
}
