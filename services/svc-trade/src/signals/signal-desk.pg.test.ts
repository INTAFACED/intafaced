/**
 * A chart alert delivered twice at once, against the real trade tables. The intent row's id is a hash of its
 * intent key, so both unique keys name the same row; the loser of the insert race must get the row that won, never a
 * 23505 on signal_intents_pkey. Real Postgres via TEST_DATABASE_URL. Every value below is TEST content.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { SignalDesk } from './signal-desk.js';

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
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (name.endsWith('_test')) return rawUrl;
  parsed.pathname = '/intafaced_test';
  return parsed.toString();
})();

const db: TestDatabase = await createTestDatabase({ service: 'trade', url, migrations });
afterAll(async () => {
  await db.drop();
}, 30_000);

const HOOK = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'the-webhook-token-0123456789';
const NOW = new Date('2026-11-07T12:00:00Z');
const OWNER = '0x00000000000000000000000000000000000000aa';
const hex = (v: string) => createHash('sha256').update(v).digest('hex');

describe('a redelivered alert arriving twice at once', () => {
  it('writes one intent and answers both calls, never a duplicate key', async () => {
    await db.sql`
      INSERT INTO trade.signal_webhooks (id, user_id, client_request_id, symbol, venue_owner, region, token_hash, token_prefix,
        place_grant, grant_expires_at, state, created_at, updated_at)
      VALUES (${HOOK}, 'u-1', 'req-1', 'BTC-USDC', ${OWNER}, 'DE', ${hex(TOKEN)}, ${TOKEN.slice(0, 6)},
        ${db.sql.json({} as never)}, '2026-12-01T00:00:00Z', 'active', ${NOW.toISOString()}, ${NOW.toISOString()})`;
    const refuse = async () => {
      throw new Error('nothing past the intent row is reached: the empty grant refuses first');
    };
    const desk = new SignalDesk({
      sql: db.sql,
      now: () => NOW,
      venueMarkets: async () => ['BTC-USDC'],
      liveTier: refuse,
      admitStart: refuse,
      admitAlert: refuse,
      prepareOrder: refuse,
      maxAlertAgeSeconds: 20,
      webhookDays: 30,
    });
    const alert = (alertId: string) => ({ token: TOKEN, alertId, time: NOW.toISOString(), side: 'buy', amount: '1', price: '60000' });

    // One round is a narrow window; 40 rounds of 8 at once lost the race on main every run.
    for (let round = 0; round < 40; round += 1) {
      const alertId = `alert-${round}`;
      const outs = await Promise.allSettled(Array.from({ length: 8 }, () => desk.ingest(HOOK, alert(alertId))));
      const failed = outs.filter((o) => o.status === 'rejected').map((o) => String((o as PromiseRejectedResult).reason));
      expect(failed).toEqual([]);
      const replies = outs.map((o) => (o as PromiseFulfilledResult<{ status: number; body: Record<string, unknown> }>).value);
      for (const reply of replies) expect(reply).toEqual(replies[0]);
      expect(replies[0]?.status).toBe(422);
      const rows = await db.sql`SELECT id FROM trade.signal_intents WHERE webhook_id = ${HOOK} AND alert_id = ${alertId}`;
      expect(rows).toHaveLength(1);
    }
  }, 60_000);
});
