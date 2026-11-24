/**
 * A margin call raised twice at once on one position (two svc-trade processes ticking futures.liquidation), against
 * the real trade tables. Both writers read the same MAX(sequence), so the loser clashes on
 * position_margin_calls_seq_uidx, a key its ON CONFLICT does not name. It must get the open call that won, delivered,
 * never a 23505. Real Postgres via TEST_DATABASE_URL. Every value below is TEST content.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { durableMarginCallNotifier, sqlMarginCallStore } from './margin-call-transport.js';

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

const USER = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-07T12:00:00Z');
const positionFor = (round: number) => `44444444-4444-4444-8444-${String(round).padStart(12, '0')}`;

describe('a margin call raised twice at once on one position', () => {
  it('keeps one open call and delivers every raise, never a duplicate key', async () => {
    const store = sqlMarginCallStore(db.sql);
    const notifier = durableMarginCallNotifier(store);

    // One round is a narrow window; 40 rounds of 8 at once lost the race on main every run.
    for (let round = 0; round < 40; round += 1) {
      const positionId = positionFor(round);
      const input = (i: number) => ({ positionId, userId: USER, marketId: 'BTC-PERP', healthBps: 9000 + i, at: NOW });

      const outs = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.recordDelivered(input(i))));
      const failed = outs.filter((o) => o.status === 'rejected').map((o) => String((o as PromiseRejectedResult).reason));
      expect(failed).toEqual([]);
      for (const out of outs) {
        const row = (out as PromiseFulfilledResult<{ positionId: string; sequence: number; clearedAt: Date | null }>).value;
        expect(row).toMatchObject({ positionId, sequence: 1, clearedAt: null });
      }
      const rows = await db.sql`SELECT sequence FROM trade.position_margin_calls WHERE position_id = ${positionId}`;
      expect(rows.map((r) => r.sequence)).toEqual([1]);

      // The notifier is what the tick reads: a raced raise is still delivered, so grace may start.
      const notices = await Promise.all(Array.from({ length: 8 }, (_, i) => notifier.notifyMarginCall(input(i))));
      expect(notices.every((n) => n.delivered)).toBe(true);
    }
  }, 60_000);

  it('a call raised again after the first was cleared takes the next sequence, also when two race', async () => {
    const store = sqlMarginCallStore(db.sql);
    const positionId = positionFor(999);
    const input = { positionId, userId: USER, marketId: 'BTC-PERP', healthBps: 9100, at: NOW };
    await store.recordDelivered(input);
    await db.sql`UPDATE trade.position_margin_calls SET cleared_at = ${NOW.toISOString()} WHERE position_id = ${positionId}`;

    const outs = await Promise.all(Array.from({ length: 8 }, () => store.recordDelivered(input)));
    for (const out of outs) expect(out).toMatchObject({ sequence: 2, clearedAt: null });
    const rows = await db.sql`
      SELECT sequence, cleared_at IS NULL AS open FROM trade.position_margin_calls
       WHERE position_id = ${positionId} ORDER BY sequence`;
    expect(rows.map((r) => [r.sequence, r.open])).toEqual([
      [1, false],
      [2, true],
    ]);
  }, 30_000);
});
