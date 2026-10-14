import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE, adminSessionConfig } from '@/lib/founder-session';
import { ENROL_COOKIE, openEnrolmentSession, sealEnrolmentSession, type EnrolmentSession } from '@/lib/enrolment-session';
import { registerLimiter } from '@/lib/rate-limit';
import { DELETE } from './route';
import { GET as status } from './status/route';
import { POST as register } from './register/route';
import { POST as authStart } from './authenticator/start/route';
import { POST as authConfirm } from './authenticator/confirm/route';
import { POST as passkeyOptions } from './passkey/options/route';
import { POST as passkeyVerify } from './passkey/verify/route';
import { POST as finish } from './finish/route';

const ORIGIN = 'https://admin.example.test';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'JBSWY3DPEHPK3PXP';
const CODES = Array.from({ length: 10 }, (_, i) => `FACED-${String(i + 1).padStart(5, '0')}`);
const ENV = {
  ADMIN_ORIGIN: ORIGIN,
  EDGE_URL: 'https://edge.example.test',
  ADMIN_SESSION_SECRET: Buffer.alloc(32, 7).toString('base64url'),
  ADMIN_FOUNDER_ENROLMENT: 'open',
};
const original = { ...process.env };

type Reply = { status?: number; data?: unknown; upstreamCode?: string };
type Call = { procedure: string; method: string; body: unknown; authorization: string | null };
let calls: Array<{ procedure: string; method: string; body: unknown; authorization: string | null }>;
let replies: Record<string, Reply | ((call: Call) => Reply)>;

function stubEdge() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const procedure = new URL(url).pathname.split('/trpc/')[1]!;
      const call = {
        procedure,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: new Headers(init?.headers).get('authorization'),
      };
      calls.push(call);
      const configured = replies[procedure];
      const reply = (typeof configured === 'function' ? configured(call) : configured) ?? { data: {} };
      if (reply.status && reply.status >= 400)
        return Response.json(
          { error: { message: 'x', code: 'BAD_REQUEST', data: { httpStatus: reply.status, intafacedCode: reply.upstreamCode } } },
          { status: reply.status },
        );
      return Response.json({ result: { data: { json: reply.data ?? {} } } });
    }),
  );
}

function live(overrides: Partial<EnrolmentSession> = {}): EnrolmentSession {
  return {
    userId: USER_ID,
    accessToken: 'enrol-access-token',
    refreshToken: 'enrol-refresh-token',
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    accessExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    expiresAt: new Date(Date.now() + 1_200_000).toISOString(),
    csrf: Buffer.alloc(32, 8).toString('base64url'),
    totpConfirmed: false,
    stepUpToken: null,
    stepUpExpiresAt: null,
    ...overrides,
  };
}

function request(
  path: string,
  method: string,
  options: { body?: unknown; session?: EnrolmentSession | null; csrf?: string | null; origin?: string } = {},
) {
  const headers = new Headers({ origin: options.origin ?? ORIGIN });
  const session = options.session === undefined ? live() : options.session;
  if (session) headers.set('cookie', `${ENROL_COOKIE}=${sealEnrolmentSession(session, adminSessionConfig())}`);
  const csrf = options.csrf === undefined ? session?.csrf : options.csrf;
  if (csrf) headers.set('x-intafaced-csrf', csrf);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

beforeEach(() => {
  registerLimiter.reset();
  Object.assign(process.env, ENV);
  calls = [];
  replies = {};
  stubEdge();
});
afterEach(() => {
  process.env = { ...original };
  vi.unstubAllGlobals();
});

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;
const procedures = () => calls.map((call) => call.procedure);

describe('off switch', () => {
  it('answers 404 admin.enrolment_off from every route, without calling identity', async () => {
    process.env.ADMIN_FOUNDER_ENROLMENT = 'closed';
    const all = [
      status(request('/api/enroll/status', 'GET', { session: null })),
      register(request('/api/enroll/register', 'POST', { session: null, body: {} })),
      authStart(request('/api/enroll/authenticator/start', 'POST')),
      authConfirm(request('/api/enroll/authenticator/confirm', 'POST', { body: {} })),
      passkeyOptions(request('/api/enroll/passkey/options', 'POST')),
      passkeyVerify(request('/api/enroll/passkey/verify', 'POST', { body: {} })),
      finish(request('/api/enroll/finish', 'POST')),
      DELETE(request('/api/enroll', 'DELETE')),
    ];
    for (const response of await Promise.all(all)) {
      expect(response.status).toBe(404);
      expect(await body(response)).toEqual({ code: 'admin.enrolment_off' });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(calls).toEqual([]);
  });

  it('is off when the variable is unset', async () => {
    delete process.env.ADMIN_FOUNDER_ENROLMENT;
    expect((await status(request('/api/enroll/status', 'GET', { session: null }))).status).toBe(404);
  });
});

describe('GET /api/enroll/status', () => {
  it('returns only open', async () => {
    replies['auth.founderEnrolmentStatus'] = { data: { open: true, hashes: 'secret' } };
    const response = await status(request('/api/enroll/status', 'GET', { session: null }));
    expect(await body(response)).toEqual({ open: true });
    expect(calls[0]).toMatchObject({ procedure: 'auth.founderEnrolmentStatus', method: 'GET', authorization: null });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a malformed reply and a cross-site request', async () => {
    replies['auth.founderEnrolmentStatus'] = { data: { open: 'yes' } };
    expect((await status(request('/api/enroll/status', 'GET', { session: null }))).status).toBe(502);
    const cross = new Request(`${ORIGIN}/api/enroll/status`, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect((await status(cross)).status).toBe(403);
  });
});

describe('POST /api/enroll/register', () => {
  const input = { invite: 'ABCD-EFGH', handle: 'test-one', email: 'one@example.test', password: 'a-test-password-1' };
  const tokens = {
    userId: USER_ID,
    accessToken: 'enrol-access-token',
    refreshToken: 'enrol-refresh-token',
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  };

  it('registers, sets the enrolment cookie, returns the csrf and not the account ID', async () => {
    replies['auth.registerFounder'] = { data: tokens };
    const response = await register(request('/api/enroll/register', 'POST', { session: null, body: input }));
    expect(response.status).toBe(200);
    const json = await body(response);
    expect(Object.keys(json)).toEqual(['csrf']);
    expect(JSON.stringify(json)).not.toContain(USER_ID);
    expect(calls).toEqual([{ procedure: 'auth.registerFounder', method: 'POST', body: input, authorization: null }]);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toMatch(new RegExp(`^${ENROL_COOKIE}=[A-Za-z0-9_-]+; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=\\d+$`));
    expect(cookie).not.toContain(ADMIN_COOKIE);
    // 30 minutes from register, whatever the 15-minute access token does.
    expect(Number(/Max-Age=(\d+)/.exec(cookie)![1])).toBeGreaterThan(1790);
    expect(Number(/Max-Age=(\d+)/.exec(cookie)![1])).toBeLessThanOrEqual(1800);
    const opened = openEnrolmentSession(cookie.split(';')[0]!, adminSessionConfig());
    expect(opened).toMatchObject({ userId: USER_ID, totpConfirmed: false, csrf: json.csrf });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['invite too long', { invite: 'x'.repeat(65) }],
    ['invite empty', { invite: '  ' }],
    ['handle too long', { handle: 'h'.repeat(33) }],
    ['email too long', { email: `${'e'.repeat(250)}@x.test` }],
    ['password short', { password: 'a'.repeat(11) }],
    ['password long', { password: 'a'.repeat(201) }],
    ['password not text', { password: 123456789012 }],
    ['extra key', { role: 'admin' }],
  ])('refuses %s with 400 and no identity call', async (_name, change) => {
    const response = await register(request('/api/enroll/register', 'POST', { session: null, body: { ...input, ...change } }));
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({ code: 'admin.enrol_input' });
    expect(calls).toEqual([]);
  });

  it('checks the Origin header', async () => {
    const response = await register(
      request('/api/enroll/register', 'POST', { session: null, body: input, origin: 'https://evil.example' }),
    );
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('wants JSON', async () => {
    const response = await register(
      new Request(`${ORIGIN}/api/enroll/register`, { method: 'POST', headers: { origin: ORIGIN }, body: 'x' }),
    );
    expect(response.status).toBe(400);
  });

  it.each([
    ['auth.invite_used', 409],
    ['auth.invite_invalid', 400],
    ['auth.invite_expired', 400],
    ['auth.founder_enrolment_closed', 403],
    ['auth.handle_taken', 409],
    ['auth.email_taken', 409],
  ])('passes %s through, sets no cookie', async (upstreamCode, httpStatus) => {
    replies['auth.registerFounder'] = { status: httpStatus, upstreamCode };
    const response = await register(request('/api/enroll/register', 'POST', { session: null, body: input }));
    expect(response.status).toBe(httpStatus);
    expect(await body(response)).toMatchObject({ upstreamCode });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('ends a session it cannot hold', async () => {
    replies['auth.registerFounder'] = { data: { ...tokens, userId: 'not-a-uuid' } };
    const response = await register(request('/api/enroll/register', 'POST', { session: null, body: input }));
    expect(response.status).toBe(502);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(procedures()).toEqual(['auth.registerFounder', 'auth.logout']);
    expect(calls[1]!.body).toEqual({ refreshToken: 'enrol-refresh-token' });
  });
});

describe('routes after register need the cookie and the csrf header', () => {
  const guarded: Array<[string, string, (request: Request) => Promise<Response>, unknown?]> = [
    ['/api/enroll/authenticator/start', 'POST', authStart],
    ['/api/enroll/authenticator/confirm', 'POST', authConfirm, { code: '123456', secret: SECRET }],
    ['/api/enroll/passkey/options', 'POST', passkeyOptions],
    ['/api/enroll/passkey/verify', 'POST', passkeyVerify, {}],
    ['/api/enroll/finish', 'POST', finish],
    ['/api/enroll', 'DELETE', DELETE],
  ];

  it.each(guarded)('%s refuses without a cookie, a csrf header, or the right origin', async (path, method, handler, payload) => {
    const base = { body: payload };
    expect((await handler(request(path, method, { ...base, session: null, csrf: live().csrf }))).status).toBe(401);
    expect((await handler(request(path, method, { ...base, csrf: null }))).status).toBe(403);
    expect((await handler(request(path, method, { ...base, csrf: 'y'.repeat(43) }))).status).toBe(403);
    expect((await handler(request(path, method, { ...base, origin: 'https://evil.example' }))).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it.each(guarded)('%s refuses a founder cookie in place of the enrolment cookie', async (path, method, handler, payload) => {
    const headers = new Headers({ origin: ORIGIN, cookie: `${ADMIN_COOKIE}=whatever`, 'x-intafaced-csrf': live().csrf });
    if (payload !== undefined) headers.set('content-type', 'application/json');
    const response = await handler(
      new Request(`${ORIGIN}${path}`, { method, headers, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) }),
    );
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe('authenticator', () => {
  const uri = `otpauth://totp/INTAFACED:x?secret=${SECRET}`;

  it('start returns the secret, link and ten recovery codes, using the enrolment token', async () => {
    replies['totp.enrol'] = { data: { secret: SECRET, uri, recoveryCodes: CODES } };
    const response = await authStart(request('/api/enroll/authenticator/start', 'POST'));
    expect(await body(response)).toEqual({ secret: SECRET, uri, recoveryCodes: CODES });
    expect(calls[0]).toMatchObject({ procedure: 'totp.enrol', method: 'POST', authorization: 'Bearer enrol-access-token' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['not an otpauth totp link', { uri: 'https://evil.example/qr' }],
    ['a hotp link', { uri: `otpauth://hotp/x?secret=${SECRET}` }],
    ['a short secret', { secret: 'ABC' }],
    ['nine codes', { recoveryCodes: CODES.slice(1) }],
    ['a malformed code', { recoveryCodes: [...CODES.slice(1), 'nope'] }],
  ])('start refuses %s from identity', async (_name, change) => {
    replies['totp.enrol'] = { data: { secret: SECRET, uri, recoveryCodes: CODES, ...change } };
    const response = await authStart(request('/api/enroll/authenticator/start', 'POST'));
    expect(response.status).toBe(502);
    expect(JSON.stringify(await body(response))).not.toContain(SECRET);
  });

  it('start refuses once the authenticator is confirmed', async () => {
    const response = await authStart(request('/api/enroll/authenticator/start', 'POST', { session: live({ totpConfirmed: true }) }));
    expect(response.status).toBe(409);
    expect(calls).toEqual([]);
  });

  it('confirm reseals the cookie with totpConfirmed and keeps the same csrf and expiry', async () => {
    const session = live();
    const response = await authConfirm(
      request('/api/enroll/authenticator/confirm', 'POST', { session, body: { code: '123456', secret: SECRET } }),
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ confirmed: true });
    expect(calls[0]).toMatchObject({
      procedure: 'totp.confirm',
      body: { secret: SECRET, code: '123456' },
      authorization: 'Bearer enrol-access-token',
    });
    const opened = openEnrolmentSession(response.headers.get('set-cookie')!.split(';')[0]!, adminSessionConfig());
    expect(opened).toEqual({ ...session, totpConfirmed: true });
  });

  it.each([
    ['letters', { code: 'abcdef', secret: SECRET }],
    ['five digits', { code: '12345', secret: SECRET }],
    ['a recovery code', { code: 'FACED-00001', secret: SECRET }],
    ['no secret', { code: '123456' }],
    ['a short secret', { code: '123456', secret: 'ABC' }],
    ['an extra key', { code: '123456', secret: SECRET, userId: USER_ID }],
  ])('confirm refuses %s', async (_name, payload) => {
    const response = await authConfirm(request('/api/enroll/authenticator/confirm', 'POST', { body: payload }));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it.each(['auth.mfa_invalid', 'auth.too_many_attempts'])('confirm passes %s through and does not reseal', async (upstreamCode) => {
    replies['totp.confirm'] = { status: upstreamCode === 'auth.too_many_attempts' ? 429 : 400, upstreamCode };
    const response = await authConfirm(request('/api/enroll/authenticator/confirm', 'POST', { body: { code: '000000', secret: SECRET } }));
    expect(await body(response)).toMatchObject({ upstreamCode });
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

/** Identity's real gate in miniature: passkey registration needs the step-up token, not the plain enrolment token. */
const gate = (call: Call): Reply =>
  call.authorization === 'Bearer stepup-token'
    ? { data: { challenge: 'c', rp: { id: 'x', name: 'x' }, credentialId: 'abc' } }
    : { status: 403, upstreamCode: 'auth.mfa_required' };

describe('passkey', () => {
  const confirmed = (overrides: Partial<EnrolmentSession> = {}) => live({ totpConfirmed: true, ...overrides });
  const held = () => confirmed({ stepUpToken: 'stepup-token', stepUpExpiresAt: new Date(Date.now() + 240_000).toISOString() });
  const attestation = {
    id: 'abc',
    rawId: 'abc',
    type: 'public-key',
    response: { clientDataJSON: 'cd', attestationObject: 'ao', transports: ['internal'] },
    clientExtensionResults: {},
  };
  const cookieSession = (response: Response) =>
    openEnrolmentSession(response.headers.get('set-cookie')!.split(';')[0]!, adminSessionConfig());
  beforeEach(() => {
    replies['webauthn.registerOptions'] = gate;
    replies['webauthn.registerVerify'] = gate;
    replies['auth.stepUp'] = { data: { accessToken: 'stepup-token', expiresAt: new Date(Date.now() + 300_000).toISOString(), scopes: [] } };
  });

  it('refuses both steps before the authenticator is confirmed', async () => {
    expect((await passkeyOptions(request('/api/enroll/passkey/options', 'POST', { body: { code: '123456' } }))).status).toBe(409);
    expect((await passkeyVerify(request('/api/enroll/passkey/verify', 'POST', { body: attestation }))).status).toBe(409);
    expect(calls).toEqual([]);
  });

  it('options with a fresh code steps up first, then asks for options with the step-up token', async () => {
    const response = await passkeyOptions(
      request('/api/enroll/passkey/options', 'POST', { session: confirmed(), body: { code: '123456' } }),
    );
    expect(response.status).toBe(200);
    expect(calls.map((call) => [call.procedure, call.authorization, call.body])).toEqual([
      ['auth.stepUp', 'Bearer enrol-access-token', { totpCode: '123456' }],
      ['webauthn.registerOptions', 'Bearer stepup-token', {}],
    ]);
    expect(await body(response)).toMatchObject({ challenge: 'c' });
  });

  it('keeps the step-up token in the sealed cookie for at most five minutes and never returns it', async () => {
    const response = await passkeyOptions(
      request('/api/enroll/passkey/options', 'POST', { session: confirmed(), body: { code: '123456' } }),
    );
    expect(JSON.stringify(await body(response))).not.toContain('stepup-token');
    expect(response.headers.get('set-cookie')).not.toContain('stepup-token');
    const stored = cookieSession(response);
    expect(stored.stepUpToken).toBe('stepup-token');
    expect(Date.parse(stored.stepUpExpiresAt!) - Date.now()).toBeLessThanOrEqual(300_000);
    expect(stored.totpConfirmed).toBe(true);
  });

  it('options reuses a step-up still held, so a cancelled prompt can be retried without a new code', async () => {
    const response = await passkeyOptions(request('/api/enroll/passkey/options', 'POST', { session: held(), body: {} }));
    expect(response.status).toBe(200);
    expect(procedures()).toEqual(['webauthn.registerOptions']);
    expect(calls[0]!.authorization).toBe('Bearer stepup-token');
  });

  it('with no step-up at all, identity gate refuses with auth.mfa_required (options and verify)', async () => {
    const options = await passkeyOptions(request('/api/enroll/passkey/options', 'POST', { session: confirmed(), body: {} }));
    expect(options.status).toBe(403);
    expect(await body(options)).toMatchObject({ upstreamCode: 'auth.mfa_required' });
    const verify = await passkeyVerify(request('/api/enroll/passkey/verify', 'POST', { session: confirmed(), body: attestation }));
    expect(verify.status).toBe(403);
    expect(await body(verify)).toMatchObject({ upstreamCode: 'auth.mfa_required' });
    expect(calls.map((call) => call.authorization)).toEqual(['Bearer enrol-access-token', 'Bearer enrol-access-token']);
  });

  it('ignores a lapsed step-up token', async () => {
    const lapsed = confirmed({ stepUpToken: 'stepup-token', stepUpExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const response = await passkeyOptions(request('/api/enroll/passkey/options', 'POST', { session: lapsed, body: {} }));
    expect(response.status).toBe(403);
    expect(calls[0]!.authorization).toBe('Bearer enrol-access-token');
  });

  it.each(['auth.mfa_invalid', 'auth.too_many_attempts'])(
    'passes a refused code (%s) through and asks for no options',
    async (upstreamCode) => {
      replies['auth.stepUp'] = { status: upstreamCode === 'auth.mfa_invalid' ? 400 : 429, upstreamCode };
      const response = await passkeyOptions(
        request('/api/enroll/passkey/options', 'POST', { session: confirmed(), body: { code: '123456' } }),
      );
      expect(await body(response)).toMatchObject({ upstreamCode });
      expect(procedures()).toEqual(['auth.stepUp']);
      expect(response.headers.get('set-cookie')).toBeNull();
    },
  );

  it.each([
    ['letters', { code: 'abcdef' }],
    ['five digits', { code: '12345' }],
    ['a recovery code', { code: 'FACED-00001' }],
    ['a number', { code: 123456 }],
    ['an extra key', { code: '123456', token: 'x' }],
  ])('options refuses %s', async (_name, payload) => {
    const response = await passkeyOptions(request('/api/enroll/passkey/options', 'POST', { session: confirmed(), body: payload }));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('refuses a malformed step-up reply', async () => {
    replies['auth.stepUp'] = { data: { expiresAt: 'x' } };
    const response = await passkeyOptions(
      request('/api/enroll/passkey/options', 'POST', { session: confirmed(), body: { code: '123456' } }),
    );
    expect(response.status).toBe(502);
    expect(procedures()).toEqual(['auth.stepUp']);
  });

  it('verify uses the held step-up token, then clears it from the cookie', async () => {
    const response = await passkeyVerify(request('/api/enroll/passkey/verify', 'POST', { session: held(), body: attestation }));
    expect(await body(response)).toEqual({ registered: true });
    expect(calls[0]).toMatchObject({ procedure: 'webauthn.registerVerify', body: attestation, authorization: 'Bearer stepup-token' });
    const stored = cookieSession(response);
    expect(stored).toMatchObject({ stepUpToken: null, stepUpExpiresAt: null, totpConfirmed: true });
  });

  it('a refused verify keeps the step-up so the person can try again', async () => {
    replies['webauthn.registerVerify'] = { status: 400, upstreamCode: 'auth.webauthn_invalid' };
    const response = await passkeyVerify(request('/api/enroll/passkey/verify', 'POST', { session: held(), body: attestation }));
    expect(await body(response)).toMatchObject({ upstreamCode: 'auth.webauthn_invalid' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it.each([
    ['wrong type', { type: 'password' }],
    ['no response', { response: null }],
    ['extra key', { userId: USER_ID }],
    ['extra response key', { response: { ...attestation.response, authenticatorData: 'x' } }],
    ['empty id', { id: '' }],
    ['transports not a list', { response: { ...attestation.response, transports: 'internal' } }],
  ])('verify refuses %s', async (_name, change) => {
    const response = await passkeyVerify(
      request('/api/enroll/passkey/verify', 'POST', { session: held(), body: { ...attestation, ...change } }),
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('access token refresh', () => {
  const lapsing = (overrides: Partial<EnrolmentSession> = {}) =>
    live({ accessExpiresAt: new Date(Date.now() + 30_000).toISOString(), ...overrides });
  const refreshed = () => ({
    data: {
      userId: USER_ID,
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    },
  });
  const uri = `otpauth://totp/INTAFACED:x?secret=${SECRET}`;
  const cookieSession = (response: Response) =>
    openEnrolmentSession(response.headers.get('set-cookie')!.split(';')[0]!, adminSessionConfig());

  it('refreshes once before the call when the access token has under a minute left, and reseals with the same csrf and end', async () => {
    replies['auth.refresh'] = refreshed();
    replies['totp.enrol'] = { data: { secret: SECRET, uri, recoveryCodes: CODES } };
    const session = lapsing();
    const response = await authStart(request('/api/enroll/authenticator/start', 'POST', { session }));
    expect(response.status).toBe(200);
    expect(calls.map((call) => [call.procedure, call.authorization, call.body])).toEqual([
      ['auth.refresh', null, { refreshToken: 'enrol-refresh-token' }],
      ['totp.enrol', 'Bearer new-access', {}],
    ]);
    const stored = cookieSession(response);
    expect(stored).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      csrf: session.csrf,
      expiresAt: session.expiresAt,
      userId: USER_ID,
    });
    expect(JSON.stringify(await body(response))).not.toContain('new-access');
  });

  it('refreshes an access token that has already expired', async () => {
    replies['auth.refresh'] = refreshed();
    const response = await authConfirm(
      request('/api/enroll/authenticator/confirm', 'POST', {
        session: lapsing({ accessExpiresAt: new Date(Date.now() - 600_000).toISOString() }),
        body: { code: '123456', secret: SECRET },
      }),
    );
    expect(response.status).toBe(200);
    expect(procedures()).toEqual(['auth.refresh', 'totp.confirm']);
    expect(calls[1]!.authorization).toBe('Bearer new-access');
    expect(cookieSession(response)).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh', totpConfirmed: true });
  });

  it('does not refresh when the token has more than a minute left', async () => {
    await authConfirm(
      request('/api/enroll/authenticator/confirm', 'POST', {
        session: live({ accessExpiresAt: new Date(Date.now() + 120_000).toISOString() }),
        body: { code: '123456', secret: SECRET },
      }),
    );
    expect(procedures()).toEqual(['totp.confirm']);
  });

  it('a failed refresh gives admin.enrolment_expired and makes no further call', async () => {
    replies['auth.refresh'] = { status: 403, upstreamCode: 'auth.session_revoked' };
    const response = await authStart(request('/api/enroll/authenticator/start', 'POST', { session: lapsing() }));
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ code: 'admin.enrolment_expired' });
    expect(procedures()).toEqual(['auth.refresh']);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('keeps the new tokens even when the call after the refresh is refused', async () => {
    replies['auth.refresh'] = refreshed();
    replies['totp.confirm'] = { status: 400, upstreamCode: 'auth.mfa_invalid' };
    const response = await authConfirm(
      request('/api/enroll/authenticator/confirm', 'POST', { session: lapsing(), body: { code: '000000', secret: SECRET } }),
    );
    expect(await body(response)).toMatchObject({ upstreamCode: 'auth.mfa_invalid' });
    expect(cookieSession(response)).toMatchObject({ refreshToken: 'new-refresh', totpConfirmed: false });
  });

  it('finish and abandon log out with the refresh token and do not refresh first', async () => {
    const expired = { accessExpiresAt: new Date(Date.now() - 600_000).toISOString() };
    await finish(request('/api/enroll/finish', 'POST', { session: lapsing({ ...expired, totpConfirmed: true }) }));
    await DELETE(request('/api/enroll', 'DELETE', { session: lapsing(expired) }));
    expect(procedures()).toEqual(['auth.logout', 'auth.logout']);
  });
});

describe('finish and abandon', () => {
  it('finish refuses before the authenticator is confirmed, and does not log out', async () => {
    const response = await finish(request('/api/enroll/finish', 'POST'));
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({ code: 'admin.enrolment_totp_required' });
    expect(calls).toEqual([]);
  });

  it('finish logs out, clears the cookie and reveals the account ID', async () => {
    const response = await finish(request('/api/enroll/finish', 'POST', { session: live({ totpConfirmed: true }) }));
    expect(await body(response)).toEqual({ userId: USER_ID, serverRevocation: 'confirmed' });
    expect(calls).toEqual([
      { procedure: 'auth.logout', method: 'POST', body: { refreshToken: 'enrol-refresh-token' }, authorization: null },
    ]);
    expect(response.headers.get('set-cookie')).toBe(`${ENROL_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('finish still returns the ID and says so when logout is unconfirmed', async () => {
    replies['auth.logout'] = { status: 503 };
    const response = await finish(request('/api/enroll/finish', 'POST', { session: live({ totpConfirmed: true }) }));
    expect(await body(response)).toEqual({ userId: USER_ID, serverRevocation: 'unconfirmed' });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('abandon logs out and clears the cookie without naming the account', async () => {
    const response = await DELETE(request('/api/enroll', 'DELETE'));
    const json = await body(response);
    expect(json).toEqual({ abandoned: true, serverRevocation: 'confirmed' });
    expect(JSON.stringify(json)).not.toContain(USER_ID);
    expect(procedures()).toEqual(['auth.logout']);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('abandon works at any stage, including after the authenticator', async () => {
    const response = await DELETE(request('/api/enroll', 'DELETE', { session: live({ totpConfirmed: true }) }));
    expect(response.status).toBe(200);
  });
});

describe('upstream codes are opt-in', () => {
  const input = { invite: 'ABCD-EFGH', handle: 'test-one', email: 'one@example.test', password: 'a-test-password-1' };

  it("drops a code the page has no copy for, keeping only this server's code", async () => {
    for (const upstreamCode of ['auth.invalid_credentials', 'auth.user_not_found', 'auth.reset_refused']) {
      replies['auth.registerFounder'] = { status: 400, upstreamCode };
      const response = await register(request('/api/enroll/register', 'POST', { session: null, body: input }));
      expect(await body(response)).toEqual({ code: 'admin.upstream_refused' });
    }
    replies['totp.confirm'] = { status: 400, upstreamCode: 'auth.session_denied' };
    const confirm = await authConfirm(request('/api/enroll/authenticator/confirm', 'POST', { body: { code: '123456', secret: SECRET } }));
    expect(await body(confirm)).toEqual({ code: 'admin.upstream_refused' });
  });

  it('passes on the passkey-preview code and the codes the page has copy for', async () => {
    for (const upstreamCode of ['auth.passkey_preview_unavailable', 'auth.mfa_invalid', 'auth.mfa_required', 'auth.too_many_attempts']) {
      replies['auth.stepUp'] = { status: 400, upstreamCode };
      const response = await passkeyOptions(
        request('/api/enroll/passkey/options', 'POST', { session: live({ totpConfirmed: true }), body: { code: '123456' } }),
      );
      expect(await body(response)).toMatchObject({ upstreamCode });
    }
  });
});

describe('register is rate limited per client', () => {
  const input = { invite: 'ABCD-EFGH', handle: 'test-one', email: 'one@example.test', password: 'a-test-password-1' };

  it('allows 10 attempts, then answers 429 admin.rate_limited without calling identity', async () => {
    process.env.ADMIN_TRUST_PROXY = '1';
    replies['auth.registerFounder'] = { status: 409, upstreamCode: 'auth.invite_used' };
    const asClient = () => {
      const asked = request('/api/enroll/register', 'POST', { session: null, body: input });
      const headers = new Headers(asked.headers);
      headers.set('x-forwarded-for', '203.0.113.5');
      return new Request(asked.url, { method: 'POST', headers, body: JSON.stringify(input) });
    };
    for (let i = 0; i < 10; i += 1) expect((await register(asClient())).status).toBe(409);
    const blocked = await register(asClient());
    expect(blocked.status).toBe(429);
    expect(await body(blocked)).toEqual({ code: 'admin.rate_limited' });
    expect(calls).toHaveLength(10);
  });

  it('keeps clients apart only when ADMIN_TRUST_PROXY=1, by the first x-forwarded-for entry', async () => {
    process.env.ADMIN_TRUST_PROXY = '1';
    replies['auth.registerFounder'] = { status: 409, upstreamCode: 'auth.invite_used' };
    const from = (ip: string) => {
      const asked = request('/api/enroll/register', 'POST', { session: null, body: input });
      const headers = new Headers(asked.headers);
      headers.set('x-forwarded-for', ip);
      return new Request(asked.url, { method: 'POST', headers, body: JSON.stringify(input) });
    };
    for (let i = 0; i < 10; i += 1) await register(from('203.0.113.1, 10.0.0.9'));
    expect((await register(from('203.0.113.1'))).status).toBe(429);
    expect((await register(from('203.0.113.2'))).status).toBe(409);
  });

  it('does not limit the routes that already have a session', async () => {
    for (let i = 0; i < 12; i += 1) expect((await authStart(request('/api/enroll/authenticator/start', 'POST'))).status).not.toBe(429);
  });
});

describe('passkey verify forwards only what it has checked', () => {
  const confirmed = () =>
    live({ totpConfirmed: true, stepUpToken: 'stepup-token', stepUpExpiresAt: new Date(Date.now() + 240_000).toISOString() });
  const attestation = {
    id: 'abc',
    rawId: 'abc',
    type: 'public-key',
    response: { clientDataJSON: 'cd', attestationObject: 'ao', transports: ['internal'] },
    clientExtensionResults: { credProps: { rk: true } },
  };

  it('rebuilds the credential field by field', async () => {
    replies['webauthn.registerVerify'] = { data: { credentialId: 'abc' } };
    await passkeyVerify(request('/api/enroll/passkey/verify', 'POST', { session: confirmed(), body: attestation }));
    expect(calls[0]!.body).toEqual(attestation);
    expect(Object.keys(calls[0]!.body as object)).toEqual(['id', 'rawId', 'type', 'response', 'clientExtensionResults']);
  });

  it('caps clientExtensionResults at 2048 characters', async () => {
    const big = { ...attestation, clientExtensionResults: { blob: 'x'.repeat(2100) } };
    const response = await passkeyVerify(request('/api/enroll/passkey/verify', 'POST', { session: confirmed(), body: big }));
    expect(response.status).toBe(400);
    const edge = { ...attestation, clientExtensionResults: { blob: 'x'.repeat(2030) } };
    expect(JSON.stringify(edge.clientExtensionResults).length).toBeLessThan(2048);
    replies['webauthn.registerVerify'] = { data: { credentialId: 'abc' } };
    expect((await passkeyVerify(request('/api/enroll/passkey/verify', 'POST', { session: confirmed(), body: edge }))).status).toBe(200);
  });
});
