import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Sql, TransactionSql } from 'postgres';
import { MERCHANT_WEBHOOK_EVENT_TYPES, type MerchantWebhookEventType } from '../merchant-webhooks.js';
import {
  WebhookUrlRefusal,
  assertPublicWebhookUrl,
  isPublicIpAddress,
  publicDnsResolver,
  systemResolver,
  type WebhookResolver,
} from '../webhook-url-guard.js';
import { MerchantOpsError } from './errors.js';
import { iso } from './money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from './pagination.js';
import { assertPermission, type MerchantCaller } from './roles.js';
import { receiverGuide, webhookCatalogue } from './webhook-catalogue.js';

/**
 * Merchant webhook endpoint operations.
 *
 * List, health, policy, catalogue and guide are reads for owner, admin, and
 * developer. Create, update, disable, rotate, resend and recover require that same
 * role plus an interactive MFA session (the step-up a key mint already requires: no
 * API key, no sub-account). Resend and recover are idempotent on request id, and
 * refused when the operator has not set a rate window or a resend window. Nothing
 * here returns a signing secret except the one response that created or rotated it,
 * and no delivery read returns a request or response body.
 *
 * Every limit below is an owner value read from the environment. Blank refuses by
 * name; nothing is defaulted (AGENTS.md floor 8).
 */

const ENDPOINT_STATUSES = ['active', 'disabled'] as const;
export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dead', 'unknown'] as const;
export type WebhookEndpointStatus = (typeof ENDPOINT_STATUSES)[number];
export type WebhookDeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface WebhookRetryLimit {
  readonly maxPerWindow: number;
  readonly windowMs: number;
}

/** The owner's webhook values. Each one absent is blank. */
export interface WebhookSettings {
  /** Most active endpoints one business may hold (`PAY_WEBHOOK_ENDPOINT_CAP`). */
  readonly endpointCap?: number;
  /** Longest a rolled secret may keep working beside the new one (`PAY_WEBHOOK_SECRET_OVERLAP_MAX_SECONDS`). */
  readonly overlapMaxSeconds?: number;
  /** How far back a resend or a recovery may reach (`PAY_WEBHOOK_RESEND_WINDOW_SECONDS`). */
  readonly resendWindowSeconds?: number;
  /** The retry policy (`PAY_WEBHOOK_RETRY_SCHEDULE_SECONDS`), shown on the dashboard. The worker sends by the same value. */
  readonly retryScheduleSeconds?: readonly number[];
  /** The timestamp tolerance the receiver guide publishes (`PAY_WEBHOOK_TOLERANCE_SECONDS`). */
  readonly toleranceSeconds?: number;
  /** The addresses deliveries come from (`PAY_WEBHOOK_SENDER_IPS`). */
  readonly senderIps?: readonly string[];
}

const POSITIVE_INT = /^[1-9][0-9]*$/;

const positive = (raw: string | undefined): number | undefined => {
  const text = raw?.trim() ?? '';
  if (!POSITIVE_INT.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
};

/**
 * Retry budget. Both values are required together. Either one unset, blank,
 * zero, or not a positive integer leaves retry unconfigured: the call refuses.
 * There is no default count and no default window.
 */
export function loadWebhookRetryLimit(env: Record<string, string | undefined>): WebhookRetryLimit | undefined {
  const maxPerWindow = positive(env.PAY_WEBHOOK_RETRY_MAX);
  const windowMs = positive(env.PAY_WEBHOOK_RETRY_WINDOW_MS);
  if (maxPerWindow === undefined || windowMs === undefined) return undefined;
  return { maxPerWindow, windowMs };
}

/**
 * The retry policy: positive whole seconds, comma separated, one per retry. Anything else, or blank, is unset: the
 * worker then sends nothing.
 */
export function loadWebhookRetrySchedule(env: Record<string, string | undefined>): readonly number[] | undefined {
  const raw = env.PAY_WEBHOOK_RETRY_SCHEDULE_SECONDS?.trim() ?? '';
  if (!raw) return undefined;
  const parts = raw.split(',').map((p) => positive(p));
  return parts.every((p): p is number => p !== undefined) ? parts : undefined;
}

export function loadWebhookSettings(env: Record<string, string | undefined>): WebhookSettings {
  const senderIps = (env.PAY_WEBHOOK_SENDER_IPS ?? '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);
  if (senderIps.some((ip) => isIP(ip) === 0)) throw new Error('PAY_WEBHOOK_SENDER_IPS must be comma-separated IP addresses');
  return {
    endpointCap: positive(env.PAY_WEBHOOK_ENDPOINT_CAP),
    overlapMaxSeconds: positive(env.PAY_WEBHOOK_SECRET_OVERLAP_MAX_SECONDS),
    resendWindowSeconds: positive(env.PAY_WEBHOOK_RESEND_WINDOW_SECONDS),
    retryScheduleSeconds: loadWebhookRetrySchedule(env),
    toleranceSeconds: positive(env.PAY_WEBHOOK_TOLERANCE_SECONDS),
    ...(senderIps.length > 0 ? { senderIps } : {}),
  };
}

/**
 * LOCAL TEST DNS (`PAY_WEBHOOK_TEST_DNS`, `name=address,name=address`): answers for TEST names only, so a journey can
 * add an https address whose name resolves to a private address without depending on outside DNS. The service refuses
 * it outside APP_ENV dev or test (index.ts). Names it does not list fall through to the normal resolver.
 */
export function testDnsResolver(raw: string | undefined, fallback: WebhookResolver): WebhookResolver | undefined {
  const text = raw?.trim() ?? '';
  if (!text) return undefined;
  const table = new Map<string, string>();
  for (const pair of text.split(',')) {
    const [name, address] = pair.split('=').map((p) => p.trim().toLowerCase());
    if (!name || !address || isIP(address) === 0) throw new Error('PAY_WEBHOOK_TEST_DNS must be name=address pairs');
    table.set(name, address);
  }
  return async (hostname) => {
    const address = table.get(hostname.toLowerCase());
    return address ? [{ address, family: isIP(address) }] : fallback(hostname);
  };
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
  event_types: string[];
  previous_secret_until: Date | null;
  created_at: Date;
  updated_at: Date;
  cursor_ts: string;
}

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  last_status_code: number | null;
  next_attempt_at: Date;
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
  eventTypes: row.event_types,
  // Only while the overlap is still running: an ended one is history, not state.
  previousSecretUntil:
    row.previous_secret_until && row.previous_secret_until.getTime() > Date.now() ? iso(row.previous_secret_until) : null,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const deliveryView = (row: DeliveryRow) => ({
  id: row.id,
  endpointId: row.endpoint_id,
  eventId: row.event_id,
  eventType: row.event_type,
  status: row.status,
  attempts: row.attempts,
  lastStatusCode: row.last_status_code,
  nextAttemptAt: row.status === 'delivered' || row.status === 'dead' ? null : iso(row.next_attempt_at),
  latencyMs: row.delivered_at ? Math.max(0, row.delivered_at.getTime() - row.created_at.getTime()) : null,
  createdAt: iso(row.created_at),
  deliveredAt: row.delivered_at ? iso(row.delivered_at) : null,
});

type Querier = Sql | TransactionSql<Record<string, never>>;

const ENDPOINT_FIELDS = (sql: Querier) => sql`
  id, url, status, disabled_reason, consecutive_failures, event_types, previous_secret_until, created_at, updated_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;

const DELIVERY_FIELDS = (sql: Querier) => sql`
  id, endpoint_id, event_id, event_type, status, attempts, last_status_code, next_attempt_at, created_at, delivered_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`;

/** The subscription a create names: at least one public type, each once, in the catalogue's order. */
function eventTypesOf(input: readonly string[] | undefined): MerchantWebhookEventType[] {
  const asked = new Set(input ?? []);
  if (asked.size === 0) throw new MerchantOpsError('pay.webhook_event_types_required', 'bad_request');
  if ([...asked].some((t) => !(MERCHANT_WEBHOOK_EVENT_TYPES as readonly string[]).includes(t))) {
    throw new MerchantOpsError('pay.webhook_event_type_unknown', 'bad_request');
  }
  return MERCHANT_WEBHOOK_EVENT_TYPES.filter((t) => asked.has(t));
}

export class WebhookOps {
  private readonly resolver: WebhookResolver;

  constructor(
    private readonly sql: Sql,
    private readonly options: {
      allowLocalHttp?: boolean;
      retry?: WebhookRetryLimit;
      settings?: WebhookSettings;
      /** DNS for the add-time check. Default: the delivery worker's (c-ares in production, the system's in dev/test). */
      resolver?: WebhookResolver;
    } = {},
  ) {
    this.resolver = options.resolver ?? (options.allowLocalHttp ? systemResolver : publicDnsResolver);
  }

  private get settings(): WebhookSettings {
    return this.options.settings ?? {};
  }

  /**
   * The address's own refusals, each by name: not https (`pay.webhook_url_https_required`), private or internal,
   * literally or by what its name resolves to (`pay.webhook_url_private`), or otherwise unusable
   * (`pay.webhook_url_invalid`). A name that does not resolve now is let through: the delivery worker checks again,
   * every attempt, and connects only to the addresses it vetted.
   */
  private async checkUrl(url: string): Promise<void> {
    const allowLocal = this.options.allowLocalHttp === true;
    let parsed: URL;
    try {
      parsed = assertPublicWebhookUrl(url, { allowLocalHttp: allowLocal });
    } catch (error) {
      if (error instanceof WebhookUrlRefusal) {
        if (error.reason === 'https') throw new MerchantOpsError('pay.webhook_url_https_required', 'bad_request');
        if (error.reason === 'private') throw new MerchantOpsError('pay.webhook_url_private', 'bad_request');
        throw new MerchantOpsError('pay.webhook_url_invalid', 'bad_request');
      }
      throw error;
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0) return;
    let answers: readonly { address: string }[];
    try {
      answers = await Promise.race([
        this.resolver(host),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns timeout')), 5_000).unref?.()),
      ]);
    } catch {
      return;
    }
    if (answers.some((a) => !isPublicIpAddress(a.address, { allowLoopback: allowLocal }))) {
      throw new MerchantOpsError('pay.webhook_url_private', 'bad_request');
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

  /**
   * Add an endpoint for the event types it names. The owner's cap counts active endpoints; blank refuses
   * (`pay.webhook_endpoint_cap_unset`), at the cap refuses (`pay.webhook_endpoint_cap_reached`). The count and the
   * insert hold the merchant's row lock, so two adds at once cannot both pass a cap of one.
   */
  async create(caller: MerchantCaller, input: { url: string; eventTypes?: readonly string[] }) {
    assertPermission(caller, 'webhooks.manage');
    assertStepUp(caller);
    const cap = this.settings.endpointCap;
    if (cap === undefined) throw new MerchantOpsError('pay.webhook_endpoint_cap_unset', 'precondition');
    const eventTypes = eventTypesOf(input.eventTypes);
    await this.checkUrl(input.url);
    const secret = randomBytes(32).toString('hex');
    const id = newId();
    return this.sql.begin(async (tx) => {
      await tx`SELECT id FROM pay.merchants WHERE id = ${caller.merchantId} FOR UPDATE`;
      const counted = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pay.merchant_webhook_endpoints
         WHERE merchant_id = ${caller.merchantId} AND status = 'active'`;
      if ((counted[0]?.n ?? 0) >= cap) throw new MerchantOpsError('pay.webhook_endpoint_cap_reached', 'precondition');
      const rows = await tx<EndpointRow[]>`
        INSERT INTO pay.merchant_webhook_endpoints (id, merchant_id, url, secret_hash, signing_secret, event_types)
        VALUES (${id}, ${caller.merchantId}, ${input.url}, ${createHash('sha256').update(secret).digest('hex')}, ${secret},
                ${eventTypes}::text[])
        RETURNING ${ENDPOINT_FIELDS(tx)}`;
      return { endpoint: endpointView(rows[0]!), secret };
    });
  }

  async update(caller: MerchantCaller, input: { endpointId: string; url: string }) {
    assertPermission(caller, 'webhooks.manage');
    assertStepUp(caller);
    await this.checkUrl(input.url);
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
   *
   * `overlapSeconds` above zero keeps the old secret signing beside the new one
   * until then (two signatures per delivery); the owner's maximum bounds it, and
   * blank refuses any overlap (`pay.webhook_overlap_max_unset`). Zero ends the
   * old secret at once, and ends any overlap still running.
   */
  async rotateSecret(caller: MerchantCaller, input: { endpointId: string; requestId: string; overlapSeconds?: number }) {
    assertPermission(caller, 'webhooks.manage');
    assertStepUp(caller);
    const overlap = input.overlapSeconds ?? 0;
    if (!Number.isSafeInteger(overlap) || overlap < 0) throw new MerchantOpsError('pay.webhook_overlap_invalid', 'bad_request');
    if (overlap > 0) {
      const max = this.settings.overlapMaxSeconds;
      if (max === undefined) throw new MerchantOpsError('pay.webhook_overlap_max_unset', 'precondition');
      if (overlap > max) throw new MerchantOpsError('pay.webhook_overlap_too_long', 'bad_request');
    }
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
           SET previous_signing_secret = ${overlap > 0 ? tx`signing_secret` : tx`NULL`},
               previous_secret_until = ${overlap > 0 ? tx`now() + make_interval(secs => ${overlap})` : tx`NULL`},
               signing_secret = ${secret},
               secret_hash = ${createHash('sha256').update(secret).digest('hex')},
               updated_at = now()
         WHERE id = ${input.endpointId}::uuid AND merchant_id = ${caller.merchantId}
         RETURNING ${ENDPOINT_FIELDS(tx)}`;
      if (!rows[0]) throw notFound();
      await tx`
        INSERT INTO pay.merchant_webhook_rotations (merchant_id, endpoint_id, request_id, requested_by, overlap_seconds)
        VALUES (${caller.merchantId}, ${input.endpointId}::uuid, ${input.requestId}::uuid, ${caller.userId}, ${overlap})`;
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

  /** Every attempt at one delivery, oldest first: when, the outcome, the response code, how long it took. */
  async attempts(caller: MerchantCaller, input: { deliveryId: string }) {
    assertPermission(caller, 'webhooks.read');
    const sql = this.sql;
    const owned = await sql<Array<{ id: string }>>`
      SELECT id FROM pay.merchant_webhook_deliveries WHERE id = ${input.deliveryId}::uuid AND merchant_id = ${caller.merchantId}`;
    if (!owned[0]) throw deliveryNotFound();
    const rows = await sql<
      Array<{
        attempt_no: number;
        started_at: Date;
        finished_at: Date;
        outcome: 'delivered' | 'failed' | 'unknown';
        status_code: number | null;
        error: string | null;
        resend_request_id: string | null;
      }>
    >`
      SELECT attempt_no, started_at, finished_at, outcome, status_code, error, resend_request_id
        FROM pay.merchant_webhook_attempts
       WHERE delivery_id = ${input.deliveryId}::uuid AND merchant_id = ${caller.merchantId}
       ORDER BY attempt_no ASC`;
    return {
      deliveryId: input.deliveryId,
      attempts: rows.map((r) => ({
        attemptNo: r.attempt_no,
        at: iso(r.started_at),
        outcome: r.outcome,
        statusCode: r.status_code,
        error: r.error,
        durationMs: Math.max(0, r.finished_at.getTime() - r.started_at.getTime()),
        resend: r.resend_request_id !== null,
      })),
    };
  }

  /** The resend window and the rate budget, or the named refusal for whichever is blank. */
  private resendLimits(): { windowMs: number; rate: WebhookRetryLimit } {
    const rate = this.options.retry;
    if (!rate || !Number.isInteger(rate.maxPerWindow) || rate.maxPerWindow < 1 || !Number.isInteger(rate.windowMs) || rate.windowMs < 1) {
      throw new MerchantOpsError('pay.webhook_retry_unconfigured', 'precondition');
    }
    const window = this.settings.resendWindowSeconds;
    if (window === undefined) throw new MerchantOpsError('pay.webhook_resend_window_unset', 'precondition');
    return { windowMs: window * 1000, rate };
  }

  /** Resends and recoveries share one rate budget per merchant. Call holding the merchant's row lock. */
  private async assertRate(tx: Querier, merchantId: string, rate: WebhookRetryLimit): Promise<void> {
    const windowStart = new Date(Date.now() - rate.windowMs);
    const counted = await tx<Array<{ n: number }>>`
      SELECT (SELECT count(*) FROM pay.merchant_webhook_retries WHERE merchant_id = ${merchantId} AND created_at >= ${windowStart})::int
           + (SELECT count(*) FROM pay.merchant_webhook_recoveries WHERE merchant_id = ${merchantId} AND created_at >= ${windowStart})::int AS n`;
    if ((counted[0]?.n ?? 0) >= rate.maxPerWindow) throw new MerchantOpsError('pay.webhook_retry_rate_limited', 'precondition');
  }

  /**
   * Resend one event to its endpoint: the next drain makes one new attempt, tagged with this request id. A repeat of
   * the request id queues nothing more. Any delivery that is not already waiting may be resent, delivered ones too, if
   * it was written inside the owner's resend window; one older refuses (`pay.webhook_resend_outside_window`). One that
   * is waiting (`pending`) or whose last attempt's outcome is unknown and still leased refuses
   * (`pay.webhook_resend_already_queued`): it is about to be tried anyway.
   */
  async retry(caller: MerchantCaller, input: { requestId: string; deliveryId: string }) {
    assertPermission(caller, 'webhooks.manage');
    assertStepUp(caller);
    const { windowMs, rate } = this.resendLimits();
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
      const found = await tx<Array<{ status: WebhookDeliveryStatus; created_at: Date; next_attempt_at: Date; endpoint_status: string }>>`
        SELECT d.status, d.created_at, d.next_attempt_at, e.status AS endpoint_status
          FROM pay.merchant_webhook_deliveries d
          JOIN pay.merchant_webhook_endpoints e ON e.id = d.endpoint_id
         WHERE d.id = ${input.deliveryId}::uuid AND d.merchant_id = ${caller.merchantId}
         FOR UPDATE OF d`;
      const row = found[0];
      if (!row) throw deliveryNotFound();
      if (row.created_at.getTime() < Date.now() - windowMs) throw new MerchantOpsError('pay.webhook_resend_outside_window', 'precondition');
      if (row.status === 'pending' || (row.status === 'unknown' && row.next_attempt_at.getTime() > Date.now())) {
        throw new MerchantOpsError('pay.webhook_resend_already_queued', 'conflict');
      }
      if (row.endpoint_status !== 'active') throw new MerchantOpsError('pay.webhook_endpoint_disabled', 'precondition');
      await this.assertRate(tx, caller.merchantId, rate);
      const updated = await tx<DeliveryRow[]>`
        UPDATE pay.merchant_webhook_deliveries
           SET status = 'pending', next_attempt_at = now(), last_error = NULL, resend_request_id = ${input.requestId}::uuid
         WHERE id = ${input.deliveryId}::uuid AND merchant_id = ${caller.merchantId}
         RETURNING ${DELIVERY_FIELDS(tx)}`;
      await tx`
        INSERT INTO pay.merchant_webhook_retries (merchant_id, request_id, delivery_id, requested_by)
        VALUES (${caller.merchantId}, ${input.requestId}::uuid, ${input.deliveryId}::uuid, ${caller.userId})`;
      return { retried: true as const, delivery: deliveryView(updated[0]!) };
    });
  }

  /**
   * Recover missed events: every event since `since` that this endpoint did not take (failed, or given up on) is
   * queued again, each for one new attempt tagged with the request id. `since` must lie inside the resend window.
   * Idempotent on the request id: a repeat answers the first count and queues nothing.
   */
  async recover(caller: MerchantCaller, input: { requestId: string; endpointId: string; since: string }) {
    assertPermission(caller, 'webhooks.manage');
    assertStepUp(caller);
    const { windowMs, rate } = this.resendLimits();
    const since = Date.parse(input.since);
    if (!Number.isFinite(since) || since > Date.now()) throw new MerchantOpsError('pay.webhook_recover_since_invalid', 'bad_request');
    if (since < Date.now() - windowMs) throw new MerchantOpsError('pay.webhook_resend_outside_window', 'precondition');
    const sql = this.sql;
    return sql.begin(async (tx) => {
      const replay = async () => {
        const prior = await tx<Array<{ endpoint_id: string; queued: number }>>`
          SELECT endpoint_id, queued FROM pay.merchant_webhook_recoveries
           WHERE merchant_id = ${caller.merchantId} AND request_id = ${input.requestId}::uuid`;
        if (!prior[0]) return null;
        if (prior[0].endpoint_id !== input.endpointId) throw new MerchantOpsError('pay.request_id_reused', 'conflict');
        return { recovered: false as const, queued: prior[0].queued };
      };
      const first = await replay();
      if (first) return first;
      await tx`SELECT id FROM pay.merchants WHERE id = ${caller.merchantId} FOR UPDATE`;
      const again = await replay();
      if (again) return again;
      const endpoint = await tx<Array<{ status: string }>>`
        SELECT status FROM pay.merchant_webhook_endpoints WHERE id = ${input.endpointId}::uuid AND merchant_id = ${caller.merchantId}`;
      if (!endpoint[0]) throw notFound();
      if (endpoint[0].status !== 'active') throw new MerchantOpsError('pay.webhook_endpoint_disabled', 'precondition');
      await this.assertRate(tx, caller.merchantId, rate);
      const queued = await tx<Array<{ id: string }>>`
        UPDATE pay.merchant_webhook_deliveries
           SET status = 'pending', next_attempt_at = now(), last_error = NULL, resend_request_id = ${input.requestId}::uuid
         WHERE merchant_id = ${caller.merchantId} AND endpoint_id = ${input.endpointId}::uuid
           AND status IN ('failed', 'dead')
           AND created_at >= ${new Date(since)}
         RETURNING id`;
      await tx`
        INSERT INTO pay.merchant_webhook_recoveries (merchant_id, request_id, endpoint_id, since, queued, requested_by)
        VALUES (${caller.merchantId}, ${input.requestId}::uuid, ${input.endpointId}::uuid, ${new Date(since)}, ${queued.length},
                ${caller.userId})`;
      return { recovered: true as const, queued: queued.length };
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
        unknown: number;
        last_delivered_at: Date | null;
      }>
    >`
      SELECT e.id, e.status, e.consecutive_failures,
             count(d.id) FILTER (WHERE d.status = 'pending')::int AS pending,
             count(d.id) FILTER (WHERE d.status = 'delivered')::int AS delivered,
             count(d.id) FILTER (WHERE d.status = 'failed')::int AS failed,
             count(d.id) FILTER (WHERE d.status = 'dead')::int AS dead,
             count(d.id) FILTER (WHERE d.status = 'unknown')::int AS unknown,
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
        deliveries: { pending: row.pending, delivered: row.delivered, failed: row.failed, dead: row.dead, unknown: row.unknown },
        lastDeliveredAt: row.last_delivered_at ? iso(row.last_delivered_at) : null,
      })),
    };
  }

  /** The owner's webhook values as they stand, each null when blank, so a page can say what is and is not set. */
  policy(caller: MerchantCaller) {
    assertPermission(caller, 'webhooks.read');
    const s = this.settings;
    const rate = this.options.retry;
    return {
      endpointCap: s.endpointCap ?? null,
      overlapMaxSeconds: s.overlapMaxSeconds ?? null,
      resendWindowSeconds: s.resendWindowSeconds ?? null,
      retryScheduleSeconds: s.retryScheduleSeconds ? [...s.retryScheduleSeconds] : null,
      resendRate: rate ? { maxPerWindow: rate.maxPerWindow, windowMs: rate.windowMs } : null,
    };
  }

  catalogue(caller: MerchantCaller) {
    assertPermission(caller, 'webhooks.read');
    return webhookCatalogue();
  }

  guide(caller: MerchantCaller) {
    assertPermission(caller, 'webhooks.read');
    return receiverGuide(this.settings);
  }
}

async function loadDelivery(sql: Querier, merchantId: string, deliveryId: string) {
  const rows = await sql<DeliveryRow[]>`
    SELECT ${DELIVERY_FIELDS(sql)} FROM pay.merchant_webhook_deliveries
     WHERE id = ${deliveryId}::uuid AND merchant_id = ${merchantId}`;
  if (!rows[0]) throw deliveryNotFound();
  return deliveryView(rows[0]);
}
