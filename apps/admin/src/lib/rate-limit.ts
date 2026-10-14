/**
 * A small per-client limiter for the public POST routes that have no session to hang a limit on (`/api/reset`,
 * `/api/enroll/register`).
 *
 * WHY. svc-edge limits per IP, but every request this server makes reaches the edge from this server's one address, so a script
 * hammering these routes would spend the same budget the founders' own sign-ins use. This stops it earlier, per browser address.
 *
 * It is in memory and per process: a restart clears it, and two replicas each count separately. That is enough to blunt a loop
 * and costs nothing to run; it is not an account lockout (identity does that).
 *
 * CLIENT ADDRESS. Behind the Caddy deploy the socket address is Caddy's, so the real client is the first `X-Forwarded-For` entry,
 * which Caddy sets from the connecting address and does not take from the request. That header is only believed when the
 * deployment sets ADMIN_TRUST_PROXY=1 (the Caddy deploy does). Without it there is no client to tell apart, and one shared
 * bucket would let a single noisy script lock both founders out of /reset, so the limiter then stays out of the way and the
 * edge's limits and identity's account lockout remain the protection. IPv6 clients are keyed by their /64, the block one
 * subscriber usually holds, so rotating addresses inside it does not buy fresh buckets.
 *
 * COST. A fixed window per client: one counter and one reset time, so every hit is O(1) and the stored size never depends on
 * how many requests arrive. The table is capped; when full, the oldest client is dropped (Map keeps insertion order), so a flood
 * of new addresses can never refuse a newcomer, it can only forget an old one.
 */

export interface RateLimiter {
  /** True if this hit is allowed, false if the client is over the limit. */
  hit(key: string, now?: number): boolean;
  /** Seconds until this client's window resets. */
  retryAfter(key: string, now?: number): number;
  /** Number of clients currently stored (for tests). */
  size(): number;
  reset(): void;
}

const MAX_KEYS = 10_000;

export function createRateLimiter({
  limit,
  windowMs,
  maxKeys = MAX_KEYS,
}: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
}): RateLimiter {
  let windows = new Map<string, { count: number; resetAt: number }>();
  const live = (key: string, now: number) => {
    const entry = windows.get(key);
    if (entry && entry.resetAt > now) return entry;
    if (entry) windows.delete(key);
    return undefined;
  };
  return {
    hit(key, now = Date.now()) {
      const entry = live(key, now);
      if (entry) {
        if (entry.count >= limit) return false; // refused hits are not stored: the cost of a flood stays flat
        entry.count += 1;
        return true;
      }
      if (windows.size >= maxKeys) {
        // Rebuild once into a fresh Map: expired clients go, then the oldest tenth of the live ones. A fresh Map carries none of
        // the deleted slots V8 keeps at the front of a Map after deletes, so the next ~1,000 newcomers cost nothing extra.
        const kept = [...windows].filter(([, entry]) => entry.resetAt > now);
        windows = new Map(kept.slice(Math.max(0, kept.length - Math.floor(maxKeys * 0.9))));
      }
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return limit >= 1;
    },
    retryAfter(key, now = Date.now()) {
      const entry = live(key, now);
      return entry ? Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) : 0;
    },
    size() {
      return windows.size;
    },
    reset() {
      windows.clear();
    },
  };
}

/**
 * The key for this request's client, or null when clients cannot be told apart (ADMIN_TRUST_PROXY unset, or no usable
 * address): the caller then does not limit. IPv4 is used as is; IPv6 is cut to its /64.
 */
export function clientKey(request: Request, env: Record<string, string | undefined> = process.env): string | null {
  if (env.ADMIN_TRUST_PROXY !== '1') return null;
  const raw = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim().toLowerCase() ?? '';
  // An IPv4 peer written as IPv6 (`::ffff:1.2.3.4`) is that IPv4 client; a zone suffix (`%en0`) is not part of the address.
  const first = raw.replace(/%.*$/, '').replace(/^::ffff:(?=\d{1,3}(\.\d{1,3}){3}$)/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(first)) return first;
  if (!/^[0-9a-f:]{2,39}$/.test(first) || !first.includes(':')) return null;
  return `v6:${ipv6Prefix64(first)}`;
}

/** The first four 16-bit groups of an IPv6 address, with `::` expanded. */
function ipv6Prefix64(address: string): string {
  const [head = '', tail] = address.split('::', 2);
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return groups
    .slice(0, 4)
    .map((group) => (group || '0').replace(/^0+(?=.)/, ''))
    .join(':');
}

/** 10 attempts per 15 minutes per client, for each public route separately. */
export const resetLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });
export const registerLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });

/** The 429 reply, or null if the request may go on. */
export function limitedResponse(
  limiter: RateLimiter,
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Response | null {
  const key = clientKey(request, env);
  if (key === null || limiter.hit(key)) return null;
  return Response.json(
    { code: 'admin.rate_limited' },
    { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(limiter.retryAfter(key)) } },
  );
}
