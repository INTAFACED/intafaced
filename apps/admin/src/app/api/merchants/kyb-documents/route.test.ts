import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { founderCookie, sealFounderSession, type FounderSession } from '../../../../lib/founder-session';

// TEST DATA ONLY: ids and bytes below stand in for a merchant's upload.
const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date();
const URL_ = `${ORIGIN}/api/merchants/kyb-documents`;
const APPLICATION = 'ab000001-0000-4000-8000-000000000001';
const DOCUMENT = 'ac000001-0000-4000-8000-000000000001';
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
const row = (state: 'accepted' | 'rejected', rejectionReason: string | null = null) => ({
  row: {
    key: 'test_proof_of_address',
    state,
    rejectionReason,
    document: { id: DOCUMENT, contentType: 'application/pdf', byteLength: 4, sha256: SHA, uploadedAt: NOW.toISOString() },
  },
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('business document review BFF', () => {
  it('is founder-only: no cookie is 401 and nothing reaches the service; GET is not allowed', async () => {
    configure();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await POST(post({ action: 'review' }, { origin: ORIGIN }));
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(fetchMock).not.toHaveBeenCalled();
    upstream({});
    expect((await GET(new Request(URL_, { headers: authed() }))).status).toBe(405);
  });

  it('sends a verdict as the founder, with a reason only for a rejection', async () => {
    configure();
    const calls = upstream({ 'kyb.documents.review': () => ok(row('rejected', 'TEST cut off')) });
    const res = await POST(
      post(
        { action: 'review', applicationId: APPLICATION, documentId: DOCUMENT, verdict: 'rejected', reason: '  TEST cut off ' },
        authed(),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, row: { state: 'rejected', rejectionReason: 'TEST cut off' } });
    const call = calls.find((c) => c.url.includes('kyb.documents.review'))!;
    expect(JSON.parse(String(call.init.body))).toEqual({
      applicationId: APPLICATION,
      documentId: DOCUMENT,
      verdict: 'rejected',
      reason: 'TEST cut off',
    });
    expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer founder-access-token');
  });

  it('refuses a malformed request before any service call', async () => {
    configure();
    const calls = upstream({});
    for (const body of [
      { action: 'review', applicationId: 'x', documentId: DOCUMENT, verdict: 'accepted' },
      { action: 'review', applicationId: APPLICATION, documentId: DOCUMENT, verdict: 'maybe' },
      { action: 'review', applicationId: APPLICATION, documentId: DOCUMENT, verdict: 'rejected' },
      { action: 'review', applicationId: APPLICATION, documentId: DOCUMENT, verdict: 'accepted', reason: 'TEST fine' },
      { action: 'delete', applicationId: APPLICATION, documentId: DOCUMENT },
    ]) {
      expect((await POST(post(body, authed()))).status).toBe(400);
    }
    expect(calls.some((c) => c.url.includes('kyb.documents'))).toBe(false);
  });

  it('a refusal comes back in words, never as a code alone', async () => {
    configure();
    upstream({
      'kyb.documents.review': () =>
        Response.json(
          {
            error: {
              json: {
                message: 'already',
                data: { code: 'CONFLICT', httpStatus: 409, cause: { code: 'pay.kyb_document_already_reviewed' } },
              },
            },
          },
          { status: 409 },
        ),
    });
    const res = await POST(post({ action: 'review', applicationId: APPLICATION, documentId: DOCUMENT, verdict: 'accepted' }, authed()));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, refusal: { title: 'This document already has a verdict' } });
  });

  it('returns a file to open', async () => {
    configure();
    upstream({
      'kyb.documents.file': () =>
        ok({ documentId: DOCUMENT, key: 'test_proof_of_address', contentType: 'application/pdf', sha256: SHA, bytesBase64: 'VEVTVA==' }),
    });
    const res = await POST(post({ action: 'file', applicationId: APPLICATION, documentId: DOCUMENT }, authed()));
    expect(await res.json()).toMatchObject({ ok: true, file: { bytesBase64: 'VEVTVA==', contentType: 'application/pdf' } });
  });
});
