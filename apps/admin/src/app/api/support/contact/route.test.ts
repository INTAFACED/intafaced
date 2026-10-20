import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const FOUNDER = '11111111-1111-4111-8111-111111111111';
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
const trpcErr = (status: number, message: string, code = 'X') =>
  Response.json({ error: { message, code: -32603, data: { code, httpStatus: status } } }, { status });
const record = (over: Record<string, unknown> = {}) => ({
  email: null,
  phone: null,
  chatHours: null,
  revision: 0,
  updatedAt: null,
  ...over,
});
const get = () => GET(new Request('http://admin.example/api/support/contact'));
const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/support/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const set = { changes: { email: 'help@example.test' }, expectedRevision: 1, reason: 'new inbox' };

beforeEach(() => {
  gate.session.mockResolvedValue(ctx);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  gate.session.mockReset();
});

describe('GET contact', () => {
  it('reads contactChannels as the founder with an as-of time; unset channels stay null', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(record()));
    vi.stubGlobal('fetch', fn);
    const json = await (await get()).json();
    expect(json.contact).toMatchObject({ kind: 'ok', data: { email: null, phone: null, chatHours: null, revision: 0 } });
    expect(Number.isFinite(Date.parse(json.asOf))).toBe(true);
    expect(fn.mock.calls[0]![0]).toBe('http://edge:4000/api/support/trpc/contactChannels');
  });
  it('a malformed answer is a failure, not an empty record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ email: '' })),
    );
    expect((await (await get()).json()).contact).toMatchObject({ kind: 'failed' });
  });
  it('a refused session returns before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    gate.session.mockResolvedValueOnce(Response.json({ code: 'admin.session_required' }, { status: 401 }));
    expect((await get()).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('POST contact', () => {
  it('refuses a malformed request before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const bad of [{}, { ...set, changes: {} }, { ...set, reason: '' }, { ...set, expectedRevision: 'x' }]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      expect((await res.json()).refusal.changed).toBe('no');
    }
    expect(fn).not.toHaveBeenCalled();
  });
  it('sends the changes with the read revision and reports saved only when the revision moved', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(record({ email: 'help@example.test', revision: 2 })));
    vi.stubGlobal('fetch', fn);
    const res = await post(set);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, contact: { email: 'help@example.test', revision: 2 } });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/support/trpc/setContactChannels');
    expect(JSON.parse(String(init!.body))).toEqual({ email: 'help@example.test', expectedRevision: 1, reason: 'new inbox' });
  });
  it('an answer that does not show the change is outcome unknown, never saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(record({ revision: 1 }))),
    );
    const res = await post(set);
    expect(res.status).toBe(502);
    expect((await res.json()).refusal.changed).toBe('unknown');
  });
  it('a stale revision is said as a stale revision and nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(409, 'support.contact_revision_stale', 'CONFLICT')),
    );
    const res = await post(set);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { code: 'support.contact_revision_stale', changed: 'no' } });
  });
  it('a refused value is said in its own words', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(400, 'support.contact_setting_invalid: email', 'BAD_REQUEST')),
    );
    expect((await (await post(set)).json()).refusal.code).toBe('support.contact_setting_invalid');
  });
  it('a founder who is not a lead is told so with a 403', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'Missing scope support:ops', 'FORBIDDEN')),
    );
    const res = await post(set);
    expect(res.status).toBe(403);
    expect((await res.json()).ok).toBe(false);
  });
  it('a network failure is outcome unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    const res = await post(set);
    expect(res.status).toBe(502);
    expect((await res.json()).refusal.changed).toBe('unknown');
  });
  it('the audit line names who and which fields, never the values or the reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(record({ email: 'help@example.test', revision: 2 }))),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await post(set);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain(FOUNDER);
    expect(line).toContain('email');
    expect(line).not.toContain('help@example.test');
    expect(line).not.toContain('new inbox');
  });
});
