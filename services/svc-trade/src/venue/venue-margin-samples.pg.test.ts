/**
 * The venue's margin readings kept for a founder's ratio history (J-derivatives-26 #8), on real PostgreSQL: a reading is
 * kept with the venue's as-of time, an equal reading is not kept again, a changed one is, and the history reads newest
 * first, per account. Every figure is TEST.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { AsOf, UserVenueAccount, UserVenueAccountSummary } from '@intafaced/venue-contracts';
import { VenueMarginSamples } from './venue-margin-samples.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is required (runs/test-db.env). This suite does not start Docker.');
  const url = new URL(raw);
  if (url.pathname === '/test') url.pathname = '/intafaced_test';
  return url.toString();
}

const a = parseAmount;
const ME: UserVenueAccount = { venueId: 'test-venue', owner: `0x${'a'.repeat(40)}`, subAccount: null };
const OTHER: UserVenueAccount = { venueId: 'test-venue', owner: `0x${'b'.repeat(40)}`, subAccount: null };

const reading = (
  at: string,
  equity: string,
  ratio: string | null,
  state: 'healthy' | 'margin_call' | null,
): AsOf<UserVenueAccountSummary> => ({
  venueId: 'test-venue',
  asOf: new Date(at),
  value: {
    asset: 'USDC',
    equity: a(equity),
    free: a('0'),
    usedMargin: a('250'),
    maintenanceMargin: a('125'),
    marginRatio: { known: true, value: a('0.5') },
    cross:
      state === null
        ? null
        : {
            state,
            equity: a(equity),
            maintenanceMargin: a('125'),
            marginRatio: ratio === null ? { known: false } : { known: true, value: a(ratio) },
            liquidationEquity: a('62.5'),
            rule: 'TEST rule',
          },
  },
});

describe('VenueMarginSamples (J-derivatives-26 #8, real PostgreSQL)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: testDatabaseUrl(), migrations });
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('keeps each changed reading at the venue’s time, not an equal one, and reads them newest first per account', async () => {
    const samples = new VenueMarginSamples(db.sql);
    await samples.record(ME, reading('2026-11-23T06:00:00.000Z', '297.75', '0.419815', 'healthy'));
    await samples.record(ME, reading('2026-11-23T06:00:05.000Z', '297.75', '0.419815', 'healthy'));
    await samples.record(ME, reading('2026-11-23T06:00:10.000Z', '122.75', '1.01833', 'margin_call'));
    // The same as-of time again keeps nothing more.
    await samples.record(ME, reading('2026-11-23T06:00:10.000Z', '120', '1.04', 'margin_call'));
    await samples.record(OTHER, reading('2026-11-23T06:00:00.000Z', '300', null, null));

    const mine = await samples.history(ME);
    expect(mine.map((s) => [s.asOf.toISOString(), s.crossState, s.marginRatio])).toEqual([
      ['2026-11-23T06:00:10.000Z', 'margin_call', { known: true, value: a('1.01833') }],
      ['2026-11-23T06:00:00.000Z', 'healthy', { known: true, value: a('0.419815') }],
    ]);
    expect(mine[0]!.equity).toBe(a('122.75'));
    // Without a cross position the account's own summary is kept, with no cross state.
    expect(await samples.history(OTHER)).toEqual([
      expect.objectContaining({
        crossState: null,
        equity: a('300'),
        maintenanceMargin: a('125'),
        marginRatio: { known: true, value: a('0.5') },
      }),
    ]);
  });
});
