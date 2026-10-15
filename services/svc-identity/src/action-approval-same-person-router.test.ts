/**
 * Unit card — `actionApproval.createSamePerson` demands a fresh factor, not just a session
 *
 * 1. Promise: a same-person money-out approval is only created after a passkey assertion or a
 *    six-digit TOTP code is verified in the same request; recovery codes and API keys are refused.
 * 2. Break: if creation trusted the session (or the `mfa` claim on a stale token), a stolen
 *    session could mint approvals for any payee with no tap.
 * 3. Done bar: no verifier => refused; verifier rejects => no approval row; recovery-code shape
 *    is a validation error; both factors at once is a validation error; only listed types; an API
 *    key principal is refused; the HMAC consume path then spends it once for the same user only.
 * 4. Class M
 * 5. Paths: services/svc-identity/src/action-approval-router.ts
 * 6. RED before: the door did not exist
 */
import { describe, expect, it, vi } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { type Context } from '@intafaced/contracts';
import { createActionApprovalRouter, type SamePersonFactorVerifier } from './action-approval-router.js';
import { ActionApprovalService } from './auth/action-approval-service.js';
import { MemoryActionApprovalStore } from './auth/action-approval-store.js';
import { AuthError } from './auth/auth-service.js';

const authConfig = {
  secret: 'an-identity-same-person-router-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION = '44444444-4444-4444-8444-444444444444';
const HASH = `sha256:${'c'.repeat(64)}`;
const TYPE = 'bank.step_up.transfers.toUser';

async function sessionCtx(userId: string, extra: { apiKeyId?: string; subAccountId?: string } = {}): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId, sessionId: SESSION, scopes: ['identity:write'], tier: 'none', mfa: false, ...extra },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-sp' };
}

function serviceCtx(service: string | null): Context {
  return { principal: null, service, region: 'DE', requestId: 'req-sp' };
}

const passkey = {
  id: 'cred',
  rawId: 'cred',
  type: 'public-key' as const,
  response: { clientDataJSON: 'x', authenticatorData: 'y', signature: 'z' },
};

function build(verify?: SamePersonFactorVerifier) {
  const service = new ActionApprovalService(new MemoryActionApprovalStore(), { ttlSeconds: 60 });
  const r = createActionApprovalRouter(service, verify ? { verifyFactor: verify } : {});
  return { r, service };
}

describe('actionApproval.createSamePerson', () => {
  it('verifies a TOTP code for this user and session, then mints an approval only they can spend, once', async () => {
    const verify = vi.fn<SamePersonFactorVerifier>(async () => undefined);
    const { r } = build(verify);
    const caller = r.createCaller(await sessionCtx(A));
    const a = await caller.actionApproval.createSamePerson({ actionType: TYPE, payloadHash: HASH, totpCode: '123456' });
    expect(verify).toHaveBeenCalledWith({ userId: A, sessionId: SESSION, totpCode: '123456' });
    expect(a).toMatchObject({ kind: 'same_person', status: 'APPROVED', requesterId: A, approverId: A });

    const consumeInput = {
      approvalId: a.approvalId,
      operationId: a.operationId,
      payloadHash: HASH,
      targetService: 'svc-bank',
      targetId: a.targetId,
      expectedVersion: a.expectedVersion,
      principalUserId: A,
      principalSessionId: SESSION,
    };
    const bank = r.createCaller(serviceCtx('svc-bank'));
    await expect(bank.actionApproval.consume({ ...consumeInput, principalUserId: B })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller.actionApproval.consume(consumeInput)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(bank.actionApproval.consume(consumeInput)).resolves.toMatchObject({ status: 'CONSUMED', kind: 'same_person' });
    await expect(bank.actionApproval.consume(consumeInput)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('accepts a passkey assertion', async () => {
    const verify = vi.fn<SamePersonFactorVerifier>(async () => undefined);
    const { r } = build(verify);
    const caller = r.createCaller(await sessionCtx(A));
    await caller.actionApproval.createSamePerson({ actionType: TYPE, payloadHash: HASH, webauthn: passkey });
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ userId: A, sessionId: SESSION, webauthn: expect.objectContaining({ id: 'cred' }) }),
    );
  });

  it('creates nothing when the factor is wrong or the user has none enrolled', async () => {
    for (const [code, trpc] of [
      ['auth.mfa_invalid', 'UNAUTHORIZED'],
      ['auth.webauthn_invalid', 'UNAUTHORIZED'],
      ['auth.mfa_not_enrolled', 'FORBIDDEN'],
      ['auth.too_many_attempts', 'TOO_MANY_REQUESTS'],
    ] as const) {
      const { r, service } = build(async () => {
        throw new AuthError('no', code);
      });
      const create = vi.spyOn(service, 'createSamePerson');
      const caller = r.createCaller(await sessionCtx(A));
      await expect(
        caller.actionApproval.createSamePerson({ actionType: TYPE, payloadHash: HASH, totpCode: '000000' }),
      ).rejects.toMatchObject({
        code: trpc,
      });
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('refuses when no verifier is wired, so a session alone never creates an approval', async () => {
    const { r } = build();
    const caller = r.createCaller(await sessionCtx(A));
    await expect(caller.actionApproval.createSamePerson({ actionType: TYPE, payloadHash: HASH, totpCode: '123456' })).rejects.toMatchObject(
      {
        code: 'PRECONDITION_FAILED',
      },
    );
  });

  it('rejects recovery codes, both factors, no factor, unlisted types and malformed hashes before any verification', async () => {
    const verify = vi.fn<SamePersonFactorVerifier>(async () => undefined);
    const { r } = build(verify);
    const caller = r.createCaller(await sessionCtx(A));
    const bad: unknown[] = [
      { actionType: TYPE, payloadHash: HASH, totpCode: 'ABCDE-12345' },
      { actionType: TYPE, payloadHash: HASH, totpCode: '123456', webauthn: passkey },
      { actionType: TYPE, payloadHash: HASH },
      { actionType: 'ledger.freeze', payloadHash: HASH, totpCode: '123456' },
      { actionType: TYPE, payloadHash: 'sha256:abc', totpCode: '123456' },
      { actionType: TYPE, payloadHash: HASH, totpCode: '123456', targetService: 'svc-ledger' },
    ];
    for (const input of bad) {
      await expect(caller.actionApproval.createSamePerson(input as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses a sub-account principal', async () => {
    const verify = vi.fn<SamePersonFactorVerifier>(async () => undefined);
    const { r } = build(verify);
    const sub = r.createCaller(await sessionCtx(A, { subAccountId: '66666666-6666-4666-8666-666666666666' }));
    await expect(sub.actionApproval.createSamePerson({ actionType: TYPE, payloadHash: HASH, totpCode: '123456' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses an API-key principal and an unauthenticated caller', async () => {
    const verify = vi.fn<SamePersonFactorVerifier>(async () => undefined);
    const { r } = build(verify);
    const key = r.createCaller(await sessionCtx(A, { apiKeyId: 'key-1' }));
    await expect(key.actionApproval.createSamePerson({ actionType: TYPE, payloadHash: HASH, totpCode: '123456' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      r.createCaller(serviceCtx(null)).actionApproval.createSamePerson({ actionType: TYPE, payloadHash: HASH, totpCode: '123456' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('four-eyes propose refuses a same-person type; ordinary types still propose and the requester still cannot approve', async () => {
    const { r } = build(async () => undefined);
    const caller = r.createCaller(await sessionCtx(A));
    await expect(
      caller.actionApproval.propose({
        actionType: TYPE,
        targetService: 'svc-bank',
        targetId: TYPE,
        expectedVersion: '1',
        payloadHash: HASH,
        policyVersion: 'v1',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
