import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { ActionApprovalConsumeError, type ActionApprovalConsumer } from './action-approval-consume.js';

/** Test-only stand-in for identity's action approvals (SP-csat-02 dual control). */
export const FOUNDER = '99999999-0000-4000-8000-00000000f0f0';

type Issued = {
  readonly requesterId: string;
  readonly approverId: string;
  readonly targetId: string;
  readonly payloadHash: string;
  used: boolean;
};

const approval = (input: ActionApprovalConsumeInput, requesterId: string, approverId: string): ActionApproval => ({
  approvalId: input.approvalId,
  operationId: input.operationId,
  actionType: input.targetId,
  targetService: input.targetService,
  targetId: input.targetId,
  expectedVersion: input.expectedVersion,
  payloadHash: input.payloadHash,
  requesterId,
  approverId,
  policyVersion: 'v1',
  createdAt: '2026-10-22T04:00:00.000Z',
  expiresAt: '2026-10-22T04:10:00.000Z',
  status: 'CONSUMED',
});

/** Identity as a ledger: issue an approval for one action and payload; consume once, only for that action and payload. */
export class FakeIdentityApprovals implements ActionApprovalConsumer {
  private readonly issued = new Map<string, Issued>();
  private n = 0;
  issue(a: { requesterId: string; approverId: string; targetId: string; payloadHash: string }) {
    const approvalId = `apr-${++this.n}`;
    this.issued.set(approvalId, { ...a, used: false });
    return { approvalId, operationId: `op-${this.n}` };
  }
  async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    const row = this.issued.get(input.approvalId);
    if (!row) throw new ActionApprovalConsumeError('unknown approval', 'action_approval.consume_failed');
    if (row.used) throw new ActionApprovalConsumeError('approval already consumed', 'action_approval.consume_failed');
    if (row.targetId !== input.targetId || row.payloadHash !== input.payloadHash) {
      throw new ActionApprovalConsumeError('approval is for a different action', 'action_approval.consume_failed');
    }
    row.used = true;
    return approval(input, row.requesterId, row.approverId);
  }
}

/** A founder approves whatever the request names (for door tests about something else). */
export function founderApproves(approverId = FOUNDER): ActionApprovalConsumer {
  return { consume: async (input) => approval(input, 'requester', approverId) };
}

/** Adds approval ids to every `configureSurvey` call, for door tests about something else. */
export function withApprovalIds<T extends object>(caller: T): T {
  return new Proxy(caller, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop !== 'configureSurvey' || typeof v !== 'function') return v;
      return (input: object) => (v as (i: object) => unknown).call(target, { approvalId: 'apr-door', operationId: 'op-door', ...input });
    },
  });
}
