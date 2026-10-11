import Fastify, { type FastifyInstance } from 'fastify';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryMerchantWebhookStore, MerchantWebhookService } from './merchant-webhooks.js';
import { PayError, assertPaymentLinkListLimit, assertPaymentListLimit, type PayService } from './payment-service.js';
import { registerPublicPayRest } from './public-rest.js';
import { MemoryRestIdempotencyStore } from './rest-idempotency.js';

/**
 * THE MERCHANT SURFACE — reads (step 1) and mutations (step 2).
 *
 * Law: docs/adr/2026-08-07-pay-public-api-law.md.
 *
 * Step 1 weighted the one catastrophic read question: can a merchant id in a
 * query string reach somebody else's payments.
 *
 * Step 2 adds the money-path questions: Idempotency-Key required, same-key
 * replay, different-body conflict, ownership before the rail runs, decimal
 * strings on write, and refund needing its own scope.
 */

const SECRET = 'a-pay-public-rest-edge-secret-long-enough-x';
const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const MERCHANT = '33333333-3333-4333-8333-333333333333';
const PAYMENT = '44444444-4444-4444-8444-444444444444';
const LINK = '66666666-6666-4666-8666-666666666666';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: OWNER,
    userId: OWNER,
    sid: '55555555-5555-4555-8555-555555555555',
    scopes: ['pay:read', 'pay:write', 'pay:refund'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

function signed(p: Principal = principal()): Record<string, string> {
  const raw = encodePrincipal(p);
  return {
    'x-intafaced-principal': raw,
    'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

const paymentRow = {
  id: PAYMENT,
  merchantId: MERCHANT,
  profileId: null,
  amount: parseAmount('1.10'),
  assetId: 'USD',
  method: 'card',
  railAdapter: 'card-sandbox',
  railRef: 'ref-1',
  status: 'captured' as const,
  capturedAmount: parseAmount('1.10'),
  refundedAmount: parseAmount('0'),
  createdAt: new Date('2026-08-07T10:00:00.000Z'),
};

type Call = { method: string; args: unknown[] };

/** Only the methods this surface touches. Everything else would be unused weight. */
function stubPay(over: Partial<Record<string, unknown>> = {}): PayService & { calls: Call[] } {
  const calls: Call[] = [];
  const record =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R | Promise<R>) =>
    async (...args: A): Promise<R> => {
      calls.push({ method: name, args });
      return fn(...args);
    };

  return {
    calls,
    getMerchant: record('getMerchant', async (id: string) => {
      if (id !== MERCHANT) throw new PayError(`merchant ${id} not found`, 'pay.merchant_not_found');
      return { id: MERCHANT, userId: OWNER } as never;
    }),
    getPayment: record('getPayment', async (id: string) => {
      if (id !== PAYMENT) throw new PayError(`payment ${id} not found`, 'pay.payment_not_found');
      return paymentRow as never;
    }),
    listPayments: record('listPayments', async () => [paymentRow] as never),
    clearingBalance: record('clearingBalance', async () => parseAmount('2.5')),
    merchantBalance: record('merchantBalance', async () => parseAmount('7.25')),
    createPayment: record('createPayment', async (input: { railAdapter?: string }) => ({
      ...paymentRow,
      status: 'created' as const,
      capturedAmount: parseAmount('0'),
      railRef: null,
      // Echo the rail REST resolved — mode honesty is derived from this field.
      railAdapter: input.railAdapter ?? paymentRow.railAdapter,
    })),
    authorize: record('authorize', async () => ({
      ...paymentRow,
      status: 'authorized' as const,
      capturedAmount: parseAmount('0'),
    })),
    capture: record('capture', async () => paymentRow),
    refund: record('refund', async () => ({
      ...paymentRow,
      status: 'refunded' as const,
      refundedAmount: parseAmount('1.10'),
    })),
    createPaymentLink: record('createPaymentLink', async (input: { label: string; maxUses?: number }) => ({
      id: LINK,
      token: 'pl_testtokenvalue',
      prefix: 'pl_testtoke',
      label: input.label,
      expiresAt: new Date('2026-09-07T10:00:00.000Z'),
      maxUses: input.maxUses ?? null,
    })),
    listPaymentLinks: record('listPaymentLinks', async () => [
      {
        id: LINK,
        prefix: 'pl_testtoke',
        label: 'Invoice',
        amount: '10',
        currency: 'USDT',
        active: true,
        expiresAt: '2026-09-07T10:00:00.000Z',
        maxUses: 1,
        uses: 0,
        createdAt: '2026-08-07T10:00:00.000Z',
      },
    ]),
    deactivatePaymentLink: record('deactivatePaymentLink', async () => ({ deactivated: true })),
    ...over,
  } as unknown as PayService & { calls: Call[] };
}

async function build(
  pay: PayService = stubPay(),
  idempotency = new MemoryRestIdempotencyStore(),
  webhooks?: MerchantWebhookService,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerPublicPayRest(app, {
    edgeSecret: SECRET,
    serviceName: 'svc-pay',
    pay,
    idempotency,
    webhooks: webhooks ?? new MerchantWebhookService(new MemoryMerchantWebhookStore()),
  });
  await app.ready();
  return app;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('ownership — the only thing standing between a query string and another merchant', () => {
  it('REFUSES a payment belonging to a merchant the caller does not own', async () => {
    app = await build();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payments/${PAYMENT}`,
      headers: signed(principal({ sub: STRANGER, userId: STRANGER })),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('pay.merchant_forbidden');
    expect(res.body).not.toContain(MERCHANT);
    expect(res.body).not.toContain('1.10');
  });

  it('REFUSES a list for a merchant the caller does not own', async () => {
    app = await build();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payments?merchantId=${MERCHANT}`,
      headers: signed(principal({ sub: STRANGER, userId: STRANGER })),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('pay.merchant_forbidden');
  });

  it('REFUSES a balance for a merchant the caller does not own', async () => {
    app = await build();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/balances?merchantId=${MERCHANT}&assetId=USD`,
      headers: signed(principal({ sub: STRANGER, userId: STRANGER })),
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('7.25');
  });

  it('serves the owner', async () => {
    app = await build();

    const res = await app.inject({ method: 'GET', url: `/v1/payments/${PAYMENT}`, headers: signed() });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: PAYMENT, merchantId: MERCHANT, status: 'captured' });
  });
});

describe('the mount boundary', () => {
  it('treats a SELF-ASSERTED principal as anonymous', async () => {
    app = await build();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payments/${PAYMENT}`,
      headers: { 'x-intafaced-principal': encodePrincipal(principal()) },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('pay.unauthorized');
  });

  it('refuses a principal signed with the WRONG secret', async () => {
    app = await build();
    const raw = encodePrincipal(principal());

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payments/${PAYMENT}`,
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, 'a-different-secret-of-sufficient-length', 'DE'),
        'x-intafaced-region': 'DE',
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('refuses a principal that carries no pay:read scope', async () => {
    app = await build();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payments/${PAYMENT}`,
      headers: signed(principal({ scopes: ['trade:read'] })),
    });

    expect(res.statusCode).toBe(401);
  });

  it('refuses an unauthenticated request outright', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: `/v1/payments/${PAYMENT}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('money on the wire (ADR §2.3)', () => {
  it('sends amounts as DECIMAL STRINGS, never numbers and never minor units', async () => {
    app = await build();

    const res = await app.inject({ method: 'GET', url: `/v1/payments/${PAYMENT}`, headers: signed() });
    const body = res.json();

    expect(body.amount).toBe('1.1');
    expect(typeof body.amount).toBe('string');
    expect(body.amount).not.toBe(110);
    expect(body.amount).not.toBe(1.1);
  });

  it('sends balances as decimal strings too', async () => {
    app = await build();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/balances?merchantId=${MERCHANT}&assetId=USD`,
      headers: signed(),
    });

    expect(res.json()).toEqual({ merchantId: MERCHANT, assetId: 'USD', clearing: '2.5', available: '7.25' });
  });
});

describe('refusals keep the pay.* vocabulary (ADR §2.6)', () => {
  it('answers a missing payment 404 with its code', async () => {
    app = await build();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/payments/66666666-6666-4666-8666-666666666666',
      headers: signed(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('pay.payment_not_found');
  });

  it('rejects a malformed uuid before it reaches the service', async () => {
    app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/payments?merchantId=not-a-uuid',
      headers: signed(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the spec is served, and describes what the routes actually do', () => {
  it('publishes an OpenAPI document naming the routes and the bearer scheme', async () => {
    app = await build();

    const spec = app.swagger() as {
      paths: Record<string, unknown>;
      servers?: Array<{ url: string }>;
      components?: { securitySchemes?: Record<string, unknown> };
    };

    // Paths are relative to servers[url]=/api/pay/v1 (transform strips service BASE).
    // Full merchant URL = server + path = /api/pay/v1/payments — never /api/pay/v1/v1/….
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/payments/{id}',
        '/payments',
        '/balances',
        '/payments/{id}/authorize',
        '/payments/{id}/capture',
        '/payments/{id}/refund',
        '/payment-links',
        '/payment-links/{id}',
      ]),
    );
    expect(Object.keys(spec.paths).some((p) => p.startsWith('/v1/'))).toBe(false);
    expect(spec.components?.securitySchemes).toHaveProperty('apiKey');
    // External path merchants call — edge prefix intact. Service mount is /v1.
    expect(spec.servers?.map((s) => s.url)).toContain('/api/pay/v1');
  });

  /**
   * THE CONTRACT AND THE ROUTER, COMPARED IN BOTH DIRECTIONS.
   *
   * The test above uses `arrayContaining`, which catches a route that vanished
   * from the spec and nothing else. Two failures pass it:
   *
   *   · the spec DESCRIBES a route that is not mounted — a generated client
   *     compiles and 404s at runtime;
   *   · the spec OMITS a route that IS mounted — an undocumented public write
   *     path on a payment API, which is how a surface grows in the dark.
   *
   * A machine-readable contract that lies is worse than none, so this compares
   * the two SETS rather than checking membership one way. Derived from Fastify's
   * own `onRoute` hook, not from a hand-kept list that would drift with it.
   */
  it('describes every mounted route and no route that is not mounted', async () => {
    const mounted = new Set<string>();
    const built = Fastify({ logger: false });
    built.addHook('onRoute', (route) => {
      // HEAD is generated for every GET; the spec does not document it.
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      if (methods.every((m) => m === 'HEAD')) return;
      // `{ hide: true }` is the spec's own opt-out — openapi.json describing
      // itself is noise, and it is the one route legitimately absent below.
      if ((route.schema as { hide?: boolean } | undefined)?.hide) return;
      // Service mount (/v1/…) to advertised path (servers[0] = /api/pay/v1).
      const path = route.url.startsWith('/v1') ? route.url.slice('/v1'.length) || '/' : route.url;
      mounted.add(path.replace(/:([A-Za-z0-9_]+)/g, '{$1}'));
    });
    await registerPublicPayRest(built, {
      edgeSecret: SECRET,
      serviceName: 'svc-pay',
      pay: stubPay(),
      idempotency: new MemoryRestIdempotencyStore(),
      // Webhook routes are conditional on this dep, so it must be present or the
      // comparison would quietly be over the smaller surface.
      webhooks: new MerchantWebhookService(new MemoryMerchantWebhookStore()),
    });
    await built.ready();
    const described = new Set(Object.keys((built.swagger() as { paths: Record<string, unknown> }).paths));
    await built.close();

    // Non-vacuity: two empty sets are equal, and would make this test a comment.
    //
    // TWELVE PATHS — OpenAPI keys by path; GET+POST share `/payments`,
    // `/webhook-endpoints`, and `/payment-links`.
    //   payments: /payments, /payments/{id}, …/authorize, …/capture, …/refund
    //   payment-links: /payment-links, /payment-links/{id}
    //   balances: /balances
    //   webhooks: /webhook-endpoints, /webhook-endpoints/{id},
    //             /webhook-endpoints/{id}/enable, /webhook-deliveries
    expect(mounted.size).toBe(12);
    expect([...described].sort()).toEqual([...mounted].sort());
  });

  it('serves the spec over HTTP, without shipping a static file server', async () => {
    app = await build();

    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });

    expect(res.statusCode).toBe(200);
    expect(res.json().info.title).toBe('Payments API');
  });

  /**
   * The test above is named 'without shipping a static file server' and, until
   * this one existed, asserted only that the spec returns 200. The absent half
   * of its own title was unchecked — which is how `@fastify/swagger-ui` could be
   * re-added, pull `@fastify/static` back in, and leave every test green.
   *
   * `@fastify/swagger-ui` was refused because `@fastify/static` carried two
   * authorization-bypass advisories (GHSA-83w8-p2f5-377r high, route guard
   * bypass via path traversal; GHSA-8pvw-jcv7-9cmj medium, non-canonical URL
   * paths) with no patched version reachable from the pinned line — on a PUBLIC
   * payment surface. The spec is the deliverable; a browsable console is not.
   *
   * Asserted by route, not by dependency, deliberately: a lockfile check would
   * pass the day someone vendored the UI or mounted it from another package.
   */
  it('mounts no browsable API console — the refusal is asserted, not just commented', async () => {
    app = await build();

    // Every path @fastify/swagger-ui serves by default or by common config.
    // Include both the service mount (/v1) and the external edge path so a
    // future mount-prefix mistake cannot reintroduce a console on either.
    const consoleRoutes = [
      '/documentation',
      '/documentation/',
      '/documentation/index.html',
      '/documentation/static/index.html',
      '/v1/documentation',
      '/v1/docs',
      '/api/pay/v1/documentation',
      '/api/pay/v1/docs',
      '/docs',
      '/swagger',
    ];

    for (const url of consoleRoutes) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, `${url} must not serve a console`).toBe(404);
    }
  });

  it('OpenAPI description matches sandbox-key + quickstart behaviour (step 5)', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
    const desc = String(res.json().info.description ?? '');
    expect(desc).toContain('MERCHANT-PUBLIC-API-QUICKSTART');
    expect(desc).toMatch(/sandbox/i);
    expect(desc).toContain('ifc_test_');
    expect(desc).toContain('pay.sandbox_rail_refused');
    expect(desc).toContain('mode: "sandbox" | "live"');
    expect(desc).toContain('Idempotency-Key');
    expect(desc).toMatch(/decimal string/i);
  });
});

describe('step 2 — mutating paths + Idempotency-Key (ADR §2.2)', () => {
  const createBody = {
    merchantId: MERCHANT,
    amount: '1.10',
    assetId: 'USD',
    method: 'card',
    railAdapter: 'card-sandbox',
  };

  /** Step-2 fixtures use a sandbox key so createPayment may name card-sandbox. */
  function sandboxSigned(p: Principal = principal({ key_env: 'sandbox', kid: 'key-sandbox' })): Record<string, string> {
    return signed(p);
  }

  it('REFUSES a mutating POST with no Idempotency-Key — NOTHING WAS ATTEMPTED', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...sandboxSigned(), 'content-type': 'application/json' },
      payload: createBody,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('pay.idempotency_required');
    expect(pay.calls.filter((c) => c.method === 'createPayment')).toHaveLength(0);
  });

  it('creates through the same PayService method, returns decimal strings', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...sandboxSigned(), 'content-type': 'application/json', 'idempotency-key': 'create:order:42' },
      payload: createBody,
    });

    expect(res.statusCode).toBe(200);
    expect(typeof res.json().amount).toBe('string');
    expect(res.json().amount).toBe('1.1');
    expect(pay.calls.some((c) => c.method === 'createPayment')).toBe(true);
    const args = pay.calls.find((c) => c.method === 'createPayment')!.args[0] as { amount: bigint };
    // parseAmount('1.10') — scaled bigint, never a number on the wire.
    expect(typeof args.amount).toBe('bigint');
  });

  it('REPLAYS an identical retry and does not call createPayment twice', async () => {
    const pay = stubPay();
    app = await build(pay);
    const headers = { ...sandboxSigned(), 'content-type': 'application/json', 'idempotency-key': 'create:order:99' };

    const first = await app.inject({ method: 'POST', url: '/v1/payments', headers, payload: createBody });
    const second = await app.inject({ method: 'POST', url: '/v1/payments', headers, payload: createBody });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(pay.calls.filter((c) => c.method === 'createPayment')).toHaveLength(1);
  });

  it('CONFLICTS when the same key is reused with a DIFFERENT body', async () => {
    const pay = stubPay();
    app = await build(pay);
    const headers = { ...sandboxSigned(), 'content-type': 'application/json', 'idempotency-key': 'create:order:conflict' };

    await app.inject({ method: 'POST', url: '/v1/payments', headers, payload: createBody });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers,
      payload: { ...createBody, amount: '2.00' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('pay.idempotency_conflict');
    expect(pay.calls.filter((c) => c.method === 'createPayment')).toHaveLength(1);
  });

  it('REFUSES create/capture/authorize on another merchant BEFORE the service mutates', async () => {
    const pay = stubPay();
    app = await build(pay);
    const stranger = signed(principal({ sub: STRANGER, userId: STRANGER, key_env: 'sandbox' }));

    const create = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...stranger, 'content-type': 'application/json', 'idempotency-key': 'stranger:create' },
      payload: createBody,
    });
    expect(create.statusCode).toBe(403);
    expect(pay.calls.filter((c) => c.method === 'createPayment')).toHaveLength(0);

    const capture = await app.inject({
      method: 'POST',
      url: `/v1/payments/${PAYMENT}/capture`,
      headers: { ...stranger, 'content-type': 'application/json', 'idempotency-key': 'stranger:capture' },
      payload: {},
    });
    expect(capture.statusCode).toBe(403);
    expect(pay.calls.filter((c) => c.method === 'capture')).toHaveLength(0);
  });

  it('authorizes, forwards capture amount to the service, and refunds with the matching scopes', async () => {
    const pay = stubPay();
    app = await build(pay);

    const auth = await app.inject({
      method: 'POST',
      url: `/v1/payments/${PAYMENT}/authorize`,
      headers: { ...signed(), 'content-type': 'application/json', 'idempotency-key': 'auth:1' },
      payload: {},
    });
    expect(auth.statusCode).toBe(200);
    expect(auth.json().status).toBe('authorized');

    // Wire shape only: REST forwards optional amount. Real PayService refuses
    // partial capture (`pay.partial_capture_unsupported`) — money suite / service
    // tests pin that; stub must not be read as product support for partials.
    const capture = await app.inject({
      method: 'POST',
      url: `/v1/payments/${PAYMENT}/capture`,
      headers: { ...signed(), 'content-type': 'application/json', 'idempotency-key': 'cap:1' },
      payload: { amount: '0.50' },
    });
    expect(capture.statusCode).toBe(200);
    const capArgs = pay.calls.find((c) => c.method === 'capture')!.args;
    expect(capArgs[1]).toMatchObject({
      amount: parseAmount('0.50'),
      identityAuthority: { kind: 'credential', subject: { userId: '11111111-1111-4111-8111-111111111111' } },
    });

    const refund = await app.inject({
      method: 'POST',
      url: `/v1/payments/${PAYMENT}/refund`,
      headers: { ...signed(), 'content-type': 'application/json', 'idempotency-key': 'ref:1' },
      payload: { amount: '0.50', refundId: 'refund:order:1' },
    });
    expect(refund.statusCode).toBe(200);
    expect(refund.json().status).toBe('refunded');
  });

  it('omitted body refundId becomes rest:<paymentId>:<digest> — never an ordinal', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/payments/${PAYMENT}/refund`,
      headers: { ...signed(), 'content-type': 'application/json', 'idempotency-key': 'ref:derived-key' },
      payload: { amount: '0.50' },
    });
    expect(res.statusCode).toBe(200);
    const args = pay.calls.find((c) => c.method === 'refund')!.args;
    const opts = args[2] as { refundId?: string };
    expect(opts.refundId).toMatch(new RegExp(`^rest:${PAYMENT}:[0-9a-f]{24}$`));
  });

  it('empty / whitespace body refundId falls through to restRefundId (not payment.refund:)', async () => {
    const pay = stubPay();
    app = await build(pay);

    for (const refundId of ['', '   ']) {
      pay.calls.length = 0;
      const res = await app.inject({
        method: 'POST',
        url: `/v1/payments/${PAYMENT}/refund`,
        headers: {
          ...signed(),
          'content-type': 'application/json',
          'idempotency-key': `ref:empty:${refundId.length}`,
        },
        payload: { amount: '0.50', refundId },
      });
      expect(res.statusCode).toBe(200);
      const opts = pay.calls.find((c) => c.method === 'refund')!.args[2] as { refundId?: string };
      expect(opts.refundId).toMatch(new RegExp(`^rest:${PAYMENT}:[0-9a-f]{24}$`));
    }
  });

  it('does not let a writer refund — pay:refund is its own authority', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/payments/${PAYMENT}/refund`,
      headers: {
        ...signed(principal({ scopes: ['pay:write'] })),
        'content-type': 'application/json',
        'idempotency-key': 'ref:forbidden',
      },
      payload: { amount: '0.50' },
    });

    expect(res.statusCode).toBe(401);
    expect(pay.calls.filter((c) => c.method === 'refund')).toHaveLength(0);
  });

  it('rejects a JSON-number amount on create — decimal strings only', async () => {
    app = await build();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...signed(), 'content-type': 'application/json', 'idempotency-key': 'num:1' },
      payload: { ...createBody, amount: 1.1 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('pay.invalid_amount');
  });
});

describe('webhooks step 3 — register + ownership + dashboard', () => {
  it('registers an endpoint and returns the signing secret once', async () => {
    app = await build();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhook-endpoints',
      headers: { ...signed(), 'content-type': 'application/json' },
      payload: { merchantId: MERCHANT, url: 'https://merchant.example/hooks/pay' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { secret: string; status: string; url: string };
    expect(body.status).toBe('active');
    expect(body.url).toBe('https://merchant.example/hooks/pay');
    expect(body.secret).toHaveLength(64);
  });

  it('REFUSES webhook registration for a merchant the caller does not own', async () => {
    app = await build();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhook-endpoints',
      headers: {
        ...signed(principal({ sub: STRANGER, userId: STRANGER })),
        'content-type': 'application/json',
      },
      payload: { merchantId: MERCHANT, url: 'https://evil.example/x' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('pay.merchant_forbidden');
  });

  it('lists deliveries for the failure dashboard under pay:read', async () => {
    app = await build();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/webhook-deliveries?merchantId=${MERCHANT}&status=failed&limit=50`,
      headers: signed(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('REFUSES webhook-deliveries when limit is omitted — never invents 50', async () => {
    app = await build();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/webhook-deliveries?merchantId=${MERCHANT}&status=failed`,
      headers: signed(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('pay.webhook_delivery_list_limit_unset');
  });

  it('REFUSES webhook-endpoints when limit is omitted — never invents 50', async () => {
    app = await build();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/webhook-endpoints?merchantId=${MERCHANT}`,
      headers: signed(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('pay.webhook_endpoint_list_limit_unset');
  });

  it('re-enables a disabled endpoint and resets the failure counter', async () => {
    const store = new MemoryMerchantWebhookStore();
    const webhooks = new MerchantWebhookService(store);
    app = await build(stubPay(), new MemoryRestIdempotencyStore(), webhooks);

    const created = await webhooks.registerEndpoint(MERCHANT, 'https://merchant.example/hooks/pay');
    await webhooks.disableEndpoint(MERCHANT, created.id, 'consecutive_failures');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/webhook-endpoints/${created.id}/enable?merchantId=${MERCHANT}`,
      headers: signed(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; consecutiveFailures: number; disabledReason: string | null };
    expect(body.status).toBe('active');
    expect(body.consecutiveFailures).toBe(0);
    expect(body.disabledReason).toBeNull();
  });
});

describe('step 4 — sandbox keys route to sandbox rail (ADR §2.5)', () => {
  const createBody = {
    merchantId: MERCHANT,
    amount: '1.00',
    assetId: 'USD',
    method: 'card',
    railAdapter: 'crypto-native',
  };

  it('sandbox principal forces card-sandbox even when body names a live rail', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: {
        ...signed(principal({ key_env: 'sandbox', kid: 'k-sandbox' })),
        'content-type': 'application/json',
        'idempotency-key': 'sandbox:force',
      },
      payload: createBody,
    });

    expect(res.statusCode).toBe(200);
    const args = pay.calls.find((c) => c.method === 'createPayment')!.args[0] as { railAdapter: string };
    expect(args.railAdapter).toBe('card-sandbox');
    expect(res.json().mode).toBe('sandbox');
  });

  it('GET payment discloses mode from rail posture (sandbox honesty)', async () => {
    app = await build();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/payments/${PAYMENT}`,
      headers: signed(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe('sandbox');
    expect(res.json().railAdapter).toBe('card-sandbox');
  });

  it('live principal naming card-sandbox is refused — NOTHING WAS ATTEMPTED', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: {
        ...signed(principal({ key_env: 'live', kid: 'k-live' })),
        'content-type': 'application/json',
        'idempotency-key': 'live:sandbox-refuse',
      },
      payload: { ...createBody, railAdapter: 'card-sandbox' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('pay.sandbox_rail_refused');
    expect(pay.calls.filter((c) => c.method === 'createPayment')).toHaveLength(0);
  });

  it('live principal may name a non-sandbox rail', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: {
        ...signed(principal({ key_env: 'live', kid: 'k-live-2' })),
        'content-type': 'application/json',
        'idempotency-key': 'live:ok',
      },
      payload: createBody,
    });

    expect(res.statusCode).toBe(200);
    const args = pay.calls.find((c) => c.method === 'createPayment')!.args[0] as { railAdapter: string };
    expect(args.railAdapter).toBe('crypto-native');
  });

  it('sandbox GET of a live-rail payment refuses — key must not look live', async () => {
    const pay = stubPay({
      getPayment: async () => ({ ...paymentRow, railAdapter: 'crypto-native' }) as never,
    });
    app = await build(pay);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payments/${PAYMENT}`,
      headers: signed(principal({ key_env: 'sandbox', kid: 'k-sandbox-get' })),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('pay.sandbox_looks_live');
  });

  it('REFUSES payment list when limit is omitted — never invents 50; owner may pass 50', async () => {
    const pay = stubPay({
      listPayments: async (input: { limit?: number }) => {
        assertPaymentListLimit(input.limit);
        return [paymentRow] as never;
      },
    });
    app = await build(pay);

    const omitted = await app.inject({
      method: 'GET',
      url: `/v1/payments?merchantId=${MERCHANT}`,
      headers: signed(),
    });
    expect(omitted.statusCode).toBe(400);
    expect(omitted.json().error.code).toBe('pay.payment_list_limit_unset');

    const explicit = await app.inject({
      method: 'GET',
      url: `/v1/payments?merchantId=${MERCHANT}&limit=50`,
      headers: signed(),
    });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json()).toHaveLength(1);
  });

  it('sandbox list omits live-rail rows rather than painting them live', async () => {
    const pay = stubPay({
      listPayments: async () =>
        [
          { ...paymentRow, id: PAYMENT, railAdapter: 'card-sandbox' },
          { ...paymentRow, id: '55555555-5555-4555-8555-555555555555', railAdapter: 'crypto-native' },
        ] as never,
    });
    app = await build(pay);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payments?merchantId=${MERCHANT}`,
      headers: signed(principal({ key_env: 'sandbox', kid: 'k-sandbox-list' })),
    });

    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ railAdapter: string; mode: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.railAdapter).toBe('card-sandbox');
    expect(rows[0]!.mode).toBe('sandbox');
  });

  it('sandbox create that the core echoes as live is refused, not returned as live', async () => {
    const pay = stubPay({
      createPayment: async () => ({ ...paymentRow, status: 'created' as const, railAdapter: 'crypto-native' }) as never,
    });
    app = await build(pay);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: {
        ...signed(principal({ key_env: 'sandbox', kid: 'k-sandbox-echo' })),
        'content-type': 'application/json',
        'idempotency-key': 'sandbox:echo-live',
      },
      payload: createBody,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('pay.sandbox_looks_live');
  });
});

describe('missing webhook config refuses by name', () => {
  it('POST webhook-endpoints without a wired service is pay.webhook_not_configured, not a 404', async () => {
    const instance = Fastify({ logger: false });
    await registerPublicPayRest(instance, {
      edgeSecret: SECRET,
      serviceName: 'svc-pay',
      pay: stubPay(),
      idempotency: new MemoryRestIdempotencyStore(),
    });
    await instance.ready();
    app = instance;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhook-endpoints',
      headers: { ...signed(), 'content-type': 'application/json' },
      payload: { merchantId: MERCHANT, url: 'https://merchant.example/hooks/pay' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('pay.webhook_not_configured');
  });
});

describe('payment-links — REST translation of createLink / listLinks / deactivateLink', () => {
  it('returns 400 when the JSON body is empty, not a serializer 500', async () => {
    app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('pay.validation');
    expect(res.body).not.toContain('FST_ERR_FAILED_ERROR_SERIALIZATION');
  });

  const linkBody = {
    merchantId: MERCHANT,
    label: 'Invoice 42',
    amount: '10.50',
    currency: 'USDT',
    maxUses: 1,
  };

  it('REFUSES create with no Idempotency-Key — NOTHING WAS ATTEMPTED', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers: { ...signed(), 'content-type': 'application/json' },
      payload: linkBody,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('pay.idempotency_required');
    expect(pay.calls.filter((c) => c.method === 'createPaymentLink')).toHaveLength(0);
  });

  it('creates through createPaymentLink and returns the token once', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers: { ...signed(), 'content-type': 'application/json', 'idempotency-key': 'link:invoice:42' },
      payload: linkBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: LINK,
      token: 'pl_testtokenvalue',
      prefix: 'pl_testtoke',
      label: 'Invoice 42',
      expiresAt: '2026-09-07T10:00:00.000Z',
      maxUses: 1,
    });
    const args = pay.calls.find((c) => c.method === 'createPaymentLink')!.args[0] as {
      merchantId: string;
      label: string;
      amount: unknown;
      currency: string;
      expiresAt: unknown;
      maxUses: number;
    };
    expect(args.merchantId).toBe(MERCHANT);
    expect(args.label).toBe('Invoice 42');
    expect(args.currency).toBe('USDT');
    expect(args.maxUses).toBe(1);
    expect(args.expiresAt).toBeUndefined();
    expect(args.amount).toEqual(parseAmount('10.50'));
  });

  it('omitted expiresAt is undefined — never null (null means forever and is refused)', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers: { ...signed(), 'content-type': 'application/json', 'idempotency-key': 'link:default-ttl' },
      payload: { merchantId: MERCHANT, label: 'Tip jar' },
    });

    expect(res.statusCode).toBe(200);
    const args = pay.calls.find((c) => c.method === 'createPaymentLink')!.args[0] as { expiresAt: unknown };
    expect(args.expiresAt).toBeUndefined();
  });

  it('explicit null expiresAt is pay.link_expiry_invalid — NOTHING WAS ATTEMPTED', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers: { ...signed(), 'content-type': 'application/json', 'idempotency-key': 'link:forever' },
      payload: { merchantId: MERCHANT, label: 'Forever', expiresAt: null },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('pay.link_expiry_invalid');
    expect(pay.calls.filter((c) => c.method === 'createPaymentLink')).toHaveLength(0);
  });

  it('rejects a JSON-number amount — decimal strings only', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers: { ...signed(), 'content-type': 'application/json', 'idempotency-key': 'link:number' },
      payload: { merchantId: MERCHANT, label: 'Invoice', amount: 10.5, currency: 'USDT' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('pay.invalid_amount');
    expect(pay.calls.filter((c) => c.method === 'createPaymentLink')).toHaveLength(0);
  });

  it('REPLAYS an identical retry and does not mint a second token', async () => {
    const pay = stubPay();
    app = await build(pay);
    const headers = { ...signed(), 'content-type': 'application/json', 'idempotency-key': 'link:retry' };

    const first = await app.inject({ method: 'POST', url: '/v1/payment-links', headers, payload: linkBody });
    const second = await app.inject({ method: 'POST', url: '/v1/payment-links', headers, payload: linkBody });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(pay.calls.filter((c) => c.method === 'createPaymentLink')).toHaveLength(1);
  });

  it('CONFLICTS when the same key is reused with a DIFFERENT body', async () => {
    const pay = stubPay();
    app = await build(pay);
    const headers = { ...signed(), 'content-type': 'application/json', 'idempotency-key': 'link:reuse' };

    await app.inject({ method: 'POST', url: '/v1/payment-links', headers, payload: linkBody });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers,
      payload: { ...linkBody, label: 'Different invoice' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('pay.idempotency_conflict');
    expect(pay.calls.filter((c) => c.method === 'createPaymentLink')).toHaveLength(1);
  });

  it('REFUSES create/list/deactivate on another merchant BEFORE the service runs', async () => {
    const pay = stubPay();
    app = await build(pay);
    const stranger = signed(principal({ sub: STRANGER, userId: STRANGER }));

    const create = await app.inject({
      method: 'POST',
      url: '/v1/payment-links',
      headers: { ...stranger, 'content-type': 'application/json', 'idempotency-key': 'stranger:link' },
      payload: linkBody,
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().error.code).toBe('pay.merchant_forbidden');
    expect(pay.calls.filter((c) => c.method === 'createPaymentLink')).toHaveLength(0);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/payment-links?merchantId=${MERCHANT}`,
      headers: stranger,
    });
    expect(list.statusCode).toBe(403);
    expect(pay.calls.filter((c) => c.method === 'listPaymentLinks')).toHaveLength(0);

    const deactivate = await app.inject({
      method: 'DELETE',
      url: `/v1/payment-links/${LINK}?merchantId=${MERCHANT}`,
      headers: stranger,
    });
    expect(deactivate.statusCode).toBe(403);
    expect(pay.calls.filter((c) => c.method === 'deactivatePaymentLink')).toHaveLength(0);
  });

  it('lists through listPaymentLinks — token is not in the list shape', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/payment-links?merchantId=${MERCHANT}&limit=50`,
      headers: signed(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        id: LINK,
        prefix: 'pl_testtoke',
        label: 'Invoice',
        amount: '10',
        currency: 'USDT',
        active: true,
        expiresAt: '2026-09-07T10:00:00.000Z',
        maxUses: 1,
        uses: 0,
        createdAt: '2026-08-07T10:00:00.000Z',
      },
    ]);
    expect(res.json()[0]).not.toHaveProperty('token');
    expect(pay.calls.filter((c) => c.method === 'listPaymentLinks')).toHaveLength(1);
    expect(pay.calls.find((c) => c.method === 'listPaymentLinks')!.args).toEqual([MERCHANT, 50]);
  });

  it('REFUSES payment-link list when limit is omitted — never invents 50; owner may pass 50', async () => {
    const pay = stubPay({
      listPaymentLinks: async (_merchantId: string, limit?: number) => {
        assertPaymentLinkListLimit(limit);
        return [
          {
            id: LINK,
            prefix: 'pl_testtoke',
            label: 'Invoice',
            amount: '10',
            currency: 'USDT',
            active: true,
            expiresAt: '2026-09-07T10:00:00.000Z',
            maxUses: 1,
            uses: 0,
            createdAt: '2026-08-07T10:00:00.000Z',
          },
        ];
      },
    });
    app = await build(pay);

    const omitted = await app.inject({
      method: 'GET',
      url: `/v1/payment-links?merchantId=${MERCHANT}`,
      headers: signed(),
    });
    expect(omitted.statusCode).toBe(400);
    expect(omitted.json().error.code).toBe('pay.payment_link_list_limit_unset');

    const explicit = await app.inject({
      method: 'GET',
      url: `/v1/payment-links?merchantId=${MERCHANT}&limit=50`,
      headers: signed(),
    });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json()).toHaveLength(1);
  });

  it('deactivates through deactivatePaymentLink', async () => {
    const pay = stubPay();
    app = await build(pay);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/payment-links/${LINK}?merchantId=${MERCHANT}`,
      headers: signed(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deactivated: true });
    expect(pay.calls.find((c) => c.method === 'deactivatePaymentLink')!.args).toEqual([MERCHANT, LINK]);
  });
});
