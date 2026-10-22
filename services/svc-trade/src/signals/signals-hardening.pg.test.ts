/**
 * Trade signal webhooks hardening (CB-bots-api-signal-01 PR 2, Deep review 4 findings) against Postgres.
 *
 * Promise: with no placement port, `create` refuses (`signal.place_unwired`) and an unwired intake writes no alert row; a
 * sentAt beyond the latency window in the future refuses (`signal.future_dated`); concurrent alerts cannot exceed the
 * per-webhook rate limit.
 */
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

describe('signals hardening', () => {
  let db: TestDatabase;
  let placed: Array<{ userId: string; input: SignalPlaceInput }>;

  function service(wirePlace = true) {
    return new SignalWebhookService({
      sql: db.sql,
      limits: LIMITS,
      now: () => NOW,
      loadMarket: async (symbol) => MARKETS[symbol] ?? null,
      ...(wirePlace
        ? {
            place: async (userId: string, input: SignalPlaceInput) => {
              placed.push({ userId, input });
              return { orderId: `00000000-0000-4000-8000-${String(placed.length).padStart(12, '0')}` };
            },
          }
        : {}),
    });
  }
  function edge(svc: SignalWebhookService) {
    return signalsRouter(svc).createCaller({ principal: null, service: 'svc-edge' } as never);
  }
  function customer(svc: SignalWebhookService) {
    return signalsRouter(svc).createCaller({ principal: principal(['trade:read', 'trade:write']), service: null } as never);
  }
  async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
    try {
      await p;
      return { code: 'ok', message: '' };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { code: e.code ?? 'unknown', message: e.message ?? '' };
    }
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
  });

  it('create refuses signal.place_unwired while placement is not wired; no webhook row', async () => {
    const r = await refusal(customer(service(false)).webhook.create({ symbol: 'BTC/USDT', mode: 'live' }));
    expect(r.code).toBe('SERVICE_UNAVAILABLE');
    expect(r.message).toContain('signal.place_unwired');
    expect((await db.sql`SELECT 1 FROM trade.signal_webhooks`).length).toBe(0);
  });

  it('unwired intake -> SERVICE_UNAVAILABLE and trade.signal_alerts stays empty', async () => {
    const created = await customer(service()).webhook.create({ symbol: 'BTC/USDT', mode: 'live' });
    const r = await refusal(edge(service(false)).intake({ webhookId: created.webhook.webhookId, token: created.token, body: alert('w1') }));
    expect(r.code).toBe('SERVICE_UNAVAILABLE');
    expect(placed).toHaveLength(0);
    expect((await db.sql`SELECT 1 FROM trade.signal_alerts`).length).toBe(0);
  });

  it('sentAt beyond the latency window in the future -> signal.future_dated, no row; within the window is accepted', async () => {
    const svc = service();
    const created = await customer(svc).webhook.create({ symbol: 'BTC/USDT', mode: 'live' });
    const base = { webhookId: created.webhook.webhookId, token: created.token };
    const r = await refusal(edge(svc).intake({ ...base, body: alert('f1', new Date(NOW.getTime() + 1001)) }));
    expect(r.code).toBe('BAD_REQUEST');
    expect(r.message).toContain('signal.future_dated');
    expect(placed).toHaveLength(0);
    expect((await db.sql`SELECT 1 FROM trade.signal_alerts`).length).toBe(0);
    const ok = await edge(svc).intake({ ...base, body: alert('f2', new Date(NOW.getTime() + 500)) });
    expect(ok.outcome).toBe('placed');
  });

  it('concurrent alerts cannot exceed the per-webhook rate limit', async () => {
    const svc = service();
    const created = await customer(svc).webhook.create({ symbol: 'BTC/USDT', mode: 'live' });
    const base = { webhookId: created.webhook.webhookId, token: created.token };
    const results = await Promise.all(
      ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map((id) => refusal(edge(svc).intake({ ...base, body: alert(id) }))),
    );
    expect(results.filter((r) => r.code === 'ok')).toHaveLength(3);
    expect(results.filter((r) => r.code === 'TOO_MANY_REQUESTS')).toHaveLength(5);
    expect(placed).toHaveLength(3);
    expect((await db.sql`SELECT 1 FROM trade.signal_alerts`).length).toBe(3);
  });
});
