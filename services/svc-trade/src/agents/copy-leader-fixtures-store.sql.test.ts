/**
 * A projected refresh must not wipe operator-published money figures.
 *
 * Postgres is the already-running TEST_DATABASE_URL. This file does not start
 * a server, and it does not run against the shared intafaced_test database.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COPY_LEADER_FIXTURES_MIRRORED_SOURCE } from './copy-leader-fixtures-project.js';
import { createCopyLeaderFixturesStore } from './copy-leader-fixtures-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');

const MIGRATIONS = ['0021_copy_mirrored_fills.sql', '0030_copy_leader_fixtures.sql'] as const;

const PUBLISHED_PNL = '12.50';
const REPUBLISHED_PNL = '-3.25';

function requireTestDatabaseUrl(): string {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!envUrl) {
    throw new Error('copy-leader fixture refresh is PG-hard (no skip). TEST_DATABASE_URL is unset; this suite does not start Postgres.');
  }
  return envUrl;
}

describe('copy leader fixture refresh keeps published PnL', () => {
  let db: TestDatabase | undefined;

  beforeAll(async () => {
    const url = requireTestDatabaseUrl();
    const migrations = MIGRATIONS.map((name) => readFileSync(join(drizzle, name), 'utf8'));
    db = await createTestDatabase({ service: 'trade', url, migrations });
    const [located] = await db.sql<{ d: string }[]>`SELECT current_database() AS d`;
    if (located?.d !== db.database) {
      throw new Error(`copy-leader fixture refresh is connected to ${located?.d ?? 'unknown'}, not the isolated database ${db.database}`);
    }
    if (located.d === 'intafaced_test') {
      throw new Error('copy-leader fixture refresh must not run against the shared intafaced_test database');
    }
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('keeps an operator-published realised PnL and winning-trade count across a projected refresh', async () => {
    const sql = db!.sql;
    const store = createCopyLeaderFixturesStore(sql);

    await store.publishFixture({
      leaderId: 'leader-kept',
      realisedPnl: PUBLISHED_PNL,
      closedTrades: 4,
      winningTrades: 3,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2026-01-31T23:59:59.000Z',
      source: 'trade.copy',
    });

    const published = (await store.listFixtures()).find((row) => row.leaderId === 'leader-kept');
    expect(published?.realisedPnl).toBe(PUBLISHED_PNL);
    expect(typeof published?.realisedPnl).toBe('string');
    expect(published?.winningTrades).toBe(3);

    await sql`
      INSERT INTO trade.copy_mirrored_fills (
        follow_id, fill_id, follower_id, leader_id, market_id, side, qty, notional, next_exposure
      ) VALUES
        ('follow-kept', 'fill-kept', 'follower-1', 'leader-kept', 'BTC-USDT', 'buy', 1, 1, 1),
        ('follow-fresh', 'fill-fresh', 'follower-1', 'leader-fresh', 'BTC-USDT', 'buy', 1, 1, 1)
    `;

    const materialized = await store.materializeProjectedFixtures();
    expect(materialized).toBe(2);

    const after = await store.listFixtures();
    const kept = after.find((row) => row.leaderId === 'leader-kept');
    expect(kept?.realisedPnl).toBe(PUBLISHED_PNL);
    expect(typeof kept?.realisedPnl).toBe('string');
    expect(kept?.winningTrades).toBe(3);
    expect(kept?.closedTrades).toBe(1);
    expect(kept?.source).toBe(COPY_LEADER_FIXTURES_MIRRORED_SOURCE);

    const fresh = after.find((row) => row.leaderId === 'leader-fresh');
    expect(fresh?.realisedPnl).toBeNull();
    expect(fresh?.winningTrades).toBeNull();
    expect(fresh?.closedTrades).toBe(1);

    await store.publishFixture({
      leaderId: 'leader-kept',
      realisedPnl: REPUBLISHED_PNL,
      closedTrades: 8,
      winningTrades: 5,
      windowStart: '2026-02-01T00:00:00.000Z',
      windowEnd: '2026-02-28T23:59:59.000Z',
      source: 'trade.copy',
    });

    const republished = (await store.listFixtures()).find((row) => row.leaderId === 'leader-kept');
    expect(republished?.realisedPnl).toBe(REPUBLISHED_PNL);
    expect(typeof republished?.realisedPnl).toBe('string');
    expect(republished?.winningTrades).toBe(5);
  });
});
