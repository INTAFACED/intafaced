import { describe, expect, it } from 'vitest';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { MemoryCommandLog } from '../preferences/account.js';
import { MemoryNoticeStore, NoticeBoard, type NoticeApprovalConsumer } from './board.js';

/**
 * Fee change notices (SP-fees-vip-04, J-cex-spot-10 #10): a `fee_change` notice names the one time a new trading fee
 * schedule version takes effect, is on the public board before that time, and changes no rate itself.
 */

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const EFFECTIVE = '2026-11-01T00:00:00.000Z';

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
      createdAt: '2026-10-20T00:00:00.000Z',
      expiresAt: '2026-10-20T23:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

const board = () =>
  new NoticeBoard(
    new MemoryNoticeStore(),
    new Approvals(),
    new MemoryCommandLog(),
    () => NOW,
    async () => [],
    async () => undefined,
    async () => new Set(),
    async () => null,
  );

const draft = (b: NoticeBoard, key: string, times: { startsAt?: string | null; endsAt?: string | null }) =>
  b.draft(AUTHOR, {
    kind: 'fee_change',
    title: `TEST fee change ${key}`,
    body: 'TEST: maker 0.06%, taker 0.09% from this time.',
    ...times,
    clientRequestId: `fee-${key}`,
  });

describe('fee change notices', () => {
  it('is on the public board before the time it takes effect, with that time', async () => {
    const b = board();
    const row = await draft(b, 'a', { startsAt: EFFECTIVE });
    await b.publish(AUTHOR, { id: row.id, clientRequestId: 'pub-a', approvalId: 'approval-a', operationId: 'o' });
    const listed = (await b.notices({ limit: 50 })).find((n) => n.id === row.id);
    expect(listed).toMatchObject({ kind: 'fee_change', status: 'published', startsAt: EFFECTIVE, endsAt: null });
    expect((await b.notices({ kind: 'fee_change', limit: 50 })).map((n) => n.id)).toEqual([row.id]);
    expect(await b.notice(row.id)).toMatchObject({ startsAt: EFFECTIVE });
  });

  it('needs the one time it takes effect, and no end', async () => {
    const b = board();
    await expect(draft(b, 'none', {})).rejects.toMatchObject({ code: 'notify.notice_effective_invalid' });
    await expect(draft(b, 'end', { startsAt: EFFECTIVE, endsAt: '2026-11-02T00:00:00.000Z' })).rejects.toMatchObject({
      code: 'notify.notice_effective_invalid',
    });
  });

  it('is approved with the time it takes effect: the same draft at another time is another payload', async () => {
    const store = new MemoryNoticeStore();
    const b = new NoticeBoard(
      store,
      new Approvals(),
      new MemoryCommandLog(),
      () => NOW,
      async () => [],
      async () => undefined,
      async () => new Set(),
      async () => null,
    );
    const row = await draft(b, 'h', { startsAt: EFFECTIVE });
    const before = (await b.publishProposal(row.id)).payloadHash;
    const stored = (await store.findById(row.id))!;
    stored.startsAt = new Date('2026-11-02T00:00:00.000Z');
    expect((await b.publishProposal(row.id)).payloadHash).not.toBe(before);
  });
});
