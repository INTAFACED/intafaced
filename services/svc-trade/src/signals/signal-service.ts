/**
 * Trade signal webhooks (CB-bots-api-signal-01 PR 2): the webhook store and `signals.intake`.
 *
 * TOKEN. `create` makes 32 random bytes (base64url, 43 chars), returns them once and stores only their SHA-256. Intake
 * hashes the presented token and compares it with `timingSafeEqual`. An unknown or revoked webhook is compared against a
 * fixed dummy hash, so every refusal takes the same path and answers `trade.signal_token_invalid`.
 *
 * ORDER OF CHECKS. Owner values first (a blank one refuses every alert), then body cap, token, body shape, latency
 * (`trade.signal_stale`, no row written), rate limit, then the intent row, then the order.
 *
 * ONE ORDER PER ALERT. The intent row (`signal.alert:<webhookId>:<alertId>`, unique) is inserted before the order is placed.
 * A repeat alert finds the row and returns its stored outcome. A row still `pending` (a crash between insert and place) is
 * placed again with the same client order id, which `placeOrder` already treats as the retry key, so it cannot double.
 *
 * MODE. A `demo` webhook only ever places on a paper market and a `live` webhook only on a non-paper one. A mismatch is
 * recorded as `refused` (`signal.mode_mismatch`) and nothing is placed.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  tradeSignalWebhookCreateOutputSchema,
  tradeSignalWebhookSchema,
  type TradeSignalWebhook,
  type TradeSignalWebhookCreateInput,
  type TradeSignalWebhookCreateOutput,
} from '@intafaced/contracts';
import { requireSignalLimits, TradeSignalError, type SignalLimits } from './signal-config.js';

const DUMMY_HASH = createHash('sha256').update('signal.webhook.no-such-webhook').digest();

export function hashSignalToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function signalAlertKey(webhookId: string, alertId: string): string {
  return `signal.alert:${webhookId}:${alertId}`;
}

/** 64 chars max (the placeOrder retry-key bound): a hash of the alert key. */
export function signalClientOrderId(alertKey: string): string {
  return `sig-${createHash('sha256').update(alertKey).digest('hex').slice(0, 60)}`;
}

const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/);

/** The alert body the customer configures in TradingView. Strict: unknown fields refuse. */
export const signalAlertBodySchema = z
  .object({
    alertId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    sentAt: z.string().datetime(),
    side: z.enum(['buy', 'sell']),
    type: z.enum(['market', 'limit']),
    qty: decimal,
    price: decimal.optional(),
  })
  .strict()
  .refine((b) => (b.type === 'limit') === (b.price !== undefined), { message: 'a limit alert needs a price; a market alert has none' });
export type SignalAlertBody = z.infer<typeof signalAlertBodySchema>;

export interface SignalPlaceInput {
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: 'market' | 'limit';
  readonly qty: string;
  readonly price: string | null;
  readonly clientOrderId: string;
}
/** Places an ordinary order as the webhook's owner through the ordinary path. */
export type SignalPlacePort = (userId: string, input: SignalPlaceInput) => Promise<{ orderId: string }>;
export type SignalMarketLookup = (symbol: string) => Promise<{ paper: boolean } | null>;

export interface SignalIntakeResult {
  readonly alertKey: string;
  readonly outcome: 'placed' | 'refused';
  readonly orderId: string | null;
  readonly reason: string | null;
  readonly replay: boolean;
}

export class SignalBodyError extends Error {
  constructor(
    readonly kind: 'too_large' | 'invalid' | 'rate_limited' | 'place_unwired',
    message: string,
  ) {
    super(message);
    this.name = 'SignalBodyError';
  }
}

interface WebhookRow {
  id: string;
  user_id: string;
  symbol: string;
  mode: 'live' | 'demo';
  token_hash: Buffer;
  state: 'active' | 'revoked';
  created_at: Date;
}

interface AlertRow {
  alert_key: string;
  outcome: 'pending' | 'placed' | 'refused';
  order_id: string | null;
  reason: string | null;
  client_order_id: string;
  user_id: string;
}

function present(row: WebhookRow): TradeSignalWebhook {
  return tradeSignalWebhookSchema.parse({
    webhookId: row.id,
    symbol: row.symbol,
    mode: row.mode,
    state: row.state,
    createdAt: row.created_at.toISOString(),
  });
}

function refusalReason(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code.slice(0, 128) : 'signal.place_refused';
}

export class SignalWebhookService {
  constructor(
    private readonly deps: {
      sql: Sql;
      limits: SignalLimits;
      loadMarket: SignalMarketLookup;
      /** Absent: intake refuses before writing anything (never a silent accept). */
      place?: SignalPlacePort;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  async create(userId: string, input: TradeSignalWebhookCreateInput): Promise<TradeSignalWebhookCreateOutput> {
    const market = await this.deps.loadMarket(input.symbol);
    if (!market) throw new SignalBodyError('invalid', `market ${input.symbol} not found`);
    if (market.paper !== (input.mode === 'demo')) {
      throw new SignalBodyError(
        'invalid',
        input.mode === 'demo' ? 'a demo webhook needs a paper market' : 'a live webhook cannot use a paper market',
      );
    }
    const token = randomBytes(32).toString('base64url');
    const [row] = await this.deps.sql<WebhookRow[]>`
      INSERT INTO trade.signal_webhooks (id, user_id, symbol, mode, token_hash)
      VALUES (${randomUUID()}, ${userId}, ${input.symbol}, ${input.mode}, ${hashSignalToken(token)})
      RETURNING id, user_id, symbol, mode, token_hash, state, created_at`;
    return tradeSignalWebhookCreateOutputSchema.parse({ webhook: present(row!), token });
  }

  async list(userId: string): Promise<{ items: TradeSignalWebhook[] }> {
    const rows = await this.deps.sql<WebhookRow[]>`
      SELECT id, user_id, symbol, mode, token_hash, state, created_at FROM trade.signal_webhooks
      WHERE user_id = ${userId} ORDER BY created_at DESC, id`;
    return { items: rows.map(present) };
  }

  async intake(input: { webhookId: string; token: string; body: string }): Promise<SignalIntakeResult> {
    const limits = requireSignalLimits(this.deps.limits);
    if (Buffer.byteLength(input.body, 'utf8') > limits.bodyCapBytes) throw new SignalBodyError('too_large', 'alert body is over the cap');

    const [hook] = await this.deps.sql<WebhookRow[]>`
      SELECT id, user_id, symbol, mode, token_hash, state, created_at FROM trade.signal_webhooks WHERE id = ${input.webhookId}`;
    const presented = hashSignalToken(input.token);
    const stored = hook && hook.state === 'active' ? Buffer.from(hook.token_hash) : DUMMY_HASH;
    const match = timingSafeEqual(presented, stored);
    if (!hook || hook.state !== 'active' || !match) throw new TradeSignalError('trade.signal_token_invalid', 'signal token is invalid');

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(input.body);
    } catch {
      throw new SignalBodyError('invalid', 'alert body is not JSON');
    }
    const parsed = signalAlertBodySchema.safeParse(parsedJson);
    if (!parsed.success) throw new SignalBodyError('invalid', 'alert body does not match the signal shape');
    const body = parsed.data;

    const received = this.now();
    const age = received.getTime() - new Date(body.sentAt).getTime();
    if (age > limits.latencyMaxMs) throw new TradeSignalError('trade.signal_stale', 'signal is older than the latency max');

    const alertKey = signalAlertKey(hook.id, body.alertId);
    const existing = await this.loadAlert(alertKey);
    if (existing) return this.replay(existing, hook, body);

    if (!this.deps.place) throw new SignalBodyError('place_unwired', 'signal order placement is not wired on this service');

    const since = new Date(received.getTime() - limits.rateLimit.windowSeconds * 1000);
    const [{ n } = { n: 0 }] = await this.deps.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM trade.signal_alerts WHERE webhook_id = ${hook.id} AND received_at > ${since}`;
    if (n >= limits.rateLimit.count) throw new SignalBodyError('rate_limited', 'signal rate limit reached for this webhook');

    const clientOrderId = signalClientOrderId(alertKey);
    const inserted = await this.deps.sql<AlertRow[]>`
      INSERT INTO trade.signal_alerts (id, alert_key, webhook_id, user_id, alert_id, sent_at, received_at, client_order_id, outcome)
      VALUES (${randomUUID()}, ${alertKey}, ${hook.id}, ${hook.user_id}, ${body.alertId}, ${new Date(body.sentAt)}, ${received},
        ${clientOrderId}, 'pending')
      ON CONFLICT (alert_key) DO NOTHING
      RETURNING alert_key, outcome, order_id, reason, client_order_id, user_id`;
    if (inserted.length === 0) {
      const raced = await this.loadAlert(alertKey);
      return this.replay(raced!, hook, body);
    }
    return this.placeAndRecord(inserted[0]!, hook, body, false);
  }

  private async loadAlert(alertKey: string): Promise<AlertRow | undefined> {
    const [row] = await this.deps.sql<AlertRow[]>`
      SELECT alert_key, outcome, order_id, reason, client_order_id, user_id FROM trade.signal_alerts WHERE alert_key = ${alertKey}`;
    return row;
  }

  private async replay(row: AlertRow, hook: WebhookRow, body: SignalAlertBody): Promise<SignalIntakeResult> {
    if (row.outcome === 'pending') {
      if (!this.deps.place) throw new SignalBodyError('place_unwired', 'signal order placement is not wired on this service');
      return this.placeAndRecord(row, hook, body, true);
    }
    return { alertKey: row.alert_key, outcome: row.outcome, orderId: row.order_id, reason: row.reason, replay: true };
  }

  private async placeAndRecord(row: AlertRow, hook: WebhookRow, body: SignalAlertBody, replay: boolean): Promise<SignalIntakeResult> {
    let outcome: 'placed' | 'refused';
    let orderId: string | null = null;
    let reason: string | null = null;
    const market = await this.deps.loadMarket(hook.symbol);
    if (!market) {
      outcome = 'refused';
      reason = 'signal.market_not_found';
    } else if (market.paper !== (hook.mode === 'demo')) {
      outcome = 'refused';
      reason = 'signal.mode_mismatch';
    } else {
      try {
        const placed = await this.deps.place!(hook.user_id, {
          symbol: hook.symbol,
          side: body.side,
          type: body.type,
          qty: body.qty,
          price: body.price ?? null,
          clientOrderId: row.client_order_id,
        });
        outcome = 'placed';
        orderId = placed.orderId;
      } catch (err) {
        outcome = 'refused';
        reason = refusalReason(err);
      }
    }
    await this.deps.sql`
      UPDATE trade.signal_alerts SET outcome = ${outcome}, order_id = ${orderId}, reason = ${reason}, updated_at = clock_timestamp()
      WHERE alert_key = ${row.alert_key} AND outcome = 'pending'`;
    return { alertKey: row.alert_key, outcome, orderId, reason, replay };
  }
}
