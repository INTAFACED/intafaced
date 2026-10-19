import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import type { Principal } from '@intafaced/auth';
import {
  createEdgeContext,
  encodePrincipal,
  mergeRouters,
  serviceAuthHeaders,
  serviceAuthHeadersForBody,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { parseAmount as amt } from '@intafaced/ledger-client';
import { createSubscriptionRouter } from '../subscription-router.js';
import { PayError, type PayService } from '../payment-service.js';
import { registerSubscriptionCycleRoutes } from './internal-cycle-routes.js';
import type { SubscriptionService } from './subscription-service.js';

/**
 * REACHABILITY — the doctrine gate, for the recurring charge cycle.
 *
 * Every test here goes over the wire. `app.inject` with real headers, a real
 * `fastifyTRPCPlugin` registration, a real `createEdgeContext`. Nothing
 * constructs a router and calls a method on it, because that is the shape this
 * repository keeps getting burned by: svc-ledger's own suite records it — *"a
 * guard is worth exactly as much as the route that runs it. Test the mounted
 * path, not the one you edited."* — and the TWAP ADR counts *"six guards that
 * were correct in isolation and unreachable in place."*
 *
 * The subscription engine's entire defence against double-charging is guards. If
 * they are not reachable they are decoration.
 */

const EDGE_SECRET = 'a-pay-subscription-reachability-edge-secret-long';
const INTERNAL_SECRET = 'a-pay-subscription-reachability-internal-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '55555555-5555-4555-8555-555555555555';
const MANDATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const edgeContext = createEdgeContext({ secret: EDGE_SECRET, serviceName: 'svc-pay' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '33333333-3333-4333-8333-333333333333',
    scopes: ['pay:read', 'pay:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

/** Headers the EDGE really signed. Anything else is a caller's assertion. */
function signedHeaders(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, EDGE_SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

function mandateRecord() {
  return {
    id: MANDATE,
    merchantId: MERCHANT,
    customerId: 'cust-1',
    assetId: 'USDT',
    amount: amt('10'),
    ceiling: null,
    cadence: 'monthly' as const,
    startsAt: new Date('2026-01-01T00:00:00.000Z'),
    endsAt: null,
    railAdapter: null,
    railMandateRef: null,
    status: 'active' as const,
    cancelledAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function subRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: SUB,
    mandateId: MANDATE,
    merchantId: MERCHANT,
    customerId: 'cust-1',
    nextRunAt: new Date('2026-01-01T00:00:00.000Z'),
    status: 'active' as const,
    cancelledAt: null,
    path: 'crypto_invoice',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    anchorAt: null,
    anchorOccurrence: 0,
    pausedAt: null,
    resumedAt: null,
    stalledAt: null,
    stallReason: null,
    ...overrides,
  };
}

/** The merchant surface, mounted at `/trpc` the way `index.ts` mounts it. */
async function mountTrpc(subs: Partial<Record<keyof SubscriptionService, unknown>>) {
  const pay = {
    getMerchant: async (id: string) => {
      if (id !== MERCHANT) throw new PayError('nf', 'pay.merchant_not_found');
      return { id: MERCHANT, userId: USER } as never;
    },
    getMerchantByUserId: async (userId: string) => (userId === USER ? ({ id: MERCHANT } as never) : null),
  } as unknown as PayService;

  const router = mergeRouters(createSubscriptionRouter(subs as unknown as SubscriptionService, pay, null));

  const app = Fastify({ logger: false });
  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router,
      createContext: ({ req }) => edgeContext(req),
    } satisfies FastifyTRPCPluginOptions<typeof router>['trpcOptions'],
  });
  await app.ready();
  return app;
}

type WireBody = {
  result?: { data?: any };
  error?: { message?: string };
};

/** POST a tRPC mutation the way a client does, and hand back the parsed body. */
async function post(
  app: Awaited<ReturnType<typeof mountTrpc>>,
  path: string,
  input: Record<string, unknown>,
  headers: Record<string, string> = signedHeaders(),
): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({ method: 'POST', url: `/trpc/${path}`, headers, payload: input });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

async function get(
  app: Awaited<ReturnType<typeof mountTrpc>>,
  path: string,
  input: Record<string, unknown>,
  headers: Record<string, string> = signedHeaders(),
): Promise<{ statusCode: number; body: WireBody }> {
  const res = await app.inject({
    method: 'GET',
    url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
    headers,
  });
  return { statusCode: res.statusCode, body: res.json() as WireBody };
}

// ── The merchant surface, over HTTP ─────────────────────────────────────────

describe('the subscription cycle surface is mounted and reachable', () => {
  it('pause reaches the service through the mounted route', async () => {
    const pauseSubscription = vi.fn(async () =>
      subRecord({ status: 'paused', pausedAt: new Date(), stalledAt: new Date(), stallReason: 'operator_pause' }),
    );
    const app = await mountTrpc({ getSubscription: async () => subRecord(), pauseSubscription });

    const { statusCode, body } = await post(app, 'subscription.pause', { subscriptionId: SUB });

    expect(statusCode).toBe(200);
    // The service really ran — not a router that merely type-checks.
    expect(pauseSubscription).toHaveBeenCalledWith(SUB);
    expect(body.result!.data.status).toBe('paused');
    // And the REASON crossed the wire, which is what keeps a pause
    // distinguishable from an outage on the merchant's own screen.
    expect(body.result!.data.stallReason).toBe('operator_pause');
    await app.close();
  });

  /**
   * The ADR requires a resume to report its NEW projected end rather than let
   * the caller assume the original one. This asserts it arrives at the client.
   */
  it('resume reaches the service AND returns the re-spaced projected end', async () => {
    const projectedEnd = new Date('2026-11-01T00:00:00.000Z');
    const resumeSubscription = vi.fn(async () => ({
      subscription: subRecord({ anchorAt: new Date('2026-05-01T00:00:00.000Z'), anchorOccurrence: 4, resumedAt: new Date() }),
      projectedEnd,
    }));
    const app = await mountTrpc({ getSubscription: async () => subRecord({ status: 'paused' }), resumeSubscription });

    const { statusCode, body } = await post(app, 'subscription.resume', { subscriptionId: SUB });

    expect(statusCode).toBe(200);
    expect(resumeSubscription).toHaveBeenCalledWith(SUB);
    expect(body.result!.data.projectedEnd).toBe(projectedEnd.toISOString());
    // The frame moved, and the merchant can see that it did.
    expect(body.result!.data.subscription.anchorOccurrence).toBe(4);
    await app.close();
  });

  /**
   * The refusal has to be reachable too. A resume that would carry periods past
   * the mandate window is refused — CONFLICT, because the payload is fine and
   * the mandate is not.
   */
  it('a resume past the mandate window refuses over the wire, by code', async () => {
    const resumeSubscription = vi.fn(async () => {
      throw new PayError('would run past the mandate window', 'pay.subscription_resume_exceeds_mandate');
    });
    const app = await mountTrpc({ getSubscription: async () => subRecord({ status: 'paused' }), resumeSubscription });

    const { statusCode, body } = await post(app, 'subscription.resume', { subscriptionId: SUB });

    expect(statusCode).toBe(409);
    expect(body.error!.message).toMatch(/pay\.subscription_resume_exceeds_mandate/);
    await app.close();
  });

  it('an unpublished fee refuses over the wire rather than charging at zero', async () => {
    const pauseSubscription = vi.fn(async () => {
      throw new PayError('no rate published', 'pay.subscription_fee_unpublished');
    });
    const app = await mountTrpc({ getSubscription: async () => subRecord(), pauseSubscription });

    const { statusCode, body } = await post(app, 'subscription.pause', { subscriptionId: SUB });

    expect(statusCode).toBe(403);
    expect(body.error!.message).toMatch(/pay\.subscription_fee_unpublished/);
    await app.close();
  });

  it('the period journal is readable, with its business keys', async () => {
    const listCycles = vi.fn(async () => [
      {
        occurrence: 0,
        amount: amt('10'),
        status: 'settled' as const,
        idempotencyKey: `pay.subscription:${SUB}:0`,
        attemptCount: 2,
        rejectionCode: null,
        paymentId: '44444444-4444-4444-8444-444444444444',
        exhaustedAt: null,
        settledAt: new Date('2026-01-02T00:00:00.000Z'),
        lastAttemptAt: new Date('2026-01-02T00:00:00.000Z'),
        notifyStatus: 'skipped_unwired' as const,
        notifyCode: 'pay.subscription_notify_unwired',
      },
    ]);
    const app = await mountTrpc({ getSubscription: async () => subRecord(), listCycles });

    const { statusCode, body } = await get(app, 'subscription.cycles', { subscriptionId: SUB, limit: 50 });

    expect(statusCode).toBe(200);
    expect(listCycles).toHaveBeenCalledWith(SUB, { limit: 50 });
    const cycles = body.result?.data?.cycles as Array<Record<string, unknown>> | undefined;
    expect(cycles).toBeDefined();
    expect(cycles).toHaveLength(1);
    const cycle = cycles![0]!;
    // A decimal string, not a scaled bigint rendered as digits.
    expect(cycle.amount).toBe('10');
    expect(cycle.idempotencyKey).toBe(`pay.subscription:${SUB}:0`);
    expect(cycle.attemptCount).toBe(2);
    await app.close();
  });

  // ── The mount boundary still holds on the new procedures ──────────────────

  it('refuses an anonymous caller, and the service never runs', async () => {
    const pauseSubscription = vi.fn();
    const app = await mountTrpc({ getSubscription: async () => subRecord(), pauseSubscription });

    const { statusCode } = await post(app, 'subscription.pause', { subscriptionId: SUB }, { 'x-intafaced-region': 'DE' });

    expect(statusCode).toBe(401);
    expect(pauseSubscription).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * The forgery: a principal the CALLER asserted, with no edge signature. A
   * hand-rolled `JSON.parse` context would have believed it, and a forgeable
   * principal on this surface is a forgeable merchant.
   */
  it('refuses a forged principal on a cycle mutation', async () => {
    const resumeSubscription = vi.fn();
    const app = await mountTrpc({ getSubscription: async () => subRecord({ status: 'paused' }), resumeSubscription });
    const raw = encodePrincipal(principal());

    const { statusCode } = await post(
      app,
      'subscription.resume',
      { subscriptionId: SUB },
      { 'x-intafaced-principal': raw, 'x-intafaced-region': 'DE' },
    );

    expect(statusCode).toBe(401);
    expect(resumeSubscription).not.toHaveBeenCalled();
    await app.close();
  });

  it('a stranger cannot pause another merchant’s subscription', async () => {
    const pauseSubscription = vi.fn();
    const app = await mountTrpc({ getSubscription: async () => subRecord(), pauseSubscription });

    const { statusCode } = await post(
      app,
      'subscription.pause',
      { subscriptionId: SUB },
      signedHeaders(principal({ sub: STRANGER, userId: STRANGER })),
    );

    expect(statusCode).toBe(404);
    expect(pauseSubscription).not.toHaveBeenCalled();
    await app.close();
  });

  it('a read scope cannot pause — a mutation needs pay:write', async () => {
    const pauseSubscription = vi.fn();
    const app = await mountTrpc({ getSubscription: async () => subRecord(), pauseSubscription });

    const { statusCode } = await post(
      app,
      'subscription.pause',
      { subscriptionId: SUB },
      signedHeaders(principal({ scopes: ['pay:read'] })),
    );

    expect(statusCode).toBe(403);
    expect(pauseSubscription).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── The runner's own route ──────────────────────────────────────────────────

describe('the cycle runner route is mounted and reachable', () => {
  async function mountRunner(subs: { runDueSubscriptions?: unknown; listCycles?: unknown }) {
    const app = Fastify({ logger: false });
    registerSubscriptionCycleRoutes(app, {
      internalSecret: INTERNAL_SECRET,
      subscriptions: subs as never,
    });
    await app.ready();
    return app;
  }

  function serviceHeaders(body: string = ''): Record<string, string> {
    return {
      ...(body === '' ? {} : { 'content-type': 'application/json' }),
      ...serviceAuthHeadersForBody('svc-cron', INTERNAL_SECRET, body),
    };
  }

  it('runs a pass for a caller with service credentials', async () => {
    const runDueSubscriptions = vi.fn(async () => ({ examined: 1, fired: 1, retried: 0, stalled: 0, outcomes: [] }));
    const app = await mountRunner({ runDueSubscriptions });

    const payload = JSON.stringify({ limit: 50 });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/run-due-subscriptions',
      headers: serviceHeaders(payload),
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().fired).toBe(1);
    expect(runDueSubscriptions).toHaveBeenCalledWith({ limit: 50 });
    await app.close();
  });

  it('REFUSES omit — never invents a 50-row due pass; owner may pass 50', async () => {
    const runDueSubscriptions = vi.fn();
    const app = await mountRunner({ runDueSubscriptions });

    const payload = JSON.stringify({});
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/run-due-subscriptions',
      headers: serviceHeaders(payload),
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('pay.due_subscriptions_batch_limit_unset');
    expect(runDueSubscriptions).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * An unauthenticated due pass fans invoices out to every customer of every
   * merchant on the platform. It must not be reachable by finding the port.
   */
  it('401 without service credentials, and no pass runs', async () => {
    const runDueSubscriptions = vi.fn();
    const app = await mountRunner({ runDueSubscriptions });

    const res = await app.inject({ method: 'POST', url: '/internal/jobs/run-due-subscriptions', payload: {} });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('pay.unauthenticated');
    expect(runDueSubscriptions).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * Fail-first mill: POST /internal/jobs/run-due-subscriptions is a mutate.
   * Compose INTERNAL_SERVICE_BODY_BIND stays accept-both; this door must not.
   * v1 HMAC (no body digest) is legal under accept-both and must 401 here.
   */
  it('401 for v1 HMAC without body digest on the due pass — even when bodyBind is accept-both', async () => {
    const runDueSubscriptions = vi.fn();
    const app = Fastify({ logger: false });
    registerSubscriptionCycleRoutes(app, {
      internalSecret: INTERNAL_SECRET,
      subscriptions: { runDueSubscriptions } as never,
      bodyBind: 'accept-both',
    });
    await app.ready();

    const payload = JSON.stringify({ limit: 50 });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/run-due-subscriptions',
      headers: { 'content-type': 'application/json', ...serviceAuthHeaders('svc-cron', INTERNAL_SECRET) },
      payload,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('pay.unauthenticated');
    expect(runDueSubscriptions).not.toHaveBeenCalled();
    await app.close();
  });

  it('401 when v2 HMAC is bound to a different body than the due-pass payload', async () => {
    const runDueSubscriptions = vi.fn();
    const app = await mountRunner({ runDueSubscriptions });
    const payload = JSON.stringify({ limit: 50 });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/run-due-subscriptions',
      headers: serviceHeaders(JSON.stringify({ limit: 99 })),
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(runDueSubscriptions).not.toHaveBeenCalled();
    await app.close();
  });

  it('journal GET still accepts v1 HMAC under accept-both — GET stays env', async () => {
    const listCycles = vi.fn(async () => []);
    const app = Fastify({ logger: false });
    registerSubscriptionCycleRoutes(app, {
      internalSecret: INTERNAL_SECRET,
      subscriptions: { listCycles } as never,
      bodyBind: 'accept-both',
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/internal/subscriptions/${SUB}/cycles?limit=50`,
      headers: serviceAuthHeaders('svc-cron', INTERNAL_SECRET),
    });

    expect(res.statusCode).toBe(200);
    expect(listCycles).toHaveBeenCalledWith(SUB, { limit: 50 });
    await app.close();
  });

  /**
   * THE CLOCK IS NOT AN INPUT.
   *
   * A caller-supplied `now` on a charge cycle is a caller-supplied answer to
   * "which period is due" — i.e. a way to charge next year's twelve periods
   * today. The route accepts a `limit` and nothing else, and this asserts the
   * body cannot reach the engine's clock: the pass runs with no `now` at all.
   */
  it('ignores a caller-supplied clock — the body cannot name the period', async () => {
    const runDueSubscriptions = vi.fn(async () => ({ examined: 0, fired: 0, retried: 0, stalled: 0, outcomes: [] }));
    const app = await mountRunner({ runDueSubscriptions });

    const payload = JSON.stringify({ now: '2099-01-01T00:00:00.000Z', limit: 5 });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/run-due-subscriptions',
      headers: serviceHeaders(payload),
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(runDueSubscriptions).toHaveBeenCalledWith({ limit: 5 });
    const firstCall = runDueSubscriptions.mock.calls[0] as [Record<string, unknown>] | undefined;
    expect(firstCall).toBeDefined();
    expect(firstCall![0]).not.toHaveProperty('now');
    await app.close();
  });

  it('refuses a nonsense limit rather than clamping it', async () => {
    const runDueSubscriptions = vi.fn();
    const app = await mountRunner({ runDueSubscriptions });

    for (const limit of [0, -1, 1.5, 10_000]) {
      const payload = JSON.stringify({ limit });
      const res = await app.inject({
        method: 'POST',
        url: '/internal/jobs/run-due-subscriptions',
        headers: serviceHeaders(payload),
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('pay.validation_failed');
    }
    expect(runDueSubscriptions).not.toHaveBeenCalled();
    await app.close();
  });

  it('serves the period journal to an operator, with keys and attempt counts', async () => {
    const listCycles = vi.fn(async () => [
      {
        occurrence: 3,
        amount: amt('10'),
        status: 'rejected' as const,
        idempotencyKey: `pay.subscription:${SUB}:3`,
        attemptCount: 3,
        rejectionCode: 'pay.rail_failed',
        paymentId: null,
        exhaustedAt: new Date('2026-04-20T00:00:00.000Z'),
        settledAt: null,
        lastAttemptAt: new Date('2026-04-20T00:00:00.000Z'),
        notifyStatus: null,
        notifyCode: null,
      },
    ]);
    const app = await mountRunner({ listCycles });

    const res = await app.inject({
      method: 'GET',
      url: `/internal/subscriptions/${SUB}/cycles?limit=50`,
      headers: serviceHeaders(),
    });

    expect(res.statusCode).toBe(200);
    expect(listCycles).toHaveBeenCalledWith(SUB, { limit: 50 });
    const cycles = (res.json() as { cycles?: Array<Record<string, unknown>> }).cycles;
    expect(cycles).toBeDefined();
    expect(cycles).toHaveLength(1);
    const cycle = cycles![0]!;
    expect(cycle.amount).toBe('10');
    expect(cycle.idempotencyKey).toBe(`pay.subscription:${SUB}:3`);
    expect(cycle.exhausted).toBe(true);
    await app.close();
  });

  it('the period journal refuses an unset page size — never dumps every row', async () => {
    const listCycles = vi.fn(async () => []);
    const app = await mountRunner({ listCycles });

    const res = await app.inject({
      method: 'GET',
      url: `/internal/subscriptions/${SUB}/cycles`,
      headers: serviceHeaders(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('pay.subscription_cycle_list_limit_unset');
    expect(listCycles).not.toHaveBeenCalled();
    await app.close();
  });

  it('401 on the journal without service credentials', async () => {
    const listCycles = vi.fn();
    const app = await mountRunner({ listCycles });
    const res = await app.inject({ method: 'GET', url: `/internal/subscriptions/${SUB}/cycles` });
    expect(res.statusCode).toBe(401);
    expect(listCycles).not.toHaveBeenCalled();
    await app.close();
  });

  it('404s an unknown subscription rather than inventing an empty journal', async () => {
    const listCycles = vi.fn(async () => {
      throw new PayError('nope', 'pay.subscription_not_found');
    });
    const app = await mountRunner({ listCycles });

    const res = await app.inject({
      method: 'GET',
      url: `/internal/subscriptions/${SUB}/cycles?limit=50`,
      headers: serviceHeaders(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('pay.subscription_not_found');
    await app.close();
  });
});

// ── The mount itself ───────────────────────────────────────────────────────

describe('index.ts mounts the runner rather than keeping its own copy', () => {
  /**
   * The reason this file can prove reachability at all is that the handler moved
   * out of `index.ts`. If a second copy grew back inline, this suite would keep
   * passing while the deployed route diverged — which is the "correct in
   * isolation, unreachable in place" failure with the sides swapped.
   */
  it('registers the shared registrar and defines no second handler', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const index = readFileSync(join(here, '..', 'index.ts'), 'utf8');

    expect(index).toMatch(/registerSubscriptionCycleRoutes\(app,/);
    expect(index).toMatch(/retainRawBody\(app\)/);
    expect(index).toMatch(/INTERNAL_SERVICE_BODY_BIND/);
    // No inline `app.post('/internal/jobs/run-due-subscriptions'` anywhere.
    expect(index).not.toMatch(/app\.(post|get)[^\n]*run-due-subscriptions/);
  });

  it('due-pass mutate hardcodes HMAC require; journal GET and merchant-watch GET stay env', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const routes = readFileSync(join(here, 'internal-cycle-routes.ts'), 'utf8');
    const merchant = readFileSync(join(here, '..', 'agents', 'merchant-watch-metrics-routes.ts'), 'utf8');
    const index = readFileSync(join(here, '..', 'index.ts'), 'utf8');

    const postAt = routes.indexOf("app.post<{ Body: { limit?: number } }>('/internal/jobs/run-due-subscriptions'");
    const getAt = routes.indexOf(
      "app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/internal/subscriptions/:id/cycles'",
    );
    expect(postAt).toBeGreaterThan(-1);
    expect(getAt).toBeGreaterThan(postAt);
    const postSlice = routes.slice(postAt, getAt);
    const getSlice = routes.slice(getAt);
    expect(postSlice).toMatch(/bodyBindMode:\s*'require'/);
    expect(postSlice).not.toMatch(/INTERNAL_SERVICE_BODY_BIND/);
    expect(getSlice).toMatch(/bodyBindMode:\s*journalMode/);
    expect(routes).toMatch(/const journalMode = deps\.bodyBind \?\? DEFAULT_SERVICE_BODY_BIND_MODE/);

    expect(merchant).toMatch(/const mode = deps\.bodyBind \?\? DEFAULT_SERVICE_BODY_BIND_MODE/);
    expect(merchant).not.toMatch(/bodyBindMode:\s*'require'/);
    expect(index).toMatch(/registerMerchantWatchMetricsRoutes\(app, \{[\s\S]*?bodyBind: env\.INTERNAL_SERVICE_BODY_BIND/);
  });
});
