import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { Context, AccountControlInput } from '@intafaced/contracts';
import { createMerchantStateRouter } from './merchant-state-router.js';
import type { MerchantStateService } from './merchant-state-service.js';
import type { MerchantAccountControls } from './merchant-account-controls.js';
const userId = randomUUID(),
  merchantId = randomUUID();
const ctx: Context = {
  principal: {
    userId,
    sub: userId,
    sid: randomUUID(),
    scopes: ['admin:read', 'admin:write'],
    mfa: true,
    tier: 'full',
    expiresAt: new Date(Date.now() + 60000),
  },
  service: null,
  region: 'ID',
  requestId: randomUUID(),
};
const input: AccountControlInput = {
  requestId: randomUUID(),
  target: { area: 'merchant', merchantId },
  action: 'restrict',
  reason: 'Review merchant activity',
  expectedVersion: '0',
};
const state = {} as MerchantStateService;
describe('legacy merchant writer shares founder controls', () => {
  it('legacy and new writer delegate the same strict command and original context', async () => {
    const change = vi.fn(async () => ({}));
    const controls = { change } as unknown as MerchantAccountControls;
    const caller = createMerchantStateRouter(state, controls).createCaller(ctx);
    await expect(caller.merchantState.set(input)).rejects.toHaveProperty('code');
    await expect(caller.accountControls.change(input)).rejects.toHaveProperty('code');
    expect(change).toHaveBeenCalledTimes(2);
    expect(change).toHaveBeenNthCalledWith(1, ctx, input);
    expect(change).toHaveBeenNthCalledWith(2, ctx, input);
  });
  it('old shared-operator approval shape cannot reach either writer', async () => {
    const change = vi.fn();
    const caller = createMerchantStateRouter(state, { change } as unknown as MerchantAccountControls).createCaller(ctx);
    await expect(
      caller.merchantState.set({ merchantId, to: 'active', reason: 'Restore', confirmOperatorId: userId, approvalId: 'old' } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.accountControls.change({ ...input, actorUserId: userId } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(change).not.toHaveBeenCalled();
  });
  it('service credentials without a founder principal cannot write', async () => {
    const change = vi.fn();
    const caller = createMerchantStateRouter(state, { change } as unknown as MerchantAccountControls).createCaller({
      ...ctx,
      principal: null,
      service: 'svc-admin',
    });
    await expect(caller.merchantState.set(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(change).not.toHaveBeenCalled();
  });
  it('history requires an explicit bounded page size before calling the service', async () => {
    const history = vi.fn();
    const caller = createMerchantStateRouter(state, { history } as unknown as MerchantAccountControls).createCaller(ctx);
    await expect(caller.accountControls.history({ target: input.target } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.merchantState.history({ target: input.target, limit: 201 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(history).not.toHaveBeenCalled();
  });
  it('missing live control integration fails closed', async () => {
    const caller = createMerchantStateRouter(state).createCaller(ctx);
    await expect(caller.merchantState.set(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});
