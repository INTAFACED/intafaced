import { describe, expect, it, vi } from 'vitest';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { createPayRouter } from '../../router.js';
import type { PayService } from '../../payment-service.js';
import { CardSandboxAdapter } from '../../rails/card-sandbox.js';
import { RailRegistry } from '../../rails/registry.js';
import type { UserMoneyService } from '../../user-money-service.js';
import { createPayNamespaces } from '../../namespaces/index.js';
import { WithdrawalApprovalError } from './errors.js';
import { createWithdrawalApprovalRouter } from './router.js';
import type { WithdrawalApprovalService } from './service.js';

/** The approval procedures through the real routers: scopes, the caller from the token, typed refusals, the direct-door gate. */
const SECRET = 'a-pay-approvals-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const REQ = '33333333-3333-4333-8333-333333333333';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-pay' });

function signed(scopes: string[], userId = USER) {
  const p = {
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes,
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-approvals',
  });
}

const view = {
  id: REQ,
  userId: USER,
  assetId: 'USDT',
  amount: '60',
  rail: 'card-sandbox',
  destination: { kind: 'bank', ref: 'DE89370400440532013000' },
  clientRef: 'w-1',
  teamAccountId: '44444444-4444-4444-8444-444444444444',
  requiredApprovals: 2,
  approvalCount: 0,
  approvedByMe: false,
  holdAtSubmit: false,
  status: 'pending' as const,
  failureCode: null,
  expiresAt: '2026-10-20T12:00:00.000Z',
  createdAt: '2026-10-20T11:50:00.000Z',
  decidedAt: null,
};

function api(service: Record<string, unknown>, scopes: string[], userId = USER) {
  return createWithdrawalApprovalRouter(service as unknown as WithdrawalApprovalService).createCaller(signed(scopes, userId))
    .withdrawalApproval;
}

describe('withdrawalApproval.* scopes and caller', () => {
  it('propose takes the caller from the token, never from the input, and needs the interactive withdraw scope', async () => {
    const propose = vi.fn(async () => view);
    const input = { assetId: 'USDT', amount: '60', railId: 'card-sandbox', destination: view.destination, clientRef: 'w-1' };
    await expect(api({ propose }, ['trade:withdraw']).propose(input)).resolves.toMatchObject({ id: REQ });
    expect(propose).toHaveBeenCalledWith(USER, input);
    await expect(api({ propose }, ['trade:write']).propose(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api({ propose }, ['trade:withdraw']).propose({ ...input, userId: 'someone-else' } as typeof input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('approve and reject need trade:withdraw, cancel needs trade:write, reads need trade:read', async () => {
    const approve = vi.fn(async () => view);
    const reject = vi.fn(async () => view);
    const cancel = vi.fn(async () => view);
    const get = vi.fn(async () => view);
    const service = { approve, reject, cancel, get };
    await api(service, ['trade:withdraw']).approve({ requestId: REQ });
    expect(approve).toHaveBeenCalledWith(USER, REQ);
    await api(service, ['trade:withdraw']).reject({ requestId: REQ });
    await api(service, ['trade:write']).cancel({ requestId: REQ });
    await api(service, ['trade:read']).get({ requestId: REQ });
    await expect(api(service, ['trade:read']).approve({ requestId: REQ })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api(service, ['trade:read']).reject({ requestId: REQ })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api(service, ['trade:read']).cancel({ requestId: REQ })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api(service, ['pay:read']).get({ requestId: REQ })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a refusal reaches the client typed, with the code in the message', async () => {
    const approve = vi.fn(async () => {
      throw new WithdrawalApprovalError('withdrawal_approval.initiator_cannot_approve', 'no');
    });
    await expect(api({ approve }, ['trade:withdraw']).approve({ requestId: REQ })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('withdrawal_approval.initiator_cannot_approve'),
    });
    const list = vi.fn(async () => {
      throw new WithdrawalApprovalError('withdrawal_approval.list_limit_unset', 'no');
    });
    await expect(api({ list }, ['trade:read']).list({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('founderAdmin.withdrawalApprovals', () => {
  const founderApi = (ok: boolean, service: Record<string, unknown>) =>
    createPayNamespaces({
      founderAuthority: async () => {
        if (!ok) throw new Error('operator.denied');
        return 'founder-1';
      },
      withdrawalApprovals: { service: service as unknown as WithdrawalApprovalService },
    }).createCaller({
      principal: {
        userId: USER,
        sub: USER,
        sid: REQ,
        scopes: [...SESSION_SCOPES],
        mfa: true,
        tier: 'full',
        expiresAt: new Date(Date.now() + 3_600_000),
      } as Principal,
      service: null,
      region: 'DE',
      requestId: 'r',
    }).founderAdmin!.withdrawalApprovals!;

  it('setPolicy takes every field (a blank one is a parse error) and records the founder', async () => {
    const setPolicy = vi.fn(async () => ({}) as never);
    const full = {
      userId: USER,
      assetId: 'USDT',
      active: true,
      teamAccountId: view.teamAccountId,
      requiredApprovals: 2,
      threshold: '50',
      windowSeconds: 3600,
      expirySeconds: 600,
      holdAtSubmit: false,
    };
    await founderApi(true, { setPolicy })
      .setPolicy(full)
      .catch(() => undefined);
    expect(setPolicy).toHaveBeenCalledWith('founder-1', full);
    for (const key of Object.keys(full)) {
      const { [key]: _omit, ...partial } = full as Record<string, unknown>;
      await expect(founderApi(true, { setPolicy }).setPolicy(partial as typeof full)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(founderApi(true, { setPolicy }).setPolicy({ ...full, threshold: '0' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(founderApi(true, { setPolicy }).setPolicy({ ...full, requiredApprovals: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('a non-founder reaches nothing', async () => {
    const settleDue = vi.fn();
    await expect(founderApi(false, { settleDue }).settleDue({})).rejects.toBeDefined();
    expect(settleDue).not.toHaveBeenCalled();
  });
});

describe('the direct door', () => {
  const rails = new RailRegistry([new CardSandboxAdapter({ secret: 'pay-approvals-test-rail-secret-at-least-32', toleranceSeconds: 300 })]);
  const input = { assetId: 'USDT', amount: '60', railId: 'card-sandbox', destination: view.destination, clientRef: 'w-1' };

  it('asks the approval gate with the caller and the amount before it withdraws, and does not withdraw when refused', async () => {
    const withdraw = vi.fn();
    const gate = {
      assertDirectAllowed: vi.fn(async () => {
        throw new WithdrawalApprovalError('withdrawal_approval.required', 'needs approvals');
      }),
    };
    const caller = createPayRouter(
      {} as PayService,
      rails,
      { withdraw } as unknown as UserMoneyService,
      null,
      undefined,
      undefined,
      null,
      undefined,
      null,
      null,
      null,
      gate,
    ).createCaller(signed(['trade:withdraw']));
    await expect(caller.withdrawal.create(input)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('withdrawal_approval.required'),
    });
    expect(gate.assertDirectAllowed).toHaveBeenCalledWith({
      userId: USER,
      assetId: 'USDT',
      amount: parseAmount('60'),
      clientRef: 'w-1',
      destination: view.destination,
    });
    expect(withdraw).not.toHaveBeenCalled();
  });

  it('withdraws when the gate allows it', async () => {
    const record = {
      id: REQ,
      userId: USER,
      assetId: 'USDT',
      amount: parseAmount('60'),
      rail: 'card-sandbox',
      destination: view.destination,
      clientRef: 'w-1',
      railRef: 'r',
      attempts: 0,
      failureCode: null,
      status: 'sent',
      createdAt: new Date(),
    };
    const withdraw = vi.fn(async () => record);
    const gate = { assertDirectAllowed: vi.fn(async () => undefined) };
    const caller = createPayRouter(
      {} as PayService,
      rails,
      { withdraw } as unknown as UserMoneyService,
      null,
      undefined,
      undefined,
      null,
      undefined,
      null,
      null,
      null,
      gate,
    ).createCaller(signed(['trade:withdraw']));
    await expect(caller.withdrawal.create(input)).resolves.toMatchObject({ id: REQ, status: 'sent' });
    expect(withdraw).toHaveBeenCalledTimes(1);
  });
});
