import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';

const gate = vi.hoisted(() => ({ session: vi.fn<() => Promise<unknown>>() }));
vi.mock('@/lib/admin-bff-gate', () => ({ adminBffSession: gate.session }));

const FOUNDER = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';
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
const ticket = (over: Record<string, unknown> = {}) => ({
  id: T1,
  userId: U,
  category: 'account',
  subject: 'Cannot sign in',
  body: 'I forgot my authenticator',
  status: 'open',
  assigneeId: null,
  createdAt: '2026-10-17T02:00:00.000Z',
  updatedAt: '2026-10-17T02:00:00.000Z',
  ...over,
});
const entry = {
  ticketId: T1,
  userId: U,
  category: 'account',
  status: 'open',
  subject: 'Cannot sign in',
  score: 10,
  ageMs: 60_000,
  createdAt: '2026-10-17T02:00:00.000Z',
  timingKind: 'score_not_promise',
  sla: false,
};
const get = (query = '') => GET(new Request(`http://admin.example/api/support${query}`));
const post = (body: unknown) =>
  POST(
    new Request('http://admin.example/api/support', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

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
  it('reads listQueue as the founder with an explicit page size and returns it with an as-of time', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok({ status: 'ok', entries: [entry] }));
    vi.stubGlobal('fetch', fn);
    const json = await (await get()).json();
    expect(json.queue).toMatchObject({ kind: 'ok', data: { limit: 100, entries: [{ ticketId: T1 }] } });
    expect(Number.isFinite(Date.parse(json.asOf))).toBe(true);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe(`http://edge:4000/api/support/trpc/listQueue?input=${encodeURIComponent('{"limit":100}')}`);
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });
  it('an empty queue is reported as empty only when svc-support says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ status: 'empty' })),
    );
    expect((await (await get()).json()).queue).toMatchObject({ kind: 'ok', data: { entries: [] } });
  });
  it('a founder without the support-staff permission sees why, not an empty queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'Missing scope support:ops')),
    );
    const json = await (await get()).json();
    expect(json.queue).toMatchObject({ kind: 'failed', forbidden: true });
    expect(json.queue.message).toContain('support:ops');
    expect(json.queue).not.toHaveProperty('data');
  });
  it('a malformed answer is a failure, not an empty queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ status: 'ok', entries: [{ ticketId: 'x' }] })),
    );
    expect((await (await get()).json()).queue).toMatchObject({ kind: 'failed' });
  });
  it('a refused session returns before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    gate.session.mockResolvedValueOnce(Response.json({ code: 'admin.session_required' }, { status: 401 }));
    expect((await get()).status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('GET ticket', () => {
  it('rejects a ticket id that is not a UUID before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    expect((await get('?view=ticket&id=../../etc')).status).toBe(400);
    expect((await get('?view=ticket')).status).toBe(400);
    expect(fn).not.toHaveBeenCalled();
  });
  it('reads the ticket, its comments and its history, each on its own', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/get')) return ok(ticket());
        if (url.includes('listComments')) return trpcErr(503, 'down');
        return ok([]);
      }),
    );
    const json = await (await get(`?view=ticket&id=${T1}`)).json();
    expect(json.detail.kind).toBe('ok');
    expect(json.detail.data.ticket.subject).toBe('Cannot sign in');
    expect(json.detail.data.comments).toMatchObject({ kind: 'failed' });
    expect(json.detail.data.events).toMatchObject({ kind: 'ok', data: [] });
  });
});

describe('POST claim', () => {
  it('refuses anything but a claim of one ticket id before the network', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    for (const body of [{}, { action: 'claim' }, { action: 'claim', ticketId: 'x' }, { action: 'assign', ticketId: T1 }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(fn).not.toHaveBeenCalled();
  });
  it('claims as the founder and reports the owner the service returned', async () => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => ok(ticket({ assigneeId: FOUNDER })));
    vi.stubGlobal('fetch', fn);
    const res = await post({ action: 'claim', ticketId: T1 });
    expect(await res.json()).toMatchObject({ ok: true, ticketId: T1, assigneeId: FOUNDER });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('http://edge:4000/api/support/trpc/claim');
    expect(JSON.parse(init!.body as string)).toEqual({ ticketId: T1 });
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
  });
  it('a ticket someone else already claimed is a refusal that changed nothing, in the service’s words', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(409, 'This ticket is already claimed')),
    );
    const res = await post({ action: 'claim', ticketId: T1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { body: 'This ticket is already claimed', changed: 'no' } });
  });
  it('a founder without the permission is told so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => trpcErr(403, 'Missing scope')),
    );
    const json = await (await post({ action: 'claim', ticketId: T1 })).json();
    expect(json.refusal.title).toContain('support-staff permission');
  });
  it('a dropped connection is "not known"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('hang up');
      }),
    );
    const res = await post({ action: 'claim', ticketId: T1 });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ refusal: { changed: 'unknown' } });
  });
  it('logs the founder and the ticket', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok(ticket({ assigneeId: FOUNDER }))),
    );
    await post({ action: 'claim', ticketId: T1 });
    expect(JSON.parse(String(vi.mocked(console.warn).mock.calls.at(-1)?.[0]))).toMatchObject({
      audit: 'admin.support_claim',
      founder: FOUNDER,
      ticketId: T1,
      outcome: 'ok',
    });
  });
});
