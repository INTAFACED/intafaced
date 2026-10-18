import { describe, expect, it } from 'vitest';
import { MemoryEventBus, personalRequestCreated, personalRequestSettled } from '@intafaced/events';
import { MemoryNotifyStore } from './store.js';
import { NotifyService } from './notify-service.js';
import { subscribeNotificationEvents } from './events.js';

const PAYER = '11111111-1111-4111-8111-111111111111';
const PAYEE = '22222222-2222-4222-8222-222222222222';
const REQUEST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('personal request inbox', () => {
  it('writes pay.request_created to the payer and pay.request_paid to the payee', async () => {
    const store = new MemoryNotifyStore();
    const notify = new NotifyService(store, { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-bank');
    await subscribeNotificationEvents(bus, notify);

    await bus.publish('personalRequestCreated', {
      requestId: REQUEST,
      payerUserId: PAYER,
      payeeHandle: 'ada',
      amount: '12.5',
      assetId: 'USDT',
      note: 'lunch',
      expiresAt: '2026-12-01T00:00:00.000Z',
      sequence: 1,
    });
    await bus.publish('personalRequestCreated', {
      requestId: REQUEST,
      payerUserId: PAYER,
      payeeHandle: 'ada',
      amount: '12.5',
      assetId: 'USDT',
      note: 'lunch',
      expiresAt: '2026-12-01T00:00:00.000Z',
      sequence: 1,
    });
    await bus.publish('personalRequestSettled', {
      requestId: REQUEST,
      payeeUserId: PAYEE,
      payerHandle: 'bob',
      amount: '12.5',
      assetId: 'USDT',
      ledgerTxId: 'tx-paid-1',
    });

    const asked = await notify.list({ userId: PAYER, limit: 10, unreadOnly: false });
    expect(asked.items).toHaveLength(1);
    expect(asked.items[0]).toMatchObject({
      kind: 'pay.request_created',
      sourceSubject: personalRequestCreated.subject,
      sourceIdempotencyKey: `${REQUEST}:1`,
      href: `/pay/request/${REQUEST}`,
    });

    const paid = await notify.list({ userId: PAYEE, limit: 10, unreadOnly: false });
    expect(paid.items).toHaveLength(1);
    expect(paid.items[0]).toMatchObject({
      kind: 'pay.request_paid',
      sourceSubject: personalRequestSettled.subject,
      sourceIdempotencyKey: REQUEST,
      href: `/pay/request/${REQUEST}`,
    });
  });
});
