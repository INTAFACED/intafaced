import { createHash, randomBytes } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { PayError } from '../payment-service.js';
import { assertPublicWebhookUrl } from '../webhook-url-guard.js';
import { MerchantOpsError } from './errors.js';
import { iso } from './money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from './pagination.js';
import { assertPermission, type MerchantCaller } from './roles.js';

/**
 * Merchant webhook endpoint operations.
 *
 * List and health are reads for owner, admin, and developer. Create, update,
 * disable, and rotate require that same role plus an interactive MFA session
 * (the step-up a key mint already requires: no API key, no sub-account).
 * Retry is the same role, idempotent on request id, and refused when the
 * operator has not set a rate window. Nothing here returns a signing secret
 * except the one response that created or rotated it, and no delivery read
 * returns a request or response body.
 */

const ENDPOINT_STATUSES = ['active', 'disabled'] as const;
const DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dead'] as const;
export type WebhookEndpointStatus = (typeof ENDPOINT_STATUSES)[number];
export type WebhookDeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface WebhookRetryLimit {
  readonly maxPerWindow: number;
  readonly windowMs: number;
}

const POSITIVE_INT = /^[1-9][0-9]*$/;

/**
 * Retry budget. Both values are required together. Either one unset, blank,
 * zero, or not a positive integer leaves retry unconfigured: the call refuses.
 * There is no default count and no default window.
 */
export function loadWebhookRetryLimit(env: Record<string, string | undefined>): WebhookRetryLimit | undefined {
  const maxRaw = env.PAY_WEBHOOK_RETRY_MAX?.trim() ?? '';
  const windowRaw = env.PAY_WEBHOOK_RETRY_WINDOW_MS?.trim() ?? '';
  if (!POSITIVE_INT.test(maxRaw) || !POSITIVE_INT.test(windowRaw)) return undefined;
  const maxPerWindow = Number(maxRaw);
  const windowMs = Number(windowRaw);
  if (!Number.isSafeInteger(maxPerWindow) || !Number.isSafeInteger(windowMs)) return undefined;
  return { maxPerWindow, windowMs };
}

const notFound = () => new MerchantOpsError('pay.webhook_endpoint_not_found', 'not_found');
const deliveryNotFound = () => new MerchantOpsError('pay.webhook_delivery_not_found', 'not_found');

function assertStepUp(caller: MerchantCaller): void {
  if (!caller.interactive) throw new MerchantOpsError('pay.webhook_step_up_required', 'forbidden');
}

function newId(): string {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface EndpointRow {
  id: string;
  url: string;
  status: WebhookEndpointStatus;
  disabled_reason: string | null;
  consecutive_failures: number;
  created_at: Date;
  updated_at: Date;
  cursor_ts: string;
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_type: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  last_status_code: number | null;
  created_at: Date;
  delivered_at: Date | null;
  cursor_ts: string;
}

const endpointView = (row: EndpointRow) => ({
  id: row.id,
  url: row.url,
  status: row.status,
  disabledReason: row.disabled_reason,
  consecutiveFailures: row.consecutive_failures,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const deliveryView = (row: DeliveryRow) => ({
  id: row.id,
  endpointId: row.endpoint_id,
  eventType: row.event_type,
  status: row.status,
  attempts: row.attempts,
  lastStatusCode: row.last_status_code,
  latencyMs: row.delivered_at ? Math.max(0, row.delivered_at.getTime() - row.created_at.getTime()) : null,
  createdAt: iso(row.created_at),
  deliveredAt: row.delivered_at ? iso(row.delivered_at) : null,
});

type Querier = Sql | TransactionSql<Record<string, never>>;

const ENDPOINT_FIELDS = (sql: Querier) => sql`
  id, url, status, disabled_reason, consecutive_failures, created_at, updated_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;

const DELIVERY_FIELDS = (sql: Querier) => sql`
  id, endpoint_id, event_type, status, attempts, last_status_code, created_at, delivered_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;

export class WebhookOps {
  constructor(
    private readonly sql: Sql,
    private readonly options: { allowLocalHttp?: boolean; retry?: WebhookRetryLimit } = {},
  ) {}

  private checkUrl(url: string): void {
    try {
      assertPublicWebhookUrl(url, { allowLocalHttp: this.options.allowLocalHttp === true });
    } catch (error) {
      if (error instanceof PayError) throw new MerchantOpsError('pay.webhook_url_invalid', 'bad_request');
      throw error;
    }
  }

  async list(
    caller: MerchantCaller,
    input: { limit?: number | undefined; cursor?: string; status?: WebhookEndpointStatus; search?: string },
  ) {
    assertPermission(caller, 'webhooks.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    const sql = this.sql;
    const rows = await sql<EndpointRow[]>`
      SELECT ${ENDPOINT_FIELDS(sql)} FROM pay.merchant_webhook_endpoints
       WHERE merchant_id = ${caller.merchantId}
         ${input.status ? sql`AND status = ${input.status}` : sql``}
         ${input.search ? sql`AND (id::text = lower(${input.search}) OR starts_with(lower(url), lower(${input.search})))` : sql``}
         ${after ? sql`AND (created_at, id) < ((${after.ts}::text)::timestamptz, ${after.key}::uuid)` : sql``}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`;
    return toPage(rows, limit, endpointView, (row) => encodeCursor(row.cursor_ts, row.id));
  }

  async create(caller: MerchantCaller, input: { url: string }) {
    assertPermission(caller, 'webhooks.manage');
    assertStepUp(caller);
    this.checkUrl(input.url);
    const secret = randomBytes(32).toString('hex');
    const id = newId();
    const sql = this.sql;
    const rows = await sql<EndpointRow[]>`
      INSERT INTO pay.merchant_webhook_endpoints (id, merchant_id, url, secret_hash, signing_secret)
      VALUES (${id}, ${caller.merchantId}, ${input.url}, ${createHash('sha256').update(secret).digest('hex')}, ${secret})
      RETURNING ${ENDPOINT_FIELDS(sql)}`;
    return { endpoint: endpointView(rows[0]!), secret };
  }

  async update(caller: MerchantCaller, input: { endpointId: string; url: string }) {
    assertPermission(caller, 'webhooks.manage');
    assertStepUp(caller);
    this.checkUrl(input.url);
    const sql = this.sql;
    const rows = await sql<EndpointRow[]>`
      UPDATE pay.merchant_webhook_endpoints SET url = ${input.url}, updated_at = now()
       WHERE id = ${input.endpointId}::uuid AND merchant_id = ${caller.merchantId}
       RETURNING ${ENDPOINT_FIELDS(sql)}`;
    if (!rows[0]) throw notFound();
    return endpointView(rows[0]);
  }

  async disable(caller: MerchantCaller, endpointId: string) {
    assertPermission(caller, 'webhooks.manage');
    assertStepUp(caller);
    const sql = this.sql;
    const rows = await sql<EndpointRow[]>`
      UPDATE pay.merchant_webhook_endpoints
         SET status = 'disabled', disabled_reason = 'disabled_by_merchant', updated_at = now()
       WHERE id = ${endpointId}::uuid AND merchant_id = ${caller.merchantId}
       RETURNING ${ENDPOINT_FIELDS(sql)}`;
    if (!rows[0]) throw notFound();
    return endpointView(rows[0]);
  }

  /**
   * Replace the signing secret. The first response for `requestId` includes the
   * secret. A repeat of that request id does not rotate again and does not
   * reveal the secret a second time.
   */
  async rotateSecret(caller: MerchantCaller, input: { endpointId: string; requestId: string }) {
    assertPermission(caller, 'webhooks.manage');
    assertStepUp(caller);
    const sql = this.sql;
    return sql.begin(async (tx) => {
      const prior = await tx<Array<{ endpoint_id: string }>>`
        SELECT endpoint_id FROM pay.merchant_webhook_rotations
         WHERE merchant_id = ${caller.merchantId} AND request_id = ${input.requestId}::uuid`;
      if (prior[0]) {
        if (prior[0].endpoint_id !== input.endpointId) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
        const current = await tx<EndpointRow[]>`
          SELECT ${ENDPOINT_FIELDS(tx)} FROM pay.merchant_webhook_endpoints
           WHERE id = ${input.endpointId}::uuid AND merchant_id = ${caller.merchantId}`;
        if (!current[0]) throw notFound();
        return { endpoint: endpointView(current[0]), secret: null, rotated: false as const };
      }
      const secret = randomBytes(32).toString('hex');
      const rows = await tx<EndpointRow[]>`
        UPDATE pay.merchant_webhook_endpoints
           SET signing_secret = ${secret}, secret_hash = ${createHash('sha256').update(secret).digest('hex')}, updated_at = now()
         WHERE id = ${input.endpointId}::uuid AND merchant_id = ${caller.merchantId}
         RETURNING ${ENDPOINT_FIELDS(tx)}`;
      if (!rows[0]) throw notFound();
      await tx`
        INSERT INTO pay.merchant_webhook_rotations (merchant_id, endpoint_id, request_id, requested_by)
        VALUES (${caller.merchantId}, ${input.endpointId}::uuid, ${input.requestId}::uuid, ${caller.userId})`;
      return { endpoint: endpointView(rows[0]), secret, rotated: true as const };
    });
  }

  async listDeliveries(
    caller: MerchantCaller,
    input: {
      limit?: number | undefined;
      cursor?: string;
      endpointId?: string;
      status?: WebhookDeliveryStatus;
      from?: string;
      to?: string;
    },
  ) {
    assertPermission(caller, 'webhooks.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    if (input.from && input.to && Date.parse(input.from) > Date.parse(input.to)) {
      throw new MerchantOpsError('pay.cursor_invalid', 'bad_request');
    }
    const sql = this.sql;
    const rows = await sql<DeliveryRow[]>`
      SELECT ${DELIVERY_FIELDS(sql)} FROM pay.merchant_webhook_deliveries
       WHERE merchant_id = ${caller.merchantId}
         ${input.endpointId ? sql`AND endpoint_id = ${input.endpointId}::uuid` : sql``}
         ${input.status ? sql`AND status = ${input.status}` : sql``}
         ${input.from ? sql`AND created_at >= (${input.from}::text)::timestamptz` : sql``}
         ${input.to ? sql`AND created_at < (${input.to}::text)::timestamptz` : sql``}
         ${after ? sql`AND (created_at, id) < ((${after.ts}::text)::timestamptz, ${after.key}::uuid)` : sql``}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`;
    return toPage(rows, limit, deliveryView, (row) => encodeCursor(row.cursor_ts, row.id));
  }

  async retry(caller: MerchantCaller, input: { requestId: string; deliveryId: string }) {
    assertPermission(caller, 'webhooks.manage');
    assertStepUp(caller);
    const limit = this.options.retry;
    if (
      !limit ||
      !Number.isInteger(limit.maxPerWindow) ||
      limit.maxPerWindow < 1 ||
      !Number.isInteger(limit.windowMs) ||
      limit.windowMs < 1
    ) {
      throw new MerchantOpsError('pay.webhook_retry_unconfigured', 'precondition');
    }
    const sql = this.sql;
    return sql.begin(async (tx) => {
      const replay = async () => {
        const prior = await tx<Array<{ delivery_id: string }>>`
          SELECT delivery_id FROM pay.merchant_webhook_retries
           WHERE merchant_id = ${caller.merchantId} AND request_id = ${input.requestId}::uuid`;
        if (!prior[0]) return null;
        if (prior[0].delivery_id !== input.deliveryId) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
        return { retried: false as const, delivery: await loadDelivery(tx, caller.merchantId, input.deliveryId) };
      };
      const first = await replay();
      if (first) return first;
      await tx`SELECT id FROM pay.merchants WHERE id = ${caller.merchantId} FOR UPDATE`;
      const again = await replay();
      if (again) return again;
      const windowStart = new Date(Date.now() - limit.windowMs);
      const counted = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pay.merchant_webhook_retries
         WHERE merchant_id = ${caller.merchantId} AND created_at >= ${windowStart}`;
      if ((counted[0]?.n ?? 0) >= limit.maxPerWindow) throw new MerchantOpsError('pay.webhook_retry_rate_limited', 'precondition');
      const updated = await tx<DeliveryRow[]>`
        UPDATE pay.merchant_webhook_deliveries
           SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
         WHERE id = ${input.deliveryId}::uuid AND merchant_id = ${caller.merchantId}
           AND status IN ('failed', 'dead')
         RETURNING ${DELIVERY_FIELDS(tx)}`;
      if (!updated[0]) {
        const exists = await tx<Array<{ id: string }>>`
          SELECT id FROM pay.merchant_webhook_deliveries
           WHERE id = ${input.deliveryId}::uuid AND merchant_id = ${caller.merchantId}`;
        if (!exists[0]) throw deliveryNotFound();
        throw new MerchantOpsError('pay.webhook_retry_not_failed', 'conflict');
      }
      await tx`
        INSERT INTO pay.merchant_webhook_retries (merchant_id, request_id, delivery_id, requested_by)
        VALUES (${caller.merchantId}, ${input.requestId}::uuid, ${input.deliveryId}::uuid, ${caller.userId})`;
      return { retried: true as const, delivery: deliveryView(updated[0]) };
    });
  }

  /** Counts and the last delivery time. No health threshold: none is configured. */
  async health(caller: MerchantCaller) {
    assertPermission(caller, 'webhooks.read');
    const rows = await this.sql<
      Array<{
        id: string;
        status: WebhookEndpointStatus;
        consecutive_failures: number;
        pending: number;
        delivered: number;
        failed: number;
        dead: number;
        last_delivered_at: Date | null;
      }>
    >`
      SELECT e.id, e.status, e.consecutive_failures,
             count(d.id) FILTER (WHERE d.status = 'pending')::int AS pending,
             count(d.id) FILTER (WHERE d.status = 'delivered')::int AS delivered,
             count(d.id) FILTER (WHERE d.status = 'failed')::int AS failed,
             count(d.id) FILTER (WHERE d.status = 'dead')::int AS dead,
             max(d.delivered_at) AS last_delivered_at
        FROM pay.merchant_webhook_endpoints e
        LEFT JOIN pay.merchant_webhook_deliveries d ON d.endpoint_id = e.id AND d.merchant_id = e.merchant_id
       WHERE e.merchant_id = ${caller.merchantId}
       GROUP BY e.id, e.status, e.consecutive_failures
       ORDER BY e.created_at DESC, e.id DESC`;
    return {
      asOf: new Date().toISOString(),
      endpoints: rows.map((row) => ({
        endpointId: row.id,
        status: row.status,
        consecutiveFailures: row.consecutive_failures,
        deliveries: { pending: row.pending, delivered: row.delivered, failed: row.failed, dead: row.dead },
        lastDeliveredAt: row.last_delivered_at ? iso(row.last_delivered_at) : null,
      })),
    };
  }
}

async function loadDelivery(sql: Querier, merchantId: string, deliveryId: string) {
  const rows = await sql<DeliveryRow[]>`
    SELECT ${DELIVERY_FIELDS(sql)} FROM pay.merchant_webhook_deliveries
     WHERE id = ${deliveryId}::uuid AND merchant_id = ${merchantId}`;
  if (!rows[0]) throw deliveryNotFound();
  return deliveryView(rows[0]);
}
