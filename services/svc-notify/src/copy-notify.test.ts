/**
 * J-copy-bots-otc-03 #6: a follow that skipped a copy or stopped copying puts a notice in the follower's inbox, with the
 * reason in words and what they can do, once per event key, and no raw code.
 */
import { en } from '@intafaced/i18n';
import { COPY_SKIP_REASON_IDS, COPY_STOP_REASON_IDS, MemoryEventBus } from '@intafaced/events';
import { describe, expect, it } from 'vitest';
import { subscribeNotificationEvents } from './events.js';
import { NotifyService } from './notify-service.js';
import { MemoryNotifyStore } from './store.js';

const FOLLOWER = '11111111-1111-4111-8111-1111111111e1';
const LEADER = '22222222-2222-4222-8222-2222222222e2';
const FILL = '33333333-3333-4333-8333-3333333333e3';
const FOLLOW = 'follow-e1';

async function wired() {
  const notify = new NotifyService(new MemoryNotifyStore(), { fanoutEnabled: true });
  const bus = new MemoryEventBus('svc-trade');
  await subscribeNotificationEvents(bus, notify);
  const inbox = async () => (await notify.list({ userId: FOLLOWER, limit: 20, unreadOnly: false })).items;
  const inboxOf = async (userId: string) => (await notify.list({ userId, limit: 20, unreadOnly: false })).items;
  return { bus, inbox, inboxOf };
}

const words = (key: string) => (en as Record<string, string>)[key];

describe('copy notices (J-copy-bots-otc-03 #6)', () => {
  it('a skipped copy tells the follower why and what they can do, once however often it is sent', async () => {
    const { bus, inbox } = await wired();
    const skipped = {
      followId: FOLLOW,
      followerId: FOLLOWER,
      leaderId: LEADER,
      leaderFillId: FILL,
      reason: 'risk_control' as const,
      skippedAt: '2026-10-30T08:00:00.000Z',
    };
    await bus.publish('copySkipped', skipped);
    await bus.publish('copySkipped', skipped);
    const items = await inbox();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'trade.copy.skipped',
      titleKey: 'notify.trade.copy_skipped.title',
      bodyKey: 'notify.trade.copy_skipped.body.risk_control',
      href: '/trade/copy?tab=follows',
      params: { followId: FOLLOW, leaderFillId: FILL },
    });
  });

  it('a skip the follower chose (paused, stopped) writes no notice', async () => {
    const { bus, inbox } = await wired();
    for (const reason of ['paused', 'stopped'] as const) {
      await bus.publish('copySkipped', {
        followId: FOLLOW,
        followerId: FOLLOWER,
        leaderId: LEADER,
        leaderFillId: FILL,
        reason,
        skippedAt: '2026-10-30T08:00:00.000Z',
      });
    }
    expect(await inbox()).toEqual([]);
  });

  it('a stop tells the follower, with close-only in words, once per follow and close-only', async () => {
    const { bus, inbox } = await wired();
    const stopped = {
      followId: FOLLOW,
      followerId: FOLLOWER,
      leaderId: LEADER,
      reason: 'follower' as const,
      closeOnly: true,
      stoppedAt: '2026-10-30T08:00:00.000Z',
    };
    await bus.publish('copyStopped', stopped);
    await bus.publish('copyStopped', stopped);
    await bus.publish('copyStopped', { ...stopped, closeOnly: false });
    expect((await inbox()).map((n) => n.bodyKey).sort()).toEqual([
      'notify.trade.copy_stopped.body.follower',
      'notify.trade.copy_stopped.body.follower_close_only',
    ]);
  });

  it('every reason has words with a next step and no raw code; the leader is never told', async () => {
    const keys = [
      'notify.trade.copy_skipped.title',
      'notify.trade.copy_stopped.title',
      ...COPY_SKIP_REASON_IDS.filter((r) => r !== 'paused' && r !== 'stopped').map((r) => `notify.trade.copy_skipped.body.${r}`),
      ...COPY_STOP_REASON_IDS.map((r) => `notify.trade.copy_stopped.body.${r}`),
      'notify.trade.copy_stopped.body.follower_close_only',
    ];
    for (const key of keys) {
      expect(words(key), key).toBeTruthy();
      expect(words(key), key).not.toMatch(/trade\.[a-z_]+/);
      if (key.includes('.body.')) expect(words(key), key).toMatch(/You can /);
    }
    expect(words('notify.trade.copy_skipped.title')).toMatch(/skipped a copy/);
    expect(words('notify.trade.copy_stopped.title')).toMatch(/stopped copying/);

    const { bus, inbox, inboxOf } = await wired();
    await bus.publish('copyStopped', {
      followId: FOLLOW,
      followerId: FOLLOWER,
      leaderId: LEADER,
      reason: 'lead_stopped',
      closeOnly: false,
      stoppedAt: '2026-10-30T08:00:00.000Z',
    });
    expect((await inbox()).map((n) => n.bodyKey)).toEqual(['notify.trade.copy_stopped.body.lead_stopped']);
    expect(await inboxOf(LEADER)).toEqual([]);
  });
});
