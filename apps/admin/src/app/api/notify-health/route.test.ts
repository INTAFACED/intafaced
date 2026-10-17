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
const delivery = {
  id: '22222222-2222-4222-8222-222222222222',
  notificationId: '33333333-3333-4333-8333-333333333333',
  channel: 'email',
  status: 'refused',
  attempts: 1,
  attemptedAt: '2026-10-17T02:00:00.000Z',
  acceptedAt: null,
  refusalCode: 'channel.not_configured',
  createdAt: '2026-10-17T02:00:00.000Z',
  updatedAt: '2026-10-17T02:00:01.000Z',
};
const get = () => GET(new Request('http://admin.example/api/notify-health'));

beforeEach(() => gate.session.mockResolvedValue(ctx));
afterEach(() => {
  vi.unstubAllGlobals();
  gate.session.mockReset();
});

describe('notify health GET', () => {
  it('reads the operator deliveries (explicit page size) and the health as the founder, with an as-of time', async () => {
    const fn = vi.fn(async (url: string, _init?: RequestInit) =>
      url.includes('operatorDeliveries')
        ? ok([delivery])
        : ok({ ok: true, service: 'svc-notify', fanoutEnabled: false, venueIncident: {} }),
    );
    vi.stubGlobal('fetch', fn);
    const json = await (await get()).json();
    expect(json.deliveries).toMatchObject({ kind: 'ok', data: { limit: 200, rows: [{ channel: 'email', status: 'refused' }] } });
    expect(json.health).toMatchObject({ kind: 'ok', data: { fanoutEnabled: false } });
    expect(Number.isFinite(Date.parse(json.asOf))).toBe(true);
    const urls = fn.mock.calls.map((c) => c[0]).sort();
    expect(urls[0]).toBe(`http://edge:4000/api/notify/trpc/health`);
    expect(urls[1]).toBe(`http://edge:4000/api/notify/trpc/notify.operatorDeliveries?input=${encodeURIComponent('{"limit":200}')}`);
    for (const call of fn.mock.calls)
      expect((call[1]!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });
  it('a founder without the operator read permission sees why, and no figures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('operatorDeliveries')
          ? Response.json({ error: { message: 'Missing scope admin:read', data: { code: 'FORBIDDEN', httpStatus: 403 } } }, { status: 403 })
          : ok({ ok: true, service: 'svc-notify', fanoutEnabled: true }),
      ),
    );
    const json = await (await get()).json();
    expect(json.deliveries).toMatchObject({ kind: 'failed', forbidden: true });
    expect(json.deliveries.message).toContain('admin:read');
    expect(json.deliveries).not.toHaveProperty('data');
    expect(json.health.kind).toBe('ok');
  });
  it('a malformed list is a failure, never an empty page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('operatorDeliveries') ? ok([{ id: 'x' }]) : ok({ ok: true, service: 'svc-notify', fanoutEnabled: true }),
      ),
    );
    expect((await (await get()).json()).deliveries).toMatchObject({ kind: 'failed' });
  });
  it('offers no way to change anything: the route has no POST', async () => {
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
