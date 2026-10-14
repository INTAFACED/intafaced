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
 * deployment sets ADMIN_TRUST_PROXY=1 (the Caddy deploy does). Without it anyone could invent the header, so every request shares
 * one bucket: safe, but one noisy client can then slow the others down.
 */

export interface RateLimiter {
  /** True if this hit is allowed, false if the client is over the limit. Counts the hit either way. */
  hit(key: string, now?: number): boolean;
  /** Seconds until the oldest counted hit leaves the window. */
  retryAfter(key: string, now?: number): number;
  reset(): void;
}

const MAX_KEYS = 10_000;

export function createRateLimiter({ limit, windowMs }: { limit: number; windowMs: number }): RateLimiter {
  const hits = new Map<string, number[]>();
  const recent = (key: string, now: number) => (hits.get(key) ?? []).filter((at) => now - at < windowMs);
  return {
    hit(key, now = Date.now()) {
      if (hits.size >= MAX_KEYS && !hits.has(key)) {
        for (const [other, times] of hits) if (times.every((at) => now - at >= windowMs)) hits.delete(other);
        // Still full of live entries: refuse new clients rather than grow without bound.
        if (hits.size >= MAX_KEYS) return false;
      }
      const times = recent(key, now);
      times.push(now);
      hits.set(key, times);
      return times.length <= limit;
    },
    retryAfter(key, now = Date.now()) {
      const times = recent(key, now);
      return times.length === 0 ? 0 : Math.max(1, Math.ceil((times[0]! + windowMs - now) / 1000));
    },
    reset() {
      hits.clear();
    },
  };
}

/** The key for this request's client: the first X-Forwarded-For entry when ADMIN_TRUST_PROXY=1 and it looks like an address, else one shared bucket. */
export function clientKey(request: Request, env: Record<string, string | undefined> = process.env): string {
  if (env.ADMIN_TRUST_PROXY !== '1') return 'shared';
  const first = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  return /^[0-9A-Fa-f:.]{3,45}$/.test(first) ? first.toLowerCase() : 'shared';
}

/** 10 attempts per 15 minutes per client, for each public route separately. */
export const resetLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });
export const registerLimiter = createRateLimiter({ limit: 10, windowMs: 15 * 60_000 });

/** The 429 reply, or null if the request may go on. */
export function limitedResponse(limiter: RateLimiter, request: Request): Response | null {
  const key = clientKey(request);
  if (limiter.hit(key)) return null;
  return Response.json(
    { code: 'admin.rate_limited' },
    { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(limiter.retryAfter(key)) } },
  );
}
