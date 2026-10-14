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
 *   · At-least-once; merchants dedupe on `id` (event id)
 *   · Retry with backoff; a permanently failing endpoint is disabled and
 *     listed on the failure dashboard — never silently dropped
 *   · Body carries STATE (current payment shape), not instructions
 *
 * Reuses the same `signPayload` the inbound rail path uses so there is one
 * way to get HMAC right. This module does not move value.
 */

export type MerchantWebhookEventType = 'payment.authorized' | 'payment.captured' | 'payment.refunded' | 'payment.failed';

export type WebhookEndpointStatus = 'active' | 'disabled';
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

export interface MerchantWebhookEndpoint {
  readonly id: string;
  readonly merchantId: string;
  readonly url: string;
  readonly status: WebhookEndpointStatus;
  readonly disabledReason: string | null;
  readonly consecutiveFailures: number;
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
  /** Attempts before a delivery is marked `dead`. */
  readonly maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 8;
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

/**
 * How long a worker owns a due row after `claimDue`, before the POST leaves.
 *
 * claimDue advances `next_attempt_at` so a second replica (FOR UPDATE SKIP
 * LOCKED) will not take the row while it is still unsent. `commitSend` records
 * that this worker is handing the body to the network. After that mark lands,
 * claimDue will not return the row even if the lease expires before
 * `markDelivered` — the body is not POSTed again. A crash before `commitSend`
 * leaves the mark unset; when the lease expires another worker retries the
 * attempt that never left. A non-2xx or a thrown redirect still goes through
 * `markRetry`, which clears the mark so a later attempt can leave.
 */
export const WEBHOOK_CLAIM_LEASE_MS = 60_000;

/** Backoff seconds by attempt index (0-based). Caps at last entry. */
const BACKOFF_SECONDS = [60, 300, 1_800, 7_200, 43_200, 86_400, 86_400, 86_400] as const;

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

export function buildSignedHeaders(secret: string, timestamp: string, rawBody: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-intafaced-timestamp': timestamp,
    'x-intafaced-signature': signPayload(secret, timestamp, rawBody),
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
  }): Promise<MerchantWebhookEndpoint>;
  listEndpoints(merchantId: string, opts: { limit: number }): Promise<MerchantWebhookEndpoint[]>;
  /** Dispatch fan-out — every active receiver. Not a client page; never invent a 50-row cut. */
  listActiveEndpoints(merchantId: string): Promise<MerchantWebhookEndpoint[]>;
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
  claimDue(limit: number, now: Date): Promise<Array<MerchantWebhookDelivery & { secret: string; url: string }>>;
  /**
   * Commit this attempt to the network. False when another worker already
   * committed it — the caller must not POST. A crash before this returns
   * leaves the row unsent so lease expiry can retry it.
   */
  commitSend(id: string, now: Date): Promise<boolean>;
  markDelivered(id: string, statusCode: number, deliveredAt: Date): Promise<void>;
  markRetry(id: string, attempts: number, nextAttemptAt: Date, statusCode: number | null, error: string, dead: boolean): Promise<void>;
  listDeliveries(merchantId: string, opts: { status?: WebhookDeliveryStatus; limit: number }): Promise<MerchantWebhookDelivery[]>;
}

type MemEndpoint = {
  id: string;
  merchantId: string;
  url: string;
  status: WebhookEndpointStatus;
  disabledReason: string | null;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
  secret: string;
  secretHash: string;
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
};

/** In-memory store — unit tests / single-process local. Not multi-replica. */
export class MemoryMerchantWebhookStore implements MerchantWebhookStore {
  readonly endpoints = new Map<string, MemEndpoint>();
  readonly deliveries = new Map<string, MemDelivery>();
  /** Attempts whose POST has been committed. Not part of the public delivery row. */
  private readonly httpSentAt = new Map<string, Date>();

  async insertEndpoint(row: {
    id: string;
    merchantId: string;
    url: string;
    secretHash: string;
    secretEncrypted: string;
  }): Promise<MerchantWebhookEndpoint> {
    const now = new Date();
    const ep: MemEndpoint = {
      id: row.id,
      merchantId: row.merchantId,
      url: row.url,
      status: 'active',
      disabledReason: null,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
      secret: row.secretEncrypted,
      secretHash: row.secretHash,
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

  async listActiveEndpoints(merchantId: string): Promise<MerchantWebhookEndpoint[]> {
    return [...this.endpoints.values()].filter((e) => e.merchantId === merchantId && e.status === 'active').map(publicEndpoint);
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
    };
    this.deliveries.set(delivery.id, delivery);
    return delivery;
  }

  async claimDue(limit: number, now: Date): Promise<Array<MerchantWebhookDelivery & { secret: string; url: string }>> {
    const leaseUntil = new Date(now.getTime() + WEBHOOK_CLAIM_LEASE_MS);
    const due = [...this.deliveries.values()]
      .filter((d) => d.status === 'pending' || d.status === 'failed')
      .filter((d) => !this.httpSentAt.has(d.id))
      .filter((d) => d.nextAttemptAt.getTime() <= now.getTime())
      .filter((d) => {
        const ep = this.endpoints.get(d.endpointId);
        return ep !== undefined && ep.status === 'active';
      })
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);
    const out: Array<MerchantWebhookDelivery & { secret: string; url: string }> = [];
    for (const d of due) {
      const ep = this.endpoints.get(d.endpointId);
      if (!ep || ep.status !== 'active') continue;
      // Lease: concurrent processDue in the same process will not re-select this row.
      d.nextAttemptAt = leaseUntil;
      out.push({ ...d, secret: ep.secret, url: ep.url });
    }
    return out;
  }

  async commitSend(id: string, now: Date): Promise<boolean> {
    const d = this.deliveries.get(id);
    if (!d || this.httpSentAt.has(id)) return false;
    if (d.status !== 'pending' && d.status !== 'failed') return false;
    this.httpSentAt.set(id, now);
    return true;
  }

  async markDelivered(id: string, statusCode: number, deliveredAt: Date): Promise<void> {
    const d = this.deliveries.get(id);
    if (!d) return;
    d.status = 'delivered';
    d.attempts += 1;
    d.lastStatusCode = statusCode;
    d.lastError = null;
    d.deliveredAt = deliveredAt;
  }

  async markRetry(
    id: string,
    attempts: number,
    nextAttemptAt: Date,
    statusCode: number | null,
    error: string,
    dead: boolean,
  ): Promise<void> {
    const d = this.deliveries.get(id);
    if (!d) return;
    d.attempts = attempts;
    d.nextAttemptAt = nextAttemptAt;
    d.lastStatusCode = statusCode;
    d.lastError = error;
    d.status = dead ? 'dead' : 'failed';
    // The POST did not succeed. A later attempt may leave.
    this.httpSentAt.delete(id);
  }

  async listDeliveries(merchantId: string, opts: { status?: WebhookDeliveryStatus; limit: number }): Promise<MerchantWebhookDelivery[]> {
    return [...this.deliveries.values()]
      .filter((d) => d.merchantId === merchantId)
      .filter((d) => (opts.status ? d.status === opts.status : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, opts.limit);
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
    createdAt: ep.createdAt,
    updatedAt: ep.updatedAt,
  };
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
  }): Promise<MerchantWebhookEndpoint> {
    const rows = (await this.sql`
      INSERT INTO pay.merchant_webhook_endpoints
        (id, merchant_id, url, secret_hash, signing_secret, status, consecutive_failures)
      VALUES
        (${row.id}, ${row.merchantId}, ${row.url}, ${row.secretHash}, ${row.secretEncrypted}, 'active', 0)
      RETURNING id, merchant_id, url, status, disabled_reason, consecutive_failures, created_at, updated_at
    `) as ReadonlyArray<EndpointRow>;
    return mapEndpoint(rows[0]!);
  }

  async listEndpoints(merchantId: string, opts: { limit: number }): Promise<MerchantWebhookEndpoint[]> {
    const rows = (await this.sql`
      SELECT id, merchant_id, url, status, disabled_reason, consecutive_failures, created_at, updated_at
        FROM pay.merchant_webhook_endpoints
       WHERE merchant_id = ${merchantId}
       ORDER BY created_at DESC
       LIMIT ${opts.limit}
    `) as ReadonlyArray<EndpointRow>;
    return rows.map(mapEndpoint);
  }

  async listActiveEndpoints(merchantId: string): Promise<MerchantWebhookEndpoint[]> {
    const rows = (await this.sql`
      SELECT id, merchant_id, url, status, disabled_reason, consecutive_failures, created_at, updated_at
        FROM pay.merchant_webhook_endpoints
       WHERE merchant_id = ${merchantId} AND status = 'active'
       ORDER BY created_at DESC
    `) as ReadonlyArray<EndpointRow>;
    return rows.map(mapEndpoint);
  }

  async getEndpoint(id: string): Promise<(MerchantWebhookEndpoint & { secret: string }) | null> {
    const rows = (await this.sql`
      SELECT id, merchant_id, url, status, disabled_reason, consecutive_failures,
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

  async claimDue(limit: number, now: Date): Promise<Array<MerchantWebhookDelivery & { secret: string; url: string }>> {
    /**
     * Multi-replica claim (ADR §2.4 at-least-once, never silently dropped).
     *
     * CTE selects due rows with FOR UPDATE SKIP LOCKED so two drainers never
     * POST the same delivery concurrently. Advancing next_attempt_at leases an
     * unsent row for WEBHOOK_CLAIM_LEASE_MS. `http_sent_at` is set by
     * `commitSend` once the worker hands the body to the network; those rows
     * stay out of this claim even after the lease expires, so markDelivered
     * landing late cannot cause a second POST. A crash before commitSend leaves
     * `http_sent_at` null and the lease expiry retries the attempt that never
     * left. Merchants still dedupe on event id.
     */
    const leaseUntil = new Date(now.getTime() + WEBHOOK_CLAIM_LEASE_MS).toISOString();
    const nowIso = now.toISOString();
    const rows = (await this.sql`
      WITH due AS (
        SELECT d.id
          FROM pay.merchant_webhook_deliveries d
          JOIN pay.merchant_webhook_endpoints e ON e.id = d.endpoint_id
         WHERE e.status = 'active'
           AND d.status IN ('pending', 'failed')
           AND d.http_sent_at IS NULL
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
                d.attempts, d.next_attempt_at, d.last_status_code, d.last_error, d.created_at, d.delivered_at
      )
      SELECT c.id, c.endpoint_id, c.merchant_id, c.event_id, c.event_type, c.payload, c.status,
             c.attempts, c.next_attempt_at, c.last_status_code, c.last_error, c.created_at, c.delivered_at,
             e.signing_secret, e.url
        FROM claimed c
        JOIN pay.merchant_webhook_endpoints e ON e.id = c.endpoint_id
    `) as ReadonlyArray<DeliveryRow & { signing_secret: string; url: string }>;
    return rows.map((r) => ({ ...mapDelivery(r), secret: r.signing_secret, url: r.url }));
  }

  async commitSend(id: string, now: Date): Promise<boolean> {
    const rows = await this.sql`
      UPDATE pay.merchant_webhook_deliveries
         SET http_sent_at = ${now.toISOString()}
       WHERE id = ${id}
         AND http_sent_at IS NULL
         AND status IN ('pending', 'failed')
      RETURNING id
    `;
    return rows.length > 0;
  }

  async markDelivered(id: string, statusCode: number, deliveredAt: Date): Promise<void> {
    await this.sql`
      UPDATE pay.merchant_webhook_deliveries
         SET status = 'delivered',
             attempts = attempts + 1,
             last_status_code = ${statusCode},
             last_error = NULL,
             delivered_at = ${deliveredAt.toISOString()}
       WHERE id = ${id}
    `;
  }

  async markRetry(
    id: string,
    attempts: number,
    nextAttemptAt: Date,
    statusCode: number | null,
    error: string,
    dead: boolean,
  ): Promise<void> {
    await this.sql`
      UPDATE pay.merchant_webhook_deliveries
         SET status = ${dead ? 'dead' : 'failed'},
             attempts = ${attempts},
             next_attempt_at = ${nextAttemptAt.toISOString()},
             last_status_code = ${statusCode},
             last_error = ${error},
             http_sent_at = NULL
       WHERE id = ${id}
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
}

type EndpointRow = {
  id: string;
  merchant_id: string;
  url: string;
  status: WebhookEndpointStatus;
  disabled_reason: string | null;
  consecutive_failures: number;
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

export class MerchantWebhookService {
  private readonly now: () => Date;
  private readonly transport: WebhookTransport;
  private readonly resolver: WebhookResolver;
  private readonly allowLocalHttp: boolean;
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
    this.maxAttempts = runtime.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.disableAfter = runtime.disableAfterFailures ?? DEFAULT_DISABLE_AFTER;
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
   * Enqueue one delivery per active endpoint for this merchant.
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
    const endpoints = await this.store.listActiveEndpoints(event.payment.merchantId);
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
   * Owner/drain may pass 25 explicitly.
   */
  async processDue(limit?: number): Promise<{ delivered: number; failed: number; disabled: number }> {
    const batch = assertDueWebhookDeliveriesBatchLimit(limit);
    const due = await this.store.claimDue(batch, this.now());
    let delivered = 0;
    let failed = 0;
    let disabled = 0;

    /** One failed attempt: backoff, count against the endpoint, disable when exhausted. Never dropped. */
    const fail = async (item: (typeof due)[number], statusCode: number | null, error: string): Promise<void> => {
      const attempts = item.attempts + 1;
      const dead = attempts >= this.maxAttempts;
      const backoff = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)] ?? 86_400;
      const next = new Date(this.now().getTime() + backoff * 1000);
      await this.store.markRetry(item.id, attempts, next, statusCode, error, dead);
      failed += 1;
      const consecutive = await this.store.bumpEndpointFailure(item.endpointId);
      if (consecutive >= this.disableAfter || dead) {
        await this.store.setEndpointStatus(item.endpointId, 'disabled', dead ? 'delivery_exhausted' : 'consecutive_failures', consecutive);
        disabled += 1;
      }
    };

    for (const item of due) {
      if (!item.secret || item.secret.trim().length < 32) {
        await fail(item, null, 'pay.webhook_not_configured');
        continue;
      }

      // SSRF guard, every attempt: the stored URL may predate the guard, and DNS
      // can change between attempts. The addresses vetted here are the only ones we connect to.
      const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
      let url: URL;
      try {
        url = assertPublicWebhookUrl(item.url, { allowLocalHttp: this.allowLocalHttp });
      } catch {
        await fail(item, null, 'webhook_target_not_public');
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
        await fail(item, null, err instanceof DeadlineExceeded ? 'webhook_dns_timeout' : 'webhook_target_not_public');
        continue;
      }

      // Before the socket write: a second worker who also holds this id loses
      // the compare-and-set and must not POST. After it lands, lease expiry
      // cannot claim the row even if markDelivered has not.
      const leaving = await this.store.commitSend(item.id, this.now());
      if (!leaving) continue;

      const rawBody = JSON.stringify(item.payload);
      const timestamp = String(Math.floor(this.now().getTime() / 1000));
      const headers = buildSignedHeaders(item.secret, timestamp, rawBody);
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
          await this.store.markDelivered(item.id, res.status, this.now());
          await this.store.resetEndpointFailures(item.endpointId);
          delivered += 1;
          continue;
        }
        // A redirect is never followed (it would walk past the guard): failure, loudly.
        const err = res.status >= 300 && res.status < 400 ? `webhook_redirect_not_followed (HTTP ${res.status})` : `HTTP ${res.status}`;
        await fail(item, res.status, err);
      } catch (err) {
        await fail(item, null, err instanceof Error ? err.message : 'delivery_error');
      }
    }

    return { delivered, failed, disabled };
  }
}
