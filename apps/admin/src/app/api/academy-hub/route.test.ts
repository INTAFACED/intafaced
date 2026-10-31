import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { founderCookie, sealFounderSession, type FounderSession } from '../../../lib/founder-session';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';

const NOW = new Date();
const URL_ = `${ORIGIN}/api/academy-hub`;

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
const calls = <T extends { url: string }>(c: T[]) =>
  c.filter((x) => !x.url.includes('operatorStatus') && !x.url.includes('consoleMode.get'));
const sent = (c: { url: string; init: RequestInit }[], procedure: string) =>
  JSON.parse(String(calls(c).find((x) => x.url.includes(procedure))!.init.body));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const EMPTY_SLOT = { curriculum: null, lesson: null, reason: null, chosenBy: null, chosenAt: null };
const TOPIC = { id: '55555555-5555-4555-8555-555555555555', slug: 'risk', name: 'Risk', createdAt: '2026-10-23T10:00:00.000Z' };

describe('academy Learn hub desk BFF (AC-articles-01)', () => {
  it('reads the featured slot and the topics; a blank topic limit comes back by name without hiding the slot', async () => {
    configure();
    upstream({ 'admin.featuredSlot': () => ok(EMPTY_SLOT), 'admin.topics': () => ok({ topics: [TOPIC], limit: 100 }) });
    const body = await (await GET(get())).json();
    expect(body.slot).toEqual({ kind: 'ok', data: EMPTY_SLOT });
    expect(body.topics).toEqual({ kind: 'ok', data: { topics: [TOPIC], limit: 100 } });
    upstream({ 'admin.featuredSlot': () => ok(EMPTY_SLOT), 'admin.topics': () => refusal('academy.topics_list_limit_unset', 412) });
    const blank = await (await GET(get())).json();
    expect(blank.slot.kind).toBe('ok');
    expect(blank.topics).toMatchObject({ kind: 'failed', code: 'academy.topics_list_limit_unset' });
  });

  it('a topic at an Academy tab address is refused by name; a bad address never reaches the service; clear needs a reason', async () => {
    configure();
    const c = upstream({ 'admin.createTopic': () => refusal('academy.slug_reserved', 400), 'admin.clearFeatured': () => ok(EMPTY_SLOT) });
    const res = await POST(post({ op: 'topic', slug: 'learning', name: 'Learning' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: 'academy.slug_reserved', title: 'That address is an Academy tab' });
    expect(sent(c, 'admin.createTopic')).toEqual({ slug: 'learning', name: 'Learning' });
    const before = calls(c).length;
    expect((await POST(post({ op: 'topic', slug: 'Not An Address', name: 'X' }))).status).toBe(400);
    expect((await POST(post({ op: 'clear', reason: '' }))).status).toBe(400);
    expect(calls(c).length).toBe(before);
    expect(await (await POST(post({ op: 'clear', reason: 'TEST' }))).json()).toEqual({ ok: true, what: 'nothing is featured' });
  });

  it('a curriculum article is featured by its address with a reason; an unknown address is refused by name; blanks never reach the service', async () => {
    configure();
    const c = upstream({ 'admin.setFeatured': () => ok({ itemSlug: 'risk-basics', reason: 'TEST', chosenAt: NOW.toISOString() }) });
    expect(await (await POST(post({ op: 'item', itemSlug: 'risk-basics', reason: 'TEST' }))).json()).toEqual({
      ok: true,
      what: 'featured on the Learn hub',
    });
    expect(sent(c, 'admin.setFeatured')).toEqual({ itemSlug: 'risk-basics', reason: 'TEST' });
    const before = calls(c).length;
    expect((await POST(post({ op: 'item', itemSlug: '', reason: 'TEST' }))).status).toBe(400);
    expect((await POST(post({ op: 'item', itemSlug: 'risk-basics', reason: '  ' }))).status).toBe(400);
    expect((await POST(post({ op: 'item', itemSlug: 'risk-basics', reason: 'TEST', extra: 1 }))).status).toBe(400);
    expect(calls(c).length).toBe(before);
    upstream({ 'admin.setFeatured': () => refusal('academy.curriculum_not_found', 404) });
    const gone = await POST(post({ op: 'item', itemSlug: 'no-such-item', reason: 'TEST' }));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ ok: false, code: 'academy.curriculum_not_found' });
  });

  it('a change without the CSRF nonce is refused before any service call', async () => {
    configure();
    const c = upstream({});
    const { cookie } = session();
    expect((await POST(post({ op: 'clear', reason: 'TEST' }, { cookie, origin: ORIGIN }))).status).toBe(403);
    expect(calls(c)).toHaveLength(0);
  });
});
