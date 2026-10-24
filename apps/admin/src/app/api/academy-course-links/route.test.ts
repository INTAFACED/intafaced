import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { founderCookie, sealFounderSession, type FounderSession } from '../../../lib/founder-session';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';

const NOW = new Date();
const URL_ = `${ORIGIN}/api/academy-course-links`;

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
const authed = () => {
  const { cookie, csrf } = session();
  return { cookie, origin: ORIGIN, 'x-intafaced-csrf': csrf };
};
const post = (body: unknown, headers: Record<string, string> = authed()) =>
  new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = (q = '') => new Request(`${URL_}${q}`, { headers: { cookie: session().cookie } });
const entitlement = () =>
  Response.json({ result: { data: { json: { status: 'enabled', userId: USER_ID, version: '1', changedAt: NOW.toISOString() } } } });
const ok = (data: unknown) => Response.json({ result: { data } });
const refusal = (code: string, status: number) =>
  Response.json({ error: { message: code, data: { httpStatus: status, cause: { code } } } }, { status });

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
const calls = <T extends { url: string }>(c: T[]) => c.filter((x) => !x.url.includes('operatorStatus'));
const sent = (c: { url: string; init: RequestInit }[], procedure: string) =>
  JSON.parse(String(calls(c).find((x) => x.url.includes(procedure))!.init.body));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const COURSE_ID = '66666666-6666-4666-8666-666666666666';
const LINK = {
  id: '77777777-7777-4777-8777-777777777777',
  reason: 'TEST reviewer',
  createdBy: '11111111-1111-4111-8111-111111111111',
  createdAt: '2026-10-23T10:00:00.000Z',
  revokedBy: null,
  revokedAt: null,
  revokeReason: null,
};
const LINK_KEY = 'k'.repeat(43);

describe('academy private links BFF (AC-catalogue-03)', () => {
  it('reads a course’s links; a missing course id never reaches the service', async () => {
    configure();
    const c = upstream({ 'admin.privateLinks': () => ok([LINK]) });
    const body = await (await GET(get(`?courseId=${COURSE_ID}`))).json();
    expect(body.links).toEqual({ kind: 'ok', data: [LINK] });
    expect(decodeURIComponent(calls(c)[0]!.url)).toContain(COURSE_ID);
    expect((await GET(get('?courseId=nope'))).status).toBe(400);
  });

  it('a new link answers with its path once; revoke needs a reason; an archived course is refused by name', async () => {
    configure();
    const c = upstream({
      'admin.createPrivateLink': () => ok({ link: LINK, key: LINK_KEY, path: `/academy/learning/course/risk-basics#key=${LINK_KEY}` }),
      'admin.revokePrivateLink': () => refusal('academy.private_link_not_found', 404),
    });
    expect(await (await POST(post({ op: 'create', courseId: COURSE_ID, reason: 'TEST reviewer' }))).json()).toEqual({
      ok: true,
      what: 'private link made',
      path: `/academy/learning/course/risk-basics#key=${LINK_KEY}`,
    });
    expect(sent(c, 'admin.createPrivateLink')).toEqual({ courseId: COURSE_ID, reason: 'TEST reviewer' });
    const before = calls(c).length;
    expect((await POST(post({ op: 'revoke', linkId: LINK.id, reason: '' }))).status).toBe(400);
    expect((await POST(post({ op: 'create', courseId: 'nope', reason: 'x' }))).status).toBe(400);
    expect(calls(c).length).toBe(before);
    const res = await POST(post({ op: 'revoke', linkId: LINK.id, reason: 'TEST done' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: 'academy.private_link_not_found' });
    upstream({ 'admin.createPrivateLink': () => refusal('academy.private_link_course_closed', 409) });
    expect(await (await POST(post({ op: 'create', courseId: COURSE_ID, reason: 'TEST' }))).json()).toMatchObject({
      ok: false,
      code: 'academy.private_link_course_closed',
    });
  });

  it('a change without the CSRF nonce is refused before any service call', async () => {
    configure();
    const c = upstream({});
    const { cookie } = session();
    expect((await POST(post({ op: 'revoke', linkId: LINK.id, reason: 'TEST' }, { cookie, origin: ORIGIN }))).status).toBe(403);
    expect(calls(c)).toHaveLength(0);
  });
});
