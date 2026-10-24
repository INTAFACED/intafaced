import { describe, expect, it } from 'vitest';
import { MemoryEventBus, bankScheduledFailed, bankScheduledReminder } from '@intafaced/events';
import { MemoryNotifyStore } from './store.js';
import { NotifyService, type CreateResult } from './notify-service.js';
import { categoryFromKind } from './preferences/categories.js';
import { subscribeNotificationEvents } from './events.js';

const OWNER = '33333333-3333-4333-8333-333333333333';
const SCHEDULE = '4a5b6c7d-8e9f-4a0b-8c1d-2e3f4a5b6c7d';

const reminder = {
  noticeId: '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e',
  userId: OWNER,
  scheduleId: SCHEDULE,
  occurrence: 3,
  // Far ahead, so the reminder is never read late by the real clock.
  dueAt: '2099-10-25T09:00:00.000Z',
  amount: '40',
  assetId: 'USDT',
  leadHours: 24,
};

const failed = {
  noticeId: '6c7d8e9f-0a1b-4c2d-8e3f-4a5b6c7d8e9f',
  userId: OWNER,
  scheduleId: SCHEDULE,
  occurrence: 2,
  amount: '40',
  assetId: 'USDT',
  reasonCode: 'bank.insufficient_funds',
  failedAt: '2026-10-24T09:00:03.000Z',
};

async function wired() {
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  const bus = new MemoryEventBus('svc-bank');
  await subscribeNotificationEvents(bus, notify);
  return { notify, bus };
}

describe('standing-order notices (BK-acct-10, J-bank-06 #6)', () => {
  it('writes one reminder per standing-order run however often the event comes', async () => {
    const { notify, bus } = await wired();

    await bus.publish('bankScheduledReminder', reminder);
    await bus.publish('bankScheduledReminder', { ...reminder, noticeId: '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' });

    const inbox = await notify.list({ userId: OWNER, limit: 10, unreadOnly: false });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({
      kind: 'bank.scheduled_reminder',
      titleKey: 'notify.bank.scheduled_reminder.title',
      bodyKey: 'notify.bank.scheduled_reminder.body',
      params: {
        scheduleId: SCHEDULE,
        occurrence: '3',
        amount: '40',
        assetId: 'USDT',
        leadHours: '24',
        dueAt: reminder.dueAt,
        dueDate: '2099-10-25',
      },
      href: '/bank/transfers',
      severity: 'info',
      sourceSubject: bankScheduledReminder.subject,
      sourceIdempotencyKey: `${SCHEDULE}:3`,
    });
  });

  it('writes one failure notice with the reason, apart from the reminder for the same run', async () => {
    const { notify, bus } = await wired();

    await bus.publish('bankScheduledFailed', failed);
    await bus.publish('bankScheduledFailed', failed);
    await bus.publish('bankScheduledReminder', { ...reminder, occurrence: 2 });

    const inbox = await notify.list({ userId: OWNER, limit: 10, unreadOnly: false });
    expect(inbox.items).toHaveLength(2);
    const notice = inbox.items.find((item) => item.kind === 'bank.scheduled_failed');
    expect(notice).toMatchObject({
      titleKey: 'notify.bank.scheduled_failed.title',
      bodyKey: 'notify.bank.scheduled_failed.body',
      params: { scheduleId: SCHEDULE, occurrence: '2', reasonCode: 'bank.insufficient_funds', failedAt: failed.failedAt },
      href: '/bank/transfers',
      severity: 'action',
      sourceSubject: bankScheduledFailed.subject,
      sourceIdempotencyKey: `${SCHEDULE}:2`,
    });
  });

  it('keeps two runs of one standing order apart', async () => {
    const { notify, bus } = await wired();

    await bus.publish('bankScheduledReminder', reminder);
    await bus.publish('bankScheduledReminder', { ...reminder, occurrence: 4, dueAt: '2099-11-25T09:00:00.000Z' });

    expect((await notify.list({ userId: OWNER, limit: 10, unreadOnly: false })).items).toHaveLength(2);
  });
  it('drops a reminder read after its run was due: nobody is told to top up for a run that already happened', async () => {
    const { notify, bus } = await wired();

    await bus.publish('bankScheduledReminder', { ...reminder, dueAt: '2020-01-01T09:00:00.000Z' });

    expect((await notify.list({ userId: OWNER, limit: 10, unreadOnly: false })).items).toHaveLength(0);
  });

  it("files both kinds under the orders category, so they follow the account's orders choices", () => {
    expect(categoryFromKind('bank.scheduled_reminder')).toBe('orders');
    expect(categoryFromKind('bank.scheduled_failed')).toBe('orders');
  });

  it('writes the failure notice, then asks for a retry when a channel answers "try again"', async () => {
    class ChannelDown extends NotifyService {
      override async create(input: Parameters<NotifyService['create']>[0]): Promise<CreateResult> {
        const result = await super.create(input);
        return {
          ...result,
          dispatch: {
            notificationId: 'n-owner',
            retry: true,
            outcomes: [{ channel: 'email', status: 'failed', code: null, detail: 'gateway 503', retryable: true }],
          },
        };
      }
    }
    const notify = new ChannelDown(new MemoryNotifyStore(), { fanoutEnabled: true });
    const bus = new MemoryEventBus('svc-bank');
    await subscribeNotificationEvents(bus, notify);

    await expect(bus.publish('bankScheduledFailed', failed)).rejects.toThrow(/retry/);
    expect((await notify.list({ userId: OWNER, limit: 10, unreadOnly: false })).items).toMatchObject([{ kind: 'bank.scheduled_failed' }]);
  });
});
