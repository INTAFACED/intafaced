import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock('@/lib/founder-session', () => ({
  authorizeAdminRequest: auth.authorize,
  adminSessionErrorResponse: () => Response.json({ error: 'session' }, { status: 401 }),
}));

import { POST } from './route';

const POSITION = 'b1b2c3d4-0000-4000-8000-000000000009';
const row = {
  id: POSITION,
  userId: 'user-1',
  marketId: 'm-1',
  side: 'long',
  status: 'open',
  size: '2',
  entryPrice: '100',
  openedAt: '2026-10-20T08:00:00.000Z',
};
const market = {
  id: 'm-1',
  symbol: 'BTC-PERP',
  base: 'BTC',
  quote: 'USDT',
  kind: 'futures',
  status: 'active',
  tickSize: '0.1',
  lotSize: '0.001',
  minQty: '0.001',
  maxQty: null,
  minNotional: '5',
  makerBps: 1,
  takerBps: 2,
  listedAt: null,
};
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  auth.authorize.mockResolvedValue({
    session: { userId: 'op', accessToken: 'founder-session-token' },
    config: { origin: 'https://admin.example', edgeUrl: 'http://isolated-edge:4000' },
  });
  fetchMock.mockImplementation(async (url: URL) => {
    const u = String(url);
    if (u.includes('markets.list')) return json({ result: { data: { json: [market] } } });
    if (u.includes('admin.positions.list')) return json({ result: { data: { json: { rows: [row], nextCursor: null } } } });
    if (u.includes('admin.positions.get')) return json({ result: { data: { json: row } } });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  auth.authorize.mockReset();
});

const post = (body: unknown) =>
  POST(new Request('https://admin.example/api/trade-ops/positions', { method: 'POST', body: JSON.stringify(body) }));

describe('positions route', () => {
  it('refuses an empty search and a bad position id before any call', async () => {
    expect(await (await post({})).json()).toMatchObject({ code: 'trade_ops.positions_lookup_empty' });
    expect(await (await post({ positionId: 'not-a-uuid' })).json()).toMatchObject({ code: 'trade_ops.positions_bad_input' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists a user's positions with the market named by symbol and unserved figures null", async () => {
    const res = await post({ userId: 'user-1' });
    const out = await res.json();
    expect(out).toMatchObject({ kind: 'ok', data: { nextCursor: null } });
    expect(out.data.rows[0]).toMatchObject({ id: POSITION, market: 'BTC-PERP', size: '2', markPrice: null, marginRatio: null });
    expect(urls().some((u) => u.includes('admin.positions.list'))).toBe(true);
  });

  it('gets one position, and refuses it when it belongs to a different user id', async () => {
    expect(await (await post({ positionId: POSITION })).json()).toMatchObject({ kind: 'ok' });
    const res = await post({ positionId: POSITION, userId: 'someone-else' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'trade_ops.positions_user_mismatch' });
  });

  it('passes a service refusal through in its words', async () => {
    fetchMock.mockImplementation(async () =>
      json({ error: { json: { message: 'position not found', data: { code: 'NOT_FOUND', appCode: 'position_not_found' } } } }, 404),
    );
    const res = await post({ positionId: POSITION });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ kind: 'refused', code: 'position_not_found' });
  });
});
