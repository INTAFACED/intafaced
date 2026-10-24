import { describe, expect, it } from 'vitest';
import { MemoryEventBus, p2pTradeFiatSent } from '@intafaced/events';
import { MemoryNotifyStore } from './store.js';
import { NotifyService, type CreateResult } from './notify-service.js';
import { subscribeNotificationEvents } from './events.js';

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';

const marked = (tradeId: string) => ({
  tradeId,
  buyerId: BUYER,
  sellerId: SELLER,
  markedAt: '2026-10-24T03:40:00.000Z',
});

describe('buyer-paid notice to the seller (P-trade-orders-23, J-p2p-01 #7)', () => {
  it('tells the seller once, however often the event comes, and never the buyer', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-p2p');
    await subscribeNotificationEvents(bus, notify);

    const tradeId = '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c';
    await bus.publish('p2pTradeFiatSent', marked(tradeId));
    await bus.publish('p2pTradeFiatSent', marked(tradeId));

    expect(await notify.unreadCount(SELLER)).toBe(1);
    expect(await notify.unreadCount(BUYER)).toBe(0);
    const row = (await notify.list({ userId: SELLER, limit: 10, unreadOnly: false })).items[0]!;
    expect(row).toMatchObject({
      kind: 'p2p.trade.fiat_sent',
      titleKey: 'notify.p2p.trade.fiat_sent.title',
      bodyKey: 'notify.p2p.trade.fiat_sent.body',
      href: `/p2p/orders/${tradeId}`,
      severity: 'action',
      sourceSubject: p2pTradeFiatSent.subject,
      sourceIdempotencyKey: `${tradeId}:seller`,
    });
    expect(row.params).toEqual({ tradeId });
  });

  it('keeps two trades apart', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-p2p');
    await subscribeNotificationEvents(bus, notify);

    await bus.publish('p2pTradeFiatSent', marked('0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c'));
    await bus.publish('p2pTradeFiatSent', marked('1c7a2d2f-5b8e-4d66-8e2f-3a7a1f9b2c3d'));

    expect(await notify.unreadCount(SELLER)).toBe(2);
  });

  it('writes the notice, then asks for a retry when the seller’s channel wants one', async () => {
    const store = new MemoryNotifyStore();
    class SellerChannelDown extends NotifyService {
      override async create(input: Parameters<NotifyService['create']>[0]): Promise<CreateResult> {
        const result = await super.create(input);
        return {
          ...result,
          dispatch: {
            notificationId: 'n-seller',
            retry: true,
            outcomes: [{ channel: 'email', status: 'failed', code: null, detail: 'gateway 503', retryable: true }],
          },
        };
      }
    }
    const notify = new SellerChannelDown(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-p2p');
    await subscribeNotificationEvents(bus, notify);

    await expect(bus.publish('p2pTradeFiatSent', marked('0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c'))).rejects.toThrow(/retry/);
    expect((await notify.list({ userId: SELLER, limit: 10, unreadOnly: false })).items).toHaveLength(1);
  });
});
