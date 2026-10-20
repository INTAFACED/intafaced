import { describe, expect, it } from 'vitest';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { MemoryCommandLog } from '../preferences/account.js';
import { MemoryNoticeStore, NoticeBoard, NoticeError, type NoticeApprovalConsumer } from './board.js';
import { clampStatusDays } from './status-feed.js';

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';

class Approvals implements NoticeApprovalConsumer {
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    return {
      approvalId: input.approvalId,
      actionType: 'notify.notice.publish',
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      requesterId: AUTHOR,
      approverId: APPROVER,
      policyVersion: 'v1',
      createdAt: '2026-10-17T00:00:00.000Z',
      expiresAt: '2026-10-17T01:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

function harness(start: string) {
  let now = new Date(start);
  const board = new NoticeBoard(new MemoryNoticeStore(), new Approvals(), new MemoryCommandLog(), () => now);
  let n = 0;
  return {
    board,
    at(iso: string) {
      now = new Date(iso);
    },
    /** Draft and publish in one step, as two different operators. */
    async publish(input: Parameters<NoticeBoard['draft']>[1]) {
      n += 1;
      const draft = await board.draft(AUTHOR, input);
      return board.publish(AUTHOR, { id: draft.id, clientRequestId: `pub-${n}`, approvalId: `appr-${n}`, operationId: `op-${n}` });
    },
  };
}

const incident = (key: string, extra: Record<string, unknown> = {}) => ({
  kind: 'incident',
  title: 'Test incident',
  body: 'Test body',
  clientRequestId: key,
  ...extra,
});

describe('status feed', () => {
  it('reads unknown, never operational, when nothing is published', async () => {
    const h = harness('2026-10-17T12:00:00.000Z');
    const feed = await h.board.statusFeed({ days: 3 });
    expect(feed.asOf).toBe('2026-10-17T12:00:00.000Z');
    expect(feed.components).toEqual([
      { component: 'api', state: 'unknown', basis: 'no_measurement', since: null },
      { component: 'webhooks', state: 'unknown', basis: 'no_measurement', since: null },
      { component: 'console', state: 'unknown', basis: 'no_measurement', since: null },
    ]);
    expect(feed.incidents).toEqual([]);
    expect(feed.maintenance).toEqual([]);
    expect(feed.history.basis).toBe('incident_notices_only');
    expect(feed.history.days.map((d) => d.date)).toEqual(['2026-10-15', '2026-10-16', '2026-10-17']);
    expect(feed.history.days.every((d) => d.components.every((c) => c.incidentMinutes === 0 && c.worstImpact === null))).toBe(true);
  });

  it('lists an incident with its updates, sets the affected component, and closes it on a resolving update', async () => {
    const h = harness('2026-10-17T10:00:00.000Z');
    const root = await h.publish(incident('i-1', { impact: 'major', components: ['api'] }));
    h.at('2026-10-17T10:30:00.000Z');
    await h.publish(incident('i-2', { parentId: root.id, impact: 'minor', components: ['api'], body: 'Test update' }));
    h.at('2026-10-17T12:00:00.000Z');

    const during = await h.board.statusFeed({ days: 1 });
    expect(during.components.find((c) => c.component === 'api')).toEqual({
      component: 'api',
      state: 'degraded',
      basis: 'incident',
      since: '2026-10-17T10:00:00.000Z',
    });
    expect(during.components.find((c) => c.component === 'webhooks')?.state).toBe('unknown');
    expect(during.incidents).toHaveLength(1);
    expect(during.incidents[0]).toMatchObject({ id: root.id, impact: 'minor', resolvedAt: null, components: ['api'] });
    expect(during.incidents[0]!.updates.map((u) => u.impact)).toEqual(['major', 'minor']);
    expect(during.history.days[0]!.components.find((c) => c.component === 'api')).toEqual({
      component: 'api',
      incidentMinutes: 120,
      worstImpact: 'major',
    });

    h.at('2026-10-17T11:00:00.000Z');
    await h.publish(incident('i-3', { parentId: root.id, resolves: true, body: 'Test resolved' }));
    h.at('2026-10-17T12:00:00.000Z');
    const after = await h.board.statusFeed({ days: 1 });
    expect(after.incidents[0]).toMatchObject({ id: root.id, resolvedAt: '2026-10-17T11:00:00.000Z' });
    expect(after.components.find((c) => c.component === 'api')?.state).toBe('unknown');
    expect(after.history.days[0]!.components.find((c) => c.component === 'api')?.incidentMinutes).toBe(60);
  });

  it('shows the worst impact when two open incidents hit one component, and counts shared minutes once', async () => {
    const h = harness('2026-10-17T10:00:00.000Z');
    await h.publish(incident('a', { impact: 'minor', components: ['webhooks'] }));
    h.at('2026-10-17T10:30:00.000Z');
    await h.publish(incident('b', { impact: 'critical', components: ['webhooks', 'console'] }));
    h.at('2026-10-17T11:00:00.000Z');
    const feed = await h.board.statusFeed({ days: 1 });
    expect(feed.components.find((c) => c.component === 'webhooks')?.state).toBe('major_outage');
    expect(feed.components.find((c) => c.component === 'console')?.state).toBe('major_outage');
    expect(feed.history.days[0]!.components.find((c) => c.component === 'webhooks')?.incidentMinutes).toBe(60);
  });

  it('keeps an impact of none out of the component state', async () => {
    const h = harness('2026-10-17T10:00:00.000Z');
    await h.publish(incident('n', { impact: 'none', components: ['api'] }));
    const feed = await h.board.statusFeed({ days: 1 });
    expect(feed.components.find((c) => c.component === 'api')?.state).toBe('unknown');
    expect(feed.incidents).toHaveLength(1);
  });

  it('reports a maintenance window on its components while it is open', async () => {
    const h = harness('2026-10-17T10:00:00.000Z');
    await h.publish({
      kind: 'maintenance',
      title: 'Test window',
      body: 'Test body',
      components: ['console'],
      startsAt: '2026-10-17T09:00:00.000Z',
      endsAt: '2026-10-17T11:00:00.000Z',
      clientRequestId: 'm-1',
    });
    const feed = await h.board.statusFeed({ days: 1 });
    expect(feed.components.find((c) => c.component === 'console')).toMatchObject({ state: 'maintenance', basis: 'maintenance' });
    expect(feed.maintenance).toHaveLength(1);
    h.at('2026-10-17T11:00:00.000Z');
    expect((await h.board.statusFeed({ days: 1 })).components.find((c) => c.component === 'console')?.state).toBe('unknown');
  });

  it('treats a legacy incident with no fields as open until its end time, with no component affected', async () => {
    const h = harness('2026-10-17T10:00:00.000Z');
    await h.publish(incident('legacy', { endsAt: '2026-10-17T11:00:00.000Z' }));
    const open = await h.board.statusFeed({ days: 1 });
    expect(open.incidents[0]).toMatchObject({ impact: null, components: [], resolvedAt: null });
    expect(open.components.every((c) => c.state === 'unknown')).toBe(true);
    h.at('2026-10-17T12:00:00.000Z');
    expect((await h.board.statusFeed({ days: 1 })).incidents[0]!.resolvedAt).toBe('2026-10-17T11:00:00.000Z');
  });

  it('keeps the minutes and worst impact of an incident whose resolving update names impact none', async () => {
    const h = harness('2026-10-17T10:00:00.000Z');
    const root = await h.publish(incident('d-1', { impact: 'critical', components: ['api'] }));
    h.at('2026-10-17T11:00:00.000Z');
    await h.publish(incident('d-2', { parentId: root.id, impact: 'none', resolves: true, body: 'Test resolved' }));
    h.at('2026-10-17T12:00:00.000Z');
    const feed = await h.board.statusFeed({ days: 1 });
    expect(feed.history.days[0]!.components.find((c) => c.component === 'api')).toEqual({
      component: 'api',
      incidentMinutes: 60,
      worstImpact: 'critical',
    });
  });

  it('lists an incident once in the status read, and drops it when an update closes it', async () => {
    const h = harness('2026-10-17T10:00:00.000Z');
    const root = await h.publish(incident('s-1', { impact: 'major', components: ['api'] }));
    h.at('2026-10-17T10:30:00.000Z');
    await h.publish(incident('s-2', { parentId: root.id, impact: 'minor', components: ['api'] }));
    expect((await h.board.noticeStatus()).incidents.map((i) => i.id)).toEqual([root.id]);
    h.at('2026-10-17T11:00:00.000Z');
    await h.publish(incident('s-3', { parentId: root.id, resolves: true }));
    expect((await h.board.noticeStatus()).incidents).toEqual([]);
  });

  it('does not show an incident dated to start later', async () => {
    const h = harness('2026-10-17T10:00:00.000Z');
    await h.publish(incident('f-1', { impact: 'minor', components: ['api'], startsAt: '2026-10-17T13:00:00.000Z' }));
    const feed = await h.board.statusFeed({ days: 1 });
    expect(feed.incidents).toEqual([]);
    expect(feed.components.find((c) => c.component === 'api')?.state).toBe('unknown');
  });

  it('clamps and refuses the day window', () => {
    expect(clampStatusDays(500)).toBe(90);
    expect(() => clampStatusDays(0)).toThrow('notify.status_days_invalid');
    expect(() => clampStatusDays(1.5)).toThrow('notify.status_days_invalid');
  });
});

describe('status notice fields', () => {
  it('refuses fields on the wrong kind, an unknown component, components with no impact, and a bad parent', async () => {
    const h = harness('2026-10-17T10:00:00.000Z');
    const code = async (input: Record<string, unknown>) => {
      try {
        await h.board.draft(AUTHOR, input as never);
      } catch (err) {
        return (err as NoticeError).code;
      }
      return null;
    };
    expect(await code({ kind: 'announcement', title: 'T', body: 'B', impact: 'minor', clientRequestId: 'r1' })).toBe(
      'notify.notice_incident_fields_invalid',
    );
    expect(await code({ kind: 'announcement', title: 'T', body: 'B', components: ['api'], clientRequestId: 'r2' })).toBe(
      'notify.notice_incident_fields_invalid',
    );
    expect(await code(incident('r3', { impact: 'minor', components: ['database'] }))).toBe('notify.notice_component_unknown');
    expect(await code(incident('r4', { components: ['api'] }))).toBe('notify.notice_impact_unset');
    expect(await code(incident('r5', { parentId: '99999999-9999-4999-8999-999999999999' }))).toBe('notify.notice_parent_invalid');
    const note = await h.board.draft(AUTHOR, { kind: 'changelog', title: 'T', body: 'B', clientRequestId: 'r6' });
    expect(await code(incident('r7', { parentId: note.id }))).toBe('notify.notice_parent_invalid');
  });

  it('refuses to publish an update whose first entry is still a draft', async () => {
    const h = harness('2026-10-17T10:00:00.000Z');
    const root = await h.board.draft(AUTHOR, incident('root', { impact: 'minor', components: ['api'] }));
    const child = await h.board.draft(AUTHOR, incident('child', { parentId: root.id, impact: 'minor', components: ['api'] }));
    await expect(
      h.board.publish(AUTHOR, { id: child.id, clientRequestId: 'p-child', approvalId: 'a-child', operationId: 'o-child' }),
    ).rejects.toMatchObject({ code: 'notify.notice_parent_invalid' });
  });

  it('refuses an update of an update', async () => {
    const h = harness('2026-10-17T10:00:00.000Z');
    const root = await h.publish(incident('root', { impact: 'minor', components: ['api'] }));
    const child = await h.publish(incident('child', { parentId: root.id, impact: 'minor', components: ['api'] }));
    await expect(h.board.draft(AUTHOR, incident('grand', { parentId: child.id }) as never)).rejects.toMatchObject({
      code: 'notify.notice_parent_invalid',
    });
  });
});

describe('status feed on the router', () => {
  it('is readable signed out, refuses a bad window, and says when notices are unwired', async () => {
    const mod = await import('../router.js');
    const { NotifyService } = await import('../notify-service.js');
    const { MemoryNotifyStore } = await import('../store.js');
    const { MemoryDeliveryStore, MemoryTargetStore } = await import('../channel-store.js');
    const { InAppChannel, UnconfiguredChannel } = await import('../channels/gateway.js');
    const { ChannelRegistry } = await import('../channels/registry.js');
    const { NotificationDispatcher } = await import('../dispatch.js');
    const { createEdgeContext } = await import('@intafaced/contracts');
    const registry = new ChannelRegistry([
      new InAppChannel(),
      new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']),
      new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
      new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
    ]);
    const targets = new MemoryTargetStore();
    const deliveries = new MemoryDeliveryStore();
    const dispatcher = new NotificationDispatcher(registry, targets, deliveries, { maxAttempts: 3, outOfAppEnabled: false });
    const ctx = createEdgeContext({ secret: 'status-feed-edge-secret-value-0123456789', serviceName: 'svc-notify' })({
      headers: { 'x-intafaced-region': 'DE' },
      id: 'req-anon-status',
    });
    const wired = new NotifyService(
      new MemoryNotifyStore(),
      { fanoutEnabled: true },
      {
        targets,
        deliveries,
        channels: registry,
        dispatcher,
        notices: new NoticeBoard(new MemoryNoticeStore(), null, new MemoryCommandLog(), () => new Date('2026-10-17T12:00:00.000Z')),
      },
    );
    const feed = await mod.createNotifyRouter(wired).createCaller(ctx).notify.statusFeed({ days: 7 });
    expect(feed.components.every((c) => c.state === 'unknown')).toBe(true);
    expect(feed.history.days).toHaveLength(7);
    expect((await mod.createNotifyRouter(wired).createCaller(ctx).notify.statusFeed({ days: 1000 })).history.days).toHaveLength(90);
    await expect(mod.createNotifyRouter(wired).createCaller(ctx).notify.statusFeed({ days: 0 })).rejects.toBeDefined();

    const unwired = new NotifyService(
      new MemoryNotifyStore(),
      { fanoutEnabled: true },
      { targets, deliveries, channels: registry, dispatcher },
    );
    await expect(mod.createNotifyRouter(unwired).createCaller(ctx).notify.statusFeed({ days: 1 })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.notices_unavailable',
    });
  });
});
