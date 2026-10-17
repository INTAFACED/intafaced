import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/founder-session', () => ({
  authorizeAdminRequest: auth.authorize,
  adminSessionErrorResponse: () => Response.json({ error: 'session' }, { status: 401 }),
}));

import { tradeOpsRoute } from './bff';

const original = process.env.ADMIN_MODULES;
afterEach(() => {
  if (original === undefined) delete process.env.ADMIN_MODULES;
  else process.env.ADMIN_MODULES = original;
  auth.authorize.mockReset();
});

const request = () => new Request('https://admin.example/api/trade-ops/approvals', { method: 'POST', body: '{}' });

describe('tradeOpsRoute module gate', () => {
  it('answers 404 before the session check and never calls the handler when the tradeops module is off', async () => {
    process.env.ADMIN_MODULES = 'crm';
    const handler = vi.fn();
    const res = await tradeOpsRoute(request(), handler);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('reaches the session check when the module is on', async () => {
    process.env.ADMIN_MODULES = 'crm,tradeops';
    auth.authorize.mockRejectedValue(new Error('no session'));
    const handler = vi.fn();
    const res = await tradeOpsRoute(request(), handler);
    expect(res.status).toBe(401);
    expect(auth.authorize).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });
});
