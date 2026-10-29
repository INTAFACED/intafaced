import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { userCopy } from './user-copy.js';

/**
 * TRANSPORT HARDENING — the two controls the front door was missing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * svc-edge is the only component the internet reaches, and it proxies to every
 * service in the fleet. Until this file it sent no security headers at all, and
 * it counted nothing: there was no throttle of any kind on any path.
 *
 * The absent throttle is the sharper of the two. `/api/*` is a catch-all that
 * forwards to `resolve()`'s route table, and one of those routes is
 * svc-identity. A password guess and a legitimate login are the same request
 * shape to this process, so an unauthenticated caller could spend attempts at
 * whatever rate their socket allowed — against the component that mints the
 * bearer tokens the entire platform trusts. Nothing downstream compensates:
 * `exchangePrincipal` refuses a bad token cheaply and correctly, and refusing
 * cheaply a million times is still a million attempts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT HERE
 *
 * **`@fastify/cors` does not replace `cors.ts`.** That file is hand-rolled for
 * properties the plugin does not offer: every `OPTIONS` terminated at the edge
 * and never proxied, a preflight answer computed from the `Origin` header alone
 * so it cannot be used as a route oracle, and allow-origin headers that survive
 * onto 404/502/503 refusals. Those are load-bearing and tested. Swapping them
 * for a plugin default would be a regression wearing the costume of a cleanup.
 *
 * **`@fastify/under-pressure` is not registered.** It answers 503 when event-loop
 * lag crosses a threshold. On a money platform that means shedding an order
 * cancel — the request a user most needs served — precisely when the system is
 * busiest. Load shedding is a product decision about which calls are droppable,
 * and nobody has made it. Serving slowly is not the same failure as refusing,
 * and this file will not quietly convert one into the other.
 */

/** Probe paths that must never be throttled. */
const UNTHROTTLED = new Set(['/health', '/ready']);

/**
 * Safe bucket class on the wire — never the IP, kid, or a VIP tier.
 * Institutional / fill-ratio / privileged-tier policy is owner-set and absent;
 * this file does not invent capacity for them.
 */
export const EDGE_IP_RATE_BUCKET = 'edge.ip' as const;
export const EDGE_API_KEY_RATE_BUCKET = 'edge.api_key' as const;

/** Every counted request costs 1. No per-route weights exist. */
export const EDGE_RATE_COST = 1 as const;

export const RATE_LIMIT_HEADER = {
  limit: 'x-ratelimit-limit',
  remaining: 'x-ratelimit-remaining',
  reset: 'x-ratelimit-reset',
  retryAfter: 'retry-after',
  bucket: 'x-ratelimit-bucket',
  cost: 'x-ratelimit-cost',
} as const;

type HeaderReply = {
  header(name: string, value: string | number): unknown;
  getHeader?(name: string): unknown;
};

/**
 * Bucket/cost only when the limiter actually counted. The request id is not a capacity claim and is not
 * stamped here: `reply-envelope.ts` puts it on every reply, refusals included.
 */
export function stampRateLimitDisclosure(reply: HeaderReply): void {
  if (reply.getHeader?.(RATE_LIMIT_HEADER.remaining) === undefined) return;
  if (reply.getHeader?.(RATE_LIMIT_HEADER.bucket) === undefined) {
    reply.header(RATE_LIMIT_HEADER.bucket, EDGE_IP_RATE_BUCKET);
  }
  if (reply.getHeader?.(RATE_LIMIT_HEADER.cost) === undefined) {
    reply.header(RATE_LIMIT_HEADER.cost, EDGE_RATE_COST);
  }
}

/** Overwrite remaining to the bucket that actually refused (429, not a delayed 200). */
export function stampRateLimitRefuseHeaders(reply: HeaderReply, input: { limit: number; resetSeconds: number; bucket: string }): void {
  reply.header(RATE_LIMIT_HEADER.limit, input.limit);
  reply.header(RATE_LIMIT_HEADER.remaining, 0);
  reply.header(RATE_LIMIT_HEADER.reset, input.resetSeconds);
  reply.header(RATE_LIMIT_HEADER.retryAfter, input.resetSeconds);
  reply.header(RATE_LIMIT_HEADER.bucket, input.bucket);
  reply.header(RATE_LIMIT_HEADER.cost, EDGE_RATE_COST);
}

export interface RateLimitConfig {
  /** Requests allowed per window, per key. */
  readonly max: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** When false, no limiter is registered at all. */
  readonly enabled: boolean;
  /**
   * Whether Fastify was constructed with `trustProxy`. Not used to configure
   * the limiter — it is used to describe, honestly, what the key actually is.
   */
  readonly trustProxy: boolean;
  /**
   * True only when counted calls go through one SharedRequestBudget held by
   * every replica. In-process Fastify counters stay false.
   */
  readonly sharedBudget?: boolean;
}

/**
 * What the limiter will actually key on, in words an operator can act on.
 *
 * This exists because the dangerous failure here is silent and inverted. Behind
 * nginx or a load balancer WITHOUT `trustProxy`, every caller in the world
 * arrives with the proxy's address, so `req.ip` is one value and the limit
 * becomes a single global budget shared by all users. A control installed to
 * stop one attacker would instead throttle the whole platform on that
 * attacker's behalf — a self-inflicted outage that looks, from inside, exactly
 * like the control working.
 *
 * So the posture is stated at boot rather than assumed, in the same spirit as
 * the screening and CORS summaries next to it in `index.ts`.
 */
export function rateLimitSummary(config: RateLimitConfig): { level: 'info' | 'warn'; summary: string } {
  if (!config.enabled) {
    return {
      level: 'warn',
      summary:
        'rate limit: DISABLED — the front door counts nothing. Every path, including the ' +
        'proxy to svc-identity, accepts requests as fast as a caller can send them. ' +
        'Set EDGE_RATE_LIMIT_ENABLED=true.',
    };
  }

  if (!config.trustProxy) {
    return {
      level: 'warn',
      summary:
        `rate limit: ${config.max} per ${config.windowMs}ms keyed on the DIRECT socket address, ` +
        `because EDGE_TRUST_PROXY is unset. If this deployment sits behind nginx or a load ` +
        `balancer, every caller shares ONE bucket and this limit throttles the whole platform ` +
        `rather than any individual. Set EDGE_TRUST_PROXY to the proxy's address or CIDR.`,
    };
  }

  return {
    level: 'info',
    summary: `rate limit: ${config.max} per ${config.windowMs}ms per client address (proxy headers trusted)`,
  };
}

/**
 * Unauthenticated `/ready` posture for the throttle — counts and booleans only.
 *
 * Mirrors the screening/CORS shape: an operator (or probe) can see whether the
 * control is armed without reading boot logs, and without inventing a shared
 * store. `multiReplicaShared` is true only when `sharedBudget` is set on an
 * enabled limiter. In-process Fastify counters stay false.
 */
export interface RateLimitReadiness {
  readonly enabled: boolean;
  /** Null when disabled — no budget is in force. */
  readonly max: number | null;
  readonly windowMs: number | null;
  readonly trustProxy: boolean;
  /** True only when replicas share one SharedRequestBudget. */
  readonly multiReplicaShared: boolean;
  /** One short line; not the full boot WARN essay. */
  readonly note: string;
}

export interface SharedBudgetTake {
  readonly ok: true;
}

export interface SharedBudgetRefuse {
  readonly ok: false;
  readonly retryAfterSeconds: number;
}

/**
 * One counter for a caller, shared by every replica that holds this object.
 * `take` returns null when the counter cannot be read. The caller refuses
 * and does not place.
 */
export interface SharedRequestBudget {
  take(callerKey: string, nowMs: number): SharedBudgetTake | SharedBudgetRefuse | null;
}

export class MemorySharedRequestBudget implements SharedRequestBudget {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readsFail = false;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  failReads(fail: boolean): void {
    this.readsFail = fail;
  }

  take(callerKey: string, nowMs: number): SharedBudgetTake | SharedBudgetRefuse | null {
    if (this.readsFail) return null;
    const existing = this.buckets.get(callerKey);
    if (!existing || existing.resetAt <= nowMs) {
      this.buckets.set(callerKey, { count: 1, resetAt: nowMs + this.windowMs });
      return { ok: true };
    }
    if (existing.count >= this.max) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000)) };
    }
    existing.count += 1;
    return { ok: true };
  }
}

export function admitCountedOrder(input: {
  readonly budget: SharedRequestBudget;
  readonly callerKey: string;
  readonly nowMs: number;
  readonly place: () => void;
}):
  | { admitted: true }
  | { admitted: false; code: 'edge.rate_limited'; retryAfterSeconds: number }
  | { admitted: false; code: 'edge.rate_unreadable' } {
  const taken = input.budget.take(input.callerKey, input.nowMs);
  if (taken === null) return { admitted: false, code: 'edge.rate_unreadable' };
  if (!taken.ok) return { admitted: false, code: 'edge.rate_limited', retryAfterSeconds: taken.retryAfterSeconds };
  input.place();
  return { admitted: true };
}

export function rateLimitReadiness(config: RateLimitConfig): RateLimitReadiness {
  const shared = config.enabled && config.sharedBudget === true;
  if (!config.enabled) {
    return {
      enabled: false,
      max: null,
      windowMs: null,
      trustProxy: config.trustProxy,
      multiReplicaShared: false,
      note: 'Throttle off — front door counts nothing (EDGE_RATE_LIMIT_ENABLED). Per-replica only; no shared store.',
    };
  }
  return {
    enabled: true,
    max: config.max,
    windowMs: config.windowMs,
    trustProxy: config.trustProxy,
    multiReplicaShared: shared,
    note: shared
      ? 'One shared request budget for every replica that holds the store. An unreadable counter refuses the counted call.'
      : config.trustProxy
        ? 'Per-replica in-process counters; proxy headers trusted for req.ip. Not fleet-wide.'
        : 'Per-replica in-process counters; EDGE_TRUST_PROXY unset — behind a balancer every caller may share ONE bucket.',
  };
}

/**
 * Security headers.
 *
 * This service answers JSON and serves no markup, so most of helmet's document
 * protections have nothing to act on. Two are switched off deliberately rather
 * than left at a default:
 *
 *   · CSP is off. A policy on a response no browser renders protects nothing,
 *     and a wrong one is a support ticket from whichever front-end embeds an
 *     error body. `apps/admin` sets its own policy over its own documents.
 *   · HSTS is off HERE. The edge terminates no TLS — nginx and the load
 *     balancer do — so a max-age emitted from behind them is a promise made by
 *     the component least able to keep it. It belongs at the TLS terminator,
 *     where somebody can see the certificate.
 *
 * What is left is the set that means something for an API: `nosniff`, a denied
 * frame ancestry, no cross-domain policies, and a referrer policy.
 */
export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: false,
    strictTransportSecurity: false,
    // Answers are JSON and are not a document; denying framing costs nothing
    // and removes a clickjacking question nobody should have to re-ask.
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    // `crossOriginResourcePolicy` would add `same-origin`, which contradicts the
    // deliberate cross-origin grant `cors.ts` issues to the configured
    // allowlist. Left off so one file owns that decision.
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
}

/**
 * The throttle.
 *
 * Registered AFTER `registerCors`, and the order is a control rather than a
 * preference — the same argument `cors.ts` makes for its own position:
 *
 *   · A preflight is answered inside the CORS hook and never reaches this
 *     limiter, so an `OPTIONS` storm cannot exhaust a legitimate user's budget
 *     and browsers do not spend quota on requests they were forced to send.
 *   · The allow-origin header is already on the reply when a 429 is sent, so a
 *     browser can READ the refusal. A throttle the browser reports as a generic
 *     CORS error tells a user the platform is broken instead of telling them to
 *     slow down.
 *
 * `/health` and `/ready` are exempt. Throttling a load balancer's probe is how
 * a busy-but-working edge gets pulled out of rotation and turned into an outage
 * — the limiter would cause exactly the unavailability it was installed to
 * prevent.
 */
export async function registerRateLimit(app: FastifyInstance, config: RateLimitConfig): Promise<void> {
  // remaining/bucket/cost only appear when the plugin counted this request (probes and throttle-off stay
  // silent). The request id is the envelope's (`reply-envelope.ts`), on every reply.
  app.addHook('onSend', async (_req, reply) => {
    stampRateLimitDisclosure(reply);
  });

  if (!config.enabled) return;

  await app.register(rateLimit, {
    max: config.max,
    timeWindow: config.windowMs,
    // In-process counters. One replica cannot see another's, so N replicas
    // means N budgets — the honest description is "per replica", and a shared
    // store is a §13 socket, not something to fake with a comment.
    allowList: (req: FastifyRequest) => {
      const pathname = req.url.split('?')[0] ?? req.url;
      return UNTHROTTLED.has(pathname);
    },
    // Plugin defaults already emit these; pin true so a default flip cannot
    // silently drop remaining/reset from the wire (PX-S04 §15).
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
    // The refusal says what happened and names the retry window. `code` matches
    // the `edge.*` vocabulary the other refusals in this service use, so a
    // client can branch on it the same way.
    //
    // `statusCode` is not decoration: the builder's return value is thrown as
    // the error, and Fastify reads the status from it. Omit the field and a
    // throttle answers 500 — the body says "rate limited" while the status tells
    // every client and dashboard the edge crashed.
    // `requestId` is added to the body on the way out by the envelope, equal to the header.
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: userCopy('edge.rate_limited'),
      code: 'edge.rate_limited',
      retryAfterSeconds: Math.ceil(Number(context.ttl) / 1000),
      remaining: 0,
      bucket: EDGE_IP_RATE_BUCKET,
      cost: EDGE_RATE_COST,
    }),
  });
}
