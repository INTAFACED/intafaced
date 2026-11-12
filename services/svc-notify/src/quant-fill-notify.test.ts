import { describe, expect, it } from 'vitest';
import { MemoryEventBus, quantOrderFilled } from '@intafaced/events';
import { MemoryNotifyStore } from './store.js';
import { NotifyService } from './notify-service.js';
import { MemoryDeliveryStore, MemoryTargetStore } from './channel-store.js';
import { NotificationDispatcher } from './dispatch.js';
import { ChannelRegistry } from './channels/registry.js';
import { InAppChannel, UnconfiguredChannel } from './channels/gateway.js';
import { QUANT_FILL_KIND, subscribeNotificationEvents } from './events.js';

// AL-live-06 / AL-alerts-01 (J-algo-dev-04 #5, #6, #7): a paper strategy fill under a fill alert becomes one inbox notice.
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FILL = {
  eventId: 'quant.fill:alert-1:run-1:0',
  userId: OWNER,
  strategyId: 'strategy-1',
  strategyVersion: 1,
  runId: 'run-1',
  alertId: 'alert-1',
  mode: 'paper' as const,
  symbol: 'BTC/USDT',
  side: 'buy' as const,
  qty: '0.01',
  price: '100.5',
  filledAt: '2026-11-12T10:00:00.000Z',
  message: 'TEST trend bought 0.01 BTC/USDT at 100.5',
  channels: [] as ('email' | 'sms' | 'push')[],
};

async function wired() {
  const targets = new MemoryTargetStore();
  const deliveries = new MemoryDeliveryStore();
  const channels = new ChannelRegistry([
    new InAppChannel(),
    new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']),
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
  const dispatcher = new NotificationDispatcher(channels, targets, deliveries, { maxAttempts: 3, outOfAppEnabled: true });
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true }, { targets, deliveries, channels, dispatcher });
  const bus = new MemoryEventBus('svc-quant');
  await subscribeNotificationEvents(bus, notify);
  return { notify, bus, deliveries };
}

describe('paper strategy fill notices (AL-alerts-01)', () => {
  it('writes one notice for the owner with the rendered message, however often the same fill is delivered', async () => {
    const { notify, bus } = await wired();
    await bus.publish('quantOrderFilled', FILL);
    await bus.publish('quantOrderFilled', FILL, { idempotencyKey: `${FILL.eventId}:again` });

    const mine = await notify.list({ userId: OWNER, limit: 10, unreadOnly: false });
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({
      kind: QUANT_FILL_KIND,
      titleKey: 'notify.quant.fill.title',
      bodyKey: 'notify.quant.fill.body',
      sourceSubject: quantOrderFilled.subject,
      sourceIdempotencyKey: FILL.eventId,
      href: '/quant/strategies/strategy-1',
    });
    expect(mine.items[0]!.params).toMatchObject({ message: FILL.message, mode: 'paper', runId: 'run-1', qty: '0.01', price: '100.5' });
    expect((await notify.list({ userId: OTHER, limit: 10, unreadOnly: false })).items).toHaveLength(0);
  });

  it('a second fill is a second notice', async () => {
    const { notify, bus } = await wired();
    await bus.publish('quantOrderFilled', FILL);
    await bus.publish('quantOrderFilled', { ...FILL, eventId: 'quant.fill:alert-1:run-1:1', side: 'sell' });
    expect((await notify.list({ userId: OWNER, limit: 10, unreadOnly: false })).items).toHaveLength(2);
  });

  it('email chosen with no email sender: the notice is still in the app, and its email row is refused by name', async () => {
    const { notify, bus, deliveries } = await wired();
    await expect(bus.publish('quantOrderFilled', { ...FILL, channels: ['email'] })).resolves.toBeTruthy();
    const mine = await notify.list({ userId: OWNER, limit: 10, unreadOnly: false });
    expect(mine.items).toHaveLength(1);
    const rows = await deliveries.listForNotification(mine.items[0]!.id);
    const email = rows.find((row) => row.channel === 'email');
    expect(email, JSON.stringify(rows)).toBeDefined();
    expect(email!.acceptedAt).toBeNull();
    expect(email!.refusalCode).toBe('channel.not_configured');
  });

  it('no out-of-app channel chosen: inbox only, no delivery row claims a send', async () => {
    const { notify, bus, deliveries } = await wired();
    await bus.publish('quantOrderFilled', FILL);
    const mine = await notify.list({ userId: OWNER, limit: 10, unreadOnly: false });
    const rows = await deliveries.listForNotification(mine.items[0]!.id);
    expect(rows.filter((row) => row.channel !== 'inapp' && row.acceptedAt !== null)).toHaveLength(0);
  });
});
