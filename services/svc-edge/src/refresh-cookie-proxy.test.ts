import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { forwardUpstreamResponseHeaders, prepareUpstreamRequestHeaders, refuseCookieCsrf } from './refresh-cookie-proxy.js';

const here = dirname(fileURLToPath(import.meta.url));

function headers(lines: string[], contentType = 'application/json') {
  return {
    get(name: string) {
      if (name === 'content-type') return contentType;
      if (name === 'set-cookie') return lines[0] ?? null;
      return null;
    },
    getSetCookie: () => lines,
  };
}

describe('refresh cookie at the edge', () => {
  it('passes Set-Cookie on auth routes and rewrites the path to the public prefix', () => {
    const forwarded = forwardUpstreamResponseHeaders(
      '/api/identity/trpc/auth.login',
      headers([
        'ifc_rt=secret; HttpOnly; SameSite=Strict; Path=/trpc/auth.refresh; Max-Age=2592000',
        'ifc_rt=secret; HttpOnly; SameSite=Strict; Path=/trpc/auth.logout; Max-Age=2592000',
      ]),
    );
    expect(forwarded['content-type']).toBe('application/json');
    expect(forwarded['set-cookie']).toEqual([
      'ifc_rt=secret; HttpOnly; SameSite=Strict; Path=/api/identity/trpc/auth.refresh; Max-Age=2592000',
      'ifc_rt=secret; HttpOnly; SameSite=Strict; Path=/api/identity/trpc/auth.logout; Max-Age=2592000',
    ]);
  });

  it('passes Set-Cookie on passkey verify', () => {
    const forwarded = forwardUpstreamResponseHeaders(
      '/api/identity/trpc/webauthn.authVerify',
      headers([
        'ifc_rt=secret; HttpOnly; SameSite=Strict; Path=/trpc/auth.refresh; Max-Age=2592000',
        'ifc_rt=secret; HttpOnly; SameSite=Strict; Path=/trpc/auth.logout; Max-Age=2592000',
      ]),
    );
    expect(forwarded['set-cookie']).toEqual([
      'ifc_rt=secret; HttpOnly; SameSite=Strict; Path=/api/identity/trpc/auth.refresh; Max-Age=2592000',
      'ifc_rt=secret; HttpOnly; SameSite=Strict; Path=/api/identity/trpc/auth.logout; Max-Age=2592000',
    ]);
  });

  it('drops Set-Cookie on every other route', () => {
    const forwarded = forwardUpstreamResponseHeaders('/api/trade/trpc/orders.list', headers(['ifc_rt=secret; Path=/trpc/auth.refresh']));
    expect(forwarded['set-cookie']).toBeUndefined();
    expect(forwarded['content-type']).toBe('application/json');
  });

  it('forwards Cookie only to auth routes', () => {
    const headersIn = { cookie: 'ifc_rt=secret', accept: 'application/json' };
    expect(prepareUpstreamRequestHeaders('/api/identity/trpc/auth.refresh', headersIn)).toMatchObject({ cookie: 'ifc_rt=secret' });
    expect(prepareUpstreamRequestHeaders('/api/trade/trpc/orders.list', headersIn).cookie).toBeUndefined();
    expect(prepareUpstreamRequestHeaders('/api/trade/trpc/orders.list', headersIn).accept).toBe('application/json');
  });

  it('refuses a cookie-authenticated auth mutation from a foreign origin', () => {
    const foreign = refuseCookieCsrf({
      method: 'POST',
      pathname: '/api/identity/trpc/auth.refresh',
      headers: { cookie: 'ifc_rt=secret', origin: 'http://localhost:9999', host: 'localhost:4000' },
      allowedOrigins: ['https://app.example.com'],
    });
    expect(foreign).toEqual({ code: 'edge.origin_not_allowed' });

    const listed = refuseCookieCsrf({
      method: 'POST',
      pathname: '/api/identity/trpc/auth.logout',
      headers: { cookie: 'ifc_rt=secret', origin: 'https://app.example.com', host: 'edge.internal' },
      allowedOrigins: ['https://app.example.com'],
    });
    expect(listed).toBeNull();

    const sameHost = refuseCookieCsrf({
      method: 'POST',
      pathname: '/api/identity/trpc/auth.refresh',
      headers: { cookie: 'ifc_rt=secret', origin: 'https://app.example.com', host: 'app.example.com' },
      allowedOrigins: [],
    });
    expect(sameHost).toEqual({ code: 'edge.origin_not_allowed' });

    const noCookie = refuseCookieCsrf({
      method: 'POST',
      pathname: '/api/identity/trpc/auth.refresh',
      headers: { origin: 'https://evil.example', host: 'app.example.com' },
      allowedOrigins: [],
    });
    expect(noCookie).toBeNull();
  });

  it('index.ts refuses the cookie before it proxies upstream', () => {
    const src = readFileSync(join(here, 'index.ts'), 'utf8');
    const csrfCall = src.indexOf('refuseCookieCsrf(');
    const refuseReturn = src.indexOf('code: csrf.code');
    const fetchCall = src.indexOf('await fetch(');
    expect(csrfCall).toBeGreaterThan(-1);
    expect(refuseReturn).toBeGreaterThan(csrfCall);
    expect(fetchCall).toBeGreaterThan(refuseReturn);
    expect(src).toContain('prepareUpstreamRequestHeaders(');
    expect(src).toContain('forwardUpstreamResponseHeaders(');
  });
});

describe('cookie csrf on refresh and logout', () => {
  const allowed = ['https://app.example.com'] as const;

  function decide(
    headers: { [key: string]: string | string[] | undefined },
    pathname = '/api/identity/trpc/auth.refresh',
    origins: readonly string[] = allowed,
  ) {
    return refuseCookieCsrf({ method: 'POST', pathname, headers, allowedOrigins: origins });
  }

  it('refuses no Origin and no session header, and does not rotate or revoke', async () => {
    let token = 'refresh-1';
    let revoked = false;
    const app = Fastify({ logger: false });
    const gate = (method: string, url: string, headers: { [key: string]: string | string[] | undefined }) =>
      refuseCookieCsrf({
        method,
        pathname: url.split('?')[0] ?? url,
        headers,
        allowedOrigins: allowed,
      });
    app.post('/api/identity/trpc/auth.refresh', async (req, reply) => {
      const csrf = gate(req.method, req.url, req.headers);
      if (csrf) return reply.code(403).send({ code: csrf.code });
      token = 'refresh-2';
      return { ok: true };
    });
    app.post('/api/identity/trpc/auth.logout', async (req, reply) => {
      const csrf = gate(req.method, req.url, req.headers);
      if (csrf) return reply.code(403).send({ code: csrf.code });
      revoked = true;
      return { ok: true };
    });
    await app.ready();
    try {
      const refresh = await app.inject({
        method: 'POST',
        url: '/api/identity/trpc/auth.refresh',
        headers: { cookie: 'ifc_rt=refresh-1' },
        payload: {},
      });
      expect(refresh.statusCode).toBe(403);
      expect(refresh.json()).toEqual({ code: 'auth.csrf_origin_required' });
      expect(token).toBe('refresh-1');

      const logout = await app.inject({
        method: 'POST',
        url: '/api/identity/trpc/auth.logout',
        headers: { cookie: 'ifc_rt=refresh-1' },
        payload: {},
      });
      expect(logout.statusCode).toBe(403);
      expect(logout.json()).toEqual({ code: 'auth.csrf_origin_required' });
      expect(revoked).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('allows an Origin on the allowlist', () => {
    expect(decide({ cookie: 'ifc_rt=secret', origin: 'https://app.example.com', host: 'edge.internal' })).toBeNull();
  });

  it('allows the session header with no Origin, including when the allowlist is empty', () => {
    expect(decide({ cookie: 'ifc_rt=secret', 'x-session-request': '1' }, '/api/identity/trpc/auth.logout', [])).toBeNull();
    expect(decide({ cookie: 'ifc_rt=secret', 'X-Session-Request': '1' }, '/api/identity/trpc/auth.refresh', [])).toBeNull();
    expect(
      decide({ cookie: 'ifc_rt=secret', origin: 'https://evil.example', 'x-session-request': '1' }, '/api/identity/trpc/auth.refresh', []),
    ).toBeNull();
  });

  it('refuses an Origin that is not on the allowlist, even when it matches Host', () => {
    expect(decide({ cookie: 'ifc_rt=secret', origin: 'https://evil.example', host: 'evil.example' })).toEqual({
      code: 'edge.origin_not_allowed',
    });
    expect(decide({ cookie: 'ifc_rt=secret', 'x-session-request': '0' })).toEqual({ code: 'auth.csrf_origin_required' });
  });
});
