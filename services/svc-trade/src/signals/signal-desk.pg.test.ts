/**
 * A chart alert webhook's create on Postgres (CB-bots-api-signal-01). A retried create carries the same request key, so
 * its id (a hash of the person and the key) and its (user_id, client_request_id) both name one row; calls racing on it
 * must all answer that one webhook, the token in exactly one reply, never a raw key clash.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestDatabase } from '@intafaced/db';
import { openTradeDatabase } from '../spot/__tests__/saga-trade-fixture.js';
import { SignalDesk } from './signal-desk.js';

let db: TestDatabase | undefined;
let stop: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const opened = await openTradeDatabase();
  db = opened.db;
  stop = opened.stop;
}, 120_000);

afterAll(async () => {
  await db?.drop();
  await stop();
}, 30_000);

const database = () => {
  if (!db) throw new Error('database not ready');
  return db;
};

const principal = {
  sub: 'u-race',
  userId: 'u-race',
  sid: 's-race',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date('2026-11-08T00:00:00Z'),
} as never;

function desk(): SignalDesk {
  return new SignalDesk({
    sql: database().sql,
    now: () => new Date('2026-11-07T12:00:00Z'),
    venueMarkets: async () => ['BTC-USDC'],
    liveTier: async () => 'basic',
    // Every racing call is admitted, as a retried create is, so all of them reach the insert.
    admitStart: async () => ({ ok: true }),
    admitAlert: async () => ({ ok: true }),
    prepareOrder: async () => ({ ok: false, code: 'trade.not_used' }),
    maxAlertAgeSeconds: 20,
    webhookDays: 30,
  });
}

describe('a webhook created many times at once under one request key', () => {
  it('answers one webhook to every call, with its token in exactly one reply, and never raises 23505', async () => {
    for (let round = 0; round < 25; round += 1) {
      const clientRequestId = `race-req-${String(round).padStart(4, '0')}`;
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          desk()
            .create(principal, { symbol: 'BTC-USDC', venueOwner: '0x00000000000000000000000000000000000000aa', clientRequestId }, 'DE')
            .then((view) => ({ id: view.webhookId, token: view.token }))
            .catch((err: unknown) => ({ error: String((err as { code?: string }).code ?? err) })),
        ),
      );
      const errors = outcomes.filter((o) => 'error' in o);
      expect(errors, `round ${round}`).toEqual([]);
      const views = outcomes as Array<{ id: string; token: string | null }>;
      expect(new Set(views.map((v) => v.id)).size, `round ${round}`).toBe(1);
      expect(
        views.filter((v) => v.token !== null),
        `round ${round}`,
      ).toHaveLength(1);
    }
    const rows = await database().sql`SELECT id FROM trade.signal_webhooks WHERE user_id = 'u-race'`;
    expect(rows).toHaveLength(25);
  });
});
