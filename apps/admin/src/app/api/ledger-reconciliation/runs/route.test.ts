import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSessionError } from '@/lib/founder-session';
import { CONTROL_ID, runView } from '@/lib/ledger/reconciliation-fixtures.test-util';
import { GET } from './route';

const auth = vi.hoisted(() => ({ authorize: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/founder-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/founder-session')>()),
  authorizeAdminRequest: auth.authorize,
}));

const ctx = {
  session: { userId: '11111111-1111-4111-8111-111111111111', accessToken: 'founder-access-token' },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const original = { ...process.env };
const get = (query: string) => GET(new Request(`https://admin.example/api/ledger-reconciliation/runs${query}`));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  process.env.EDGE_URL = 'http://edge:4000';
  process.env.ADMIN_TREASURY_TOKEN = 'isolated-treasury-token';
  auth.authorize.mockResolvedValue(ctx);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  auth.authorize.mockReset();
  process.env = { ...original };
});

describe('GET /api/ledger-reconciliation/runs', () => {
  it('reads one control’s evaluations through the edge with the founder’s own token, never the treasury credential', async () => {
    fetchMock.mockResolvedValue(Response.json({ controlId: CONTROL_ID, total: 3, runs: [runView()] }));
    const res = await get(`?controlId=${CONTROL_ID}&limit=1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ controlId: CONTROL_ID, total: 3 });
    expect(body.runs).toHaveLength(1);
    expect(typeof body.readAt).toBe('string');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/admin/ledger/reconciliation/controls/runs');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer founder-access-token' });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ controlId: CONTROL_ID, limit: 1 });
  });
  it('sends no limit when none is asked, so svc-ledger’s default applies', async () => {
    fetchMock.mockResolvedValue(Response.json({ controlId: CONTROL_ID, total: 0, runs: [] }));
    expect((await get(`?controlId=${CONTROL_ID}`)).status).toBe(200);
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ controlId: CONTROL_ID });
  });
  it('refuses a missing or bad control id, and a limit outside 1 to 500, before the network', async () => {
    for (const query of [
      '',
      '?controlId=nope',
      `?controlId=${CONTROL_ID}&limit=0`,
      `?controlId=${CONTROL_ID}&limit=501`,
      `?controlId=${CONTROL_ID}&limit=1.5`,
    ]) {
      const res = await get(query);
      expect(res.status, query).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('passes a refusal through with its code; a 2xx that is not this control’s list is not one', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'nope', code: 'ops.control_not_found' }, { status: 404 }));
    const refused = await get(`?controlId=${CONTROL_ID}`);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ code: 'ops.control_not_found' });
    const other = '7f7f7f7f-1111-4222-8333-444455556666';
    fetchMock.mockResolvedValue(Response.json({ controlId: other, total: 1, runs: [runView({ controlId: other })] }));
    expect((await get(`?controlId=${CONTROL_ID}`)).status).toBe(502);
    fetchMock.mockResolvedValue(Response.json({ controlId: CONTROL_ID, total: 1, runs: [runView({ controlId: other })] }));
    expect((await get(`?controlId=${CONTROL_ID}`)).status).toBe(502);
  });
  it('an edge that does not answer is unavailable, and a refused founder session returns before the network', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect((await get(`?controlId=${CONTROL_ID}`)).status).toBe(503);
    fetchMock.mockReset();
    auth.authorize.mockRejectedValue(new AdminSessionError('admin.session_required', 401));
    expect((await get(`?controlId=${CONTROL_ID}`)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
