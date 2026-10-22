import { describe, expect, it } from 'vitest';
import { MemoryEventBus, personalTransferPosted } from '@intafaced/events';
import { MemoryNotifyStore } from './store.js';
import { NotifyService, type CreateResult } from './notify-service.js';
import { subscribeNotificationEvents } from './events.js';

const SENDER = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';

const posted = {
  transferId: 'f3c1d2e4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  senderUserId: SENDER,
  recipientUserId: RECIPIENT,
  amount: '25',
  assetId: 'USDT',
  ledgerTxId: 'tx-posted-1',
  postedAt: '2026-10-22T10:14:20.000Z',
};

describe('personal transfer notices (PP-send-request-18)', () => {
  it('tells the recipient money arrived and gives the sender the receipt, once each however often the event comes', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-bank');
    await subscribeNotificationEvents(bus, notify);

    await bus.publish('personalTransferPosted', posted);
    await bus.publish('personalTransferPosted', posted);

    const received = await notify.list({ userId: RECIPIENT, limit: 10, unreadOnly: false });
    expect(received.items).toHaveLength(1);
    expect(received.items[0]).toMatchObject({
      kind: 'pay.transfer_received',
      titleKey: 'notify.pay.transfer_received.title',
      bodyKey: 'notify.pay.transfer_received.body',
      params: { amount: '25', assetId: 'USDT', transferId: posted.transferId, ledgerTxId: 'tx-posted-1' },
      href: '/money/activity?tab=transfers',
      sourceSubject: personalTransferPosted.subject,
      sourceIdempotencyKey: posted.transferId,
    });

    const sent = await notify.list({ userId: SENDER, limit: 10, unreadOnly: false });
    expect(sent.items).toHaveLength(1);
    expect(sent.items[0]).toMatchObject({ kind: 'pay.transfer_sent', sourceIdempotencyKey: posted.transferId });
  });

  it('keeps two transfers between the same people apart', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-bank');
    await subscribeNotificationEvents(bus, notify);

    await bus.publish('personalTransferPosted', posted);
    await bus.publish('personalTransferPosted', {
      ...posted,
      transferId: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
      ledgerTxId: 'tx-posted-2',
    });

    expect((await notify.list({ userId: RECIPIENT, limit: 10, unreadOnly: false })).items).toHaveLength(2);
    expect((await notify.list({ userId: SENDER, limit: 10, unreadOnly: false })).items).toHaveLength(2);
  });

  it("writes the sender's receipt even when the recipient's channel wants a retry, then asks for the retry", async () => {
    const store = new MemoryNotifyStore();
    // The recipient's out-of-app channel answers "try again"; the sender's is fine.
    class RecipientChannelDown extends NotifyService {
      override async create(input: Parameters<NotifyService['create']>[0]): Promise<CreateResult> {
        const result = await super.create(input);
        if (input.userId !== RECIPIENT) return result;
        return {
          ...result,
          dispatch: {
            notificationId: 'n-recipient',
            retry: true,
            outcomes: [{ channel: 'email', status: 'failed', code: null, detail: 'gateway 503', retryable: true }],
          },
        };
      }
    }
    const notify = new RecipientChannelDown(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-bank');
    await subscribeNotificationEvents(bus, notify);

    await expect(bus.publish('personalTransferPosted', posted)).rejects.toThrow(/retry/);
    expect((await notify.list({ userId: RECIPIENT, limit: 10, unreadOnly: false })).items).toHaveLength(1);
    expect((await notify.list({ userId: SENDER, limit: 10, unreadOnly: false })).items).toMatchObject([{ kind: 'pay.transfer_sent' }]);
  });

  it('gives a send to oneself only the receipt, not a "money received" notice', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-bank');
    await subscribeNotificationEvents(bus, notify);

    await bus.publish('personalTransferPosted', { ...posted, recipientUserId: SENDER });

    const mine = await notify.list({ userId: SENDER, limit: 10, unreadOnly: false });
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ kind: 'pay.transfer_sent', sourceIdempotencyKey: posted.transferId });
  });
});
