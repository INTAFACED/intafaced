import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const ctx = {
  session: {
    userId: '11111111-1111-4111-8111-111111111111',
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const ok = (data: unknown) => Response.json({ result: { data } });
const setting = {
  channel: 'email',
  configured: false,
  requires: ['EMAIL_API_KEY'],
  enabled: null,
  adapter: null,
  version: 0,
  effective: 'unconfigured',
  notConnected: null,
};
const get = () => GET(new Request('http://admin.example/api/notify-config'));

beforeEach(() => gate.session.mockResolvedValue(ctx));
afterEach(() => {
  vi.unstubAllGlobals();
  gate.session.mockReset();
});

describe('notify config GET', () => {
  it('reads channel settings and templates as the founder, with an as-of time', async () => {
    const fn = vi.fn(async (url: string, _init?: RequestInit) => (url.includes('notify.channelSettings') ? ok([setting]) : ok([])));
    vi.stubGlobal('fetch', fn);
    const json = await (await get()).json();
    expect(json.channels).toMatchObject({ kind: 'ok', data: [{ channel: 'email', effective: 'unconfigured' }] });
    expect(json.templates).toMatchObject({ kind: 'ok', data: [] });
    expect(Number.isFinite(Date.parse(json.asOf))).toBe(true);
    const urls = fn.mock.calls.map((c) => c[0]).sort();
    expect(urls[0]).toContain('/api/notify/trpc/notify.channelSettings');
    expect(urls[1]).toContain('/api/notify/trpc/notify.templates');
    for (const call of fn.mock.calls)
      expect((call[1]!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });
  it('a founder without the operator read permission sees why, and no rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: { message: 'Missing scope admin:read', data: { code: 'FORBIDDEN', httpStatus: 403 } } }, { status: 403 }),
      ),
    );
    const json = await (await get()).json();
    expect(json.channels).toMatchObject({ kind: 'failed', forbidden: true });
    expect(json.channels).not.toHaveProperty('data');
  });
  it('a malformed list is a failure, never an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok([{ channel: 'fax' }])),
    );
    expect((await (await get()).json()).channels).toMatchObject({ kind: 'failed' });
  });
  it('has no POST', async () => {
    const routes = await import('./route');
    expect(Object.keys(routes).filter((k) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(k))).toEqual([]);
  });
  it('a refused session returns before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    gate.session.mockResolvedValueOnce(Response.json({ code: 'admin.session_required' }, { status: 401 }));
    expect((await get()).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });
});
