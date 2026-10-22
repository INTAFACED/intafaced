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
import { AllowlistError } from './errors.js';
import { createAllowlistRouter } from './router.js';
import type { AllowlistService } from './service.js';

/** The allowlist procedures through the real routers: scopes, the caller from the token, typed refusals, the direct-door gate. */
const SECRET = 'a-pay-allowlist-test-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const CHANGE = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);
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
    id: 'req-allowlist',
  });
}

const view = {
  id: CHANGE,
  userId: USER,
  op: 'add' as const,
  entryId: null,
  subject: { address: '0x1111111111111111111111111111111111111111' },
  requestHash: HASH,
  teamAccountId: '44444444-4444-4444-8444-444444444444',
  requiredApprovals: 2,
  approvalCount: 0,
  approvedByMe: false,
  status: 'waiting' as const,
  failureCode: null,
  createdAt: '2026-10-20T11:50:00.000Z',
  decidedAt: null,
};

function api(service: Record<string, unknown>, scopes: string[], userId = USER) {
  return createAllowlistRouter(service as unknown as AllowlistService).createCaller(signed(scopes, userId)).allowlist;
}

describe('allowlist.* scopes and caller', () => {
  const add = {
    group: 'external_wallet' as const,
    assetId: 'USDT',
    address: view.subject.address,
    label: 'Cold',
    clientRef: 'r-1',
  };

  it('every change takes the caller from the token and needs the interactive withdraw scope', async () => {
    const proposeAdd = vi.fn(async () => view);
    const proposeDelete = vi.fn(async () => view);
    const proposePolicy = vi.fn(async () => view);
    const setMode = vi.fn(async () => ({ mode: { userId: USER, enabled: true, setAt: null }, change: null }));
    const service = { proposeAdd, proposeDelete, proposePolicy, setMode };
    await api(service, ['trade:withdraw']).proposeAdd(add);
    expect(proposeAdd).toHaveBeenCalledWith(USER, add);
    await api(service, ['trade:withdraw']).proposeDelete({ entryId: CHANGE, clientRef: 'r-2' });
    await api(service, ['trade:withdraw']).proposePolicy({ enabled: true, assetId: 'USDT', maxAmount: '5', clientRef: 'r-3' });
    await api(service, ['trade:withdraw']).setMode({ enabled: true, clientRef: 'r-4' });
    for (const call of [
      () => api(service, ['trade:write']).proposeAdd(add),
      () => api(service, ['trade:write']).proposeDelete({ entryId: CHANGE, clientRef: 'r-2' }),
      () => api(service, ['trade:write']).proposePolicy({ enabled: true, assetId: 'USDT', maxAmount: '5', clientRef: 'r-3' }),
      () => api(service, ['trade:read']).setMode({ enabled: false, clientRef: 'r-4' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(api(service, ['trade:withdraw']).proposeAdd({ ...add, userId: 'someone-else' } as typeof add)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('approve and reject carry the hash and need trade:withdraw, cancel needs trade:write, reads need trade:read', async () => {
    const approve = vi.fn(async () => view);
    const reject = vi.fn(async () => view);
    const cancel = vi.fn(async () => view);
    const get = vi.fn(async () => view);
    const service = { approve, reject, cancel, get };
    await api(service, ['trade:withdraw']).approve({ changeId: CHANGE, requestHash: HASH });
    expect(approve).toHaveBeenCalledWith(USER, CHANGE, HASH);
    await api(service, ['trade:withdraw']).reject({ changeId: CHANGE, requestHash: HASH });
    await api(service, ['trade:write']).cancel({ changeId: CHANGE });
    await api(service, ['trade:read']).get({ changeId: CHANGE });
    await expect(api(service, ['trade:read']).approve({ changeId: CHANGE, requestHash: HASH })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(api(service, ['trade:read']).cancel({ changeId: CHANGE })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api(service, ['pay:read']).get({ changeId: CHANGE })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api(service, ['trade:withdraw']).approve({ changeId: CHANGE, requestHash: 'short' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('a refusal reaches the client typed, with the code in the message', async () => {
    const approve = vi.fn(async () => {
      throw new AllowlistError('allowlist.requester_cannot_approve', 'no');
    });
    await expect(api({ approve }, ['trade:withdraw']).approve({ changeId: CHANGE, requestHash: HASH })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('allowlist.requester_cannot_approve'),
    });
    const listEntries = vi.fn(async () => {
      throw new AllowlistError('allowlist.list_limit_unset', 'no');
    });
    await expect(api({ listEntries }, ['trade:read']).listEntries({})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const proposeAdd = vi.fn(async () => {
      throw new AllowlistError('allowlist.quorum_unset', 'no');
    });
    await expect(api({ proposeAdd }, ['trade:withdraw']).proposeAdd(add)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('founderAdmin.allowlist', () => {
  const founderApi = (ok: boolean, service: Record<string, unknown>) =>
    createPayNamespaces({
      founderAuthority: async () => {
        if (!ok) throw new Error('operator.denied');
        return 'founder-1';
      },
      allowlist: { service: service as unknown as AllowlistService },
    }).createCaller({
      principal: {
        userId: USER,
        sub: USER,
        sid: CHANGE,
        scopes: [...SESSION_SCOPES],
        mfa: true,
        tier: 'full',
        expiresAt: new Date(Date.now() + 3_600_000),
      } as Principal,
      service: null,
      region: 'DE',
      requestId: 'r',
    }).founderAdmin!.allowlist!;

  it('setQuorum takes every field (a blank one is a parse error) and records the founder', async () => {
    const setQuorum = vi.fn(async () => ({}) as never);
    const full = { userId: USER, teamAccountId: view.teamAccountId, requiredApprovals: 2 };
    await founderApi(true, { setQuorum })
      .setQuorum(full)
      .catch(() => undefined);
    expect(setQuorum).toHaveBeenCalledWith('founder-1', full);
    for (const key of Object.keys(full)) {
      const { [key]: _omit, ...partial } = full as Record<string, unknown>;
      await expect(founderApi(true, { setQuorum }).setQuorum(partial as typeof full)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(founderApi(true, { setQuorum }).setQuorum({ ...full, requiredApprovals: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('suspend records the founder; a non-founder reaches nothing', async () => {
    const suspend = vi.fn(async () => ({}) as never);
    await founderApi(true, { suspend })
      .suspend({ entryId: CHANGE, reason: 'review' })
      .catch(() => undefined);
    expect(suspend).toHaveBeenCalledWith('founder-1', CHANGE, 'review');
    const resume = vi.fn();
    await expect(founderApi(false, { resume }).resume({ entryId: CHANGE })).rejects.toBeDefined();
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('the direct door', () => {
  const rails = new RailRegistry([
    new CardSandboxAdapter({ secret: 'pay-allowlist-test-rail-secret-at-least-32c', toleranceSeconds: 300 }),
  ]);
  const destination = { kind: 'crypto', ref: '0x1111111111111111111111111111111111111111' };
  const input = { assetId: 'USDT', amount: '60', railId: 'card-sandbox', destination, clientRef: 'w-1' };
  const door = (gate: unknown, withdraw: unknown) =>
    createPayRouter(
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
      gate as never,
    ).createCaller(signed(['trade:withdraw']));

  it('asks the gate with the destination before it withdraws, and a refusal is typed and withdraws nothing', async () => {
    const withdraw = vi.fn();
    const gate = {
      assertDirectAllowed: vi.fn(async () => {
        throw new AllowlistError('pay.destination_not_allowlisted', 'not listed');
      }),
    };
    await expect(door(gate, withdraw).withdrawal.create(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('pay.destination_not_allowlisted'),
    });
    expect(gate.assertDirectAllowed).toHaveBeenCalledWith({
      userId: USER,
      assetId: 'USDT',
      amount: parseAmount('60'),
      clientRef: 'w-1',
      destination,
    });
    expect(withdraw).not.toHaveBeenCalled();
  });
});
