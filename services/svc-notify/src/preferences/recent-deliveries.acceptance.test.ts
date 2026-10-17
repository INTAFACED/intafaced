import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryDeliveryStore, MemoryTargetStore } from '../channel-store.js';
import { InAppChannel, UnconfiguredChannel } from '../channels/gateway.js';
import { ChannelRegistry } from '../channels/registry.js';
import { NotificationDispatcher } from '../dispatch.js';
import { NotifyService } from '../notify-service.js';
import { createNotifyRouter } from '../router.js';
import { MemoryNotifyStore } from '../store.js';
import { RECENT_DELIVERIES_LIMIT_MAX } from './recent.js';

/**
 * Seam: notify.recentDeliveries. Counts are literals for the rows this file inserts.
 */

const SECRET = 'notify-recent-acceptance-edge-secret-value';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-notify' });

function signed(userId: string) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['notify:read', 'notify:write'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: `req-${userId}`,
  });
}

function channels() {
  return new ChannelRegistry([
    new InAppChannel(),
    new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']),
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
}

async function settle(
  deliveries: MemoryDeliveryStore,
  notificationId: string,
  status: 'accepted' | 'refused' | 'failed' | 'abandoned' | 'pending',
) {
  const claim = await deliveries.claim(notificationId, 'email', 3);
  if (!claim.claimed) throw new Error('claim failed');
  if (status === 'pending') return;
  await deliveries.settle({
    id: claim.id,
    attempt: claim.attempt,
    status,
    refusalCode: status === 'refused' ? 'channel.not_configured' : null,
    attempted: status === 'failed' || status === 'abandoned',
  });
}

describe('notify.recentDeliveries', () => {
  it('pages the caller only, with counts that match the page, and clamps the limit', async () => {
    expect(RECENT_DELIVERIES_LIMIT_MAX).toBe(50);
    let tick = Date.parse('2026-05-01T00:00:00.000Z');
    const deliveries = new MemoryDeliveryStore({ now: () => new Date(tick) });
    const store = new MemoryNotifyStore();
    const registry = channels();
    const dispatcher = new NotificationDispatcher(registry, new MemoryTargetStore(), deliveries, {
      maxAttempts: 3,
      outOfAppEnabled: false,
    });
    const notify = new NotifyService(
      store,
      { fanoutEnabled: true },
      { targets: new MemoryTargetStore(), deliveries, channels: registry, dispatcher },
    );
    const caller = createNotifyRouter(notify).createCaller(signed(USER));
    const other = createNotifyRouter(notify).createCaller(signed(OTHER));

    const statuses = ['accepted', 'accepted', 'refused', 'failed', 'abandoned', 'accepted', 'refused'] as const;
    const ids: string[] = [];
    for (const status of statuses) {
      tick += 1000;
      const inserted = await store.insert({
        userId: USER,
        kind: 'trade.fill',
        titleKey: 'notify.trade.fill.title',
        bodyKey: 'notify.trade.fill.body',
        severity: 'info',
        sourceSubject: 'intafaced.trade.fill.settled',
        sourceIdempotencyKey: `recent-${status}-${tick}`,
      });
      ids.push(inserted.notification!.id);
      await settle(deliveries, inserted.notification!.id, status);
    }
    tick += 1000;
    const pending = await store.insert({
      userId: USER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      severity: 'info',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'recent-pending',
    });
    await settle(deliveries, pending.notification!.id, 'pending');
    tick += 1000;
    const foreign = await store.insert({
      userId: OTHER,
      kind: 'trade.fill',
      titleKey: 'notify.trade.fill.title',
      bodyKey: 'notify.trade.fill.body',
      severity: 'info',
      sourceSubject: 'intafaced.trade.fill.settled',
      sourceIdempotencyKey: 'recent-other',
    });
    await settle(deliveries, foreign.notification!.id, 'accepted');

    const page1 = await caller.notify.recentDeliveries({ limit: 3 });
    expect(page1.rows.map((row) => row.notificationId)).toEqual([ids[6], ids[5], ids[4]]);
    expect(page1.counts).toEqual({ sent: 1, refused: 1, failed: 1 });
    expect(page1.counts.sent + page1.counts.refused + page1.counts.failed).toBe(page1.rows.length);
    expect(page1.rows[0]).toMatchObject({ status: 'refused', outcome: 'refused', channel: 'email' });
    expect(page1.rows[1]).toMatchObject({ status: 'accepted', outcome: 'sent' });
    expect(page1.rows[2]).toMatchObject({ status: 'abandoned', outcome: 'failed' });

    const page2 = await caller.notify.recentDeliveries({ limit: 3, cursor: page1.nextCursor });
    expect(page2.rows.map((row) => row.notificationId)).toEqual([ids[3], ids[2], ids[1]]);
    expect(page2.counts).toEqual({ sent: 1, refused: 1, failed: 1 });

    const page3 = await caller.notify.recentDeliveries({ limit: 3, cursor: page2.nextCursor });
    expect(page3.rows.map((row) => row.notificationId)).toEqual([ids[0]]);
    expect(page3.counts).toEqual({ sent: 1, refused: 0, failed: 0 });
    expect(page3.nextCursor).toBeNull();

    const seen = [...page1.rows, ...page2.rows, ...page3.rows].map((row) => row.notificationId);
    expect(new Set(seen).size).toBe(7);
    expect(seen).not.toContain(foreign.notification!.id);
    expect(seen).not.toContain(pending.notification!.id);

    const foreignPage = await other.notify.recentDeliveries({ limit: 10 });
    expect(foreignPage.rows.map((row) => row.notificationId)).toEqual([foreign.notification!.id]);
    expect(foreignPage.counts).toEqual({ sent: 1, refused: 0, failed: 0 });

    for (let n = 0; n < 55; n += 1) {
      tick += 1000;
      const row = await store.insert({
        userId: USER,
        kind: 'token.stake.created',
        titleKey: 'notify.token.stake.created.title',
        bodyKey: 'notify.token.stake.created.body',
        severity: 'info',
        sourceSubject: 'intafaced.token.stake.created',
        sourceIdempotencyKey: `clamp-${n}`,
      });
      await settle(deliveries, row.notification!.id, 'accepted');
    }
    const clamped = await caller.notify.recentDeliveries({ limit: 10_000 });
    expect(clamped.rows).toHaveLength(50);
    expect(clamped.counts.sent + clamped.counts.refused + clamped.counts.failed).toBe(50);
  });

  it('refuses a cursor that is not one of ours', async () => {
    const deliveries = new MemoryDeliveryStore();
    const registry = channels();
    const notify = new NotifyService(
      new MemoryNotifyStore(),
      { fanoutEnabled: true },
      {
        targets: new MemoryTargetStore(),
        deliveries,
        channels: registry,
        dispatcher: new NotificationDispatcher(registry, new MemoryTargetStore(), deliveries, { maxAttempts: 3, outOfAppEnabled: false }),
      },
    );
    const caller = createNotifyRouter(notify).createCaller(signed(USER));
    await expect(caller.notify.recentDeliveries({ limit: 5, cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.recent_deliveries_cursor_invalid',
    });
  });
});
