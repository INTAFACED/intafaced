import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
const original = { ...process.env };
const secret = 'isolated-proxy-secret';
const request = (body?: unknown, extras: Record<string, string> = {}) =>
  new Request('http://isolated-admin/api/ledger-freeze', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-intafaced-admin-bff': secret, 'content-type': 'application/json', ...extras },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const state = { frozen: false, reason: null, actor: 'reconciliation', changedAt: '2026-10-09T16:00:00.000Z' };
beforeEach(() => {
  process.env.ADMIN_BFF_SHARED_SECRET = secret;
  process.env.EDGE_URL = 'http://isolated-edge:4000';
  process.env.ADMIN_TREASURY_TOKEN = 'isolated-unit-token';
});
afterEach(() => {
  process.env = { ...original };
  vi.unstubAllGlobals();
});
describe('Ledger BFF preserves boundaries and conservative result', () => {
  it('unconfigured/missing/wrong-origin gate refuses before network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.ADMIN_BFF_SHARED_SECRET;
    expect((await GET(request())).status).toBe(503);
    process.env.ADMIN_BFF_SHARED_SECRET = secret;
    expect((await GET(new Request('http://isolated-admin/api/ledger-freeze'))).status).toBe(401);
    expect((await POST(request({ frozen: false }, { origin: 'http://other-origin' }))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  for (const body of [null, [], {}, { frozen: 'false' }, { frozen: true, reason: 'short' }])
    it(`invalid input ${JSON.stringify(body)} is typed pre-effect refusal`, async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const res = await POST(request(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'admin.ledger_invalid_request' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  it('malformed 2xx read becomes 502 rather than default not-frozen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    );
    const res = await GET(request());
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ kind: 'invalid_response', state: null, upstreamStatus: 200 });
  });
  it('403/404 read keeps refusal/route-absence, never inventing missing storage row', async () => {
    for (const status of [403, 404]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ error: 'Opaque refusal', code: 'edge.no_route' }, { status })),
      );
      const res = await GET(request());
      expect(res.status).toBe(status);
      expect((await res.json()).state).toBeNull();
    }
  });
  it('standing200 response stays unresolved with original trimmed reason and unchanged forwarding payload', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(state));
    vi.stubGlobal('fetch', fetchMock);
    const res = await POST(
      request({
        frozen: true,
        reason: '  Original incident reason <opaque>  ',
        operatorId: 'must not forward',
        approvalId: 'must not forward',
        operationId: 'must not forward',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: false,
      uncertain: true,
      intent: { frozen: true, reason: 'Original incident reason <opaque>' },
      returnedState: state,
    });
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ reason: 'Original incident reason <opaque>' });
  });
  it('arbitrary400 after approval/effect remains unresolved and cannot be called Not applied', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message: 'Publish failed after effect', code: 'ledger.operator_request_failed' }, { status: 400 })),
    );
    const res = await POST(request({ frozen: false }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ uncertain: true, intent: { frozen: false }, state: null });
  });
});
