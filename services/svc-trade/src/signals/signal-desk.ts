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
 * The message forms (CB-bots-api-signal-02) are a closed set: `side` is buy, sell or reverse; `amount` is a quantity, or a
 * percent of the position (`"50%"`, or `amountType: "position_percent"`); `price` is the worst price accepted. A percent
 * of the position, and a reversal, read the venue account's position on the webhook's market (spot: the base asset held;
 * a perpetual: its signed size). A reversal plans two intents, each under its own key: the close of the whole position,
 * then the open the other way; an open the market cannot hold (a short on cash spot) is refused by its own code, and an
 * open after a close that was not prepared is refused too, so a reversal never opens without closing first.
 *
 * Pause, resume and end are the person's (`trade.signals.webhooks.pause|resume|end`). An alert whose every order was
 * refused is a failure; a prepared one sets the count back to zero. At the owner's count in a row
 * (TRADE_SIGNAL_FAILURE_COUNT; blank: every alert refuses `trade.signal_failure_count_not_set`) the webhook ends, once.
 * The count moves only when an alert's reply is first stored, so a repeat of the same alert id never counts twice.
 *
 * A notification URL (CB-bots-api-signal-03) is a second kind of webhook with its own token. Its alerts are checked the
 * same way (token, age, alert id) and each becomes one in-app notice through svc-notify (`trade.signal_note.created`, key
 * `signal.note:<webhookId>:<alertId>`), never an order.
 *
 * Nothing here holds or moves money: the venue is the record of the person's balances and fills.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { abs, formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { PlaceUserOrderIntent } from '@intafaced/venue-contracts';
import type { Principal } from '@intafaced/auth';
import { captureAlgoPlaceGrant, parseAlgoPlaceGrant, principalFromAlgoGrant } from '../algo/durable-principal.js';
import { assertPlaceEligible } from '../spot/place-eligibility.js';

export const SIGNAL_INTAKE_PATH = '/api/v1/signals/webhook';
/** Where a notification URL's alerts arrive: a notice each, never an order. */
export const SIGNAL_NOTIFY_PATH = '/api/v1/signals/notify';
const NOTE_MAX = 280;
const FAILURE_COUNT_LIMIT = 100;
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
  /** `order`: its alerts prepare orders. `notify`: its alerts become notices only. */
  readonly kind: 'order' | 'notify';
  readonly symbol: string | null;
  readonly venueOwner: string | null;
  readonly path: string;
  readonly tokenPrefix: string;
  readonly state: 'active' | 'paused' | 'ended';
  /** Why it ended: the owner's failure count reached (`failures`), or the person ended it (`owner`). */
  readonly endedReason: 'failures' | 'owner' | null;
  /** Alerts in a row whose every order was refused. */
  readonly consecutiveFailures: number;
  readonly createdAt: string;
}

/** How an alert sizes its order: a quantity, or a percent of the position on the webhook's market. */
export type SignalSizing =
  { readonly kind: 'quantity'; readonly value: string } | { readonly kind: 'position_percent'; readonly value: string };

/** The venue account's position on one market: spot, the base asset held (never below zero); a perpetual, signed. */
export interface SignalPosition {
  readonly kind: 'spot' | 'perpetual';
  readonly size: Amount;
  /** The market's lot: a percent of the position is rounded down to it. */
  readonly lotSize: Amount;
}

export interface SignalIntentView {
  readonly alertId: string;
  readonly action: 'open' | 'close';
  readonly side: 'buy' | 'sell';
  readonly sizing: SignalSizing;
  /** The quantity the order was prepared for: the sizing resolved against the position. Null when none was resolved. */
  readonly quantity: string | null;
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
   * The trading admission of one alert's order. No session is behind an alert, so it is the person's standing
   * instruction (the webhook, id `webhookId`), owned by svc-trade: identity still checks the person, and a restricted
   * or frozen account is refused here by its own code, before anything is prepared.
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
  /**
   * The venue account's position on the webhook's market, read only for a percent of the position or a reversal. Throws
   * when it cannot be read: the alert is refused `trade.signal_position_unavailable` and nothing is written.
   */
  position(owner: string, symbol: string): Promise<SignalPosition>;
  /** svc-notify's notice for one notification-URL alert, published under its key. Throws when the bus cannot take it. */
  publishNote(input: { userId: string; webhookId: string; alertId: string; message: string; receivedAt: Date }): Promise<void>;
  /**
   * Owner: alerts in a row whose every order was refused before the webhook ends. Null: unset, and intake refuses
   * `trade.signal_failure_count_not_set`.
   */
  readonly failureCount: number | null;
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

/** Whole alerts 1..100, or null when blank. Anything else stops the boot. */
export function parseSignalFailureCount(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > FAILURE_COUNT_LIMIT) {
    throw new Error(`TRADE_SIGNAL_FAILURE_COUNT must be a whole number of alerts, 1 to ${FAILURE_COUNT_LIMIT}, or blank`);
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
  kind: 'order' | 'notify';
  symbol: string | null;
  venue_owner: string | null;
  region: string;
  token_hash: string;
  token_prefix: string;
  place_grant: unknown;
  grant_expires_at: Date | null;
  state: 'active' | 'paused' | 'ended';
  ended_reason: 'failures' | 'owner' | null;
  consecutive_failures: number;
  created_at: Date;
}

interface IntentRow {
  alert_id: string;
  action: 'open' | 'close';
  side: 'buy' | 'sell';
  /** The sizing as the alert gave it, and the quantity it resolved to (kept in the same column). */
  sizing: SignalSizing & { quantity?: string };
  status: SignalIntentView['status'];
  action_key: string | null;
  venue_client_order_id: string | null;
  code: string | null;
  created_at: Date;
}

const webhookView = (row: WebhookRow): SignalWebhookView => ({
  webhookId: row.id,
  kind: row.kind ?? 'order',
  symbol: row.symbol,
  venueOwner: row.venue_owner,
  path: `${row.kind === 'notify' ? SIGNAL_NOTIFY_PATH : SIGNAL_INTAKE_PATH}/${row.id}`,
  tokenPrefix: row.token_prefix,
  state: row.state,
  endedReason: row.ended_reason ?? null,
  consecutiveFailures: row.consecutive_failures ?? 0,
  createdAt: row.created_at.toISOString(),
});

const intentView = (row: IntentRow): SignalIntentView => ({
  alertId: row.alert_id,
  action: row.action,
  side: row.side,
  sizing: { kind: row.sizing.kind, value: row.sizing.value } as SignalSizing,
  quantity: row.sizing.quantity ?? null,
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

/** The webhook's admitted strategy, checked on the person's own session when they make it. */
export const signalBusinessId = (webhookId: string) => `signal:${webhookId}`;

/** One alert's order, as the user-venue door keeps it: the business key its prepared action is stored under. */
export const signalOrderKey = (webhookId: string, alertId: string) => `signal-order:${webhookId}:${alertId}`;

/** A reversal's close, as the door keeps it: its own key beside the open's. */
export const signalCloseKey = (webhookId: string, alertId: string) => `signal-order:${webhookId}:${alertId}:close`;

/** One notification-URL alert's notice, as the bus and svc-notify keep it: one notice per webhook and alert id. */
export const signalNoteKey = (webhookId: string, alertId: string) => `signal.note:${webhookId}:${alertId}`;

/** One planned action of an alert, before it is prepared. A planned refusal is written as a refused intent. */
interface PlannedAction {
  readonly action: 'open' | 'close';
  readonly side: 'buy' | 'sell';
  readonly sizing: SignalSizing;
  readonly qty: Amount | null;
  readonly reduceOnly: boolean;
  readonly orderKey: string;
  readonly refused?: { readonly code: string; readonly message: string };
}

const format = (message: string, field: string) => new SignalError(message, 'trade.signal_format_invalid', 400, field);

/** The alert's sizing, from its `amount` and `amountType`: a quantity, or a percent (above 0, at most 100) of the position. */
export function parseSignalSizing(body: Record<string, unknown>): { sizing: SignalSizing; value: Amount } {
  const type = body.amountType;
  if (type !== undefined && type !== 'quantity' && type !== 'position_percent')
    throw format('amountType is quantity or position_percent', 'amountType');
  // Money arrives as decimal strings only: a JSON number may already have lost digits before it reaches us.
  let text = typeof body.amount === 'string' ? body.amount.trim() : '';
  const percentSign = text.endsWith('%');
  if (percentSign) text = text.slice(0, -1).trim();
  if (percentSign && type === 'quantity') throw format('a quantity is a decimal string with no percent sign', 'amountType');
  const percent = percentSign || type === 'position_percent';
  let value: Amount;
  try {
    value = parseAmount(text);
  } catch {
    throw format(
      percent
        ? 'amount is required: a percent of the position, such as "50%"'
        : 'amount is required: a decimal quantity, as a string, or a percent of the position such as "50%"',
      'amount',
    );
  }
  if (value <= 0n) throw format('amount must be above zero', 'amount');
  if (percent && value > parseAmount('100')) throw format('a percent of the position is at most 100', 'amount');
  return { sizing: { kind: percent ? 'position_percent' : 'quantity', value: formatAmount(value) }, value };
}

/** A percent of a position's size, rounded down to the market's lot. */
function percentOf(size: Amount, percent: Amount, lot: Amount): Amount {
  const raw = mul(abs(size), percent, 'floor') / 100n;
  if (lot <= 0n) return raw;
  return (raw / lot) * lot;
}

/** Whether an alert's reply is a failure for the count: every order planned was refused, and none is unknown. */
function failed(statuses: readonly SignalIntentView['status'][]): boolean {
  return statuses.length > 0 && statuses.every((st) => st === 'refused');
}

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
    // The webhook is admitted as a strategy on the person's own session; each alert's order is then admitted on the webhook
    // as a standing instruction, since no session is behind an alert.
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

  /**
   * One webhook's intents, oldest first. A reversal's two rows share one time, so its close is listed before its open,
   * in the order they are prepared. Another person's webhook reads as not found.
   */
  async intents(principal: Principal, webhookId: string): Promise<{ items: SignalIntentView[] }> {
    const hook = await this.owned(principal, webhookId);
    const rows = await this.ports.sql<IntentRow[]>`
      SELECT * FROM trade.signal_intents WHERE webhook_id = ${hook.id}
      ORDER BY created_at ASC, CASE WHEN action = 'close' THEN 0 ELSE 1 END ASC, id ASC LIMIT ${LIST_MAX * 5}`;
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

  /** The person's webhook, paused: the next alert is refused `trade.signal_paused` and nothing is planned. */
  async pause(principal: Principal, webhookId: string): Promise<SignalWebhookView> {
    return this.setState(principal, webhookId, 'pause');
  }

  /** A paused webhook, active again. An ended one stays ended. */
  async resume(principal: Principal, webhookId: string): Promise<SignalWebhookView> {
    return this.setState(principal, webhookId, 'resume');
  }

  /** The person ends their webhook; it never takes an alert again. Ending one already ended answers it as it is. */
  async end(principal: Principal, webhookId: string): Promise<SignalWebhookView> {
    return this.setState(principal, webhookId, 'end');
  }

  private async setState(principal: Principal, webhookId: string, change: 'pause' | 'resume' | 'end'): Promise<SignalWebhookView> {
    const hook = await this.owned(principal, webhookId);
    const at = this.ports.now().toISOString();
    if (hook.state === 'ended') {
      if (change === 'end') return webhookView(hook);
      throw new SignalError('This webhook has ended', 'trade.signal_webhook_ended', 409);
    }
    const [row] =
      change === 'end'
        ? await this.ports.sql<WebhookRow[]>`
            UPDATE trade.signal_webhooks SET state = 'ended', ended_reason = 'owner', ended_at = ${at}, updated_at = ${at}
            WHERE id = ${hook.id} AND user_id = ${principal.userId} AND state <> 'ended' RETURNING *`
        : await this.ports.sql<WebhookRow[]>`
            UPDATE trade.signal_webhooks SET state = ${change === 'pause' ? 'paused' : 'active'}, updated_at = ${at}
            WHERE id = ${hook.id} AND user_id = ${principal.userId} AND state <> 'ended' RETURNING *`;
    // Ended in between (the failure count, or another tab): answer what it is now.
    return webhookView(row ?? (await this.owned(principal, webhookId)));
  }

  /** A notification URL: its alerts become notices only. The token is in this reply only; the same request key answers the same URL. */
  async createNotify(
    principal: Principal,
    input: { clientRequestId: string },
    region: string,
  ): Promise<SignalWebhookView & { readonly token: string | null }> {
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
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const now = this.ports.now().toISOString();
    const webhookId = idFor(`signal-webhook:${principal.userId}:${requestId}`);
    const [row] = await this.ports.sql<WebhookRow[]>`
      INSERT INTO trade.signal_webhooks
        (id, user_id, client_request_id, kind, symbol, venue_owner, region, token_hash, token_prefix, place_grant, grant_expires_at, state, created_at, updated_at)
      VALUES (${webhookId}, ${principal.userId}, ${requestId}, 'notify', NULL, NULL, ${region}, ${sha256(token)}, ${token.slice(0, 6)},
        NULL, NULL, 'active', ${now}, ${now})
      ON CONFLICT (user_id, client_request_id) DO NOTHING
      RETURNING *`;
    if (!row) {
      const [raced] = await this.ports.sql<WebhookRow[]>`
        SELECT * FROM trade.signal_webhooks WHERE user_id = ${principal.userId} AND client_request_id = ${requestId}`;
      return { ...webhookView(raced!), token: null };
    }
    return { ...webhookView(row), token };
  }

  /** One alert to a notification URL. Never throws: every outcome is a reply. */
  async ingestNote(webhookId: string, raw: unknown): Promise<AlertReply> {
    try {
      const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const { hook, alertId, now } = await this.checked(webhookId, body, 'notify');
      const [stored] = await this.ports.sql<Array<{ status: number; body: Record<string, unknown> }>>`
        SELECT status, body FROM trade.signal_alert_results WHERE webhook_id = ${hook.id} AND alert_id = ${alertId}`;
      if (stored) return { status: stored.status, body: stored.body };
      if (hook.state === 'paused') throw new SignalError('This notification URL is paused', 'trade.signal_paused', 409);
      if (hook.state === 'ended') throw new SignalError('This notification URL has ended', 'trade.signal_webhook_ended', 410);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message || message.length > NOTE_MAX)
        throw format(`message is required: the notice's text, 1 to ${NOTE_MAX} characters`, 'message');
      // A bus that cannot take it answers 503 and stores nothing, so the sender's retry publishes again; svc-notify keeps
      // one notice per key however often it is sent.
      try {
        await this.ports.publishNote({ userId: hook.user_id, webhookId: hook.id, alertId, message, receivedAt: now });
      } catch {
        throw new SignalError('The notice could not be sent now; send the alert again', 'trade.signal_note_unsent', 503);
      }
      const reply: AlertReply = { status: 200, body: { ok: true, alertId, notice: 'sent', orders: 0 } };
      return await this.keep(hook.id, alertId, reply, now.toISOString());
    } catch (err) {
      if (err instanceof SignalError) return refusal(err);
      throw err;
    }
  }

  /** The checks every alert passes first, in order: the token (and the URL's kind), the owner's age limit, the alert id. */
  private async checked(
    webhookId: string,
    body: Record<string, unknown>,
    kind: 'order' | 'notify',
  ): Promise<{ hook: WebhookRow; alertId: string; now: Date }> {
    const authFailed = new SignalError('The webhook token is not valid', 'trade.signal_auth_failed', 403);
    if (!/^[0-9a-f-]{36}$/i.test(webhookId)) throw authFailed;
    const [hook] = await this.ports.sql<WebhookRow[]>`SELECT * FROM trade.signal_webhooks WHERE id = ${webhookId}`;
    const token = typeof body.token === 'string' ? body.token : '';
    // The same work whether or not the webhook exists, and a constant-time compare of the hashes.
    const presented = Buffer.from(sha256(token), 'hex');
    const held = Buffer.from(hook?.token_hash ?? sha256(`absent:${webhookId}`), 'hex');
    // A token is good only at its own kind's path: an order token posted to the notice path, or the reverse, is refused.
    if (!hook || !token || !timingSafeEqual(presented, held) || (hook.kind ?? 'order') !== kind) throw authFailed;

    const maxAge = this.ports.maxAlertAgeSeconds;
    if (maxAge === null) throw new SignalError('The platform has not set how old an alert may be', 'trade.signal_latency_not_set', 503);
    const sent = typeof body.time === 'string' ? Date.parse(body.time) : Number.NaN;
    if (!Number.isFinite(sent)) throw format('time is required: when the alert fired, as an ISO time', 'time');
    const now = this.ports.now();
    if (now.getTime() - sent > maxAge * 1000) {
      throw new SignalError(`The alert is older than ${maxAge} seconds (stale), so it was not used`, 'trade.signal_stale', 400);
    }
    const alertId = typeof body.alertId === 'string' ? body.alertId.trim() : '';
    if (!alertId || alertId.length > 120) throw format('alertId is required (1 to 120 characters)', 'alertId');
    return { hook, alertId, now };
  }

  /** Stores an alert's reply under its id; the reply kept first wins. Answers the kept one and whether this call stored it. */
  private async keep(
    webhookId: string,
    alertId: string,
    reply: AlertReply,
    at: string,
    onFirst?: () => Promise<void>,
  ): Promise<AlertReply> {
    const [inserted] = await this.ports.sql<Array<{ alert_id: string }>>`
      INSERT INTO trade.signal_alert_results (webhook_id, alert_id, status, body, created_at)
      VALUES (${webhookId}, ${alertId}, ${reply.status}, ${this.ports.sql.json(reply.body as never)}, ${at})
      ON CONFLICT (webhook_id, alert_id) DO NOTHING
      RETURNING alert_id`;
    if (inserted && onFirst) await onFirst();
    const [kept] = await this.ports.sql<Array<{ status: number; body: Record<string, unknown> }>>`
      SELECT status, body FROM trade.signal_alert_results WHERE webhook_id = ${webhookId} AND alert_id = ${alertId}`;
    return kept ? { status: kept.status, body: kept.body } : reply;
  }

  /**
   * The failure count after one alert's reply was first stored: a failure adds one, and at the owner's count the webhook
   * ends, once (the update holds only while it is not ended); a prepared order sets the count back to zero.
   */
  private async count(hook: WebhookRow, failure: boolean, limit: number): Promise<void> {
    const at = this.ports.now().toISOString();
    if (!failure) {
      await this.ports.sql`
        UPDATE trade.signal_webhooks SET consecutive_failures = 0, updated_at = ${at} WHERE id = ${hook.id} AND consecutive_failures <> 0`;
      return;
    }
    const [row] = await this.ports.sql<Array<{ consecutive_failures: number }>>`
      UPDATE trade.signal_webhooks SET consecutive_failures = consecutive_failures + 1, updated_at = ${at}
      WHERE id = ${hook.id} RETURNING consecutive_failures`;
    if (row && row.consecutive_failures >= limit) {
      await this.ports.sql`
        UPDATE trade.signal_webhooks SET state = 'ended', ended_reason = 'failures', ended_at = ${at}, updated_at = ${at}
        WHERE id = ${hook.id} AND state <> 'ended'`;
    }
  }

  /** The actions an alert plans, from its side and sizing and, where they need it, the position. Throws a typed refusal. */
  private async plan(hook: WebhookRow, alertId: string, body: Record<string, unknown>): Promise<PlannedAction[]> {
    const side = body.side;
    if (side !== 'buy' && side !== 'sell' && side !== 'reverse') throw format('side is required: buy, sell or reverse', 'side');
    const { sizing, value } = parseSignalSizing(body);
    const symbol = hook.symbol!;
    const openKey = signalOrderKey(hook.id, alertId);
    if (sizing.kind === 'quantity' && side !== 'reverse') {
      return [{ action: 'open', side, sizing, qty: value, reduceOnly: false, orderKey: openKey }];
    }
    let position: SignalPosition;
    try {
      position = await this.ports.position(hook.venue_owner!, symbol);
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      throw new SignalError(
        `The position on ${symbol} could not be read${typeof code === 'string' ? ` (${code})` : ''}, so the alert was not used; send it again`,
        'trade.signal_position_unavailable',
        503,
      );
    }
    const sized = (of: Amount) => (sizing.kind === 'quantity' ? value : percentOf(of, value, position.lotSize));
    const noPosition = { code: 'trade.signal_no_position', message: `There is no position on ${symbol} to size this order from` };
    if (side !== 'reverse') {
      const qty = sized(position.size);
      // On a perpetual, an order against the position only reduces it; on spot every sell is of the base held.
      const against = position.kind === 'perpetual' && ((position.size > 0n && side === 'sell') || (position.size < 0n && side === 'buy'));
      return [
        {
          action: 'open',
          side,
          sizing,
          qty: qty > 0n ? qty : null,
          reduceOnly: against,
          orderKey: openKey,
          ...(qty > 0n ? {} : { refused: noPosition }),
        },
      ];
    }
    // A reversal: close the whole position, then open the other way.
    if (position.size === 0n)
      throw new SignalError(`There is no position on ${symbol} to reverse`, 'trade.signal_no_position', 422, 'side');
    const closeSide: 'buy' | 'sell' = position.size > 0n ? 'sell' : 'buy';
    const close: PlannedAction = {
      action: 'close',
      side: closeSide,
      sizing: { kind: 'position_percent', value: '100' },
      qty: abs(position.size),
      reduceOnly: position.kind === 'perpetual',
      orderKey: signalCloseKey(hook.id, alertId),
    };
    const openQty = sized(position.size);
    const open: PlannedAction = {
      action: 'open',
      side: closeSide,
      sizing,
      qty: openQty > 0n ? openQty : null,
      reduceOnly: false,
      orderKey: openKey,
      ...(position.kind === 'spot'
        ? {
            refused: {
              code: 'trade.signal_short_not_offered',
              message: `${symbol} is a cash spot market, which holds no short: the close sells what you hold, and no open the other way is planned`,
            },
          }
        : openQty > 0n
          ? {}
          : { refused: noPosition }),
    };
    return [close, open];
  }

  private async ingestOrRefuse(webhookId: string, raw: unknown): Promise<AlertReply> {
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const { hook, alertId, now } = await this.checked(webhookId, body, 'order');

    // A repeat of an alert id answers what the first one got, whatever the webhook's state now.
    const [stored] = await this.ports.sql<Array<{ status: number; body: Record<string, unknown> }>>`
      SELECT status, body FROM trade.signal_alert_results WHERE webhook_id = ${hook.id} AND alert_id = ${alertId}`;
    if (stored) return { status: stored.status, body: stored.body };

    if (hook.state === 'paused') throw new SignalError('This webhook is paused', 'trade.signal_paused', 409);
    if (hook.state === 'ended') throw new SignalError('This webhook has ended', 'trade.signal_webhook_ended', 410);
    const limit = this.ports.failureCount;
    if (limit === null)
      throw new SignalError(
        'Not set: the platform has not set how many failed alerts in a row end a webhook',
        'trade.signal_failure_count_not_set',
        503,
      );

    // A market order on the venue carries the worst price it accepts: the alert names it, as TradingView's {{close}} can.
    if (body.side === undefined || body.side === null || body.side === '') throw format('side is required: buy, sell or reverse', 'side');
    const priceText = typeof body.price === 'string' ? body.price.trim() : '';
    let price: Amount;
    try {
      price = parseAmount(priceText);
    } catch {
      throw format('price is required: the worst price the order accepts, as a decimal string', 'price');
    }
    if (price <= 0n) throw format('price must be above zero', 'price');
    // Parsed before the position is read, so a malformed message never costs a venue read.
    parseSignalSizing(body);
    const planned = await this.plan(hook, alertId, body);

    const at = now.toISOString();
    // Every intent row is written before any order is prepared; a crash after it leaves it pending under its key, and the
    // door's own store under the order's key means a later prepare of it returns the same action, never a second.
    for (const p of planned) {
      const key = `signal.alert:${hook.id}:${alertId}:${p.action}`;
      await this.ports.sql`
        INSERT INTO trade.signal_intents (id, webhook_id, alert_id, action, intent_key, side, sizing, status, created_at, updated_at)
        VALUES (${idFor(key)}, ${hook.id}, ${alertId}, ${p.action}, ${key}, ${p.side},
          ${this.ports.sql.json({ ...p.sizing, ...(p.qty !== null ? { quantity: formatAmount(p.qty) } : {}) } as never)}, 'pending', ${at}, ${at})
        ON CONFLICT (intent_key) DO NOTHING`;
    }
    const outcomes: Array<{
      action: 'open' | 'close';
      side: 'buy' | 'sell';
      status: SignalIntentView['status'];
      actionKey: string | null;
      venueClientOrderId: string | null;
      code: string | null;
    }> = [];
    for (const p of planned) {
      const key = `signal.alert:${hook.id}:${alertId}:${p.action}`;
      let status: SignalIntentView['status'];
      let actionKey: string | null = null;
      let venueClientOrderId: string | null = null;
      let code: string | null = null;
      const closeFirst = outcomes.find((o) => o.action === 'close');
      if (p.refused) {
        status = 'refused';
        code = p.refused.code;
      } else if (closeFirst && closeFirst.status !== 'prepared') {
        // A reversal never opens the other way without its close prepared first.
        status = closeFirst.status === 'unknown' ? 'unknown' : 'refused';
        code = closeFirst.status === 'unknown' ? null : 'trade.signal_reverse_close_failed';
      } else {
        try {
          const grant = parseAlgoPlaceGrant(hook.place_grant);
          if (!grant) throw new SignalError('This webhook holds no place grant', 'trade.signal_grant_unavailable', 422);
          const principal = principalFromAlgoGrant({ userId: hook.user_id, grant, expiresAt: hook.grant_expires_at!, now });
          // The same check as a signed-in order (OWNER 88), on the creator's tier as identity holds it now, never the tier
          // the stored grant carries from the create, and the region recorded at create. A refusal places nothing.
          assertPlaceEligible({ tier: await this.ports.liveTier(hook.user_id), region: hook.region });
          const intent: PlaceUserOrderIntent = {
            kind: 'place_order',
            symbol: hook.symbol!,
            side: p.side,
            type: 'market',
            amount: p.qty!,
            price,
            timeInForce: 'IOC',
            reduceOnly: p.reduceOnly,
            clientOrderKey: p.orderKey,
            builderFee: null,
          };
          await this.ports.admitAlert(
            principal,
            intent.clientOrderKey,
            {
              webhookId: hook.id,
              alertId,
              action: p.action,
              symbol: hook.symbol,
              side: p.side,
              amount: formatAmount(p.qty!),
              price: formatAmount(price),
            },
            hook.id,
          );
          const prepared = await this.ports.prepareOrder(principal, { owner: hook.venue_owner!, intent });
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
            (err as { code?: unknown })?.code && typeof (err as { code: unknown }).code === 'string'
              ? (err as { code: string }).code
              : null;
          status = code ? 'refused' : 'unknown';
        }
      }
      await this.ports.sql`
        UPDATE trade.signal_intents SET status = ${status}, action_key = ${actionKey}, venue_client_order_id = ${venueClientOrderId}, code = ${code}, updated_at = ${this.ports.now().toISOString()}
        WHERE intent_key = ${key}`;
      outcomes.push({ action: p.action, side: p.side, status, actionKey, venueClientOrderId, code });
    }
    const statuses = outcomes.map((o) => o.status);
    const unknown = statuses.includes('unknown');
    const allPrepared = statuses.every((st) => st === 'prepared');
    const somePrepared = statuses.includes('prepared');
    const reply: AlertReply = {
      // 200 every order prepared; 207 some prepared and some refused (a reversal's close without its open); 422 every
      // order refused; 202 an outcome unknown, kept unstored so a repeat reaches the door again.
      status: unknown ? 202 : allPrepared ? 200 : somePrepared ? 207 : 422,
      body: {
        ok: allPrepared,
        alertId,
        intents: outcomes,
        // Prepared is not sent: the person's wallet signs it and sends it, and only then does it reach the venue.
        ...(somePrepared ? { next: 'sign the prepared order in your wallet and send it: POST /api/v1/venue/submit' } : {}),
      },
    };
    // An unknown order outcome is not stored as final: a repeat re-reads the intent instead of answering a guess.
    if (unknown) return reply;
    return this.keep(hook.id, alertId, reply, at, () => this.count(hook, failed(statuses), limit));
  }

  private async owned(principal: Principal, webhookId: string): Promise<WebhookRow> {
    if (!/^[0-9a-f-]{36}$/i.test(webhookId)) throw new SignalError('Webhook not found', 'trade.signal_webhook_not_found', 404);
    const [row] = await this.ports.sql<WebhookRow[]>`
      SELECT * FROM trade.signal_webhooks WHERE id = ${webhookId} AND user_id = ${principal.userId}`;
    if (!row) throw new SignalError('Webhook not found', 'trade.signal_webhook_not_found', 404);
    return row;
  }
}
