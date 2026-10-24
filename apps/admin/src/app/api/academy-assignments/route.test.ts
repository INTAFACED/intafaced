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
const URL_ = `${ORIGIN}/api/academy-assignments`;
const ITEM_ID = '44444444-4444-4444-8444-444444444444';

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

const ASSIGNMENT = {
  itemId: ITEM_ID,
  courseId: COURSE_ID,
  title: 'Position-size write-up',
  revision: 1,
  brief: { instructions: 'Size one trade.', points: '10', dueAt: '2026-10-25T12:00:00.000Z', text: 'required', file: 'required' },
  savedBy: USER_ID,
  savedAt: '2026-10-24T07:00:00.000Z',
  withdrawnAt: null,
  withdrawReason: null,
  learnersHandedIn: 0,
};
const BRIEF = { instructions: 'Size one trade.', points: '10', dueAt: '2026-10-25T12:00:00.000Z', text: 'required', file: 'required' };

describe('academy assignment editor BFF', () => {
  it('a change without the CSRF nonce is refused before any service call', async () => {
    configure();
    const c = upstream({});
    const { cookie } = session();
    expect((await POST(post({ op: 'save', itemId: ITEM_ID, revision: 0, ...BRIEF }, { cookie, origin: ORIGIN }))).status).toBe(403);
    expect(calls(c)).toHaveLength(0);
  });

  it('reads one assignment by item id; a malformed id never reaches the service', async () => {
    configure();
    const c = upstream({ 'admin.assignment': () => ok(ASSIGNMENT) });
    expect((await GET(get('?itemId=nope'))).status).toBe(400);
    expect(calls(c)).toHaveLength(0);
    const body = await (await GET(get(`?itemId=${ITEM_ID}`))).json();
    expect(body.assignment).toEqual({ kind: 'ok', data: ASSIGNMENT });
  });

  it('a save is checked for shape here: no answer at all, or points that are not a decimal, never reach the service', async () => {
    configure();
    const c = upstream({ 'admin.saveAssignment': () => ok(ASSIGNMENT) });
    for (const bad of [
      { ...BRIEF, text: 'off', file: 'off' },
      { ...BRIEF, points: '0' },
      { ...BRIEF, points: '1e3' },
      { ...BRIEF, instructions: ' ' },
    ]) {
      const res = await POST(post({ op: 'save', itemId: ITEM_ID, revision: 0, ...bad }));
      expect(res.status).toBe(400);
    }
    expect(calls(c)).toHaveLength(0);
    const res = await POST(post({ op: 'save', itemId: ITEM_ID, revision: 0, ...BRIEF }));
    expect(await res.json()).toMatchObject({ ok: true, what: 'assignment saved', assignment: ASSIGNMENT });
    expect(sent(c, 'admin.saveAssignment')).toEqual({ itemId: ITEM_ID, revision: 0, ...BRIEF });
  });

  it('a stale revision and a withdrawn assignment come back by name; withdraw needs a reason', async () => {
    configure();
    upstream({ 'admin.saveAssignment': () => refusal('academy.assignment_closed', 409) });
    const res = await POST(post({ op: 'save', itemId: ITEM_ID, revision: 1, ...BRIEF }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: 'academy.assignment_closed', title: 'Assignment withdrawn' });
    const c = upstream({
      'admin.withdrawAssignment': () => ok({ ...ASSIGNMENT, withdrawnAt: ASSIGNMENT.savedAt, withdrawReason: 'TEST' }),
    });
    expect((await POST(post({ op: 'withdraw', itemId: ITEM_ID, reason: ' ' }))).status).toBe(400);
    expect(calls(c)).toHaveLength(0);
    expect(await (await POST(post({ op: 'withdraw', itemId: ITEM_ID, reason: 'TEST' }))).json()).toMatchObject({
      ok: true,
      what: 'assignment withdrawn',
    });
    expect((await POST(post({ op: 'delete', itemId: ITEM_ID }))).status).toBe(400);
  });
});
