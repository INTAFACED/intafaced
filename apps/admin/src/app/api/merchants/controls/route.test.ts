import { founderChangeHash } from '@intafaced/contracts/founder-change-hash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { ADMIN_COOKIE, founderCookie, sealFounderSession, type FounderSession } from '../../../../lib/founder-session';

const ORIGINAL_ENV = { ...process.env };
const ORIGIN = 'https://admin.example';
const EDGE = 'http://edge:4000';
const KEY = Buffer.alloc(32, 4);
const USER_ID = '11111111-1111-4111-8111-111111111111';
const MID = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';
const APPROVAL = '44444444-4444-4444-8444-444444444444';
const HASH = `sha256:${'c'.repeat(64)}`;
const NOW = new Date();
const URL_ = `${ORIGIN}/api/merchants/controls`;

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
const serviceCalls = <T extends { url: string }>(calls: T[]) =>
  calls.filter((c) => !c.url.includes('operatorStatus') && !c.url.includes('consoleMode.get'));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const change = { kind: 'set_caps', caps: [{ kind: 'daily_intake', assetCode: 'USDT', limit: '1000' }] };
const submitBody = { action: 'submit', requestId: REQ, merchantId: MID, change, reason: 'Raise the cap', expectedVersion: '0' };
const shown = { requestId: REQ, merchantId: MID, change, expectedVersion: '3', reason: 'Checked it' };
const profile = {
  merchantId: MID,
  tierId: null,
  archetypeId: null,
  caps: null,
  pricing: null,
  reserve: null,
  version: '0',
  updatedAt: null,
};
const result = (outcome: string) => ({
  requestId: REQ,
  merchantId: MID,
  outcome,
  actorUserId: USER_ID,
  profile,
  occurredAt: NOW.toISOString(),
});
const approval = (status: string) => ({
  approvalId: APPROVAL,
  merchantId: MID,
  settlementId: '55555555-5555-4555-8555-555555555555',
  amount: '10',
  assetCode: 'USDT',
  payloadHash: HASH,
  status,
  makerUserId: USER_ID,
  checkerUserId: null,
  railId: 'crypto-native',
  destinationKind: 'crypto',
  destinationMasked: '0x0000…0f01',
  createdAt: NOW.toISOString(),
  decidedAt: null,
  expiresAt: NOW.toISOString(),
});

describe('G6: the controls BFF refuses everything that is not a signed-in founder, and says no-store', () => {
  it('no session configuration is 503, no cookie 401, a forged cookie 401, all no-store, none reaching a service', async () => {
    delete process.env.ADMIN_ORIGIN;
    expect((await POST(post(submitBody))).status).toBe(503);
    configure();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const none = await POST(post(submitBody, { origin: ORIGIN }));
    expect(none.status).toBe(401);
    expect(none.headers.get('cache-control')).toBe('no-store');
    expect((await POST(post(submitBody, { origin: ORIGIN, cookie: `${ADMIN_COOKIE}=forged` }))).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST needs the exact origin and the CSRF nonce', async () => {
    configure();
    const { cookie, csrf } = session();
    expect((await POST(post(submitBody, { cookie, origin: 'https://evil.example', 'x-intafaced-csrf': csrf }))).status).toBe(403);
    expect((await POST(post(submitBody, { cookie, origin: ORIGIN }))).status).toBe(403);
  });

  it.each(['not_operator', 'revoked'] as const)('a signed-in user who is %s is refused', async (status) => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => entitlement(status)),
    );
    const res = await POST(post(submitBody, authed()));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'admin.founder_required' });
  });

  it('the module switched off is 404 before anything else; GET is 405', async () => {
    configure();
    process.env.ADMIN_MODULES = 'crm';
    expect((await POST(post(submitBody, authed()))).status).toBe(404);
    expect((await GET(new Request(URL_))).status).toBe(404);
    delete process.env.ADMIN_MODULES;
    upstream({});
    const res = await GET(new Request(URL_, { headers: { cookie: session().cookie } }));
    expect(res.status).toBe(405);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST as a signed-in founder', () => {
  it('rejects bodies it does not understand with 400 before any service call', async () => {
    configure();
    const calls = upstream({});
    for (const body of [
      { action: 'nope' },
      { ...submitBody, requestId: 'x' },
      { ...submitBody, reason: 'no' },
      { ...submitBody, expectedVersion: '01' },
      { ...submitBody, change: { kind: 'set_caps', caps: [] } },
      { ...submitBody, change: { kind: 'set_caps', caps: [{ kind: 'daily_intake', assetCode: 'USDT', limit: 1000 }] } },
      { ...submitBody, actorUserId: USER_ID, change: { kind: 'wipe' } },
      { action: 'confirm', requestId: REQ },
      { action: 'confirm', requestId: REQ, reason: 'fine' },
      { ...shown, action: 'confirm', requestId: 'x', reason: 'fine' },
      { ...shown, action: 'confirm', change: { kind: 'wipe' } },
      { ...shown, action: 'decline', merchantId: 'nope' },
      { ...shown, action: 'confirm', expectedVersion: '01' },
      { action: 'decide', approvalId: APPROVAL, decision: 'maybe', expectedPayloadHash: HASH, reason: 'fine' },
      { action: 'decide', approvalId: APPROVAL, decision: 'approve', expectedPayloadHash: 'sha256:short', reason: 'fine' },
      { action: 'decide', approvalId: 'not-a-uuid', decision: 'approve', expectedPayloadHash: HASH, reason: 'fine' },
      { action: 'decide', approvalId: APPROVAL, decision: 'approve', expectedPayloadHash: HASH, reason: 'no' },
    ]) {
      const res = await POST(post(body, authed()));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(serviceCalls(calls)).toHaveLength(0);
  });

  it('submit forwards exactly the validated input as the founder, never an actor, and returns the outcome', async () => {
    configure();
    const calls = upstream({ 'founderAdmin.changes.submit': () => ok(result('pending_second_approval')) });
    const res = await POST(post({ ...submitBody, extra: 'ignored' }, authed()));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { ok: boolean; result: { outcome: string } };
    expect(body.ok).toBe(true);
    expect(body.result.outcome).toBe('pending_second_approval');
    const [call] = serviceCalls(calls);
    expect(call!.url).toBe(`${EDGE}/api/pay/trpc/founderAdmin.changes.submit`);
    expect((call!.init.headers as Record<string, string>).authorization).toBe('Bearer founder-access-token');
    expect(JSON.parse(String(call!.init.body))).toEqual({
      requestId: REQ,
      merchantId: MID,
      change,
      reason: 'Raise the cap',
      expectedVersion: '0',
    });
  });

  it('confirm and decline map to the service decisions confirm and reject, and carry the hash of the change that was shown', async () => {
    configure();
    const calls = upstream({ 'founderAdmin.changes.confirm': () => ok(result('changed')) });
    expect((await POST(post({ action: 'confirm', ...shown }, authed()))).status).toBe(200);
    expect((await POST(post({ action: 'decline', ...shown, reason: 'Not now' }, authed()))).status).toBe(200);
    const hash = founderChangeHash({ scope: 'merchant', merchantId: MID, change }, '3');
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const [a, b] = serviceCalls(calls).map((c) => JSON.parse(String(c.init.body)));
    expect(a).toEqual({ requestId: REQ, decision: 'confirm', reason: 'Checked it', expectedChangeHash: hash });
    expect(b).toEqual({ requestId: REQ, decision: 'reject', reason: 'Not now', expectedChangeHash: hash });
  });

  it('the hash follows what was shown: another merchant, kind, version or extra rule hashes differently, and key order does not matter', async () => {
    configure();
    const calls = upstream({ 'founderAdmin.changes.confirm': () => ok(result('changed')) });
    const send = async (over: Record<string, unknown>) => {
      await POST(post({ action: 'confirm', ...shown, ...over }, authed()));
      return JSON.parse(String(serviceCalls(calls).at(-1)!.init.body)).expectedChangeHash as string;
    };
    const base = await send({});
    const other = [
      await send({ merchantId: '99999999-9999-4999-8999-999999999999' }),
      await send({ change: { kind: 'set_reserve', reserve: { rollingReserveBps: 0, holdDays: 0 } } }),
      await send({ expectedVersion: '4' }),
      await send({ change: { kind: 'set_caps', caps: [...change.caps, { kind: 'beneficiaries_per_day', limit: 3 }] } }),
    ];
    expect(new Set([base, ...other]).size).toBe(5);
    expect(await send({ change: { caps: [{ limit: '1000', assetCode: 'USDT', kind: 'daily_intake' }], kind: 'set_caps' } })).toBe(base);
    // an upper-case merchant id is the same merchant
    expect(await send({ merchantId: MID.toUpperCase() })).toBe(base);
  });

  it('a hash mismatch from the service is a plain refusal, and a missing request is "no pending change", not "no merchant"', async () => {
    configure();
    upstream({ 'founderAdmin.changes.confirm': () => refusedWith(409, 'pay.change_hash_mismatch') });
    const res = await POST(post({ action: 'confirm', ...shown }, authed()));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { refusal: { title: string; body: string } };
    expect(body.refusal.title).toBe('That is not the change on file');
    expect(body.refusal.title).not.toContain('pay.');
    upstream({
      'founderAdmin.changes.confirm': () =>
        Response.json(
          { error: { message: 'x', data: { code: 'NOT_FOUND', httpStatus: 404, cause: { code: 'pay.merchant_not_found' } } } },
          { status: 404 },
        ),
    });
    const gone = await POST(post({ action: 'decline', ...shown }, authed()));
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { refusal: { title: string } }).refusal.title).toBe('No pending change with that reference');
  });

  it('tiers is a read of the tier definitions, returns them parsed, and writes nothing', async () => {
    configure();
    const tier = {
      id: 'standard',
      name: 'Standard',
      archetype: 'standard',
      caps: [{ kind: 'beneficiaries_per_day', limit: 3 }],
      reserve: null,
      approvalThresholds: [{ assetCode: 'USDT', amount: '100' }],
      founderThresholds: [{ assetCode: 'USDT', amount: '1000' }],
      approvalTtlSeconds: 3600,
      version: '2',
      merchants: 1,
    };
    const calls = upstream({ 'founderAdmin.control.tiers.list': () => ok([tier]) });
    const res = await POST(post({ action: 'tiers' }, authed()));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tiers: Array<{ id: string }> }).tiers[0]?.id).toBe('standard');
    expect(serviceCalls(calls).map((c) => c.url)).toEqual([`${EDGE}/api/pay/trpc/founderAdmin.control.tiers.list?input=%7B%7D`]);
    upstream({ 'founderAdmin.control.tiers.list': () => ok([{ nonsense: true }]) });
    expect((await POST(post({ action: 'tiers' }, authed()))).status).toBe(502);
  });

  it('a set_caps for a merchant with no tier is refused by the service with a plain "assign a tier first"', async () => {
    configure();
    upstream({ 'founderAdmin.changes.submit': () => refusedWith(412, 'pay.tier_unassigned') });
    const res = await POST(post(submitBody, authed()));
    expect(res.status).toBe(412);
    const body = (await res.json()) as { refusal: { title: string; next: string } };
    expect(body.refusal.title).toBe('This merchant has no tier yet');
    expect(body.refusal.next).toContain('Assign a tier first');
  });

  it('decide signs the exact payload hash it was given', async () => {
    configure();
    const calls = upstream({ 'founderAdmin.control.approvals.decide': () => ok(approval('pending')) });
    const res = await POST(
      post({ action: 'decide', approvalId: APPROVAL, decision: 'approve', expectedPayloadHash: HASH, reason: 'Looks right' }, authed()),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { approval: { status: string } }).approval.status).toBe('pending');
    expect(JSON.parse(String(serviceCalls(calls)[0]!.init.body))).toEqual({
      approvalId: APPROVAL,
      decision: 'approve',
      expectedPayloadHash: HASH,
      reason: 'Looks right',
    });
  });

  it.each([
    ['pay.dual_control_required', 409, 'A different founder has to do this step'],
    ['pay.change_not_found', 404, 'No pending change with that reference'],
    ['pay.change_not_pending', 409, 'already been decided'],
    ['pay.approval_payload_mismatch', 409, 'The payout changed after you opened it'],
    ['pay.approval_self_approval', 403, 'cannot decide an approval you took part in'],
  ])(
    'a refusal with code %s is explained in plain English with the code kept for support, not as the explanation',
    async (code, status, words) => {
      configure();
      upstream({
        'founderAdmin.changes.confirm': () => refusedWith(status, code),
        'founderAdmin.control.approvals.decide': () => refusedWith(status, code),
      });
      const res = await POST(
        post(
          code.startsWith('pay.approval')
            ? { action: 'decide', approvalId: APPROVAL, decision: 'approve', expectedPayloadHash: HASH, reason: 'fine' }
            : { action: 'confirm', ...shown },
          authed(),
        ),
      );
      expect(res.status).toBe(status);
      const body = (await res.json()) as { ok: boolean; refusal: { title: string; body: string; code: string } };
      expect(body.ok).toBe(false);
      expect(`${body.refusal.title} ${body.refusal.body}`).toContain(words);
      expect(body.refusal.title).not.toContain('pay.');
    },
  );

  it('a stub or a reserve that is not wired says "not built yet" and 501, never success', async () => {
    configure();
    upstream({
      'founderAdmin.changes.submit': () =>
        Response.json(
          {
            error: {
              message: 'pay.reserve_ledger_unwired',
              data: { code: 'NOT_IMPLEMENTED', httpStatus: 501, cause: { code: 'pay.reserve_ledger_unwired' } },
            },
          },
          { status: 501 },
        ),
    });
    const res = await POST(
      post({ ...submitBody, change: { kind: 'set_reserve', reserve: { rollingReserveBps: 5, holdDays: 1 } } }, authed()),
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { ok: boolean; refusal: { title: string; body: string } };
    expect(body.ok).toBe(false);
    expect(body.refusal.title).toBe('This change is not switched on');
  });

  it('an answer in a shape the console does not know is a 502, not a success', async () => {
    configure();
    upstream({ 'founderAdmin.changes.submit': () => ok({ surprise: true }) });
    const res = await POST(post(submitBody, authed()));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('an unreachable service is a 503 and nothing is reported as changed', async () => {
    configure();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('operatorStatus')) return entitlement('enabled');
        throw new Error('ECONNREFUSED');
      }),
    );
    const res = await POST(post(submitBody, authed()));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });
});
