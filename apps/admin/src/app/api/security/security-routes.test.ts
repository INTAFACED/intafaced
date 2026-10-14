import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as overviewGet } from './route';
import { POST as changePassword } from './password/route';
import { POST as setPassword } from './password/set/route';
import { POST as stepUpOptions } from './step-up/options/route';
import { POST as replaceBegin } from './authenticator/replace-begin/route';
import { POST as replaceConfirm } from './authenticator/replace-confirm/route';
import { POST as recoveryCodes } from './recovery-codes/route';
import { POST as passkeyOptions } from './passkeys/options/route';
import { POST as passkeyVerify } from './passkeys/verify/route';
import { DELETE as passkeyRemove } from './passkeys/[id]/route';
import { adminSessionConfig, ADMIN_COOKIE, sealFounderSession, type FounderSession } from '@/lib/founder-session';

const userId = randomUUID();
const original = { ...process.env };
const now = new Date();
const session: FounderSession = {
  userId,
  accessToken: 'founder-access-token',
  refreshToken: 'founder-refresh-token',
  expiresAt: new Date(now.getTime() + 600000).toISOString(),
  issuedAt: now.toISOString(),
  csrf: randomBytes(32).toString('base64url'),
};
const enabled = { status: 'enabled', userId, version: '1', changedAt: now.toISOString() };
const ok = (data: unknown) => Response.json({ result: { data } });
const refused = (status: number, intafacedCode: string) =>
  Response.json({ error: { message: 'x', code: 'BAD_REQUEST', data: { httpStatus: status, intafacedCode } } }, { status });
const proof = { totpCode: '123456' };
const assertion = {
  id: 'cred',
  rawId: 'cred',
  type: 'public-key',
  response: { clientDataJSON: 'a', authenticatorData: 'b', signature: 'c', userHandle: null },
};

function request(path: string, method: string, input?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://admin.example${path}`, {
    method,
    headers: {
      cookie: `${ADMIN_COOKIE}=${sealFounderSession(session, adminSessionConfig())}`,
      ...(method !== 'GET'
        ? { origin: 'https://admin.example', 'x-intafaced-csrf': session.csrf, 'content-type': 'application/json' }
        : {}),
      ...headers,
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
/** The founder check goes first, then the queued answers in order. */
function upstream(...answers: Response[]) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(ok(enabled));
  for (const answer of answers) fetcher.mockResolvedValueOnce(answer);
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
const procedure = (fetcher: ReturnType<typeof upstream>, call: number) => String(fetcher.mock.calls[call]![0]).split('/trpc/')[1];
const bearer = (fetcher: ReturnType<typeof upstream>, call: number) =>
  new Headers(fetcher.mock.calls[call]![1]?.headers).get('authorization');
const sentBody = (fetcher: ReturnType<typeof upstream>, call: number) => JSON.parse(String(fetcher.mock.calls[call]![1]?.body));

beforeEach(() => {
  process.env.ADMIN_ORIGIN = 'https://admin.example';
  process.env.EDGE_URL = 'http://edge:4000';
  process.env.ADMIN_SESSION_SECRET = randomBytes(32).toString('base64url');
});
afterEach(() => {
  process.env = { ...original };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('every Security route is authorised first', () => {
  const calls: Array<[string, string, (r: Request) => Promise<Response>, unknown?]> = [
    ['/api/security', 'GET', overviewGet],
    ['/api/security/password', 'POST', changePassword, { currentPassword: 'x', newPassword: 'a-new-password-1' }],
    ['/api/security/password/set', 'POST', setPassword, { newPassword: 'a-new-password-1', proof }],
    ['/api/security/step-up/options', 'POST', stepUpOptions],
    ['/api/security/authenticator/replace-begin', 'POST', replaceBegin, { proof }],
    ['/api/security/authenticator/replace-confirm', 'POST', replaceConfirm, { code: '123456' }],
    ['/api/security/recovery-codes', 'POST', recoveryCodes, { proof }],
    ['/api/security/passkeys/options', 'POST', passkeyOptions, { proof }],
    [
      '/api/security/passkeys/verify',
      'POST',
      passkeyVerify,
      { id: 'a', rawId: 'a', type: 'public-key', response: { clientDataJSON: 'a', attestationObject: 'b' } },
    ],
  ];
  it.each(calls)('%s %s refuses without a session before any upstream call', async (path, method, handler, input) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await handler(
      new Request(`https://admin.example${path}`, {
        method,
        headers: { origin: 'https://admin.example', 'content-type': 'application/json' },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
    );
    expect(result.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(calls.filter(([, method]) => method === 'POST'))('%s refuses a missing CSRF header', async (path, method, handler, input) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await handler(
      new Request(`https://admin.example${path}`, {
        method,
        headers: {
          cookie: `${ADMIN_COOKIE}=${sealFounderSession(session, adminSessionConfig())}`,
          origin: 'https://admin.example',
          'content-type': 'application/json',
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
    );
    expect(result.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses a mutation from another origin', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await changePassword(
      request(
        '/api/security/password',
        'POST',
        { currentPassword: 'x', newPassword: 'a-new-password-1' },
        { origin: 'https://evil.example' },
      ),
    );
    expect(result.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses an account that is no longer a founder', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(ok({ ...enabled, userId: randomUUID() })));
    const result = await recoveryCodes(request('/api/security/recovery-codes', 'POST', { proof }));
    expect(result.status).toBe(403);
  });
});

describe('GET /api/security', () => {
  it('combines the overview with the passkey list', async () => {
    const fetcher = upstream(
      ok({
        totpEnrolled: true,
        totpEnrolledAt: '2026-10-01T00:00:00.000Z',
        recoveryCodesRemaining: 8,
        passkeys: 1,
        passwordChangedAt: null,
      }),
      ok([{ credentialId: 'abc_-1', createdAt: '2026-10-02T00:00:00.000Z', transports: ['internal'] }]),
    );
    const result = await overviewGet(request('/api/security', 'GET'));
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({
      totpEnrolled: true,
      totpEnrolledAt: '2026-10-01T00:00:00.000Z',
      recoveryCodesRemaining: 8,
      passkeys: [{ id: 'abc_-1', createdAt: '2026-10-02T00:00:00.000Z' }],
      passkeysAvailable: true,
      passwordChangedAt: null,
    });
    const names = [1, 2].map((call) => procedure(fetcher, call)!.split('?')[0]).sort();
    expect(names).toEqual(['auth.securityOverview', 'webauthn.list']);
    expect(bearer(fetcher, 1)).toBe('Bearer founder-access-token');
  });
  it('still answers when passkeys are switched off, and says so', async () => {
    upstream(
      ok({
        totpEnrolled: true,
        totpEnrolledAt: null,
        recoveryCodesRemaining: 10,
        passkeys: 0,
        passwordChangedAt: '2026-10-03T00:00:00.000Z',
      }),
      Response.json({ error: { message: 'x', code: 'FORBIDDEN', data: {} } }, { status: 403 }),
    );
    const body = await (await overviewGet(request('/api/security', 'GET'))).json();
    expect(body).toMatchObject({ passkeys: [], passkeysAvailable: false, passwordChangedAt: '2026-10-03T00:00:00.000Z' });
  });
  it('refuses an overview it does not understand', async () => {
    upstream(ok({ totpEnrolled: 'yes' }), ok([]));
    expect((await overviewGet(request('/api/security', 'GET'))).status).toBe(502);
  });
});

describe('POST /api/security/password', () => {
  it('changes the password, signs the founder out and clears the cookie', async () => {
    const fetcher = upstream(ok({ ok: true }), ok({ signedOut: true }));
    const result = await changePassword(
      request('/api/security/password', 'POST', { currentPassword: 'old-password', newPassword: 'a-new-password-1' }),
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ signedOut: true });
    expect(result.headers.get('set-cookie')).toMatch(/^__Host-intafaced-admin=; .*Max-Age=0/);
    expect(procedure(fetcher, 1)).toBe('auth.changePassword');
    expect(bearer(fetcher, 1)).toBe('Bearer founder-access-token');
    expect(sentBody(fetcher, 1)).toEqual({ currentPassword: 'old-password', newPassword: 'a-new-password-1' });
    expect(procedure(fetcher, 2)).toBe('auth.logout');
    expect(sentBody(fetcher, 2)).toEqual({ refreshToken: 'founder-refresh-token' });
  });
  it('still clears the cookie when the logout call fails', async () => {
    upstream(ok({ ok: true }), Response.json({}, { status: 500 }));
    const result = await changePassword(
      request('/api/security/password', 'POST', { currentPassword: 'old-password', newPassword: 'a-new-password-1' }),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('keeps the session and carries the reason when the current password is wrong', async () => {
    const fetcher = upstream(refused(401, 'auth.invalid_credentials'));
    const result = await changePassword(
      request('/api/security/password', 'POST', { currentPassword: 'wrong', newPassword: 'a-new-password-1' }),
    );
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ code: 'admin.authority_refused', upstreamCode: 'auth.invalid_credentials' });
    expect(result.headers.get('set-cookie')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['a short new password', { currentPassword: 'x', newPassword: 'short' }],
    ['a huge new password', { currentPassword: 'x', newPassword: 'a'.repeat(201) }],
    ['no current password', { newPassword: 'a-new-password-1' }],
    ['an empty current password', { currentPassword: '', newPassword: 'a-new-password-1' }],
    ['an unknown key', { currentPassword: 'x', newPassword: 'a-new-password-1', extra: 1 }],
    ['a non-string', { currentPassword: 1, newPassword: 'a-new-password-1' }],
  ])('refuses %s before the upstream is asked', async (_name, input) => {
    const fetcher = upstream();
    const result = await changePassword(request('/api/security/password', 'POST', input));
    expect(result.status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/security/password/set', () => {
  it('steps up, sets the password with the step-up token only, signs out and never returns the token', async () => {
    const fetcher = upstream(ok({ accessToken: 'step-up-token', expiresAt: 'x', scopes: [] }), ok({ ok: true }), ok({ signedOut: true }));
    const result = await setPassword(
      request('/api/security/password/set', 'POST', { newPassword: 'a-new-password-1', proof: { webauthn: assertion } }),
    );
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('{"signedOut":true}');
    expect(result.headers.get('set-cookie')).toContain('Max-Age=0');
    expect([1, 2, 3].map((call) => procedure(fetcher, call))).toEqual(['auth.stepUp', 'auth.setPassword', 'auth.logout']);
    expect(bearer(fetcher, 1)).toBe('Bearer founder-access-token');
    expect(sentBody(fetcher, 1)).toEqual({ webauthn: assertion });
    expect(bearer(fetcher, 2)).toBe('Bearer step-up-token');
    expect(sentBody(fetcher, 2)).toEqual({ newPassword: 'a-new-password-1' });
  });
  it('does not set anything when the proof is refused', async () => {
    const fetcher = upstream(refused(401, 'auth.invalid_credentials'));
    const result = await setPassword(request('/api/security/password/set', 'POST', { newPassword: 'a-new-password-1', proof }));
    expect(result.status).toBe(401);
    expect(await result.json()).toMatchObject({ upstreamCode: 'auth.invalid_credentials' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.headers.get('set-cookie')).toBeNull();
  });
  it.each([
    ['no proof', { newPassword: 'a-new-password-1' }],
    ['a short code', { newPassword: 'a-new-password-1', proof: { totpCode: '123' } }],
    ['a short password', { newPassword: 'short', proof }],
  ])('refuses %s', async (_name, input) => {
    const fetcher = upstream();
    expect((await setPassword(request('/api/security/password/set', 'POST', input))).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/security/step-up/options', () => {
  it('returns the passkey challenge', async () => {
    const fetcher = upstream(ok({ challenge: 'abc', rpId: 'admin.example' }));
    const result = await stepUpOptions(request('/api/security/step-up/options', 'POST'));
    expect(await result.json()).toEqual({ challenge: 'abc', rpId: 'admin.example' });
    expect(procedure(fetcher, 1)).toBe('auth.stepUpOptions');
    expect(bearer(fetcher, 1)).toBe('Bearer founder-access-token');
  });
});

describe('POST /api/security/authenticator/replace-begin', () => {
  const secret = 'TESTSECRETTESTSECRET';
  const uri = `otpauth://totp/INTAFACED:test?secret=${secret}`;
  it('steps up with a recovery code, then returns only the new secret and uri', async () => {
    const fetcher = upstream(ok({ accessToken: 'step-up-token', expiresAt: 'x', scopes: [] }), ok({ secret, uri, pending: 'x' }));
    const result = await replaceBegin(request('/api/security/authenticator/replace-begin', 'POST', { proof: { totpCode: 'ABCDE-12345' } }));
    expect(await result.json()).toEqual({ secret, uri });
    expect([1, 2].map((call) => procedure(fetcher, call))).toEqual(['auth.stepUp', 'totp.replaceBegin']);
    expect(sentBody(fetcher, 1)).toEqual({ totpCode: 'ABCDE-12345' });
    expect(bearer(fetcher, 2)).toBe('Bearer step-up-token');
  });
  it('refuses a secret that is not an otpauth uri', async () => {
    upstream(ok({ accessToken: 't', expiresAt: 'x', scopes: [] }), ok({ secret, uri: 'https://evil.example' }));
    expect((await replaceBegin(request('/api/security/authenticator/replace-begin', 'POST', { proof }))).status).toBe(502);
  });
  it('refuses a missing proof', async () => {
    const fetcher = upstream();
    expect((await replaceBegin(request('/api/security/authenticator/replace-begin', 'POST', {}))).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/security/authenticator/replace-confirm', () => {
  it('confirms a code from the new app with the founder token', async () => {
    const fetcher = upstream(ok({ ok: true }));
    const result = await replaceConfirm(request('/api/security/authenticator/replace-confirm', 'POST', { code: '654321' }));
    expect(await result.json()).toEqual({ ok: true });
    expect(procedure(fetcher, 1)).toBe('totp.replaceConfirm');
    expect(bearer(fetcher, 1)).toBe('Bearer founder-access-token');
    expect(sentBody(fetcher, 1)).toEqual({ code: '654321' });
  });
  it('refuses a wrong code, passing on no reason the page has no copy for', async () => {
    upstream(refused(400, 'auth.invalid_totp'));
    const result = await replaceConfirm(request('/api/security/authenticator/replace-confirm', 'POST', { code: '000000' }));
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ code: 'admin.upstream_refused' });
  });
  it.each([
    ['a recovery code', { code: 'ABCDE-12345' }],
    ['a short code', { code: '123' }],
    ['an extra key', { code: '123456', secret: 'x' }],
  ])('refuses %s', async (_name, input) => {
    const fetcher = upstream();
    expect((await replaceConfirm(request('/api/security/authenticator/replace-confirm', 'POST', input))).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/security/recovery-codes', () => {
  it('steps up, then returns the ten new codes', async () => {
    const codes = Array.from({ length: 10 }, (_, index) => `FACED-1${String(index).padStart(5, '0')}`);
    const fetcher = upstream(ok({ accessToken: 'step-up-token', expiresAt: 'x', scopes: [] }), ok({ recoveryCodes: codes }));
    const result = await recoveryCodes(request('/api/security/recovery-codes', 'POST', { proof }));
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({ recoveryCodes: codes });
    expect(bearer(fetcher, 2)).toBe('Bearer step-up-token');
    expect(procedure(fetcher, 2)).toBe('totp.regenerateRecoveryCodes');
  });
  it('shows nothing when the proof is refused', async () => {
    const fetcher = upstream(refused(401, 'auth.invalid_credentials'));
    const result = await recoveryCodes(request('/api/security/recovery-codes', 'POST', { proof }));
    expect(result.status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('refuses codes it does not understand', async () => {
    upstream(ok({ accessToken: 't', expiresAt: 'x', scopes: [] }), ok({ recoveryCodes: 'nope' }));
    expect((await recoveryCodes(request('/api/security/recovery-codes', 'POST', { proof }))).status).toBe(502);
  });
});

describe('passkeys', () => {
  const credential = {
    id: 'abc',
    rawId: 'abc',
    type: 'public-key',
    response: { clientDataJSON: 'x', attestationObject: 'y', transports: ['internal'] },
    clientExtensionResults: {},
  };
  it('steps up, then asks for registration options with the step-up token', async () => {
    const fetcher = upstream(ok({ accessToken: 'step-up-token', expiresAt: 'x', scopes: [] }), ok({ challenge: 'c' }));
    const result = await passkeyOptions(request('/api/security/passkeys/options', 'POST', { proof }));
    expect(await result.json()).toEqual({ challenge: 'c' });
    expect([1, 2].map((call) => procedure(fetcher, call))).toEqual(['auth.stepUp', 'webauthn.registerOptions']);
    expect(bearer(fetcher, 1)).toBe('Bearer founder-access-token');
    expect(bearer(fetcher, 2)).toBe('Bearer step-up-token');
  });
  it('refuses to add a passkey without a proof, or with a refused one', async () => {
    for (const body of [{}, { proof: { totpCode: '12' } }]) {
      const fetcher = upstream();
      expect((await passkeyOptions(request('/api/security/passkeys/options', 'POST', body))).status).toBe(400);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const refusing = upstream(refused(401, 'auth.invalid_credentials'));
    const result = await passkeyOptions(request('/api/security/passkeys/options', 'POST', { proof }));
    expect(result.status).toBe(401);
    expect(refusing).toHaveBeenCalledTimes(2);
  });
  it('forwards only the known registration fields', async () => {
    const fetcher = upstream(ok({ credentialId: 'abc' }));
    const result = await passkeyVerify(request('/api/security/passkeys/verify', 'POST', credential));
    expect(await result.json()).toEqual({ credentialId: 'abc' });
    expect(procedure(fetcher, 1)).toBe('webauthn.registerVerify');
    expect(sentBody(fetcher, 1)).toEqual(credential);
  });
  it.each([
    ['an unknown top-level key', { ...credential, extra: 1 }],
    ['an unknown response key', { ...credential, response: { ...credential.response, extra: 1 } }],
    ['a wrong type', { ...credential, type: 'password' }],
    ['a missing attestation', { ...credential, response: { clientDataJSON: 'x' } }],
    ['oversized data', { ...credential, response: { ...credential.response, attestationObject: 'x'.repeat(5000) } }],
  ])('refuses registration with %s', async (_name, input) => {
    const fetcher = upstream();
    const result = await passkeyVerify(request('/api/security/passkeys/verify', 'POST', input));
    // An unknown key is refused by the allowlist (400) and the rest by shape checks (400).
    expect(result.status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  const remove = (id: string, body: unknown = { proof }) =>
    passkeyRemove(request(`/api/security/passkeys/${id}`, 'DELETE', body), { params: Promise.resolve({ id }) });
  it('steps up, then removes one passkey by id with the step-up token', async () => {
    const fetcher = upstream(ok({ accessToken: 'step-up-token', expiresAt: 'x', scopes: [] }), ok({ removed: true }));
    const result = await remove('abc_-1');
    expect(await result.json()).toEqual({ removed: true });
    expect([1, 2].map((call) => procedure(fetcher, call))).toEqual(['auth.stepUp', 'webauthn.remove']);
    expect(bearer(fetcher, 2)).toBe('Bearer step-up-token');
    expect(sentBody(fetcher, 2)).toEqual({ credentialId: 'abc_-1' });
  });
  it.each([
    ['no body proof', {}],
    ['a short code', { proof: { totpCode: '12' } }],
    ['an unknown key', { proof, extra: 1 }],
  ])('refuses removal with %s before any identity call', async (_name, body) => {
    const fetcher = upstream();
    expect((await remove('abc', body)).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses removal with no JSON body at all', async () => {
    const fetcher = upstream();
    const bare = request('/api/security/passkeys/abc', 'DELETE');
    expect((await passkeyRemove(bare, { params: Promise.resolve({ id: 'abc' }) })).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not remove anything when the proof is refused', async () => {
    const fetcher = upstream(refused(401, 'auth.invalid_credentials'));
    const result = await remove('abc');
    expect(result.status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('refuses when identity does, such as removing the last passkey, without passing on a code the page has no copy for', async () => {
    upstream(ok({ accessToken: 't', expiresAt: 'x', scopes: [] }), refused(409, 'auth.last_factor'));
    const result = await remove('abc');
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ code: 'admin.upstream_refused' });
  });
  it('refuses an id that is not base64url without asking identity', async () => {
    const fetcher = upstream();
    expect((await remove('a/../b')).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('needs the CSRF header', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const bad = new Request('https://admin.example/api/security/passkeys/abc', {
      method: 'DELETE',
      headers: {
        cookie: `${ADMIN_COOKIE}=${sealFounderSession(session, adminSessionConfig())}`,
        origin: 'https://admin.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ proof }),
    });
    expect((await passkeyRemove(bad, { params: Promise.resolve({ id: 'abc' }) })).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('upstream codes are opt-in', () => {
  it.each([
    ['auth.too_many_attempts', 429],
    ['auth.password_unchanged', 400],
    ['auth.password_policy', 400],
    ['auth.mfa_required', 403],
    ['auth.invalid_credentials', 401],
  ])('passes on %s, which the page has copy for', async (code, status) => {
    upstream(refused(status, code));
    const result = await changePassword(
      request('/api/security/password', 'POST', { currentPassword: 'old-password', newPassword: 'a-new-password-1' }),
    );
    expect(await result.json()).toMatchObject({ upstreamCode: code });
  });
  it('drops any code the page has no copy for', async () => {
    for (const code of ['auth.mfa_not_enrolled', 'auth.user_not_found', 'auth.reset_refused']) {
      upstream(refused(400, code));
      const result = await changePassword(
        request('/api/security/password', 'POST', { currentPassword: 'old-password', newPassword: 'a-new-password-1' }),
      );
      expect(await result.json()).toEqual({ code: 'admin.upstream_refused' });
    }
  });
});
