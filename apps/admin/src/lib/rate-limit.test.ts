import { describe, expect, it } from 'vitest';
import { clientKey, createRateLimiter, limitedResponse } from './rate-limit';

const request = (headers: Record<string, string> = {}) => new Request('https://admin.example.test/api/reset', { method: 'POST', headers });

describe('rate limiter', () => {
  it('allows the limit, refuses the next, and forgives after the window', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });
    expect([1, 2, 3, 4].map(() => limiter.hit('a', 0))).toEqual([true, true, true, false]);
    expect(limiter.hit('b', 0)).toBe(true);
    expect(limiter.retryAfter('a', 400)).toBe(1);
    expect(limiter.hit('a', 1001)).toBe(true);
  });

  it('refuses new clients instead of growing without bound', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000_000 });
    for (let i = 0; i < 10_000; i += 1) limiter.hit(`k${i}`, 0);
    expect(limiter.hit('one-more', 1)).toBe(false);
    expect(limiter.hit('k5', 2)).toBe(false);
    expect(limiter.hit('one-more', 2_000_000)).toBe(true);
  });
});

describe('client key', () => {
  it('is one shared bucket unless ADMIN_TRUST_PROXY is 1', () => {
    expect(clientKey(request({ 'x-forwarded-for': '203.0.113.9' }), {})).toBe('shared');
    expect(clientKey(request({ 'x-forwarded-for': '203.0.113.9' }), { ADMIN_TRUST_PROXY: 'true' })).toBe('shared');
  });

  it('uses only the first x-forwarded-for entry when the proxy is trusted, and only if it looks like an address', () => {
    const env = { ADMIN_TRUST_PROXY: '1' };
    expect(clientKey(request({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), env)).toBe('203.0.113.9');
    expect(clientKey(request({ 'x-forwarded-for': '2001:DB8::1' }), env)).toBe('2001:db8::1');
    expect(clientKey(request({ 'x-forwarded-for': '<script>' }), env)).toBe('shared');
    expect(clientKey(request(), env)).toBe('shared');
  });

  it('answers 429 admin.rate_limited with a Retry-After', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limitedResponse(limiter, request())).toBeNull();
    const refused = limitedResponse(limiter, request())!;
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ code: 'admin.rate_limited' });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(refused.headers.get('cache-control')).toBe('no-store');
  });
});
