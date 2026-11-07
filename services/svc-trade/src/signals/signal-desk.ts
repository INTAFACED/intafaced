/**
 * Chart alert webhooks (CB-bots-api-signal-01, J-copy-bots-otc-20).
 *
 * A person creates a webhook for one market. The reply carries its intake path and a secret token, once; the token is
 * kept only as a SHA-256 hash and a six-character prefix, so every later read shows the prefix alone. The creator's own
 * place grant is stored with it (as a TWAP stores its grant) and lasts the owner's webhook life
 * (TRADE_SIGNAL_WEBHOOK_DAYS; blank refuses every create).
 *
 * An alert POSTed to the intake path is checked in this order, and nothing is written for any refusal before the last:
 * the token (wrong: `trade.signal_auth_failed`, 401); the owner's maximum alert age (TRADE_SIGNAL_MAX_ALERT_AGE_SECONDS;
 * blank: `trade.signal_latency_not_set`; older: `trade.signal_stale`); the alert id and the message's fields, each
 * named when missing. Then one intent row per planned action is written under `signal.alert:<webhookId>:<alertId>`,
 * before the order call, and the order goes through the ordinary place path as the creator. The reply is stored, so the
 * same alert id again returns it exactly and places nothing.
 *
 * Nothing here holds or moves money of its own: an alert's order is an ordinary order from the person's balance.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import { captureAlgoPlaceGrant, parseAlgoPlaceGrant, principalFromAlgoGrant } from '../algo/durable-principal.js';

export const SIGNAL_INTAKE_PATH = '/api/v1/signals/webhook';
const TOKEN_BYTES = 24;
const LIST_MAX = 100;
const MAX_AGE_LIMIT_SECONDS = 3600;
const WEBHOOK_DAYS_LIMIT = 366;

export class SignalError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'SignalError';
  }
}

export interface SignalWebhookView {
  readonly webhookId: string;
  readonly symbol: string;
  readonly path: string;
  readonly tokenPrefix: string;
  readonly state: 'active' | 'paused' | 'ended';
  readonly createdAt: string;
}

export interface SignalIntentView {
  readonly alertId: string;
  readonly action: 'open' | 'close';
  readonly side: 'buy' | 'sell';
  readonly sizing: { readonly kind: 'quantity'; readonly value: string };
  readonly status: 'pending' | 'placed' | 'refused' | 'unknown';
  readonly orderId: string | null;
  readonly code: string | null;
  readonly createdAt: string;
}

export interface SignalPorts {
  readonly sql: Sql;
  readonly now: () => Date;
  /** A market's id by its symbol, or null when none exists or it is not an open spot market. */
  marketIdBySymbol(symbol: string): Promise<string | null>;
  /** The ordinary place path, as the webhook's creator. */
  placeOrder(
    principal: Principal,
    input: { marketId: string; side: 'buy' | 'sell'; qty: Amount; clientOrderId: string },
  ): Promise<{ id: string }>;
  /** Owner: the oldest alert accepted, in seconds. Null: unset, and intake refuses `trade.signal_latency_not_set`. */
  readonly maxAlertAgeSeconds: number | null;
  /** Owner: how long a webhook may place for its creator, in days. Null: unset, and create refuses. */
  readonly webhookDays: number | null;
}

/** Whole seconds 1..3600, or null when blank. Anything else stops the boot. */
export function parseSignalMaxAge(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_AGE_LIMIT_SECONDS) {
    throw new Error(`TRADE_SIGNAL_MAX_ALERT_AGE_SECONDS must be whole seconds, 1 to ${MAX_AGE_LIMIT_SECONDS}, or blank`);
  }
  return n;
}

/** Whole days 1..366, or null when blank. Anything else stops the boot. */
export function parseSignalWebhookDays(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > WEBHOOK_DAYS_LIMIT) {
    throw new Error(`TRADE_SIGNAL_WEBHOOK_DAYS must be whole days, 1 to ${WEBHOOK_DAYS_LIMIT}, or blank`);
  }
  return n;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** A stable id from a business key, so a retried write lands on the same row. */
function idFor(key: string): string {
  const h = sha256(key);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The webhook's market, as the person names it: `BTCUSDT`, `BTC-USDT` or `BTC/USDT`, all meaning BTC/USDT. */
export function canonicalSymbol(raw: string): string | null {
  const v = raw.trim().toUpperCase().replace(/[-_]/g, '/');
  if (/^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/.test(v)) return v;
  const quote = ['USDT', 'USDC', 'USD', 'EUR', 'BTC', 'ETH'].find((q) => v.endsWith(q) && v.length > q.length);
  return quote ? `${v.slice(0, -quote.length)}/${quote}` : null;
}

interface WebhookRow {
  id: string;
  user_id: string;
  symbol: string;
  market_id: string;
  token_hash: string;
  token_prefix: string;
  place_grant: unknown;
  grant_expires_at: Date;
  state: 'active' | 'paused' | 'ended';
  created_at: Date;
}

interface IntentRow {
  alert_id: string;
  action: 'open' | 'close';
  side: 'buy' | 'sell';
  sizing: { kind: 'quantity'; value: string };
  status: SignalIntentView['status'];
  order_id: string | null;
  code: string | null;
  created_at: Date;
}

const webhookView = (row: WebhookRow): SignalWebhookView => ({
  webhookId: row.id,
  symbol: row.symbol,
  path: `${SIGNAL_INTAKE_PATH}/${row.id}`,
  tokenPrefix: row.token_prefix,
  state: row.state,
  createdAt: row.created_at.toISOString(),
});

const intentView = (row: IntentRow): SignalIntentView => ({
  alertId: row.alert_id,
  action: row.action,
  side: row.side,
  sizing: row.sizing,
  status: row.status,
  orderId: row.order_id,
  code: row.code,
  createdAt: row.created_at.toISOString(),
});

/** What an alert answers: its status code and body, the same for a repeat of the same alert id. */
export interface AlertReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const refusal = (err: SignalError): AlertReply => ({
  status: err.status,
  body: { ok: false, code: err.code, message: err.message, ...(err.field ? { field: err.field } : {}) },
});

export class SignalDesk {
  constructor(private readonly ports: SignalPorts) {}

  /** A webhook for one market. The token is in this reply only. The same request key again answers the same webhook, without its token. */
  async create(
    principal: Principal,
    input: { symbol: string; clientRequestId: string },
  ): Promise<SignalWebhookView & { readonly token: string | null }> {
    const days = this.ports.webhookDays;
    if (days === null)
      throw new SignalError('The platform has not set how long a webhook may place orders', 'trade.signal_webhook_life_not_set', 412);
    const symbol = canonicalSymbol(input.symbol);
    if (!symbol) throw new SignalError('Market is not a symbol such as BTC/USDT', 'trade.signal_symbol_invalid', 400, 'symbol');
    const marketId = await this.ports.marketIdBySymbol(symbol);
    if (!marketId) throw new SignalError(`${symbol} is not an open spot market`, 'trade.signal_symbol_invalid', 400, 'symbol');
    const requestId = input.clientRequestId.trim();
    if (!/^[A-Za-z0-9:._-]{8,120}$/.test(requestId)) {
      throw new SignalError(
        'clientRequestId must be 8 to 120 letters, digits or : . _ -',
        'trade.signal_request_key_invalid',
        400,
        'clientRequestId',
      );
    }
    const [existing] = await this.ports.sql<WebhookRow[]>`
      SELECT * FROM trade.signal_webhooks WHERE user_id = ${principal.userId} AND client_request_id = ${requestId}`;
    if (existing) return { ...webhookView(existing), token: null };
    const grant = captureAlgoPlaceGrant(principal);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const now = this.ports.now();
    const expires = new Date(now.getTime() + days * 86_400_000);
    const [row] = await this.ports.sql<WebhookRow[]>`
      INSERT INTO trade.signal_webhooks
        (id, user_id, client_request_id, symbol, market_id, token_hash, token_prefix, place_grant, grant_expires_at, state, created_at, updated_at)
      VALUES (${randomUUID()}, ${principal.userId}, ${requestId}, ${symbol}, ${marketId}, ${sha256(token)}, ${token.slice(0, 6)},
        ${this.ports.sql.json(grant as never)}, ${expires.toISOString()}, 'active', ${now.toISOString()}, ${now.toISOString()})
      ON CONFLICT (user_id, client_request_id) DO NOTHING
      RETURNING *`;
    if (!row) {
      const [raced] = await this.ports.sql<WebhookRow[]>`
        SELECT * FROM trade.signal_webhooks WHERE user_id = ${principal.userId} AND client_request_id = ${requestId}`;
      return { ...webhookView(raced!), token: null };
    }
    return { ...webhookView(row), token };
  }

  /** The person's webhooks, newest first, each with its token prefix only. */
  async list(principal: Principal): Promise<SignalWebhookView[]> {
    const rows = await this.ports.sql<WebhookRow[]>`
      SELECT * FROM trade.signal_webhooks WHERE user_id = ${principal.userId} ORDER BY created_at DESC, id DESC LIMIT ${LIST_MAX}`;
    return rows.map(webhookView);
  }

  /** One webhook's intents, oldest first. Another person's webhook reads as not found. */
  async intents(principal: Principal, webhookId: string): Promise<{ items: SignalIntentView[] }> {
    const hook = await this.owned(principal, webhookId);
    const rows = await this.ports.sql<IntentRow[]>`
      SELECT * FROM trade.signal_intents WHERE webhook_id = ${hook.id} ORDER BY created_at ASC, id ASC LIMIT ${LIST_MAX * 5}`;
    return { items: rows.map(intentView) };
  }

  /** One alert, as it arrives at the intake path. Never throws: every outcome is a reply. */
  async ingest(webhookId: string, raw: unknown): Promise<AlertReply> {
    try {
      return await this.ingestOrRefuse(webhookId, raw);
    } catch (err) {
      if (err instanceof SignalError) return refusal(err);
      throw err;
    }
  }

  private async ingestOrRefuse(webhookId: string, raw: unknown): Promise<AlertReply> {
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const authFailed = new SignalError('The webhook token is not valid', 'trade.signal_auth_failed', 401);
    if (!/^[0-9a-f-]{36}$/i.test(webhookId)) throw authFailed;
    const [hook] = await this.ports.sql<WebhookRow[]>`SELECT * FROM trade.signal_webhooks WHERE id = ${webhookId}`;
    const token = typeof body.token === 'string' ? body.token : '';
    // The same work whether or not the webhook exists, and a constant-time compare of the hashes.
    const presented = Buffer.from(sha256(token), 'hex');
    const held = Buffer.from(hook?.token_hash ?? sha256(`absent:${webhookId}`), 'hex');
    if (!hook || !token || !timingSafeEqual(presented, held)) throw authFailed;

    const maxAge = this.ports.maxAlertAgeSeconds;
    if (maxAge === null) throw new SignalError('The platform has not set how old an alert may be', 'trade.signal_latency_not_set', 503);
    const sent = typeof body.time === 'string' ? Date.parse(body.time) : Number.NaN;
    if (!Number.isFinite(sent))
      throw new SignalError('time is required: when the alert fired, as an ISO time', 'trade.signal_format_invalid', 400, 'time');
    const now = this.ports.now();
    if (now.getTime() - sent > maxAge * 1000) {
      throw new SignalError(`The alert is older than ${maxAge} seconds (stale), so it was not used`, 'trade.signal_stale', 400);
    }
    const alertId = typeof body.alertId === 'string' ? body.alertId.trim() : '';
    if (!alertId || alertId.length > 120)
      throw new SignalError('alertId is required (1 to 120 characters)', 'trade.signal_format_invalid', 400, 'alertId');

    // A repeat of an alert id answers what the first one got, whatever the webhook's state now.
    const [stored] = await this.ports.sql<Array<{ status: number; body: Record<string, unknown> }>>`
      SELECT status, body FROM trade.signal_alert_results WHERE webhook_id = ${hook.id} AND alert_id = ${alertId}`;
    if (stored) return { status: stored.status, body: stored.body };

    if (hook.state === 'paused') throw new SignalError('This webhook is paused', 'trade.signal_paused', 409);
    if (hook.state === 'ended') throw new SignalError('This webhook has ended', 'trade.signal_webhook_ended', 410);

    const side = body.side;
    if (side !== 'buy' && side !== 'sell')
      throw new SignalError('side is required: buy or sell', 'trade.signal_format_invalid', 400, 'side');
    const amountText = typeof body.amount === 'string' ? body.amount.trim() : typeof body.amount === 'number' ? String(body.amount) : '';
    let qty: Amount;
    try {
      qty = parseAmount(amountText);
    } catch {
      throw new SignalError('amount is required: a decimal quantity', 'trade.signal_format_invalid', 400, 'amount');
    }
    if (qty <= 0n) throw new SignalError('amount must be above zero', 'trade.signal_format_invalid', 400, 'amount');

    const key = `signal.alert:${hook.id}:${alertId}:open`;
    const at = now.toISOString();
    // The intent row is written before the order call; a crash after it leaves it pending under its key.
    await this.ports.sql`
      INSERT INTO trade.signal_intents (id, webhook_id, alert_id, action, intent_key, side, sizing, status, created_at, updated_at)
      VALUES (${idFor(key)}, ${hook.id}, ${alertId}, 'open', ${key}, ${side},
        ${this.ports.sql.json({ kind: 'quantity', value: formatAmount(qty) } as never)}, 'pending', ${at}, ${at})
      ON CONFLICT (intent_key) DO NOTHING`;
    let status: SignalIntentView['status'];
    let orderId: string | null = null;
    let code: string | null = null;
    try {
      const grant = parseAlgoPlaceGrant(hook.place_grant);
      if (!grant) throw new SignalError('This webhook holds no place grant', 'trade.signal_grant_unavailable', 422);
      const principal = principalFromAlgoGrant({ userId: hook.user_id, grant, expiresAt: hook.grant_expires_at, now });
      const order = await this.ports.placeOrder(principal, {
        marketId: hook.market_id,
        side,
        qty,
        clientOrderId: `sig-${sha256(key).slice(0, 40)}`,
      });
      status = 'placed';
      orderId = order.id;
    } catch (err) {
      code =
        (err as { code?: unknown })?.code && typeof (err as { code: unknown }).code === 'string' ? (err as { code: string }).code : null;
      status = code ? 'refused' : 'unknown';
    }
    await this.ports.sql`
      UPDATE trade.signal_intents SET status = ${status}, order_id = ${orderId}, code = ${code}, updated_at = ${this.ports.now().toISOString()}
      WHERE intent_key = ${key}`;
    const reply: AlertReply = {
      status: status === 'placed' ? 200 : status === 'refused' ? 422 : 202,
      body: { ok: status === 'placed', alertId, intents: [{ action: 'open', side, status, orderId, code }] },
    };
    // An unknown order outcome is not stored as final: a repeat re-reads the intent instead of answering a guess.
    if (status !== 'unknown') {
      await this.ports.sql`
        INSERT INTO trade.signal_alert_results (webhook_id, alert_id, status, body, created_at)
        VALUES (${hook.id}, ${alertId}, ${reply.status}, ${this.ports.sql.json(reply.body as never)}, ${at})
        ON CONFLICT (webhook_id, alert_id) DO NOTHING`;
      const [kept] = await this.ports.sql<Array<{ status: number; body: Record<string, unknown> }>>`
        SELECT status, body FROM trade.signal_alert_results WHERE webhook_id = ${hook.id} AND alert_id = ${alertId}`;
      if (kept) return { status: kept.status, body: kept.body };
    }
    return reply;
  }

  private async owned(principal: Principal, webhookId: string): Promise<WebhookRow> {
    if (!/^[0-9a-f-]{36}$/i.test(webhookId)) throw new SignalError('Webhook not found', 'trade.signal_webhook_not_found', 404);
    const [row] = await this.ports.sql<WebhookRow[]>`
      SELECT * FROM trade.signal_webhooks WHERE id = ${webhookId} AND user_id = ${principal.userId}`;
    if (!row) throw new SignalError('Webhook not found', 'trade.signal_webhook_not_found', 404);
    return row;
  }
}
