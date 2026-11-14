import { createHash, randomBytes } from 'node:crypto';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import {
  PayError,
  assertDueWebhookDeliveriesBatchLimit,
  assertWebhookDeliveryListLimit,
  assertWebhookEndpointListLimit,
  type PaymentStatus,
  type PaymentView,
} from './payment-service.js';
import { paymentModeFromRail } from './sandbox-key-routing.js';
import { signPayload } from './rails/webhook-signature.js';
import { pinnedPost, type WebhookTransport } from './webhook-pinned-post.js';
import {
  assertPublicWebhookUrl,
  publicDnsResolver,
  resolvePublicAddresses,
  systemResolver,
  type ResolvedAddress,
  type WebhookResolver,
} from './webhook-url-guard.js';

/**
 * Outbound merchant webhooks — `pay.public-api` step 3.
 *
 * Law: docs/adr/2026-08-07-pay-public-api-law.md §2.4.
 *
 *   · HMAC-SHA256 over `timestamp + "." + raw body` → `X-Intafaced-Signature`
 *     (two comma-separated signatures while a rolled secret's overlap lasts)
 *   · At-least-once; merchants dedupe on `id` (event id)
 *   · Retry on the owner's retry policy; a blank policy sends nothing. A permanently
 *     failing endpoint, or one that answers 410 Gone, is disabled and listed on the
 *     failure dashboard — never silently dropped
 *   · Every attempt is journalled (outcome, response code, time taken)
 *   · Body carries STATE (current payment shape), not instructions
 *
 * Reuses the same `signPayload` the inbound rail path uses so there is one
 * way to get HMAC right. This module does not move value.
 */

/** Every public event type, in the catalogue's order (merchant-ops/webhook-catalogue.ts publishes each one's payload). */
export const MERCHANT_WEBHOOK_EVENT_TYPES = ['payment.authorized', 'payment.captured', 'payment.refunded', 'payment.failed'] as const;
export type MerchantWebhookEventType = (typeof MERCHANT_WEBHOOK_EVENT_TYPES)[number];

export type WebhookEndpointStatus = 'active' | 'disabled';
/**
 * `unknown`: the attempt timed out after the request may have reached the receiver, so whether it arrived is not
 * known. It is tried again only once its lease has passed, never while another worker could still be sending it.
 */
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead' | 'unknown';
export type WebhookAttemptOutcome = 'delivered' | 'failed' | 'unknown';

export interface MerchantWebhookEndpoint {
  readonly id: string;
  readonly merchantId: string;
  readonly url: string;
  readonly status: WebhookEndpointStatus;
  readonly disabledReason: string | null;
  readonly consecutiveFailures: number;
  /** The event types this endpoint subscribed to; an event of any other type writes no delivery for it. */
  readonly eventTypes: readonly MerchantWebhookEventType[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Returned once on create — the only time the signing secret is shown. */
export interface MerchantWebhookEndpointCreated extends MerchantWebhookEndpoint {
  readonly secret: string;
}

export interface MerchantWebhookDelivery {
  readonly id: string;
  readonly endpointId: string;
  readonly merchantId: string;
  readonly eventId: string;
  readonly eventType: MerchantWebhookEventType;
  readonly payload: unknown;
  readonly status: WebhookDeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
}

/** A due delivery as the worker holds it: where to send it and which secrets sign it. */
export interface ClaimedWebhookDelivery extends MerchantWebhookDelivery {
  readonly secret: string;
  readonly url: string;
  /** The secret a roll replaced, while its overlap lasts (`previousSecretUntil` in the future). */
  readonly previousSecret: string | null;
  readonly previousSecretUntil: Date | null;
  /** The resend request this attempt answers, if a person asked for it (merchant-ops/webhooks.ts). */
  readonly resendRequestId: string | null;
}

/** One attempt's journal row. Written in the same statement that records the delivery's new state. */
export interface WebhookAttempt {
  readonly deliveryId: string;
  readonly merchantId: string;
  readonly attemptNo: number;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly outcome: WebhookAttemptOutcome;
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly resendRequestId: string | null;
}

/** What one attempt leaves on the delivery row. */
export interface WebhookAttemptResult {
  readonly status: WebhookDeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly deliveredAt: Date | null;
  readonly attempt: WebhookAttempt;
}

export interface PaymentEventNotify {
  readonly type: MerchantWebhookEventType;
  readonly payment: PaymentView;
}

/** Injectable clock + HTTP for tests. */
export interface MerchantWebhookRuntime {
  readonly now?: () => Date;
  /**
   * Opens the connection to an already-vetted address (see webhook-pinned-post.ts).
   * Replaces `fetch`: `fetch` re-resolves the hostname, which defeats the SSRF guard.
   */
  readonly transport?: WebhookTransport;
  /**
   * DNS for the delivery-time SSRF check. Must return every answer. Default: c-ares with
   * its own timeout (production) or `dns.lookup` when `allowLocalHttp` (dev/test, so
   * `localhost` resolves). Either way the call sits inside the delivery deadline.
   */
  readonly resolver?: WebhookResolver;
  /**
   * Permit http and loopback receivers. dev/test only — the service wiring sets
   * it from an explicit APP_ENV of `dev` or `test`. Default false (production posture).
   */
  readonly allowLocalHttp?: boolean;
  /** Consecutive delivery failures before an endpoint is disabled (ADR §2.4). */
  readonly disableAfterFailures?: number;
  /** Attempts before a delivery is marked `dead`. Defaults to one first attempt plus one per retry in the policy. */
  readonly maxAttempts?: number;
  /**
   * The retry policy, an owner value (`PAY_WEBHOOK_RETRY_SCHEDULE_SECONDS`): the wait before each retry, in seconds.
   * Blank (`null` or absent) sends nothing at all: deliveries wait as `pending` and the dashboard says why. No
   * schedule is invented here.
   */
  readonly retryScheduleSeconds?: readonly number[] | null;
}

const DEFAULT_DISABLE_AFTER = 5;
/** One deadline per delivery attempt: DNS + connect + response headers, all inside it. */
const DELIVERY_TIMEOUT_MS = 10_000;

class DeadlineExceeded extends Error {}

/** Rejects with DeadlineExceeded after `ms`; the underlying work is abandoned, not cancelled. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceeded('deadline')), Math.max(0, ms));
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** A timed-out POST: the receiver may have taken it, so the outcome is unknown rather than failed. */
function isTimeout(err: unknown): boolean {
  if (err instanceof DeadlineExceeded) return true;
  const name = (err as { name?: unknown } | null)?.name;
  const code = (err as { code?: unknown } | null)?.code;
  return name === 'TimeoutError' || name === 'AbortError' || code === 'ABORT_ERR' || code === 23;
}

/**
 * How long a worker owns a due row after `claimDue`.
 *
 * claimDue advances `next_attempt_at` into the future so a second replica
 * (FOR UPDATE SKIP LOCKED) will not POST the same delivery while this one is
 * in flight. Crash before the attempt is recorded: the lease expires and
 * another worker retries — at-least-once, never silently dropped. An attempt
 * that ends `unknown` keeps the lease: it is not tried again before it ends.
 */
export const WEBHOOK_CLAIM_LEASE_MS = 60_000;

/** The disabled reason an endpoint gets when its receiver answers 410 Gone. */
export const WEBHOOK_GONE_REASON = 'receiver_gone';

export function eventIdFor(type: MerchantWebhookEventType, payment: PaymentView): string {
  if (type === 'payment.refunded') {
    return `${type}:${payment.id}:${formatAmount(payment.refundedAmount)}`;
  }
  return `${type}:${payment.id}`;
}

export function paymentStateBody(payment: PaymentView): Record<string, unknown> {
  return {
    id: payment.id,
    merchantId: payment.merchantId,
    profileId: payment.profileId,
    amount: formatAmount(payment.amount),
    assetId: payment.assetId,
    method: payment.method,
    railAdapter: payment.railAdapter,
    railRef: payment.railRef,
    status: payment.status as PaymentStatus,
    mode: paymentModeFromRail(payment.railAdapter),
    capturedAmount: formatAmount(payment.capturedAmount as Amount),
    refundedAmount: formatAmount(payment.refundedAmount as Amount),
    createdAt: payment.createdAt.toISOString(),
  };
}

/**
 * The signed headers. While a rolled secret's overlap lasts, the signature header carries two signatures, the new
 * secret's first, separated by a comma: a receiver holding either secret finds one that matches.
 */
export function buildSignedHeaders(
  secret: string,
  timestamp: string,
  rawBody: string,
  previousSecret?: string | null,
): Record<string, string> {
  const signatures = [
    signPayload(secret, timestamp, rawBody),
    ...(previousSecret ? [signPayload(previousSecret, timestamp, rawBody)] : []),
  ];
  return {
    'content-type': 'application/json',
    'x-intafaced-timestamp': timestamp,
    'x-intafaced-signature': signatures.join(','),
  };
}

function newId(): string {
  // uuid v4 shape without depending on crypto.randomUUID availability quirks in tests
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function secretFor(): string {
  return randomBytes(32).toString('hex');
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

// ── Store ports ─────────────────────────────────────────────────────────────

export interface MerchantWebhookStore {
  insertEndpoint(row: {
    id: string;
    merchantId: string;
    url: string;
    secretHash: string;
    secretEncrypted: string;
    /** Omitted: every public event type. */
    eventTypes?: readonly MerchantWebhookEventType[];
  }): Promise<MerchantWebhookEndpoint>;
  listEndpoints(merchantId: string, opts: { limit: number }): Promise<MerchantWebhookEndpoint[]>;
  /**
   * Dispatch fan-out — every active receiver subscribed to `eventType`. Not a client page; never invent a 50-row cut.
   */
  listActiveEndpoints(merchantId: string, eventType: MerchantWebhookEventType): Promise<MerchantWebhookEndpoint[]>;
  getEndpoint(id: string): Promise<(MerchantWebhookEndpoint & { secret: string }) | null>;
  setEndpointStatus(id: string, status: WebhookEndpointStatus, reason: string | null, consecutiveFailures: number): Promise<void>;
  bumpEndpointFailure(id: string): Promise<number>;
  resetEndpointFailures(id: string): Promise<void>;
  /** Insert delivery; return null if (endpointId, eventId) already exists. */
  insertDelivery(row: {
    id: string;
    endpointId: string;
    merchantId: string;
    eventId: string;
    eventType: MerchantWebhookEventType;
    payload: unknown;
    nextAttemptAt: Date;
  }): Promise<MerchantWebhookDelivery | null>;
  claimDue(limit: number, now: Date): Promise<ClaimedWebhookDelivery[]>;
  /** The delivery's new state and its attempt's journal row, together. Clears the resend request it answered. */
  finishAttempt(id: string, result: WebhookAttemptResult): Promise<void>;
  listDeliveries(merchantId: string, opts: { status?: WebhookDeliveryStatus; limit: number }): Promise<MerchantWebhookDelivery[]>;
  listAttempts(merchantId: string, deliveryId: string): Promise<WebhookAttempt[]>;
}

type MemEndpoint = {
  id: string;
  merchantId: string;
  url: string;
  status: WebhookEndpointStatus;
  disabledReason: string | null;
  consecutiveFailures: number;
  eventTypes: MerchantWebhookEventType[];
  createdAt: Date;
  updatedAt: Date;
  secret: string;
  secretHash: string;
  previousSecret: string | null;
  previousSecretUntil: Date | null;
};
type MemDelivery = {
  id: string;
  endpointId: string;
  merchantId: string;
  eventId: string;
  eventType: MerchantWebhookEventType;
  payload: unknown;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
  resendRequestId: string | null;
};

/** The statuses a worker may claim once due. */
const CLAIMABLE: ReadonlySet<WebhookDeliveryStatus> = new Set(['pending', 'failed', 'unknown']);

/** In-memory store — unit tests / single-process local. Not multi-replica. */
export class MemoryMerchantWebhookStore implements MerchantWebhookStore {
  readonly endpoints = new Map<string, MemEndpoint>();
  readonly deliveries = new Map<string, MemDelivery>();
  readonly attempts: WebhookAttempt[] = [];

  async insertEndpoint(row: {
    id: string;
    merchantId: string;
    url: string;
    secretHash: string;
    secretEncrypted: string;
    eventTypes?: readonly MerchantWebhookEventType[];
  }): Promise<MerchantWebhookEndpoint> {
    const now = new Date();
    const ep: MemEndpoint = {
      id: row.id,
      merchantId: row.merchantId,
      url: row.url,
      status: 'active',
      disabledReason: null,
      consecutiveFailures: 0,
      eventTypes: [...(row.eventTypes ?? MERCHANT_WEBHOOK_EVENT_TYPES)],
      createdAt: now,
      updatedAt: now,
      secret: row.secretEncrypted,
      secretHash: row.secretHash,
      previousSecret: null,
      previousSecretUntil: null,
    };
    this.endpoints.set(ep.id, ep);
    return publicEndpoint(ep);
  }

  async listEndpoints(merchantId: string, opts: { limit: number }): Promise<MerchantWebhookEndpoint[]> {
    return [...this.endpoints.values()]
      .filter((e) => e.merchantId === merchantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, opts.limit)
      .map(publicEndpoint);
  }

  async listActiveEndpoints(merchantId: string, eventType: MerchantWebhookEventType): Promise<MerchantWebhookEndpoint[]> {
    return [...this.endpoints.values()]
      .filter((e) => e.merchantId === merchantId && e.status === 'active' && e.eventTypes.includes(eventType))
      .map(publicEndpoint);
  }

  async getEndpoint(id: string): Promise<(MerchantWebhookEndpoint & { secret: string }) | null> {
    const ep = this.endpoints.get(id);
    if (!ep) return null;
    return { ...publicEndpoint(ep), secret: ep.secret };
  }

  async setEndpointStatus(id: string, status: WebhookEndpointStatus, reason: string | null, consecutiveFailures: number): Promise<void> {
    const ep = this.endpoints.get(id);
    if (!ep) return;
    ep.status = status;
    ep.disabledReason = reason;
    ep.consecutiveFailures = consecutiveFailures;
    ep.updatedAt = new Date();
  }

  async bumpEndpointFailure(id: string): Promise<number> {
    const ep = this.endpoints.get(id);
    if (!ep) return 0;
    ep.consecutiveFailures += 1;
    ep.updatedAt = new Date();
    return ep.consecutiveFailures;
  }

  async resetEndpointFailures(id: string): Promise<void> {
    const ep = this.endpoints.get(id);
    if (!ep) return;
    ep.consecutiveFailures = 0;
    ep.updatedAt = new Date();
  }

  async insertDelivery(row: {
    id: string;
    endpointId: string;
    merchantId: string;
    eventId: string;
    eventType: MerchantWebhookEventType;
    payload: unknown;
    nextAttemptAt: Date;
  }): Promise<MerchantWebhookDelivery | null> {
    for (const d of this.deliveries.values()) {
      if (d.endpointId === row.endpointId && d.eventId === row.eventId) return null;
    }
    const now = new Date();
    const delivery: MemDelivery = {
      id: row.id,
      endpointId: row.endpointId,
      merchantId: row.merchantId,
      eventId: row.eventId,
      eventType: row.eventType,
      payload: row.payload,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: row.nextAttemptAt,
      lastStatusCode: null,
      lastError: null,
      createdAt: now,
      deliveredAt: null,
      resendRequestId: null,
    };
    this.deliveries.set(delivery.id, delivery);
    return publicDelivery(delivery);
  }

  async claimDue(limit: number, now: Date): Promise<ClaimedWebhookDelivery[]> {
    const leaseUntil = new Date(now.getTime() + WEBHOOK_CLAIM_LEASE_MS);
    const due = [...this.deliveries.values()]
      .filter((d) => CLAIMABLE.has(d.status))
      .filter((d) => d.nextAttemptAt.getTime() <= now.getTime())
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);
    const out: ClaimedWebhookDelivery[] = [];
    for (const d of due) {
      const ep = this.endpoints.get(d.endpointId);
      if (!ep || ep.status !== 'active') continue;
      // Lease: concurrent processDue in the same process will not re-select this row.
      d.nextAttemptAt = leaseUntil;
      out.push({
        ...publicDelivery(d),
        secret: ep.secret,
        url: ep.url,
        previousSecret: ep.previousSecret,
        previousSecretUntil: ep.previousSecretUntil,
        resendRequestId: d.resendRequestId,
      });
    }
    return out;
  }

  async finishAttempt(id: string, result: WebhookAttemptResult): Promise<void> {
    const d = this.deliveries.get(id);
    if (!d) return;
    d.status = result.status;
    d.attempts = result.attempts;
    d.nextAttemptAt = result.nextAttemptAt;
    d.lastStatusCode = result.statusCode;
    d.lastError = result.error;
    if (result.deliveredAt) d.deliveredAt = result.deliveredAt;
    d.resendRequestId = null;
    this.attempts.push(result.attempt);
  }

  async listDeliveries(merchantId: string, opts: { status?: WebhookDeliveryStatus; limit: number }): Promise<MerchantWebhookDelivery[]> {
    return [...this.deliveries.values()]
      .filter((d) => d.merchantId === merchantId)
      .filter((d) => (opts.status ? d.status === opts.status : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, opts.limit)
      .map(publicDelivery);
  }

  async listAttempts(merchantId: string, deliveryId: string): Promise<WebhookAttempt[]> {
    return this.attempts
      .filter((a) => a.merchantId === merchantId && a.deliveryId === deliveryId)
      .sort((a, b) => a.attemptNo - b.attemptNo);
  }

  /** Test seam: a roll with overlap, as merchant-ops `rotateSecret` writes it. */
  rollSecret(id: string, secret: string, overlapUntil: Date | null): void {
    const ep = this.endpoints.get(id);
    if (!ep) return;
    ep.previousSecret = overlapUntil ? ep.secret : null;
    ep.previousSecretUntil = overlapUntil;
    ep.secret = secret;
  }

  /** Test seam: a resend request, as merchant-ops `retry` writes it. */
  requestResend(deliveryId: string, requestId: string, now: Date): void {
    const d = this.deliveries.get(deliveryId);
    if (!d) return;
    d.status = 'pending';
    d.nextAttemptAt = now;
    d.resendRequestId = requestId;
  }
}

function publicEndpoint(ep: MemEndpoint): MerchantWebhookEndpoint {
  return {
    id: ep.id,
    merchantId: ep.merchantId,
    url: ep.url,
    status: ep.status,
    disabledReason: ep.disabledReason,
    consecutiveFailures: ep.consecutiveFailures,
    eventTypes: [...ep.eventTypes],
    createdAt: ep.createdAt,
    updatedAt: ep.updatedAt,
  };
}

function publicDelivery(d: MemDelivery): MerchantWebhookDelivery {
  const { resendRequestId: _resend, ...rest } = d;
  return { ...rest };
}

export type WebhookSql = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (strings: TemplateStringsArray, ...values: any[]): Promise<readonly any[]>;
};

/**
 * Durable Postgres store. Secrets are stored as the raw signing secret for the
 * HMAC (same posture as rail webhook secrets in env today — not Class X go-live
 * key custody). Hash is kept for optional rotation audits.
 */
export class PostgresMerchantWebhookStore implements MerchantWebhookStore {
  constructor(private readonly sql: WebhookSql) {}

  async insertEndpoint(row: {
    id: string;
    merchantId: string;
    url: string;
    secretHash: string;
    secretEncrypted: string;
    eventTypes?: readonly MerchantWebhookEventType[];
  }): Promise<MerchantWebhookEndpoint> {
    const eventTypes = [...(row.eventTypes ?? MERCHANT_WEBHOOK_EVENT_TYPES)];
    const rows = (await this.sql`
      INSERT INTO pay.merchant_webhook_endpoints
        (id, merchant_id, url, secret_hash, signing_secret, status, consecutive_failures, event_types)
      VALUES
        (${row.id}, ${row.merchantId}, ${row.url}, ${row.secretHash}, ${row.secretEncrypted}, 'active', 0, ${eventTypes}::text[])
      RETURNING id, merchant_id, url, status, disabled_reason, consecutive_failures, event_types, created_at, updated_at
    `) as ReadonlyArray<EndpointRow>;
    return mapEndpoint(rows[0]!);
  }

  async listEndpoints(merchantId: string, opts: { limit: number }): Promise<MerchantWebhookEndpoint[]> {
    const rows = (await this.sql`
      SELECT id, merchant_id, url, status, disabled_reason, consecutive_failures, event_types, created_at, updated_at
        FROM pay.merchant_webhook_endpoints
       WHERE merchant_id = ${merchantId}
       ORDER BY created_at DESC
       LIMIT ${opts.limit}
    `) as ReadonlyArray<EndpointRow>;
    return rows.map(mapEndpoint);
  }

  async listActiveEndpoints(merchantId: string, eventType: MerchantWebhookEventType): Promise<MerchantWebhookEndpoint[]> {
    const rows = (await this.sql`
      SELECT id, merchant_id, url, status, disabled_reason, consecutive_failures, event_types, created_at, updated_at
        FROM pay.merchant_webhook_endpoints
       WHERE merchant_id = ${merchantId} AND status = 'active' AND ${eventType} = ANY(event_types)
       ORDER BY created_at DESC
    `) as ReadonlyArray<EndpointRow>;
    return rows.map(mapEndpoint);
  }

  async getEndpoint(id: string): Promise<(MerchantWebhookEndpoint & { secret: string }) | null> {
    const rows = (await this.sql`
      SELECT id, merchant_id, url, status, disabled_reason, consecutive_failures, event_types,
             created_at, updated_at, signing_secret
        FROM pay.merchant_webhook_endpoints
       WHERE id = ${id}
    `) as ReadonlyArray<EndpointRow & { signing_secret: string }>;
    const row = rows[0];
    if (!row) return null;
    return { ...mapEndpoint(row), secret: row.signing_secret };
  }

  async setEndpointStatus(id: string, status: WebhookEndpointStatus, reason: string | null, consecutiveFailures: number): Promise<void> {
    await this.sql`
      UPDATE pay.merchant_webhook_endpoints
         SET status = ${status},
             disabled_reason = ${reason},
             consecutive_failures = ${consecutiveFailures},
             updated_at = now()
       WHERE id = ${id}
    `;
  }

  async bumpEndpointFailure(id: string): Promise<number> {
    const rows = (await this.sql`
      UPDATE pay.merchant_webhook_endpoints
         SET consecutive_failures = consecutive_failures + 1,
             updated_at = now()
       WHERE id = ${id}
       RETURNING consecutive_failures
    `) as ReadonlyArray<{ consecutive_failures: number }>;
    return rows[0]?.consecutive_failures ?? 0;
  }

  async resetEndpointFailures(id: string): Promise<void> {
    await this.sql`
      UPDATE pay.merchant_webhook_endpoints
         SET consecutive_failures = 0, updated_at = now()
       WHERE id = ${id}
    `;
  }

  async insertDelivery(row: {
    id: string;
    endpointId: string;
    merchantId: string;
    eventId: string;
    eventType: MerchantWebhookEventType;
    payload: unknown;
    nextAttemptAt: Date;
  }): Promise<MerchantWebhookDelivery | null> {
    const rows = (await this.sql`
      INSERT INTO pay.merchant_webhook_deliveries
        (id, endpoint_id, merchant_id, event_id, event_type, payload, status, attempts, next_attempt_at)
      VALUES
        (${row.id}, ${row.endpointId}, ${row.merchantId}, ${row.eventId}, ${row.eventType},
         ${row.payload as never}, 'pending', 0, ${row.nextAttemptAt.toISOString()})
      ON CONFLICT (endpoint_id, event_id) DO NOTHING
      RETURNING id, endpoint_id, merchant_id, event_id, event_type, payload, status, attempts,
                next_attempt_at, last_status_code, last_error, created_at, delivered_at
    `) as ReadonlyArray<DeliveryRow>;
    if (rows.length === 0) return null;
    return mapDelivery(rows[0]!);
  }

  async claimDue(limit: number, now: Date): Promise<ClaimedWebhookDelivery[]> {
    /**
     * Multi-replica claim (ADR §2.4 at-least-once, never silently dropped).
     *
     * CTE selects due rows with FOR UPDATE SKIP LOCKED so two drainers never
     * POST the same delivery concurrently. Advancing next_attempt_at leases the
     * row for WEBHOOK_CLAIM_LEASE_MS; a crashed worker's lease expires and
     * another replica retries. Merchants still dedupe on event id.
     */
    const leaseUntil = new Date(now.getTime() + WEBHOOK_CLAIM_LEASE_MS).toISOString();
    const nowIso = now.toISOString();
    const rows = (await this.sql`
      WITH due AS (
        SELECT d.id
          FROM pay.merchant_webhook_deliveries d
          JOIN pay.merchant_webhook_endpoints e ON e.id = d.endpoint_id
         WHERE e.status = 'active'
           AND d.status IN ('pending', 'failed', 'unknown')
           AND d.next_attempt_at <= ${nowIso}
         ORDER BY d.next_attempt_at ASC
         LIMIT ${limit}
         FOR UPDATE OF d SKIP LOCKED
      ),
      claimed AS (
        UPDATE pay.merchant_webhook_deliveries d
           SET next_attempt_at = ${leaseUntil}
          FROM due
         WHERE d.id = due.id
      RETURNING d.id, d.endpoint_id, d.merchant_id, d.event_id, d.event_type, d.payload, d.status,
                d.attempts, d.next_attempt_at, d.last_status_code, d.last_error, d.created_at, d.delivered_at,
                d.resend_request_id
      )
      SELECT c.id, c.endpoint_id, c.merchant_id, c.event_id, c.event_type, c.payload, c.status,
             c.attempts, c.next_attempt_at, c.last_status_code, c.last_error, c.created_at, c.delivered_at,
             c.resend_request_id, e.signing_secret, e.url, e.previous_signing_secret, e.previous_secret_until
        FROM claimed c
        JOIN pay.merchant_webhook_endpoints e ON e.id = c.endpoint_id
    `) as ReadonlyArray<
      DeliveryRow & {
        signing_secret: string;
        url: string;
        previous_signing_secret: string | null;
        previous_secret_until: Date | string | null;
        resend_request_id: string | null;
      }
    >;
    return rows.map((r) => ({
      ...mapDelivery(r),
      secret: r.signing_secret,
      url: r.url,
      previousSecret: r.previous_signing_secret,
      previousSecretUntil: r.previous_secret_until ? new Date(r.previous_secret_until) : null,
      resendRequestId: r.resend_request_id,
    }));
  }

  async finishAttempt(id: string, result: WebhookAttemptResult): Promise<void> {
    const a = result.attempt;
    // One statement: the row's new state and its journal line land together or not at all.
    await this.sql`
      WITH updated AS (
        UPDATE pay.merchant_webhook_deliveries
           SET status = ${result.status},
               attempts = ${result.attempts},
               next_attempt_at = ${result.nextAttemptAt.toISOString()},
               last_status_code = ${result.statusCode},
               last_error = ${result.error},
               delivered_at = COALESCE(${result.deliveredAt ? result.deliveredAt.toISOString() : null}::timestamptz, delivered_at),
               resend_request_id = NULL
         WHERE id = ${id}
         RETURNING id
      )
      INSERT INTO pay.merchant_webhook_attempts
        (delivery_id, merchant_id, attempt_no, started_at, finished_at, outcome, status_code, error, resend_request_id)
      SELECT updated.id, ${a.merchantId}, ${a.attemptNo}, ${a.startedAt.toISOString()}, ${a.finishedAt.toISOString()},
             ${a.outcome}, ${a.statusCode}, ${a.error}, ${a.resendRequestId}::uuid
        FROM updated
      ON CONFLICT DO NOTHING
    `;
  }

  async listDeliveries(merchantId: string, opts: { status?: WebhookDeliveryStatus; limit: number }): Promise<MerchantWebhookDelivery[]> {
    if (opts.status) {
      const rows = (await this.sql`
        SELECT id, endpoint_id, merchant_id, event_id, event_type, payload, status, attempts,
               next_attempt_at, last_status_code, last_error, created_at, delivered_at
          FROM pay.merchant_webhook_deliveries
         WHERE merchant_id = ${merchantId} AND status = ${opts.status}
         ORDER BY created_at DESC
         LIMIT ${opts.limit}
      `) as ReadonlyArray<DeliveryRow>;
      return rows.map(mapDelivery);
    }
    const rows = (await this.sql`
      SELECT id, endpoint_id, merchant_id, event_id, event_type, payload, status, attempts,
             next_attempt_at, last_status_code, last_error, created_at, delivered_at
        FROM pay.merchant_webhook_deliveries
       WHERE merchant_id = ${merchantId}
       ORDER BY created_at DESC
       LIMIT ${opts.limit}
    `) as ReadonlyArray<DeliveryRow>;
    return rows.map(mapDelivery);
  }

  async listAttempts(merchantId: string, deliveryId: string): Promise<WebhookAttempt[]> {
    const rows = (await this.sql`
      SELECT delivery_id, merchant_id, attempt_no, started_at, finished_at, outcome, status_code, error, resend_request_id
        FROM pay.merchant_webhook_attempts
       WHERE merchant_id = ${merchantId} AND delivery_id = ${deliveryId}
       ORDER BY attempt_no ASC
    `) as ReadonlyArray<{
      delivery_id: string;
      merchant_id: string;
      attempt_no: number;
      started_at: Date | string;
      finished_at: Date | string;
      outcome: WebhookAttemptOutcome;
      status_code: number | null;
      error: string | null;
      resend_request_id: string | null;
    }>;
    return rows.map((r) => ({
      deliveryId: r.delivery_id,
      merchantId: r.merchant_id,
      attemptNo: r.attempt_no,
      startedAt: new Date(r.started_at),
      finishedAt: new Date(r.finished_at),
      outcome: r.outcome,
      statusCode: r.status_code,
      error: r.error,
      resendRequestId: r.resend_request_id,
    }));
  }
}

type EndpointRow = {
  id: string;
  merchant_id: string;
  url: string;
  status: WebhookEndpointStatus;
  disabled_reason: string | null;
  consecutive_failures: number;
  event_types: MerchantWebhookEventType[] | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type DeliveryRow = {
  id: string;
  endpoint_id: string;
  merchant_id: string;
  event_id: string;
  event_type: MerchantWebhookEventType;
  payload: unknown;
  status: WebhookDeliveryStatus;
  attempts: number;
  next_attempt_at: Date | string;
  last_status_code: number | null;
  last_error: string | null;
  created_at: Date | string;
  delivered_at: Date | string | null;
};

function mapEndpoint(row: EndpointRow): MerchantWebhookEndpoint {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    url: row.url,
    status: row.status,
    disabledReason: row.disabled_reason,
    consecutiveFailures: row.consecutive_failures,
    eventTypes: [...(row.event_types ?? [])],
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapDelivery(row: DeliveryRow): MerchantWebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    merchantId: row.merchant_id,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: new Date(row.next_attempt_at),
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    createdAt: new Date(row.created_at),
    deliveredAt: row.delivered_at ? new Date(row.delivered_at) : null,
  };
}

// ── Service ─────────────────────────────────────────────────────────────────

/** What one drain pass did. `paused` names why it sent nothing at all. */
export interface WebhookDrainResult {
  readonly delivered: number;
  readonly failed: number;
  readonly unknown: number;
  readonly disabled: number;
  readonly paused?: 'pay.webhook_retry_policy_unset';
}

export class MerchantWebhookService {
  private readonly now: () => Date;
  private readonly transport: WebhookTransport;
  private readonly resolver: WebhookResolver;
  private readonly allowLocalHttp: boolean;
  private readonly retrySchedule: readonly number[] | null;
  private readonly maxAttempts: number;
  private readonly disableAfter: number;

  constructor(
    private readonly store: MerchantWebhookStore,
    runtime: MerchantWebhookRuntime = {},
  ) {
    this.now = runtime.now ?? (() => new Date());
    this.transport = runtime.transport ?? pinnedPost;
    this.allowLocalHttp = runtime.allowLocalHttp === true;
    this.resolver = runtime.resolver ?? (this.allowLocalHttp ? systemResolver : publicDnsResolver);
    const schedule = runtime.retryScheduleSeconds ?? null;
    this.retrySchedule = schedule && schedule.length > 0 && schedule.every((s) => Number.isSafeInteger(s) && s > 0) ? [...schedule] : null;
    this.maxAttempts = runtime.maxAttempts ?? (this.retrySchedule ? this.retrySchedule.length + 1 : 1);
    this.disableAfter = runtime.disableAfterFailures ?? DEFAULT_DISABLE_AFTER;
  }

  /** The retry policy this process sends by, or null when the owner has not set one (nothing is sent). */
  get retryPolicy(): readonly number[] | null {
    return this.retrySchedule;
  }

  async registerEndpoint(merchantId: string, url: string): Promise<MerchantWebhookEndpointCreated> {
    assertPublicWebhookUrl(url, { allowLocalHttp: this.allowLocalHttp });
    const secret = secretFor();
    const id = newId();
    const endpoint = await this.store.insertEndpoint({
      id,
      merchantId,
      url,
      secretHash: hashSecret(secret),
      secretEncrypted: secret,
    });
    return { ...endpoint, secret };
  }

  async listEndpoints(merchantId: string, limit?: number): Promise<MerchantWebhookEndpoint[]> {
    return this.store.listEndpoints(merchantId, { limit: assertWebhookEndpointListLimit(limit) });
  }

  async disableEndpoint(merchantId: string, endpointId: string, reason = 'disabled_by_merchant'): Promise<void> {
    const ep = await this.store.getEndpoint(endpointId);
    if (!ep || ep.merchantId !== merchantId) {
      throw new PayError('Webhook endpoint not found', 'pay.webhook_endpoint_not_found');
    }
    await this.store.setEndpointStatus(endpointId, 'disabled', reason, ep.consecutiveFailures);
  }

  /**
   * Re-enable a disabled endpoint after the merchant fixes their receiver.
   * ADR §2.4: permanently failing endpoints are disabled and surfaced — this
   * is the product path back to active (failure counter resets).
   */
  async enableEndpoint(merchantId: string, endpointId: string): Promise<MerchantWebhookEndpoint> {
    const ep = await this.store.getEndpoint(endpointId);
    if (!ep || ep.merchantId !== merchantId) {
      throw new PayError('Webhook endpoint not found', 'pay.webhook_endpoint_not_found');
    }
    await this.store.setEndpointStatus(endpointId, 'active', null, 0);
    const refreshed = await this.store.getEndpoint(endpointId);
    if (!refreshed) {
      throw new PayError('Webhook endpoint not found', 'pay.webhook_endpoint_not_found');
    }
    const { secret: _secret, ...publicEp } = refreshed;
    return publicEp;
  }

  /**
   * Enqueue one delivery per active endpoint of this merchant that subscribed to the event's type.
   * Dedup is (endpointId, eventId) — a re-notify of the same logical event is a no-op.
   */
  async enqueue(event: PaymentEventNotify): Promise<number> {
    const eventId = eventIdFor(event.type, event.payment);
    const createdAt = this.now().toISOString();
    const payload = {
      id: eventId,
      type: event.type,
      createdAt,
      data: { payment: paymentStateBody(event.payment) },
    };
    const endpoints = await this.store.listActiveEndpoints(event.payment.merchantId, event.type);
    let inserted = 0;
    for (const ep of endpoints) {
      const row = await this.store.insertDelivery({
        id: newId(),
        endpointId: ep.id,
        merchantId: event.payment.merchantId,
        eventId,
        eventType: event.type,
        payload,
        nextAttemptAt: this.now(),
      });
      if (row) inserted += 1;
    }
    return inserted;
  }

  /** Failure dashboard — dead + failed deliveries newest first. */
  async listDeliveries(
    merchantId: string,
    opts: { status?: WebhookDeliveryStatus; limit?: number } = {},
  ): Promise<MerchantWebhookDelivery[]> {
    return this.store.listDeliveries(merchantId, {
      status: opts.status,
      limit: assertWebhookDeliveryListLimit(opts.limit),
    });
  }

  /**
   * Process due deliveries. Safe to call on an interval from every replica
   * (Postgres uses SKIP LOCKED; memory store is single-process).
   *
   * `limit` is required. Omit used to invent a 25-row drain. Blank refuses.
   * Owner/drain may pass 25 explicitly. With no retry policy set, nothing is
   * claimed and nothing is sent (`paused`).
   */
  async processDue(limit?: number): Promise<WebhookDrainResult> {
    const batch = assertDueWebhookDeliveriesBatchLimit(limit);
    const schedule = this.retrySchedule;
    if (!schedule) return { delivered: 0, failed: 0, unknown: 0, disabled: 0, paused: 'pay.webhook_retry_policy_unset' };
    const due = await this.store.claimDue(batch, this.now());
    let delivered = 0;
    let failed = 0;
    let unknown = 0;
    let disabled = 0;

    const attemptOf = (
      item: ClaimedWebhookDelivery,
      startedAt: Date,
      outcome: WebhookAttemptOutcome,
      statusCode: number | null,
      error: string | null,
    ): WebhookAttempt => ({
      deliveryId: item.id,
      merchantId: item.merchantId,
      attemptNo: item.attempts + 1,
      startedAt,
      finishedAt: this.now(),
      outcome,
      statusCode,
      error,
      resendRequestId: item.resendRequestId,
    });

    /**
     * One attempt that did not deliver: wait the policy's next interval, count it against the endpoint, disable the
     * endpoint when it is exhausted or gone. Never dropped. An `unknown` outcome is not tried again before its lease ends.
     */
    const fail = async (
      item: ClaimedWebhookDelivery,
      startedAt: Date,
      statusCode: number | null,
      error: string,
      outcome: 'failed' | 'unknown' = 'failed',
    ): Promise<void> => {
      const attempts = item.attempts + 1;
      const gone = statusCode === 410;
      const dead = attempts >= this.maxAttempts || gone;
      const backoff = schedule[Math.min(attempts - 1, schedule.length - 1)]!;
      let next = new Date(this.now().getTime() + backoff * 1000);
      if (outcome === 'unknown' && item.nextAttemptAt.getTime() > next.getTime()) next = item.nextAttemptAt;
      await this.store.finishAttempt(item.id, {
        status: dead ? 'dead' : outcome,
        attempts,
        nextAttemptAt: next,
        statusCode,
        error,
        deliveredAt: null,
        attempt: attemptOf(item, startedAt, outcome, statusCode, error),
      });
      if (outcome === 'unknown') unknown += 1;
      else failed += 1;
      const consecutive = await this.store.bumpEndpointFailure(item.endpointId);
      if (gone || consecutive >= this.disableAfter || dead) {
        const reason = gone ? WEBHOOK_GONE_REASON : dead ? 'delivery_exhausted' : 'consecutive_failures';
        await this.store.setEndpointStatus(item.endpointId, 'disabled', reason, consecutive);
        disabled += 1;
      }
    };

    for (const item of due) {
      const startedAt = this.now();
      if (!item.secret || item.secret.trim().length < 32) {
        await fail(item, startedAt, null, 'pay.webhook_not_configured');
        continue;
      }

      // SSRF guard, every attempt: the stored URL may predate the guard, and DNS
      // can change between attempts. The addresses vetted here are the only ones we connect to.
      const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
      let url: URL;
      try {
        url = assertPublicWebhookUrl(item.url, { allowLocalHttp: this.allowLocalHttp });
      } catch {
        await fail(item, startedAt, null, 'webhook_target_not_public');
        continue;
      }
      let addresses: readonly ResolvedAddress[];
      try {
        addresses = await withDeadline(
          resolvePublicAddresses(url.hostname, this.resolver, { allowLoopback: this.allowLocalHttp }),
          deadline - Date.now(),
        );
      } catch (err) {
        // A hung nameserver is a failure to retry, not a refusal; either way nothing was POSTed.
        await fail(item, startedAt, null, err instanceof DeadlineExceeded ? 'webhook_dns_timeout' : 'webhook_target_not_public');
        continue;
      }

      const rawBody = JSON.stringify(item.payload);
      const now = this.now();
      const timestamp = String(Math.floor(now.getTime() / 1000));
      const overlap = item.previousSecret && item.previousSecretUntil && item.previousSecretUntil.getTime() > now.getTime();
      const headers = buildSignedHeaders(item.secret, timestamp, rawBody, overlap ? item.previousSecret : null);
      headers['x-intafaced-event-id'] = item.eventId;

      try {
        const res = await this.transport({
          url,
          addresses,
          headers,
          body: rawBody,
          // Whatever DNS left of the one deadline.
          timeoutMs: Math.max(1, deadline - Date.now()),
        });
        if (res.status >= 200 && res.status < 300) {
          const at = this.now();
          await this.store.finishAttempt(item.id, {
            status: 'delivered',
            attempts: item.attempts + 1,
            nextAttemptAt: item.nextAttemptAt,
            statusCode: res.status,
            error: null,
            deliveredAt: at,
            attempt: attemptOf(item, startedAt, 'delivered', res.status, null),
          });
          await this.store.resetEndpointFailures(item.endpointId);
          delivered += 1;
          continue;
        }
        // A redirect is never followed (it would walk past the guard): failure, loudly.
        const err = res.status >= 300 && res.status < 400 ? `webhook_redirect_not_followed (HTTP ${res.status})` : `HTTP ${res.status}`;
        await fail(item, startedAt, res.status, err);
      } catch (err) {
        if (isTimeout(err)) await fail(item, startedAt, null, 'webhook_timeout', 'unknown');
        else await fail(item, startedAt, null, err instanceof Error ? err.message : 'delivery_error');
      }
    }

    return { delivered, failed, unknown, disabled };
  }
}
