import { describe, expect, it, vi } from 'vitest';
import { router } from '@intafaced/contracts';
import { tradingControlsRouter } from './router.js';
import { TradingControls } from './trading-controls.js';
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

describe('svc-trade accountControls.change', () => {
  it('refuses a caller-supplied approval id and does not call controls', async () => {
    const controls = {
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
    const caller = router({ accountControls: tradingControlsRouter(controls) }).createCaller(context);
    await expect(caller.accountControls.change({ ...input, approvalId: 'appr-1' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(controls.change).not.toHaveBeenCalled();
  });
});
