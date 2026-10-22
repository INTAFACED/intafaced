/**
 * Trade signal webhooks (CB-bots-api-signal-01 PR 2) against Postgres.
 *
 * Promise: create returns the token once and stores only its hash; intake is svc-edge only; a bad token, a stale alert and a
 * blank owner value refuse with their codes and place nothing; the same alert twice is one order; a demo webhook places only
 * on a paper market.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import { signalsRouter } from './router.js';
import { parseSignalLimits, type SignalLimits } from './signal-config.js';
import { SignalWebhookService, type SignalPlaceInput } from './signal-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const rawUrl = process.env.TEST_DATABASE_URL?.trim();
if (!rawUrl) throw new Error('TEST_DATABASE_URL is unset; this suite does not start Docker');
const url = (() => {
  const parsed = new URL(rawUrl);
  if (decodeURIComponent(parsed.pathname.replace(/^\//, '')).endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const ALICE = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-22T08:00:00.000Z');
// Test-only values for the owner settings; they are fixtures, not proposed production numbers.
const LIMITS = parseSignalLimits({
  TRADE_SIGNAL_LATENCY_MAX_MS: '1000',
  TRADE_SIGNAL_BODY_CAP_BYTES: '512',
  TRADE_SIGNAL_RATE_LIMIT: '3/60',
});
const MARKETS: Record<string, { paper: boolean }> = { 'BTC/USDT': { paper: false }, 'PAPER/USDT': { paper: true } };

function principal(scopes: string[]): Principal {
  return {
    sub: ALICE,
    userId: ALICE,
    scopes,
    tier: 'basic',
    mfa: false,
    sid: '00000000-0000-4000-8000-000000000009',
    expiresAt: new Date(NOW.getTime() + 60_000),
  } as Principal;
}

function alert(alertId: string, sentAt = new Date(NOW.getTime() - 200)): string {
  return JSON.stringify({ alertId, sentAt: sentAt.toISOString(), side: 'buy', type: 'limit', qty: '0.01', price: '50000' });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    const e = err as { code?: string; message?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? 'unknown';
  }
}

describe('signals webhooks + intake', () => {
  let db: TestDatabase;
  let placed: Array<{ userId: string; input: SignalPlaceInput }>;
  const ordersByKey = new Map<string, string>();

  function service(limits: SignalLimits = LIMITS, wirePlace = true) {
    return new SignalWebhookService({
      sql: db.sql,
      limits,
      now: () => NOW,
      loadMarket: async (symbol) => MARKETS[symbol] ?? null,
      ...(wirePlace
        ? {
            place: async (userId: string, input: SignalPlaceInput) => {
              placed.push({ userId, input });
              // Same retry-key behaviour as placeOrder: one client order id is one order.
              const id =
                ordersByKey.get(input.clientOrderId) ?? `00000000-0000-4000-8000-${String(ordersByKey.size + 1).padStart(12, '0')}`;
              ordersByKey.set(input.clientOrderId, id);
              return { orderId: id };
            },
          }
        : {}),
    });
  }

  function edge(svc: SignalWebhookService, caller: string | null = 'svc-edge') {
    return signalsRouter(svc).createCaller({ principal: null, service: caller } as never);
  }
  function customer(svc: SignalWebhookService) {
    return signalsRouter(svc).createCaller({ principal: principal(['trade:read', 'trade:write']), service: null } as never);
  }

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 60_000);
  beforeEach(async () => {
    await db.sql`TRUNCATE trade.signal_alerts, trade.signal_webhooks`;
    placed = [];
    ordersByKey.clear();
  });

  it('bad token -> refused; token never stored in clear', async () => {
    const svc = service();
    const created = await customer(svc).webhook.create({ symbol: 'BTC/USDT', mode: 'live' });
    expect(created.token.length).toBeGreaterThanOrEqual(32);
    const rows = await db.sql<{ token_hash: Buffer }[]>`SELECT token_hash FROM trade.signal_webhooks`;
    expect(Buffer.from(rows[0]!.token_hash).equals(createHash('sha256').update(created.token).digest())).toBe(true);
    const dump = JSON.stringify(await db.sql`SELECT row_to_json(w)::text AS t FROM trade.signal_webhooks w`);
    expect(dump).not.toContain(created.token);
    const listed = await customer(svc).webhook.list({});
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(listed.items).toHaveLength(1);

    const msg = async (p: Promise<unknown>) =>
      await p.then(
        () => 'ok',
        (e: Error) => e.message,
      );
    expect(await msg(edge(svc).intake({ webhookId: created.webhook.webhookId, token: 'x'.repeat(43), body: alert('a1') }))).toContain(
      'trade.signal_token_invalid',
    );
    expect(
      await msg(edge(svc).intake({ webhookId: '99999999-9999-4999-8999-999999999999', token: created.token, body: alert('a1') })),
    ).toContain('trade.signal_token_invalid');
    expect(placed).toHaveLength(0);
    expect((await db.sql`SELECT 1 FROM trade.signal_alerts`).length).toBe(0);
  });

  it('intake is callable only by svc-edge', async () => {
    const svc = service();
    const created = await customer(svc).webhook.create({ symbol: 'BTC/USDT', mode: 'live' });
    const input = { webhookId: created.webhook.webhookId, token: created.token, body: alert('a1') };
    expect(await codeOf(edge(svc, 'svc-bank').intake(input))).toBe('s2s.caller_forbidden');
    expect(await codeOf(edge(svc, null).intake(input))).toBe('UNAUTHORIZED');
    expect(placed).toHaveLength(0);
  });

  it('same alert twice -> one order', async () => {
    const svc = service();
    const created = await customer(svc).webhook.create({ symbol: 'BTC/USDT', mode: 'live' });
    const input = { webhookId: created.webhook.webhookId, token: created.token, body: alert('dup-1') };
    const first = await edge(svc).intake(input);
    const second = await edge(svc).intake(input);
    expect(first).toMatchObject({ outcome: 'placed', replay: false, alertKey: `signal.alert:${created.webhook.webhookId}:dup-1` });
    expect(second).toEqual({ ...first, replay: true });
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ userId: ALICE, input: { symbol: 'BTC/USDT', side: 'buy', qty: '0.01', price: '50000' } });
    const rows = await db.sql`SELECT outcome, order_id FROM trade.signal_alerts`;
    expect(rows).toEqual([{ outcome: 'placed', order_id: first.orderId }]);
  });

  it('stale alert -> trade.signal_stale, no order', async () => {
    const svc = service();
    const created = await customer(svc).webhook.create({ symbol: 'BTC/USDT', mode: 'live' });
    const stale = alert('old-1', new Date(NOW.getTime() - 1001));
    const err = await edge(svc)
      .intake({ webhookId: created.webhook.webhookId, token: created.token, body: stale })
      .then(
        () => 'ok',
        (e: Error) => e.message,
      );
    expect(err).toContain('trade.signal_stale');
    expect(placed).toHaveLength(0);
    expect((await db.sql`SELECT 1 FROM trade.signal_alerts`).length).toBe(0);
  });

  it.each([
    ['TRADE_SIGNAL_LATENCY_MAX_MS', 'trade.signal_latency_unset'],
    ['TRADE_SIGNAL_BODY_CAP_BYTES', 'trade.signal_body_cap_unset'],
    ['TRADE_SIGNAL_RATE_LIMIT', 'trade.signal_rate_limit_unset'],
  ] as const)('blank %s -> intake refused %s', async (key, code) => {
    const created = await customer(service()).webhook.create({ symbol: 'BTC/USDT', mode: 'live' });
    const limits = parseSignalLimits({
      TRADE_SIGNAL_LATENCY_MAX_MS: '1000',
      TRADE_SIGNAL_BODY_CAP_BYTES: '512',
      TRADE_SIGNAL_RATE_LIMIT: '3/60',
      [key]: '',
    });
    const err = await edge(service(limits))
      .intake({ webhookId: created.webhook.webhookId, token: created.token, body: alert('u1') })
      .then(
        () => 'ok',
        (e: Error) => e.message,
      );
    expect(err).toContain(code);
    expect(placed).toHaveLength(0);
  });

  it('demo webhook -> demo order path only', async () => {
    const svc = service();
    expect(await codeOf(customer(svc).webhook.create({ symbol: 'BTC/USDT', mode: 'demo' }))).toBe('BAD_REQUEST');
    expect(await codeOf(customer(svc).webhook.create({ symbol: 'PAPER/USDT', mode: 'live' }))).toBe('BAD_REQUEST');
    const demo = await customer(svc).webhook.create({ symbol: 'PAPER/USDT', mode: 'demo' });
    const res = await edge(svc).intake({ webhookId: demo.webhook.webhookId, token: demo.token, body: alert('d1') });
    expect(res.outcome).toBe('placed');
    expect(placed.map((p) => p.input.symbol)).toEqual(['PAPER/USDT']);

    // A market that flips to live after create is refused and recorded, never placed live.
    MARKETS['PAPER/USDT'] = { paper: false };
    try {
      const res2 = await edge(svc).intake({ webhookId: demo.webhook.webhookId, token: demo.token, body: alert('d2') });
      expect(res2).toMatchObject({ outcome: 'refused', reason: 'signal.mode_mismatch', orderId: null });
      expect(placed).toHaveLength(1);
    } finally {
      MARKETS['PAPER/USDT'] = { paper: true };
    }
  });

  it('body over the cap, rate limit and unwired placement refuse without placing', async () => {
    const svc = service();
    const created = await customer(svc).webhook.create({ symbol: 'BTC/USDT', mode: 'live' });
    const base = { webhookId: created.webhook.webhookId, token: created.token };
    expect(await codeOf(edge(svc).intake({ ...base, body: 'x'.repeat(513) }))).toBe('PAYLOAD_TOO_LARGE');
    expect(await codeOf(edge(service(LIMITS, false)).intake({ ...base, body: alert('w1') }))).toBe('SERVICE_UNAVAILABLE');
    for (const id of ['r1', 'r2', 'r3']) await edge(svc).intake({ ...base, body: alert(id) });
    expect(await codeOf(edge(svc).intake({ ...base, body: alert('r4') }))).toBe('TOO_MANY_REQUESTS');
    expect(placed).toHaveLength(3);
  });
});
