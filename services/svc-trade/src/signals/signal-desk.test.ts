import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TradingControlError } from '../controls/trading-controls.js';
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
      liveTier: async () => {
        throw new Error('no tier may be read');
      },
      admitStart: async () => {
        throw new Error('no admission may be asked');
      },
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
    expect(out).toEqual({ status: 403, body: { ok: false, code: 'trade.signal_auth_failed', message: 'The webhook token is not valid' } });
    expect(calls.every((c) => c.trimStart().startsWith('SELECT'))).toBe(true);
  });
});

/**
 * Who may place through a webhook (OWNER 88): the shared check in spot/place-eligibility.ts, at create on the request's
 * tier and on every alert on the creator's live tier, never the tier the stored grant carries. A fake database answers
 * by statement; every write is recorded so a test can see that a refusal placed nothing.
 */
describe('a webhook places only for a person who may place a trade order', () => {
  const HOOK = '22222222-2222-4222-8222-222222222222';
  const TOKEN = 'the-webhook-token-0123456789';
  const NOW = new Date('2026-11-07T12:00:00Z');
  const hex = (v: string) => createHash('sha256').update(v).digest('hex');
  const principal = (tier: 'none' | 'basic') =>
    ({
      sub: 'u-1',
      userId: 'u-1',
      sid: 's-1',
      scopes: ['trade:read', 'trade:write'],
      tier,
      mfa: false,
      expiresAt: new Date('2026-11-08T00:00:00Z'),
    }) as never;

  function world(opts: { liveTier: 'none' | 'basic'; placeOrder?: () => Promise<{ id: string }> }) {
    const writes: string[] = [];
    const orders: unknown[] = [];
    const admissions: string[] = [];
    let result: { status: number; body: Record<string, unknown> } | null = null;
    const hook = {
      id: HOOK,
      user_id: 'u-1',
      client_request_id: 'req-00000001',
      symbol: 'BTC/USDT',
      market_id: 'm-btc',
      region: 'DE',
      token_hash: hex(TOKEN),
      token_prefix: TOKEN.slice(0, 6),
      // The grant the create stored says basic; the alert must read the live tier instead.
      place_grant: { scopes: ['trade:read', 'trade:write'], sid: 's-1', tier: 'basic', mfa: false },
      grant_expires_at: new Date('2026-12-07T12:00:00Z'),
      state: 'active',
      created_at: NOW,
      updated_at: NOW,
    };
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?').replace(/\s+/g, ' ').trim();
        if (text.startsWith('SELECT * FROM trade.signal_webhooks WHERE id')) return [hook];
        if (text.startsWith('SELECT * FROM trade.signal_webhooks WHERE user_id')) return [];
        if (text.startsWith('SELECT status, body FROM trade.signal_alert_results')) return result ? [result] : [];
        writes.push(text.split(' (')[0]!);
        if (text.startsWith('INSERT INTO trade.signal_alert_results')) result = { status: values[2] as number, body: values[3] as never };
        if (text.startsWith('INSERT INTO trade.signal_webhooks')) return [{ ...hook, id: values[0] }];
        return [];
      },
      { json: (v: unknown) => v },
    ) as unknown as SignalPorts['sql'];
    const desk = new SignalDesk({
      sql,
      now: () => NOW,
      marketIdBySymbol: async () => 'm-btc',
      liveTier: async () => opts.liveTier,
      admitStart: async (_p, businessId) => {
        admissions.push(businessId);
        return {};
      },
      placeOrder:
        opts.placeOrder ??
        (async (_p, input) => {
          orders.push(input);
          return { id: 'o-1' };
        }),
      maxAlertAgeSeconds: 20,
      webhookDays: 30,
    });
    const alert = (alertId: string) => desk.ingest(HOOK, { token: TOKEN, alertId, time: NOW.toISOString(), side: 'buy', amount: '0.01' });
    return { desk, alert, writes, orders, admissions };
  }

  it('refuses a create below basic as tier.insufficient, writing and admitting nothing', async () => {
    const w = world({ liveTier: 'basic' });
    await expect(w.desk.create(principal('none'), { symbol: 'BTCUSDT', clientRequestId: 'req-00000001' }, 'DE')).rejects.toMatchObject({
      code: 'tier.insufficient',
    });
    expect(w.writes).toEqual([]);
    expect(w.admissions).toEqual([]);
  });

  it('creates for a basic person, keeping the region for the alerts', async () => {
    const w = world({ liveTier: 'basic' });
    const made = await w.desk.create(principal('basic'), { symbol: 'BTCUSDT', clientRequestId: 'req-00000001' }, 'DE');
    expect(made.token).not.toBeNull();
    expect(w.admissions).toHaveLength(1);
  });

  it('places for a person whose live tier is basic', async () => {
    const w = world({ liveTier: 'basic' });
    const out = await w.alert('a-ok');
    expect(out.status).toBe(200);
    expect(w.orders).toHaveLength(1);
  });

  it('refuses an alert when the live tier is below basic, though the stored grant says basic: no order', async () => {
    const w = world({ liveTier: 'none' });
    const out = await w.alert('a-none');
    expect(out.status).toBe(422);
    expect(out.body).toMatchObject({ ok: false, intents: [{ status: 'refused', code: 'tier.insufficient', orderId: null }] });
    expect(w.orders).toEqual([]);
  });

  it('refuses an alert for a restricted account as trade.desk_restricted: no order', async () => {
    // The restriction is the place path's own admission (controls/trading-controls.ts), reached through placeOrder.
    const w = world({
      liveTier: 'basic',
      placeOrder: async () => {
        throw new TradingControlError('trade.desk_restricted');
      },
    });
    const out = await w.alert('a-restricted');
    expect(out.status).toBe(422);
    expect(out.body).toMatchObject({ ok: false, intents: [{ status: 'refused', code: 'trade.desk_restricted', orderId: null }] });
    expect(w.orders).toEqual([]);
  });
});
