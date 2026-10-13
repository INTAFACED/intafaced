import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
const founderGate = vi.hoisted(() => vi.fn<() => Promise<Response | null>>(async () => null));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffGate: founderGate }));

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
  vi.unstubAllGlobals();
  founderGate.mockReset();
  founderGate.mockResolvedValue(null);
});
describe('kill-switch GET keeps the BFF boundary and typed read refusal', () => {
  it('forwards authoritative read403 while never making a mutation', async () => {
    process.env.ADMIN_BFF_SHARED_SECRET = 'isolated-proxy-secret';
    process.env.EDGE_URL = 'http://isolated-edge:4000';
    process.env.ADMIN_OPERATOR_TOKEN = 'isolated-unit-token';
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ error: 'Isolated scope refusal', code: 'scope.insufficient' }, { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(
      new Request('http://admin.example/api/kill-switch', { headers: { 'x-intafaced-admin-bff': 'isolated-proxy-secret' } }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ status: 'refused', code: 'scope.insufficient', httpStatus: 403 });
    expect(fetchMock).toHaveBeenCalledWith('http://isolated-edge:4000/admin/kill-switches', expect.objectContaining({ cache: 'no-store' }));
  });
  it('malformed edge200 propagates a typed unusable read and never an observed zero', async () => {
    process.env.ADMIN_BFF_SHARED_SECRET = 'isolated-proxy-secret';
    process.env.EDGE_URL = 'http://isolated-edge:4000';
    process.env.ADMIN_OPERATOR_TOKEN = 'isolated-unit-token';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    );
    const response = await GET(
      new Request('http://admin.example/api/kill-switch', { headers: { 'x-intafaced-admin-bff': 'isolated-proxy-secret' } }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'invalid_response', code: 'admin.kill_invalid_response' });
  });
});
