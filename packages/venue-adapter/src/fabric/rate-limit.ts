/**
 * THE PER-VENUE RATE-LIMIT GOVERNOR — §27's "rate-limit governor per venue".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SAFETY DEVICE AND NOT AN OPTIMISATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Getting banned by a venue mid-execution is an outage you caused yourself, and
 * it is the worst-timed outage available: rate limits bite hardest in a fast
 * market, which is exactly when there are open orders that need cancelling and
 * a position that needs hedging. A venue that has IP-banned us for ten minutes
 * looks, from inside the process, identical to a venue that has gone down —
 * except we did it, and we did it while holding risk.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GOVERNOR NEVER SLEEPS ON THE CALLER'S BEHALF
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `tryAcquire` returns a DECISION. It does not await, it does not queue, and it
 * does not hold a promise open until a token frees up.
 *
 * A governor that silently waits converts a rate limit into latency, and latency
 * with no upper bound is worse than a refusal: the caller believes it is
 * executing, the market moves, and the order finally goes out against a price
 * that no longer exists. A refusal is honest — the venue is `rate_limited`,
 * which §27 requires be EXCLUDED AND REPORTED, and the router routes around it
 * with the reason attached.
 *
 * A caller that genuinely can wait (a background market refresh) reads
 * `retryAfterMs` and schedules. A caller that cannot (an execution path) treats
 * the refusal as the exclusion it is.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HEADROOM, BECAUSE WE ARE NOT THE ONLY CLIENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Venue limits are per IP or per key, and neither is per process. Another pod,
 * a backfill job, or a user's own bot on the same key all spend from the same
 * bucket. A governor tuned to exactly the published limit is a governor that
 * bans us the first time anything else is running.
 *
 * `reservedHeadroomBps` is the fraction we refuse to spend. It defaults to
 * 20% and is not optional, because the failure it prevents is invisible in
 * testing — you only find out in production, with everything else running.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE VENUE'S OWN VERDICT OUTRANKS OUR ARITHMETIC
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * When a venue answers 429 or 418, our model of its limit has already been
 * proven wrong. `observeVenueBackoff` drains the bucket and hard-blocks until
 * the venue says otherwise. Continuing to spend tokens we believe we have,
 * against a venue that has just told us to stop, is how a soft limit becomes a
 * ban.
 */

export interface RateLimitPolicy {
  readonly venueId: string;
  /** Weight units the venue permits per window. From the venue's published limit. */
  readonly capacity: number;
  readonly windowMs: number;
  /**
   * Fraction of `capacity` we refuse to spend, in basis points. Default 2000
   * (20%). See the header — this is not tuning, it is the margin that keeps us
   * out of a ban when something else shares the limit.
   */
  readonly reservedHeadroomBps?: number;
  /**
   * Burst allowance as a fraction of usable capacity, in bps of 1x.
   *
   * `10_000` (the default) means the bucket holds one full window's worth and
   * no more. Raising it lets a burst through at the cost of a longer recovery;
   * it does not raise the sustained rate, which is set by refill alone.
   */
  readonly burstBps?: number;
}

export type AcquireDecision =
  | { readonly admitted: true; readonly venueId: string; readonly remaining: number }
  | {
      readonly admitted: false;
      readonly venueId: string;
      /** `rate_limited` in §27's exclusion vocabulary. Report it; do not retry blindly. */
      readonly reason: 'rate_limited' | 'venue_backoff';
      /** Earliest moment the same request could succeed. Never a guess — computed from the bucket. */
      readonly retryAfterMs: number;
      readonly detail: string;
    };

const DEFAULT_HEADROOM_BPS = 2_000;
const DEFAULT_BURST_BPS = 10_000;

export class RateLimitGovernor {
  readonly venueId: string;
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #burstCapacity: number;

  #tokens: number;
  #lastRefillAt: number;
  #backoffUntil: number | null = null;
  #backoffReason = '';
  #refusals = 0;
  #admitted = 0;

  constructor(policy: RateLimitPolicy, now: number = Date.now()) {
    if (policy.capacity <= 0 || policy.windowMs <= 0) {
      throw new Error(`${policy.venueId}: rate-limit policy needs a positive capacity and window`);
    }
    this.venueId = policy.venueId;

    const headroomBps = policy.reservedHeadroomBps ?? DEFAULT_HEADROOM_BPS;
    if (headroomBps < 0 || headroomBps >= 10_000) {
      throw new Error(`${policy.venueId}: reservedHeadroomBps must be in [0, 10000)`);
    }
    // Usable sustained rate after headroom. Floor, never round up: rounding up
    // spends the headroom this governor exists to protect. A floor of 0 is a
    // refusal — substituting 1 would invent a weight that headroom withheld.
    const usable = Math.floor((policy.capacity * (10_000 - headroomBps)) / 10_000);
    if (usable === 0) {
      throw new Error(`${policy.venueId}: usable weight is zero and is not invented`);
    }
    this.#capacity = usable;
    this.#refillPerMs = this.#capacity / policy.windowMs;
    const burst = Math.floor((this.#capacity * (policy.burstBps ?? DEFAULT_BURST_BPS)) / 10_000);
    if (burst === 0) {
      throw new Error(`${policy.venueId}: burst usable weight is zero and is not invented`);
    }
    this.#burstCapacity = burst;
    this.#tokens = this.#burstCapacity;
    this.#lastRefillAt = now;
  }

  /** Usable weight per window after headroom — what the governor will actually spend. */
  get usableCapacity(): number {
    return this.#capacity;
  }

  get refusalCount(): number {
    return this.#refusals;
  }

  get admittedCount(): number {
    return this.#admitted;
  }

  /** Non-null while the venue itself has told us to stop. */
  backoffUntil(now: number = Date.now()): number | null {
    return this.#backoffUntil !== null && this.#backoffUntil > now ? this.#backoffUntil : null;
  }

  /**
   * Spend `weight` if it is there, or refuse and say when to come back.
   *
   * Weight, not "one request": venues price a 5000-level depth snapshot at fifty
   * times a ticker read, and a governor that counted requests would sail through
   * its limit on the calls that cost the most.
   */
  tryAcquire(weight = 1, now: number = Date.now()): AcquireDecision {
    if (weight <= 0) throw new Error(`${this.venueId}: request weight must be positive`);

    const bannedUntil = this.backoffUntil(now);
    if (bannedUntil !== null) {
      this.#refusals += 1;
      return {
        admitted: false,
        venueId: this.venueId,
        reason: 'venue_backoff',
        retryAfterMs: bannedUntil - now,
        detail: `${this.venueId} told us to back off (${this.#backoffReason}); holding until it lifts`,
      };
    }

    this.#refill(now);

    if (weight > this.#burstCapacity) {
      // A request heavier than the whole bucket can never be admitted. Saying so
      // is better than refusing it forever with a retry hint that will not help.
      this.#refusals += 1;
      return {
        admitted: false,
        venueId: this.venueId,
        reason: 'rate_limited',
        retryAfterMs: Number.POSITIVE_INFINITY,
        detail:
          `weight ${weight} exceeds ${this.venueId}'s usable burst capacity of ${this.#burstCapacity} — ` +
          'this request can never be admitted under the current policy',
      };
    }

    if (this.#tokens >= weight) {
      this.#tokens -= weight;
      this.#admitted += 1;
      return { admitted: true, venueId: this.venueId, remaining: Math.floor(this.#tokens) };
    }

    this.#refusals += 1;
    const shortfall = weight - this.#tokens;
    return {
      admitted: false,
      venueId: this.venueId,
      reason: 'rate_limited',
      // Computed, not guessed: exactly how long until the shortfall refills.
      retryAfterMs: Math.ceil(shortfall / this.#refillPerMs),
      detail: `${this.venueId} governor holding back — ${this.#tokens.toFixed(1)}/${weight} weight available`,
    };
  }

  /**
   * The venue said stop. Believe it over our arithmetic.
   *
   * Drains the bucket as well as setting the block: when the block lifts, the
   * first thing we do must not be a burst, or we are straight back into the
   * limit that produced the 429.
   */
  observeVenueBackoff(retryAfterMs: number, reason: string, now: number = Date.now()): void {
    const until = now + Math.max(0, retryAfterMs);
    this.#backoffUntil = Math.max(this.#backoffUntil ?? 0, until);
    this.#backoffReason = reason;
    this.#tokens = 0;
    this.#lastRefillAt = this.#backoffUntil;
  }

  #refill(now: number): void {
    if (now <= this.#lastRefillAt) return;
    this.#tokens = Math.min(this.#burstCapacity, this.#tokens + (now - this.#lastRefillAt) * this.#refillPerMs);
    this.#lastRefillAt = now;
  }
}

/**
 * One governor per venue, created on demand.
 *
 * A registry rather than a global because limits are per venue and sharing one
 * bucket across venues would throttle a healthy venue because a different one is
 * busy — a self-inflicted outage with no upside at all.
 */
export class RateLimitRegistry {
  readonly #governors = new Map<string, RateLimitGovernor>();

  register(policy: RateLimitPolicy, now: number = Date.now()): RateLimitGovernor {
    const governor = new RateLimitGovernor(policy, now);
    this.#governors.set(policy.venueId, governor);
    return governor;
  }

  /**
   * The governor for a venue, or `null`.
   *
   * `null` rather than a permissive default. An ungoverned venue is the one that
   * bans us, and a lenient fallback would make that the quiet outcome of a
   * missing registration — see `requireGovernor`.
   */
  get(venueId: string): RateLimitGovernor | null {
    return this.#governors.get(venueId) ?? null;
  }

  /** As `get`, but a missing registration is a configuration bug and reads like one. */
  requireGovernor(venueId: string): RateLimitGovernor {
    const governor = this.get(venueId);
    if (!governor) {
      throw new Error(
        `${venueId} has no rate-limit policy registered. Every venue the fabric talks to needs one — ` +
          'an ungoverned venue is the one that bans us mid-execution (§27).',
      );
    }
    return governor;
  }

  venueIds(): string[] {
    return [...this.#governors.keys()];
  }
}
