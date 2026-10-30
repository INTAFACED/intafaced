/**
 * OPS-change-control-01 CR-1 at the doors: a governed type's audience comes from its owner policy row; a caller outside
 * it is `action_approval.audience_mismatch`; a blank row refuses `action_approval.policy_unset` before anything is
 * written; the policy read is for founders and operators only.
 */
import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createActionApprovalRouter } from './action-approval-router.js';
import { staticFounderDirectory } from './auth/action-approval-audience.js';
import { approvalPolicySource } from './auth/action-approval-policy.js';
import { ActionApprovalService } from './auth/action-approval-service.js';
import { MemoryActionApprovalStore } from './auth/action-approval-store.js';

const authConfig = {
  secret: 'an-identity-action-approval-policy-router-test-secret',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const FOUNDER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOUNDER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATOR_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUPPORT_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const USER_E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SESSION = '44444444-4444-4444-8444-444444444444';

const reverse = {
  actionType: 'ops.ledger.reverse',
  targetService: 'svc-ops',
  targetId: 'reverse:tx-1',
  expectedVersion: '1',
  payloadHash: 'sha256:rev',
  policyVersion: 'desk-v1',
};

const policy = (over: Record<string, string> = {}) =>
  JSON.stringify({
    'ops.ledger.reverse': { requiredApprovals: '2', approverAudience: 'operator', applier: 'svc-ops', maxAgeSeconds: '600', ...over },
  });

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-policy' };
}

const service = (name: string): Context => ({ principal: null, service: name, region: 'DE', requestId: 'req-policy' });

function rig(raw: { value: string | undefined }) {
  const store = new MemoryActionApprovalStore();
  const svc = new ActionApprovalService(store, {
    ttlSeconds: 600,
    founders: staticFounderDirectory([FOUNDER_A, FOUNDER_B]),
    policies: approvalPolicySource(() => raw.value),
  });
  return { store, r: createActionApprovalRouter(svc) };
}

const OPERATOR = ['identity:write', 'admin:write'];
const SUPPORT = ['identity:write', 'support:ops'];
const PLAIN = ['identity:read', 'identity:write'];

describe('governed action types at the router', () => {
  it('a blank policy refuses propose with policy_unset and writes nothing', async () => {
    const { store, r } = rig({ value: undefined });
    const caller = r.createCaller(await ctx(OPERATOR_C, OPERATOR));
    await expect(caller.actionApproval.propose(reverse)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('[action_approval.policy_unset]'),
    });
    expect(await store.listByRequester(OPERATOR_C, 10)).toEqual([]);
  });

  it('two operators then a third: PENDING after one, APPROVED after two, consumed by the applier only', async () => {
    const { r } = rig({ value: policy() });
    const maker = r.createCaller(await ctx(OPERATOR_C, OPERATOR));
    const p = await maker.actionApproval.propose(reverse);
    const first = await r.createCaller(await ctx(FOUNDER_A, OPERATOR)).actionApproval.approve({
      approvalId: p.approvalId,
      expectedPayloadHash: p.payloadHash,
    });
    expect(first).toMatchObject({ status: 'PENDING', approvalsGiven: 1, approvalsRequired: 2 });
    const input = {
      approvalId: p.approvalId,
      operationId: p.operationId,
      payloadHash: p.payloadHash,
      targetService: 'svc-ops',
      targetId: p.targetId,
      expectedVersion: p.expectedVersion,
    };
    await expect(r.createCaller(service('svc-ops')).actionApproval.consume(input)).rejects.toMatchObject({
      message: expect.stringContaining('[action_approval.not_approved]'),
    });
    await r.createCaller(await ctx(SUPPORT_D, SUPPORT)).actionApproval.approve({
      approvalId: p.approvalId,
      expectedPayloadHash: p.payloadHash,
    });
    await expect(
      r.createCaller(service('svc-ledger')).actionApproval.consume({ ...input, targetService: 'svc-ledger' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('[action_approval.service_mismatch]') });
    expect((await r.createCaller(service('svc-ops')).actionApproval.consume(input)).status).toBe('CONSUMED');
  });

  it('the author approving is same_person; the same approver twice is already_approved', async () => {
    const { r } = rig({ value: policy() });
    const maker = r.createCaller(await ctx(OPERATOR_C, OPERATOR));
    const p = await maker.actionApproval.propose(reverse);
    await expect(maker.actionApproval.approve({ approvalId: p.approvalId, expectedPayloadHash: p.payloadHash })).rejects.toMatchObject({
      message: expect.stringContaining('[action_approval.same_person]'),
    });
    const checker = r.createCaller(await ctx(FOUNDER_A, OPERATOR));
    await checker.actionApproval.approve({ approvalId: p.approvalId, expectedPayloadHash: p.payloadHash });
    await expect(checker.actionApproval.approve({ approvalId: p.approvalId, expectedPayloadHash: p.payloadHash })).rejects.toMatchObject({
      message: expect.stringContaining('[action_approval.already_approved]'),
    });
  });

  it('a caller outside the policy audience is audience_mismatch at propose, approve and reject', async () => {
    // Founder audience: an operator who is not a founder may not propose or approve.
    const founderOnly = rig({ value: policy({ approverAudience: 'founder' }) });
    await expect(
      founderOnly.r.createCaller(await ctx(OPERATOR_C, OPERATOR)).actionApproval.propose(reverse),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('[action_approval.audience_mismatch]') });
    const p = await founderOnly.r.createCaller(await ctx(FOUNDER_A, OPERATOR)).actionApproval.propose(reverse);
    const operator = founderOnly.r.createCaller(await ctx(OPERATOR_C, OPERATOR));
    await expect(operator.actionApproval.approve({ approvalId: p.approvalId, expectedPayloadHash: p.payloadHash })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('[action_approval.audience_mismatch]'),
    });
    await expect(operator.actionApproval.reject({ approvalId: p.approvalId })).rejects.toMatchObject({
      message: expect.stringContaining('[action_approval.audience_mismatch]'),
    });

    // Trade-ops audience: a support operator does not hold the trade-ops permission.
    const tradeOps = rig({ value: policy({ approverAudience: 'trade_ops' }) });
    const q = await tradeOps.r.createCaller(await ctx(OPERATOR_C, OPERATOR)).actionApproval.propose(reverse);
    await expect(
      tradeOps.r.createCaller(await ctx(SUPPORT_D, SUPPORT)).actionApproval.approve({ approvalId: q.approvalId, expectedPayloadHash: q.payloadHash }),
    ).rejects.toMatchObject({ message: expect.stringContaining('[action_approval.audience_mismatch]') });

    // Operator audience: an ordinary signed-in user is not an operator.
    const ops = rig({ value: policy() });
    await expect(ops.r.createCaller(await ctx(USER_E, PLAIN)).actionApproval.propose(reverse)).rejects.toMatchObject({
      message: expect.stringContaining('[action_approval.audience_mismatch]'),
    });
  });

  it('a pending request can still be rejected while its policy is blank, but not approved', async () => {
    const raw = { value: policy() as string | undefined };
    const { r } = rig(raw);
    const p = await r.createCaller(await ctx(OPERATOR_C, OPERATOR)).actionApproval.propose(reverse);
    raw.value = '';
    const checker = r.createCaller(await ctx(FOUNDER_A, OPERATOR));
    await expect(checker.actionApproval.approve({ approvalId: p.approvalId, expectedPayloadHash: p.payloadHash })).rejects.toMatchObject({
      message: expect.stringContaining('[action_approval.policy_unset]'),
    });
    // Blank falls back to the fixed audience for reject: svc-ops is founder-level, and A is a founder.
    expect((await checker.actionApproval.reject({ approvalId: p.approvalId })).status).toBe('REJECTED');
  });
});

describe('actionApproval.policies', () => {
  it('lists every governed type for an operator or founder, blank shown as unset with the typed code', async () => {
    const { r } = rig({ value: policy() });
    for (const scopes of [OPERATOR, SUPPORT]) {
      const read = await r.createCaller(await ctx(OPERATOR_C, scopes)).actionApproval.policies();
      expect(read.policies.map((p) => p.actionType)).toEqual(['ops.ledger.reverse', 'ops.ledger.adjust']);
      expect(read.policies[0]).toMatchObject({
        state: 'set',
        policy: { requiredApprovals: 2, approverAudience: 'operator', applier: 'svc-ops', maxAgeSeconds: 600 },
      });
      expect(read.policies[1]).toEqual({ state: 'unset', actionType: 'ops.ledger.adjust', code: 'action_approval.policy_unset' });
    }
    // A live founder whose session carries no operator scope.
    const founderRead = await r.createCaller(await ctx(FOUNDER_B, PLAIN)).actionApproval.policies();
    expect(founderRead.policies).toHaveLength(2);
  });

  it('refuses anyone who is neither', async () => {
    const { r } = rig({ value: policy() });
    await expect(r.createCaller(await ctx(USER_E, PLAIN)).actionApproval.policies()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('[action_approval.operator_only]'),
    });
  });
});
