import { describe, expect, it } from 'vitest';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { MemoryCommandLog } from '../preferences/account.js';
import { MemoryNoticeStore, NoticeBoard, type NoticeApprovalConsumer } from './board.js';

/** The founders' incident desk on the notice board: drafts listed, the publish proposal, and a resolved incident is final. */

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';

/** Consumes like identity does: refuses a payload hash other than the one the approval was proposed with. */
class BoundApprovals implements NoticeApprovalConsumer {
  readonly proposed = new Map<string, string>();
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    if (this.proposed.get(input.approvalId) !== input.payloadHash) throw new Error('action_approval.payload_mismatch');
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
      createdAt: '2026-10-23T00:00:00.000Z',
      expiresAt: '2026-10-23T23:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

function desk() {
  const approvals = new BoundApprovals();
  let t = Date.parse('2026-10-23T12:00:00.000Z');
  const board = new NoticeBoard(
    new MemoryNoticeStore(),
    approvals,
    new MemoryCommandLog(),
    () => new Date((t += 1000)),
    async () => ['api'],
  );
  let n = 0;
  /** Draft, ask for the approval bound to the proposal, publish as the author. */
  const publish = async (input: Parameters<NoticeBoard['draft']>[1]) => {
    n += 1;
    const draft = await board.draft(AUTHOR, input);
    const proposal = await board.publishProposal(draft.id);
    approvals.proposed.set(`appr-${n}`, proposal.payloadHash);
    return board.publish(AUTHOR, { id: draft.id, clientRequestId: `pub-${n}`, approvalId: `appr-${n}`, operationId: `op-${n}` });
  };
  return { board, publish };
}

const incident = { kind: 'incident', title: 'TEST API errors', body: 'TEST investigating', impact: 'major', components: ['api'] };

describe('incident desk on the notice board', () => {
  it('lists drafts with their incident fields and author; the public read does not', async () => {
    const { board } = desk();
    const draft = await board.draft(AUTHOR, { ...incident, clientRequestId: 'd-1' });
    const rows = await board.operatorNotices({ limit: 10 });
    expect(rows).toEqual([
      expect.objectContaining({ id: draft.id, status: 'draft', impact: 'major', components: ['api'], parentId: null, authorId: AUTHOR }),
    ]);
    expect(await board.notices({ limit: 10 })).toEqual([]);
  });

  it('the proposal is exactly what publish spends; a published notice has none', async () => {
    const { board, publish } = desk();
    const published = await publish({ ...incident, clientRequestId: 'd-1' });
    expect(published.status).toBe('published');
    await expect(board.publishProposal(published.id)).rejects.toMatchObject({ code: 'notify.notice_published_immutable' });
    const draft = await board.draft(AUTHOR, { ...incident, clientRequestId: 'd-2' });
    expect(await board.publishProposal(draft.id)).toMatchObject({
      actionType: 'notify.notice.publish',
      targetService: 'svc-notify',
      targetId: draft.id,
      expectedVersion: '1',
      payloadHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it('a resolved incident is final: no further update is drafted or published, a recurrence is a new incident', async () => {
    const { board, publish } = desk();
    const root = await publish({ ...incident, clientRequestId: 'root' });
    // An update drafted while open, left unpublished.
    const late = await board.draft(AUTHOR, {
      kind: 'incident',
      title: 'TEST',
      body: 'TEST still looking',
      parentId: root.id,
      clientRequestId: 'late',
    });
    await publish({
      kind: 'incident',
      title: 'TEST',
      body: 'TEST resolved',
      parentId: root.id,
      resolves: true,
      clientRequestId: 'resolve',
    });
    expect((await board.noticeStatus()).incidents).toEqual([]);
    await expect(
      board.draft(AUTHOR, { kind: 'incident', title: 'TEST', body: 'TEST again', parentId: root.id, clientRequestId: 'after' }),
    ).rejects.toMatchObject({ code: 'notify.notice_incident_resolved' });
    await expect(
      board.publish(AUTHOR, { id: late.id, clientRequestId: 'pub-late', approvalId: 'x', operationId: 'y' }),
    ).rejects.toMatchObject({
      code: 'notify.notice_incident_resolved',
    });
    const recurrence = await publish({ ...incident, clientRequestId: 'recurrence' });
    expect((await board.noticeStatus()).incidents.map((i) => i.id)).toEqual([recurrence.id]);
  });
});
