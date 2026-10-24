import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { founderCookie, sealFounderSession, type FounderSession } from '../../../../lib/founder-session';

// TEST DATA ONLY: ids, words and bytes below stand in for an information request and its answer.
const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date();
const URL_ = `${ORIGIN}/api/merchants/kyb-requests`;
const MERCHANT = 'ad000001-0000-4000-8000-000000000001';
const REQUEST = 'ae000001-0000-4000-8000-000000000001';
const SHA = 'a'.repeat(64);

function configure() {
  vi.stubEnv('ADMIN_ORIGIN', ORIGIN);
  vi.stubEnv('EDGE_URL', EDGE);
  vi.stubEnv('ADMIN_SESSION_SECRET', KEY.toString('base64url'));
  vi.stubEnv('APP_ENV', 'test');
}
function authed() {
  const s: FounderSession = {
    userId: USER_ID,
    accessToken: 'founder-access-token',
    refreshToken: 'refresh-token',
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    csrf: Buffer.alloc(32, 5).toString('base64url'),
  };
  const cookie = founderCookie(sealFounderSession(s, { origin: ORIGIN, edgeUrl: EDGE, key: KEY }, NOW), 3600).split(';')[0]!;
  return { cookie, origin: ORIGIN, 'x-intafaced-csrf': s.csrf };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const entitlement = () =>
  Response.json({ result: { data: { json: { status: 'enabled', userId: USER_ID, version: '1', changedAt: NOW.toISOString() } } } });
const ok = (data: unknown) => Response.json({ result: { data } });

function upstream(handlers: Record<string, (init: RequestInit, url: string) => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('accountControls.operatorStatus')) return entitlement();
      const key = Object.keys(handlers).find((k) => url.includes(k));
      if (!key) throw new Error(`unexpected upstream call ${url}`);
      return handlers[key]!(init, url);
    }),
  );
  return calls;
}
const request = (patch: Record<string, unknown> = {}) => ({
  request: {
    id: REQUEST,
    merchantId: MERCHANT,
    text: 'TEST send a bank statement',
    dueAt: '2026-11-07T12:00:00.000Z',
    state: 'open',
    pastDue: false,
    createdAt: NOW.toISOString(),
    createdBy: USER_ID,
    answer: null,
    closedBy: null,
    closedAt: null,
    closeNote: null,
    ...patch,
  },
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('information requests BFF', () => {
  it('is founder-only: no cookie is 401 and nothing reaches the service; GET is not allowed', async () => {
    configure();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await POST(post({ action: 'create' }, { origin: ORIGIN }));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    upstream({});
    expect((await GET(new Request(URL_, { headers: authed() }))).status).toBe(405);
  });

  it('asks with a key made from the merchant, words and due date, so sending it again is the same request', async () => {
    configure();
    const calls = upstream({ 'kyb.requests.create': () => ok(request()) });
    const body = { action: 'create', merchantId: MERCHANT, text: '  TEST send a bank statement ', dueAt: '2026-11-07T12:00:00Z' };
    expect((await POST(post(body, authed()))).status).toBe(200);
    expect((await POST(post(body, authed()))).status).toBe(200);
    const sent = calls.filter((c) => c.url.includes('kyb.requests.create')).map((c) => JSON.parse(String(c.init.body)));
    expect(sent[0]).toMatchObject({ merchantId: MERCHANT, text: 'TEST send a bank statement', dueAt: '2026-11-07T12:00:00.000Z' });
    expect(sent[0].requestKey).toMatch(/^kyb-request:ad000001-0000-4000-8000-000000000001:[0-9a-f]{24}$/);
    expect(sent[1].requestKey).toBe(sent[0].requestKey);
  });

  it('closes with the note, and returns a file to open', async () => {
    configure();
    const calls = upstream({
      'kyb.requests.close': () =>
        ok(request({ state: 'closed', closedBy: USER_ID, closedAt: NOW.toISOString(), closeNote: 'TEST received' })),
      'kyb.requests.file': () => ok({ requestId: REQUEST, contentType: 'application/pdf', sha256: SHA, bytesBase64: 'VEVTVA==' }),
    });
    const closed = await POST(post({ action: 'close', requestId: REQUEST, note: 'TEST received' }, authed()));
    expect(await closed.json()).toMatchObject({ ok: true, request: { state: 'closed', closedBy: USER_ID } });
    expect(JSON.parse(String(calls.find((c) => c.url.includes('kyb.requests.close'))!.init.body))).toEqual({
      requestId: REQUEST,
      note: 'TEST received',
    });
    const file = await POST(post({ action: 'file', requestId: REQUEST }, authed()));
    expect(await file.json()).toMatchObject({ ok: true, file: { bytesBase64: 'VEVTVA==' } });
  });

  it('refuses a malformed request before any service call, and a refusal comes back in words', async () => {
    configure();
    const calls = upstream({
      'kyb.requests.create': () =>
        Response.json(
          {
            error: {
              json: { message: 'past', data: { code: 'BAD_REQUEST', httpStatus: 400, cause: { code: 'pay.kyb_request_due_past' } } },
            },
          },
          { status: 400 },
        ),
    });
    for (const body of [
      { action: 'create', merchantId: 'x', text: 'TEST words', dueAt: '2026-11-07T12:00:00Z' },
      { action: 'create', merchantId: MERCHANT, text: '🚫🚫', dueAt: '2026-11-07T12:00:00Z' },
      { action: 'create', merchantId: MERCHANT, text: 'TEST words', dueAt: 'soon' },
      { action: 'close', requestId: REQUEST, note: 'ok' },
      { action: 'delete', requestId: REQUEST },
    ]) {
      expect((await POST(post(body, authed()))).status).toBe(400);
    }
    expect(calls.some((c) => c.url.includes('kyb.requests'))).toBe(false);
    const res = await POST(post({ action: 'create', merchantId: MERCHANT, text: 'TEST words', dueAt: '2020-01-01T00:00:00Z' }, authed()));
    expect(await res.json()).toMatchObject({ ok: false, refusal: { title: 'The due date has passed' } });
  });
});
