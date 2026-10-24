import { describe, expect, it } from 'vitest';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { MemoryCommandLog } from '../preferences/account.js';
import { MemoryNoticeStore, NoticeBoard, type NoticeApprovalConsumer } from '../notices/board.js';
import { MemoryPostmortemStore, POSTMORTEM_PUBLISH_ACTION, Postmortems, type IncidentState } from './postmortems.js';

/** Incident postmortems (SP-status-02): only on a resolved incident, versioned drafts, a second founder's approval to publish. */

const AUTHOR = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';
const INCIDENT = '33333333-3333-4333-8333-333333333333';

/** Consumes like identity does: once, and only for the hash, target and version the approval was asked with. */
class BoundApprovals implements NoticeApprovalConsumer {
  readonly proposed = new Map<string, { hash: string; target: string; version: string }>();
  readonly spent = new Set<string>();
  readonly inputs: ActionApprovalConsumeInput[] = [];
  approver = APPROVER;
  actionType = POSTMORTEM_PUBLISH_ACTION;
  failure: Error | null = null;
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    this.inputs.push(input);
    if (this.failure) throw this.failure;
    const bound = this.proposed.get(input.approvalId);
    if (!bound || bound.hash !== input.payloadHash || bound.target !== input.targetId || bound.version !== input.expectedVersion)
      throw new Error('identity refused consume (409) action_approval.payload_mismatch');
    if (this.spent.has(input.approvalId)) throw new Error('identity refused consume (409) action_approval.consumed');
    this.spent.add(input.approvalId);
    return {
      approvalId: input.approvalId,
      actionType: this.actionType,
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      requesterId: AUTHOR,
      approverId: this.approver,
      policyVersion: 'v1',
      createdAt: '2026-10-23T00:00:00.000Z',
      expiresAt: '2026-10-23T23:00:00.000Z',
      status: 'CONSUMED',
      operationId: input.operationId,
    };
  }
}

function desk(state: IncidentState = 'resolved') {
  const approvals = new BoundApprovals();
  const incident = { state };
  let t = Date.parse('2026-10-23T12:00:00.000Z');
  const postmortems = new Postmortems(
    new MemoryPostmortemStore(),
    async (id) => (id === INCIDENT ? incident.state : 'unknown'),
    approvals,
    () => new Date((t += 1000)),
  );
  /** Asks for the approval bound to the current proposal, as the console does. */
  const approve = async (approvalId: string) => {
    const proposal = await postmortems.proposal(INCIDENT);
    approvals.proposed.set(approvalId, { hash: proposal.payloadHash, target: proposal.targetId, version: proposal.expectedVersion });
  };
  return { postmortems, approvals, incident, approve };
}

describe('incident postmortems', () => {
  it('refuses a postmortem on an incident that is still open, and on one that is not a published incident', async () => {
    const { postmortems, incident } = desk('open');
    await expect(postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST what happened', expectedVersion: 0 })).rejects.toMatchObject(
      {
        code: 'status.postmortem_requires_resolved',
      },
    );
    expect(await postmortems.get(INCIDENT)).toBeNull();
    await expect(
      postmortems.write(AUTHOR, { incidentId: '44444444-4444-4444-8444-444444444444', body: 'TEST', expectedVersion: 0 }),
    ).rejects.toMatchObject({ code: 'status.postmortem_incident_unknown' });
    incident.state = 'resolved';
    expect(await postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST what happened', expectedVersion: 0 })).toMatchObject({
      version: 1,
      status: 'draft',
      writtenBy: AUTHOR,
    });
  });

  it('a draft moves by version; the same words sent again are a replay; a stale edit is refused', async () => {
    const { postmortems } = desk();
    await postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST first', expectedVersion: 0 });
    expect(await postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST first', expectedVersion: 0 })).toMatchObject({ version: 1 });
    expect(await postmortems.write(APPROVER, { incidentId: INCIDENT, body: 'TEST second', expectedVersion: 1 })).toMatchObject({
      version: 2,
      body: 'TEST second',
      writtenBy: APPROVER,
    });
    await expect(postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST other', expectedVersion: 1 })).rejects.toMatchObject({
      code: 'status.postmortem_version_stale',
    });
    await expect(postmortems.write(AUTHOR, { incidentId: INCIDENT, body: '   ', expectedVersion: 2 })).rejects.toMatchObject({
      code: 'status.postmortem_invalid',
    });
  });

  it('publishes with a second founder approval once; the published postmortem is never edited', async () => {
    const { postmortems, approve } = desk();
    await postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST what happened', expectedVersion: 0 });
    expect(await postmortems.published(10)).toEqual([]);
    await approve('appr-1');
    const published = await postmortems.publish(AUTHOR, { incidentId: INCIDENT, approvalId: 'appr-1', operationId: 'op-1' });
    expect(published).toMatchObject({ status: 'published', version: 1, publishedAt: expect.any(String) });
    // The same approval sent again answers the published postmortem, publishes nothing new.
    expect(await postmortems.publish(AUTHOR, { incidentId: INCIDENT, approvalId: 'appr-1', operationId: 'op-1' })).toEqual(published);
    expect(await postmortems.published(10)).toEqual([published]);
    await expect(postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST changed', expectedVersion: 1 })).rejects.toMatchObject({
      code: 'status.postmortem_published',
    });
    await expect(postmortems.proposal(INCIDENT)).rejects.toMatchObject({ code: 'status.postmortem_published' });
  });

  it('the approver cannot publish, and that refusal spends the approval', async () => {
    const { postmortems, approve } = desk();
    await postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST what happened', expectedVersion: 0 });
    await approve('appr-1');
    await expect(postmortems.publish(APPROVER, { incidentId: INCIDENT, approvalId: 'appr-1', operationId: 'op-1' })).rejects.toMatchObject({
      code: 'status.postmortem_publish_same_operator',
    });
    await expect(postmortems.publish(AUTHOR, { incidentId: INCIDENT, approvalId: 'appr-1', operationId: 'op-2' })).rejects.toMatchObject({
      code: 'status.postmortem_publish_same_operator',
    });
    expect(await postmortems.get(INCIDENT)).toMatchObject({ status: 'draft' });
  });

  it('an approval asked for an earlier version does not publish an edited draft', async () => {
    const { postmortems, approve } = desk();
    await postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST first', expectedVersion: 0 });
    await approve('appr-1');
    await postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST edited', expectedVersion: 1 });
    await expect(postmortems.publish(AUTHOR, { incidentId: INCIDENT, approvalId: 'appr-1', operationId: 'op-1' })).rejects.toMatchObject({
      code: 'status.postmortem_approval_spent',
    });
    expect(await postmortems.get(INCIDENT)).toMatchObject({ status: 'draft', version: 2 });
  });

  it('the consume names a request id and the publisher, so identity can answer a retry after a lost reply', async () => {
    const { postmortems, approvals, approve } = desk();
    await postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST', expectedVersion: 0 });
    await approve('appr-1');
    await postmortems.publish(AUTHOR, { incidentId: INCIDENT, approvalId: 'appr-1', operationId: 'op-1' });
    expect(approvals.inputs[0]).toMatchObject({ requestId: 'postmortem-publish:appr-1', consumerPrincipalId: AUTHOR });
  });

  it('identity not answering leaves the approval usable; identity refusing spends nothing here either', async () => {
    const { postmortems, approvals, approve } = desk();
    await postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST', expectedVersion: 0 });
    await approve('appr-1');
    approvals.failure = new Error('identity refused consume (503) unavailable');
    await expect(postmortems.publish(AUTHOR, { incidentId: INCIDENT, approvalId: 'appr-1', operationId: 'op-1' })).rejects.toMatchObject({
      code: 'status.postmortem_approval_unreachable',
    });
    approvals.failure = new Error('The operation was aborted due to timeout');
    await expect(postmortems.publish(AUTHOR, { incidentId: INCIDENT, approvalId: 'appr-1', operationId: 'op-1' })).rejects.toMatchObject({
      code: 'status.postmortem_approval_unreachable',
    });
    approvals.failure = null;
    expect(await postmortems.publish(AUTHOR, { incidentId: INCIDENT, approvalId: 'appr-1', operationId: 'op-1' })).toMatchObject({
      status: 'published',
    });
  });

  it('an approval asked for another action is spent and publishes nothing', async () => {
    const { postmortems, approvals, approve } = desk();
    await postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST', expectedVersion: 0 });
    await approve('appr-1');
    approvals.actionType = 'notify.notice.publish' as typeof POSTMORTEM_PUBLISH_ACTION;
    await expect(postmortems.publish(AUTHOR, { incidentId: INCIDENT, approvalId: 'appr-1', operationId: 'op-1' })).rejects.toMatchObject({
      code: 'status.postmortem_approval_spent',
    });
    expect(await postmortems.get(INCIDENT)).toMatchObject({ status: 'draft' });
  });

  it('a spent approval is a replay only for the founder who published with it, on that incident', async () => {
    const { postmortems, approve } = desk();
    await postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST', expectedVersion: 0 });
    await approve('appr-1');
    await postmortems.publish(AUTHOR, { incidentId: INCIDENT, approvalId: 'appr-1', operationId: 'op-1' });
    await expect(postmortems.publish(APPROVER, { incidentId: INCIDENT, approvalId: 'appr-1', operationId: 'op-1' })).rejects.toMatchObject({
      code: 'status.postmortem_approval_spent',
    });
    expect((await postmortems.forIncidents([INCIDENT, INCIDENT, 'other'])).map((p) => p.incidentId)).toEqual([INCIDENT]);
    expect(await postmortems.forIncidents([])).toEqual([]);
  });

  it('with no approval service wired, publishing refuses and nothing is published', async () => {
    const postmortems = new Postmortems(new MemoryPostmortemStore(), async () => 'resolved', null);
    await postmortems.write(AUTHOR, { incidentId: INCIDENT, body: 'TEST', expectedVersion: 0 });
    await expect(postmortems.publish(AUTHOR, { incidentId: INCIDENT, approvalId: 'a', operationId: 'o' })).rejects.toMatchObject({
      code: 'status.postmortem_approval_unavailable',
    });
    await expect(postmortems.publish(AUTHOR, { incidentId: 'missing', approvalId: 'a', operationId: 'o' })).rejects.toMatchObject({
      code: 'status.postmortem_not_found',
    });
  });
});

describe('incident state from the notice board', () => {
  it('is unknown for drafts and non-incidents, open until a published entry resolves it, then resolved', async () => {
    const approvals = new BoundApprovals();
    const consumer: NoticeApprovalConsumer = {
      consume: async (input) => ({ ...(await approvals.consume({ ...input })), actionType: 'notify.notice.publish' }),
    };
    let t = Date.parse('2026-10-23T12:00:00.000Z');
    const board = new NoticeBoard(
      new MemoryNoticeStore(),
      consumer,
      new MemoryCommandLog(),
      () => new Date((t += 1000)),
      async () => ['api'],
    );
    let n = 0;
    const publish = async (input: Parameters<NoticeBoard['draft']>[1]) => {
      n += 1;
      const draft = await board.draft(AUTHOR, input);
      const p = await board.publishProposal(draft.id);
      approvals.proposed.set(`appr-${n}`, { hash: p.payloadHash, target: p.targetId, version: p.expectedVersion });
      return board.publish(AUTHOR, { id: draft.id, clientRequestId: `pub-${n}`, approvalId: `appr-${n}`, operationId: `op-${n}` });
    };
    const incident = { kind: 'incident', title: 'TEST API errors', body: 'TEST investigating', impact: 'major', components: ['api'] };
    const draft = await board.draft(AUTHOR, { ...incident, clientRequestId: 'draft' });
    expect(await board.incidentState(draft.id)).toBe('unknown');
    const root = await publish({ ...incident, clientRequestId: 'root' });
    expect(await board.incidentState(root.id)).toBe('open');
    const resolution = await publish({
      kind: 'incident',
      title: 'TEST',
      body: 'TEST resolved',
      parentId: root.id,
      resolves: true,
      clientRequestId: 'resolve',
    });
    expect(await board.incidentState(root.id)).toBe('resolved');
    // An update is not the incident: its postmortem goes on the first entry.
    expect(await board.incidentState(resolution.id)).toBe('unknown');
  });
});
