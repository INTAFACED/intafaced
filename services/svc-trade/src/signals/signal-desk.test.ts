import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { TradingControlError } from '../controls/trading-controls.js';
import { canonicalSymbol, parseSignalMaxAge, parseSignalWebhookDays, SignalDesk, SignalError, type SignalPorts } from './signal-desk.js';

describe('chart alert webhooks (CB-bots-api-signal-01)', () => {
  it('reads the market the way a person names it', () => {
    expect(canonicalSymbol('BTCUSDC')).toBe('BTC-USDC');
    expect(canonicalSymbol('btc-usdc')).toBe('BTC-USDC');
    expect(canonicalSymbol('ETH/USDC')).toBe('ETH-USDC');
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
      venueMarkets: async () => ['BTC-USDC'],
      liveTier: async () => {
        throw new Error('no tier may be read');
      },
      admitStart: async () => {
        throw new Error('no admission may be asked');
      },
      admitAlert: async () => {
        throw new Error('no admission may be asked');
      },
      prepareOrder: async () => {
        throw new Error('no order may be prepared');
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
      price: '60000',
    });
    expect(out).toEqual({ status: 403, body: { ok: false, code: 'trade.signal_auth_failed', message: 'The webhook token is not valid' } });
    expect(calls.every((c) => c.trimStart().startsWith('SELECT'))).toBe(true);
  });
});

/**
 * What an alert can do, and who may place through a webhook (OWNER 88). An alert never picks the market, the venue
 * account, the trader or the parent, and a paused, ended or expired webhook prepares nothing. On every alert the shared check in
 * spot/place-eligibility.ts runs on the creator's live tier, never the tier the stored grant carries. A fake database answers
 * by statement; every write is recorded so a test can see that a refusal prepared nothing. An alert's order is only ever
 * prepared through the user-venue door, for the person's wallet to sign; nothing here sends it.
 */
describe('a webhook prepares an order only for a person who may place a trade order', () => {
  const HOOK = '22222222-2222-4222-8222-222222222222';
  const TOKEN = 'the-webhook-token-0123456789';
  const NOW = new Date('2026-11-07T12:00:00Z');
  const OWNER = '0x00000000000000000000000000000000000000aa';
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

  function world(opts: {
    liveTier: 'none' | 'basic' | (() => Promise<'none' | 'basic'>);
    prepareOrder?: SignalPorts['prepareOrder'];
    admitAlert?: SignalPorts['admitAlert'];
    venueMarkets?: SignalPorts['venueMarkets'];
    hook?: Partial<{ state: 'active' | 'paused' | 'ended'; grant_expires_at: Date; region: string }>;
  }) {
    const writes: string[] = [];
    const orders: Array<{ userId: string; owner: string; intent: Record<string, unknown> }> = [];
    const admissions: string[] = [];
    const children: Array<{ businessId: string; webhookId: string }> = [];
    const tierAsked: string[] = [];
    let result: { status: number; body: Record<string, unknown> } | null = null;
    const hook = {
      id: HOOK,
      user_id: 'u-1',
      client_request_id: 'req-00000001',
      symbol: 'BTC-USDC',
      venue_owner: OWNER,
      region: 'DE',
      token_hash: hex(TOKEN),
      token_prefix: TOKEN.slice(0, 6),
      // The grant the create stored says basic; the alert must read the live tier instead.
      place_grant: { scopes: ['trade:read', 'trade:write'], sid: 's-1', tier: 'basic', mfa: false },
      grant_expires_at: new Date('2026-12-07T12:00:00Z'),
      state: 'active',
      created_at: NOW,
      updated_at: NOW,
      ...opts.hook,
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
      venueMarkets: opts.venueMarkets ?? (async () => ['BTC-USDC']),
      liveTier: async (userId) => {
        tierAsked.push(userId);
        return typeof opts.liveTier === 'function' ? opts.liveTier() : opts.liveTier;
      },
      admitStart: async (_p, businessId) => {
        admissions.push(businessId);
        return {};
      },
      admitAlert:
        opts.admitAlert ??
        (async (_p, businessId, _payload, webhookId) => {
          children.push({ businessId, webhookId });
          return {};
        }),
      prepareOrder:
        opts.prepareOrder ??
        (async (p, input) => {
          orders.push({ userId: p.userId, owner: input.owner, intent: input.intent as never });
          return { ok: true, actionKey: input.intent.clientOrderKey, venueClientOrderId: 'vc-1' };
        }),
      maxAlertAgeSeconds: 20,
      webhookDays: 30,
    });
    const alert = (alertId: string, extra: Record<string, unknown> = {}) =>
      desk.ingest(HOOK, { token: TOKEN, alertId, time: NOW.toISOString(), side: 'buy', amount: '0.01', price: '60000', ...extra });
    return { desk, alert, writes, orders, admissions, children, tierAsked };
  }

  it('creates for a basic person, keeping the region for the alerts', async () => {
    const w = world({ liveTier: 'basic' });
    const made = await w.desk.create(principal('basic'), { symbol: 'BTCUSDC', venueOwner: OWNER, clientRequestId: 'req-00000001' }, 'DE');
    expect(made.token).not.toBeNull();
    expect(w.admissions).toHaveLength(1);
  });

  it('refuses a create while venue trading is off, and a market the door does not list: no webhook, no admission', async () => {
    const off = world({ liveTier: 'basic', venueMarkets: async () => null });
    const p = principal('basic');
    await expect(
      off.desk.create(p, { symbol: 'BTC-USDC', venueOwner: OWNER, clientRequestId: 'req-00000001' }, 'DE'),
    ).rejects.toMatchObject({
      code: 'trade.signal_venue_off',
    });
    const unlisted = world({ liveTier: 'basic' });
    await expect(
      unlisted.desk.create(p, { symbol: 'ETH-USDC', venueOwner: OWNER, clientRequestId: 'req-00000001' }, 'DE'),
    ).rejects.toMatchObject({ code: 'trade.signal_symbol_invalid', field: 'symbol' });
    const badOwner = world({ liveTier: 'basic' });
    await expect(
      badOwner.desk.create(p, { symbol: 'BTC-USDC', venueOwner: 'not-a-wallet', clientRequestId: 'req-00000001' }, 'DE'),
    ).rejects.toMatchObject({ code: 'trade.signal_owner_invalid', field: 'venueOwner' });
    for (const w of [off, unlisted, badOwner]) {
      expect(w.admissions).toEqual([]);
      expect(w.writes).toEqual([]);
    }
  });

  it("prepares one venue market IOC under the alert's own key, as a delegated child of the webhook, for a basic person", async () => {
    const w = world({ liveTier: 'basic' });
    const out = await w.alert('a-ok');
    expect(out.status).toBe(200);
    const key = `signal-order:${HOOK}:a-ok`;
    expect(out.body).toMatchObject({ ok: true, intents: [{ status: 'prepared', actionKey: key, venueClientOrderId: 'vc-1' }] });
    expect(w.children).toEqual([{ businessId: key, webhookId: HOOK }]);
    expect(w.orders).toEqual([
      {
        userId: 'u-1',
        owner: OWNER,
        intent: {
          kind: 'place_order',
          symbol: 'BTC-USDC',
          side: 'buy',
          type: 'market',
          amount: parseAmount('0.01'),
          price: parseAmount('60000'),
          timeInForce: 'IOC',
          reduceOnly: false,
          clientOrderKey: key,
          builderFee: null,
        },
      },
    ]);
  });

  it('refuses an alert with no price, naming the field: nothing admitted or prepared', async () => {
    const w = world({ liveTier: 'basic' });
    const out = await w.alert('a-noprice', { price: undefined });
    expect(out).toMatchObject({ status: 400, body: { code: 'trade.signal_format_invalid', field: 'price' } });
    expect(w.children).toEqual([]);
    expect(w.orders).toEqual([]);
    expect(w.writes).toEqual([]);
  });

  it("keeps the door's refusal as the intent's code and stores it as the alert's answer", async () => {
    const w = world({ liveTier: 'basic', prepareOrder: async () => ({ ok: false, code: 'trade.venue_market_not_listed' }) });
    const out = await w.alert('a-unlisted');
    expect(out).toMatchObject({
      status: 422,
      body: { ok: false, intents: [{ status: 'refused', code: 'trade.venue_market_not_listed', actionKey: null }] },
    });
    expect(await w.alert('a-unlisted')).toEqual(out);
  });

  it('leaves an intent unknown, and stores no answer, when the door fails with no code: the next try reaches the door again', async () => {
    let calls = 0;
    const w = world({
      liveTier: 'basic',
      prepareOrder: async () => {
        calls += 1;
        throw new Error('socket hang up');
      },
    });
    const out = await w.alert('a-lost');
    expect(out).toMatchObject({ status: 202, body: { ok: false, intents: [{ status: 'unknown' }] } });
    expect(w.writes.some((t) => t.startsWith('INSERT INTO trade.signal_alert_results'))).toBe(false);
    await w.alert('a-lost');
    expect(calls).toBe(2);
  });

  it("ignores an alert's market, account and trader: the order is the webhook's market and account, for its creator", async () => {
    const w = world({ liveTier: 'basic' });
    const out = await w.alert('a-pick', {
      marketId: 'm-eth',
      symbol: 'ETH-USDC',
      market: 'ETHUSDC',
      owner: '0x00000000000000000000000000000000000000bb',
      venueOwner: '0x00000000000000000000000000000000000000bb',
      clientOrderKey: 'order:mine',
      userId: 'u-other',
      user_id: 'u-other',
    });
    expect(out.status).toBe(200);
    expect(w.orders).toEqual([
      {
        userId: 'u-1',
        owner: OWNER,
        intent: expect.objectContaining({ symbol: 'BTC-USDC', clientOrderKey: `signal-order:${HOOK}:a-pick` }),
      },
    ]);
    expect(w.children).toEqual([{ businessId: `signal-order:${HOOK}:a-pick`, webhookId: HOOK }]);
  });

  it('refuses an alert to a paused webhook as trade.signal_paused (409): no order', async () => {
    const w = world({ liveTier: 'basic', hook: { state: 'paused' } });
    const out = await w.alert('a-paused');
    expect(out).toMatchObject({ status: 409, body: { code: 'trade.signal_paused' } });
    expect(w.orders).toEqual([]);
  });

  it('refuses an alert to an ended webhook as trade.signal_webhook_ended (410): no order', async () => {
    const w = world({ liveTier: 'basic', hook: { state: 'ended' } });
    const out = await w.alert('a-ended');
    expect(out).toMatchObject({ status: 410, body: { code: 'trade.signal_webhook_ended' } });
    expect(w.orders).toEqual([]);
  });

  it("prepares nothing once the webhook's life is over, though its row still reads active", async () => {
    const w = world({ liveTier: 'basic', hook: { grant_expires_at: new Date('2026-11-07T11:59:59Z') } });
    const out = await w.alert('a-expired');
    expect(out.status).toBe(422);
    expect(out.body).toMatchObject({ ok: false, intents: [{ status: 'refused', actionKey: null }] });
    expect(w.orders).toEqual([]);
  });

  it('refuses an alert when the live tier is below basic, though the stored grant says basic: no order', async () => {
    const w = world({ liveTier: 'none' });
    const out = await w.alert('a-none');
    expect(out.status).toBe(422);
    expect(out.body).toMatchObject({ ok: false, intents: [{ status: 'refused', code: 'tier.insufficient', actionKey: null }] });
    expect(w.orders).toEqual([]);
  });

  it('refuses an alert when the live tier cannot be read: no order, never the stored tier', async () => {
    const w = world({
      liveTier: async () => {
        throw new SignalError('identity is unreachable', 'trade.signal_tier_unavailable', 503);
      },
    });
    const out = await w.alert('a-unreachable');
    expect(out.status).toBe(422);
    expect(out.body).toMatchObject({ ok: false, intents: [{ status: 'refused', code: 'trade.signal_tier_unavailable', actionKey: null }] });
    expect(w.orders).toEqual([]);
  });

  it("reads the live tier of the webhook's creator, never of a user the alert names", async () => {
    const w = world({ liveTier: 'basic' });
    await w.alert('a-who', { userId: 'u-other', user_id: 'u-other' });
    expect(w.tierAsked).toEqual(['u-1']);
  });

  it('refuses an alert by jurisdiction on the region kept at create: no order', async () => {
    // A screening list that blocks KP (the shared check's jurisdiction half); DE stays allowed.
    vi.stubEnv('INTAFACED_SANCTIONS_REGIONS', 'KP');
    vi.stubEnv('INTAFACED_SANCTIONS_LIST_SOURCE', 'test-fixture');
    try {
      const w = world({ liveTier: 'basic', hook: { region: 'KP' } });
      const out = await w.alert('a-region');
      expect(out.status).toBe(422);
      expect(out.body).toMatchObject({ ok: false, intents: [{ status: 'refused', code: 'denied.region_blocked', actionKey: null }] });
      expect(w.orders).toEqual([]);
      // The same list lets a DE webhook place, so the refusal above is the region's.
      const de = world({ liveTier: 'basic' });
      expect((await de.alert('a-region-de')).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses an alert for a restricted account as trade.desk_restricted: no order', async () => {
    // The restriction is the trading admission (controls/trading-controls.ts), asked for the alert's order before the door.
    const w = world({
      liveTier: 'basic',
      admitAlert: async () => {
        throw new TradingControlError('trade.desk_restricted');
      },
    });
    const out = await w.alert('a-restricted');
    expect(out.status).toBe(422);
    expect(out.body).toMatchObject({ ok: false, intents: [{ status: 'refused', code: 'trade.desk_restricted', actionKey: null }] });
    expect(w.orders).toEqual([]);
  });
});
