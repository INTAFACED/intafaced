import { z } from 'zod';
import type { ServiceName } from './service-keys.js';

/**
 * Trade signal webhooks (CB-bots-api-signal-01, journey J-copy-bots-otc-20): a customer creates a TradingView-style webhook
 * for one symbol in live or demo mode; svc-edge later forwards each alert to svc-trade, which checks the token and the alert's
 * age and places an ordinary order as the owner. This file is contracts only: svc-trade serves `create`/`list`/`intake` and
 * svc-edge calls `intake` in later pull requests.
 *
 * Browser-safe: zod only at run time (the service name import is type-only).
 *
 * TOKEN. `create` returns the token exactly once (`token` in the create output). `list` never carries it, and every list item
 * is `.strict()`, so a token or token hash field fails the parse instead of reaching the browser. svc-trade stores only a hash.
 *
 * OWNER VALUES. The latency max, the ingress body size cap and the ingress rate limit are owner decisions with no value in the
 * spec. None of them has a default here. Each blank value is a typed refusal (`*_unset`), never an invented number.
 */

/** Customer procedures on svc-trade's root router. */
export const TRADE_SIGNAL_WEBHOOK_CREATE_PROCEDURE = 'signals.webhook.create' as const;
export const TRADE_SIGNAL_WEBHOOK_LIST_PROCEDURE = 'signals.webhook.list' as const;
/** Service procedure on svc-trade, called by svc-edge with the raw alert body and the path token. */
export const TRADE_SIGNAL_INTAKE_PROCEDURE = 'signals.intake' as const;
/** The only service allowed to call `signals.intake`. Passed to `serviceProcedureFor`. */
export const TRADE_SIGNAL_INTAKE_CALLERS: readonly ServiceName[] = ['svc-edge'];

/**
 * Typed refusals.
 * `trade.signal_stale`: server time minus alert time is over the latency max; no order is placed.
 * `trade.signal_token_invalid`: unknown webhook, revoked webhook or a token that does not match its hash.
 * `trade.signal_latency_unset`: the latency max is blank, so intake is refused.
 * `trade.signal_body_cap_unset`: the svc-edge ingress body size cap is blank, so the route refuses every alert.
 * `trade.signal_rate_limit_unset`: the svc-edge ingress rate limit is blank, so the route refuses every alert.
 */
export const TRADE_SIGNAL_ERROR_CODES = [
  'trade.signal_stale',
  'trade.signal_token_invalid',
  'trade.signal_latency_unset',
  'trade.signal_body_cap_unset',
  'trade.signal_rate_limit_unset',
] as const;
export type TradeSignalErrorCode = (typeof TRADE_SIGNAL_ERROR_CODES)[number];
export const tradeSignalErrorCodeSchema = z.enum(TRADE_SIGNAL_ERROR_CODES);

/** The refusals raised because an owner value is blank. Every one of them refuses; none falls back to a number. */
export const TRADE_SIGNAL_UNSET_CODES = [
  'trade.signal_latency_unset',
  'trade.signal_body_cap_unset',
  'trade.signal_rate_limit_unset',
] as const satisfies readonly TradeSignalErrorCode[];

export const TRADE_SIGNAL_WEBHOOK_MODES = ['live', 'demo'] as const;
export const TRADE_SIGNAL_WEBHOOK_STATES = ['active', 'revoked'] as const;

/** Market symbol as the customer sees it. Bounded, not pattern-matched (a dated symbol has a colon). */
const symbol = z.string().min(1).max(64);
const timestamp = z.string().datetime();

export const tradeSignalWebhookCreateInputSchema = z
  .object({
    symbol,
    /** Required: there is no default mode, so a demo webhook is never silently live (or the reverse). */
    mode: z.enum(TRADE_SIGNAL_WEBHOOK_MODES),
  })
  .strict();
export type TradeSignalWebhookCreateInput = z.infer<typeof tradeSignalWebhookCreateInputSchema>;

/** A webhook as listed: no token and no token hash. */
export const tradeSignalWebhookSchema = z
  .object({
    webhookId: z.string().uuid(),
    symbol,
    mode: z.enum(TRADE_SIGNAL_WEBHOOK_MODES),
    state: z.enum(TRADE_SIGNAL_WEBHOOK_STATES),
    createdAt: timestamp,
  })
  .strict();
export type TradeSignalWebhook = z.infer<typeof tradeSignalWebhookSchema>;

/** The create answer: the webhook plus its token, shown once. Opaque URL-safe text, at least 32 characters. */
export const tradeSignalWebhookCreateOutputSchema = z
  .object({
    webhook: tradeSignalWebhookSchema,
    token: z
      .string()
      .min(32)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type TradeSignalWebhookCreateOutput = z.infer<typeof tradeSignalWebhookCreateOutputSchema>;

export const tradeSignalWebhookListInputSchema = z.object({}).strict();
export type TradeSignalWebhookListInput = z.infer<typeof tradeSignalWebhookListInputSchema>;

export const tradeSignalWebhookListOutputSchema = z.object({ items: z.array(tradeSignalWebhookSchema) }).strict();
export type TradeSignalWebhookListOutput = z.infer<typeof tradeSignalWebhookListOutputSchema>;
