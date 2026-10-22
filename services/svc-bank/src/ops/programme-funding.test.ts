import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import type { ActionApproval, ActionApprovalConsumeInput } from '@intafaced/contracts';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import type { BankServices } from '../bank-service.js';
import { createBankRouter } from '../router.js';
import { FUNDING_MODEL_SET_ACTION } from './programme-funding.js';

/** BK-cops-04 funding model through the real svc-bank router (the one svc-edge serves at /api/bank). TEST values only. */
const SECRET = 'c'.repeat(32);
const OPERATOR = '77777777-7777-4777-8777-777777777777';
const APPROVER = '88888888-8888-4888-8888-888888888888';
const REASON = 'TEST confirm the jit funding model';

function fakeIdentity() {
  const seen: ActionApprovalConsumeInput[] = [];
  return {
    seen,
    async consume(input: ActionApprovalConsumeInput): Promise<ActionApproval> {
      seen.push(input);
      const now = new Date().toISOString();
      return {
        approvalId: input.approvalId,
        actionType: FUNDING_MODEL_SET_ACTION,
        targetService: 'svc-bank',
        targetId: FUNDING_MODEL_SET_ACTION,
        expectedVersion: '1',
        payloadHash: input.payloadHash,
        requesterId: OPERATOR,
        approverId: APPROVER,
        requesterIsFounder: true,
        approverIsFounder: true,
        policyVersion: 'v1',
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        status: 'CONSUMED',
        operationId: input.operationId,
      };
    },
  };
}

function caller(scopes: string[], approvals?: ReturnType<typeof fakeIdentity>) {
  const raw = encodePrincipal({
    sub: OPERATOR,
    userId: OPERATOR,
    sid: randomUUID(),
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  // The funding model procedures read no bank service; an empty services object proves it.
  return createBankRouter({} as BankServices, approvals ? { approvals } : {}).createCaller(
    edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: `req-${randomUUID()}`,
    }),
  );
}

describe('ops.programmeFundingModel (BK-cops-04)', () => {
  it('get explains the current jit model and lists only jit as wired', async () => {
    const view = await caller(['admin:read']).ops.programmeFundingModelGet();
    expect(view).toMatchObject({ current: 'jit', wired: ['jit'], changedAt: null, changedBy: null });
    expect(view.explanation).toMatch(/held from the customer’s own balance/);
  });

  it('an unwired model refuses bank.funding_model_not_wired before any approval is consumed', async () => {
    const identity = fakeIdentity();
    for (const model of ['prefunded_pooled', 'credit'] as const) {
      await expect(
        caller(['admin:treasury'], identity).ops.programmeFundingModelSet({ model, reason: REASON, approvalId: 'a1', operationId: 'o1' }),
      ).rejects.toMatchObject({ message: expect.stringMatching(/bank\.funding_model_not_wired/) });
    }
    expect(identity.seen).toHaveLength(0);
  });

  it('with no identity wired the change refuses; set needs treasury; a short reason or missing approval is refused', async () => {
    await expect(
      caller(['admin:treasury']).ops.programmeFundingModelSet({ model: 'jit', reason: REASON, approvalId: 'a', operationId: 'o' }),
    ).rejects.toBeTruthy();
    await expect(
      caller(['admin:read'], fakeIdentity()).ops.programmeFundingModelSet({
        model: 'jit',
        reason: REASON,
        approvalId: 'a',
        operationId: 'o',
      }),
    ).rejects.toBeTruthy();
    const identity = fakeIdentity();
    await expect(
      caller(['admin:treasury'], identity).ops.programmeFundingModelSet({
        model: 'jit',
        reason: 'short',
        approvalId: 'a',
        operationId: 'o',
      }),
    ).rejects.toBeTruthy();
    await expect(
      caller(['admin:treasury'], identity).ops.programmeFundingModelSet({ model: 'jit', reason: REASON, approvalId: '', operationId: 'o' }),
    ).rejects.toBeTruthy();
    expect(identity.seen).toHaveLength(0);
  });
});
