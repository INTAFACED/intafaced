import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import { TEST_VENUE_MARKETS, TestVenueSimulator, seedTestVenue } from '@intafaced/venue-sim';
import { LOCAL_TEST_SEED_APPROVER, LOCAL_TEST_SEED_OPERATOR, seedTestListings } from './venue-listing.js';
import { SqlVenueListingStore, delistingNoticeKey, type VenueLimitVersion, type VenueListingVersion } from './venue-listing-store.js';

/**
 * Our venue listings on Postgres (J-cex-spot-16, drizzle/20261109140659_venue_listings.sql): a version lands only on top
 * of the one before it, an approval writes one version, a delisting's notice is written with its version or not at all,
 * versions are append-only, and the database refuses a limit above the venue's or one person approving their own.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The venue listing Postgres test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const a = parseAmount;
const T0 = new Date('2026-11-09T12:00:00.000Z');
const listing = (over: Partial<VenueListingVersion> = {}): VenueListingVersion => ({
  venueId: 'test-venue-sim',
  symbol: 'ETH-USDC',
  version: 1,
  change: 'listing',
  opensAt: T0,
  delistsAt: null,
  routing: 'show',
  approvalId: 'approval-1',
  proposerId: 'op-a',
  approverId: 'op-b',
  executorId: 'op-a',
  reason: 'TEST listing',
  recordedAt: T0,
  ...over,
});
const limits = (over: Partial<VenueLimitVersion> = {}): VenueLimitVersion => ({
  venueId: 'test-venue-sim',
  symbol: 'ETH-USDC',
  version: 1,
  maxOrderQty: a('5.5'),
  maxOrderNotional: a('15000.000000000000000001'),
  venueMaxOrderQty: a('500'),
  venueMaxOrderNotional: a('2000000'),
  approvalId: 'limits-1',
  proposerId: 'op-a',
  approverId: 'op-b',
  executorId: 'op-a',
  reason: 'TEST limits',
  recordedAt: T0,
  ...over,
});

describe('SqlVenueListingStore (Postgres)', () => {
  let db: TestDatabase | undefined;
  let store: SqlVenueListingStore;

  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
    store = new SqlVenueListingStore(db.sql);
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);
  beforeEach(async () => {
    await db!.sql`TRUNCATE trade.venue_delisting_notices, trade.venue_routed_limits, trade.venue_listings`;
  });

  it('writes a version only on top of the one before it; an approval writes once', async () => {
    expect(await store.appendListing(listing({ version: 2, approvalId: 'skip' }))).toBe('stale');
    expect(await store.appendListing(listing())).toBe('written');
    expect(await store.appendListing(listing())).toBe('replayed');
    expect(await store.appendListing(listing({ approvalId: 'approval-2' }))).toBe('stale');
    expect(await store.appendListing(listing({ version: 2, change: 'routing', routing: 'stop', approvalId: 'approval-2' }))).toBe(
      'written',
    );
    expect((await store.latestListing('test-venue-sim', 'ETH-USDC'))?.routing).toBe('stop');
    expect((await store.listingVersions('test-venue-sim')).map((r) => [r.version, r.routing])).toEqual([
      [1, 'show'],
      [2, 'stop'],
    ]);
    expect((await store.listingByApproval('approval-1'))?.opensAt).toEqual(T0);
  });

  it('two writes racing for one version: exactly one lands', async () => {
    await store.appendListing(listing());
    const outcomes = await Promise.all(
      ['r1', 'r2', 'r3'].map((id) => store.appendListing(listing({ version: 2, change: 'routing', routing: 'stop', approvalId: id }))),
    );
    expect(outcomes.filter((o) => o === 'written')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'stale')).toHaveLength(2);
  });

  it('a delisting writes its notice with its version; the notice is published once', async () => {
    await store.appendListing(listing());
    const delistsAt = new Date('2026-12-01T00:00:00.000Z');
    const noticeKey = delistingNoticeKey('test-venue-sim', 'ETH-USDC', delistsAt);
    const row = listing({ version: 2, change: 'delisting', delistsAt, approvalId: 'delist-1' });
    const notice = { noticeKey, approvalId: 'delist-1', venueId: 'test-venue-sim', symbol: 'ETH-USDC', delistsAt, scheduledAt: T0 };
    expect(await store.appendListing(row, notice)).toBe('written');
    expect((await store.pendingNotices(10)).map((n) => n.noticeKey)).toEqual([noticeKey]);
    await store.markNoticePublished(noticeKey, T0);
    await store.markNoticePublished(noticeKey, new Date('2026-11-10T00:00:00.000Z'));
    expect(await store.noticeByApproval('delist-1')).toMatchObject({ publishedAt: T0 });
    expect(await store.pendingNotices(10)).toEqual([]);
    // A second notice under the same key: nothing at all is written, the version included.
    expect(
      await store.appendListing(listing({ version: 3, change: 'delisting', delistsAt, approvalId: 'delist-2' }), {
        ...notice,
        approvalId: 'delist-2',
      }),
    ).toBe('stale');
    expect(await store.listingByApproval('delist-2')).toBeNull();
  });

  it('keeps exact decimals, and refuses a limit above the venue, one person approving their own, and any edit of a version', async () => {
    expect(await store.appendLimits(limits())).toBe('written');
    expect(await store.latestLimits('test-venue-sim', 'ETH-USDC')).toMatchObject({
      maxOrderQty: a('5.5'),
      maxOrderNotional: a('15000.000000000000000001'),
      venueMaxOrderQty: a('500'),
    });
    expect(await store.appendLimits(limits())).toBe('replayed');
    await expect(store.appendLimits(limits({ version: 2, approvalId: 'limits-2', maxOrderQty: a('501') }))).rejects.toThrow(
      /not_above_venue/,
    );
    await expect(store.appendLimits(limits({ version: 2, approvalId: 'limits-3', approverId: 'op-a' }))).rejects.toThrow(/two_people/);
    await expect(store.appendListing(listing({ approverId: 'op-a' }))).rejects.toThrow(/two_people/);
    // No approval id is exempt, the stack seed's included.
    await expect(
      store.appendListing(listing({ approvalId: 'test-stack-listing:test-venue-sim:ETH-USDC', approverId: 'op-a' })),
    ).rejects.toThrow(/two_people/);
    await store.appendListing(listing());
    await expect(db!.sql`UPDATE trade.venue_listings SET routing = 'stop'`).rejects.toThrow(/never changed/);
    await expect(db!.sql`DELETE FROM trade.venue_routed_limits`).rejects.toThrow(/never changed/);
  });

  it('reads the latest row per symbol, and every notice of a venue, each in one query', async () => {
    await store.appendListing(listing());
    await store.appendListing(listing({ version: 2, approvalId: 'approval-2', change: 'routing', routing: 'stop' }));
    await store.appendListing(listing({ symbol: 'BTC-USDC', approvalId: 'approval-3' }));
    await store.appendListing(listing({ venueId: 'other-venue', approvalId: 'approval-4', routing: 'close_only' }));
    await store.appendLimits(limits());
    await store.appendLimits(limits({ version: 2, approvalId: 'limits-2', maxOrderQty: a('7') }));
    const delistsAt = new Date('2026-12-01T00:00:00.000Z');
    const noticeKey = delistingNoticeKey('test-venue-sim', 'BTC-USDC', delistsAt);
    await store.appendListing(listing({ symbol: 'BTC-USDC', version: 2, approvalId: 'approval-5', change: 'delisting', delistsAt }), {
      noticeKey,
      approvalId: 'approval-5',
      venueId: 'test-venue-sim',
      symbol: 'BTC-USDC',
      delistsAt,
      scheduledAt: T0,
    });
    expect((await store.latestListings('test-venue-sim')).map((r) => [r.symbol, r.version, r.routing])).toEqual([
      ['BTC-USDC', 2, 'show'],
      ['ETH-USDC', 2, 'stop'],
    ]);
    expect((await store.latestLimitsBySymbol('test-venue-sim')).map((r) => [r.symbol, r.version, r.maxOrderQty])).toEqual([
      ['ETH-USDC', 2, a('7')],
    ]);
    expect((await store.noticesForVenue('test-venue-sim')).map((n) => n.noticeKey)).toEqual([noticeKey]);
    expect(await store.noticesForVenue('other-venue')).toEqual([]);
  });

  it('the LOCAL TEST stack seed lands under the two-person CHECK, as two distinct stack ids, once', async () => {
    const sim = new TestVenueSimulator({ clock: () => T0, markets: TEST_VENUE_MARKETS, chainId: 84532 });
    await seedTestVenue(sim);
    expect(await seedTestListings(store, sim, ['BTC-USDC'], 'test', T0)).toEqual(['BTC-USDC']);
    expect(await seedTestListings(store, sim, ['BTC-USDC'], 'test', T0)).toEqual([]);
    expect(await store.latestListing('test-venue-sim', 'BTC-USDC')).toMatchObject({
      version: 1,
      proposerId: LOCAL_TEST_SEED_OPERATOR,
      approverId: LOCAL_TEST_SEED_APPROVER,
    });
  });
});
