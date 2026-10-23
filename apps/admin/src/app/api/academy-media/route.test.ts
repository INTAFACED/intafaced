import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { POST as UPLOAD } from './upload/route';
import { checkBeforeUpload } from '../../../lib/academy/media-model';
import { founderCookie, sealFounderSession, type FounderSession } from '../../../lib/founder-session';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const COURSE_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date();
const URL_ = `${ORIGIN}/api/academy-media`;
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

function upstream(handlers: Record<string, (init: RequestInit, url: string) => Response | Promise<Response>>) {
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

const MEDIA_ID = '55555555-5555-4555-8555-555555555555';
const STORE = 'http://store.test:9000/academy/courses/c/items/i/handout/x?X-Amz-Signature=abc';
const LIMITS = { maxBytes: 1024, videoTypes: ['video/webm'], handoutTypes: ['application/pdf'] };
const ITEM_MEDIA = { itemId: ITEM_ID, videoId: null, limits: LIMITS, media: [], captions: [] };
const PDF_BYTES: Uint8Array<ArrayBuffer> = new TextEncoder().encode('%PDF-1.4 test handout');
const sha = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
const MEDIA = (state: 'pending' | 'ready' | 'refused') => ({
  id: MEDIA_ID,
  kind: 'handout',
  fileName: 'sheet.pdf',
  contentType: 'application/pdf',
  bytes: PDF_BYTES.length,
  state,
  refusal: state === 'refused' ? 'the file was declared application/pdf but its content is image/png' : null,
  createdAt: '2026-10-23T10:00:00.000Z',
  url: null,
});
const upload = (query: Record<string, string>, body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = authed()) =>
  new Request(`${ORIGIN}/api/academy-media/upload?${new URLSearchParams(query).toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', ...headers },
    body,
  });

describe('academy course files BFF (AC-videos-02)', () => {
  it('reads an item’s files and limits; a malformed caption line comes back as 422 with nothing saved', async () => {
    configure();
    const c = upstream({
      'admin.itemMedia': () => ok(ITEM_MEDIA),
      'admin.setItemCaptions': () =>
        ok({ outcome: 'invalid', problem: 'line 6: "00:00:05.000" is not an SRT timestamp', media: ITEM_MEDIA }),
    });
    const read = await (await GET(get(`?itemId=${ITEM_ID}`))).json();
    expect(read.media).toEqual({ kind: 'ok', data: ITEM_MEDIA });
    expect((await GET(get('?itemId=nope'))).status).toBe(400);
    const res = await POST(post({ op: 'captions', itemId: ITEM_ID, language: 'en', label: 'English', format: 'srt', text: 'x' }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: 'academy.captions_invalid',
      body: 'line 6: "00:00:05.000" is not an SRT timestamp',
    });
    expect(sent(c, 'admin.setItemCaptions')).toMatchObject({ itemId: ITEM_ID, format: 'srt' });
    expect((await POST(post({ op: 'intent' }))).status).toBe(400);
  });

  it('an upload without the CSRF nonce is refused before any service call', async () => {
    configure();
    const c = upstream({});
    const { cookie } = session();
    const res = await UPLOAD(upload({ itemId: ITEM_ID }, PDF_BYTES, { cookie, origin: ORIGIN }));
    expect(res.status).toBe(403);
    expect(calls(c)).toHaveLength(0);
  });

  it('a refused declaration comes back by name and no byte goes to storage', async () => {
    configure();
    const c = upstream({ 'admin.mediaUploadIntent': () => refusal('academy.upload_limits_unset', 412) });
    const res = await UPLOAD(
      upload(
        { itemId: ITEM_ID, kind: 'handout', fileName: 'sheet.pdf', bytes: String(PDF_BYTES.length), sha256: await sha(PDF_BYTES) },
        PDF_BYTES,
      ),
    );
    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ ok: false, code: 'academy.upload_limits_unset', changed: 'no' });
    expect(calls(c).map((x) => x.url)).toEqual([expect.stringContaining('admin.mediaUploadIntent')]);
  });

  it('declares, streams the bytes to the address svc-academy issued, then confirms; a type mismatch is refused by name', async () => {
    configure();
    const stored: Uint8Array[] = [];
    const c = upstream({
      'admin.mediaUploadIntent': () => ok({ media: MEDIA('pending'), uploadUrl: STORE }),
      'store.test': async (init) => {
        stored.push(new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()));
        return new Response(null, { status: 200 });
      },
      'admin.confirmMedia': () => refusal('academy.file_type_mismatch', 400),
    });
    const query = {
      itemId: ITEM_ID,
      kind: 'handout',
      fileName: 'sheet.pdf',
      bytes: String(PDF_BYTES.length),
      sha256: await sha(PDF_BYTES),
    };
    const res = await UPLOAD(upload(query, PDF_BYTES));
    expect(sent(c, 'admin.mediaUploadIntent')).toEqual({ ...query, bytes: PDF_BYTES.length, contentType: 'application/pdf' });
    const put = calls(c).find((x) => x.url.includes('store.test'))!;
    expect(put.url).toBe(STORE);
    expect(put.init.method).toBe('PUT');
    expect(stored).toEqual([PDF_BYTES]);
    expect(sent(c, 'admin.confirmMedia')).toEqual({ mediaId: MEDIA_ID });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: 'academy.file_type_mismatch' });
  });

  it('bytes that are not the declared fingerprint are never confirmed', async () => {
    configure();
    const c = upstream({
      'admin.mediaUploadIntent': () => ok({ media: MEDIA('pending'), uploadUrl: STORE }),
      'store.test': async (init) => {
        // Drain the stream as a store would.
        await new Response(init.body as BodyInit).arrayBuffer();
        return new Response(null, { status: 200 });
      },
      'admin.confirmMedia': () => ok(MEDIA('ready')),
    });
    const res = await UPLOAD(
      upload(
        { itemId: ITEM_ID, kind: 'handout', fileName: 'sheet.pdf', bytes: String(PDF_BYTES.length), sha256: 'a'.repeat(64) },
        PDF_BYTES,
      ),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, code: 'academy.upload_incomplete' });
    expect(calls(c).some((x) => x.url.includes('admin.confirmMedia'))).toBe(false);
  });

  it('a file already stored is confirmed without sending its bytes again', async () => {
    configure();
    const c = upstream({
      'admin.mediaUploadIntent': () => ok({ media: MEDIA('ready'), uploadUrl: null }),
      'admin.confirmMedia': () => ok(MEDIA('ready')),
    });
    const res = await UPLOAD(
      upload(
        { itemId: ITEM_ID, kind: 'handout', fileName: 'sheet.pdf', bytes: String(PDF_BYTES.length), sha256: await sha(PDF_BYTES) },
        PDF_BYTES,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, what: 'checked and stored', media: { state: 'ready' } });
    expect(calls(c).some((x) => x.url.includes('store.test'))).toBe(false);
  });
});

describe('the browser’s own check before an upload', () => {
  it('blank limits, over the size and a type not accepted are refused with no request', () => {
    expect(
      checkBeforeUpload({ maxBytes: null, videoTypes: null, handoutTypes: null }, 'video', { size: 1, type: 'video/webm' }),
    ).toMatchObject({
      ok: false,
      title: 'The upload limits are not set',
    });
    expect(checkBeforeUpload(LIMITS, 'video', { size: 2048, type: 'video/webm' })).toMatchObject({
      ok: false,
      title: 'The file is over the size limit',
    });
    expect(checkBeforeUpload(LIMITS, 'handout', { size: 10, type: 'image/png' })).toMatchObject({
      ok: false,
      title: 'This file type is not accepted',
    });
    expect(checkBeforeUpload(LIMITS, 'handout', { size: 10, type: 'application/pdf' })).toEqual({ ok: true });
  });
});
