import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { ADMIN_COOKIE, founderCookie, sealFounderSession, type FounderSession } from '../../../../lib/founder-session';
import { notesFixture, TEST_MERCHANT } from '../../../../testing/founder-read-fixtures';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date();
const URL_ = `${ORIGIN}/api/merchants/notes`;
const NOTE_ID = '00000000-0000-4000-8000-000000000701';

function configure() {
  vi.stubEnv('ADMIN_ORIGIN', ORIGIN);
  vi.stubEnv('EDGE_URL', EDGE);
  vi.stubEnv('ADMIN_SESSION_SECRET', KEY.toString('base64url'));
  vi.stubEnv('APP_ENV', 'test');
}
function session() {
  const s: FounderSession = {
    userId: USER_ID,
    accessToken: 'founder-access-token',
    refreshToken: 'refresh-token',
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    csrf: Buffer.alloc(32, 5).toString('base64url'),
  };
  return {
    cookie: founderCookie(sealFounderSession(s, { origin: ORIGIN, edgeUrl: EDGE, key: KEY }, NOW), 3600).split(';')[0]!,
    csrf: s.csrf,
  };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const authed = () => {
  const { cookie, csrf } = session();
  return { cookie, origin: ORIGIN, 'x-intafaced-csrf': csrf };
};
const entitlement = () =>
  Response.json({ result: { data: { json: { status: 'enabled', userId: USER_ID, version: '1', changedAt: NOW.toISOString() } } } });

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
const ok = (data: unknown) => Response.json({ result: { data } });

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('operator notes BFF is founder-only', () => {
  it('no cookie: 401, no-store, and no service call', async () => {
    configure();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await POST(post({ action: 'add' }, { origin: ORIGIN }));
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('forged cookie: 401', async () => {
    configure();
    expect((await POST(post({}, { cookie: `${ADMIN_COOKIE}=forged`, origin: ORIGIN }))).status).toBe(401);
  });
  it('needs the exact origin and the CSRF nonce', async () => {
    configure();
    const { cookie, csrf } = session();
    expect((await POST(post({}, { cookie, origin: 'https://evil.example', 'x-intafaced-csrf': csrf }))).status).toBe(403);
    expect((await POST(post({}, { cookie, origin: ORIGIN }))).status).toBe(403);
  });
  it('GET is 405 for a founder; the module switch answers 404', async () => {
    configure();
    upstream({});
    expect((await GET(new Request(URL_, { headers: { cookie: session().cookie } }))).status).toBe(405);
    process.env.ADMIN_MODULES = 'crm';
    expect((await POST(post({}, authed()))).status).toBe(404);
  });
});

describe('add and retract', () => {
  it('rejects bodies it does not understand with 400 before any service call', async () => {
    configure();
    const calls = upstream({});
    for (const body of [
      { action: 'nope' },
      { action: 'add', merchantId: 'x', body: 'hi' },
      { action: 'add', merchantId: TEST_MERCHANT, body: '   ' },
      { action: 'add', merchantId: TEST_MERCHANT, body: 'x'.repeat(4001) },
      { action: 'add', merchantId: TEST_MERCHANT, body: 'hi', tags: ['y'.repeat(41)] },
      { action: 'add', merchantId: TEST_MERCHANT, body: 'hi', tags: 'a' },
      { action: 'add', merchantId: TEST_MERCHANT, body: 'hi', flagged: 'yes' },
      { action: 'retract', noteId: 'x', reason: 'because' },
      { action: 'retract', noteId: NOTE_ID, reason: 'no' },
    ]) {
      const res = await POST(post(body, authed()));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(calls.filter((c) => !c.url.includes('operatorStatus') && !c.url.includes('consoleMode.get'))).toHaveLength(0);
  });

  it('add sends the founder token, trims the text and never names an author', async () => {
    configure();
    const calls = upstream({ 'founderAdmin.ops.notes.add': () => ok(notesFixture.items[0]) });
    const res = await POST(
      post(
        {
          action: 'add',
          merchantId: TEST_MERCHANT.toUpperCase(),
          body: '  watch this one  ',
          tags: [' cap '],
          flagged: true,
          authorId: 'spoof',
        },
        authed(),
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const call = calls.find((c) => c.url.includes('notes.add'))!;
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(JSON.parse(String(call.init.body))).toEqual({ merchantId: TEST_MERCHANT, body: 'watch this one', tags: ['cap'], flagged: true });
  });

  it('retract sends the reason and answers with the retracted note', async () => {
    configure();
    const calls = upstream({ 'founderAdmin.ops.notes.retract': () => ok(notesFixture.items[1]) });
    const res = await POST(post({ action: 'retract', noteId: NOTE_ID, reason: ' wrong merchant ' }, authed()));
    expect(res.status).toBe(200);
    expect(JSON.parse(String(calls.find((c) => c.url.includes('notes.retract'))!.init.body))).toEqual({
      noteId: NOTE_ID,
      reason: 'wrong merchant',
    });
  });

  it('an unbuilt service is a plain refusal, not a blank success', async () => {
    configure();
    upstream({
      'founderAdmin.ops.notes.add': () => Response.json({ error: { data: { cause: { code: 'pay.not_built' } } } }, { status: 501 }),
    });
    const res = await POST(post({ action: 'add', merchantId: TEST_MERCHANT, body: 'hi' }, authed()));
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.refusal.code).toBe('pay.not_built');
  });

  it('a service answer in an unknown shape is refused, not shown as saved', async () => {
    configure();
    upstream({ 'founderAdmin.ops.notes.add': () => ok({ nope: true }) });
    const res = await POST(post({ action: 'add', merchantId: TEST_MERCHANT, body: 'hi' }, authed()));
    expect((await res.json()).ok).toBe(false);
  });
});
