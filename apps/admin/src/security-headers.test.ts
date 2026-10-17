import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    for (const { key, value } of STATIC_SECURITY_HEADERS) expect(value.trim(), key).not.toBe('');
    // HSTS is per deployment, so it is set by the middleware from the runtime env; baked into `headers()` it would be fixed per image.
    expect(headers.has('Strict-Transport-Security')).toBe(false);
    expect(new Set(STATIC_SECURITY_HEADERS.map((h) => h.key)).size).toBe(STATIC_SECURITY_HEADERS.length);
  });

  it('denies camera, microphone, geolocation and payment but leaves passkeys alone', () => {
    const policy = STATIC_SECURITY_HEADERS.find((h) => h.key === 'Permissions-Policy')!.value;
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) expect(policy).toContain(`${feature}=()`);
    expect(policy).not.toMatch(/publickey-credentials/);
  });
});

describe('Strict-Transport-Security (middleware, runtime env)', () => {
  const KEYS = ['HSTS_MAX_AGE_SECONDS', 'HSTS_INCLUDE_SUBDOMAINS'] as const;
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  const sts = (path = '/') => run(path).headers.get('strict-transport-security');

  it("sends today's gentle value when nothing is configured, on pages, API routes, redirects and 404s", () => {
    for (const key of KEYS) delete process.env[key];
    for (const path of ['/', '/crm', '/api/kill-switch']) expect(sts(path), path).toBe('max-age=86400');
    process.env.ADMIN_MODULES = 'crm';
    expect(run('/tools').status).toBe(307);
    expect(sts('/tools')).toBe('max-age=86400');
    expect(run('/api/accounts').status).toBe(404);
    expect(sts('/api/accounts')).toBe('max-age=86400');
  });

  it('follows the environment at call time, with no rebuild in between', () => {
    process.env.HSTS_MAX_AGE_SECONDS = '604800';
    process.env.HSTS_INCLUDE_SUBDOMAINS = 'true';
    expect(sts()).toBe('max-age=604800; includeSubDomains');
    process.env.HSTS_MAX_AGE_SECONDS = '2592000';
    process.env.HSTS_INCLUDE_SUBDOMAINS = 'false';
    expect(sts()).toBe('max-age=2592000');
    process.env.HSTS_MAX_AGE_SECONDS = '0';
    expect(sts()).toBe('max-age=0');
  });

  it('never throws on a bad value (boot refuses it; the request path falls back to the default) and never says preload', () => {
    for (const bad of ['-1', '1e9', '63072001', '86400; preload', 'yes', ' 86400', '08', '1.5', 'NaN']) {
      process.env.HSTS_MAX_AGE_SECONDS = bad;
      process.env.HSTS_INCLUDE_SUBDOMAINS = 'preload';
      expect(sts(), bad).toBe('max-age=86400');
    }
  });

  it('does not depend on the build: no HSTS in next.config headers(), no NEXT_PUBLIC_ or `env` inlining of the knobs', async () => {
    const rules = await nextConfig.headers!();
    for (const rule of rules) {
      for (const header of rule.headers) expect(header.key.toLowerCase()).not.toBe('strict-transport-security');
    }
    expect((nextConfig as { env?: Record<string, string> }).env ?? {}).not.toHaveProperty('HSTS_MAX_AGE_SECONDS');
    expect((nextConfig as { env?: Record<string, string> }).env ?? {}).not.toHaveProperty('HSTS_INCLUDE_SUBDOMAINS');
    const sources = ['./middleware.ts', './lib/security-headers.mjs', './instrumentation.ts'].map((file) =>
      readFileSync(resolve(import.meta.dirname, file), 'utf8'),
    );
    for (const source of sources) expect(source).not.toMatch(/NEXT_PUBLIC_HSTS/);
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
