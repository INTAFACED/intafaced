import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import type { DeskRequest } from '@/lib/desk/approval-packet';
import type { FounderCallContext } from '@/lib/desk/founder-call';
import { governanceExecute } from './server';

const ctx: FounderCallContext = {
  session: {
    userId: '11111111-1111-4111-8111-111111111111',
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const target = '22222222-2222-4222-8222-222222222222';
const roleSet: DeskRequest = { kind: 'token.governance.role.set', userId: target, role: 'moderator', revision: '3' };
const ids = { approvalId: 'appr_1', operationId: 'op_1' };
const trpcOk = (data: unknown) => Response.json({ result: { data } });
const trpcErr = (status: number, message: string, trpcCode: string) =>
  Response.json({ error: { message, code: -32603, data: { code: trpcCode, httpStatus: status } } }, { status });

afterEach(() => vi.unstubAllGlobals());
function stub(handler: (procedure: string, input: Record<string, unknown>) => Response) {
  const calls: Array<{ procedure: string; input: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const procedure = new URL(url).pathname.split('/').pop() ?? '';
      const input = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      calls.push({ procedure, input });
      return handler(procedure, input);
    }),
  );
  return calls;
}

/** J-more-catalogue-10 #6: a role change carries the running founder's fresh step-up for exactly this move. */
describe('governance role change step-up', () => {
  it('spends the code at identity for exactly this account, role and revision, then hands svc-token the step-up approval', async () => {
    const calls = stub((procedure) => {
      if (procedure === 'stepUp.begin') return trpcOk({ challengeId: 'ch_1', totp: true });
      if (procedure === 'stepUp.complete') return trpcOk({ stepUpApprovalId: 'su_1', scope: 'token.step_up.governance.setRole' });
      return trpcOk({ userId: target, role: 'moderator', revision: 4 });
    });
    const reply = await governanceExecute(ctx)(roleSet, { ...ids, stepUpCode: '123456' });
    expect(reply).toMatchObject({ ok: true });
    expect(calls.map((c) => c.procedure)).toEqual(['stepUp.begin', 'stepUp.complete', 'governance.setRole']);
    expect(calls[0]!.input).toEqual({
      scope: 'token.step_up.governance.setRole',
      purpose: 'governance.setRole',
      target,
      fields: { userId: target, role: 'moderator', expectedRevision: '3' },
    });
    expect(calls[1]!.input).toEqual({ challengeId: 'ch_1', totpCode: '123456' });
    expect(calls[2]!.input).toMatchObject({ userId: target, role: 'moderator', expectedRevision: 3, ...ids, stepUpApprovalId: 'su_1' });
  });

  it('without a code asks svc-token anyway, so its step-up refusal is what the founder reads', async () => {
    const calls = stub(() => trpcErr(403, 'identity.step_up_required', 'FORBIDDEN'));
    const reply = await governanceExecute(ctx)(roleSet, ids);
    expect(reply.ok).toBe(false);
    expect(calls.map((c) => c.procedure)).toEqual(['governance.setRole']);
    expect(calls[0]!.input).not.toHaveProperty('stepUpApprovalId');
  });

  it('a wrong code stops at identity: svc-token is never asked and nothing changes', async () => {
    const calls = stub((procedure) =>
      procedure === 'stepUp.begin' ? trpcOk({ challengeId: 'ch_1', totp: true }) : trpcErr(403, 'identity.step_up_invalid', 'FORBIDDEN'),
    );
    const reply = await governanceExecute(ctx)(roleSet, { ...ids, stepUpCode: '000000' });
    expect(reply.ok).toBe(false);
    expect(calls.map((c) => c.procedure)).toEqual(['stepUp.begin', 'stepUp.complete']);
  });

  it('an approval for another scope is not passed on', async () => {
    const calls = stub((procedure) => {
      if (procedure === 'stepUp.begin') return trpcOk({ challengeId: 'ch_1', totp: true });
      return trpcOk({ stepUpApprovalId: 'su_1', scope: 'identity.step_up.withdraw' });
    });
    const reply = await governanceExecute(ctx)(roleSet, { ...ids, stepUpCode: '123456' });
    expect(reply.ok).toBe(false);
    expect(calls.map((c) => c.procedure)).toEqual(['stepUp.begin', 'stepUp.complete']);
  });
});
