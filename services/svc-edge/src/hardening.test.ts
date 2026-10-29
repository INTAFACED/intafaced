import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER, REQUEST_ID_OPTIONS, registerReplyEnvelope } from './reply-envelope.js';
import { registerCors, type OriginAllowlist } from './cors.js';
import {
  EDGE_API_KEY_RATE_BUCKET,
  EDGE_IP_RATE_BUCKET,
  EDGE_RATE_COST,
  RATE_LIMIT_HEADER,
  rateLimitReadiness,
  rateLimitSummary,
  registerRateLimit,
  registerSecurityHeaders,
  stampRateLimitDisclosure,
  stampRateLimitRefuseHeaders,
  type RateLimitConfig,
} from './hardening.js';

/**
 * THE THROTTLE, AND THE TWO WAYS IT COULD BE WORSE THAN NOTHING.
 *
 * A rate-limit test that only proves "the 301st request gets a 429" certifies
 * the half that was never in doubt. The failures worth catching are the ones
 * that still look like the control working:
 *
 *   · a 429 the BROWSER CANNOT READ, because the allow-origin header was not on
 *     the reply. The user is told the platform is down rather than told to slow
 *     down, which is the same symptom `cors.ts` was written to end.
 *   · a throttled `/health` or `/ready`, which takes a busy-but-working edge out
 *     of the load balancer — the limiter causing the outage it was installed to
 *     prevent.
 *   · a preflight that spends the caller's budget, letting an `OPTIONS` storm
 *     lock out the legitimate requests behind it.
 *
 * `app.inject()` is Fastify's real pipeline, so hook ordering here is the
 * ordering `index.ts` gets.
 */

const ORIGIN = 'https://app.example.com';

function header(res: { headers: Record<string, unknown> }, name: string): unknown {
  return res.headers[name];
}

function expectCountedCapacity(
  res: { headers: Record<string, unknown> },
  expected: { remaining: number; limit: number; bucket: string },
): void {
  expect(String(header(res, RATE_LIMIT_HEADER.limit))).toBe(String(expected.limit));
  expect(String(header(res, RATE_LIMIT_HEADER.remaining))).toBe(String(expected.remaining));
  expect(Number(header(res, RATE_LIMIT_HEADER.reset))).toBeGreaterThan(0);
  expect(header(res, RATE_LIMIT_HEADER.bucket)).toBe(expected.bucket);
  expect(String(header(res, RATE_LIMIT_HEADER.cost))).toBe(String(EDGE_RATE_COST));
  expect(header(res, REQUEST_ID_HEADER)).toEqual(expect.any(String));
}

function expectNoCapacityClaim(res: { headers: Record<string, unknown> }): void {
  expect(header(res, RATE_LIMIT_HEADER.limit)).toBeUndefined();
  expect(header(res, RATE_LIMIT_HEADER.remaining)).toBeUndefined();
  expect(header(res, RATE_LIMIT_HEADER.reset)).toBeUndefined();
  expect(header(res, RATE_LIMIT_HEADER.bucket)).toBeUndefined();
  expect(header(res, RATE_LIMIT_HEADER.cost)).toBeUndefined();
  expect(header(res, RATE_LIMIT_HEADER.retryAfter)).toBeUndefined();
}

const allowlist: OriginAllowlist = {
  origins: [ORIGIN],
  configured: true,
  source: 'test',
  summary: 'test',
};

/** The registrations `index.ts` performs, in the same order (the envelope owns the request id). */
async function buildApp(config: Partial<RateLimitConfig> = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ...REQUEST_ID_OPTIONS });
  registerReplyEnvelope(app);
  registerCors(app, allowlist);
  await registerSecurityHeaders(app);
  await registerRateLimit(app, {
    enabled: true,
    max: 2,
    windowMs: 60_000,
    trustProxy: false,
    ...config,
  });
  app.get('/health', async () => ({ ok: true }));
  app.get('/ready', async () => ({ ready: true }));
  app.all('/api/*', async () => ({ proxied: true }));
  await app.ready();
  return app;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('rate limit', () => {
  it('refuses past the limit with the edge refusal vocabulary', async () => {
    app = await buildApp();

    const first = await app.inject({ method: 'GET', url: '/api/trade/thing' });
    const second = await app.inject({ method: 'GET', url: '/api/trade/thing' });
    const third = await app.inject({ method: 'GET', url: '/api/trade/thing' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expectCountedCapacity(first, { remaining: 1, limit: 2, bucket: EDGE_IP_RATE_BUCKET });
    expectCountedCapacity(second, { remaining: 0, limit: 2, bucket: EDGE_IP_RATE_BUCKET });
    // 429 and not 500. The builder's return is thrown as the error and Fastify
    // reads the status off it, so a missing `statusCode` produces a body that
    // says "rate limited" over a status that says the edge fell over.
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({
      code: 'edge.rate_limited',
      remaining: 0,
      bucket: EDGE_IP_RATE_BUCKET,
      cost: EDGE_RATE_COST,
    });
    expect(third.json().retryAfterSeconds).toBeGreaterThan(0);
    expect(third.json().requestId).toBe(third.headers[REQUEST_ID_HEADER]);
    expectCountedCapacity(third, { remaining: 0, limit: 2, bucket: EDGE_IP_RATE_BUCKET });
    expect(third.headers[RATE_LIMIT_HEADER.retryAfter]).toBeDefined();
  });

  it('puts the allow-origin header on the 429, so a browser can read the refusal', async () => {
    app = await buildApp();

    let last = await app.inject({ method: 'GET', url: '/api/trade/thing', headers: { origin: ORIGIN } });
    for (let i = 0; i < 3; i++) {
      last = await app.inject({ method: 'GET', url: '/api/trade/thing', headers: { origin: ORIGIN } });
    }

    expect(last.statusCode).toBe(429);
    // Without this the browser reports a generic CORS error and the user is
    // told the platform is broken instead of being told to slow down.
    expect(last.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('never throttles the load balancer probes', async () => {
    app = await buildApp({ max: 1 });

    // Well past the limit on both probe paths.
    for (let i = 0; i < 5; i++) {
      const health = await app.inject({ method: 'GET', url: '/health' });
      const ready = await app.inject({ method: 'GET', url: '/ready' });
      expect(health.statusCode).toBe(200);
      expect(ready.statusCode).toBe(200);
      expectNoCapacityClaim(health);
      expectNoCapacityClaim(ready);
    }
  });

  it('does not spend the caller budget on preflights', async () => {
    app = await buildApp({ max: 2 });

    // Preflights are answered inside the CORS hook and never reach the limiter.
    for (let i = 0; i < 10; i++) {
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/api/trade/thing',
        headers: { origin: ORIGIN },
      });
      expect(preflight.statusCode).toBe(204);
    }

    // The budget is untouched, so a real request still succeeds.
    const real = await app.inject({ method: 'GET', url: '/api/trade/thing', headers: { origin: ORIGIN } });
    expect(real.statusCode).toBe(200);
  });

  it('registers no limiter at all when disabled', async () => {
    app = await buildApp({ enabled: false, max: 1 });

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/trade/thing' });
      expect(res.statusCode).toBe(200);
      expectNoCapacityClaim(res);
    }
  });

  it('refuses with 429 rather than a delayed success', async () => {
    app = await buildApp({ max: 1 });
    await app.inject({ method: 'GET', url: '/api/trade/thing' });
    const refused = await app.inject({ method: 'GET', url: '/api/trade/thing' });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().code).toBe('edge.rate_limited');
    expect(refused.json()).not.toMatchObject({ delayed: true });
    expect(refused.json()).not.toHaveProperty('queued');
  });
});

describe('security headers', () => {
  it('sends the API-relevant set', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('emits no CSP and no HSTS — neither is this component to promise', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    // A policy on a response no browser renders protects nothing.
    expect(res.headers['content-security-policy']).toBeUndefined();
    // The edge terminates no TLS; max-age belongs at the terminator.
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('leaves the cross-origin grant to cors.ts alone', async () => {
    app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/trade/thing', headers: { origin: ORIGIN } });

    // helmet's `crossOriginResourcePolicy: same-origin` would contradict the
    // allowlist that cors.ts deliberately issues.
    expect(res.headers['cross-origin-resource-policy']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
  });
});

describe('rate-limit disclosure stamps', () => {
  it('does not invent remaining when the limiter did not count', () => {
    const headers: Record<string, string | number> = {};
    const reply = {
      header(name: string, value: string | number) {
        headers[name] = value;
      },
      getHeader(name: string) {
        return headers[name];
      },
    };
    stampRateLimitDisclosure(reply);
    // The request id is the envelope's, not a capacity claim of this helper.
    expect(headers[REQUEST_ID_HEADER]).toBeUndefined();
    expect(headers[RATE_LIMIT_HEADER.remaining]).toBeUndefined();
    expect(headers[RATE_LIMIT_HEADER.bucket]).toBeUndefined();
    expect(headers[RATE_LIMIT_HEADER.cost]).toBeUndefined();
  });

  it('keeps a key-quota refuse bucket instead of overwriting it as IP', () => {
    const headers: Record<string, string | number> = {};
    const reply = {
      header(name: string, value: string | number) {
        headers[name] = value;
      },
      getHeader(name: string) {
        return headers[name];
      },
    };
    stampRateLimitRefuseHeaders(reply, {
      limit: 300,
      resetSeconds: 12,
      bucket: EDGE_API_KEY_RATE_BUCKET,
    });
    stampRateLimitDisclosure(reply);
    expect(headers[RATE_LIMIT_HEADER.remaining]).toBe(0);
    expect(headers[RATE_LIMIT_HEADER.bucket]).toBe(EDGE_API_KEY_RATE_BUCKET);
    expect(headers[RATE_LIMIT_HEADER.cost]).toBe(EDGE_RATE_COST);
  });
});

describe('rateLimitSummary', () => {
  const base: RateLimitConfig = { enabled: true, max: 300, windowMs: 60_000, trustProxy: true };

  it('warns loudly when the throttle is off', () => {
    const { level, summary } = rateLimitSummary({ ...base, enabled: false });
    expect(level).toBe('warn');
    expect(summary).toContain('DISABLED');
  });

  it('warns that an untrusted proxy collapses every caller into one bucket', () => {
    const { level, summary } = rateLimitSummary({ ...base, trustProxy: false });
    expect(level).toBe('warn');
    // The inverted failure: the control becomes a platform-wide throttle.
    expect(summary).toContain('ONE bucket');
    expect(summary).toContain('EDGE_TRUST_PROXY');
  });

  it('is quiet only when the key actually identifies a caller', () => {
    const { level } = rateLimitSummary(base);
    expect(level).toBe('info');
  });
});

/**
 * `/ready` must not invent a shared throttle store, and must report whether
 * the control is armed without requiring boot-log archaeology.
 */
describe('rateLimitReadiness', () => {
  const base: RateLimitConfig = { enabled: true, max: 300, windowMs: 60_000, trustProxy: true };

  it('never claims multi-replica share for in-process counters', () => {
    expect(rateLimitReadiness(base).multiReplicaShared).toBe(false);
    expect(rateLimitReadiness({ ...base, enabled: false }).multiReplicaShared).toBe(false);
    expect(rateLimitReadiness({ ...base, trustProxy: false }).multiReplicaShared).toBe(false);
  });

  it('reports the armed budget when enabled', () => {
    const r = rateLimitReadiness(base);
    expect(r.enabled).toBe(true);
    expect(r.max).toBe(300);
    expect(r.windowMs).toBe(60_000);
    expect(r.trustProxy).toBe(true);
  });

  it('reports null budget when disabled rather than a fake number', () => {
    const r = rateLimitReadiness({ ...base, enabled: false });
    expect(r.enabled).toBe(false);
    expect(r.max).toBeNull();
    expect(r.windowMs).toBeNull();
    expect(r.note).toMatch(/off|nothing/i);
  });

  it('names the shared-bucket risk when trustProxy is unset', () => {
    const r = rateLimitReadiness({ ...base, trustProxy: false });
    expect(r.note).toMatch(/ONE bucket|EDGE_TRUST_PROXY/i);
  });
});
