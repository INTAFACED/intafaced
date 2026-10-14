import { describe, expect, it } from 'vitest';
import { clientKey, createRateLimiter, limitedResponse } from './rate-limit';

const request = (headers: Record<string, string> = {}) => new Request('https://admin.example.test/api/reset', { method: 'POST', headers });
const TRUSTED = { ADMIN_TRUST_PROXY: '1' };

describe('rate limiter', () => {
  it('allows the limit, refuses the next, and forgives after the window', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });
    expect([1, 2, 3, 4].map(() => limiter.hit('a', 0))).toEqual([true, true, true, false]);
    expect(limiter.hit('b', 0)).toBe(true);
    expect(limiter.retryAfter('a', 400)).toBe(1);
    expect(limiter.hit('a', 1001)).toBe(true);
  });

  it('keeps a flood from one client flat in time and memory', () => {
    const limiter = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });
    const started = performance.now();
    for (let i = 0; i < 100_000; i += 1) limiter.hit('flood', 1_000 + i);
    // Generous: the old list-per-client version took minutes for this; the bound only has to catch that, not time a busy Mac.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(limiter.size()).toBe(1);
    expect(limiter.hit('flood', 2_000)).toBe(false);
  });

  it('drops the oldest client when full, so a newcomer is never refused', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000_000, maxKeys: 100 });
    for (let i = 0; i < 100; i += 1) limiter.hit(`k${i}`, 0);
    expect(limiter.hit('founder', 1)).toBe(true);
    expect(limiter.size()).toBe(91); // the oldest tenth went in one pass
    expect(limiter.hit('k0', 2)).toBe(true); // the oldest tenth was forgotten
    expect(limiter.hit('k50', 2)).toBe(false); // the rest are still counted
    expect(limiter.size()).toBeLessThanOrEqual(100);
  });

  it('keeps the table bounded under a flood of new clients, and never refuses one', () => {
    const limiter = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });
    let refused = 0;
    for (let i = 0; i < 80_000; i += 1) if (!limiter.hit(`c${i}`, 1_000)) refused += 1;
    expect(refused).toBe(0);
    expect(limiter.size()).toBeLessThanOrEqual(10_000);
  });
});

describe('client key', () => {
  it('does not limit unless ADMIN_TRUST_PROXY is exactly 1', () => {
    expect(clientKey(request({ 'x-forwarded-for': '203.0.113.9' }), {})).toBeNull();
    expect(clientKey(request({ 'x-forwarded-for': '203.0.113.9' }), { ADMIN_TRUST_PROXY: 'true' })).toBeNull();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    for (let i = 0; i < 5; i += 1) expect(limitedResponse(limiter, request(), {})).toBeNull();
  });

  it('uses only the first x-forwarded-for entry when the proxy is trusted, and only if it is an address', () => {
    expect(clientKey(request({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }), TRUSTED)).toBe('203.0.113.9');
    expect(clientKey(request({ 'x-forwarded-for': '<script>' }), TRUSTED)).toBeNull();
    expect(clientKey(request({ 'x-forwarded-for': '999' }), TRUSTED)).toBeNull();
    expect(clientKey(request(), TRUSTED)).toBeNull();
  });

  it('keys IPv6 clients by their /64', () => {
    const key = (xff: string) => clientKey(request({ 'x-forwarded-for': xff }), TRUSTED);
    expect(key('2001:DB8:1:2::1')).toBe('v6:2001:db8:1:2');
    expect(key('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('v6:2001:db8:1:2');
    expect(key('2001:db8::1')).toBe('v6:2001:db8:0:0');
    expect(key('2001:0db8:0001:0002::9')).toBe('v6:2001:db8:1:2');
    expect(key('::1')).toBe('v6:0:0:0:0');
    expect(key('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(key('fe80::1%en0')).toBe('v6:fe80:0:0:0');
  });

  it('answers 429 admin.rate_limited with a Retry-After', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const from = () => request({ 'x-forwarded-for': '203.0.113.9' });
    expect(limitedResponse(limiter, from(), TRUSTED)).toBeNull();
    const refused = limitedResponse(limiter, from(), TRUSTED)!;
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ code: 'admin.rate_limited' });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(refused.headers.get('cache-control')).toBe('no-store');
  });
});
