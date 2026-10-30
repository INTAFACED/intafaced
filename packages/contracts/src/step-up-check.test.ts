import { describe, expect, it, vi } from 'vitest';
import { ACTION_APPROVAL_CONSUME_FAILED } from './action-approval-client.js';
import { samePersonTargetService, type ActionApproval, type ActionApprovalConsumeInput } from './action-approval.js';
import { bindCustomerStepUp } from './customer-step-up.js';
import { StepUpCheckError, createStepUpCheck, type StepUpCheckRequest } from './step-up-check.js';

const SCOPE = 'trade.step_up.bots.grid.withdrawProfit' as const;
const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = 'sid-1';
const APPROVAL = 'appr-1';
const FIELDS = { botId: '5a5a5a5a-0000-5000-8000-000000000001', requestId: 'req-1', asset: 'USDT', amount: '1.25' };

const request = (over: Partial<StepUpCheckRequest> = {}): StepUpCheckRequest => ({
  scope: SCOPE,
  userId: USER,
  sessionId: SESSION,
  approvalId: APPROVAL,
  fields: FIELDS,
  requestId: `bots.grid.withdraw:${FIELDS.botId}:${FIELDS.requestId}`,
  ...over,
});

/** Identity's answer to a consume it accepts: the row its begin and verify minted (customer-step-up in svc-identity). */
const consumedRow = (input: ActionApprovalConsumeInput, over: Partial<ActionApproval> = {}): ActionApproval => ({
  approvalId: input.approvalId,
  actionType: SCOPE,
  targetService: input.targetService,
  targetId: input.targetId,
  expectedVersion: input.expectedVersion,
  payloadHash: input.payloadHash,
  requesterId: USER,
  approverId: USER,
  policyVersion: 'step-up-v1',
  createdAt: '2026-10-29T12:00:00.000Z',
  expiresAt: '2026-10-29T12:05:00.000Z',
  status: 'CONSUMED',
  operationId: input.operationId,
  kind: 'same_person',
  consumedAt: '2026-10-29T12:01:00.000Z',
  ...over,
});

const accepting = (over: Partial<ActionApproval> = {}) => {
  const consume = vi.fn(async (input: ActionApprovalConsumeInput) => consumedRow(input, over));
  return { consume };
};

const codeOf = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StepUpCheckError);
  return (err as StepUpCheckError).code;
};

describe('identity step-up check (CB-bots-05)', () => {
  it('the grid withdrawal scope is spent by svc-trade, not a bank door', () => {
    expect(samePersonTargetService(SCOPE)).toBe('svc-trade');
  });

  it('consumes the approval with the same hash identity bound at begin, once, under the business request id', async () => {
    const approvals = accepting();
    const check = createStepUpCheck({ service: 'svc-trade', approvals });
    const result = await check.require(request());
    expect(result).toEqual({ stepUpEventId: APPROVAL, consumedAt: '2026-10-29T12:01:00.000Z', replayed: false });
    const begun = bindCustomerStepUp(USER, {
      scope: SCOPE,
      purpose: 'bots.grid.withdrawProfit',
      amount: '1.25',
      target: FIELDS.botId,
      fields: FIELDS,
    });
    expect(begun.ok).toBe(true);
    expect(approvals.consume).toHaveBeenCalledTimes(1);
    expect(approvals.consume).toHaveBeenCalledWith({
      approvalId: APPROVAL,
      operationId: APPROVAL,
      payloadHash: begun.ok ? begun.payloadHash : '',
      targetService: 'svc-trade',
      targetId: SCOPE,
      expectedVersion: '1',
      principalUserId: USER,
      principalSessionId: SESSION,
      requestId: `bots.grid.withdraw:${FIELDS.botId}:${FIELDS.requestId}`,
    });
  });

  it('identity answering a retry of the same request id is a replay, so the caller never applies it twice', async () => {
    const check = createStepUpCheck({ service: 'svc-trade', approvals: accepting({ consumption: 'already_consumed_by_this_request' }) });
    expect((await check.require(request())).replayed).toBe(true);
  });

  it('an over-long approval id is step_up_required; an over-long request id is the caller’s bug, and identity is not asked', async () => {
    const approvals = accepting();
    const check = createStepUpCheck({ service: 'svc-trade', approvals });
    expect(await codeOf(check.require(request({ approvalId: 'a'.repeat(129) })))).toBe('identity.step_up_required');
    await expect(check.require(request({ requestId: 'r'.repeat(129) }))).rejects.toThrow(/request id must be 1 to 128/);
    expect(approvals.consume).not.toHaveBeenCalled();
  });

  it('no approval sent is step_up_required, and identity is not asked', async () => {
    const approvals = accepting();
    const check = createStepUpCheck({ service: 'svc-trade', approvals });
    for (const approvalId of [undefined, null, '', '   ']) {
      expect(await codeOf(check.require(request({ approvalId })))).toBe('identity.step_up_required');
    }
    expect(approvals.consume).not.toHaveBeenCalled();
  });

  it('a refusal identity answered (spent, expired, other details) is step_up_required', async () => {
    for (const tag of [
      'action_approval.consumed',
      'action_approval.expired',
      'action_approval.payload_mismatch',
      'action_approval.not_requester',
    ]) {
      const fail = Object.assign(new Error(`identity refused consume (400) consume refused [${tag}]`), {
        code: ACTION_APPROVAL_CONSUME_FAILED,
      });
      const check = createStepUpCheck({ service: 'svc-trade', approvals: { consume: vi.fn().mockRejectedValue(fail) } });
      expect(await codeOf(check.require(request()))).toBe('identity.step_up_required');
    }
  });

  it('identity unwired, unreachable or unreadable is step_up_unavailable, never a pass', async () => {
    expect(await codeOf(createStepUpCheck({ service: 'svc-trade', approvals: null }).require(request()))).toBe(
      'identity.step_up_unavailable',
    );
    const failures = [
      new TypeError('fetch failed'),
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
      Object.assign(new Error('identity refused consume (502)'), { code: ACTION_APPROVAL_CONSUME_FAILED }),
      Object.assign(new Error('identity consume result is not JSON'), { code: ACTION_APPROVAL_CONSUME_FAILED }),
      // A 5xx is identity failing, even when it carries a tag (founders_unavailable is a 503).
      Object.assign(new Error('identity refused consume (503) [action_approval.founders_unavailable]'), {
        code: ACTION_APPROVAL_CONSUME_FAILED,
      }),
    ];
    for (const failure of failures) {
      const check = createStepUpCheck({ service: 'svc-trade', approvals: { consume: vi.fn().mockRejectedValue(failure) } });
      expect(await codeOf(check.require(request()))).toBe('identity.step_up_unavailable');
    }
  });

  it('an answer that is not this person’s same-person approval of this scope is step_up_required', async () => {
    const wrong: Partial<ActionApproval>[] = [
      { kind: 'four_eyes' },
      { kind: undefined },
      { status: 'APPROVED' },
      { requesterId: 'someone-else' },
      { approverId: 'someone-else' },
      { actionType: 'bank.step_up.ramps.offramp' },
    ];
    for (const over of wrong) {
      const check = createStepUpCheck({ service: 'svc-trade', approvals: accepting(over) });
      expect(await codeOf(check.require(request()))).toBe('identity.step_up_required');
    }
  });

  it('a caller that is not the scope’s service, or fields that are not the door’s, never reach identity', async () => {
    const approvals = accepting();
    expect(await codeOf(createStepUpCheck({ service: 'svc-bank', approvals }).require(request()))).toBe('identity.step_up_unavailable');
    const check = createStepUpCheck({ service: 'svc-trade', approvals });
    const { amount: _amount, ...missing } = FIELDS;
    for (const fields of [missing, { ...FIELDS, actor: USER }, { ...FIELDS, extra: 'x' }]) {
      expect(await codeOf(check.require(request({ fields })))).toBe('identity.step_up_unavailable');
    }
    expect(approvals.consume).not.toHaveBeenCalled();
  });

  it('a different amount hashes differently, so identity is asked with a hash it never bound for it', async () => {
    const approvals = accepting();
    const check = createStepUpCheck({ service: 'svc-trade', approvals });
    await check.require(request());
    await check.require(request({ fields: { ...FIELDS, amount: '1.26' } }));
    const [first, second] = approvals.consume.mock.calls.map(([input]) => input.payloadHash);
    expect(first).not.toBe(second);
  });
});
