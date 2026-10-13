import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import nextConfig from '../next.config.mjs';
import { middleware } from './middleware';
import { STATIC_SECURITY_HEADERS, contentSecurityPolicy, createNonce } from './lib/security-headers.mjs';

const original = process.env.ADMIN_MODULES;
afterEach(() => {
  if (original === undefined) delete process.env.ADMIN_MODULES;
  else process.env.ADMIN_MODULES = original;
});

const run = (path: string) => middleware(new NextRequest(`https://admin.example${path}`));
const directives = (policy: string) =>
  new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .map(([name, ...sources]) => [name, sources]),
  );

describe('static security headers (next.config headers())', () => {
  it('are configured for every path, including /api and static files', async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.source).toBe('/:path*');
    expect(rules[0]!.headers).toEqual(STATIC_SECURITY_HEADERS);
  });

  it('carry the required values and none is empty', () => {
    const headers = new Map(STATIC_SECURITY_HEADERS.map((h) => [h.key, h.value]));
    expect(headers.get('Strict-Transport-Security')).toBe('max-age=86400');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    for (const { key, value } of STATIC_SECURITY_HEADERS) expect(value.trim(), key).not.toBe('');
    expect(headers.get('Strict-Transport-Security')).not.toMatch(/preload|includeSubDomains/);
    expect(new Set(STATIC_SECURITY_HEADERS.map((h) => h.key)).size).toBe(STATIC_SECURITY_HEADERS.length);
  });

  it('denies camera, microphone, geolocation and payment but leaves passkeys alone', () => {
    const policy = STATIC_SECURITY_HEADERS.find((h) => h.key === 'Permissions-Policy')!.value;
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) expect(policy).toContain(`${feature}=()`);
    expect(policy).not.toMatch(/publickey-credentials/);
  });
});

describe('Content-Security-Policy', () => {
  it('uses the nonce with strict-dynamic and never allows inline or eval scripts in production', () => {
    const policy = directives(contentSecurityPolicy('abc123', { development: false }));
    expect(policy.get('script-src')).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(policy.get('default-src')).toEqual(["'self'"]);
    expect(policy.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy.get('connect-src')).toEqual(["'self'"]);
    expect(policy.get('font-src')).toEqual(["'self'"]);
    for (const name of ['frame-ancestors', 'object-src']) expect(policy.get(name)).toEqual(["'none'"]);
    for (const name of ['base-uri', 'form-action']) expect(policy.get(name)).toEqual(["'self'"]);
  });

  it('allows eval only for `next dev`', () => {
    expect(contentSecurityPolicy('n', { development: true })).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy('n', { development: false })).not.toContain('unsafe-eval');
  });

  it('nonces are unique, unpredictable and CSP-safe', () => {
    const nonces = new Set(Array.from({ length: 50 }, createNonce));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
  });
});

describe('middleware applies the CSP and forwards the nonce', () => {
  it('pages and API routes get a policy whose nonce is the one forwarded to Next', () => {
    for (const path of ['/', '/crm', '/login', '/api/kill-switch', '/api/session']) {
      const res = run(path);
      const policy = res.headers.get('content-security-policy');
      expect(policy, path).toBeTruthy();
      const nonce = /'nonce-([^']+)'/.exec(policy!)![1]!;
      // NextResponse.next({ request: { headers } }) publishes the forwarded request headers like this.
      expect(res.headers.get('x-middleware-override-headers'), path).toContain('x-nonce');
      expect(res.headers.get('x-middleware-request-x-nonce'), path).toBe(nonce);
      expect(res.headers.get('x-middleware-request-content-security-policy'), path).toBe(policy);
    }
  });

  it('each request gets a fresh nonce', () => {
    expect(run('/').headers.get('content-security-policy')).not.toBe(run('/').headers.get('content-security-policy'));
  });

  it('gate redirects and 404s carry the policy too', () => {
    process.env.ADMIN_MODULES = 'crm';
    expect(run('/tools').status).toBe(307);
    expect(run('/tools').headers.get('content-security-policy')).toContain('frame-ancestors');
    expect(run('/api/accounts').status).toBe(404);
    expect(run('/api/accounts').headers.get('content-security-policy')).toContain("script-src 'self' 'nonce-");
  });

  it('a client cannot choose the nonce by sending its own x-nonce or policy', () => {
    const res = middleware(
      new NextRequest('https://admin.example/', {
        headers: { 'x-nonce': 'attacker', 'content-security-policy': "script-src 'unsafe-inline'" },
      }),
    );
    expect(res.headers.get('x-middleware-request-x-nonce')).not.toBe('attacker');
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(res.headers.get('content-security-policy'));
    expect(res.headers.get('x-middleware-request-content-security-policy')).not.toContain("script-src 'unsafe-inline'");
  });
});
