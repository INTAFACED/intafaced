import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { founderCookie, sealFounderSession, type FounderSession } from '../../../lib/founder-session';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const COURSE_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date();
const URL_ = `${ORIGIN}/api/academy-courses`;

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
const get = () => new Request(URL_, { headers: { cookie: session().cookie } });
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

const COURSE = {
  id: COURSE_ID,
  slug: 'risk-basics',
  title: 'Risk basics',
  summary: null,
  thumbnailUrl: null,
  pricing: 'paid',
  price: null,
  priceAsset: null,
  state: 'draft',
  revision: 1,
  items: 0,
  createdBy: USER_ID,
  createdAt: '2026-10-23T10:00:00.000Z',
  updatedAt: '2026-10-23T10:00:00.000Z',
};
const COUNTS = { draft: 1, published: 0, concluded: 0, archived: 0, deleted: 0 };

describe('academy course desk BFF', () => {
  it('a change without the CSRF nonce is refused before any service call', async () => {
    configure();
    const c = upstream({});
    const { cookie } = session();
    expect((await POST(post({ op: 'create', slug: 'risk-basics', title: 'Risk basics' }, { cookie, origin: ORIGIN }))).status).toBe(403);
    expect(calls(c)).toHaveLength(0);
  });

  it('the module switch answers 404', async () => {
    configure();
    process.env.ADMIN_MODULES = 'crm';
    expect((await GET(get())).status).toBe(404);
  });

  it('reads the list with a page size, and one course by id', async () => {
    configure();
    const c = upstream({
      'admin.courses': () => ok({ courses: [COURSE], counts: COUNTS }),
      'admin.course': () => ok({ course: COURSE, events: [] }),
    });
    const body = await (await GET(get())).json();
    expect(body.list).toEqual({ kind: 'ok', data: { courses: [COURSE], counts: COUNTS } });
    expect(decodeURIComponent(calls(c)[0]!.url)).toContain('"limit":100');
    const one = await (await GET(new Request(`${URL_}?courseId=${COURSE_ID}`, { headers: { cookie: session().cookie } }))).json();
    expect(one.detail).toEqual({ kind: 'ok', data: { course: COURSE, events: [] } });
    expect((await GET(new Request(`${URL_}?courseId=nope`, { headers: { cookie: session().cookie } }))).status).toBe(400);
  });

  it('creates a draft with blank fields as null and the slug trimmed, as the founder', async () => {
    configure();
    const c = upstream({ 'admin.createCourse': () => ok(COURSE) });
    const res = await POST(
      post({
        op: 'create',
        slug: ' risk-basics ',
        title: 'Risk basics',
        summary: '  ',
        thumbnailUrl: '',
        pricing: 'paid',
        price: '',
        priceAsset: '',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, what: 'created', course: COURSE });
    expect(sent(c, 'admin.createCourse')).toEqual({
      slug: 'risk-basics',
      title: 'Risk basics',
      summary: null,
      thumbnailUrl: null,
      pricing: 'paid',
      price: null,
      priceAsset: null,
    });
    expect(String(calls(c)[0]!.init.headers && (calls(c)[0]!.init.headers as Record<string, string>).authorization)).toBe(
      'Bearer founder-access-token',
    );
  });

  it('names a form mistake before anything is sent', async () => {
    configure();
    const c = upstream({});
    const bad = await POST(post({ op: 'create', slug: 'Risk Basics', title: 'Risk basics' }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).body).toContain('lower-case');
    expect((await POST(post({ op: 'create', slug: 'risk', title: 'R', thumbnailUrl: 'javascript:alert(1)' }))).status).toBe(400);
    expect((await POST(post({ op: 'move', courseId: COURSE_ID, to: 'deleted', revision: 1, reason: 'x' }))).status).toBe(400);
    expect((await POST(post({ op: 'move', courseId: COURSE_ID, to: 'published', revision: 1, reason: ' ' }))).status).toBe(400);
    expect(calls(c)).toHaveLength(0);
  });

  it('a reserved address and a paid course with no price come back as named refusals, nothing changed', async () => {
    configure();
    upstream({
      'admin.createCourse': () => refusal('academy.slug_reserved', 400),
      'admin.setCourseState': () => refusal('academy.price_unset', 412),
    });
    const reserved = await (await POST(post({ op: 'create', slug: 'videos', title: 'Videos' }))).json();
    expect(reserved).toMatchObject({ ok: false, code: 'academy.slug_reserved', title: 'That address is an Academy tab', changed: 'no' });
    const res = await POST(post({ op: 'move', courseId: COURSE_ID, to: 'published', revision: 1, reason: 'ready' }));
    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ ok: false, code: 'academy.price_unset', title: 'A paid course needs a price', changed: 'no' });
  });

  it('a dropped reply on a change is an unknown outcome, never a failure', async () => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('accountControls.operatorStatus')) return entitlement();
        throw new TypeError('fetch failed');
      }),
    );
    const body = await (await POST(post({ op: 'update', courseId: COURSE_ID, revision: 1, title: 'Risk basics', pricing: 'free' }))).json();
    expect(body).toMatchObject({ ok: false, changed: 'unknown' });
  });
});
