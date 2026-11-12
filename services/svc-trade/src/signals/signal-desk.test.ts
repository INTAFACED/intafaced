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
      position: async () => {
        throw new Error('no position may be read');
      },
      publishNote: async () => {
        throw new Error('no notice may be sent');
      },
      failureCount: 3,
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
    position?: SignalPorts['position'];
    failureCount?: number | null;
    hook?: Partial<{ state: 'active' | 'paused' | 'ended'; grant_expires_at: Date; region: string; kind: 'order' | 'notify' }>;
  }) {
    const writes: string[] = [];
    const orders: Array<{ userId: string; owner: string; intent: Record<string, unknown> }> = [];
    const admissions: string[] = [];
    const children: Array<{ businessId: string; webhookId: string }> = [];
    const tierAsked: string[] = [];
    const results = new Map<string, { status: number; body: Record<string, unknown> }>();
    const notes: Array<{ userId: string; webhookId: string; alertId: string; message: string }> = [];
    const positionsRead: string[] = [];
    const intents = new Map<string, Record<string, unknown>>();
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
      kind: 'order',
      ended_reason: null as string | null,
      consecutive_failures: 0,
      created_at: NOW,
      updated_at: NOW,
      ...opts.hook,
    };
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?').replace(/\s+/g, ' ').trim();
        if (text.startsWith('SELECT * FROM trade.signal_webhooks WHERE id')) return [hook];
        if (text.startsWith('SELECT * FROM trade.signal_webhooks WHERE user_id')) return [];
        if (text.startsWith('SELECT status, body FROM trade.signal_alert_results')) {
          const kept = results.get(values[1] as string);
          return kept ? [kept] : [];
        }
        writes.push(text.split(' (')[0]!);
        if (text.startsWith('INSERT INTO trade.signal_alert_results')) {
          if (results.has(values[1] as string)) return [];
          results.set(values[1] as string, { status: values[2] as number, body: values[3] as never });
          return [{ alert_id: values[1] }];
        }
        if (text.startsWith('INSERT INTO trade.signal_intents')) {
          if (!intents.has(values[4] as string))
            intents.set(values[4] as string, {
              alertId: values[2],
              action: values[3],
              side: values[5],
              sizing: values[6],
              status: 'pending',
            });
          return [];
        }
        if (text.startsWith('UPDATE trade.signal_intents')) {
          const row = intents.get(values[5] as string);
          if (row) Object.assign(row, { status: values[0], actionKey: values[1], code: values[3] });
          return [];
        }
        if (text.startsWith('UPDATE trade.signal_webhooks SET consecutive_failures = consecutive_failures + 1')) {
          hook.consecutive_failures += 1;
          return [{ consecutive_failures: hook.consecutive_failures }];
        }
        if (text.startsWith('UPDATE trade.signal_webhooks SET consecutive_failures = 0')) {
          hook.consecutive_failures = 0;
          return [];
        }
        if (text.startsWith("UPDATE trade.signal_webhooks SET state = 'ended'")) {
          if (hook.state === 'ended') return [];
          hook.state = 'ended';
          hook.ended_reason = text.includes("ended_reason = 'owner'") ? 'owner' : 'failures';
          return [{ ...hook }];
        }
        if (text.startsWith('UPDATE trade.signal_webhooks SET state =')) {
          if (hook.state === 'ended') return [];
          hook.state = values[0] as 'active' | 'paused';
          return [{ ...hook }];
        }
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
      position:
        opts.position ??
        (async (owner, symbol) => {
          positionsRead.push(`${owner}:${symbol}`);
          return { kind: 'spot', size: parseAmount('0.002'), lotSize: parseAmount('0.001') };
        }),
      publishNote: async (note) => {
        notes.push({ userId: note.userId, webhookId: note.webhookId, alertId: note.alertId, message: note.message });
      },
      failureCount: opts.failureCount === undefined ? 3 : opts.failureCount,
      maxAlertAgeSeconds: 20,
      webhookDays: 30,
    });
    const alert = (alertId: string, extra: Record<string, unknown> = {}) =>
      desk.ingest(HOOK, { token: TOKEN, alertId, time: NOW.toISOString(), side: 'buy', amount: '0.01', price: '60000', ...extra });
    const note = (alertId: string, extra: Record<string, unknown> = {}) =>
      desk.ingestNote(HOOK, { token: TOKEN, alertId, time: NOW.toISOString(), message: 'TEST alert', ...extra });
    return { desk, alert, note, hook, intents, writes, orders, admissions, children, tierAsked, notes, positionsRead, results };
  }

  it('creates for a basic person, keeping the region for the alerts', async () => {
    const w = world({ liveTier: 'basic' });
    const made = await w.desk.create(principal('basic'), { symbol: 'BTCUSDC', venueOwner: OWNER, clientRequestId: 'req-00000001' }, 'DE');
    expect(made.token).not.toBeNull();
    expect(w.admissions).toHaveLength(1);
    // The same person and request key always name the same webhook, so a retried create admits the same strategy.
    const again = world({ liveTier: 'basic' });
    const twice = await again.desk.create(
      principal('basic'),
      { symbol: 'BTCUSDC', venueOwner: OWNER, clientRequestId: 'req-00000001' },
      'DE',
    );
    expect(twice.webhookId).toBe(made.webhookId);
    expect(again.admissions).toEqual(w.admissions);
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

  it("prepares one venue market IOC under the alert's own key, admitted on the webhook as a standing instruction, for a basic person", async () => {
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

  it('refuses an amount or a price sent as a JSON number, naming the field: money arrives as decimal strings only', async () => {
    for (const [field, extra] of [
      ['amount', { amount: 0.01 }],
      ['price', { price: 70000.123456789 }],
    ] as const) {
      const w = world({ liveTier: 'basic' });
      const out = await w.alert(`a-number-${field}`, extra);
      expect(out).toMatchObject({ status: 400, body: { code: 'trade.signal_format_invalid', field } });
      expect(w.children).toEqual([]);
      expect(w.orders).toEqual([]);
      expect(w.writes).toEqual([]);
    }
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

  it("plans a percent of the position on the venue account's holding, rounded down to the lot: position percent 50", async () => {
    const w = world({ liveTier: 'basic' });
    const out = await w.alert('a-half', { side: 'sell', amount: '50%' });
    expect(out.status).toBe(200);
    expect(w.positionsRead).toEqual([`${OWNER}:BTC-USDC`]);
    expect(w.orders).toEqual([
      { userId: 'u-1', owner: OWNER, intent: expect.objectContaining({ side: 'sell', amount: parseAmount('0.001'), reduceOnly: false }) },
    ]);
    expect([...w.intents.values()]).toEqual([
      expect.objectContaining({ action: 'open', side: 'sell', sizing: { kind: 'position_percent', value: '50', quantity: '0.001' } }),
    ]);
    // The same with amountType, and a percent above 100 or with a quantity type refused naming the field.
    const typed = world({ liveTier: 'basic' });
    expect((await typed.alert('a-typed', { side: 'sell', amount: '50', amountType: 'position_percent' })).status).toBe(200);
    expect(typed.orders[0]!.intent).toMatchObject({ amount: parseAmount('0.001') });
    for (const [extra, field] of [
      [{ amount: '150%' }, 'amount'],
      [{ amount: '50%', amountType: 'quantity' }, 'amountType'],
      [{ amountType: 'notional' }, 'amountType'],
    ] as const) {
      const bad = world({ liveTier: 'basic' });
      expect(await bad.alert('a-bad', extra)).toMatchObject({ status: 400, body: { code: 'trade.signal_format_invalid', field } });
      expect(bad.writes).toEqual([]);
      expect(bad.positionsRead).toEqual([]);
    }
  });

  it('refuses a percent of no position as its own intent: nothing prepared', async () => {
    const w = world({ liveTier: 'basic', position: async () => ({ kind: 'spot', size: 0n, lotSize: parseAmount('0.001') }) });
    const out = await w.alert('a-flat', { side: 'sell', amount: '50%' });
    expect(out).toMatchObject({ status: 422, body: { intents: [{ status: 'refused', code: 'trade.signal_no_position' }] } });
    expect(w.orders).toEqual([]);
  });

  it('refuses an alert when the position cannot be read: nothing written, nothing stored, so a resend tries again', async () => {
    const w = world({
      liveTier: 'basic',
      position: async () => {
        throw new Error('venue down');
      },
    });
    const out = await w.alert('a-unread', { side: 'reverse' });
    expect(out).toMatchObject({ status: 503, body: { code: 'trade.signal_position_unavailable' } });
    expect(w.writes).toEqual([]);
  });

  it('plans a reversal on a perpetual as one close and one open, each prepared under its own key, the close first and reduce-only', async () => {
    const w = world({
      liveTier: 'basic',
      position: async () => ({ kind: 'perpetual', size: parseAmount('0.03'), lotSize: parseAmount('0.001') }),
    });
    const out = await w.alert('a-rev', { side: 'reverse' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({
      ok: true,
      intents: [
        { action: 'close', side: 'sell', status: 'prepared', actionKey: `signal-order:${HOOK}:a-rev:close` },
        { action: 'open', side: 'sell', status: 'prepared', actionKey: `signal-order:${HOOK}:a-rev` },
      ],
    });
    expect(w.orders.map((o) => [o.intent.clientOrderKey, o.intent.side, o.intent.amount, o.intent.reduceOnly])).toEqual([
      [`signal-order:${HOOK}:a-rev:close`, 'sell', parseAmount('0.03'), true],
      [`signal-order:${HOOK}:a-rev`, 'sell', parseAmount('0.01'), false],
    ]);
    expect(w.children.map((c) => c.businessId)).toEqual([`signal-order:${HOOK}:a-rev:close`, `signal-order:${HOOK}:a-rev`]);
    // The same alert again: the stored reply, nothing new prepared.
    expect(await w.alert('a-rev', { side: 'reverse' })).toEqual(out);
    expect(w.orders).toHaveLength(2);
  });

  it('plans a reversal on cash spot as a prepared close of what is held and an open refused by its own code: spot holds no short', async () => {
    const w = world({ liveTier: 'basic' });
    const out = await w.alert('a-rev-spot', { side: 'reverse' });
    expect(out.status).toBe(207);
    expect(out.body).toMatchObject({
      ok: false,
      intents: [
        { action: 'close', side: 'sell', status: 'prepared', actionKey: `signal-order:${HOOK}:a-rev-spot:close` },
        { action: 'open', side: 'sell', status: 'refused', code: 'trade.signal_short_not_offered', actionKey: null },
      ],
    });
    expect(w.orders.map((o) => [o.intent.clientOrderKey, o.intent.amount])).toEqual([
      [`signal-order:${HOOK}:a-rev-spot:close`, parseAmount('0.002')],
    ]);
    // Two intent rows, each under its own key.
    expect([...w.intents.keys()]).toEqual([`signal.alert:${HOOK}:a-rev-spot:close`, `signal.alert:${HOOK}:a-rev-spot:open`]);
  });

  it('never opens a reversal the other way when its close was refused', async () => {
    const w = world({
      liveTier: 'basic',
      position: async () => ({ kind: 'perpetual', size: parseAmount('-0.02'), lotSize: parseAmount('0.001') }),
      prepareOrder: async () => ({ ok: false, code: 'venue.market_halted' }),
    });
    const out = await w.alert('a-rev-halt', { side: 'reverse' });
    expect(out.body).toMatchObject({
      intents: [
        { action: 'close', side: 'buy', status: 'refused', code: 'venue.market_halted' },
        { action: 'open', side: 'buy', status: 'refused', code: 'trade.signal_reverse_close_failed' },
      ],
    });
  });

  it('refuses a reversal with no position, and a message with no side naming the field: nothing written', async () => {
    const flat = world({ liveTier: 'basic', position: async () => ({ kind: 'spot', size: 0n, lotSize: parseAmount('0.001') }) });
    expect(await flat.alert('a-rev-flat', { side: 'reverse' })).toMatchObject({ status: 422, body: { code: 'trade.signal_no_position' } });
    const noSide = world({ liveTier: 'basic' });
    expect(await noSide.alert('a-noside', { side: undefined })).toMatchObject({
      status: 400,
      body: { code: 'trade.signal_format_invalid', field: 'side' },
    });
    for (const w of [flat, noSide]) {
      expect(w.writes).toEqual([]);
      expect(w.orders).toEqual([]);
    }
  });

  it('ends the webhook once after the owner count of failed alerts in a row; a prepared alert sets the count back to zero', async () => {
    let refuse = true;
    const w = world({
      liveTier: 'basic',
      prepareOrder: async (_p, input) =>
        refuse
          ? { ok: false, code: 'venue.order_above_venue_max' }
          : { ok: true, actionKey: input.intent.clientOrderKey, venueClientOrderId: null },
    });
    await w.alert('f-1');
    await w.alert('f-2');
    expect(w.hook.consecutive_failures).toBe(2);
    refuse = false;
    expect((await w.alert('ok-1')).status).toBe(200);
    expect(w.hook.consecutive_failures).toBe(0);
    refuse = true;
    for (const id of ['f-3', 'f-4']) expect((await w.alert(id)).status).toBe(422);
    // A repeat of a failed alert id answers its stored reply and does not count again.
    await w.alert('f-4');
    expect(w.hook.consecutive_failures).toBe(2);
    expect(w.hook.state).toBe('active');
    expect((await w.alert('f-5')).status).toBe(422);
    expect(w.hook).toMatchObject({ state: 'ended', ended_reason: 'failures', consecutive_failures: 3 });
    const endedWrites = w.writes.filter((t) => t.startsWith("UPDATE trade.signal_webhooks SET state = 'ended'"));
    expect(endedWrites).toHaveLength(1);
    expect(await w.alert('after')).toMatchObject({ status: 410, body: { code: 'trade.signal_webhook_ended' } });
  });

  it('refuses every alert while the owner failure count is blank ("Not set"): nothing written', async () => {
    const w = world({ liveTier: 'basic', failureCount: null });
    const out = await w.alert('a-noset');
    expect(out).toMatchObject({ status: 503, body: { code: 'trade.signal_failure_count_not_set' } });
    expect(String(out.body.message)).toMatch(/^Not set/);
    expect(w.writes).toEqual([]);
  });

  it("pauses, resumes and ends the person's own webhook; an ended one cannot resume", async () => {
    const w = world({ liveTier: 'basic' });
    const p = principal('basic');
    expect(await w.desk.pause(p, HOOK)).toMatchObject({ state: 'paused' });
    expect(await w.alert('a-while-paused')).toMatchObject({ status: 409, body: { code: 'trade.signal_paused' } });
    expect(await w.desk.resume(p, HOOK)).toMatchObject({ state: 'active' });
    expect(await w.desk.end(p, HOOK)).toMatchObject({ state: 'ended', endedReason: 'owner' });
    await expect(w.desk.resume(p, HOOK)).rejects.toMatchObject({ code: 'trade.signal_webhook_ended' });
    expect(await w.desk.end(p, HOOK)).toMatchObject({ state: 'ended' });
    expect(w.orders).toEqual([]);
  });
});

describe('a notification URL turns an alert into one notice, never an order (CB-bots-api-signal-03)', () => {
  const HOOK = '33333333-3333-4333-8333-333333333333';
  const TOKEN = 'the-notify-token-0123456789';
  const NOW = new Date('2026-11-07T12:00:00Z');
  const hex = (v: string) => createHash('sha256').update(v).digest('hex');

  function world(kind: 'order' | 'notify', publish?: SignalPorts['publishNote']) {
    const notes: string[] = [];
    const results = new Map<string, { status: number; body: Record<string, unknown> }>();
    const writes: string[] = [];
    const hook = {
      id: HOOK,
      user_id: 'u-1',
      kind,
      symbol: null,
      venue_owner: null,
      region: 'DE',
      token_hash: hex(TOKEN),
      token_prefix: TOKEN.slice(0, 6),
      place_grant: null,
      grant_expires_at: null,
      state: 'active',
      ended_reason: null,
      consecutive_failures: 0,
      created_at: NOW,
    };
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?').replace(/\s+/g, ' ').trim();
        if (text.startsWith('SELECT * FROM trade.signal_webhooks WHERE id')) return [hook];
        if (text.startsWith('SELECT status, body FROM trade.signal_alert_results')) {
          const kept = results.get(values[1] as string);
          return kept ? [kept] : [];
        }
        writes.push(text.split(' (')[0]!);
        if (text.startsWith('INSERT INTO trade.signal_alert_results')) {
          if (results.has(values[1] as string)) return [];
          results.set(values[1] as string, { status: values[2] as number, body: values[3] as never });
          return [{ alert_id: values[1] }];
        }
        return [];
      },
      { json: (v: unknown) => v },
    ) as unknown as SignalPorts['sql'];
    const never = async () => {
      throw new Error('a notification URL never trades');
    };
    const desk = new SignalDesk({
      sql,
      now: () => NOW,
      venueMarkets: never,
      liveTier: never,
      admitStart: never,
      admitAlert: never,
      prepareOrder: never,
      position: never,
      publishNote:
        publish ??
        (async (n) => {
          notes.push(`${n.userId}:${n.webhookId}:${n.alertId}:${n.message}`);
        }),
      failureCount: 3,
      maxAlertAgeSeconds: 20,
      webhookDays: 30,
    });
    const note = (path: 'note' | 'order', alertId: string, extra: Record<string, unknown> = {}) =>
      (path === 'note' ? desk.ingestNote : desk.ingest).call(desk, HOOK, {
        token: TOKEN,
        alertId,
        time: NOW.toISOString(),
        message: 'TEST alert',
        side: 'buy',
        amount: '1',
        price: '1',
        ...extra,
      });
    return { note, notes, writes };
  }

  it('sends one notice for an alert, and the same alert id again sends none', async () => {
    const w = world('notify');
    const out = await w.note('note', 'n-1');
    expect(out).toEqual({ status: 200, body: { ok: true, alertId: 'n-1', notice: 'sent', orders: 0 } });
    expect(await w.note('note', 'n-1')).toEqual(out);
    expect(w.notes).toEqual([`u-1:${HOOK}:n-1:TEST alert`]);
    expect(w.writes.some((t) => t.includes('signal_intents'))).toBe(false);
  });

  it('refuses a notification token at the order path, and an order token at the notice path, as auth failed', async () => {
    expect(await world('notify').note('order', 'n-2')).toMatchObject({ status: 403, body: { code: 'trade.signal_auth_failed' } });
    const orderHook = world('order');
    expect(await orderHook.note('note', 'n-3')).toMatchObject({ status: 403, body: { code: 'trade.signal_auth_failed' } });
    expect(orderHook.notes).toEqual([]);
  });

  it('refuses a stale alert and one with no message, naming the field: no notice', async () => {
    const w = world('notify');
    expect(await w.note('note', 'n-4', { time: '2026-11-07T11:00:00Z' })).toMatchObject({
      status: 400,
      body: { code: 'trade.signal_stale' },
    });
    expect(await w.note('note', 'n-5', { message: '' })).toMatchObject({
      status: 400,
      body: { code: 'trade.signal_format_invalid', field: 'message' },
    });
    expect(w.notes).toEqual([]);
    expect(w.writes).toEqual([]);
  });

  it('answers 503 and stores nothing when the bus cannot take the notice, so a resend sends it', async () => {
    let fail = true;
    const sent: string[] = [];
    const w = world('notify', async (n) => {
      if (fail) throw new Error('bus down');
      sent.push(n.alertId);
    });
    expect(await w.note('note', 'n-6')).toMatchObject({ status: 503, body: { code: 'trade.signal_note_unsent' } });
    fail = false;
    expect((await w.note('note', 'n-6')).status).toBe(200);
    expect(sent).toEqual(['n-6']);
  });
});
