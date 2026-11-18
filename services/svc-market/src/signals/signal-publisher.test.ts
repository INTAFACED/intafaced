import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommerceService } from '../commerce/commerce-service.js';
import { MARKET_OPS_SCOPE, VendorService } from '../vendor-service.js';
import type { SlotEntitlementSource, VendorEntitlement } from '../stake-source.js';
import { SignalPublisher, providerCriteriaFromEnv, type PublishInput, type TrackRecordSource } from './signal-publisher.js';

/**
 * Signal publishing against a real Postgres (CB-bots-api-signal-05/06/07, J-copy-bots-otc-22): the one vetting, the
 * publish key, the fee models, archive and the per-asset earnings read from real Market purchases. PG-hard, no skip.
 */
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const BUYER_B = '44444444-4444-4444-8444-444444444444';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CRITERIA = { minTier: 'full', minFills: 1 } as const;
const MONTH = 30 * 86_400;

class FixedEntitlement implements SlotEntitlementSource {
  async entitlementOf(): Promise<VendorEntitlement> {
    return { tierName: 'Operator', vendorSlots: 10 };
  }
}

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_h8a_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

/** A track record source that answers `fills` and counts how often it was read. */
function record(fills: number): TrackRecordSource & { reads: number } {
  const source = {
    reads: 0,
    async recordOf() {
      source.reads += 1;
      return { fills, firstFillAt: fills > 0 ? '2026-11-01T00:00:00.000Z' : null };
    },
  };
  return source;
}

describe('SignalPublisher', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let vendors: VendorService;
  let ledger: MemoryLedger;
  let commerce: CommerceService;

  const publisher = (opts: { criteria?: typeof CRITERIA | null; track?: TrackRecordSource | null } = {}) =>
    new SignalPublisher({
      sql,
      commerce,
      myVendor: (userId) => vendors.myVendor(userId),
      criteria: opts.criteria === undefined ? CRITERIA : opts.criteria,
      trackRecord: opts.track === undefined ? record(3) : opts.track,
    });

  const free = (over: Partial<PublishInput> = {}): PublishInput => ({
    userId: PROVIDER,
    tier: 'full',
    publishKey: `free-${randomUUID()}`,
    title: 'TEST free signal',
    description: 'TEST signal',
    assetId: 'USDT',
    feeModel: 'free',
    ...over,
  });

  async function approvedProvider() {
    const vendor = await vendors.applyAsVendor({ userId: PROVIDER, displayName: 'TEST provider', description: 'signals' });
    await vendors.vet({ vendorId: vendor.id, decision: 'approved', reason: 'TEST', actorId: OPERATOR, actorScope: MARKET_OPS_SCOPE });
    return vendor.id;
  }

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'market', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE market.signals, market.signal_vettings, market.reviews, market.listing_takedowns, market.subscription_state,
               market.purchases, market.listings, market.vendor_slots, market.vendor_status_events, market.vendors
      RESTART IDENTITY CASCADE`;
    vendors = new VendorService(sql, new FixedEntitlement());
    ledger = new MemoryLedger();
    commerce = new CommerceService(sql, vendors, ledger, { commissionBps: 100 });
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('refuses every publish while the provider criteria are blank, and writes nothing', async () => {
    await approvedProvider();
    expect(providerCriteriaFromEnv({ MARKET_SIGNAL_PROVIDER_MIN_TIER: 'full' })).toBeNull();
    expect(providerCriteriaFromEnv({ MARKET_SIGNAL_PROVIDER_MIN_FILLS: 1 })).toBeNull();
    await expect(publisher({ criteria: null }).publish(free())).rejects.toMatchObject({ code: 'market.provider_criteria_not_set' });
    expect((await sql`SELECT count(*)::int AS n FROM market.signals`)[0]!.n).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM market.signal_vettings`)[0]!.n).toBe(0);
  });

  it('vets a provider who meets the criteria once, and publishes', async () => {
    await approvedProvider();
    const track = record(3);
    const p = publisher({ track });
    const first = await p.publish(free());
    expect(first.signal.state).toBe('published');
    expect(first.vetting).toMatchObject({ minTier: 'full', minFills: 1, tierSeen: 'full', fillsSeen: 3 });
    const second = await p.publish(free({ title: 'TEST second free signal' }));
    // The second publish reuses the recorded pass: the record is not read again, and there is one vetting row.
    expect(second.vetting.passedAt).toBe(first.vetting.passedAt);
    expect(track.reads).toBe(1);
    expect((await sql`SELECT count(*)::int AS n FROM market.signal_vettings`)[0]!.n).toBe(1);
  });

  it('refuses a provider below the tier or without fills, and an unreadable record, recording no pass', async () => {
    await approvedProvider();
    await expect(publisher().publish(free({ tier: 'basic' }))).rejects.toMatchObject({ code: 'market.provider_criteria_not_met' });
    await expect(publisher({ track: record(0) }).publish(free())).rejects.toMatchObject({
      code: 'market.provider_criteria_not_met',
      detail: { fillsSeen: 0, minFills: 1 },
    });
    await expect(publisher({ track: null }).publish(free())).rejects.toMatchObject({ code: 'market.provider_record_unavailable' });
    const down: TrackRecordSource = { recordOf: () => Promise.reject(new Error('down')) };
    await expect(publisher({ track: down }).publish(free())).rejects.toThrow('down');
    expect((await sql`SELECT count(*)::int AS n FROM market.signal_vettings`)[0]!.n).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM market.signals WHERE status = 'published'`)[0]!.n).toBe(0);
  });

  it('refuses an unapproved seller', async () => {
    await vendors.applyAsVendor({ userId: PROVIDER, displayName: 'TEST provider', description: 'signals' });
    await expect(publisher().publish(free())).rejects.toMatchObject({ code: 'market.vendor_not_approved' });
  });

  it('lists a free signal once: a retried publish key answers the first', async () => {
    await approvedProvider();
    const p = publisher();
    const input = free({ publishKey: 'signal-publish:TEST-1' });
    const first = await p.publish(input);
    const again = await p.publish(input);
    expect(again.replayed).toBe(true);
    expect(again.signal.id).toBe(first.signal.id);
    const listed = await p.catalogue(50);
    expect(listed.filter((s) => s.title === input.title)).toHaveLength(1);
    expect(first.signal).toMatchObject({ feeModel: 'free', price: null, listingId: null });
  });

  it('refuses a monthly fee with a blank price, a profit share and a recurring subscription, by name', async () => {
    await approvedProvider();
    const p = publisher();
    await expect(p.publish(free({ feeModel: 'monthly', price: '  ', periodSeconds: MONTH }))).rejects.toMatchObject({
      code: 'market.price_not_set',
    });
    await expect(p.publish(free({ feeModel: 'monthly', price: null, periodSeconds: MONTH }))).rejects.toMatchObject({
      code: 'market.price_not_set',
    });
    await expect(p.publish(free({ feeModel: 'profit_share' }))).rejects.toMatchObject({ code: 'market.strategy_profit_share_forbidden' });
    await expect(p.publish(free({ profitShareBps: 1000 }))).rejects.toMatchObject({ code: 'market.strategy_profit_share_forbidden' });
    await expect(p.publish(free({ feeModel: 'recurring' }))).rejects.toMatchObject({ code: 'market.subscription_recurring_not_built' });
    await expect(p.publish(free({ feeModel: 'monthly', price: '10', periodSeconds: null }))).rejects.toMatchObject({
      code: 'market.subscription_period_unset',
    });
    expect((await sql`SELECT count(*)::int AS n FROM market.signals`)[0]!.n).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM market.listings`)[0]!.n).toBe(0);
  });

  it('publishes a monthly fee signal through one subscription listing, also after a stop between the two writes', async () => {
    await approvedProvider();
    const p = publisher();
    const input = free({ feeModel: 'monthly', price: '10', periodSeconds: MONTH, publishKey: 'signal-publish:TEST-m' });
    const made = await p.publish(input);
    expect(made.signal).toMatchObject({ feeModel: 'monthly', price: '10', periodSeconds: MONTH });
    const [listing] = await sql<Array<{ offer_type: string; price: string; status: string }>>`
      SELECT offer_type, price::text AS price, status FROM market.listings WHERE id = ${made.signal.listingId}`;
    expect(listing).toMatchObject({ offer_type: 'subscription', status: 'active' });
    expect(parseAmount(listing!.price)).toBe(parseAmount('10'));

    // A stop after the listing was made and before the signal recorded it: the retry finds that listing again.
    await sql`UPDATE market.signals SET status = 'pending', listing_id = NULL WHERE id = ${made.signal.id}`;
    const retried = await p.publish(input);
    expect(retried.signal.listingId).toBe(made.signal.listingId);
    expect((await sql`SELECT count(*)::int AS n FROM market.listings`)[0]!.n).toBe(1);
  });

  it('archives: the signal and its listing withdraw, a buyer keeps their period, a second archive answers the first', async () => {
    await approvedProvider();
    const p = publisher();
    const made = await p.publish(free({ feeModel: 'monthly', price: '10', periodSeconds: MONTH }));
    await ledger.post(recipes.deposit({ userId: BUYER, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: 'buyer-1' }));
    await commerce.purchase({ buyerId: BUYER, listingId: made.signal.listingId!, purchaseId: randomUUID() });
    const before = await commerce.subscriptionAccess({ buyerId: BUYER, listingId: made.signal.listingId! });

    const archived = await p.archive({ userId: PROVIDER, signalId: made.signal.id });
    expect(archived.state).toBe('archived');
    expect((await p.catalogue(50)).map((s) => s.id)).not.toContain(made.signal.id);
    const [listing] = await sql<Array<{ status: string }>>`SELECT status FROM market.listings WHERE id = ${made.signal.listingId}`;
    expect(listing!.status).toBe('archived');
    const after = await commerce.subscriptionAccess({ buyerId: BUYER, listingId: made.signal.listingId! });
    expect(after.accessUntil).toBe(before.accessUntil);
    expect((await p.archive({ userId: PROVIDER, signalId: made.signal.id })).archivedAt).toBe(archived.archivedAt);
    await expect(p.archive({ userId: BUYER, signalId: made.signal.id })).rejects.toMatchObject({ code: 'market.signal_not_found' });
  });

  it('earnings: sales of 10 and 5 are gross 15, net gross less each sale’s commission, per asset, settled at sale', async () => {
    await approvedProvider();
    const p = publisher();
    const ten = await p.publish(free({ feeModel: 'monthly', price: '10', periodSeconds: MONTH, title: 'TEST ten' }));
    const five = await p.publish(free({ feeModel: 'monthly', price: '5', periodSeconds: MONTH, title: 'TEST five' }));
    // A sale of a Market listing that is not a signal is not a signal earning.
    const other = await commerce.createListing({
      userId: PROVIDER,
      title: 'TEST other',
      description: 'not a signal',
      offerType: 'one_time',
      assetId: 'USDT',
      price: '7',
    });
    for (const [buyer, ref] of [
      [BUYER, 'b1'],
      [BUYER_B, 'b2'],
    ] as const) {
      await ledger.post(recipes.deposit({ userId: buyer, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: ref }));
    }
    await commerce.purchase({ buyerId: BUYER, listingId: ten.signal.listingId!, purchaseId: randomUUID() });
    await commerce.purchase({ buyerId: BUYER_B, listingId: five.signal.listingId!, purchaseId: randomUUID() });
    await commerce.purchase({ buyerId: BUYER, listingId: other.id, purchaseId: randomUUID() });

    const report = await p.earnings({ userId: PROVIDER, from: '2020-01-01T00:00:00.000Z', to: '2099-01-01T00:00:00.000Z' });
    expect(report.settlement).toBe('at_sale');
    expect(report.profitShare).toBeNull();
    expect(report.assets).toEqual([{ assetId: 'USDT', gross: '15', commission: '0.15', net: '14.85', sales: 2 }]);
  });
});
