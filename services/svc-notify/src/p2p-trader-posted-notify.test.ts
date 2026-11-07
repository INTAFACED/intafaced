import { describe, expect, it } from 'vitest';
import { MemoryEventBus, p2pTraderPosted } from '@intafaced/events';
import { MemoryNotifyStore } from './store.js';
import { NotifyService } from './notify-service.js';
import { subscribeNotificationEvents } from './events.js';
import { renderInboxCopy } from './channels/render.js';

const TRADER = '11111111-1111-4111-8111-111111111111';
const FOLLOWER = '22222222-2222-4222-8222-222222222222';
const SECOND = '33333333-3333-4333-8333-333333333333';
const OFFER = '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c';

const posted = (offerId: string, followerId: string) => ({
  offerId,
  traderId: TRADER,
  followerId,
  side: 'sell' as const,
  asset: 'USDT',
  fiatCurrency: 'EUR',
  postedAt: '2026-11-07T07:50:00.000Z',
});

describe('a followed trader posted an ad (P-ads-merchant-22, J-p2p-12 #4)', () => {
  it('tells each follower once per ad, however often the event comes', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-p2p');
    await subscribeNotificationEvents(bus, notify);

    await bus.publish('p2pTraderPosted', posted(OFFER, FOLLOWER));
    await bus.publish('p2pTraderPosted', posted(OFFER, FOLLOWER));
    await bus.publish('p2pTraderPosted', posted(OFFER, SECOND));

    expect(await notify.unreadCount(FOLLOWER)).toBe(1);
    expect(await notify.unreadCount(SECOND)).toBe(1);
    expect(await notify.unreadCount(TRADER)).toBe(0);
    const row = (await notify.list({ userId: FOLLOWER, limit: 10, unreadOnly: false })).items[0]!;
    expect(row).toMatchObject({
      kind: 'p2p.trader.posted',
      titleKey: 'notify.p2p.trader.posted.title',
      bodyKey: 'notify.p2p.trader.posted.body',
      href: `/p2p?makerId=${TRADER}`,
      severity: 'info',
      sourceSubject: p2pTraderPosted.subject,
      sourceIdempotencyKey: `${OFFER}:${FOLLOWER}`,
    });
    expect(row.params).toEqual({ offerId: OFFER, traderId: TRADER, side: 'sell', asset: 'USDT', fiatCurrency: 'EUR' });
    expect(renderInboxCopy(row, 'en')).toEqual({
      title: 'A trader you follow posted an ad',
      body: 'A trader you follow posted a new USDT ad in EUR. Open their ads to see it.',
    });
  });

  it('keeps two ads apart for the same follower', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-p2p');
    await subscribeNotificationEvents(bus, notify);

    await bus.publish('p2pTraderPosted', posted(OFFER, FOLLOWER));
    await bus.publish('p2pTraderPosted', posted('1c7a2d2f-5b8e-4d66-8e2f-3a7a1f9b2c3d', FOLLOWER));

    expect(await notify.unreadCount(FOLLOWER)).toBe(2);
  });
});
