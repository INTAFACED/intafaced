import { describe, expect, it } from 'vitest';
import { custodyApproverViewSchema, custodyTaskDetailSchema, custodyTaskViewSchema } from './custody-approval-tasks.js';

const task = {
  id: '11111111-1111-4111-8111-111111111111',
  clientRef: 'ref-1',
  kind: 'config',
  scope: 'policy',
  title: 'Publish policy',
  payload: { rule: 'two approvers' },
  payloadHash: 'a'.repeat(64),
  initiator: 'founder-1',
  requiredApprovals: 2,
  approvalCount: 1,
  approvedByMe: false,
  status: 'pending',
  failureCode: null,
  expiresAt: '2026-10-21T00:00:00Z',
  createdAt: '2026-10-20T00:00:00Z',
  decidedAt: null,
  executedAt: null,
};

describe('custody approval task views', () => {
  it('reads a task, a task with its timeline and an approver', () => {
    expect(custodyTaskViewSchema.parse(task)).toMatchObject({ status: 'pending', requiredApprovals: 2 });
    expect(
      custodyTaskDetailSchema.parse({ ...task, timeline: [{ kind: 'submitted', actor: 'founder-1', detail: {}, at: task.createdAt }] })
        .timeline,
    ).toHaveLength(1);
    expect(
      custodyApproverViewSchema.parse({ userId: 'u', label: 'Ops', role: 'keyless', active: true, setBy: 'owner', setAt: task.createdAt }),
    ).toMatchObject({ role: 'keyless' });
  });

  it('refuses a malformed fingerprint, an unknown status and a missing deadline', () => {
    expect(custodyTaskViewSchema.safeParse({ ...task, payloadHash: 'abc' }).success).toBe(false);
    expect(custodyTaskViewSchema.safeParse({ ...task, status: 'maybe' }).success).toBe(false);
    const { expiresAt: _gone, ...noDeadline } = task;
    expect(custodyTaskViewSchema.safeParse(noDeadline).success).toBe(false);
  });
});
