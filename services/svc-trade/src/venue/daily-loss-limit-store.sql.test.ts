import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import { SqlDailyLossLimitStore, ageDailyLossLimit } from './daily-loss-limit-store.js';
import { changed, inForce, LOOSENING_WAIT_MS } from './daily-loss-limit.js';

// trade.user_venue_daily_loss_limits (daily-loss-limit.ts): the terms in force and a waiting loosening round-trip
// exactly, one row per person and venue account, and the table refuses half-set terms.

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The daily loss limit store test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const a = parseAmount;
const KEY = {
  userId: '11111111-1111-4111-8111-1111111111d2',
  venueId: 'test-venue-sim',
  owner: '0x00000000000000000000000000000000000000d2',
};

describe('SqlDailyLossLimitStore on Postgres (trade.user_venue_daily_loss_limits)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('keeps the terms in force and a waiting loosening exactly, in one row per person and account', async () => {
    const store = new SqlDailyLossLimitStore(db!.sql);
    const t0 = new Date('2026-11-27T10:00:00Z');
    expect(await store.get(KEY)).toBeNull();
    const blank = { ...KEY, asset: 'USDC', active: null, pending: null, createdAt: t0, updatedAt: t0 };

    const on = await store.update(KEY, (r) => changed(r ?? blank, { mode: 'blocking', limit: a('100.5') }, t0));
    expect(on).toMatchObject({ asset: 'USDC', active: { mode: 'blocking', limit: a('100.5') }, pending: null });

    const t1 = new Date(t0.getTime() + 60_000);
    const waiting = await store.update(KEY, (r) => changed(r!, null, t1));
    expect(waiting.active).toEqual({ mode: 'blocking', limit: a('100.5') });
    expect(waiting.pending).toEqual({ terms: null, effectiveAt: new Date(t1.getTime() + LOOSENING_WAIT_MS) });
    expect(await store.get(KEY)).toEqual(waiting);
    expect(inForce((await store.get(KEY))!, new Date(t1.getTime() + LOOSENING_WAIT_MS)).active).toBeNull();

    const looser = await store.update(KEY, (r) => changed(r!, { mode: 'advisory', limit: a('100.5') }, t1));
    expect(looser.pending).toEqual({
      terms: { mode: 'advisory', limit: a('100.5') },
      effectiveAt: new Date(t1.getTime() + LOOSENING_WAIT_MS),
    });

    const rows = await db!.sql`SELECT count(*)::int AS n FROM trade.user_venue_daily_loss_limits WHERE user_id = ${KEY.userId}`;
    expect(rows[0]!.n).toBe(1);
  });

  it("the TEST age door moves only a waiting loosening's time back, so its 24 hours pass on a TEST clock", async () => {
    const key = { ...KEY, userId: '11111111-1111-4111-8111-1111111111d4' };
    const store = new SqlDailyLossLimitStore(db!.sql);
    const age = ageDailyLossLimit(db!.sql);
    const t0 = new Date();
    const blank = { ...key, asset: 'USDC', active: null, pending: null, createdAt: t0, updatedAt: t0 };
    await store.update(key, (r) => changed(r ?? blank, { mode: 'blocking', limit: a('100') }, t0));
    // Nothing waits: nothing is aged.
    expect(await age(key.owner, 60_000)).toBeNull();
    const asked = await store.update(key, (r) => changed(r!, { mode: 'blocking', limit: a('300') }, t0));
    const due = asked.pending!.effectiveAt.getTime();
    expect(await age(key.owner.toUpperCase().replace('0X', '0x'), LOOSENING_WAIT_MS)).toEqual({
      pendingEffectiveAt: new Date(due - LOOSENING_WAIT_MS).toISOString(),
    });
    const aged = (await store.get(key))!;
    expect(aged.active).toEqual({ mode: 'blocking', limit: a('100') });
    expect(inForce(aged, new Date()).active).toEqual({ mode: 'blocking', limit: a('300') });
  });

  it('refuses half-set terms and a limit of zero', async () => {
    const insert = (mode: string | null, limit: string | null) => db!.sql`
      INSERT INTO trade.user_venue_daily_loss_limits (user_id, venue_id, owner, asset, mode, limit_amount, created_at, updated_at)
      VALUES (${'11111111-1111-4111-8111-1111111111d3'}, 'v', ${KEY.owner}, 'USDC', ${mode}, ${limit}, now(), now())`;
    await expect(insert('blocking', null)).rejects.toThrow(/user_venue_daily_loss_limits_terms_ck/);
    await expect(insert('advisory', '0')).rejects.toThrow(/user_venue_daily_loss_limits_limit_ck/);
    await expect(insert('hard', '5')).rejects.toThrow(/user_venue_daily_loss_limits_mode_ck/);
  });
});
