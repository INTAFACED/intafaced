import { describe, expect, it, vi } from 'vitest';
import { router } from '@intafaced/contracts';
import { tradingControlsRouter } from './router.js';
import { TradingControls, TradingControlError } from './trading-controls.js';
import { principalFor } from '../spot/testing.js';

const userId = 'a1111111-1111-4111-8111-111111111111';
const target = { area: 'trading' as const, userId };
const input = {
  target,
  requestId: 'b1111111-1111-4111-8111-111111111111',
  reason: 'Inspect activity',
  expectedVersion: '0',
  action: 'restrict' as const,
};
const context = {
  principal: { ...principalFor(userId, ['ops:read', 'ops:write']), mfa: true },
  region: 'SG',
  service: null,
  requestId: 'ctx',
};
describe('Trading founder routes', () => {
  it('protects all reads/commands, without an unreachable admin:write pre-gate', async () => {
    const controls = {
      getState: vi.fn(async () => ({ target, restricted: false, version: '0' })),
      history: vi.fn(async () => []),
      change: vi.fn(async () => ({
        auditId: input.requestId,
        requestId: input.requestId,
        target,
        action: input.action,
        reason: input.reason,
        occurredAt: new Date().toISOString(),
        actorUserId: userId,
        outcome: 'changed' as const,
        changed: true as const,
        before: { target, restricted: false, version: '0' },
        after: { target, restricted: true, version: '1' },
      })),
    } as unknown as TradingControls;
    const routes = router({ accountControls: tradingControlsRouter(controls) });
    const anonymous = routes.createCaller({ ...context, principal: null });
    await expect(anonymous.accountControls.getState({ target })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anonymous.accountControls.history({ target, limit: 10 })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anonymous.accountControls.change(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const caller = routes.createCaller(context);
    expect(await caller.accountControls.getState({ target })).toMatchObject({ version: '0' });
    expect(await caller.accountControls.change(input)).toMatchObject({ outcome: 'changed' });
    expect(controls.change).toHaveBeenCalledWith(context, input);
  });
  it('strict inputs reject supplied actor or receipt authority and missing version/reason', async () => {
    const controls = { change: vi.fn() } as unknown as TradingControls;
    const caller = router({ accountControls: tradingControlsRouter(controls) }).createCaller(context);
    for (const body of [
      { ...input, actorUserId: userId },
      { ...input, admission: { status: 'committed' } },
      { target, action: 'restrict' },
      { ...input, reason: 'x' },
    ]) {
      await expect(caller.accountControls.change(body as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(controls.change).not.toHaveBeenCalled();
  });
  it('does not turn authority failure or unknown output into allowed control', async () => {
    const denied = {
      getState: async () => {
        throw new TradingControlError('operator.denied');
      },
    } as unknown as TradingControls;
    await expect(
      router({ accountControls: tradingControlsRouter(denied) })
        .createCaller(context)
        .accountControls.getState({ target }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      router({ accountControls: tradingControlsRouter() }).createCaller(context).accountControls.change(input),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    const invalid = { change: async () => ({ outcome: 'allowed' }) } as unknown as TradingControls;
    await expect(
      router({ accountControls: tradingControlsRouter(invalid) })
        .createCaller(context)
        .accountControls.change(input),
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});
