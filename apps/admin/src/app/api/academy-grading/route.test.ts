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
const URL_ = `${ORIGIN}/api/academy-grading`;
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
const calls = <T extends { url: string }>(c: T[]) =>
  c.filter((x) => !x.url.includes('operatorStatus') && !x.url.includes('consoleMode.get'));
const sent = (c: { url: string; init: RequestInit }[], procedure: string) =>
  JSON.parse(String(calls(c).find((x) => x.url.includes(procedure))!.init.body));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const SUB_ID = '55555555-5555-4555-8555-555555555555';
const QUEUE = {
  itemId: ITEM_ID,
  courseId: COURSE_ID,
  title: 'Write-up',
  points: '10',
  leaseSeconds: 900,
  rows: [
    {
      submissionId: SUB_ID,
      alias: 1,
      version: 1,
      submittedAt: NOW.toISOString(),
      late: false,
      text: 'TEST answer',
      file: null,
      peerReviews: { received: 0, meanTotal: null },
      grade: null,
      nextN: 1,
      lease: null,
    },
  ],
};
const GRADE = { itemId: ITEM_ID, submissionId: SUB_ID, n: 1, score: '8', comment: 'TEST Clear sizing.', reason: null };

describe('academy grading BFF (AC-assignments-02)', () => {
  it('reads the queue for one item, and refuses a missing item id before calling svc-academy', async () => {
    configure();
    const c = upstream({ 'admin.gradingQueue': () => ok(QUEUE) });
    expect((await GET(get())).status).toBe(400);
    expect(calls(c)).toHaveLength(0);
    const res = await GET(get(`?itemId=${ITEM_ID}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ queue: { kind: 'ok', data: QUEUE } });
  });

  it('checks a grade for shape here, sends a good one as is, and words a locked hand-in', async () => {
    configure();
    const c = upstream({ 'admin.gradeSubmission': () => ok(QUEUE) });
    for (const bad of [
      { ...GRADE, score: '-1' },
      { ...GRADE, score: '8.123' },
      { ...GRADE, n: 0 },
      { ...GRADE, extra: 1 },
    ]) {
      expect((await POST(post({ op: 'grade', ...bad }))).status).toBe(400);
    }
    expect((await POST(post({ op: 'regrade', ...GRADE }))).status).toBe(400);
    expect(calls(c)).toHaveLength(0);
    expect(await (await POST(post({ op: 'grade', ...GRADE }))).json()).toMatchObject({ ok: true, what: 'grade saved' });
    expect(sent(c, 'admin.gradeSubmission')).toEqual(GRADE);
    upstream({ 'admin.gradeSubmission': () => refusal('academy.grader_locked', 409) });
    const res = await POST(post({ op: 'grade', ...GRADE }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: 'academy.grader_locked' });
  });

  it('refuses a post with no founder session or no CSRF token', async () => {
    configure();
    const c = upstream({ 'admin.openGrading': () => ok(QUEUE) });
    expect((await POST(post({ op: 'open', itemId: ITEM_ID, submissionId: SUB_ID }, { origin: ORIGIN }))).status).toBeGreaterThanOrEqual(
      400,
    );
    const { cookie } = session();
    expect(
      (await POST(post({ op: 'open', itemId: ITEM_ID, submissionId: SUB_ID }, { cookie, origin: ORIGIN }))).status,
    ).toBeGreaterThanOrEqual(400);
    expect(calls(c)).toHaveLength(0);
  });
});
