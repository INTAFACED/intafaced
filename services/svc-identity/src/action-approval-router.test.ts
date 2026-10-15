import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { TRPCError, type Context } from '@intafaced/contracts';
import { createActionApprovalRouter } from './action-approval-router.js';
import { staticFounderDirectory } from './auth/action-approval-audience.js';
import { ActionApprovalService } from './auth/action-approval-service.js';
import { MemoryActionApprovalStore } from './auth/action-approval-store.js';

const authConfig = {
  secret: 'an-identity-action-approval-router-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION = '44444444-4444-4444-8444-444444444444';

const propose = {
  actionType: 'ledger.freeze',
  targetService: 'svc-ledger',
  targetId: 'posting_freeze',
  expectedVersion: '1',
  payloadHash: 'sha256:abc',
  policyVersion: 'v1',
};

async function sessionCtx(userId: string, mfa: boolean): Promise<Context> {
  // Operators: four-eyes over operator action types needs an operator principal (#4724).
  const { token } = await issueAccessToken(
    { userId, sessionId: SESSION, scopes: ['identity:write', 'admin:write'], tier: 'none', mfa },
    authConfig,
  );
  return {
    principal: await verifyAccessToken(token, authConfig),
    service: null,
    region: 'DE',
    requestId: 'req-aa',
  };
}

function serviceCtx(service: string | null): Context {
  return { principal: null, service, region: 'DE', requestId: 'req-aa' };
}

function router() {
  // `ledger.freeze` is a founder-only type: A and B are the founder pair here.
  return createActionApprovalRouter(
    new ActionApprovalService(new MemoryActionApprovalStore(), { ttlSeconds: 60, founders: staticFounderDirectory([A, B]) }),
  );
}

describe('actionApproval router', () => {
  it('unsigned consume is 401; wrong service is 403; session cannot consume', async () => {
    const r = router();
    const maker = r.createCaller(await sessionCtx(A, true));
    const checker = r.createCaller(await sessionCtx(B, true));
    const pending = await maker.actionApproval.propose(propose);
    const approved = await checker.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: pending.payloadHash });
    const consumeInput = {
      approvalId: approved.approvalId,
      operationId: approved.operationId,
      payloadHash: approved.payloadHash,
      targetService: 'svc-ledger',
      targetId: approved.targetId,
      expectedVersion: approved.expectedVersion,
    };

    await expect(r.createCaller(serviceCtx(null)).actionApproval.consume(consumeInput)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    } satisfies Partial<TRPCError>);

    await expect(r.createCaller(serviceCtx('svc-identity')).actionApproval.consume(consumeInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    await expect(maker.actionApproval.consume(consumeInput)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const consumed = await r.createCaller(serviceCtx('svc-ledger')).actionApproval.consume(consumeInput);
    expect(consumed.status).toBe('CONSUMED');
  });

  it('approve without MFA is 401, not a successful second-name check', async () => {
    const r = router();
    const maker = r.createCaller(await sessionCtx(A, true));
    const pending = await maker.actionApproval.propose(propose);
    const noMfa = r.createCaller(await sessionCtx(B, false));
    await expect(
      noMfa.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: pending.payloadHash }),
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('consumeForEdge is MFA admin:write and only for svc-edge', async () => {
    const r = router();
    const maker = r.createCaller(await sessionCtx(A, true));
    const checker = r.createCaller(await sessionCtx(B, true));
    const pending = await maker.actionApproval.propose({
      ...propose,
      actionType: 'edge.kill',
      targetService: 'svc-edge',
      targetId: 'kill:trade',
    });
    const approved = await checker.actionApproval.approve({ approvalId: pending.approvalId, expectedPayloadHash: pending.payloadHash });
    const consumeInput = {
      approvalId: approved.approvalId,
      operationId: approved.operationId,
      payloadHash: approved.payloadHash,
      targetService: 'svc-edge' as const,
      targetId: approved.targetId,
      expectedVersion: approved.expectedVersion,
    };

    const writer = r.createCaller(
      await (async () => {
        const { token } = await issueAccessToken(
          { userId: A, sessionId: SESSION, scopes: ['admin:write'], tier: 'none', mfa: true },
          authConfig,
        );
        return {
          principal: await verifyAccessToken(token, authConfig),
          service: null,
          region: 'DE',
          requestId: 'req-aa',
        };
      })(),
    );
    const consumed = await writer.actionApproval.consumeForEdge(consumeInput);
    expect(consumed.status).toBe('CONSUMED');

    const ledgerShaped = { ...consumeInput, targetService: 'svc-ledger', targetId: 'posting_freeze' };
    await expect(writer.actionApproval.consumeForEdge(ledgerShaped)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const noMfa = r.createCaller(
      await (async () => {
        const { token } = await issueAccessToken(
          { userId: B, sessionId: SESSION, scopes: ['admin:write'], tier: 'none', mfa: false },
          authConfig,
        );
        return {
          principal: await verifyAccessToken(token, authConfig),
          service: null,
          region: 'DE',
          requestId: 'req-aa',
        };
      })(),
    );
    await expect(noMfa.actionApproval.consumeForEdge(consumeInput)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('ttl unset is named, not a default window', async () => {
    const r = createActionApprovalRouter(
      new ActionApprovalService(new MemoryActionApprovalStore(), { ttlSeconds: undefined, founders: staticFounderDirectory([A, B]) }),
    );
    const maker = r.createCaller(await sessionCtx(A, true));
    await expect(maker.actionApproval.propose(propose)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});
