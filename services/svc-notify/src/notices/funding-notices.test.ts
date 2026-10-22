import { describe, expect, it } from 'vitest';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { MemoryCommandLog } from '../preferences/account.js';
import { MemoryNoticeStore, NoticeBoard, NoticeError, type NoticeApprovalConsumer } from './board.js';

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

const usdtEth = { asset: 'USDT', network: 'ethereum' };

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NoticeError) return err.code;
    throw err;
  }
  throw new Error('expected a NoticeError');
}

describe('funding incident notices (W-compliance-notices-01)', () => {
  it('shows an incident for USDT on Ethereum on that network only', async () => {
    const h = harness('2026-10-22T03:00:00.000Z');
    const root = await h.publish(incident('f-1', { ...usdtEth, impact: 'major', phase: 'investigating' }));
    expect(root).toMatchObject({ asset: 'USDT', network: 'ethereum', phase: 'investigating' });

    const eth = await h.board.fundingNotices(usdtEth);
    expect(eth.incidents.map((i) => i.root.id)).toEqual([root.id]);
    expect(eth.incidents[0]!.latest.phase).toBe('investigating');
    expect((await h.board.fundingNotices({ asset: 'USDT', network: 'tron' })).incidents).toEqual([]);
    expect((await h.board.fundingNotices({ asset: 'USDC', network: 'ethereum' })).incidents).toEqual([]);
  });

  it('walks the phases, carries the newest entry, and drops the banner once resolved', async () => {
    const h = harness('2026-10-22T03:00:00.000Z');
    const root = await h.publish(incident('p-1', { ...usdtEth, impact: 'major', phase: 'investigating' }));
    for (const [i, phase] of (['identified', 'update', 'monitoring'] as const).entries()) {
      h.at(`2026-10-22T0${4 + i}:00:00.000Z`);
      await h.publish(incident(`p-${i + 2}`, { parentId: root.id, phase }));
      const read = await h.board.fundingNotices(usdtEth);
      expect(read.incidents[0]!.latest).toMatchObject({ phase, asset: 'USDT', network: 'ethereum' });
    }
    h.at('2026-10-22T08:00:00.000Z');
    await h.publish(incident('p-5', { parentId: root.id, phase: 'resolved', resolves: true }));
    expect((await h.board.fundingNotices(usdtEth)).incidents).toEqual([]);
  });

  it('lists open maintenance for the same asset and network only', async () => {
    const h = harness('2026-10-22T03:00:00.000Z');
    const m = await h.publish({ kind: 'maintenance', title: 'Test maintenance', body: 'Test body', clientRequestId: 'm-1', ...usdtEth });
    await h.publish({
      kind: 'maintenance',
      title: 'Test maintenance',
      body: 'Test body',
      clientRequestId: 'm-2',
      asset: 'USDT',
      network: 'tron',
    });
    await h.publish({ kind: 'maintenance', title: 'Test maintenance', body: 'Test body', clientRequestId: 'm-3' });
    expect((await h.board.fundingNotices(usdtEth)).maintenance.map((n) => n.id)).toEqual([m.id]);
  });

  it('leaves unscoped notices unchanged: no scope, no phase', async () => {
    const h = harness('2026-10-22T03:00:00.000Z');
    const plain = await h.publish(incident('u-1', { impact: 'minor', components: ['api'] }));
    expect(plain).toMatchObject({ asset: null, network: null, phase: null });
  });

  it('refuses a blank phase on a scoped incident and on its updates', async () => {
    const h = harness('2026-10-22T03:00:00.000Z');
    expect(await refusal(h.board.draft(AUTHOR, incident('r-1', { ...usdtEth })))).toBe('notify.notice_phase_unset');
    const root = await h.publish(incident('r-2', { ...usdtEth, phase: 'investigating' }));
    expect(await refusal(h.board.draft(AUTHOR, incident('r-3', { parentId: root.id })))).toBe('notify.notice_phase_unset');
  });

  it('refuses half a scope, a malformed scope, and scope on the wrong kind', async () => {
    const h = harness('2026-10-22T03:00:00.000Z');
    expect(await refusal(h.board.draft(AUTHOR, incident('s-1', { asset: 'USDT', phase: 'investigating' })))).toBe(
      'notify.notice_scope_invalid',
    );
    expect(await refusal(h.board.draft(AUTHOR, incident('s-2', { network: 'ethereum', phase: 'investigating' })))).toBe(
      'notify.notice_scope_invalid',
    );
    expect(await refusal(h.board.draft(AUTHOR, incident('s-3', { asset: 'usdt', network: 'ethereum', phase: 'investigating' })))).toBe(
      'notify.notice_scope_invalid',
    );
    expect(await refusal(h.board.draft(AUTHOR, incident('s-4', { asset: 'USDT', network: 'Ethereum', phase: 'investigating' })))).toBe(
      'notify.notice_scope_invalid',
    );
    expect(await refusal(h.board.draft(AUTHOR, { kind: 'announcement', title: 'T', body: 'B', clientRequestId: 's-5', ...usdtEth }))).toBe(
      'notify.notice_scope_invalid',
    );
  });

  it('refuses an update naming another scope, and inherits the scope when it names none', async () => {
    const h = harness('2026-10-22T03:00:00.000Z');
    const root = await h.publish(incident('i-1', { ...usdtEth, phase: 'investigating' }));
    expect(
      await refusal(h.board.draft(AUTHOR, incident('i-2', { parentId: root.id, asset: 'USDT', network: 'tron', phase: 'identified' }))),
    ).toBe('notify.notice_scope_invalid');
    const same = await h.board.draft(AUTHOR, incident('i-3', { parentId: root.id, ...usdtEth, phase: 'identified' }));
    expect(same).toMatchObject(usdtEth);
    const inherited = await h.board.draft(AUTHOR, incident('i-4', { parentId: root.id, phase: 'identified' }));
    expect(inherited).toMatchObject(usdtEth);
  });

  it('refuses a phase that disagrees with the close flag, an unknown phase, and a phase with no scope', async () => {
    const h = harness('2026-10-22T03:00:00.000Z');
    const root = await h.publish(incident('c-1', { ...usdtEth, phase: 'investigating' }));
    expect(await refusal(h.board.draft(AUTHOR, incident('c-2', { parentId: root.id, phase: 'resolved' })))).toBe(
      'notify.notice_phase_invalid',
    );
    expect(await refusal(h.board.draft(AUTHOR, incident('c-3', { parentId: root.id, phase: 'monitoring', resolves: true })))).toBe(
      'notify.notice_phase_invalid',
    );
    expect(await refusal(h.board.draft(AUTHOR, incident('c-4', { ...usdtEth, phase: 'escalated' })))).toBe('notify.notice_phase_invalid');
    expect(await refusal(h.board.draft(AUTHOR, incident('c-5', { phase: 'investigating' })))).toBe('notify.notice_scope_invalid');
    expect(
      await refusal(
        h.board.draft(AUTHOR, { kind: 'maintenance', title: 'T', body: 'B', clientRequestId: 'c-6', ...usdtEth, phase: 'update' }),
      ),
    ).toBe('notify.notice_incident_fields_invalid');
  });

  it('publishes a scoped incident only on a second operator: the author alone is refused and nothing shows', async () => {
    class SameOperator implements NoticeApprovalConsumer {
      async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
        return { ...(await new Approvals().consume(input)), approverId: AUTHOR };
      }
    }
    const board = new NoticeBoard(
      new MemoryNoticeStore(),
      new SameOperator(),
      new MemoryCommandLog(),
      () => new Date('2026-10-22T03:00:00.000Z'),
    );
    const draft = await board.draft(AUTHOR, incident('so-1', { ...usdtEth, phase: 'investigating' }));
    expect(await refusal(board.publish(AUTHOR, { id: draft.id, clientRequestId: 'so-p', approvalId: 'so-a', operationId: 'so-o' }))).toBe(
      'notify.notice_publish_same_operator',
    );
    expect((await board.fundingNotices(usdtEth)).incidents).toEqual([]);
  });

  it('refuses a malformed scope on the read', async () => {
    const h = harness('2026-10-22T03:00:00.000Z');
    expect(await refusal(h.board.fundingNotices({ asset: '', network: 'ethereum' }))).toBe('notify.notice_scope_invalid');
    expect(await refusal(h.board.fundingNotices({ asset: 'USDT', network: '' }))).toBe('notify.notice_scope_invalid');
  });
});

describe('funding notices on the router', () => {
  it('is readable signed out, refuses a malformed scope, and says when notices are unwired', async () => {
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
      id: 'req-anon-funding',
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
    const caller = mod.createNotifyRouter(wired).createCaller(ctx);
    expect(await caller.notify.fundingNotices({ asset: 'USDT', network: 'ethereum' })).toEqual({
      asset: 'USDT',
      network: 'ethereum',
      incidents: [],
      maintenance: [],
    });
    await expect(caller.notify.fundingNotices({ asset: 'usdt', network: 'ethereum' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.notify.fundingNotices({ asset: 'USDT', network: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const unwired = new NotifyService(
      new MemoryNotifyStore(),
      { fanoutEnabled: true },
      { targets, deliveries, channels: registry, dispatcher },
    );
    await expect(
      mod.createNotifyRouter(unwired).createCaller(ctx).notify.fundingNotices({ asset: 'USDT', network: 'ethereum' }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'notify.notices_unavailable',
    });
  });
});
