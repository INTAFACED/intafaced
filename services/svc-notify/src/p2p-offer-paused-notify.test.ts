import { describe, expect, it } from 'vitest';
import { MemoryEventBus, p2pOfferPaused } from '@intafaced/events';
import { MemoryNotifyStore } from './store.js';
import { NotifyService, type CreateResult } from './notify-service.js';
import { subscribeNotificationEvents } from './events.js';
import { renderInboxCopy } from './channels/render.js';

const MAKER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const INSTRUMENT = '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c';

const paused = (instrumentId: string, offerIds: string[]) => ({
  instrumentId,
  makerId: MAKER,
  methodId: 'sepa',
  offerIds,
  reason: 'method_removed' as const,
  pausedAt: '2026-10-25T01:40:00.000Z',
});

describe('ads-paused notice to the maker (P-ads-merchant-18, J-p2p-04 #4)', () => {
  it('tells the maker once per removal, however often the event comes', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-p2p');
    await subscribeNotificationEvents(bus, notify);

    const offers = ['3c8b3e3f-6c9f-4e77-9f3a-4b8b2a0c3d4e', '4d9c4f4a-7daa-4f88-8a4b-5c9c3b1d4e5f'];
    await bus.publish('p2pOfferPaused', paused(INSTRUMENT, offers));
    await bus.publish('p2pOfferPaused', paused(INSTRUMENT, offers));

    expect(await notify.unreadCount(MAKER)).toBe(1);
    expect(await notify.unreadCount(OTHER)).toBe(0);
    const row = (await notify.list({ userId: MAKER, limit: 10, unreadOnly: false })).items[0]!;
    expect(row).toMatchObject({
      kind: 'p2p.offer.paused',
      titleKey: 'notify.p2p.offer.paused.title',
      bodyKey: 'notify.p2p.offer.paused.body',
      href: '/uc/ad',
      severity: 'action',
      sourceSubject: p2pOfferPaused.subject,
      sourceIdempotencyKey: `${INSTRUMENT}:maker`,
    });
    expect(row.params).toEqual({ instrumentId: INSTRUMENT, methodId: 'sepa', count: '2' });
    expect(renderInboxCopy(row, 'en')).toEqual({
      title: 'Ads paused: payment method removed',
      body: 'You removed the only payment method 2 of your ads could be paid with, so they are paused. Add a payment method for their currency, then resume them from My offers.',
    });
  });

  it('says "it" when one ad was paused', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-p2p');
    await subscribeNotificationEvents(bus, notify);

    await bus.publish('p2pOfferPaused', paused(INSTRUMENT, ['3c8b3e3f-6c9f-4e77-9f3a-4b8b2a0c3d4e']));

    const row = (await notify.list({ userId: MAKER, limit: 10, unreadOnly: false })).items[0]!;
    expect(renderInboxCopy(row, 'en').body).toBe(
      'You removed the only payment method 1 of your ads could be paid with, so it is paused. Add a payment method for its currency, then resume it from My offers.',
    );
  });

  it('keeps two removals apart', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-p2p');
    await subscribeNotificationEvents(bus, notify);

    await bus.publish('p2pOfferPaused', paused(INSTRUMENT, ['3c8b3e3f-6c9f-4e77-9f3a-4b8b2a0c3d4e']));
    await bus.publish('p2pOfferPaused', paused('1c7a2d2f-5b8e-4d66-8e2f-3a7a1f9b2c3d', ['4d9c4f4a-7daa-4f88-8a4b-5c9c3b1d4e5f']));

    expect(await notify.unreadCount(MAKER)).toBe(2);
  });

  it('writes the notice, then asks for a retry when the maker’s channel wants one', async () => {
    const store = new MemoryNotifyStore();
    class MakerChannelDown extends NotifyService {
      override async create(input: Parameters<NotifyService['create']>[0]): Promise<CreateResult> {
        const result = await super.create(input);
        return {
          ...result,
          dispatch: {
            notificationId: 'n-maker',
            retry: true,
            outcomes: [{ channel: 'email', status: 'failed', code: null, detail: 'gateway 503', retryable: true }],
          },
        };
      }
    }
    const notify = new MakerChannelDown(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-p2p');
    await subscribeNotificationEvents(bus, notify);

    await expect(bus.publish('p2pOfferPaused', paused(INSTRUMENT, ['3c8b3e3f-6c9f-4e77-9f3a-4b8b2a0c3d4e']))).rejects.toThrow(/retry/);
    expect((await notify.list({ userId: MAKER, limit: 10, unreadOnly: false })).items).toHaveLength(1);
  });
});
