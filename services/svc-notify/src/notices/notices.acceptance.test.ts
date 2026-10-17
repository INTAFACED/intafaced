import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryDeliveryStore, MemoryTargetStore } from '../channel-store.js';
import { InAppChannel, UnconfiguredChannel } from '../channels/gateway.js';
import { ChannelRegistry } from '../channels/registry.js';
import { NotificationDispatcher } from '../dispatch.js';
import { NotifyService } from '../notify-service.js';
import { createNotifyRouter } from '../router.js';
import { MemoryNotifyStore } from '../store.js';
import { MemoryCommandLog } from '../preferences/account.js';
import { MemoryNoticeStore, NoticeBoard, type NoticeApprovalConsumer } from '../notices/board.js';

/**
 * Seam: the public notice reads and the operator draft/publish writes.
 * Titles in this file are the test's own strings. The service seeds none.
 */

const SECRET = 'notify-notices-acceptance-edge-secret-value';
const AUTHOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-notify' });

function signed(userId: string, scopes: string[]) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes,
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
    id: `req-${userId}-${scopes.join('.')}`,
  });
}

function anonymous() {
  return edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon-notice' });
}

class OnceApprovals implements NoticeApprovalConsumer {
  readonly consumed: string[] = [];
  constructor(private readonly approverId: string) {}
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    if (this.consumed.includes(input.approvalId)) throw new Error('already consumed');
    this.consumed.push(input.approvalId);
    return {
      approvalId: input.approvalId,
      actionType: 'notify.notice.publish',
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      requesterId: AUTHOR,
      approverId: this.approverId,
      policyVersion: 'v1',
      createdAt: '2026-10-17T00:00:00.000Z',
      expiresAt: '2026-10-17T01:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

function open(approvals: NoticeApprovalConsumer | null) {
  const registry = new ChannelRegistry([
    new InAppChannel(),
    new UnconfiguredChannel('email', ['NOTIFY_EMAIL_GATEWAY_URL', 'NOTIFY_EMAIL_GATEWAY_TOKEN']),
    new UnconfiguredChannel('push', ['NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN']),
    new UnconfiguredChannel('sms', ['NOTIFY_SMS_GATEWAY_URL', 'NOTIFY_SMS_GATEWAY_TOKEN']),
  ]);
  const targets = new MemoryTargetStore();
  const deliveries = new MemoryDeliveryStore();
  const notices = new NoticeBoard(new MemoryNoticeStore(), approvals, new MemoryCommandLog(), () => new Date('2026-10-17T12:00:00.000Z'));
  const notify = new NotifyService(
    new MemoryNotifyStore(),
    { fanoutEnabled: true },
    {
      targets,
      deliveries,
      channels: registry,
      dispatcher: new NotificationDispatcher(registry, targets, deliveries, { maxAttempts: 3, outOfAppEnabled: false }),
      notices,
    },
  );
  const router = createNotifyRouter(notify);
  return {
    anon: router.createCaller(anonymous()),
    author: router.createCaller(signed(AUTHOR, ['admin:write', 'notify:read'])),
    member: router.createCaller(signed(AUTHOR, ['notify:read', 'notify:write'])),
  };
}

describe('public notices', () => {
  it('shows nothing until a different operator publishes, and keeps the id', async () => {
    const unwired = open(null);
    await expect(unwired.anon.notify.announcement()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'A public announcement is refused. The missing piece is content.',
    });
    expect(await unwired.anon.notify.notices({ limit: 20 })).toEqual([]);
    expect(await unwired.anon.notify.noticeStatus()).toEqual({ incidents: [], maintenance: [] });
    await expect(
      unwired.member.notify.draftNotice({
        kind: 'announcement',
        title: 'Test title',
        body: 'Test body',
        clientRequestId: 'draft-denied',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const draft = await unwired.author.notify.draftNotice({
      kind: 'announcement',
      title: 'Test title',
      body: 'Test body',
      clientRequestId: 'draft-1',
    });
    const replay = await unwired.author.notify.draftNotice({
      kind: 'announcement',
      title: 'Different title',
      body: 'Different body',
      clientRequestId: 'draft-1',
    });
    expect(replay).toMatchObject({ id: draft.id, title: 'Test title', status: 'draft' });
    expect(await unwired.anon.notify.notices({ limit: 20 })).toEqual([]);
    await expect(unwired.anon.notify.notice({ id: draft.id })).rejects.toMatchObject({ message: 'notify.notice_not_found' });
    await expect(
      unwired.author.notify.publishNotice({
        id: draft.id,
        clientRequestId: 'publish-unwired',
        approvalId: 'approval-unwired',
        operationId: 'op-unwired',
      }),
    ).rejects.toMatchObject({ message: 'notify.notice_publish_approval_unavailable' });
    expect(await unwired.anon.notify.notices({ limit: 20 })).toEqual([]);

    const same = open(new OnceApprovals(AUTHOR));
    const maintenance = await same.author.notify.draftNotice({
      kind: 'maintenance',
      title: 'Test maintenance',
      body: 'Test maintenance body',
      startsAt: '2026-10-17T00:00:00.000Z',
      endsAt: '2026-10-18T00:00:00.000Z',
      clientRequestId: 'draft-maint',
    });
    await expect(
      same.author.notify.publishNotice({
        id: maintenance.id,
        clientRequestId: 'publish-same',
        approvalId: 'approval-same',
        operationId: 'op-same',
      }),
    ).rejects.toMatchObject({ message: 'notify.notice_publish_same_operator' });
    expect(await same.anon.notify.notices({ limit: 20 })).toEqual([]);
    expect(await same.anon.notify.noticeStatus()).toEqual({ incidents: [], maintenance: [] });

    const approvals = new OnceApprovals(APPROVER);
    const board = open(approvals);
    const incident = await board.author.notify.draftNotice({
      kind: 'incident',
      title: 'Test incident',
      body: 'Test incident body',
      clientRequestId: 'draft-incident',
    });
    const published = await board.author.notify.publishNotice({
      id: incident.id,
      clientRequestId: 'publish-1',
      approvalId: 'approval-1',
      operationId: 'op-1',
    });
    expect(published.id).toBe(incident.id);
    expect(published.status).toBe('published');
    const again = await board.author.notify.publishNotice({
      id: incident.id,
      clientRequestId: 'publish-1',
      approvalId: 'approval-unused',
      operationId: 'op-unused',
    });
    expect(again.id).toBe(published.id);
    expect(approvals.consumed).toEqual(['approval-1']);

    const changelog = await board.author.notify.draftNotice({
      kind: 'changelog',
      title: 'Test changelog',
      body: 'Test changelog body',
      clientRequestId: 'draft-log',
    });
    await expect(
      board.author.notify.publishNotice({
        id: changelog.id,
        clientRequestId: 'publish-2',
        approvalId: 'approval-1',
        operationId: 'op-2',
      }),
    ).rejects.toMatchObject({ message: 'notify.notice_approval_spent' });
    await expect(board.anon.notify.notice({ id: changelog.id })).rejects.toMatchObject({ message: 'notify.notice_not_found' });

    expect(await board.anon.notify.notices({ limit: 20 })).toEqual([expect.objectContaining({ id: published.id, status: 'published' })]);
    expect(await board.anon.notify.noticeStatus()).toEqual({
      incidents: [expect.objectContaining({ id: published.id })],
      maintenance: [],
    });
    await expect(board.anon.notify.announcement()).rejects.toMatchObject({
      message: 'A public announcement is refused. The missing piece is content.',
    });

    const announcement = await board.author.notify.draftNotice({
      kind: 'announcement',
      title: 'Test announcement',
      body: 'Test announcement body',
      clientRequestId: 'draft-announcement',
    });
    const live = await board.author.notify.publishNotice({
      id: announcement.id,
      clientRequestId: 'publish-announcement',
      approvalId: 'approval-2',
      operationId: 'op-announcement',
    });
    expect(live.id).toBe(announcement.id);
    expect(await board.anon.notify.announcement()).toMatchObject({ id: live.id, kind: 'announcement', title: 'Test announcement' });
    expect(approvals.consumed).toEqual(['approval-1', 'approval-2']);
  });
});
