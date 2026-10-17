import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    expect(sameHost).toBeNull();

    const noCookie = refuseCookieCsrf({
      method: 'POST',
      pathname: '/api/identity/trpc/auth.refresh',
      headers: { origin: 'https://evil.example', host: 'app.example.com' },
      allowedOrigins: [],
    });
    expect(noCookie).toBeNull();
  });

  it('index.ts uses the cookie proxy on the way in and the way out', () => {
    const src = readFileSync(join(here, 'index.ts'), 'utf8');
    expect(src).toContain('refuseCookieCsrf(');
    expect(src).toContain('prepareUpstreamRequestHeaders(');
    expect(src).toContain('forwardUpstreamResponseHeaders(');
  });
});
