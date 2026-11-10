/**
 * Chart alert webhooks (CB-bots-api-signal-01, J-copy-bots-otc-20).
 *
 * A person creates a webhook for one venue market (a market the user-venue door lists) and the venue account they sign
 * for. The reply carries its intake path and a secret token, once; the token is kept only as a SHA-256 hash and a
 * six-character prefix, so every later read shows the prefix alone. The creator's own place grant is stored with it (as
 * a TWAP stores its grant) and lasts the owner's webhook life (TRADE_SIGNAL_WEBHOOK_DAYS; blank refuses every create).
 * With the door off, create refuses `trade.signal_venue_off`.
 *
 * An alert POSTed to the intake path is checked in this order, and nothing is written for any refusal before the last:
 * the token (wrong: `trade.signal_auth_failed`, 403; never 401, as the route is public and a signed-out caller is not asked for a credential); the owner's maximum alert age (TRADE_SIGNAL_MAX_ALERT_AGE_SECONDS;
 * blank: `trade.signal_latency_not_set`; older: `trade.signal_stale`); the alert id and the message's fields, each
 * named when missing. Then one intent row per planned action is written under `signal.alert:<webhookId>:<alertId>`,
 * before the order is prepared, and the order is prepared through svc-trade's user-venue door as the creator, under the
 * alert's own business key `signal-order:<webhookId>:<alertId>` (a market IOC of the alert's amount, no worse than its price).
 * The door never holds a key that can sign: the person's own wallet signs the prepared order and sends it
 * (`POST /api/v1/venue/submit` with the action key), and nothing reaches the venue before that. The reply is stored, so
 * the same alert id again returns it exactly and prepares nothing.
 *
 * Nothing here holds or moves money: the venue is the record of the person's balances and fills.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { PlaceUserOrderIntent } from '@intafaced/venue-contracts';
import type { Principal } from '@intafaced/auth';
import { captureAlgoPlaceGrant, parseAlgoPlaceGrant, principalFromAlgoGrant } from '../algo/durable-principal.js';
import { assertPlaceEligible } from '../spot/place-eligibility.js';

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
  readonly venueOwner: string;
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
  readonly status: 'pending' | 'prepared' | 'refused' | 'unknown';
  /** The door's key for the prepared order: what the person's wallet signs and sends it under. */
  readonly actionKey: string | null;
  readonly venueClientOrderId: string | null;
  readonly code: string | null;
  readonly createdAt: string;
}

export interface SignalPorts {
  readonly sql: Sql;
  readonly now: () => Date;
  /** The venue markets the user-venue door lists now; null when the door is off. */
  venueMarkets(): Promise<readonly string[] | null>;
  /** The creator's live verification tier from identity, read on every alert. Throws when it cannot be read. */
  liveTier(userId: string): Promise<Principal['tier']>;
  /** The trading admission of the webhook as a `strategy.start` operation, business id `signal:<webhookId>`. */
  admitStart(principal: Principal, businessId: string, payload: unknown): Promise<unknown>;
  /**
   * The trading admission of one alert's order, a delegated `algo.child` of `signal:<webhookId>`: a restricted or frozen
   * account is refused here by its own code, before anything is prepared.
   */
  admitAlert(principal: Principal, businessId: string, payload: unknown, webhookId: string): Promise<unknown>;
  /**
   * The user-venue door's prepare for one alert's order, signed for by the account's owner wallet. A refusal of the door
   * or the venue answers its code; anything else throws, and the intent stays unknown.
   */
  prepareOrder(
    principal: Principal,
    input: { owner: string; intent: PlaceUserOrderIntent },
  ): Promise<{ ok: true; actionKey: string; venueClientOrderId: string | null } | { ok: false; code: string }>;
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

/** The webhook's market, as the person names it: `BTCUSDC`, `BTC/USDC` or `BTC-USDC`, all meaning the venue's BTC-USDC. */
export function canonicalSymbol(raw: string): string | null {
  const v = raw.trim().toUpperCase().replace(/[/_]/g, '-');
  if (/^[A-Z0-9]{2,15}-[A-Z0-9]{2,15}$/.test(v)) return v;
  const quote = ['USDT', 'USDC', 'USD', 'EUR', 'BTC', 'ETH'].find((q) => v.endsWith(q) && v.length > q.length);
  return quote ? `${v.slice(0, -quote.length)}-${quote}` : null;
}

const OWNER_RE = /^0x[0-9a-f]{40}$/;

interface WebhookRow {
  id: string;
  user_id: string;
  symbol: string;
  venue_owner: string;
  region: string;
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
  action_key: string | null;
  venue_client_order_id: string | null;
  code: string | null;
  created_at: Date;
}

const webhookView = (row: WebhookRow): SignalWebhookView => ({
  webhookId: row.id,
  symbol: row.symbol,
  venueOwner: row.venue_owner,
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
  actionKey: row.action_key,
  venueClientOrderId: row.venue_client_order_id,
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

/** The webhook's admitted strategy: its alerts' orders are delegated children of it. */
export const signalBusinessId = (webhookId: string) => `signal:${webhookId}`;

/** One alert's order, as the user-venue door keeps it: the business key its prepared action is stored under. */
export const signalOrderKey = (webhookId: string, alertId: string) => `signal-order:${webhookId}:${alertId}`;

export class SignalDesk {
  constructor(private readonly ports: SignalPorts) {}

  /** A webhook for one venue market and account. The token is in this reply only. The same request key again answers the same webhook, without its token. */
  async create(
    principal: Principal,
    input: { symbol: string; venueOwner: string; clientRequestId: string },
    /**
     * The request's region as the edge resolved it; kept on the webhook for the jurisdiction check on each alert. The
     * create itself is gated by its procedure (`scopedProcedure(..., { module: 'trade' })`: tier and jurisdiction).
     */
    region: string,
  ): Promise<SignalWebhookView & { readonly token: string | null }> {
    const days = this.ports.webhookDays;
    if (days === null)
      throw new SignalError('The platform has not set how long a webhook may place orders', 'trade.signal_webhook_life_not_set', 412);
    const symbol = canonicalSymbol(input.symbol);
    if (!symbol) throw new SignalError('Market is not a symbol such as BTC-USDC', 'trade.signal_symbol_invalid', 400, 'symbol');
    const owner = input.venueOwner.trim().toLowerCase();
    if (!OWNER_RE.test(owner))
      throw new SignalError(
        'The venue account is your wallet address, 0x and 40 hex digits',
        'trade.signal_owner_invalid',
        400,
        'venueOwner',
      );
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
    const markets = await this.ports.venueMarkets();
    if (markets === null)
      throw new SignalError('Venue trading is not switched on, so an alert has nowhere to trade', 'trade.signal_venue_off', 412);
    if (!markets.includes(symbol))
      throw new SignalError(`${symbol} is not a venue market we list`, 'trade.signal_symbol_invalid', 400, 'symbol');
    const grant = captureAlgoPlaceGrant(principal);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const now = this.ports.now();
    const expires = new Date(now.getTime() + days * 86_400_000);
    // The webhook is admitted as a strategy, as a grid bot is: each alert's order is then a delegated child of it.
    // The webhook's id comes from the person and their request key, so a retried create admits the same strategy.
    const webhookId = idFor(`signal-webhook:${principal.userId}:${requestId}`);
    await this.ports.admitStart(principal, signalBusinessId(webhookId), {
      webhookId,
      symbol,
      venueOwner: owner,
      expiresAt: expires.toISOString(),
    });
    const [row] = await this.ports.sql<WebhookRow[]>`
      INSERT INTO trade.signal_webhooks
        (id, user_id, client_request_id, symbol, venue_owner, region, token_hash, token_prefix, place_grant, grant_expires_at, state, created_at, updated_at)
      VALUES (${webhookId}, ${principal.userId}, ${requestId}, ${symbol}, ${owner}, ${region}, ${sha256(token)}, ${token.slice(0, 6)},
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
    const authFailed = new SignalError('The webhook token is not valid', 'trade.signal_auth_failed', 403);
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
    // Money arrives as decimal strings only: a JSON number may already have lost digits before it reaches us.
    const amountText = typeof body.amount === 'string' ? body.amount.trim() : '';
    let qty: Amount;
    try {
      qty = parseAmount(amountText);
    } catch {
      throw new SignalError('amount is required: a decimal quantity, as a string', 'trade.signal_format_invalid', 400, 'amount');
    }
    if (qty <= 0n) throw new SignalError('amount must be above zero', 'trade.signal_format_invalid', 400, 'amount');
    // A market order on the venue carries the worst price it accepts: the alert names it, as TradingView's {{close}} can.
    const priceText = typeof body.price === 'string' ? body.price.trim() : '';
    let price: Amount;
    try {
      price = parseAmount(priceText);
    } catch {
      throw new SignalError(
        'price is required: the worst price the order accepts, as a decimal string',
        'trade.signal_format_invalid',
        400,
        'price',
      );
    }
    if (price <= 0n) throw new SignalError('price must be above zero', 'trade.signal_format_invalid', 400, 'price');

    const key = `signal.alert:${hook.id}:${alertId}:open`;
    const at = now.toISOString();
    // The intent row is written before the order is prepared; a crash after it leaves it pending under its key, and the
    // door's own store under the alert's order key means a later prepare of it returns the same action, never a second.
    await this.ports.sql`
      INSERT INTO trade.signal_intents (id, webhook_id, alert_id, action, intent_key, side, sizing, status, created_at, updated_at)
      VALUES (${idFor(key)}, ${hook.id}, ${alertId}, 'open', ${key}, ${side},
        ${this.ports.sql.json({ kind: 'quantity', value: formatAmount(qty) } as never)}, 'pending', ${at}, ${at})
      ON CONFLICT (intent_key) DO NOTHING`;
    let status: SignalIntentView['status'];
    let actionKey: string | null = null;
    let venueClientOrderId: string | null = null;
    let code: string | null = null;
    try {
      const grant = parseAlgoPlaceGrant(hook.place_grant);
      if (!grant) throw new SignalError('This webhook holds no place grant', 'trade.signal_grant_unavailable', 422);
      const principal = principalFromAlgoGrant({ userId: hook.user_id, grant, expiresAt: hook.grant_expires_at, now });
      // The same check as a signed-in order (OWNER 88), on the creator's tier as identity holds it now, never the tier
      // the stored grant carries from the create, and the region recorded at create. A refusal places nothing.
      assertPlaceEligible({ tier: await this.ports.liveTier(hook.user_id), region: hook.region });
      const intent: PlaceUserOrderIntent = {
        kind: 'place_order',
        symbol: hook.symbol,
        side,
        type: 'market',
        amount: qty,
        price,
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: signalOrderKey(hook.id, alertId),
        builderFee: null,
      };
      await this.ports.admitAlert(
        principal,
        intent.clientOrderKey,
        { webhookId: hook.id, alertId, symbol: hook.symbol, side, amount: formatAmount(qty), price: formatAmount(price) },
        hook.id,
      );
      const prepared = await this.ports.prepareOrder(principal, { owner: hook.venue_owner, intent });
      if (prepared.ok) {
        status = 'prepared';
        actionKey = prepared.actionKey;
        venueClientOrderId = prepared.venueClientOrderId;
      } else {
        status = 'refused';
        code = prepared.code;
      }
    } catch (err) {
      code =
        (err as { code?: unknown })?.code && typeof (err as { code: unknown }).code === 'string' ? (err as { code: string }).code : null;
      status = code ? 'refused' : 'unknown';
    }
    await this.ports.sql`
      UPDATE trade.signal_intents SET status = ${status}, action_key = ${actionKey}, venue_client_order_id = ${venueClientOrderId}, code = ${code}, updated_at = ${this.ports.now().toISOString()}
      WHERE intent_key = ${key}`;
    const reply: AlertReply = {
      status: status === 'prepared' ? 200 : status === 'refused' ? 422 : 202,
      body: {
        ok: status === 'prepared',
        alertId,
        intents: [{ action: 'open', side, status, actionKey, venueClientOrderId, code }],
        // Prepared is not sent: the person's wallet signs it and sends it, and only then does it reach the venue.
        ...(status === 'prepared' ? { next: 'sign the prepared order in your wallet and send it: POST /api/v1/venue/submit' } : {}),
      },
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
