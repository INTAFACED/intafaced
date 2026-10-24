import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { ADMIN_COOKIE, founderCookie, sealFounderSession, type FounderSession } from '../../../../lib/founder-session';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const APPROVAL = '44444444-4444-4444-8444-444444444444';
const HASH = `sha256:${'c'.repeat(64)}`;
const OPERATION = '55555555-5555-4555-8555-555555555555';
const NOW = new Date();
const URL_ = `${ORIGIN}/api/merchants/categories`;

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
  const sealed = sealFounderSession(s, { origin: ORIGIN, edgeUrl: EDGE, key: KEY }, NOW);
  return { cookie: founderCookie(sealed, 3600).split(';')[0]!, csrf: s.csrf };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const authed = () => {
  const { cookie, csrf } = session();
  return { cookie, origin: ORIGIN, 'x-intafaced-csrf': csrf };
};
const entitlement = (status: 'enabled' | 'revoked' | 'not_operator') =>
  Response.json({
    result: {
      data: {
        json:
          status === 'not_operator' ? { status, userId: USER_ID } : { status, userId: USER_ID, version: '1', changedAt: NOW.toISOString() },
      },
    },
  });
const ok = (data: unknown) => Response.json({ result: { data } });
const refusedWith = (status: number, code: string) =>
  Response.json({ error: { message: code, data: { cause: { code }, httpStatus: status } } }, { status });

function upstream(handlers: Record<string, (init: RequestInit, url: string) => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('accountControls.operatorStatus')) return entitlement('enabled');
      const key = Object.keys(handlers).find((k) => url.includes(k));
      if (!key) throw new Error(`unexpected upstream call ${url}`);
      return handlers[key]!(init, url);
    }),
  );
  return calls;
}
const serviceCalls = <T extends { url: string }>(calls: T[]) => calls.filter((c) => !c.url.includes('operatorStatus'));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// TEST DATA ONLY: one high-risk category with a TEST reserve; no live magnitude.
const change = {
  key: 'test-gaming',
  label: 'TEST gaming',
  class: 'restricted',
  reserve: { percent: '5.00', holdDays: 90 },
  extraDocuments: ['TEST gaming licence'],
  expectedVersion: null,
  reason: 'TEST add a high-risk category',
};
const preview = { needsDualControl: true, reasons: ['category_added'], actionType: 'pay.business_category_change', payloadHash: HASH };
const approval = (status: string, approverId: string | null = null) => ({
  approvalId: APPROVAL,
  actionType: 'pay.business_category_change',
  targetService: 'svc-pay',
  targetId: 'pay.business_category_change',
  expectedVersion: '1',
  payloadHash: HASH,
  requesterId: USER_ID,
  approverId,
  policyVersion: 'v1',
  createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
  status,
  operationId: OPERATION,
});
const saved = {
  ...change,
  expectedVersion: undefined,
  reason: undefined,
  version: 1,
  updatedAt: NOW.toISOString(),
  updatedBy: USER_ID,
  approvedBy: OTHER,
};
delete (saved as Record<string, unknown>).expectedVersion;
delete (saved as Record<string, unknown>).reason;
const previewInput = (url: string) => JSON.parse(decodeURIComponent(new URL(url).searchParams.get('input')!));

describe('G6: the category BFF refuses everything that is not a signed-in founder, and says no-store', () => {
  it('no cookie is 401 no-store and a forged cookie 401, neither reaching a service', async () => {
    configure();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const none = await POST(post({ action: 'preview', change }, { origin: ORIGIN }));
    expect(none.status).toBe(401);
    expect(none.headers.get('cache-control')).toBe('no-store');
    expect((await POST(post({ action: 'preview', change }, { origin: ORIGIN, cookie: `${ADMIN_COOKIE}=forged` }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST needs the exact origin and the CSRF nonce; GET is 405', async () => {
    configure();
    const { cookie, csrf } = session();
    expect(
      (await POST(post({ action: 'preview', change }, { cookie, origin: 'https://evil.example', 'x-intafaced-csrf': csrf }))).status,
    ).toBe(403);
    expect((await POST(post({ action: 'preview', change }, { cookie, origin: ORIGIN }))).status).toBe(403);
    upstream({});
    expect((await GET(new Request(URL_, { headers: authed() }))).status).toBe(405);
  });

  it('a signed-in user who is not a founder is refused', async () => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => entitlement('not_operator')),
    );
    const res = await POST(post({ action: 'preview', change }, authed()));
    expect(res.status).toBe(403);
  });
});

describe('the category BFF checks the change, then binds every step to the reviewed hash', () => {
  it('refuses a change svc-pay would refuse, and an unknown action, before any service call', async () => {
    configure();
    const calls = upstream({});
    for (const body of [
      { action: 'preview', change: { ...change, class: 'permissionless' } },
      { action: 'preview', change: { ...change, key: 'Not A Key' } },
      { action: 'preview', change: { ...change, reserve: { percent: '0', holdDays: 90 } } },
      { action: 'preview', change: { ...change, actorId: OTHER } },
      { action: 'save', change, approvalId: '', operationId: OPERATION },
      { action: 'delete', change },
    ]) {
      const res = await POST(post(body, authed()));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(serviceCalls(calls)).toHaveLength(0);
  });

  it('preview asks svc-pay with exactly the checked change', async () => {
    configure();
    const calls = upstream({ 'categoryPolicy.preview': () => ok(preview) });
    const res = await POST(post({ action: 'preview', change }, authed()));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as { preview: typeof preview }).preview.payloadHash).toBe(HASH);
    const [call] = serviceCalls(calls);
    expect(previewInput(call!.url)).toEqual(change);
  });

  it('propose sends identity the preview hash and type, never a hash from the browser', async () => {
    configure();
    const calls = upstream({ 'categoryPolicy.preview': () => ok(preview), 'actionApproval.propose': () => ok(approval('PENDING')) });
    const res = await POST(post({ action: 'propose', change, payloadHash: `sha256:${'f'.repeat(64)}` }, authed()));
    expect(res.status).toBe(200);
    const sent = JSON.parse(String(serviceCalls(calls).at(-1)!.init.body));
    expect(sent).toMatchObject({ actionType: 'pay.business_category_change', targetService: 'svc-pay', payloadHash: HASH });
  });

  it('approve binds the other founder to the change they reviewed', async () => {
    configure();
    const calls = upstream({
      'categoryPolicy.preview': () => ok(preview),
      'actionApproval.approve': () => ok(approval('APPROVED', USER_ID)),
    });
    const res = await POST(post({ action: 'approve', change, approvalId: APPROVAL }, authed()));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { matchesReviewedChange: boolean }).matchesReviewedChange).toBe(true);
    expect(JSON.parse(String(serviceCalls(calls).at(-1)!.init.body))).toEqual({ approvalId: APPROVAL, expectedPayloadHash: HASH });
  });

  it('save writes with the approval, and a svc-pay refusal reads as plain words', async () => {
    configure();
    const calls = upstream({ 'categoryPolicy.preview': () => ok(preview), 'categoryPolicy.set': () => ok(saved) });
    const res = await POST(post({ action: 'save', change, approvalId: APPROVAL, operationId: OPERATION }, authed()));
    expect(res.status).toBe(200);
    expect(JSON.parse(String(serviceCalls(calls).at(-1)!.init.body))).toEqual({ ...change, approvalId: APPROVAL, operationId: OPERATION });

    upstream({ 'categoryPolicy.preview': () => refusedWith(409, 'pay.category_exists') });
    const refused = await POST(post({ action: 'save', change, approvalId: APPROVAL, operationId: OPERATION }, authed()));
    expect(refused.status).toBe(409);
    const words = JSON.stringify(await refused.json());
    expect(words).not.toMatch(/"title":"[^"]*pay\./);
  });

  it('reject declines the approval without asking svc-pay anything', async () => {
    configure();
    const calls = upstream({ 'actionApproval.reject': () => ok(approval('REJECTED', USER_ID)) });
    const res = await POST(post({ action: 'reject', approvalId: APPROVAL }, authed()));
    expect(res.status).toBe(200);
    expect(serviceCalls(calls).map((c) => c.url)).toEqual([`${EDGE}/api/identity/trpc/actionApproval.reject`]);
  });
});
