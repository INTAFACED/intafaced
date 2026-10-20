import { describe, expect, it } from 'vitest';
import { MemoryEventBus, supportTicketResolved } from '@intafaced/events';
import { MemoryNotifyStore } from './store.js';
import { NotifyService } from './notify-service.js';
import { MemoryDeliveryStore, MemoryTargetStore } from './channel-store.js';
import { NotificationDispatcher } from './dispatch.js';
import { ChannelRegistry } from './channels/registry.js';
import { InAppChannel, UnconfiguredChannel } from './channels/gateway.js';
import type { NotificationChannel, OutboundMessage } from './channels/channel.js';
import { subscribeNotificationEvents } from './events.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TICKET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESOLVED = { ticketId: TICKET, userId: OWNER, resolvedAt: '2026-10-20T10:00:00.000Z' };

async function wired() {
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  const bus = new MemoryEventBus('svc-support');
  await subscribeNotificationEvents(bus, notify);
  return { notify, bus };
}

describe('support rating request (SP-csat-01)', () => {
  it('asks the owner of a resolved request, and only the owner, once', async () => {
    const { notify, bus } = await wired();
    await bus.publish('supportTicketResolved', RESOLVED);
    await bus.publish('supportTicketResolved', RESOLVED);

    const mine = await notify.list({ userId: OWNER, limit: 10, unreadOnly: false });
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({
      kind: 'support.rate_request',
      titleKey: 'notify.support.rate_request.title',
      bodyKey: 'notify.support.rate_request.body',
      sourceSubject: supportTicketResolved.subject,
      sourceIdempotencyKey: TICKET,
      href: '/support',
      severity: 'info',
    });
    expect((await notify.list({ userId: OTHER, limit: 10, unreadOnly: false })).items).toHaveLength(0);
  });

  it('a different request is a different ask', async () => {
    const { notify, bus } = await wired();
    await bus.publish('supportTicketResolved', RESOLVED);
    await bus.publish('supportTicketResolved', { ...RESOLVED, ticketId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    expect((await notify.list({ userId: OWNER, limit: 10, unreadOnly: false })).items).toHaveLength(2);
  });

  it('writes nothing while fan-out is off', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: false });
    const bus = new MemoryEventBus('svc-support');
    await subscribeNotificationEvents(bus, notify);
    await bus.publish('supportTicketResolved', RESOLVED);
    expect((await notify.list({ userId: OWNER, limit: 10, unreadOnly: false })).items).toHaveLength(0);
  });

  it('emails the owner once when an address is confirmed, and says nothing when the email gateway is not set', async () => {
    const sent: OutboundMessage[] = [];
    const email: NotificationChannel = {
      channel: 'email',
      unavailableReason: null,
      deliver: async (m) => {
        sent.push(m);
        return { reference: 'email-1' };
      },
    } as NotificationChannel;
    const build = async (emailChannel: NotificationChannel) => {
      const targets = new MemoryTargetStore();
      const deliveries = new MemoryDeliveryStore();
      const channels = new ChannelRegistry([
        new InAppChannel(),
        emailChannel,
        new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
        new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
      ]);
      const dispatcher = new NotificationDispatcher(channels, targets, deliveries, { maxAttempts: 3, outOfAppEnabled: true });
      const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true }, { targets, deliveries, channels, dispatcher });
      await targets.upsert({
        userId: OWNER,
        channel: 'email',
        address: 'someone@example.com',
        locale: 'en',
        verifyTokenHash: 'x'.repeat(64),
        verifyExpiresAt: new Date(Date.now() + 60_000),
      });
      await targets.markVerified(OWNER, 'email', 'x'.repeat(64), new Date());
      const bus = new MemoryEventBus('svc-support');
      await subscribeNotificationEvents(bus, notify);
      return { notify, bus };
    };

    const live = await build(email);
    await live.bus.publish('supportTicketResolved', RESOLVED);
    await live.bus.publish('supportTicketResolved', RESOLVED);
    expect(sent).toHaveLength(1);
    expect((await live.notify.list({ userId: OWNER, limit: 10, unreadOnly: false })).items).toHaveLength(1);

    // No gateway: the inbox row is still written, nothing is claimed sent, and the event is acknowledged.
    const dark = await build(new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']));
    await expect(dark.bus.publish('supportTicketResolved', RESOLVED)).resolves.toBeTruthy();
    expect((await dark.notify.list({ userId: OWNER, limit: 10, unreadOnly: false })).items).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});
