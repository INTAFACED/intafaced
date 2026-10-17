import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/founder-session', () => ({
  authorizeAdminRequest: auth.authorize,
  adminSessionErrorResponse: () => Response.json({ error: 'session' }, { status: 401 }),
}));

import { POST } from './route';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const fetchMock = vi.fn();

beforeEach(() => {
  auth.authorize.mockResolvedValue({
    session: { userId: ME, accessToken: 'founder-session-token' },
    config: { origin: 'https://admin.example', edgeUrl: 'http://isolated-edge:4000' },
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  auth.authorize.mockReset();
});

const post = (body: unknown) =>
  POST(new Request('https://admin.example/api/trade-ops/kill-switch', { method: 'POST', body: JSON.stringify(body) }));

describe('trade desk kill switch route', () => {
  it('has no toggle: it answers trade_ops.bad_action and sends nothing to the edge', async () => {
    const res = await post({
      action: 'toggle',
      disabled: true,
      reason: 'incident 4471 runaway bot',
      confirmOperatorId: OTHER,
      approvalId: 'ap-1',
      operationId: 'op-1',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ kind: 'refused', code: 'trade_ops.bad_action' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps halt_all and mass_cancel as checked blockers that send nothing', async () => {
    const halt = await post({ action: 'halt_all', reason: 'venue incident drill', confirmOperatorId: OTHER });
    expect(halt.status).toBe(501);
    expect(await halt.json()).toMatchObject({ kind: 'refused', code: 'trade_ops.matching_not_routed' });
    const cancel = await post({
      action: 'mass_cancel',
      scope: 'market',
      target: 'BTC/USDT',
      reason: 'cleanup after halt',
      confirmOperatorId: OTHER,
    });
    expect(cancel.status).toBe(501);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
