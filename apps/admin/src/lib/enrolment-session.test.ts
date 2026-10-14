import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE, AdminSessionError, openFounderSession, sealFounderSession, type AdminSessionConfig } from './founder-session';
import {
  authorizeEnrolment,
  liveStepUpToken,
  refreshEnrolmentSession,
  withoutStepUp,
  withStepUp,
  ENROL_COOKIE,
  ENROL_MAX_AGE_MS,
  enrolmentCookie,
  enrolmentCookieAge,
  enrolmentIsOpen,
  enrolmentOffResponse,
  newEnrolmentSession,
  openEnrolmentSession,
  sealEnrolmentSession,
  type EnrolmentSession,
} from './enrolment-session';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://admin.example.test';
const CSRF = Buffer.alloc(32, 8).toString('base64url');

function config(overrides: Partial<AdminSessionConfig> = {}): AdminSessionConfig {
  return { origin: ORIGIN, edgeUrl: 'https://edge.example.test', key: Buffer.alloc(32, 7), ...overrides };
}

function session(overrides: Partial<EnrolmentSession> = {}): EnrolmentSession {
  return {
    userId: USER_ID,
    accessToken: 'enrol-access-token',
    refreshToken: 'enrol-refresh-token',
    issuedAt: NOW.toISOString(),
    accessExpiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
    csrf: CSRF,
    totpConfirmed: false,
    stepUpToken: null,
    stepUpExpiresAt: null,
    ...overrides,
  };
}

const header = (name: string, value: string) => `${name}=${value}`;
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as AdminSessionError;
  }
  throw new Error('expected a refusal');
};

describe('enrolment session', () => {
  it('seals and opens, and carries totpConfirmed', () => {
    const sealed = sealEnrolmentSession(session({ totpConfirmed: true }), config(), NOW);
    expect(openEnrolmentSession(header(ENROL_COOKIE, sealed), config(), NOW)).toEqual(session({ totpConfirmed: true }));
  });

  it('is its own cookie, with its own name and no tokens in the clear', () => {
    expect(ENROL_COOKIE).toBe('__Host-intafaced-enrol');
    expect(ENROL_COOKIE).not.toBe(ADMIN_COOKIE);
    const sealed = sealEnrolmentSession(session(), config(), NOW);
    expect(sealed).not.toContain('enrol-access-token');
    expect(enrolmentCookie(sealed, 1200)).toBe(`${ENROL_COOKIE}=${sealed}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=1200`);
    expect(enrolmentCookie('', 0)).toContain('Max-Age=0');
  });

  it('never opens a founder cookie as an enrolment session, even renamed', () => {
    const founder = sealFounderSession(
      { userId: USER_ID, accessToken: 'a', refreshToken: 'r', issuedAt: NOW.toISOString(), expiresAt: session().expiresAt, csrf: CSRF },
      config(),
      NOW,
    );
    expect(refusal(() => openEnrolmentSession(header(ADMIN_COOKIE, founder), config(), NOW)).code).toBe('admin.enrolment_required');
    expect(refusal(() => openEnrolmentSession(header(ENROL_COOKIE, founder), config(), NOW)).code).toBe('admin.enrolment_required');
  });

  it('never opens an enrolment cookie as a founder session, even renamed, so console routes are out of reach', () => {
    const enrol = sealEnrolmentSession(session({ totpConfirmed: true }), config(), NOW);
    expect(refusal(() => openFounderSession(header(ENROL_COOKIE, enrol), config(), NOW)).code).toBe('admin.session_required');
    expect(refusal(() => openFounderSession(header(ADMIN_COOKIE, enrol), config(), NOW)).code).toBe('admin.session_required');
  });

  it('is bound to the key and the origin', () => {
    const sealed = sealEnrolmentSession(session(), config(), NOW);
    expect(() => openEnrolmentSession(header(ENROL_COOKIE, sealed), config({ key: Buffer.alloc(32, 9) }), NOW)).toThrow();
    expect(() => openEnrolmentSession(header(ENROL_COOKIE, sealed), config({ origin: 'https://other.example.test' }), NOW)).toThrow();
  });

  it('refuses a tampered, duplicated, missing or expired cookie', () => {
    const sealed = sealEnrolmentSession(session(), config(), NOW);
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(() => openEnrolmentSession(header(ENROL_COOKIE, flipped), config(), NOW)).toThrow();
    expect(() => openEnrolmentSession(`${header(ENROL_COOKIE, sealed)}; ${header(ENROL_COOKIE, sealed)}`, config(), NOW)).toThrow();
    expect(() => openEnrolmentSession(null, config(), NOW)).toThrow();
    expect(() => openEnrolmentSession(header(ENROL_COOKIE, sealed), config(), new Date(NOW.getTime() + 21 * 60_000))).toThrow();
  });

  it('validates the payload strictly on seal', () => {
    const bad: Array<Partial<EnrolmentSession> | Record<string, unknown>> = [
      { userId: 'not-a-uuid' },
      { accessToken: '' },
      { refreshToken: 'r'.repeat(257) },
      { csrf: 'short' },
      { totpConfirmed: 'yes' },
      { expiresAt: new Date(NOW.getTime() + ENROL_MAX_AGE_MS + 60_000).toISOString() },
      { accessExpiresAt: 'soon' },
      { expiresAt: new Date(NOW.getTime() - 1).toISOString() },
      { issuedAt: new Date(NOW.getTime() + 60_000).toISOString() },
    ];
    for (const change of bad) expect(() => sealEnrolmentSession({ ...session(), ...change } as EnrolmentSession, config(), NOW)).toThrow();
    expect(() => sealEnrolmentSession({ ...session(), extra: 1 } as EnrolmentSession, config(), NOW)).toThrow();
    const { totpConfirmed: _omitted, ...missing } = session();
    expect(() => sealEnrolmentSession(missing as EnrolmentSession, config(), NOW)).toThrow();
  });

  it('builds a session from identity tokens: 30 minutes from register, whatever the access token does', () => {
    const upstream = {
      userId: USER_ID,
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    };
    const created = newEnrolmentSession(upstream, NOW);
    expect(Date.parse(created.expiresAt) - NOW.getTime()).toBe(ENROL_MAX_AGE_MS);
    expect(created.accessExpiresAt).toBe(upstream.expiresAt);
    expect(enrolmentCookieAge(created, NOW)).toBe(1800);
    expect(created).toMatchObject({ totpConfirmed: false, stepUpToken: null, stepUpExpiresAt: null });
    expect(created.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => newEnrolmentSession({ ...upstream, userId: 'nope' }, NOW)).toThrow();
    expect(() => newEnrolmentSession({ ...upstream, expiresAt: 'soon' }, NOW)).toThrow();
    expect(() => newEnrolmentSession(null, NOW)).toThrow();
  });

  it('holds a step-up token for at most five minutes and never past the enrolment, and drops it on request', () => {
    const base = session();
    const held = withStepUp(base, 'step-up-token', new Date(NOW.getTime() + 60 * 60_000).toISOString(), NOW);
    expect(Date.parse(held.stepUpExpiresAt!) - NOW.getTime()).toBe(5 * 60_000);
    expect(liveStepUpToken(held, NOW)).toBe('step-up-token');
    expect(liveStepUpToken(held, new Date(NOW.getTime() + 5 * 60_000 + 1))).toBeNull();
    expect(withStepUp(base, 't', new Date(NOW.getTime() + 60_000).toISOString(), NOW).stepUpExpiresAt).toBe(
      new Date(NOW.getTime() + 60_000).toISOString(),
    );
    expect(() => withStepUp(base, '', NOW.toISOString(), NOW)).toThrow();
    expect(() => withStepUp(base, 't', 'soon', NOW)).toThrow();
    expect(liveStepUpToken(base, NOW)).toBeNull();
    expect(withoutStepUp(held)).toMatchObject({ stepUpToken: null, stepUpExpiresAt: null });
    // It survives the sealed cookie, and the token is not readable in it.
    const sealed = sealEnrolmentSession(held, config(), NOW);
    expect(sealed).not.toContain('step-up-token');
    expect(openEnrolmentSession(header(ENROL_COOKIE, sealed), config(), NOW).stepUpToken).toBe('step-up-token');
  });

  it('fits in a cookie with realistic token sizes', () => {
    // A real access token measured at about 907 characters and a step-up token at about 929 (26 session scopes). Use a little more.
    const real = session({
      accessToken: 'a'.repeat(960),
      refreshToken: 'r'.repeat(64),
      stepUpToken: 's'.repeat(960),
      stepUpExpiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
      totpConfirmed: true,
    });
    const sealed = sealEnrolmentSession(real, config(), NOW);
    const margin = 3800 - sealed.length;
    // Measured at roughly 3050 of 3800: well over 600 characters to spare, room for around 20 more scopes.
    expect(sealed.length).toBeLessThan(3800);
    expect(margin).toBeGreaterThan(600);
    expect(enrolmentCookie(sealed, 1800).length).toBeLessThan(4096);
  });

  it('refuses a half-set or over-long step-up on seal', () => {
    expect(() => sealEnrolmentSession(session({ stepUpToken: 't' }), config(), NOW)).toThrow();
    expect(() => sealEnrolmentSession(session({ stepUpExpiresAt: NOW.toISOString() }), config(), NOW)).toThrow();
    expect(() =>
      sealEnrolmentSession(
        session({ stepUpToken: 't', stepUpExpiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString() }),
        config(),
        NOW,
      ),
    ).toThrow();
    expect(() =>
      sealEnrolmentSession(session({ stepUpToken: 'x'.repeat(2601), stepUpExpiresAt: NOW.toISOString() }), config(), NOW),
    ).toThrow();
  });

  describe('refresh', () => {
    afterEach(() => vi.unstubAllGlobals());
    const stub = (reply: () => Response) => {
      const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => reply());
      vi.stubGlobal('fetch', fetcher);
      return fetcher;
    };
    const tokens = (extra: Record<string, unknown> = {}) =>
      Response.json({
        result: {
          data: {
            json: {
              userId: USER_ID,
              accessToken: 'new-access',
              refreshToken: 'new-refresh',
              expiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
              ...extra,
            },
          },
        },
      });

    it('swaps the tokens and keeps the csrf, the enrolment end and the step', async () => {
      const fetcher = stub(() => tokens());
      const before = session({ totpConfirmed: true });
      const after = await refreshEnrolmentSession(before, config(), NOW);
      expect(after).toEqual({
        ...before,
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        accessExpiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
      });
      expect(fetcher.mock.calls[0]![0]).toBe('https://edge.example.test/api/identity/trpc/auth.refresh');
      expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ refreshToken: 'enrol-refresh-token' });
    });

    it.each([
      ['a refusal', () => Response.json({ error: {} }, { status: 403 })],
      ['another account', () => tokens({ userId: '22222222-2222-4222-8222-222222222222' })],
      ['no access token', () => tokens({ accessToken: '' })],
      ['a bad expiry', () => tokens({ expiresAt: 'later' })],
    ])('gives admin.enrolment_expired on %s', async (_name, reply) => {
      stub(reply);
      expect(await refreshEnrolmentSession(session(), config(), NOW).catch((error: AdminSessionError) => error.code)).toBe(
        'admin.enrolment_expired',
      );
    });

    it('gives admin.enrolment_expired when the network is down', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Promise.reject(new TypeError('offline'))),
      );
      expect(await refreshEnrolmentSession(session(), config(), NOW).catch((error: AdminSessionError) => error.code)).toBe(
        'admin.enrolment_expired',
      );
    });
  });

  it('is off unless ADMIN_FOUNDER_ENROLMENT is exactly open', () => {
    expect(enrolmentIsOpen({})).toBe(false);
    expect(enrolmentIsOpen({ ADMIN_FOUNDER_ENROLMENT: 'true' })).toBe(false);
    expect(enrolmentIsOpen({ ADMIN_FOUNDER_ENROLMENT: 'OPEN' })).toBe(false);
    expect(enrolmentIsOpen({ ADMIN_FOUNDER_ENROLMENT: 'open' })).toBe(true);
    expect(enrolmentOffResponse().status).toBe(404);
  });

  it('authorizeEnrolment wants the origin, the cookie and the matching CSRF header, and the authenticator when asked', async () => {
    const env = {
      ADMIN_ORIGIN: ORIGIN,
      EDGE_URL: 'https://edge.example.test',
      ADMIN_SESSION_SECRET: Buffer.alloc(32, 7).toString('base64url'),
    };
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const live = session({
        issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
      const cookie = header(ENROL_COOKIE, sealEnrolmentSession(live, config()));
      const request = (headers: Record<string, string>) =>
        new Request(`${ORIGIN}/api/enroll/finish`, { method: 'POST', headers: { origin: ORIGIN, ...headers } });
      expect(authorizeEnrolment(request({ cookie, 'x-intafaced-csrf': CSRF })).session.userId).toBe(USER_ID);
      expect(refusal(() => authorizeEnrolment(request({ cookie }))).code).toBe('admin.session_csrf');
      expect(refusal(() => authorizeEnrolment(request({ cookie, 'x-intafaced-csrf': 'x'.repeat(43) }))).code).toBe('admin.session_csrf');
      expect(refusal(() => authorizeEnrolment(request({ 'x-intafaced-csrf': CSRF }))).code).toBe('admin.enrolment_required');
      expect(refusal(() => authorizeEnrolment(request({ cookie, 'x-intafaced-csrf': CSRF, origin: 'https://evil.example' }))).code).toBe(
        'admin.session_origin',
      );
      expect(refusal(() => authorizeEnrolment(request({ cookie, 'x-intafaced-csrf': CSRF }), { confirmed: true })).code).toBe(
        'admin.enrolment_totp_required',
      );
      const confirmed = header(ENROL_COOKIE, sealEnrolmentSession({ ...live, totpConfirmed: true }, config()));
      expect(authorizeEnrolment(request({ cookie: confirmed, 'x-intafaced-csrf': CSRF }), { confirmed: true }).session.totpConfirmed).toBe(
        true,
      );
    } finally {
      process.env = saved;
    }
  });
});
