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
 * The running service uses `PgHandleLookupLimiter`: one row per person in
 * `handle_lookup_budget`, so every replica and every restart shares the one
 * budget (#4689). A process-local `HandleLookupLimiter` would give a person N
 * budgets on N replicas; it stays for router tests that pin the clock.
 */
import type { Sql } from 'postgres';

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
 * Shared fixed window in Postgres, keyed by person. One atomic upsert takes a
 * lookup: a new or expired window starts at 1, a live one under the limit adds
 * 1, and a full one matches no row, so nothing is written and the lookup is
 * refused. The database serialises takes on the row, so lookups fired at once
 * from several replicas never exceed `max` per window between them.
 */
export class PgHandleLookupLimiter implements HandleLookupLimiterPort {
  constructor(
    private readonly sql: Sql,
    private readonly limit: HandleLookupLimit = DEFAULT_HANDLE_LOOKUP_LIMIT,
    /** Tests pin the clock; absent, the database's own clock decides, the same on every replica. */
    private readonly now?: () => Date,
  ) {}

  async tryTake(callerId: string): Promise<boolean> {
    const at = this.now ? this.now().toISOString() : null;
    const windowSeconds = this.limit.windowMs / 1000;
    let rows: { hits: number }[];
    try {
      rows = await this.sql<{ hits: number }[]>`
      WITH t AS (SELECT COALESCE(${at}::timestamptz, now()) AS at)
      INSERT INTO handle_lookup_budget AS b (user_id, window_started_at, hits)
      SELECT ${callerId}::uuid, t.at, 1 FROM t
      ON CONFLICT (user_id) DO UPDATE SET
        window_started_at = CASE
          WHEN b.window_started_at <= EXCLUDED.window_started_at - make_interval(secs => ${windowSeconds}) THEN EXCLUDED.window_started_at
          ELSE b.window_started_at END,
        hits = CASE
          WHEN b.window_started_at <= EXCLUDED.window_started_at - make_interval(secs => ${windowSeconds}) THEN 1
          ELSE b.hits + 1 END
      WHERE b.window_started_at <= EXCLUDED.window_started_at - make_interval(secs => ${windowSeconds})
         OR b.hits < ${this.limit.max}
      RETURNING b.hits`;
    } catch (err) {
      // A caller with no user row (an account removed under a live token) has no budget: refuse it, never a 500.
      if ((err as { code?: string }).code === '23503') return false;
      throw err;
    }
    return rows.length === 1;
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
