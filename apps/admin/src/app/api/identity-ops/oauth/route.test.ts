import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const APP = '44444444-4444-4444-8444-444444444444';
const DEV = '55555555-5555-4555-8555-555555555555';
const REASON = 'Checked the redirect addresses and the scopes.';
const ctx = {
  session: {
    userId: FOUNDER,
    accessToken: 'founder-access-token',
    refreshToken: 'r',
    expiresAt: '2030-01-01T00:00:00.000Z',
    issuedAt: '2026-01-01T00:00:00.000Z',
    csrf: 'c'.repeat(43),
  },
  config: { origin: 'https://admin.example', edgeUrl: 'http://edge:4000', key: Buffer.alloc(32, 1) },
};
const ok = (data: unknown) => Response.json({ result: { data } });
const trpcErr = (status: number, message: string) =>
  Response.json({ error: { message, code: -32603, data: { code: 'X', httpStatus: status } } }, { status });
const app = (over: Record<string, unknown> = {}) => ({
  id: APP,
  clientId: 'ifc_abc',
  name: 'Ledger sync',
  description: null,
  logoUrl: null,
  redirectUrls: ['https://app.example.test/callback'],
  scopes: ['trade:read'],
  confidential: true,
  status: 'pending',
  createdAt: '2026-10-20T12:00:00.000Z',
  secretRolledAt: null,
  ...over,
});
const get = (query = '') => GET(new Request(`http://admin.example/api/identity-ops/oauth${query}`));
const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/identity-ops/oauth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const decision = (over: Record<string, unknown> = {}) => ({ action: 'review', appId: APP, decision: 'approve', reason: REASON, ...over });

beforeEach(() => {
  gate.session.mockResolvedValue(ctx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
});

describe('GET queue', () => {
  it('reads one status as the founder with an explicit page size and stamps the read time', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok({ apps: [{ ...app(), developerUserId: DEV }] }));
    vi.stubGlobal('fetch', fn);
    const json = await (await get('?status=pending')).json();
    expect(json).toMatchObject({ status: 'pending', limit: 50, apps: { kind: 'ok', data: [{ id: APP, developerUserId: DEV }] } });
    expect(Number.isFinite(Date.parse(json.asOf))).toBe(true);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe(`http://edge:4000/api/identity/trpc/oauth.apps.queue?input=${encodeURIComponent('{"status":"pending","limit":50}')}`);
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });

  it('an empty queue is empty only when svc-identity says so, and a status it does not know is refused before any call', async () => {
    const fn = vi.fn(async () => ok({ apps: [] }));
    vi.stubGlobal('fetch', fn);
    expect((await (await get()).json()).apps).toEqual({ kind: 'ok', data: [] });
    expect((await get('?status=rejected')).status).toBe(400);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a row that is not exactly the contract makes the whole read invalid, not a shorter list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ apps: [{ ...app(), developerUserId: DEV }, { id: 'x' }] })),
    );
    expect((await (await get()).json()).apps).toMatchObject({ kind: 'failed' });
  });

  it('a session without the compliance permission sees why, not an empty queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'oauth.operator_denied')),
    );
    expect((await (await get()).json()).apps).toMatchObject({ kind: 'failed', forbidden: true });
  });
});

describe('POST decision', () => {
  it('approves one app as the founder and reports done only when the service shows it approved', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(app({ status: 'approved' })));
    vi.stubGlobal('fetch', fn);
    const res = await post(decision());
    expect(await res.json()).toEqual({ ok: true, appId: APP, status: 'approved' });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/identity/trpc/oauth.apps.review');
    expect(JSON.parse(String(init!.body))).toEqual({ appId: APP, decision: 'approve', reason: REASON });
  });

  it('a 200 that does not show the status asked for is outcome unknown, never a success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(app({ status: 'pending' }))),
    );
    const json = await (await post(decision())).json();
    expect(json.ok).toBe(false);
    expect(json.refusal.changed).toBe('unknown');
  });

  it('suspends with the same shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(app({ status: 'suspended' }))),
    );
    expect(await (await post(decision({ decision: 'suspend' }))).json()).toEqual({ ok: true, appId: APP, status: 'suspended' });
  });

  it.each([{ reason: 'short' }, { decision: 'reject' }, { appId: 'x' }])('refuses %j before any call', async (over) => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const res = await post(decision(over));
    expect(res.status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a developer approving their own app is a definite refusal that says nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'oauth.operator_denied')),
    );
    const res = await post(decision());
    expect(res.status).toBe(403);
    expect((await res.json()).refusal).toMatchObject({ code: 'oauth.operator_denied', changed: 'no' });
  });

  it('a lost reply is an unknown outcome', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket closed');
      }),
    );
    const res = await post(decision());
    expect(res.status).toBe(502);
    expect((await res.json()).refusal.changed).toBe('unknown');
  });

  it('writes an audit line naming the founder and the app, never the reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(app({ status: 'approved' }))),
    );
    await post(decision());
    const line = String(vi.mocked(console.warn).mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({ audit: 'admin.oauth_app_approve', founder: FOUNDER, appId: APP, outcome: 'ok' });
    expect(line).not.toContain(REASON);
  });
});
