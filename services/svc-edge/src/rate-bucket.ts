import type { KeyRateLimit, KeyUsageOutput, RateLimitReason, RouteCost } from '@intafaced/contracts/api-rate-limits';
import { routeCostSchema } from '@intafaced/contracts/api-rate-limits';
import { z } from 'zod';

/**
 * The key's token bucket (DV-limits-01, J-developer-06 #2 #3; ENGINE RL-1 to RL-4).
 *
 * Each API key spends from one bucket of `burst` tokens that refills at `refillPerMinute`; a call spends its route's
 * cost from the owner's cost table (`EDGE_RATE_ROUTE_COSTS`). Identity hands the key's limit over in the exchange. A
 * blank limit or a route with no cost allows nothing: the call is refused with `edge.limits_unset` or `edge.cost_unset`
 * and never metered against a default.
 *
 * The bucket lives in this process: each replica counts on its own, and a restart starts every key full. That is a
 * stated limit (the readiness view says per-replica), not a shared store.
 */

/** `EDGE_RATE_ROUTE_COSTS`: JSON list of `{ route: "METHOD /path", cost }`, first match wins. Blank: none set. */
export function parseRouteCosts(raw: string | undefined): readonly RouteCost[] {
  const text = raw?.trim() ?? '';
  if (!text) return [];
  try {
    return z.array(routeCostSchema).min(1).parse(JSON.parse(text));
  } catch {
    throw new Error('EDGE_RATE_ROUTE_COSTS must be a JSON list of {"route":"METHOD /path","cost":n} (n a whole number above 0)');
  }
}

function segmentsMatch(pattern: readonly string[], path: readonly string[]): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    const part = pattern[i]!;
    if (part === '**' && i === pattern.length - 1) return path.length >= i;
    if (i >= path.length) return false;
    if (part !== '*' && part !== path[i]) return false;
  }
  return pattern.length === path.length;
}

const split = (path: string) => path.split('/').filter(Boolean);

/** The cost of one call: the first row whose method and path match. Null: the table names no cost for this call. */
export function routeCost(costs: readonly RouteCost[], method: string, pathname: string): number | null {
  const verb = method.toUpperCase();
  const path = split(pathname);
  for (const row of costs) {
    const [rowMethod, rowPath] = row.route.split(' ') as [string, string];
    if (rowMethod !== '*' && rowMethod !== verb) continue;
    if (segmentsMatch(split(rowPath), path)) return row.cost;
  }
  return null;
}

interface Bucket {
  /** Tokens, as a fraction: refill is continuous. */
  tokens: number;
  at: number;
  burst: number;
  refillPerMinute: number;
  userId: string;
  since: number;
  used: number;
  refused: number;
}

export type Take =
  | { readonly ok: true; readonly remaining: number; readonly cost: number; readonly burst: number }
  | {
      readonly ok: false;
      readonly reason: RateLimitReason;
      readonly retryAfterSeconds: number;
      readonly cost: number;
      readonly burst: number;
    };

/** Every key's bucket on this replica. An unused key's bucket is dropped once it would be full again. */
export class KeyBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private takes = 0;

  /** Spend `cost` tokens of key `kid`, owned by `userId`, under `limit`. A clock that moved back adds nothing. */
  take(kid: string, userId: string, limit: KeyRateLimit, cost: number, now: number): Take {
    if ((this.takes += 1) % 1000 === 0) this.prune(now);
    let bucket = this.buckets.get(kid);
    if (!bucket) {
      bucket = { tokens: limit.burst, at: now, burst: limit.burst, refillPerMinute: limit.refillPerMinute, userId, since: now, used: 0, refused: 0 };
      this.buckets.set(kid, bucket);
    }
    const perMs = limit.refillPerMinute / 60_000;
    const elapsed = Math.max(0, now - bucket.at);
    // A changed limit (a grant, or a tier the owner moved) applies from this call; the bucket never holds more than it.
    bucket.tokens = Math.min(limit.burst, bucket.tokens + elapsed * perMs);
    bucket.at = Math.max(bucket.at, now);
    bucket.burst = limit.burst;
    bucket.refillPerMinute = limit.refillPerMinute;
    if (cost > limit.burst) {
      bucket.refused += 1;
      return { ok: false, reason: 'endpoint', retryAfterSeconds: Math.ceil((cost - limit.burst) / perMs / 1000) || 1, cost, burst: limit.burst };
    }
    if (bucket.tokens + 1e-9 < cost) {
      bucket.refused += 1;
      const missing = cost - bucket.tokens;
      return { ok: false, reason: 'global', retryAfterSeconds: Math.max(1, Math.ceil(missing / perMs / 1000)), cost, burst: limit.burst };
    }
    bucket.tokens -= cost;
    bucket.used += cost;
    return { ok: true, remaining: Math.floor(bucket.tokens + 1e-9), cost, burst: limit.burst };
  }

  /** What this replica counted for key `kid`, for its owner only; anyone else, or a key it never counted, reads `none`. */
  usage(kid: string, userId: string, now: number): KeyUsageOutput {
    const asOf = new Date(now).toISOString();
    const bucket = this.buckets.get(kid);
    if (!bucket || bucket.userId !== userId) return { state: 'none', asOf, keyId: kid };
    const tokens = Math.min(bucket.burst, bucket.tokens + Math.max(0, now - bucket.at) * (bucket.refillPerMinute / 60_000));
    return {
      state: 'counted',
      asOf,
      keyId: kid,
      since: new Date(bucket.since).toISOString(),
      used: bucket.used,
      refused: bucket.refused,
      remaining: Math.floor(tokens + 1e-9),
      burst: bucket.burst,
      refillPerMinute: bucket.refillPerMinute,
    };
  }

  /** Drops buckets that have refilled to full and have no counts worth keeping past an hour of quiet. */
  prune(now: number): void {
    for (const [kid, bucket] of this.buckets) {
      if (now - bucket.at > 3_600_000) this.buckets.delete(kid);
    }
  }
}
