/**
 * HANDLE LOOKUP (pay by @handle) — the guard rails around `identity.users.resolveHandle`.
 *
 * The product choice is "pay by exact @handle with a name check". A lookup that
 * answers yes/no for an arbitrary string is an oracle for who uses INTAFACED, so
 * three limits live here and nowhere else:
 *
 *   · exact match only — `normaliseHandleQuery` accepts one well-formed handle
 *     (optionally written with a leading @) and nothing that could act as a
 *     pattern. The SQL is `=` on a citext column.
 *   · a per-caller budget — `HandleLookupLimiter`.
 *   · one answer for every miss — the router returns `{ found: false }` for
 *     malformed, unknown, frozen and closed handles alike.
 *
 * The limiter is process-local on purpose: svc-identity has no shared limiter
 * today (svc-edge's per-IP one is the only other). With N replicas the real
 * budget is N x max per window, which still makes a harvest of the handle space
 * impractical. A Postgres-backed one can implement `HandleLookupLimiterPort`
 * later without touching the router.
 */

/** Same shape as registration: 3-32 letters, numbers or underscores. */
export const HANDLE_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;

/** Stable code the client can branch on. */
export const HANDLE_LOOKUP_RATE_LIMITED = 'identity.handle_lookup_rate_limited';

export interface HandleLookupLimit {
  /** Lookups allowed per caller per window. */
  readonly max: number;
  readonly windowMs: number;
}

/** 30 per minute per caller: a person typing handles never gets near it. */
export const DEFAULT_HANDLE_LOOKUP_LIMIT: HandleLookupLimit = { max: 30, windowMs: 60_000 };

export interface HandleLookupLimiterPort {
  /** True when the caller may do one more lookup now. A refusal is not counted. */
  tryTake(callerId: string): boolean | Promise<boolean>;
}

/** Process-local sliding window keyed by caller (user id). */
export class HandleLookupLimiter implements HandleLookupLimiterPort {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: HandleLookupLimit = DEFAULT_HANDLE_LOOKUP_LIMIT,
    private readonly now: () => number = Date.now,
  ) {}

  tryTake(callerId: string): boolean {
    const now = this.now();
    const since = now - this.limit.windowMs;
    const recent = (this.hits.get(callerId) ?? []).filter((t) => t > since);
    if (recent.length >= this.limit.max) {
      this.hits.set(callerId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(callerId, recent);
    this.sweep(since);
    return true;
  }

  /** Drop callers with no hits left in the window so the map cannot grow forever. */
  private sweep(since: number): void {
    if (this.hits.size < 1024) return;
    for (const [id, times] of this.hits) {
      if (times.every((t) => t <= since)) this.hits.delete(id);
    }
  }
}

/**
 * One well-formed handle, or null. Trims, drops a single leading "@" (that is
 * how the UI shows it), and refuses everything that is not a registration-shaped
 * handle, so `%` and `*` cannot be smuggled in as patterns.
 */
export function normaliseHandleQuery(raw: string): string | null {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return HANDLE_PATTERN.test(bare) ? bare : null;
}
