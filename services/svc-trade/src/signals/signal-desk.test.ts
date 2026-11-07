import { describe, expect, it } from 'vitest';
import { canonicalSymbol, parseSignalMaxAge, parseSignalWebhookDays, SignalDesk, type SignalPorts } from './signal-desk.js';

describe('chart alert webhooks (CB-bots-api-signal-01)', () => {
  it('reads the market the way a person names it', () => {
    expect(canonicalSymbol('BTCUSDT')).toBe('BTC/USDT');
    expect(canonicalSymbol('btc-usdt')).toBe('BTC/USDT');
    expect(canonicalSymbol('ETH/USDT')).toBe('ETH/USDT');
    expect(canonicalSymbol('nonsense')).toBeNull();
  });

  it('keeps the owner values blank when blank, and stops the boot on anything malformed', () => {
    expect(parseSignalMaxAge('')).toBeNull();
    expect(parseSignalMaxAge('20')).toBe(20);
    expect(() => parseSignalMaxAge('0')).toThrow();
    expect(() => parseSignalMaxAge('20s')).toThrow();
    expect(parseSignalWebhookDays(undefined)).toBeNull();
    expect(parseSignalWebhookDays('30')).toBe(30);
    expect(() => parseSignalWebhookDays('400')).toThrow();
  });

  it('refuses an alert for a webhook that does not exist as auth failed, writing nothing', async () => {
    const calls: string[] = [];
    const sql = Object.assign(
      async (strings: TemplateStringsArray) => {
        calls.push(strings.join('?'));
        return [];
      },
      { json: (v: unknown) => v },
    ) as unknown as SignalPorts['sql'];
    const desk = new SignalDesk({
      sql,
      now: () => new Date('2026-11-07T10:00:00Z'),
      marketIdBySymbol: async () => 'm-btc',
      placeOrder: async () => {
        throw new Error('no order may be placed');
      },
      maxAlertAgeSeconds: 20,
      webhookDays: 30,
    });
    const out = await desk.ingest('11111111-1111-4111-8111-111111111111', {
      token: 'x',
      alertId: 'a',
      time: '2026-11-07T10:00:00Z',
      side: 'buy',
      amount: '1',
    });
    expect(out).toEqual({ status: 401, body: { ok: false, code: 'trade.signal_auth_failed', message: 'The webhook token is not valid' } });
    expect(calls.every((c) => c.trimStart().startsWith('SELECT'))).toBe(true);
  });
});
