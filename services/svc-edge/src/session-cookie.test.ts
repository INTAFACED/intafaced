import { describe, expect, it } from 'vitest';
import {
  answerRefusal,
  clearedCookieValue,
  cookieIsSecure,
  finishSessionCookie,
  planSessionCookie,
  readRefreshCookie,
  refreshCookieValue,
  REFRESH_COOKIE,
  type SessionCookiePlan,
} from './session-cookie.js';

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123_-abcDEF12';
const http = { secure: false, maxAgeSeconds: 2_592_000 };
const https = { secure: true, maxAgeSeconds: 2_592_000 };
const csrf = { 'x-session-request': '1', cookie: `${REFRESH_COOKIE}=${TOKEN}` };

describe('cookie attributes', () => {
  it('is HttpOnly, SameSite=Strict, scoped to the session path, and Secure only on https', () => {
    const plain = refreshCookieValue(TOKEN, http);
    expect(plain).toBe(`${REFRESH_COOKIE}=${TOKEN}; Path=/api/identity/session; HttpOnly; SameSite=Strict; Max-Age=2592000`);
    expect(plain).not.toContain('Secure');
    expect(refreshCookieValue(TOKEN, https)).toMatch(/; Secure$/);
    expect(clearedCookieValue(http)).toContain('Max-Age=0');
    expect(clearedCookieValue(https)).toMatch(/Max-Age=0; Secure$/);
  });

  it('is Secure on https and in hosted environments, not on the local http stack', () => {
    expect(cookieIsSecure('http', 'dev')).toBe(false);
    expect(cookieIsSecure('http', 'test')).toBe(false);
    expect(cookieIsSecure('https', 'dev')).toBe(true);
    expect(cookieIsSecure('http', 'staging')).toBe(true);
    expect(cookieIsSecure('http', 'prod')).toBe(true);
  });
});

describe('reading the cookie', () => {
  it('finds ours among others, treats empty as absent, and refuses a duplicate', () => {
    expect(readRefreshCookie(`a=1; ${REFRESH_COOKIE}=${TOKEN}; b=2`)).toBe(TOKEN);
    expect(readRefreshCookie(undefined)).toBeNull();
    expect(readRefreshCookie(`${REFRESH_COOKIE}=`)).toBeNull();
    expect(readRefreshCookie(`${REFRESH_COOKIE}=${TOKEN}; ${REFRESH_COOKIE}=other`)).toBe('ambiguous');
  });
});

describe('planning', () => {
  const plan = (path: string, headers: Record<string, string>, method = 'POST', module = 'identity') =>
    planSessionCookie({ module, path, method, headers });

  it('only touches the identity module', () => {
    expect(plan('/session/refresh', csrf, 'POST', 'trade').kind).toBe('none');
    expect(plan('/trpc/auth.login', { 'x-session-transport': 'cookie' }, 'POST', 'pay').kind).toBe('none');
  });

  it('leaves ordinary sign-in alone unless the caller asks for the cookie', () => {
    expect(plan('/trpc/auth.login', {}).kind).toBe('none');
    expect(plan('/trpc/auth.login', { 'x-session-transport': 'cookie' }).kind).toBe('mint');
    expect(plan('/trpc/auth.register', { 'x-session-transport': 'cookie' }).kind).toBe('mint');
    expect(plan('/trpc/webauthn.authVerify', { 'x-session-transport': 'cookie' }).kind).toBe('mint');
    expect(plan('/trpc/auth.changePassword', { 'x-session-transport': 'cookie' }).kind).toBe('none');
  });

  it('builds the refresh from the cookie only, ignoring any bearer token or body', () => {
    const p = plan('/session/refresh', { ...csrf, authorization: 'Bearer stolen.access.token' });
    expect(p).toEqual({ kind: 'refresh', path: '/trpc/auth.refresh', body: JSON.stringify({ refreshToken: TOKEN }) });
  });

  it('refuses refresh without a cookie, even with a valid-looking bearer token', () => {
    const p = plan('/session/refresh', { 'x-session-request': '1', authorization: 'Bearer stolen.access.token' });
    expect(p).toMatchObject({ kind: 'refuse', status: 401, code: 'session.no_cookie' });
  });

  it('CSRF: needs the custom header, POST, and a same-origin fetch when the browser says', () => {
    expect(plan('/session/refresh', { cookie: csrf.cookie })).toMatchObject({
      kind: 'refuse',
      status: 403,
      code: 'session.csrf_header_missing',
    });
    expect(plan('/session/refresh', { ...csrf, 'x-session-request': '0' })).toMatchObject({ status: 403 });
    expect(plan('/session/refresh', csrf, 'GET')).toMatchObject({ status: 405 });
    expect(plan('/session/refresh', { ...csrf, 'sec-fetch-site': 'cross-site' })).toMatchObject({
      status: 403,
      code: 'session.cross_site',
    });
    expect(plan('/session/refresh', { ...csrf, 'sec-fetch-site': 'same-site' })).toMatchObject({ status: 403 });
    expect(plan('/session/refresh', { ...csrf, 'sec-fetch-site': 'same-origin' }).kind).toBe('refresh');
  });

  it('refuses a malformed or duplicated cookie and clears it', () => {
    expect(plan('/session/refresh', { 'x-session-request': '1', cookie: `${REFRESH_COOKIE}=bad;token` })).toMatchObject({
      status: 401,
      clearCookie: true,
    });
    expect(plan('/session/refresh', { 'x-session-request': '1', cookie: `${csrf.cookie}; ${csrf.cookie}` })).toMatchObject({
      status: 401,
      code: 'session.cookie_ambiguous',
    });
  });

  it('logout with nothing to revoke succeeds without an upstream call and clears the cookie', () => {
    const p = plan('/session/logout', { 'x-session-request': '1' }) as Extract<SessionCookiePlan, { kind: 'refuse' }>;
    expect(p).toMatchObject({ kind: 'refuse', status: 200, ok: true, clearCookie: true });
    const answered = answerRefusal(p, http);
    expect(JSON.parse(answered.body)).toEqual({ result: { data: { ok: true } } });
    expect(answered.setCookie[0]).toContain('Max-Age=0');
  });
});

describe('finishing', () => {
  const session = {
    accessToken: 'a.b.c',
    refreshToken: TOKEN,
    expiresAt: '2030-01-01T00:00:00.000Z',
    userId: '11111111-1111-4111-8111-111111111111',
  };
  const ok = (data: unknown) => ({ status: 200, text: JSON.stringify({ result: { data } }) });

  it('moves the refresh token from the body into the cookie', () => {
    const done = finishSessionCookie({ kind: 'mint' }, ok(session), http);
    expect(done.setCookie).toEqual([refreshCookieValue(TOKEN, http)]);
    const data = JSON.parse(done.body).result.data;
    expect(data.refreshToken).toBeUndefined();
    expect(data).toMatchObject({ accessToken: 'a.b.c', userId: session.userId });
    expect(done.body).not.toContain(TOKEN);
  });

  it('handles a batched answer', () => {
    const done = finishSessionCookie({ kind: 'mint' }, { status: 200, text: JSON.stringify([{ result: { data: session } }]) }, http);
    expect(done.body).not.toContain(TOKEN);
    expect(done.setCookie).toHaveLength(1);
  });

  it('passes a sign-in that minted nothing (second factor pending) through untouched', () => {
    const text = JSON.stringify({ result: { data: { mfaRequired: true } } });
    expect(finishSessionCookie({ kind: 'mint' }, { status: 200, text }, http)).toEqual({ status: 200, body: text, setCookie: [] });
  });

  it('a refresh that answers without a session fails closed and leaks nothing', () => {
    const done = finishSessionCookie({ kind: 'refresh', path: '', body: '' }, ok({}), http);
    expect(done.status).toBe(502);
    expect(done.setCookie).toEqual([]);
  });

  it('refuses to put a token with header-breaking characters in a cookie', () => {
    const done = finishSessionCookie({ kind: 'mint' }, ok({ ...session, refreshToken: 'x; Domain=evil.example' }), http);
    expect(done.status).toBe(502);
    expect(done.setCookie).toEqual([]);
    expect(done.body).not.toContain('evil.example');
  });

  it('clears the cookie when identity refuses a refresh (expired, revoked, reuse), keeps it on an outage', () => {
    const refresh: SessionCookiePlan = { kind: 'refresh', path: '', body: '' };
    expect(finishSessionCookie(refresh, { status: 401, text: '{}' }, http).setCookie[0]).toContain('Max-Age=0');
    expect(finishSessionCookie(refresh, { status: 403, text: '{}' }, http).setCookie[0]).toContain('Max-Age=0');
    expect(finishSessionCookie(refresh, { status: 503, text: '{}' }, http).setCookie).toEqual([]);
    expect(finishSessionCookie(refresh, { status: 500, text: '{}' }, http).setCookie).toEqual([]);
  });

  it('logout always clears the cookie and passes identity status through', () => {
    const logout: SessionCookiePlan = { kind: 'logout', path: '', body: '' };
    expect(finishSessionCookie(logout, ok({ ok: true }), http).setCookie[0]).toContain('Max-Age=0');
    const down = finishSessionCookie(logout, { status: 503, text: '{}' }, http);
    expect(down.status).toBe(503);
    expect(down.setCookie[0]).toContain('Max-Age=0');
  });

  it('does not touch an ordinary proxied answer', () => {
    expect(finishSessionCookie({ kind: 'none' }, { status: 201, text: 'x' }, http)).toEqual({ status: 201, body: 'x', setCookie: [] });
  });
});
