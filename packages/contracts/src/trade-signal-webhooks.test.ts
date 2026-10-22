import { describe, expect, it } from 'vitest';
import {
  TRADE_SIGNAL_ERROR_CODES,
  TRADE_SIGNAL_INTAKE_CALLERS,
  TRADE_SIGNAL_UNSET_CODES,
  TRADE_SIGNAL_WEBHOOK_CREATE_PROCEDURE,
  TRADE_SIGNAL_WEBHOOK_LIST_PROCEDURE,
  tradeSignalErrorCodeSchema,
  tradeSignalWebhookCreateInputSchema,
  tradeSignalWebhookCreateOutputSchema,
  tradeSignalWebhookListInputSchema,
  tradeSignalWebhookListOutputSchema,
} from './trade-signal-webhooks.js';
import { SERVICE_NAMES } from './service-keys.js';
import * as root from './index.js';

const WEBHOOK = {
  webhookId: '11111111-1111-4111-8111-111111111111',
  symbol: 'BTC/USDT',
  mode: 'demo' as const,
  state: 'active' as const,
  createdAt: '2026-10-22T08:00:00.000Z',
};
const TOKEN = 'a'.repeat(43);

describe('trade signal webhook contracts', () => {
  it('names the three pack codes and the two ingress unset codes', () => {
    expect([...TRADE_SIGNAL_ERROR_CODES]).toEqual([
      'trade.signal_stale',
      'trade.signal_token_invalid',
      'trade.signal_latency_unset',
      'trade.signal_body_cap_unset',
      'trade.signal_rate_limit_unset',
    ]);
    expect(tradeSignalErrorCodeSchema.safeParse('trade.signal_unknown').success).toBe(false);
    for (const code of TRADE_SIGNAL_UNSET_CODES) expect(code.endsWith('_unset')).toBe(true);
  });

  it('create input needs a symbol and an explicit mode, and refuses extra fields', () => {
    expect(tradeSignalWebhookCreateInputSchema.parse({ symbol: 'BTC/USDT', mode: 'live' })).toEqual({
      symbol: 'BTC/USDT',
      mode: 'live',
    });
    expect(tradeSignalWebhookCreateInputSchema.safeParse({ symbol: 'BTC/USDT' }).success).toBe(false);
    expect(tradeSignalWebhookCreateInputSchema.safeParse({ symbol: '', mode: 'demo' }).success).toBe(false);
    expect(tradeSignalWebhookCreateInputSchema.safeParse({ symbol: 'BTC/USDT', mode: 'paper' }).success).toBe(false);
    expect(tradeSignalWebhookCreateInputSchema.safeParse({ symbol: 'BTC/USDT', mode: 'demo', maxLatencyMs: 5000 }).success).toBe(false);
  });

  it('create output carries the token once; a short or non-url-safe token is refused', () => {
    expect(tradeSignalWebhookCreateOutputSchema.parse({ webhook: WEBHOOK, token: TOKEN }).token).toBe(TOKEN);
    expect(tradeSignalWebhookCreateOutputSchema.safeParse({ webhook: WEBHOOK, token: 'short' }).success).toBe(false);
    expect(tradeSignalWebhookCreateOutputSchema.safeParse({ webhook: WEBHOOK, token: `${'a'.repeat(40)}/+=` }).success).toBe(false);
  });

  it('list never carries a token or a token hash', () => {
    expect(tradeSignalWebhookListInputSchema.safeParse({}).success).toBe(true);
    expect(tradeSignalWebhookListOutputSchema.parse({ items: [WEBHOOK] }).items).toHaveLength(1);
    expect(tradeSignalWebhookListOutputSchema.safeParse({ items: [{ ...WEBHOOK, token: TOKEN }] }).success).toBe(false);
    expect(tradeSignalWebhookListOutputSchema.safeParse({ items: [{ ...WEBHOOK, tokenHash: 'x' }] }).success).toBe(false);
  });

  it('only svc-edge may call intake; procedures and exports are on the root entry', () => {
    expect([...TRADE_SIGNAL_INTAKE_CALLERS]).toEqual(['svc-edge']);
    for (const s of TRADE_SIGNAL_INTAKE_CALLERS) expect(SERVICE_NAMES).toContain(s);
    expect(TRADE_SIGNAL_WEBHOOK_CREATE_PROCEDURE).toBe('signals.webhook.create');
    expect(TRADE_SIGNAL_WEBHOOK_LIST_PROCEDURE).toBe('signals.webhook.list');
    expect(root.TRADE_SIGNAL_ERROR_CODES).toBe(TRADE_SIGNAL_ERROR_CODES);
  });
});
