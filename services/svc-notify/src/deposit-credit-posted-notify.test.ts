import { describe, expect, it } from 'vitest';
import { MemoryEventBus, payDepositCreditPosted } from '@intafaced/events';
import { MemoryNotifyStore } from './store.js';
import { NotifyService, type CreateResult } from './notify-service.js';
import { subscribeNotificationEvents } from './events.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

/** TEST figures only. */
const credited = {
  depositId: '33333333-3333-4333-8333-333333333333',
  userId: ALICE,
  assetId: 'USDT',
  networkId: 'ethereum',
  amount: '100',
  txHash: `0x${'ab'.repeat(32)}`,
  ledgerTxId: '44444444-4444-4444-8444-444444444444',
  creditedAt: '2026-10-24T12:00:00.000Z',
};

async function wired(notify: NotifyService) {
  const bus = new MemoryEventBus('svc-pay');
  await subscribeNotificationEvents(bus, notify);
  return bus;
}

describe('deposit credited notices (W-deposit-09, J-wallet-02 #7)', () => {
  it('tells the customer the deposit is in their balance, once however often svc-pay announces it', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const bus = await wired(notify);

    await bus.publish('payDepositCreditPosted', credited);
    await bus.publish('payDepositCreditPosted', credited);

    const inbox = await notify.list({ userId: ALICE, limit: 10, unreadOnly: false });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({
      kind: 'bank.deposit.credited',
      titleKey: 'notify.bank.deposit.credited.title',
      bodyKey: 'notify.bank.deposit.credited.body',
      params: {
        amount: '100',
        asset: 'USDT',
        networkId: 'ethereum',
        depositId: credited.depositId,
        txHash: credited.txHash,
        ledgerTxId: credited.ledgerTxId,
      },
      href: '/uc/recharge',
      sourceSubject: payDepositCreditPosted.subject,
      sourceIdempotencyKey: credited.depositId,
    });
    expect((await notify.list({ userId: BOB, limit: 10, unreadOnly: false })).items).toHaveLength(0);
  });

  it('keeps two deposits apart, even of the same amount', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const bus = await wired(notify);

    await bus.publish('payDepositCreditPosted', credited);
    await bus.publish('payDepositCreditPosted', { ...credited, depositId: '55555555-5555-4555-8555-555555555555' });

    expect((await notify.list({ userId: ALICE, limit: 10, unreadOnly: false })).items).toHaveLength(2);
  });

  it('refuses a payload that is not a credit, and writes nothing', async () => {
    const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
    const bus = await wired(notify);

    await expect(bus.publish('payDepositCreditPosted', { ...credited, amount: 100 } as never)).rejects.toThrow();
    expect((await notify.list({ userId: ALICE, limit: 10, unreadOnly: false })).items).toHaveLength(0);
  });

  it('keeps the inbox row and asks for a retry when an out-of-app channel wants one', async () => {
    class ChannelDown extends NotifyService {
      override async create(input: Parameters<NotifyService['create']>[0]): Promise<CreateResult> {
        const result = await super.create(input);
        return {
          ...result,
          dispatch: {
            notificationId: 'n-deposit',
            retry: true,
            outcomes: [{ channel: 'email', status: 'failed', code: null, detail: 'gateway 503', retryable: true }],
          },
        };
      }
    }
    const notify = new ChannelDown(new MemoryNotifyStore(), { fanoutEnabled: true });
    const bus = await wired(notify);

    await expect(bus.publish('payDepositCreditPosted', credited)).rejects.toThrow(/retry/);
    expect((await notify.list({ userId: ALICE, limit: 10, unreadOnly: false })).items).toMatchObject([{ kind: 'bank.deposit.credited' }]);
  });
});
