import { describe, expect, it } from 'vitest';
import { MemoryEventBus, p2pRemarkCaseOpened } from '@intafaced/events';
import { MemoryNotifyStore } from './store.js';
import { NotifyService, type CreateResult } from './notify-service.js';
import { subscribeNotificationEvents } from './events.js';
import { renderInboxCopy } from './channels/render.js';

const BUYER = '11111111-1111-4111-8111-111111111111';
const SELLER = '22222222-2222-4222-8222-222222222222';
const TRADE = '0b6f1c1e-4a7d-4c55-9d1e-2f6f0e8a1b2c';
const CASE = '3c8b3e3f-6c9f-4e77-9f3a-4b8b2a0c3d4e';

const opened = (caseId: string, reportedId = BUYER) => ({
  caseId,
  tradeId: TRADE,
  reportedId,
  reporterRole: reportedId === BUYER ? ('seller' as const) : ('buyer' as const),
  openedAt: '2026-10-25T10:00:00.000Z',
});

async function wired(notify: NotifyService) {
  const bus = new MemoryEventBus('svc-p2p');
  await subscribeNotificationEvents(bus, notify);
  return bus;
}

describe('reported-remark notice to the reported party (P-ads-merchant-19, J-p2p-04 #5)', () => {
  it('tells the reported party once per case, however often the event comes, and links the order', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const bus = await wired(notify);

    await bus.publish('p2pRemarkCaseOpened', opened(CASE));
    await bus.publish('p2pRemarkCaseOpened', opened(CASE));

    expect(await notify.unreadCount(BUYER)).toBe(1);
    expect(await notify.unreadCount(SELLER)).toBe(0);
    const row = (await notify.list({ userId: BUYER, limit: 10, unreadOnly: false })).items[0]!;
    expect(row).toMatchObject({
      kind: 'p2p.remark_case.opened',
      titleKey: 'notify.p2p.remark_case.opened.title',
      bodyKey: 'notify.p2p.remark_case.opened.body',
      href: `/p2p/orders/${TRADE}`,
      severity: 'action',
      sourceSubject: p2pRemarkCaseOpened.subject,
      sourceIdempotencyKey: `${CASE}:reported`,
    });
    expect(row.params).toEqual({ caseId: CASE, tradeId: TRADE });
    expect(renderInboxCopy(row, 'en')).toEqual({
      title: 'A payment-note remark was reported',
      body: 'The other person on this order reported something written in a payment note. A case is open for staff to decide. In a payment note, write only what the payment method asks for.',
    });
  });

  it('keeps two cases apart: each party reported on one order is told of their own', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const bus = await wired(notify);

    await bus.publish('p2pRemarkCaseOpened', opened(CASE, BUYER));
    await bus.publish('p2pRemarkCaseOpened', opened('4d9c4f4a-7daa-4f88-8a4b-5c9c3b1d4e5f', SELLER));

    expect(await notify.unreadCount(BUYER)).toBe(1);
    expect(await notify.unreadCount(SELLER)).toBe(1);
  });

  it('writes the notice, then asks for a retry when the reported party’s channel wants one', async () => {
    class ChannelDown extends NotifyService {
      override async create(input: Parameters<NotifyService['create']>[0]): Promise<CreateResult> {
        const result = await super.create(input);
        return {
          ...result,
          dispatch: {
            notificationId: 'n-reported',
            retry: true,
            outcomes: [{ channel: 'email', status: 'failed', code: null, detail: 'gateway 503', retryable: true }],
          },
        };
      }
    }
    const notify = new ChannelDown(new MemoryNotifyStore(), { fanoutEnabled: true });
    const bus = await wired(notify);

    await expect(bus.publish('p2pRemarkCaseOpened', opened(CASE))).rejects.toThrow(/retry/);
    expect((await notify.list({ userId: BUYER, limit: 10, unreadOnly: false })).items).toHaveLength(1);
  });
});
