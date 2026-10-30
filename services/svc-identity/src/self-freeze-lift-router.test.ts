import { describe, expect, it, vi } from 'vitest';
import { SESSION_SCOPES, issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { SecurityStepUpError, type SecurityStepUp } from './auth/security-step-up.js';
import { SelfFreezeLift, SelfFreezeLiftError } from './auth/self-freeze-lift.js';
import { createSelfFreezeLiftRouter } from './self-freeze-lift-router.js';

const tokenConfig = {
  secret: 'an-identity-lift-router-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
  refreshTtlSeconds: 2_592_000,
};

async function ctx(): Promise<Context> {
  const { token } = await issueAccessToken(
    {
      userId: '00000000-0000-4000-8000-0000000000aa',
      sessionId: '44444444-4444-4444-8444-444444444444',
      scopes: [...SESSION_SCOPES],
      tier: 'none',
      mfa: true,
    },
    tokenConfig,
  );
  return { principal: await verifyAccessToken(token, tokenConfig), service: null, region: 'DE', requestId: 'r' };
}

describe('selfFreezeManage.lift door', () => {
  it('refuses an unset wait before spending any step-up approval', async () => {
    const require = vi.fn();
    const lift = new SelfFreezeLift(vi.fn() as never, undefined);
    const caller = createSelfFreezeLiftRouter(lift, { require } as unknown as SecurityStepUp).createCaller(await ctx());
    await expect(caller.selfFreezeManage.lift({ clientRequestId: 'c1' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(require).not.toHaveBeenCalled();
  });

  it('asks for the self_freeze_lift step-up and does not lift without it', async () => {
    const require = vi.fn().mockRejectedValue(new SecurityStepUpError('identity.step_up_required'));
    const lift = new SelfFreezeLift(vi.fn() as never, 0);
    vi.spyOn(lift, 'assertDue').mockResolvedValue(undefined);
    const spy = vi.spyOn(lift, 'lift');
    const caller = createSelfFreezeLiftRouter(lift, { require } as unknown as SecurityStepUp).createCaller(await ctx());
    await expect(caller.selfFreezeManage.lift({ clientRequestId: 'c1' })).rejects.toBeTruthy();
    expect(require).toHaveBeenCalledWith(expect.anything(), 'identity.step_up.self_freeze_lift', { clientRequestId: 'c1' }, undefined);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses too soon before spending any step-up approval', async () => {
    const require = vi.fn();
    const lift = new SelfFreezeLift(vi.fn() as never, 3600);
    const availableAt = new Date('2026-10-23T00:00:00Z');
    vi.spyOn(lift, 'assertDue').mockRejectedValue(new SelfFreezeLiftError('identity.self_freeze_lift_too_soon', availableAt));
    const spy = vi.spyOn(lift, 'lift');
    const caller = createSelfFreezeLiftRouter(lift, { require } as unknown as SecurityStepUp).createCaller(await ctx());
    await expect(caller.selfFreezeManage.lift({ clientRequestId: 'c1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { code: 'identity.self_freeze_lift_too_soon', availableAt: availableAt.toISOString() },
    });
    expect(require).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends the whole seconds left that the database counted, so the customer app can name them', async () => {
    const lift = new SelfFreezeLift(vi.fn() as never, 3600);
    const availableAt = new Date('2026-10-29T16:00:30.000Z');
    vi.spyOn(lift, 'assertDue').mockRejectedValue(new SelfFreezeLiftError('identity.self_freeze_lift_too_soon', availableAt, 30));
    const caller = createSelfFreezeLiftRouter(lift, { require: vi.fn() } as unknown as SecurityStepUp).createCaller(await ctx());
    await expect(caller.selfFreezeManage.lift({ clientRequestId: 'c1' })).rejects.toMatchObject({
      cause: { code: 'identity.self_freeze_lift_too_soon', details: { retryAfterSeconds: 30 } },
    });
  });
});
