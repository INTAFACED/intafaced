import { MemoryEventBus } from '@intafaced/events';
import { describe, expect, it } from 'vitest';
import type { NotificationChannel, OutboundMessage } from './channels/channel.js';
import { InAppChannel, UnconfiguredChannel } from './channels/gateway.js';
import { ChannelRegistry } from './channels/registry.js';
import { MemoryDeliveryStore, MemoryTargetStore } from './channel-store.js';
import { NotificationDispatcher, type DispatchOptions } from './dispatch.js';
import { subscribeNotificationEvents } from './events.js';
import { NotifyService } from './notify-service.js';
import { MemoryNotifyStore, type Notification } from './store.js';

/**
 * J-agents-02 #6: the person ticked "Also by email" for an agent's spend alert. The email they asked for gets a delivery
 * row even when it could not go, so Delivery history shows what happened to it: `channel.not_configured` while the
 * platform has no email sender, `channel.no_target` or `channel.target_unverified` when a sender is set but the person
 * has no confirmed address, `channel.disabled` when sending is switched off. A message whose channels nobody asked for
 * keeps the old rule: nothing is written on a channel nobody can use.
 */

const USER = '11111111-1111-4111-8111-1111111111a1';
const AGENT = '33333333-3333-4333-8333-3333333333a3';

class SentEmail implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly unavailableReason = null;
  readonly sent: OutboundMessage[] = [];
  async deliver(req: OutboundMessage) {
    this.sent.push(req);
    return { reference: 'ref-1' };
  }
}

const unconfigured = () => new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']);

function registry(email: NotificationChannel = unconfigured()) {
  return new ChannelRegistry([
    new InAppChannel(),
    email,
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
}

function alert(): Notification {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    userId: USER,
    kind: 'agents.usage_alert.crossed',
    severity: 'action',
    titleKey: 'notify.agents.usage_alert.crossed.title',
    bodyKey: 'notify.agents.usage_alert.crossed.body',
    params: {},
    href: `/agents/${AGENT}`,
    readAt: null,
    sourceSubject: 'intafaced.agents.usage_alert.crossed',
    sourceIdempotencyKey: `agents.usage_alert:${AGENT}:2026-11`,
    createdAt: new Date(),
  } as Notification;
}

async function withEmailAddress(confirmed: boolean): Promise<MemoryTargetStore> {
  const targets = new MemoryTargetStore();
  await targets.upsert({
    userId: USER,
    channel: 'email',
    address: 'person@example.test',
    locale: 'en',
    verifyTokenHash: 'code-hash',
    verifyExpiresAt: new Date(Date.now() + 60_000),
  });
  if (confirmed) expect(await targets.markVerified(USER, 'email', 'code-hash', new Date())).toBe(true);
  return targets;
}

function dispatcher(
  deliveries: MemoryDeliveryStore,
  options: Partial<DispatchOptions> = {},
  reg = registry(),
  targets = new MemoryTargetStore(),
): NotificationDispatcher {
  return new NotificationDispatcher(reg, targets, deliveries, { maxAttempts: 3, outOfAppEnabled: true, ...options });
}

const emailOf = (report: { outcomes: readonly { channel: string }[] }) => report.outcomes.find((o) => o.channel === 'email');

describe('an out-of-app channel the person asked for is always on the record', () => {
  it('no email sender on the platform: the email row is refused channel.not_configured, never attempted, once', async () => {
    const deliveries = new MemoryDeliveryStore();
    const report = await dispatcher(deliveries).dispatch(alert(), { asked: ['email'] });
    expect(emailOf(report)).toEqual({
      channel: 'email',
      status: 'refused',
      code: 'channel.not_configured',
      detail: 'no confirmed address on this channel',
      retryable: false,
    });
    expect(report.retry).toBe(false);
    // Redelivered: the same one row, never a second.
    await dispatcher(deliveries).dispatch(alert(), { asked: ['email'] });
    const rows = await deliveries.listForNotification(alert().id);
    const byChannel = [...rows].sort((a, b) => a.channel.localeCompare(b.channel));
    expect(byChannel.map((row) => [row.channel, row.status, row.refusalCode, row.attemptedAt])).toEqual([
      ['email', 'refused', 'channel.not_configured', null],
      ['inapp', 'accepted', null, expect.any(Date)],
    ]);
  });

  it('a registered address never confirmed is named in the detail, the binding cause still the missing sender', async () => {
    const report = await dispatcher(new MemoryDeliveryStore(), {}, registry(), await withEmailAddress(false)).dispatch(alert(), {
      asked: ['email'],
    });
    expect(emailOf(report)).toMatchObject({
      status: 'refused',
      code: 'channel.not_configured',
      detail: 'address registered but never confirmed',
    });
  });

  it('a sender set and no confirmed address: refused channel.no_target, or channel.target_unverified', async () => {
    const none = await dispatcher(new MemoryDeliveryStore(), {}, registry(new SentEmail())).dispatch(alert(), { asked: ['email'] });
    expect(emailOf(none)).toMatchObject({ status: 'refused', code: 'channel.no_target' });
    const unconfirmed = await dispatcher(new MemoryDeliveryStore(), {}, registry(new SentEmail()), await withEmailAddress(false)).dispatch(
      alert(),
      { asked: ['email'] },
    );
    expect(emailOf(unconfirmed)).toMatchObject({ status: 'refused', code: 'channel.target_unverified' });
  });

  it('a sender set and a confirmed address: the email is sent', async () => {
    const email = new SentEmail();
    const report = await dispatcher(new MemoryDeliveryStore(), {}, registry(email), await withEmailAddress(true)).dispatch(alert(), {
      asked: ['email'],
    });
    expect(emailOf(report)).toMatchObject({ status: 'accepted' });
    expect(email.sent).toHaveLength(1);
  });

  it('sending switched off: refused channel.disabled', async () => {
    const report = await dispatcher(new MemoryDeliveryStore(), { outOfAppEnabled: false }).dispatch(alert(), { asked: ['email'] });
    expect(emailOf(report)).toMatchObject({ status: 'refused', code: 'channel.disabled', detail: 'no confirmed address on this channel' });
  });

  it('nobody asked: nothing is written on a channel nobody can use, and the unasked channels stay off the record', async () => {
    const plain = await dispatcher(new MemoryDeliveryStore()).dispatch(alert());
    expect(plain.outcomes.map((o) => o.channel)).toEqual(['inapp']);
    const asked = await dispatcher(new MemoryDeliveryStore()).dispatch(alert(), { asked: ['email'] });
    expect(asked.outcomes.map((o) => o.channel)).toEqual(['inapp', 'email']);
  });

  it('inbox only (outOfApp false) wins over asked: no out-of-app row at all', async () => {
    const report = await dispatcher(new MemoryDeliveryStore()).dispatch(alert(), { outOfApp: false, asked: ['email'] });
    expect(report.outcomes.map((o) => o.channel)).toEqual(['inapp']);
  });
});

describe('the agent spend alert asks for email only when the person ticked it (J-agents-02 #6)', () => {
  async function wired() {
    const deliveries = new MemoryDeliveryStore();
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true }, {
      dispatcher: dispatcher(deliveries),
    } as never);
    const bus = new MemoryEventBus('svc-agents');
    await subscribeNotificationEvents(bus, notify);
    return { bus, notify, deliveries };
  }
  const crossed = (email: boolean) => ({
    alertKey: `agents.usage_alert:${AGENT}:2026-11`,
    userId: USER,
    agentId: AGENT,
    month: '2026-11',
    alertAt: '0.01',
    spent: '0.0102',
    assetId: 'USDT',
    email,
  });
  const channelsOf = async (notify: NotifyService, deliveries: MemoryDeliveryStore) => {
    const [row] = (await notify.list({ userId: USER, limit: 5, unreadOnly: false })).items;
    return (await deliveries.listForNotification(row!.id))
      .map((d) => [d.channel, d.status, d.refusalCode])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };

  it('email ticked: the inbox row and a refused email row, channel.not_configured', async () => {
    const { bus, notify, deliveries } = await wired();
    await bus.publish('agentUsageAlertCrossed', crossed(true));
    expect(await channelsOf(notify, deliveries)).toEqual([
      ['email', 'refused', 'channel.not_configured'],
      ['inapp', 'accepted', null],
    ]);
  });

  it('email not ticked: the inbox row alone', async () => {
    const { bus, notify, deliveries } = await wired();
    await bus.publish('agentUsageAlertCrossed', crossed(false));
    expect(await channelsOf(notify, deliveries)).toEqual([['inapp', 'accepted', null]]);
  });
});
