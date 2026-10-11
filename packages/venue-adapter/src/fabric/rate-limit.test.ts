import { describe, expect, it } from 'vitest';
import { RateLimitGovernor, RateLimitRegistry, type RateLimitPolicy } from './rate-limit.js';

const T0 = 1_000_000;

/** 1000 weight/minute, no headroom — makes the arithmetic in these tests readable. */
const policy = (overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy => ({
  venueId: 'binance-spot',
  capacity: 1_000,
  windowMs: 60_000,
  reservedHeadroomBps: 0,
  ...overrides,
});

describe('RateLimitGovernor — a refusal, never a silent wait', () => {
  it('admits inside the bucket and reports what is left', () => {
    const governor = new RateLimitGovernor(policy(), T0);
    const decision = governor.tryAcquire(50, T0);
    expect(decision.admitted).toBe(true);
    expect(decision.admitted && decision.remaining).toBe(950);
  });

  it('counts WEIGHT, not requests — a depth read is fifty tickers', () => {
    const governor = new RateLimitGovernor(policy({ capacity: 100 }), T0);
    expect(governor.tryAcquire(50, T0).admitted).toBe(true);
    expect(governor.tryAcquire(50, T0).admitted).toBe(true);
    // Two requests, and the bucket is empty. A request counter would have
    // sailed through ninety-eight more.
    expect(governor.tryAcquire(1, T0).admitted).toBe(false);
  });

  it('REFUSES rather than queueing, and says exactly when to come back', () => {
    const governor = new RateLimitGovernor(policy({ capacity: 60, windowMs: 60_000 }), T0);
    governor.tryAcquire(60, T0);

    const decision = governor.tryAcquire(10, T0);
    expect(decision.admitted).toBe(false);
    expect(decision.admitted === false && decision.reason).toBe('rate_limited');
    // 60 weight per 60s = 1/ms... no: 60/60_000 = 0.001/ms, so 10 weight is 10_000ms.
    expect(decision.admitted === false && decision.retryAfterMs).toBe(10_000);
  });

  it('refills continuously, not in window steps', () => {
    const governor = new RateLimitGovernor(policy({ capacity: 60_000, windowMs: 60_000 }), T0);
    governor.tryAcquire(60_000, T0);
    expect(governor.tryAcquire(1, T0).admitted).toBe(false);
    // 1 weight per ms.
    expect(governor.tryAcquire(500, T0 + 500).admitted).toBe(true);
  });

  it('never refills past the burst ceiling — idle time does not bank a flood', () => {
    const governor = new RateLimitGovernor(policy({ capacity: 100, windowMs: 1_000 }), T0);
    // An hour idle.
    expect(governor.tryAcquire(100, T0 + 3_600_000).admitted).toBe(true);
    expect(governor.tryAcquire(1, T0 + 3_600_000).admitted).toBe(false);
  });

  it('says so plainly when a request can NEVER be admitted', () => {
    const governor = new RateLimitGovernor(policy({ capacity: 100 }), T0);
    const decision = governor.tryAcquire(500, T0);
    expect(decision.admitted).toBe(false);
    expect(decision.admitted === false && decision.retryAfterMs).toBe(Number.POSITIVE_INFINITY);
    expect(decision.admitted === false && decision.detail).toContain('never be admitted');
  });

  describe('headroom — we are not the only client on this limit', () => {
    it('spends only what headroom leaves', () => {
      // 20% of 1000 reserved => 800 usable.
      const governor = new RateLimitGovernor(policy({ reservedHeadroomBps: 2_000 }), T0);
      expect(governor.usableCapacity).toBe(800);
      expect(governor.tryAcquire(800, T0).admitted).toBe(true);
      expect(governor.tryAcquire(1, T0).admitted).toBe(false);
    });

    it('defaults to 20% rather than to the published limit', () => {
      const governor = new RateLimitGovernor({ venueId: 'v', capacity: 6_000, windowMs: 60_000 }, T0);
      expect(governor.usableCapacity).toBe(4_800);
    });

    it('rounds usable capacity DOWN — rounding up spends the margin it exists to protect', () => {
      const governor = new RateLimitGovernor(policy({ capacity: 101, reservedHeadroomBps: 5_000 }), T0);
      expect(governor.usableCapacity).toBe(50);
    });

    it('keeps a positive floor — capacity 2 with the default headroom is 1', () => {
      const governor = new RateLimitGovernor({ venueId: 'v', capacity: 2, windowMs: 60_000 }, T0);
      expect(governor.usableCapacity).toBe(1);
      expect(governor.tryAcquire(1, T0).admitted).toBe(true);
    });

    it('refuses capacity 1 with the default headroom — a zero floor is not invented as 1', () => {
      // floor(1 * 8000 / 10000) = 0. The old clamp admitted a full window.
      expect(
        () => new RateLimitGovernor({ venueId: 'binance-spot', capacity: 1, windowMs: 60_000 }, T0),
      ).toThrow(/binance-spot: usable weight is zero and is not invented/);
    });

    it('refuses a burst that floors to 0 while usable capacity stays positive', () => {
      // Headroom 0 leaves usable capacity 1000. floor(1000 * 9 / 10000) = 0.
      expect(
        () => new RateLimitGovernor(policy({ venueId: 'okx-spot', capacity: 1_000, burstBps: 9 }), T0),
      ).toThrow(/okx-spot: burst usable weight is zero and is not invented/);
    });
  });

  describe("the venue's own verdict outranks our arithmetic", () => {
    it('hard-blocks on an observed 429 even with tokens in hand', () => {
      const governor = new RateLimitGovernor(policy(), T0);
      expect(governor.tryAcquire(1, T0).admitted).toBe(true);

      governor.observeVenueBackoff(30_000, 'HTTP 429', T0);

      const decision = governor.tryAcquire(1, T0 + 1);
      expect(decision.admitted).toBe(false);
      expect(decision.admitted === false && decision.reason).toBe('venue_backoff');
      expect(decision.admitted === false && decision.retryAfterMs).toBe(29_999);
      expect(decision.admitted === false && decision.detail).toContain('HTTP 429');
    });

    it('does not come back with a full bucket when the block lifts', () => {
      const governor = new RateLimitGovernor(policy({ capacity: 60_000, windowMs: 60_000 }), T0);
      governor.observeVenueBackoff(10_000, 'HTTP 418', T0);
      expect(governor.tryAcquire(1, T0 + 5_000).admitted).toBe(false);

      // Block lifted; refill starts from empty at the moment it lifted, so only
      // 1ms of tokens exists. A burst here is straight back into the ban.
      expect(governor.tryAcquire(60_000, T0 + 10_001).admitted).toBe(false);
      expect(governor.tryAcquire(1, T0 + 10_001).admitted).toBe(true);
    });

    it('extends an existing block rather than shortening it', () => {
      const governor = new RateLimitGovernor(policy(), T0);
      governor.observeVenueBackoff(60_000, 'HTTP 418', T0);
      governor.observeVenueBackoff(1_000, 'HTTP 429', T0);
      expect(governor.backoffUntil(T0)).toBe(T0 + 60_000);
    });

    it('lifts the block on its own once the time passes', () => {
      const governor = new RateLimitGovernor(policy(), T0);
      governor.observeVenueBackoff(5_000, 'HTTP 429', T0);
      expect(governor.backoffUntil(T0 + 4_999)).not.toBeNull();
      expect(governor.backoffUntil(T0 + 5_001)).toBeNull();
    });
  });

  it('counts admissions and refusals, so a health endpoint has something true to show', () => {
    const governor = new RateLimitGovernor(policy({ capacity: 10 }), T0);
    governor.tryAcquire(10, T0);
    governor.tryAcquire(1, T0);
    governor.tryAcquire(1, T0);
    expect(governor.admittedCount).toBe(1);
    expect(governor.refusalCount).toBe(2);
  });

  it('refuses a nonsensical policy at construction rather than at 3am', () => {
    expect(() => new RateLimitGovernor(policy({ capacity: 0 }))).toThrow(/positive capacity/);
    expect(() => new RateLimitGovernor(policy({ windowMs: 0 }))).toThrow(/positive capacity/);
    expect(() => new RateLimitGovernor(policy({ reservedHeadroomBps: 10_000 }))).toThrow(/reservedHeadroomBps/);
  });
});

describe('RateLimitRegistry — one bucket per venue', () => {
  it('keeps venues independent, so a busy one cannot throttle a healthy one', () => {
    const registry = new RateLimitRegistry();
    registry.register(policy({ venueId: 'a', capacity: 10 }), T0);
    registry.register(policy({ venueId: 'b', capacity: 10 }), T0);

    registry.requireGovernor('a').tryAcquire(10, T0);
    expect(registry.requireGovernor('a').tryAcquire(1, T0).admitted).toBe(false);
    expect(registry.requireGovernor('b').tryAcquire(1, T0).admitted).toBe(true);
  });

  it('treats a missing registration as the configuration bug it is', () => {
    const registry = new RateLimitRegistry();
    expect(registry.get('nope')).toBeNull();
    // Not a permissive default: an ungoverned venue is the one that bans us.
    expect(() => registry.requireGovernor('nope')).toThrow(/no rate-limit policy registered/);
  });
});
