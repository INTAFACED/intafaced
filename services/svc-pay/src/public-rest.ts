import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import { requireScope, type Principal, type Scope } from '@intafaced/auth';
import { createEdgeContext, type EdgeRequest } from '@intafaced/contracts';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { assertMerchantAreaAccess, type MerchantAreaFence } from './merchant-ownership.js';
import { areaForSurface, isPayfacPermissionPort, resolveActorMerchantId, type PayfacPermissionPort } from './payfac-permissions.js';
import { PERMISSION_AREAS, SubMerchantError, type PermissionArea } from './submerchants.js';
import { type MerchantWebhookService, type WebhookDeliveryStatus } from './merchant-webhooks.js';
import { PayError, type PayService, type PaymentStatus } from './payment-service.js';
import { SandboxRailRefusal } from './rails/posture.js';
import { fingerprintRequest, MemoryRestIdempotencyStore, type RestIdempotencyStore } from './rest-idempotency.js';
import { isSandboxRailId, resolveMerchantRail } from './sandbox-key-routing.js';

/**
 * `pay.public-api` — the merchant REST surface.
 *
 * Law: docs/adr/2026-08-07-pay-public-api-law.md. Every decision below is that
 * ADR's, not this file's; where the two disagree the ADR wins.
 *
 * STEP 1 — reads:
 *   GET /api/pay/v1/payments/:id          scope pay:read
 *   GET /api/pay/v1/payments              scope pay:read   ?merchantId= &status= &limit=
 *   GET /api/pay/v1/balances              scope pay:read   ?merchantId= &assetId=
 *   GET /api/pay/v1/openapi.json          public — the spec
 *
 * STEP 2 — mutations (this PR), every POST requires `Idempotency-Key` (ADR §2.2):
 *   POST /api/pay/v1/payments                    scope pay:write
 *   POST /api/pay/v1/payments/:id/authorize      scope pay:write
 *   POST /api/pay/v1/payments/:id/capture        scope pay:write
 *   POST /api/pay/v1/payments/:id/refund         scope pay:refund
 *
 * ── A TRANSLATION, NOT A SECOND IMPLEMENTATION ───────────────────────────
 *
 * The ADR's rule: "any behaviour that differs between REST and tRPC is a defect
 * in the REST layer". So these routes call the same `PayService` methods the
 * tRPC router calls, gate on the same `assertMerchantAreaAccess`, and render
 * amounts through the same `formatAmount`. Nothing here recomputes anything.
 *
 * ── AUTH IS THE MOUNT BOUNDARY, UNCHANGED ────────────────────────────────
 *
 * ADR §2.1: merchants authenticate with `ifc_…` API keys, svc-edge exchanges
 * them at identity, and this service receives a SIGNED PRINCIPAL. It never sees
 * a raw key and there is no second auth path here.
 *
 * ── MONEY ON THE WIRE ────────────────────────────────────────────────────
 *
 * ADR §2.3: decimal strings with an explicit asset. Never minor units, never a
 * number.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 *
 * STEP 3 — outbound merchant webhooks (this PR residual after tip #994):
 *   POST   /api/pay/v1/webhook-endpoints              pay:write
 *   GET    /api/pay/v1/webhook-endpoints              pay:read
 *   DELETE /api/pay/v1/webhook-endpoints/:id          pay:write
 *   GET    /api/pay/v1/webhook-deliveries             pay:read   (failure dashboard)
 *
 * STEP 4 — sandbox keys: principal `key_env` from the API-key exchange routes
 * createPayment onto the sandbox rail (`card-sandbox`). A live key may not name
 * a sandbox rail. `assertRailMayMoveValue` remains the second gate for
 * value-leaving caps — REST acquires no exception. No parallel stack.
 *
 * STEP 5 — public docs + merchant quickstart (this residual):
 *   docs/pay/MERCHANT-PUBLIC-API-QUICKSTART.md — callable without monorepo.
 *   OpenAPI description below stays the machine contract (must match behaviour).
 *
 * D26-P1-P2 — PayFac permissions (when `trees` is SubMerchantService):
 *   GET    /api/pay/v1/submerchant-permissions/areas
 *   GET    /api/pay/v1/submerchant-permissions              ?subjectMerchantId=
 *   GET    /api/pay/v1/submerchant-permissions/history      ?subjectMerchantId=
 *   POST   /api/pay/v1/submerchant-permissions/grant
 *   POST   /api/pay/v1/submerchant-permissions/revoke
 *   Same journal + actor-from-principal rules as tRPC `submerchantPermission.*`.
 *   Honest partial: docs/pay/PAYFAC-PERMISSIONS-PARTIAL-2026-08-12.md
 *
 * Not Class X go-live. Not a live acquirer. Outbound webhooks do not move value.
 */

/**
 * Service-side mount. svc-edge strips `/api/pay` before forwarding
 * (`services/svc-edge/src/routes.ts` — no `preservePath`), so a browser call to
 * `/api/pay/v1/payments` arrives here as `/v1/payments`.
 *
 * Mounting at `/api/pay/v1` 404s every external call (edge already ate the
 * prefix). Do **not** "fix" that by setting `preservePath: true` on the pay
 * upstream — that would break `/api/pay/trpc` and `/api/pay/webhooks`, which
 * correctly rely on stripping.
 *
 * External path (quickstart, OpenAPI `servers`) stays `/api/pay/v1` — that is
 * what merchants call. `BASE` is only what this process listens on.
 */
const BASE = '/v1';
/** Public edge path advertised in OpenAPI. Not a mount. */
const EXTERNAL_BASE = '/api/pay/v1';

const PAYMENT_STATUSES: readonly PaymentStatus[] = ['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed'];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Same decimal-string rule as the tRPC `amountSchema`. */
const AMOUNT_PATTERN = '^\\d+(\\.\\d{1,18})?$';

export interface PublicRestDeps {
  /** Shared EDGE_PRINCIPAL_SECRET — the same value the tRPC mount verifies. */
  edgeSecret: string;
  serviceName: string;
  pay: PayService;
  /** Version string for the OpenAPI document. */
  version?: string;
  /**
   * Idempotency journal for mutating POSTs. Defaults to in-memory (tests /
   * single-process). Production wires `PostgresRestIdempotencyStore`.
   */
  idempotency?: RestIdempotencyStore;
  /** Outbound merchant webhooks (step 3). Optional so read/mutate tests stay light. */
  webhooks?: MerchantWebhookService;
  /**
   * PayFac area fence — same as tRPC `createPayRouter` fourth arg.
   * When the concrete `SubMerchantService` is passed (boot already does), REST
   * also mounts `/v1/submerchant-permissions/*` (D26-P1-P2) via duck-typing —
   * no `index.ts` change required while #1720 is open.
   */
  trees?: MerchantAreaFence | PayfacPermissionPort | null;
}

/**
 * The error envelope, and it is the internal vocabulary (ADR §2.6).
 *
 * `pay.*` codes are the public codes. No competitor taxonomy.
 */
interface ErrorBody {
  error: { code: string; message: string };
}

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', description: 'Stable `pay.*` code. Branch on this, never on the message.' },
        message: { type: 'string' },
      },
    },
  },
} as const;

const paymentSchema = {
  type: 'object',
  required: ['id', 'merchantId', 'amount', 'assetId', 'status', 'mode', 'capturedAmount', 'refundedAmount', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    merchantId: { type: 'string', format: 'uuid' },
    profileId: { type: 'string', nullable: true },
    amount: { type: 'string', description: 'Decimal string. Never minor units, never a number (ADR §2.3).' },
    assetId: { type: 'string' },
    method: { type: 'string', nullable: true },
    railAdapter: { type: 'string', nullable: true },
    railRef: { type: 'string', nullable: true },
    status: { type: 'string', enum: [...PAYMENT_STATUSES] },
    mode: {
      type: 'string',
      enum: ['live', 'sandbox'],
      description: 'Rail posture of this payment (ADR §2.5). `sandbox` when the rail is a sandbox simulation; never silent live.',
    },
    capturedAmount: { type: 'string', description: 'Decimal string.' },
    refundedAmount: { type: 'string', description: 'Decimal string.' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

const balanceSchema = {
  type: 'object',
  required: ['merchantId', 'assetId', 'clearing', 'available'],
  properties: {
    merchantId: { type: 'string', format: 'uuid' },
    assetId: { type: 'string' },
    clearing: { type: 'string', description: 'Decimal string. Held against pending settlement.' },
    available: { type: 'string', description: 'Decimal string. Withdrawable.' },
  },
} as const;

const createBodySchema = {
  type: 'object',
  required: ['merchantId', 'amount', 'assetId', 'method', 'railAdapter'],
  additionalProperties: false,
  properties: {
    merchantId: { type: 'string', format: 'uuid' },
    profileId: { type: 'string', format: 'uuid', nullable: true },
    // No `type: string` here on purpose: Fastify/Ajv coerceTypes would turn a
    // JSON number into `"1.1"` before the handler runs, and ADR §2.3 would be
    // decorative. `requireDecimalString` enforces the wire shape.
    amount: { description: 'Decimal string. Never a JSON number (ADR §2.3).' },
    assetId: { type: 'string', minLength: 1, maxLength: 16 },
    method: { type: 'string', minLength: 1 },
    railAdapter: { type: 'string', minLength: 1 },
    instrument: {
      type: 'object',
      required: ['kind'],
      additionalProperties: false,
      properties: {
        kind: { type: 'string' },
        token: { type: 'string' },
        address: { type: 'string' },
      },
    },
    customerRef: { type: 'string' },
    metadata: { type: 'object', additionalProperties: { type: 'string' } },
  },
} as const;

const captureBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    amount: {
      description:
        'Optional amount as a decimal string. If present, must equal the full authorized amount — partial capture is not supported (`pay.partial_capture_unsupported`). Omit to capture the full authorization. Never a JSON number.',
    },
  },
} as const;

const refundBodySchema = {
  type: 'object',
  required: ['amount'],
  additionalProperties: false,
  properties: {
    amount: { description: 'Decimal string. Never a JSON number (ADR §2.3).' },
    refundId: {
      type: 'string',
      description:
        'Optional business refund id (business key, never a random UUID). Omit it and your `Idempotency-Key` becomes this refund’s business identity for this payment, so the same key can never refund twice — even if the retry arrives after the idempotency record has expired. Send a NEW key (or an explicit `refundId`) for a genuinely second partial refund.',
    },
  },
} as const;

const idempotencyHeaderSchema = {
  type: 'object',
  // Not `required` here: Fastify's header-validation error envelope is not our
  // `pay.*` shape and serialization then 500s. Enforcement is `requireIdempotencyKey`.
  properties: {
    'idempotency-key': {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      description: 'Required on every mutating POST (ADR §2.2). A business key — never a random UUID per attempt.',
    },
  },
} as const;

/**
 * THE BUSINESS IDENTITY OF A REFUND THE CALLER DID NOT NAME.
 *
 * `PayService.refund` defaults `refundId` to `${paymentId}:${sequence + 1}` — an
 * ATTEMPT ORDINAL, which is the right default for an internal caller who counts
 * its own refunds and the wrong one for a public retry. `refundId` becomes the
 * ledger key `payment.refund:<refundId>`, so two attempts at ONE business event
 * that produce `…:1` and `…:2` are two real movements out of the merchant's
 * clearing balance. `withIdempotency` hides that in the common case and is not
 * the guard: it ABANDONS its claim on 5xx so a retry may execute, and a journal
 * row can expire. A partial refund is the reachable case — a full one is caught
 * by `pay.refund_exceeds_captured` once refundable hits zero, which is luck
 * rather than design.
 *
 * So when the caller does not supply a business key, the caller's
 * `Idempotency-Key` IS the business key, bound to the payment it refunds.
 * Derived from the key and the payment id, never from a clock or a random value.
 *
 * DIGESTED, not concatenated, for one reason: the ledger caps an idempotency key
 * at 200 characters (`packages/ledger-client` `types.ts`) and this header is
 * allowed 255, so pasting it in would build a key the ledger rejects — turning a
 * long-but-legal merchant key into a refused refund. A digest is fixed-width and
 * still a pure function of the key, which is all idempotency needs. The raw key
 * stays readable in the REST journal, so an operator can still join the two.
 */
function restRefundId(paymentId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${paymentId} ${idempotencyKey}`).digest('hex').slice(0, 24);
  return `rest:${paymentId}:${digest}`;
}

/** Reject JSON numbers / anything that is not already a decimal string (ADR §2.3). */
function requireDecimalString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !new RegExp(AMOUNT_PATTERN).test(value)) {
    throw new PayError(`${field} must be an unsigned decimal string (never a JSON number). NOTHING WAS ATTEMPTED.`, 'pay.invalid_amount');
  }
  return value;
}
function statusFor(code: string): number {
  switch (code) {
    case 'pay.merchant_not_found':
    case 'pay.payment_not_found':
    case 'pay.profile_not_found':
    case 'pay.settlement_not_found':
    case 'pay.webhook_endpoint_not_found':
      return 404;
    case 'pay.merchant_forbidden':
    case 'pay.submerchant_permission_denied':
    case 'pay.submerchant_not_onboarded':
    case 'pay.submerchant_out_of_scope':
    case 'pay.submerchant_grant_lateral':
    case 'pay.merchant_inactive':
    case 'pay.kyb_operator_required':
      return 403;
    case 'pay.invalid_transition':
    case 'pay.nothing_captured':
    case 'pay.capture_exceeds_authorized':
    case 'pay.refund_exceeds_captured':
    case 'pay.refund_in_flight':
    case 'pay.refund_id_spent':
    case 'pay.refund_id_conflict':
    case 'pay.settlement_in_flight':
    case 'pay.settlement_desynced':
    case 'pay.idempotency_conflict':
    case 'pay.partial_capture_unsupported':
    case 'pay.submerchant_user_already_merchant':
    case 'pay.submerchant_cycle':
      return 409;
    case 'pay.rail_operation_unsupported':
    case 'pay.sandbox_rail_refused':
      return 503;
    default:
      return 400;
  }
}

function send(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof SandboxRailRefusal) {
    const body: ErrorBody = {
      error: {
        code: 'pay.sandbox_rail_refused',
        message: err.message,
      },
    };
    return reply.code(503).send(body);
  }
  if (err instanceof PayError) {
    const body: ErrorBody = { error: { code: err.code, message: err.message } };
    return reply.code(statusFor(err.code)).send(body);
  }
  if (err instanceof SubMerchantError) {
    const body: ErrorBody = { error: { code: err.code, message: err.message } };
    return reply.code(statusFor(err.code)).send(body);
  }
  throw err;
}

export async function registerPublicPayRest(app: FastifyInstance, deps: PublicRestDeps): Promise<void> {
  const assertAccess = (userId: string | undefined, merchantId: string, area: PermissionArea) =>
    assertMerchantAreaAccess(deps.pay, userId, merchantId, area, deps.trees ?? null);
  const edge = createEdgeContext({ secret: deps.edgeSecret, serviceName: deps.serviceName });
  const idempotency = deps.idempotency ?? new MemoryRestIdempotencyStore();

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Payments API',
        version: deps.version ?? '1.0.0',
        description: [
          'Merchant payments API.',
          '',
          'Human quickstart (no monorepo required): docs/pay/MERCHANT-PUBLIC-API-QUICKSTART.md',
          '',
          '**Amounts are decimal strings** with an explicit `assetId` — never minor units and never a JSON number.',
          'A payment of one dollar ten is `"1.1"`, not `110` and not `1.1` as a number.',
          '',
          'Amounts are **canonical**: no trailing zeros. An amount created as `1.10` is returned as `"1.1"`.',
          'Compare amounts numerically or with a decimal library — never by string equality.',
          '',
          '**Authentication** is an `ifc_…` (live) or `ifc_test_…` (sandbox) API key as a bearer token.',
          'Keys are exchanged for a short-lived principal at the edge; this service never sees the key itself.',
          '',
          '**Sandbox keys** (mode=sandbox / `key_env=sandbox`): createPayment always uses the sandbox rail',
          '(`card-sandbox`). A **live** key that names a sandbox rail is refused (`pay.sandbox_rail_refused`).',
          'Every payment response includes `mode: "sandbox" | "live"` from the rail posture — never silent.',
          'There is no parallel sandbox deployment — same API, rail posture only.',
          '',
          '**Idempotency-Key** is required on every mutating POST. A repeated key with the same body returns',
          'the original result; a repeated key with a different body is `409 pay.idempotency_conflict`.',
          '',
          '**Errors** carry a stable `pay.*` code. Branch on the code, never on the message.',
          '',
          '**Webhooks** (ADR §2.4): HMAC-SHA256 over `timestamp + "." + raw body` in',
          '`X-Intafaced-Signature`, with `X-Intafaced-Timestamp`. At-least-once — dedupe on event `id`.',
          'Bodies carry payment **state**, not instructions. Permanently failing endpoints are disabled',
          'and listed under webhook-deliveries.',
          '',
          'This surface does **not** imply a live card acquirer (Class X / `socket.psp-partners`).',
        ].join('\n'),
      },
      // External edge path. Service mount is BASE (`/v1`); edge strips `/api/pay`.
      // Paths below are rewritten relative to this server so composition is
      // `/api/pay/v1` + `/payments` = `/api/pay/v1/payments`, never a doubled `/v1`.
      servers: [{ url: EXTERNAL_BASE }],
      components: {
        securitySchemes: {
          apiKey: { type: 'http', scheme: 'bearer', description: 'An `ifc_…` API key.' },
        },
        parameters: {
          IdempotencyKey: {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 255 },
            description: 'Required on mutating POSTs (ADR §2.2). Business key — never random per attempt.',
          },
        },
      },
      security: [{ apiKey: [] }],
      tags: [{ name: 'payments' }, { name: 'balances' }, { name: 'webhooks' }],
    },
    /**
     * Routes mount at BASE (`/v1/…`) because that is what arrives after the edge
     * strips `/api/pay`. OpenAPI must advertise paths relative to EXTERNAL_BASE
     * so a generated client does not call `/api/pay/v1/v1/payments`.
     */
    transform: ({ schema, url }) => {
      const path = url.startsWith(BASE) ? url.slice(BASE.length) || '/' : url;
      return { schema, url: path };
    },
  });

  /**
   * THE SPEC, NOT A UI.
   *
   * `@fastify/swagger-ui` was refused: `@fastify/static` carried advisories, and
   * rendering docs is not a reason to run a static file server inside the
   * payments service. The spec is the artefact.
   */
  app.get(`${BASE}/openapi.json`, { schema: { hide: true } }, async () => app.swagger());

  /**
   * Resolve the caller, or refuse.
   *
   * An unsigned or absent principal is anonymous. Missing scope and missing
   * auth both land as 401 — from the caller's side the next action is the same.
   */
  function principalOf(req: FastifyRequest, reply: FastifyReply, scope: Scope): Principal | null {
    const ctx = edge({ headers: req.headers } as EdgeRequest);
    try {
      if (!ctx.principal) throw new Error('anonymous');
      requireScope(ctx.principal, scope);
      return ctx.principal;
    } catch {
      reply.code(401).send({
        error: {
          code: 'pay.unauthorized',
          message: `A valid API key with the ${scope} scope is required.`,
        },
      });
      return null;
    }
  }

  function requireIdempotencyKey(req: FastifyRequest, reply: FastifyReply): string | null {
    const raw = req.headers['idempotency-key'];
    const key = typeof raw === 'string' ? raw.trim() : Array.isArray(raw) ? raw[0]?.trim() : '';
    if (!key) {
      reply.code(400).send({
        error: {
          code: 'pay.idempotency_required',
          message: 'Idempotency-Key header is required on every mutating POST. NOTHING WAS ATTEMPTED.',
        },
      });
      return null;
    }
    if (key.length > 255) {
      reply.code(400).send({
        error: {
          code: 'pay.idempotency_required',
          message: 'Idempotency-Key must be at most 255 characters. NOTHING WAS ATTEMPTED.',
        },
      });
      return null;
    }
    return key;
  }

  /**
   * Run a mutating handler behind the Idempotency-Key claim→put journal.
   * 5xx abandons the claim so a retry may execute; 2xx/4xx are stored and replayed.
   */
  async function withIdempotency(
    req: FastifyRequest,
    reply: FastifyReply,
    ownerId: string,
    key: string,
    body: unknown,
    run: () => Promise<void>,
  ): Promise<FastifyReply> {
    const path = req.url.split('?')[0] ?? req.url;
    const fingerprint = fingerprintRequest(req.method, path, body ?? {});
    const claim = await idempotency.claim(ownerId, key, fingerprint);
    if (claim.kind === 'conflict') {
      return reply.code(409).send({
        error: {
          code: 'pay.idempotency_conflict',
          message: 'Idempotency-Key was already used with a different request body. Refusing rather than guessing which result you wanted.',
        },
      });
    }
    if (claim.kind === 'replay') {
      return reply.code(claim.record.statusCode).send(claim.record.body);
    }

    // Capture whatever Fastify sends so we can journal it.
    let captured: { statusCode: number; body: unknown } | undefined;
    const originalSend = reply.send.bind(reply);
    reply.send = ((payload: unknown) => {
      captured = { statusCode: reply.statusCode, body: payload };
      return originalSend(payload);
    }) as typeof reply.send;

    try {
      await run();
      if (captured && captured.statusCode < 500) {
        await idempotency.put(ownerId, key, { statusCode: captured.statusCode, body: captured.body }, claim.token);
      } else {
        await idempotency.abandon(ownerId, key, claim.token);
      }
      return reply;
    } catch (err) {
      await idempotency.abandon(ownerId, key, claim.token);
      throw err;
    }
  }

  // ── READS (step 1) ────────────────────────────────────────────────────────

  app.get(
    `${BASE}/payments/:id`,
    {
      schema: {
        tags: ['payments'],
        summary: 'Fetch one payment',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        response: { 200: paymentSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const principal = principalOf(req, reply, 'pay:read');
      if (!principal) return reply;
      try {
        const payment = await deps.pay.getPayment(req.params.id);
        await assertAccess(principal.userId, payment.merchantId, areaForSurface('rest.payments.read'));
        return reply.send(toPaymentBody(payment));
      } catch (err) {
        return send(reply, err);
      }
    },
  );

  app.get(
    `${BASE}/payments`,
    {
      schema: {
        tags: ['payments'],
        summary: 'List a merchant’s payments, newest first',
        querystring: {
          type: 'object',
          required: ['merchantId'],
          properties: {
            merchantId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: [...PAYMENT_STATUSES] },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
          },
        },
        response: { 200: { type: 'array', items: paymentSchema }, 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (req: FastifyRequest<{ Querystring: { merchantId: string; status?: PaymentStatus; limit?: number } }>, reply) => {
      const principal = principalOf(req, reply, 'pay:read');
      if (!principal) return reply;
      try {
        await assertAccess(principal.userId, req.query.merchantId, areaForSurface('rest.payments.list'));
        const rows = await deps.pay.listPayments({
          merchantId: req.query.merchantId,
          status: req.query.status,
          limit: Math.min(req.query.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
        });
        return reply.send(rows.map(toPaymentBody));
      } catch (err) {
        return send(reply, err);
      }
    },
  );

  app.get(
    `${BASE}/balances`,
    {
      schema: {
        tags: ['balances'],
        summary: 'Merchant balance for one asset',
        description:
          'A PROJECTION of the ledger, not a second book (Doctrine §0.6). `clearing` is held against pending settlement; `available` is withdrawable.',
        querystring: {
          type: 'object',
          required: ['merchantId', 'assetId'],
          properties: { merchantId: { type: 'string', format: 'uuid' }, assetId: { type: 'string', minLength: 1, maxLength: 16 } },
        },
        response: { 200: balanceSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (req: FastifyRequest<{ Querystring: { merchantId: string; assetId: string } }>, reply) => {
      const principal = principalOf(req, reply, 'pay:read');
      if (!principal) return reply;
      try {
        await assertAccess(principal.userId, req.query.merchantId, areaForSurface('rest.balances.read'));
        const [clearing, available] = await Promise.all([
          deps.pay.clearingBalance(req.query.merchantId, req.query.assetId),
          deps.pay.merchantBalance(req.query.merchantId, req.query.assetId),
        ]);
        return reply.send({
          merchantId: req.query.merchantId,
          assetId: req.query.assetId,
          clearing: formatAmount(clearing),
          available: formatAmount(available),
        });
      } catch (err) {
        return send(reply, err);
      }
    },
  );

  // ── MUTATIONS (step 2) ────────────────────────────────────────────────────

  type CreateBody = {
    merchantId: string;
    profileId?: string | null;
    amount: unknown;
    assetId: string;
    method: string;
    railAdapter: string;
    instrument?: { kind: string; token?: string; address?: string };
    customerRef?: string;
    metadata?: Record<string, string>;
  };

  app.post(
    `${BASE}/payments`,
    {
      schema: {
        tags: ['payments'],
        summary: 'Create a payment',
        description: 'Requires `Idempotency-Key`. Calls the same `PayService.createPayment` the tRPC router uses.',
        headers: idempotencyHeaderSchema,
        body: createBodySchema,
        response: {
          200: paymentSchema,
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          409: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (req: FastifyRequest<{ Body: CreateBody }>, reply) => {
      const principal = principalOf(req, reply, 'pay:write');
      if (!principal) return reply;
      const key = requireIdempotencyKey(req, reply);
      if (!key) return reply;

      return withIdempotency(req, reply, principal.userId, key, req.body, async () => {
        try {
          await assertAccess(principal.userId, req.body.merchantId, areaForSurface('rest.payments.create'));
          const amount = requireDecimalString(req.body.amount, 'amount');
          // ADR §2.5 step 4 — sandbox key → sandbox rail; live key may not.
          const railAdapter = resolveMerchantRail({
            keyEnv: principal.key_env,
            requestedRail: req.body.railAdapter,
          });
          const payment = await deps.pay.createPayment({
            merchantId: req.body.merchantId,
            profileId: req.body.profileId ?? null,
            amount: parseAmount(amount),
            assetId: req.body.assetId,
            method: req.body.method,
            railAdapter,
            instrument: req.body.instrument,
            customerRef: req.body.customerRef,
            metadata: req.body.metadata,
          });
          return reply.send(toPaymentBody(payment));
        } catch (err) {
          return send(reply, err);
        }
      });
    },
  );

  app.post(
    `${BASE}/payments/:id/authorize`,
    {
      schema: {
        tags: ['payments'],
        summary: 'Authorize a payment',
        description: 'Requires `Idempotency-Key`. No value moves on authorize — ledger untouched.',
        headers: idempotencyHeaderSchema,
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', additionalProperties: false, properties: {} },
        response: {
          200: paymentSchema,
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (req: FastifyRequest<{ Params: { id: string }; Body?: Record<string, never> }>, reply) => {
      const principal = principalOf(req, reply, 'pay:write');
      if (!principal) return reply;
      const key = requireIdempotencyKey(req, reply);
      if (!key) return reply;

      return withIdempotency(req, reply, principal.userId, key, req.body ?? {}, async () => {
        try {
          const existing = await deps.pay.getPayment(req.params.id);
          await assertAccess(principal.userId, existing.merchantId, areaForSurface('rest.payments.authorize'));
          const payment = await deps.pay.authorize(req.params.id);
          return reply.send(toPaymentBody(payment));
        } catch (err) {
          return send(reply, err);
        }
      });
    },
  );

  app.post(
    `${BASE}/payments/:id/capture`,
    {
      schema: {
        tags: ['payments'],
        summary: 'Capture an authorized payment',
        description: 'Requires `Idempotency-Key`. Value moves only through ledger-client recipes inside `PayService.capture`.',
        headers: idempotencyHeaderSchema,
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: captureBodySchema,
        response: {
          200: paymentSchema,
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (req: FastifyRequest<{ Params: { id: string }; Body: { amount?: unknown } }>, reply) => {
      const principal = principalOf(req, reply, 'pay:write');
      if (!principal) return reply;
      const key = requireIdempotencyKey(req, reply);
      if (!key) return reply;

      return withIdempotency(req, reply, principal.userId, key, req.body ?? {}, async () => {
        try {
          const existing = await deps.pay.getPayment(req.params.id);
          await assertAccess(principal.userId, existing.merchantId, areaForSurface('rest.payments.capture'));
          const opts = req.body?.amount === undefined ? {} : { amount: parseAmount(requireDecimalString(req.body.amount, 'amount')) };
          const payment = await deps.pay.capture(req.params.id, opts);
          return reply.send(toPaymentBody(payment));
        } catch (err) {
          return send(reply, err);
        }
      });
    },
  );

  app.post(
    `${BASE}/payments/:id/refund`,
    {
      schema: {
        tags: ['payments'],
        summary: 'Refund a captured payment',
        description: 'Requires `Idempotency-Key` and `pay:refund` (not the same authority as taking payment). Ledger-only.',
        headers: idempotencyHeaderSchema,
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: refundBodySchema,
        response: {
          200: paymentSchema,
          400: errorSchema,
          401: errorSchema,
          403: errorSchema,
          404: errorSchema,
          409: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (req: FastifyRequest<{ Params: { id: string }; Body: { amount: unknown; refundId?: string } }>, reply) => {
      const principal = principalOf(req, reply, 'pay:refund');
      if (!principal) return reply;
      const key = requireIdempotencyKey(req, reply);
      if (!key) return reply;

      return withIdempotency(req, reply, principal.userId, key, req.body, async () => {
        try {
          const existing = await deps.pay.getPayment(req.params.id);
          await assertAccess(principal.userId, existing.merchantId, areaForSurface('rest.payments.refund'));
          const amount = requireDecimalString(req.body.amount, 'amount');
          // The caller's own business key wins; otherwise their Idempotency-Key
          // IS the business key (see `restRefundId`). Never an attempt ordinal.
          // Empty / whitespace body refundId is NOT a business key — fall through
          // to the Idempotency-Key-derived identity. `??` alone would accept ""
          // and build ledger key `payment.refund:` (or spaces), colliding all
          // such "keys" and bypassing restRefundId.
          const bodyRefundId = typeof req.body.refundId === 'string' ? req.body.refundId.trim() : '';
          const payment = await deps.pay.refund(req.params.id, parseAmount(amount), {
            refundId: bodyRefundId.length > 0 ? bodyRefundId : restRefundId(req.params.id, key),
          });
          return reply.send(toPaymentBody(payment));
        } catch (err) {
          return send(reply, err);
        }
      });
    },
  );

  // ── WEBHOOKS (step 3) ─────────────────────────────────────────────────────

  if (deps.webhooks) {
    const webhooks = deps.webhooks;

    const endpointSchema = {
      type: 'object',
      required: ['id', 'merchantId', 'url', 'status', 'consecutiveFailures', 'createdAt'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        merchantId: { type: 'string', format: 'uuid' },
        url: { type: 'string' },
        status: { type: 'string', enum: ['active', 'disabled'] },
        disabledReason: { type: 'string', nullable: true },
        consecutiveFailures: { type: 'integer' },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        secret: {
          type: 'string',
          description: 'Signing secret — returned ONLY on create. Store it; we will not show it again.',
        },
      },
    } as const;

    const deliverySchema = {
      type: 'object',
      required: ['id', 'endpointId', 'merchantId', 'eventId', 'eventType', 'status', 'attempts', 'createdAt'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        endpointId: { type: 'string', format: 'uuid' },
        merchantId: { type: 'string', format: 'uuid' },
        eventId: { type: 'string', description: 'Merchant dedupe key (ADR §2.4).' },
        eventType: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'delivered', 'failed', 'dead'] },
        attempts: { type: 'integer' },
        nextAttemptAt: { type: 'string', format: 'date-time' },
        lastStatusCode: { type: 'integer', nullable: true },
        lastError: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        deliveredAt: { type: 'string', format: 'date-time', nullable: true },
      },
    } as const;

    app.post(
      `${BASE}/webhook-endpoints`,
      {
        schema: {
          tags: ['webhooks'],
          summary: 'Register an outbound webhook endpoint',
          description: 'HTTPS required (localhost http allowed). Signing secret returned once. ADR §2.4 — no value moves.',
          body: {
            type: 'object',
            required: ['merchantId', 'url'],
            additionalProperties: false,
            properties: {
              merchantId: { type: 'string', format: 'uuid' },
              url: { type: 'string', minLength: 8, maxLength: 2048 },
            },
          },
          response: { 200: endpointSchema, 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
        },
      },
      async (req: FastifyRequest<{ Body: { merchantId: string; url: string } }>, reply) => {
        const principal = principalOf(req, reply, 'pay:write');
        if (!principal) return reply;
        try {
          await assertAccess(principal.userId, req.body.merchantId, areaForSurface('rest.webhooks.write'));
          const created = await webhooks.registerEndpoint(req.body.merchantId, req.body.url);
          return reply.send({
            id: created.id,
            merchantId: created.merchantId,
            url: created.url,
            status: created.status,
            disabledReason: created.disabledReason,
            consecutiveFailures: created.consecutiveFailures,
            createdAt: created.createdAt.toISOString(),
            updatedAt: created.updatedAt.toISOString(),
            secret: created.secret,
          });
        } catch (err) {
          return send(reply, err);
        }
      },
    );

    app.get(
      `${BASE}/webhook-endpoints`,
      {
        schema: {
          tags: ['webhooks'],
          summary: 'List webhook endpoints for a merchant',
          querystring: {
            type: 'object',
            required: ['merchantId'],
            properties: { merchantId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: { type: 'array', items: endpointSchema }, 401: errorSchema, 403: errorSchema, 404: errorSchema },
        },
      },
      async (req: FastifyRequest<{ Querystring: { merchantId: string } }>, reply) => {
        const principal = principalOf(req, reply, 'pay:read');
        if (!principal) return reply;
        try {
          await assertAccess(principal.userId, req.query.merchantId, areaForSurface('rest.webhooks.read'));
          const rows = await webhooks.listEndpoints(req.query.merchantId);
          return reply.send(
            rows.map((e) => ({
              id: e.id,
              merchantId: e.merchantId,
              url: e.url,
              status: e.status,
              disabledReason: e.disabledReason,
              consecutiveFailures: e.consecutiveFailures,
              createdAt: e.createdAt.toISOString(),
              updatedAt: e.updatedAt.toISOString(),
            })),
          );
        } catch (err) {
          return send(reply, err);
        }
      },
    );

    app.delete(
      `${BASE}/webhook-endpoints/:id`,
      {
        schema: {
          tags: ['webhooks'],
          summary: 'Disable a webhook endpoint',
          params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
          querystring: {
            type: 'object',
            required: ['merchantId'],
            properties: { merchantId: { type: 'string', format: 'uuid' } },
          },
          response: {
            200: { type: 'object', properties: { disabled: { type: 'boolean' } } },
            401: errorSchema,
            403: errorSchema,
            404: errorSchema,
          },
        },
      },
      async (req: FastifyRequest<{ Params: { id: string }; Querystring: { merchantId: string } }>, reply) => {
        const principal = principalOf(req, reply, 'pay:write');
        if (!principal) return reply;
        try {
          await assertAccess(principal.userId, req.query.merchantId, areaForSurface('rest.webhooks.read'));
          await webhooks.disableEndpoint(req.query.merchantId, req.params.id);
          return reply.send({ disabled: true });
        } catch (err) {
          return send(reply, err);
        }
      },
    );

    app.post(
      `${BASE}/webhook-endpoints/:id/enable`,
      {
        schema: {
          tags: ['webhooks'],
          summary: 'Re-enable a disabled webhook endpoint',
          description:
            'After consecutive failures disable an endpoint (ADR §2.4), fix the receiver and call this. Resets the failure counter.',
          params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
          querystring: {
            type: 'object',
            required: ['merchantId'],
            properties: { merchantId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: endpointSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
        },
      },
      async (req: FastifyRequest<{ Params: { id: string }; Querystring: { merchantId: string } }>, reply) => {
        const principal = principalOf(req, reply, 'pay:write');
        if (!principal) return reply;
        try {
          await assertAccess(principal.userId, req.query.merchantId, 'webhook');
          const enabled = await webhooks.enableEndpoint(req.query.merchantId, req.params.id);
          return reply.send({
            id: enabled.id,
            merchantId: enabled.merchantId,
            url: enabled.url,
            status: enabled.status,
            disabledReason: enabled.disabledReason,
            consecutiveFailures: enabled.consecutiveFailures,
            createdAt: enabled.createdAt.toISOString(),
            updatedAt: enabled.updatedAt.toISOString(),
          });
        } catch (err) {
          return send(reply, err);
        }
      },
    );

    app.get(
      `${BASE}/webhook-deliveries`,
      {
        schema: {
          tags: ['webhooks'],
          summary: 'Webhook delivery dashboard (failures / dead / all)',
          description:
            'Permanently failing endpoints are disabled rather than silently dropped (ADR §2.4). Filter with `status=failed` or `status=dead`.',
          querystring: {
            type: 'object',
            required: ['merchantId'],
            properties: {
              merchantId: { type: 'string', format: 'uuid' },
              status: { type: 'string', enum: ['pending', 'delivered', 'failed', 'dead'] },
              limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
            },
          },
          response: { 200: { type: 'array', items: deliverySchema }, 401: errorSchema, 403: errorSchema, 404: errorSchema },
        },
      },
      async (
        req: FastifyRequest<{
          Querystring: { merchantId: string; status?: WebhookDeliveryStatus; limit?: number };
        }>,
        reply,
      ) => {
        const principal = principalOf(req, reply, 'pay:read');
        if (!principal) return reply;
        try {
          await assertAccess(principal.userId, req.query.merchantId, areaForSurface('rest.webhooks.read'));
          const rows = await webhooks.listDeliveries(req.query.merchantId, {
            status: req.query.status,
            limit: req.query.limit,
          });
          return reply.send(
            rows.map((d) => ({
              id: d.id,
              endpointId: d.endpointId,
              merchantId: d.merchantId,
              eventId: d.eventId,
              eventType: d.eventType,
              status: d.status,
              attempts: d.attempts,
              nextAttemptAt: d.nextAttemptAt.toISOString(),
              lastStatusCode: d.lastStatusCode,
              lastError: d.lastError,
              createdAt: d.createdAt.toISOString(),
              deliveredAt: d.deliveredAt ? d.deliveredAt.toISOString() : null,
            })),
          );
        } catch (err) {
          return send(reply, err);
        }
      },
    );
  }

  // ── D26-P1-P2 — PayFac permission product path (REST translation of tRPC) ──
  // Mounted only when `trees` is a full SubMerchantService (boot already passes it).
  const permissions = isPayfacPermissionPort(deps.trees) ? deps.trees : null;
  if (permissions) {
    const areaEnum = [...PERMISSION_AREAS];
    const grantBody = {
      type: 'object',
      required: ['granteeMerchantId', 'subjectMerchantId', 'area', 'reason'],
      additionalProperties: false,
      properties: {
        granteeMerchantId: { type: 'string', format: 'uuid' },
        subjectMerchantId: { type: 'string', format: 'uuid' },
        area: { type: 'string', enum: areaEnum },
        reason: { type: 'string', minLength: 3, maxLength: 500 },
      },
    } as const;
    const eventSchema = {
      type: 'object',
      required: [
        'id',
        'seq',
        'granteeMerchantId',
        'subjectMerchantId',
        'area',
        'action',
        'reason',
        'actorId',
        'actorMerchantId',
        'actorScope',
        'createdAt',
      ],
      properties: {
        id: { type: 'string', format: 'uuid' },
        seq: { type: 'string' },
        granteeMerchantId: { type: 'string', format: 'uuid' },
        subjectMerchantId: { type: 'string', format: 'uuid' },
        area: { type: 'string' },
        action: { type: 'string', enum: ['grant', 'revoke'] },
        reason: { type: 'string' },
        actorId: { type: 'string' },
        actorMerchantId: { type: 'string', format: 'uuid' },
        actorScope: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    } as const;
    const grantSchema = {
      type: 'object',
      required: ['granteeMerchantId', 'subjectMerchantId', 'area', 'reason', 'actorId', 'actorMerchantId', 'grantedAt'],
      properties: {
        granteeMerchantId: { type: 'string', format: 'uuid' },
        subjectMerchantId: { type: 'string', format: 'uuid' },
        area: { type: 'string' },
        reason: { type: 'string' },
        actorId: { type: 'string' },
        actorMerchantId: { type: 'string', format: 'uuid' },
        grantedAt: { type: 'string', format: 'date-time' },
      },
    } as const;

    app.get(
      `${BASE}/submerchant-permissions/areas`,
      {
        schema: {
          tags: ['payfac-permissions'],
          summary: 'Permission area vocabulary (eleven surfaces; not fourteen)',
          response: { 200: { type: 'array', items: { type: 'string' } }, 401: errorSchema },
        },
      },
      async (req, reply) => {
        const principal = principalOf(req, reply, 'pay:read');
        if (!principal) return reply;
        return reply.send([...PERMISSION_AREAS]);
      },
    );

    app.get(
      `${BASE}/submerchant-permissions`,
      {
        schema: {
          tags: ['payfac-permissions'],
          summary: 'Live grants over a subject merchant (implicit root/self authority omitted)',
          querystring: {
            type: 'object',
            required: ['subjectMerchantId'],
            properties: { subjectMerchantId: { type: 'string', format: 'uuid' } },
          },
          response: { 200: { type: 'array', items: grantSchema }, 401: errorSchema, 403: errorSchema, 404: errorSchema },
        },
      },
      async (req: FastifyRequest<{ Querystring: { subjectMerchantId: string } }>, reply) => {
        const principal = principalOf(req, reply, 'pay:read');
        if (!principal) return reply;
        try {
          const actorMerchantId = await resolveActorMerchantId(deps.pay, principal.userId);
          const rows = await permissions.listPermissions(actorMerchantId, req.query.subjectMerchantId);
          return reply.send(
            rows.map((r) => ({
              granteeMerchantId: r.granteeMerchantId,
              subjectMerchantId: r.subjectMerchantId,
              area: r.area,
              reason: r.reason,
              actorId: r.actorId,
              actorMerchantId: r.actorMerchantId,
              grantedAt: r.grantedAt.toISOString(),
            })),
          );
        } catch (err) {
          return send(reply, err);
        }
      },
    );

    app.get(
      `${BASE}/submerchant-permissions/history`,
      {
        schema: {
          tags: ['payfac-permissions'],
          summary: 'Grant and revoke journal for a subject, newest first',
          querystring: {
            type: 'object',
            required: ['subjectMerchantId'],
            properties: {
              subjectMerchantId: { type: 'string', format: 'uuid' },
              limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
            },
          },
          response: { 200: { type: 'array', items: eventSchema }, 401: errorSchema, 403: errorSchema, 404: errorSchema },
        },
      },
      async (req: FastifyRequest<{ Querystring: { subjectMerchantId: string; limit?: number } }>, reply) => {
        const principal = principalOf(req, reply, 'pay:read');
        if (!principal) return reply;
        try {
          const actorMerchantId = await resolveActorMerchantId(deps.pay, principal.userId);
          const rows = await permissions.permissionHistory(actorMerchantId, req.query.subjectMerchantId, req.query.limit ?? 50);
          return reply.send(
            rows.map((r) => ({
              id: r.id,
              seq: r.seq,
              granteeMerchantId: r.granteeMerchantId,
              subjectMerchantId: r.subjectMerchantId,
              area: r.area,
              action: r.action,
              reason: r.reason,
              actorId: r.actorId,
              actorMerchantId: r.actorMerchantId,
              actorScope: r.actorScope,
              createdAt: r.createdAt.toISOString(),
            })),
          );
        } catch (err) {
          return send(reply, err);
        }
      },
    );

    app.post(
      `${BASE}/submerchant-permissions/grant`,
      {
        schema: {
          tags: ['payfac-permissions'],
          summary: 'Grant an area the caller already holds (reason required; append-only journal)',
          body: grantBody,
          response: { 200: eventSchema, 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
        },
      },
      async (
        req: FastifyRequest<{
          Body: { granteeMerchantId: string; subjectMerchantId: string; area: PermissionArea; reason: string };
        }>,
        reply,
      ) => {
        const principal = principalOf(req, reply, 'pay:write');
        if (!principal) return reply;
        try {
          const actorMerchantId = await resolveActorMerchantId(deps.pay, principal.userId);
          const event = await permissions.grantPermission({
            actorMerchantId,
            granteeMerchantId: req.body.granteeMerchantId,
            subjectMerchantId: req.body.subjectMerchantId,
            area: req.body.area,
            reason: req.body.reason,
            actorId: principal.userId,
            actorScope: 'pay:write',
          });
          return reply.send({
            id: event.id,
            seq: event.seq,
            granteeMerchantId: event.granteeMerchantId,
            subjectMerchantId: event.subjectMerchantId,
            area: event.area,
            action: event.action,
            reason: event.reason,
            actorId: event.actorId,
            actorMerchantId: event.actorMerchantId,
            actorScope: event.actorScope,
            createdAt: event.createdAt.toISOString(),
          });
        } catch (err) {
          return send(reply, err);
        }
      },
    );

    app.post(
      `${BASE}/submerchant-permissions/revoke`,
      {
        schema: {
          tags: ['payfac-permissions'],
          summary: 'Revoke a live grant — new journal row, never an edit',
          body: grantBody,
          response: { 200: eventSchema, 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
        },
      },
      async (
        req: FastifyRequest<{
          Body: { granteeMerchantId: string; subjectMerchantId: string; area: PermissionArea; reason: string };
        }>,
        reply,
      ) => {
        const principal = principalOf(req, reply, 'pay:write');
        if (!principal) return reply;
        try {
          const actorMerchantId = await resolveActorMerchantId(deps.pay, principal.userId);
          const event = await permissions.revokePermission({
            actorMerchantId,
            granteeMerchantId: req.body.granteeMerchantId,
            subjectMerchantId: req.body.subjectMerchantId,
            area: req.body.area,
            reason: req.body.reason,
            actorId: principal.userId,
            actorScope: 'pay:write',
          });
          return reply.send({
            id: event.id,
            seq: event.seq,
            granteeMerchantId: event.granteeMerchantId,
            subjectMerchantId: event.subjectMerchantId,
            area: event.area,
            action: event.action,
            reason: event.reason,
            actorId: event.actorId,
            actorMerchantId: event.actorMerchantId,
            actorScope: event.actorScope,
            createdAt: event.createdAt.toISOString(),
          });
        } catch (err) {
          return send(reply, err);
        }
      },
    );
  }
}

/**
 * REST payment body. Same money fields as tRPC `toPaymentOut`, plus `mode`
 * (sandbox honesty — ADR §2.5) derived from the rail id, never invented.
 */
function toPaymentBody(view: {
  id: string;
  merchantId: string;
  profileId: string | null;
  amount: Amount;
  assetId: string;
  method: string | null;
  railAdapter: string | null;
  railRef: string | null;
  status: PaymentStatus;
  capturedAmount: Amount;
  refundedAmount: Amount;
  createdAt: Date;
}) {
  const mode: 'live' | 'sandbox' = view.railAdapter && isSandboxRailId(view.railAdapter) ? 'sandbox' : 'live';
  return {
    id: view.id,
    merchantId: view.merchantId,
    profileId: view.profileId,
    amount: formatAmount(view.amount),
    assetId: view.assetId,
    method: view.method,
    railAdapter: view.railAdapter,
    railRef: view.railRef,
    status: view.status,
    mode,
    capturedAmount: formatAmount(view.capturedAmount),
    refundedAmount: formatAmount(view.refundedAmount),
    createdAt: view.createdAt.toISOString(),
  };
}
