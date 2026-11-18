import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { sqlVenueAdlAcks, type VenueAdlAcks } from './venue-adl-acks.js';

/**
 * A person's acknowledged version of a venue's auto-deleveraging rules on Postgres (J-derivatives-07 #5,
 * drizzle/20261118030000_venue_adl_acks.sql): one row per person and venue, the latest version read replacing the one
 * before, kept apart per venue and per person.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The venue ADL acknowledgement Postgres test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const A = '11111111-1111-4111-8111-1111111111a7';
const B = '22222222-2222-4222-8222-2222222222b7';
const T0 = new Date('2026-11-18T06:00:00.000Z');

describe('sqlVenueAdlAcks (Postgres)', () => {
  let db: TestDatabase | undefined;
  let acks: VenueAdlAcks;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
    acks = sqlVenueAdlAcks(db.sql);
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);
  beforeEach(async () => {
    await db!.sql`TRUNCATE trade.venue_adl_acks`;
  });

  it('stores the version read, and a later version replaces it, per person and venue', async () => {
    expect(await acks.get(A, 'test-venue-sim')).toBeNull();
    expect(await acks.record(A, 'test-venue-sim', 'TEST-adl-1', T0)).toEqual({ version: 'TEST-adl-1', acknowledgedAt: T0 });
    const later = new Date(T0.getTime() + 60_000);
    await acks.record(A, 'test-venue-sim', 'TEST-adl-2', later);
    expect(await acks.get(A, 'test-venue-sim')).toEqual({ version: 'TEST-adl-2', acknowledgedAt: later });
    // Another venue and another person are their own rows.
    expect(await acks.get(A, 'test-venue-b')).toBeNull();
    expect(await acks.get(B, 'test-venue-sim')).toBeNull();
    const rows = await db!.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM trade.venue_adl_acks`;
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('refuses an empty version', async () => {
    await expect(acks.record(A, 'test-venue-sim', '', T0)).rejects.toThrow(/venue_adl_acks_version_ck/);
  });
});
