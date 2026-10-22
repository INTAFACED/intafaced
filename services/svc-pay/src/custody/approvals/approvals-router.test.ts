import { describe, expect, it, vi } from 'vitest';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { createPayNamespaces } from '../../namespaces/index.js';
import { CustodyApprovalError } from './errors.js';
import { createCustodyApprovalRouters } from './router.js';
import type { CustodyApprovalService } from './service.js';
import { router } from '@intafaced/contracts';
import { founderProcedure } from '../../namespaces/founder-procedure.js';

/** The custody approval procedures through a real founder procedure: founder-only, the actor from the session, typed refusals. */
const TASK = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);
const principal = {
  userId: '11111111-1111-4111-8111-111111111111',
  sub: '11111111-1111-4111-8111-111111111111',
  sid: TASK,
  scopes: [...SESSION_SCOPES],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 3_600_000),
} as Principal;
const ctx = { principal, service: null, region: 'DE', requestId: 'r' };

function api(ok: boolean, service: Record<string, unknown>) {
  const authority = async () => {
    if (!ok) throw new Error('operator.denied');
    return 'founder-1';
  };
  const routers = createCustodyApprovalRouters(founderProcedure(authority), service as unknown as CustodyApprovalService, (c) => {
    return (c as { founderUserId: string }).founderUserId;
  });
  return router(routers).createCaller(ctx);
}

describe('founderAdmin.custody approval procedures', () => {
  it('decisions carry the signed-in founder and the hash they read', async () => {
    const approve = vi.fn(async () => ({}) as never);
    const reject = vi.fn(async () => ({}) as never);
    await api(true, { approve, reject })
      .tasks.approve({ taskId: TASK, payloadHash: HASH })
      .catch(() => undefined);
    expect(approve).toHaveBeenCalledWith('founder-1', TASK, HASH);
    await api(true, { approve, reject })
      .tasks.reject({ taskId: TASK, payloadHash: HASH })
      .catch(() => undefined);
    expect(reject).toHaveBeenCalledWith('founder-1', TASK, HASH);
    await api(true, { approve, reject })
      .config.approve({ taskId: TASK, payloadHash: HASH })
      .catch(() => undefined);
    expect(approve).toHaveBeenLastCalledWith('founder-1', TASK, HASH, 'config');
    await expect(api(true, { approve }).tasks.approve({ taskId: TASK, payloadHash: 'short' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(api(true, { approve }).tasks.approve({ taskId: TASK, payloadHash: HASH, initiator: 'x' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('setQuorum takes every field: a blank one is a parse error', async () => {
    const setQuorum = vi.fn(async () => ({}) as never);
    const full = { kind: 'config' as const, requiredApprovals: 2, expirySeconds: 600 };
    await api(true, { setQuorum })
      .approvalSettings.setQuorum(full)
      .catch(() => undefined);
    expect(setQuorum).toHaveBeenCalledWith('founder-1', full);
    for (const key of Object.keys(full)) {
      const { [key]: _omit, ...partial } = full as Record<string, unknown>;
      await expect(api(true, { setQuorum }).approvalSettings.setQuorum(partial as typeof full)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    await expect(api(true, { setQuorum }).approvalSettings.setQuorum({ ...full, requiredApprovals: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('a non-founder reaches nothing', async () => {
    const approve = vi.fn();
    const register = vi.fn();
    const caller = api(false, { approve, register });
    await expect(caller.tasks.approve({ taskId: TASK, payloadHash: HASH })).rejects.toBeDefined();
    await expect(caller.approvers.register({ userId: 'u', label: 'l', role: 'keyless' })).rejects.toBeDefined();
    expect(approve).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('a refusal reaches the client typed, with the code in the message', async () => {
    const approve = vi.fn(async () => {
      throw new CustodyApprovalError('custody_approval.initiator_cannot_decide', 'no');
    });
    await expect(api(true, { approve }).tasks.approve({ taskId: TASK, payloadHash: HASH })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('custody_approval.initiator_cannot_decide'),
    });
    const list = vi.fn(async () => {
      throw new CustodyApprovalError('custody_approval.list_limit_unset', 'no');
    });
    await expect(api(true, { list }).tasks.list({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('is mounted under founderAdmin.custody', async () => {
    const sql = vi.fn(async () => []);
    const caller = createPayNamespaces({
      founderAuthority: async () => 'founder-1',
      custody: { sql: sql as never },
    }).createCaller(ctx);
    await expect(caller.founderAdmin!.custody!.approvers.list({})).resolves.toEqual([]);
    expect(sql).toHaveBeenCalled();
  });
});
