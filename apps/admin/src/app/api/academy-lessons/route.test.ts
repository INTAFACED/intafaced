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
const URL_ = `${ORIGIN}/api/academy-lessons`;
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

const LESSON = {
  courseId: COURSE_ID,
  courseTitle: 'Risk basics',
  courseState: 'draft',
  courseRevision: 3,
  item: { id: ITEM_ID, kind: 'lesson', title: 'Position size', indent: 0, url: null, lessonRevision: 1, liveRevision: null },
  revisions: [
    {
      revision: 1,
      source: 'saved',
      fromRevision: null,
      fromItemId: null,
      blocks: [{ type: 'text', markdown: 'One' }],
      actor: USER_ID,
      at: '2026-10-23T10:00:00.000Z',
    },
  ],
  importMaxBytes: 8192,
  draft: null,
  featured: false,
};

describe('academy lesson editor BFF', () => {
  it('a change without the CSRF nonce is refused before any service call', async () => {
    configure();
    const c = upstream({});
    const { cookie } = session();
    expect((await POST(post({ op: 'save', itemId: ITEM_ID, revision: 0, blocks: [] }, { cookie, origin: ORIGIN }))).status).toBe(403);
    expect(calls(c)).toHaveLength(0);
  });

  it('reads one lesson by item id; a malformed id never reaches the service', async () => {
    configure();
    const c = upstream({ 'admin.lesson': () => ok(LESSON) });
    expect((await GET(get('?itemId=nope'))).status).toBe(400);
    expect(calls(c)).toHaveLength(0);
    const body = await (await GET(get(`?itemId=${ITEM_ID}`))).json();
    expect(body.lesson).toEqual({ kind: 'ok', data: LESSON });
  });

  it('a save is checked for shape here: a script address or an unknown block type is refused before any call', async () => {
    configure();
    const c = upstream({ 'admin.saveLesson': () => ok(LESSON) });
    for (const blocks of [
      [{ type: 'image', url: 'javascript:alert(1)', alt: 'x' }],
      [{ type: 'iframe', url: 'https://example.com' }],
      [],
    ]) {
      const res = await POST(post({ op: 'save', itemId: ITEM_ID, revision: 0, blocks }));
      expect(res.status).toBe(400);
    }
    expect(calls(c)).toHaveLength(0);
    const blocks = [{ type: 'text', markdown: 'One' }];
    const res = await POST(post({ op: 'save', itemId: ITEM_ID, revision: 0, blocks }));
    expect(await res.json()).toMatchObject({ ok: true, what: 'lesson saved', lesson: LESSON });
    expect(sent(c, 'admin.saveLesson')).toEqual({ itemId: ITEM_ID, revision: 0, blocks });
  });

  it('a stale revision and an unknown op come back by name, with nothing changed', async () => {
    configure();
    upstream({ 'admin.revertLesson': () => refusal('academy.revision_stale', 409) });
    const res = await POST(post({ op: 'revert', itemId: ITEM_ID, revision: 2, toRevision: 1 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: 'academy.revision_stale', title: 'The lesson changed since you opened it' });
    expect((await POST(post({ op: 'delete', itemId: ITEM_ID }))).status).toBe(400);
  });

  it('publish needs a reason; duplicate sends the course revision read', async () => {
    configure();
    const c = upstream({ 'admin.publishLesson': () => ok(LESSON), 'admin.duplicateItem': () => ok(LESSON) });
    expect((await POST(post({ op: 'publish', itemId: ITEM_ID, lessonRevision: 1, courseRevision: 3, reason: ' ' }))).status).toBe(400);
    await POST(post({ op: 'publish', itemId: ITEM_ID, lessonRevision: 1, courseRevision: 3, reason: 'first cut' }));
    expect(sent(c, 'admin.publishLesson')).toEqual({ itemId: ITEM_ID, lessonRevision: 1, courseRevision: 3, reason: 'first cut' });
    await POST(post({ op: 'duplicate', itemId: ITEM_ID, courseRevision: 3 }));
    expect(sent(c, 'admin.duplicateItem')).toEqual({ itemId: ITEM_ID, courseRevision: 3 });
  });

  it('an import report lists each bad block with nothing created; an imported file answers with the lesson', async () => {
    configure();
    const problems = [{ block: 2, problem: 'unknown block type "iframe"' }];
    upstream({ 'admin.importLesson': () => ok({ outcome: 'invalid', problems, lesson: LESSON }) });
    const res = await POST(post({ op: 'import', itemId: ITEM_ID, revision: 1, document: '{}' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, code: 'academy.import_invalid', changed: 'no', problems });
    upstream({ 'admin.importLesson': () => ok({ outcome: 'imported', lesson: LESSON }) });
    const good = await POST(post({ op: 'import', itemId: ITEM_ID, revision: 1, document: '{}' }));
    expect(await good.json()).toMatchObject({ ok: true, what: 'imported', lesson: LESSON });
  });

  it('a file over the owner limit comes back by name; this route takes a lesson larger than 16 KiB', async () => {
    configure();
    const c = upstream({ 'admin.importLesson': () => refusal('academy.import_too_large', 400) });
    const document = 'x'.repeat(40_000);
    const res = await POST(post({ op: 'import', itemId: ITEM_ID, revision: 1, document }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'academy.import_too_large', title: 'The file is over the size limit' });
    expect(sent(c, 'admin.importLesson').document).toHaveLength(40_000);
  });

  it('the model path comes back as an owner decision by name; accept sends the draft it names', async () => {
    configure();
    const c = upstream({
      'admin.assistantDraft': () => refusal('owner.decision', 412),
      'admin.decideDraft': () => ok(LESSON),
    });
    const res = await POST(post({ op: 'draft', itemId: ITEM_ID, revision: 1, path: 'model' }));
    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ ok: false, code: 'owner.decision', title: 'Waiting for an owner decision' });
    await POST(post({ op: 'decide', itemId: ITEM_ID, basedOnRevision: 1, kind: 'template', decision: 'accept' }));
    expect(sent(c, 'admin.decideDraft')).toEqual({ itemId: ITEM_ID, basedOnRevision: 1, kind: 'template', decision: 'accept' });
  });

  it('feature fills the Learn hub slot then reads the lesson again; a lesson learners cannot read is refused by name', async () => {
    configure();
    const SLOT = {
      curriculum: null,
      lesson: {
        itemId: ITEM_ID,
        title: 'Position size',
        courseId: COURSE_ID,
        courseTitle: 'Risk basics',
        courseState: 'draft',
        liveRevision: 1,
      },
      reason: 'TEST',
      chosenBy: USER_ID,
      chosenAt: '2026-10-23T10:00:00.000Z',
    };
    const c = upstream({ 'admin.featureLesson': () => ok(SLOT), 'admin.lesson': () => ok({ ...LESSON, featured: true }) });
    const body = await (await POST(post({ op: 'feature', itemId: ITEM_ID, reason: 'TEST' }))).json();
    expect(body).toMatchObject({ ok: true, what: 'featured on the Learn hub', lesson: { featured: true } });
    expect(sent(c, 'admin.featureLesson')).toEqual({ itemId: ITEM_ID, reason: 'TEST' });
    upstream({ 'admin.featureLesson': () => refusal('academy.featured_not_live', 412) });
    const refused = await POST(post({ op: 'feature', itemId: ITEM_ID, reason: 'TEST' }));
    expect(refused.status).toBe(412);
    expect(await refused.json()).toMatchObject({ ok: false, code: 'academy.featured_not_live' });
    expect((await POST(post({ op: 'feature', itemId: ITEM_ID, reason: ' ' }))).status).toBe(400);
  });

  it('withdraw goes over the course revision read with a reason', async () => {
    configure();
    const c = upstream({ 'admin.withdrawLesson': () => ok(LESSON) });
    const body = await (await POST(post({ op: 'withdraw', itemId: ITEM_ID, courseRevision: 3, reason: 'TEST pulled' }))).json();
    expect(body).toMatchObject({ ok: true, what: 'withdrawn from learners' });
    expect(sent(c, 'admin.withdrawLesson')).toEqual({ itemId: ITEM_ID, courseRevision: 3, reason: 'TEST pulled' });
  });
});
