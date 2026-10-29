import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSessionError } from '@/lib/founder-session';
import { CONTROL_ID, controlView } from '@/lib/ledger/reconciliation-fixtures.test-util';
import { GET, POST } from './route';

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
const define = {
  template: 'threshold',
  accountSet: { mode: 'query', assetId: 'USDT' },
  reason: 'LOCAL TEST define the USDT floor control',
  activate: true,
};
const get = () => GET(new Request('https://admin.example/api/ledger-reconciliation'));
const post = (body: unknown) =>
  POST(
    new Request('https://admin.example/api/ledger-reconciliation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

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

describe('GET /api/ledger-reconciliation', () => {
  it('lists through the edge with the founder’s own token, never the treasury credential', async () => {
    fetchMock.mockResolvedValue(Response.json({ controls: [controlView()] }));
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.controls).toHaveLength(1);
    expect(body.treasuryParked).toBeNull();
    expect(typeof body.readAt).toBe('string');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/admin/ledger/reconciliation/controls');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer founder-access-token' });
  });
  it('says the treasury doors are parked when the console holds no treasury credential, and still lists', async () => {
    delete process.env.ADMIN_TREASURY_TOKEN;
    fetchMock.mockResolvedValue(Response.json({ controls: [] }));
    const body = await (await get()).json();
    expect(body.controls).toEqual([]);
    expect(body.treasuryParked).toContain('ADMIN_TREASURY_TOKEN');
  });
  it('passes a refusal through with its code, and a malformed 2xx is not a list', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'nope', code: 'scope.denied' }, { status: 403 }));
    const refused = await get();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: 'scope.denied' });
    fetchMock.mockResolvedValue(Response.json({ controls: [{ id: 'x' }] }));
    expect((await get()).status).toBe(502);
  });
  it('a refused founder session returns before the network', async () => {
    auth.authorize.mockRejectedValue(new AdminSessionError('admin.session_required', 401));
    expect((await get()).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/ledger-reconciliation', () => {
  it('defines on the treasury transport and returns the stored control', async () => {
    fetchMock.mockResolvedValue(Response.json(controlView({ state: 'draft', version: 1 })));
    const res = await post({ action: 'define', body: define });
    expect(res.status).toBe(200);
    expect((await res.json()).control).toMatchObject({ id: CONTROL_ID, state: 'draft' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/admin/ledger/reconciliation/controls');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer isolated-treasury-token' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(define);
  });
  it('updates at the update door', async () => {
    fetchMock.mockResolvedValue(Response.json(controlView()));
    const res = await post({ action: 'update', body: { controlId: CONTROL_ID, reason: 'LOCAL TEST change the control' } });
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://edge:4000/admin/ledger/reconciliation/controls/update');
  });
  it('svc-ledger’s refusal keeps its code: a blank tolerance with activate is ops.control_policy_unset', async () => {
    fetchMock.mockResolvedValue(Response.json({ message: 'ops.control_policy_unset', code: 'ops.control_policy_unset' }, { status: 412 }));
    const res = await post({ action: 'define', body: define });
    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({ code: 'ops.control_policy_unset' });
  });
  it('a console with no treasury credential sends nothing and names the missing setting', async () => {
    delete process.env.ADMIN_TREASURY_TOKEN;
    const res = await post({ action: 'define', body: define });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'admin.ledger_unconfigured', detail: expect.stringContaining('ADMIN_TREASURY_TOKEN') });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('a body outside the contract, or any other action, is refused before the network', async () => {
    for (const body of [
      { action: 'define', body: { ...define, reason: 'short' } },
      { action: 'define', body: { ...define, accountSet: { mode: 'query' } } },
      { action: 'delete', body: define },
      { action: 'define', body: define, extra: true },
      // Pause, resume and retire are two-founder: never through this one-founder door, with or without approval ids.
      { action: 'update', body: { controlId: CONTROL_ID, reason: 'LOCAL TEST pause the control', lifecycle: 'pause' } },
      {
        action: 'update',
        body: { controlId: CONTROL_ID, reason: 'LOCAL TEST pause the control', lifecycle: 'pause', approvalId: 'a', operationId: 'o' },
      },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('a dropped connection after sending is unknown, not refused', async () => {
    fetchMock.mockRejectedValue(new Error('reset'));
    const res = await post({ action: 'define', body: define });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 'admin.upstream_unavailable', changed: 'unknown' });
  });
});
