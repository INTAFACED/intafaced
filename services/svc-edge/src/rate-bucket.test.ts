import { describe, expect, it } from 'vitest';
import { KeyBuckets, parseRouteCosts, routeCost } from './rate-bucket.js';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const KID = '22222222-2222-4222-8222-222222222222';
// TEST values: burst 5, refill 60 a minute (one token a second).
const LIMIT = { tier: 'base', burst: 5, refillPerMinute: 60 } as const;

describe('the key token bucket (ENGINE RL-1 to RL-4, T-20)', () => {
  it('allows calls until the burst is spent, then refuses with retry-after = missing tokens over the rate, rounded up', () => {
    const buckets = new KeyBuckets();
    const takes = Array.from({ length: 6 }, () => buckets.take(KID, USER, LIMIT, 1, 0));
    expect(takes.slice(0, 5).every((t) => t.ok)).toBe(true);
    expect(takes.slice(0, 5).map((t) => (t.ok ? t.remaining : -1))).toEqual([4, 3, 2, 1, 0]);
    expect(takes[5]).toEqual({ ok: false, reason: 'global', retryAfterSeconds: 1, cost: 1, burst: 5 });
    // A cost of 3 with 0.5 tokens back needs 2.5 more: three seconds at one a second.
    expect(buckets.take(KID, USER, LIMIT, 3, 500)).toMatchObject({ ok: false, retryAfterSeconds: 3 });
    // A second later one token is back.
    expect(buckets.take(KID, USER, LIMIT, 1, 1000)).toMatchObject({ ok: true, remaining: 0 });
  });

  it('never allows a cost above the burst, and says the route is the reason', () => {
    const buckets = new KeyBuckets();
    expect(buckets.take(KID, USER, LIMIT, 6, 0)).toMatchObject({ ok: false, reason: 'endpoint' });
    expect(buckets.take(KID, USER, LIMIT, 6, 3_600_000)).toMatchObject({ ok: false, reason: 'endpoint' });
  });

  it('a clock that moves backwards adds nothing', () => {
    const buckets = new KeyBuckets();
    for (let i = 0; i < 5; i += 1) buckets.take(KID, USER, LIMIT, 1, 10_000);
    expect(buckets.take(KID, USER, LIMIT, 1, 0).ok).toBe(false);
    expect(buckets.take(KID, USER, LIMIT, 1, 5_000).ok).toBe(false);
    expect(buckets.take(KID, USER, LIMIT, 1, 11_000).ok).toBe(true);
  });

  it('a granted refill applies from the next call and never fills the bucket above its burst', () => {
    const buckets = new KeyBuckets();
    for (let i = 0; i < 5; i += 1) buckets.take(KID, USER, LIMIT, 1, 0);
    const granted = { tier: 'granted', burst: 5, refillPerMinute: 600 } as const;
    // Ten tokens a second: after 300 ms three are back, where the tier would have given none.
    expect(buckets.take(KID, USER, granted, 3, 300)).toMatchObject({ ok: true, remaining: 0 });
    expect(buckets.usage(KID, USER, 60_000)).toMatchObject({ remaining: 5, burst: 5, refillPerMinute: 600 });
  });

  it('usage counts the tokens spent and the calls refused, for the owner only; anyone else reads nothing', () => {
    const buckets = new KeyBuckets();
    expect(buckets.usage(KID, USER, 0)).toEqual({ state: 'none', asOf: new Date(0).toISOString(), keyId: KID });
    for (let i = 0; i < 7; i += 1) buckets.take(KID, USER, LIMIT, 1, 1_000);
    const mine = buckets.usage(KID, USER, 1_500);
    expect(mine).toEqual({
      state: 'counted',
      asOf: new Date(1_500).toISOString(),
      keyId: KID,
      since: new Date(1_000).toISOString(),
      used: 5,
      refused: 2,
      remaining: 0,
      burst: 5,
      refillPerMinute: 60,
    });
    // Reading is not a call: the numbers do not move by reading.
    expect(buckets.usage(KID, USER, 1_500)).toEqual(mine);
    expect(buckets.usage(KID, OTHER, 1_500)).toEqual({ state: 'none', asOf: new Date(1_500).toISOString(), keyId: KID });
  });

  it('drops a key that has been quiet for an hour', () => {
    const buckets = new KeyBuckets();
    buckets.take(KID, USER, LIMIT, 1, 0);
    buckets.prune(3_600_001);
    expect(buckets.usage(KID, USER, 3_600_001).state).toBe('none');
  });
});

describe('the route cost table (T-19)', () => {
  const costs = parseRouteCosts(
    JSON.stringify([
      { route: 'GET /api/v1/account/balance', cost: 2 },
      { route: 'POST /api/v1/orders', cost: 3 },
      { route: 'GET /api/v1/*/history', cost: 5 },
      { route: '* /api/v1/**', cost: 1 },
    ]),
  );

  it('first match wins, with * for one segment and ** for the rest', () => {
    expect(routeCost(costs, 'GET', '/api/v1/account/balance')).toBe(2);
    expect(routeCost(costs, 'get', '/api/v1/account/balance')).toBe(2);
    expect(routeCost(costs, 'POST', '/api/v1/orders')).toBe(3);
    expect(routeCost(costs, 'GET', '/api/v1/orders/history')).toBe(5);
    expect(routeCost(costs, 'GET', '/api/v1/orders/a/history')).toBe(1);
    expect(routeCost(costs, 'DELETE', '/api/v1/orders/abc')).toBe(1);
    expect(routeCost(costs, 'GET', '/api/v1')).toBe(1);
  });

  it('a call no row names has no cost, so the gateway refuses it', () => {
    expect(routeCost(costs, 'GET', '/api/pay/v1/payments')).toBeNull();
    expect(routeCost([], 'GET', '/api/v1/account/balance')).toBeNull();
  });

  it('blank is none set; a malformed, zero or negative cost stops the service', () => {
    expect(parseRouteCosts(undefined)).toEqual([]);
    expect(parseRouteCosts('  ')).toEqual([]);
    for (const bad of ['[]', 'nope', '[{"route":"GET /a","cost":0}]', '[{"route":"GET /a","cost":-1}]', '[{"route":"/a","cost":1}]']) {
      expect(() => parseRouteCosts(bad)).toThrow(/EDGE_RATE_ROUTE_COSTS/);
    }
  });
});
