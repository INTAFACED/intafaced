import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPostgres } from '@intafaced/db/test-postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MARKET_OPS_SCOPE, VendorService } from './vendor-service.js';
import { FixedEntitlement, type SlotEntitlementSource } from './stake-source.js';

/**
 * STAKE-GATED LISTING SLOTS AGAINST A REAL POSTGRES (§8.7, `market.vendors`
 * Stage 2 DoD clause 2: "slot capacity cannot be oversold under concurrency").
 *
 * Postgres is REAL here and it has to be. The whole guarantee is a `SELECT …
 * FOR UPDATE` interacting with a `COUNT`, and there is no way to fake a lock
 * that would tell you anything: an in-memory double serialises by accident,
 * because JavaScript has one thread. A test that passes without a database is a
 * test of nothing on this particular claim.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `market.*` SQL stays on `market`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 *
 * `createTestDatabase` isolates by DATABASE, so `market.vendors` keeps its real
 * schema name — svc-market's SQL is schema-qualified (§2) and could not run
 * inside a generated `test_market_*` schema.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Every forward migration, in order — read from disk so a new one is exercised the moment it lands. */
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const VENDOR_USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '33333333-3333-4333-8333-333333333333';

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await testPostgres(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: market vendor-slots is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-market vendor slots PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-market vendor slots', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  /** A vendor sitting in `approved`, the only status that may hold a slot. */
  async function approvedVendor(userId: string, service: VendorService): Promise<string> {
    const vendor = await service.applyAsVendor({ userId, displayName: 'Acme', description: 'I sell things' });
    await service.vet({
      vendorId: vendor.id,
      decision: 'approved',
      reason: 'documents check out',
      actorId: OPERATOR,
      actorScope: MARKET_OPS_SCOPE,
    });
    return vendor.id;
  }

  /** A service whose stake gate reports exactly `slots` for everybody. */
  const withCapacity = (slots: number, tierName = 'Operator') => new VendorService(sql, new FixedEntitlement(slots, tierName));

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'market', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`TRUNCATE market.vendor_slots, market.vendor_status_events, market.vendors RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('slot claim — capacity comes from the stake tier', () => {
    it('lets an approved vendor claim up to their tier and no further', async () => {
      const service = withCapacity(3);
      await approvedVendor(VENDOR_USER, service);

      for (const ref of ['listing-1', 'listing-2', 'listing-3']) {
        await expect(service.claimSlot({ userId: VENDOR_USER, ref })).resolves.toMatchObject({ claimed: true });
      }

      await expect(service.claimSlot({ userId: VENDOR_USER, ref: 'listing-4' })).rejects.toMatchObject({
        code: 'market.slots_exhausted',
      });
    });

    /**
     * Base tier. `vendorSlots: 0` is a real tier value, not a missing one, and it
     * must refuse with the STAKE code — the accessible one — rather than "full".
     */
    it('refuses a vendor whose tier entitles them to nothing, and says stake', async () => {
      const service = withCapacity(0, 'Base');
      await approvedVendor(VENDOR_USER, service);
      await expect(service.claimSlot({ userId: VENDOR_USER, ref: 'listing-1' })).rejects.toMatchObject({
        code: 'market.stake_required',
      });
      expect(await service.openSlotCount((await service.myVendor(VENDOR_USER))!.id)).toBe(0);
    });

    it('refuses a vendor who was never approved, whatever they stake', async () => {
      const service = withCapacity(50, 'Sovereign');
      await service.applyAsVendor({ userId: VENDOR_USER, displayName: 'Acme', description: 'pending' });
      await expect(service.claimSlot({ userId: VENDOR_USER, ref: 'listing-1' })).rejects.toMatchObject({
        code: 'market.vendor_not_approved',
      });
    });

    it('refuses somebody who never applied', async () => {
      await expect(withCapacity(3).claimSlot({ userId: OTHER_USER, ref: 'listing-1' })).rejects.toMatchObject({
        code: 'market.vendor_not_found',
      });
    });

    /**
     * One vendor's slots are their own. Two vendors at the same tier must each
     * get their full capacity — a count that forgot its `WHERE vendor_id` would
     * pass every test above and fail this one.
     */
    it('counts each vendor separately', async () => {
      const service = withCapacity(1);
      await approvedVendor(VENDOR_USER, service);
      await approvedVendor(OTHER_USER, service);

      await expect(service.claimSlot({ userId: VENDOR_USER, ref: 'a' })).resolves.toMatchObject({ claimed: true });
      await expect(service.claimSlot({ userId: OTHER_USER, ref: 'a' })).resolves.toMatchObject({ claimed: true });
      await expect(service.claimSlot({ userId: OTHER_USER, ref: 'b' })).rejects.toMatchObject({ code: 'market.slots_exhausted' });
    });

    it('refuses a claim when owner slot magnitudes are unset rather than inventing a count', async () => {
      const unset: SlotEntitlementSource = {
        entitlementOf: async () => ({ tierName: 'Operator', vendorSlots: Number.NaN }),
      };
      const service = new VendorService(sql, unset);
      await approvedVendor(VENDOR_USER, withCapacity(3));

      await expect(service.claimSlot({ userId: VENDOR_USER, ref: 'listing-1' })).rejects.toMatchObject({
        code: 'market.stake_unavailable',
      });
      expect(await service.openSlotCount((await service.myVendor(VENDOR_USER))!.id)).toBe(0);
    });

    it('fails closed when the stake gate cannot be read', async () => {
      const dead: SlotEntitlementSource = {
        entitlementOf: async () => {
          const { MarketError } = await import('./vendor-service.js');
          throw new MarketError('Stake gate unavailable', 'market.stake_unavailable');
        },
      };
      const service = new VendorService(sql, dead);
      await approvedVendor(VENDOR_USER, withCapacity(3));

      await expect(service.claimSlot({ userId: VENDOR_USER, ref: 'listing-1' })).rejects.toMatchObject({
        code: 'market.stake_unavailable',
      });
      // Nothing was written. A gate that refuses after the insert is not a gate.
      expect(await service.openSlotCount((await service.myVendor(VENDOR_USER))!.id)).toBe(0);
    });
  });

  describe('THE OVERSELL PROOF — concurrent claims cannot exceed the tier', () => {
    /**
     * THE TEST THIS WHOLE STAGE EXISTS FOR.
     *
     * Eight claims fired at once against a tier entitled to three. Every one is a
     * distinct `ref`, so idempotency cannot mask the race — these are eight
     * genuinely different slots competing for three places.
     *
     * Without `FOR UPDATE` on the vendor row, all eight would read `open = 0`,
     * all eight would pass `decideVendorSlot`, and all eight would insert.
     *
     * EIGHT because `createTestDatabase` opens a pool of exactly eight
     * (packages/db/src/testing.ts). Raising this number without raising the pool
     * would make the extra claims queue for a CONNECTION rather than for the
     * LOCK, and a claim that never overlapped another cannot demonstrate
     * anything. Note the failure direction: connection queueing would make this
     * test miss a missing lock, never invent a pass — the assertion below is on
     * the exact count, which a broken lock cannot satisfy however the calls
     * interleave.
     */
    it('admits exactly the tier capacity out of eight simultaneous claims', async () => {
      const service = withCapacity(3);
      const vendorId = await approvedVendor(VENDOR_USER, service);

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => service.claimSlot({ userId: VENDOR_USER, ref: `listing-${i}` })),
      );

      const claimed = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r) => r.status === 'rejected');

      expect(claimed).toHaveLength(3);
      expect(refused).toHaveLength(5);

      // Refused BY NAME. A rejection is not a pass on its own — a deadlock, a
      // serialisation failure or a crash would also arrive as `rejected`, and
      // counting those as "capacity held" is how a broken lock reads as green.
      for (const failure of refused) {
        expect((failure as PromiseRejectedResult).reason).toMatchObject({ code: 'market.slots_exhausted' });
      }

      // And the database agrees with the return values.
      expect(await service.openSlotCount(vendorId)).toBe(3);
    });

    it('holds at a capacity of one, where the race is tightest', async () => {
      const service = withCapacity(1);
      const vendorId = await approvedVendor(VENDOR_USER, service);

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => service.claimSlot({ userId: VENDOR_USER, ref: `listing-${i}` })),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const failure of results.filter((r) => r.status === 'rejected')) {
        expect((failure as PromiseRejectedResult).reason).toMatchObject({ code: 'market.slots_exhausted' });
      }
      expect(await service.openSlotCount(vendorId)).toBe(1);
    });

    /**
     * Overselling by the OTHER route: not a race between different listings, but
     * one listing retried. Six concurrent claims of the same `ref` against a
     * capacity of one must consume exactly one slot — and none of them may fail,
     * because a retry of a claim that succeeded is not an error.
     */
    it('a retried claim consumes one slot, not six', async () => {
      const service = withCapacity(1);
      const vendorId = await approvedVendor(VENDOR_USER, service);

      const results = await Promise.all(Array.from({ length: 6 }, () => service.claimSlot({ userId: VENDOR_USER, ref: 'listing-1' })));

      expect(results.filter((r) => r.claimed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.slot.id)).size).toBe(1);
      expect(await service.openSlotCount(vendorId)).toBe(1);
    });
  });

  describe('release', () => {
    it('frees capacity for the next claim', async () => {
      const service = withCapacity(1);
      await approvedVendor(VENDOR_USER, service);

      await service.claimSlot({ userId: VENDOR_USER, ref: 'listing-1' });
      await expect(service.claimSlot({ userId: VENDOR_USER, ref: 'listing-2' })).rejects.toMatchObject({
        code: 'market.slots_exhausted',
      });

      await expect(service.releaseSlot({ userId: VENDOR_USER, ref: 'listing-1' })).resolves.toEqual({ released: true });
      await expect(service.claimSlot({ userId: VENDOR_USER, ref: 'listing-2' })).resolves.toMatchObject({ claimed: true });
    });

    it('is idempotent, and a slot that was never held is an answer not a 404', async () => {
      const service = withCapacity(1);
      await approvedVendor(VENDOR_USER, service);
      await service.claimSlot({ userId: VENDOR_USER, ref: 'listing-1' });

      await expect(service.releaseSlot({ userId: VENDOR_USER, ref: 'listing-1' })).resolves.toEqual({ released: true });
      await expect(service.releaseSlot({ userId: VENDOR_USER, ref: 'listing-1' })).resolves.toEqual({ released: false });
      await expect(service.releaseSlot({ userId: VENDOR_USER, ref: 'never-existed' })).resolves.toEqual({ released: false });
    });

    it('lets a released ref be claimed again — re-listing is not a duplicate', async () => {
      const service = withCapacity(1);
      await approvedVendor(VENDOR_USER, service);
      await service.claimSlot({ userId: VENDOR_USER, ref: 'listing-1' });
      await service.releaseSlot({ userId: VENDOR_USER, ref: 'listing-1' });
      await expect(service.claimSlot({ userId: VENDOR_USER, ref: 'listing-1' })).resolves.toMatchObject({ claimed: true });
    });

    /**
     * DoD "release on unstake / offence / suspension" — the suspension half,
     * which svc-market records itself and therefore can act on.
     */
    it('releases every open slot when an operator suspends the vendor', async () => {
      const service = withCapacity(3);
      const vendorId = await approvedVendor(VENDOR_USER, service);
      for (const ref of ['a', 'b', 'c']) await service.claimSlot({ userId: VENDOR_USER, ref });
      expect(await service.openSlotCount(vendorId)).toBe(3);

      await service.vet({
        vendorId,
        decision: 'suspended',
        reason: 'offence recorded by ops',
        actorId: OPERATOR,
        actorScope: MARKET_OPS_SCOPE,
      });

      expect(await service.openSlotCount(vendorId)).toBe(0);
    });

    it('releases slots on rejection too, not only suspension', async () => {
      const service = withCapacity(3);
      const vendorId = await approvedVendor(VENDOR_USER, service);
      await service.claimSlot({ userId: VENDOR_USER, ref: 'a' });

      await service.vet({ vendorId, decision: 'rejected', reason: 'reversed on appeal', actorId: OPERATOR, actorScope: MARKET_OPS_SCOPE });
      expect(await service.openSlotCount(vendorId)).toBe(0);
    });

    it('does not release anything when an operator re-approves an approved vendor', async () => {
      const service = withCapacity(3);
      const vendorId = await approvedVendor(VENDOR_USER, service);
      await service.claimSlot({ userId: VENDOR_USER, ref: 'a' });

      // A no-op vet writes nothing at all — including no release.
      const result = await service.vet({
        vendorId,
        decision: 'approved',
        reason: 'clicked twice',
        actorId: OPERATOR,
        actorScope: MARKET_OPS_SCOPE,
      });
      expect(result.changed).toBe(false);
      expect(await service.openSlotCount(vendorId)).toBe(1);
    });

    it('reinstating a suspended vendor does not resurrect their old slots', async () => {
      const service = withCapacity(3);
      const vendorId = await approvedVendor(VENDOR_USER, service);
      await service.claimSlot({ userId: VENDOR_USER, ref: 'a' });
      await service.vet({ vendorId, decision: 'suspended', reason: 'held', actorId: OPERATOR, actorScope: MARKET_OPS_SCOPE });
      await service.vet({ vendorId, decision: 'approved', reason: 'cleared', actorId: OPERATOR, actorScope: MARKET_OPS_SCOPE });

      // The slot stays released. A vendor coming back re-claims what they want,
      // rather than silently reoccupying capacity nobody re-checked.
      expect(await service.openSlotCount(vendorId)).toBe(0);
      await expect(service.claimSlot({ userId: VENDOR_USER, ref: 'a' })).resolves.toMatchObject({ claimed: true });
    });
  });

  describe('slot status — DoD clause 5, cannot present as listed', () => {
    it('reports the tier, the capacity and the held slots', async () => {
      const service = withCapacity(3);
      await approvedVendor(VENDOR_USER, service);
      await service.claimSlot({ userId: VENDOR_USER, ref: 'a' });
      await service.claimSlot({ userId: VENDOR_USER, ref: 'b' });

      await expect(service.slotStatus(VENDOR_USER)).resolves.toMatchObject({
        status: 'approved',
        tier: 'Operator',
        capacity: 3,
        held: 2,
        usable: 2,
      });
    });

    /**
     * THE UNSTAKE CASE, and the mechanism the DoD asked for.
     *
     * Nothing released these slots — svc-market never learns that somebody
     * unstaked, and deliberately does not poll svc-token for it. The vendor
     * simply reads as entitled to nothing, because capacity is re-derived on
     * every read.
     */
    it('reports zero usable slots the moment the tier drops to Base', async () => {
      const generous = withCapacity(3);
      await approvedVendor(VENDOR_USER, generous);
      await generous.claimSlot({ userId: VENDOR_USER, ref: 'a' });
      await generous.claimSlot({ userId: VENDOR_USER, ref: 'b' });

      // Same rows, same database — only svc-token's answer has changed.
      const unstaked = withCapacity(0, 'Base');
      await expect(unstaked.slotStatus(VENDOR_USER)).resolves.toMatchObject({ capacity: 0, held: 2, usable: 0 });
    });

    it('clamps usable to the current tier when it shrinks under held slots', async () => {
      const generous = withCapacity(3);
      await approvedVendor(VENDOR_USER, generous);
      for (const ref of ['a', 'b', 'c']) await generous.claimSlot({ userId: VENDOR_USER, ref });

      await expect(withCapacity(1, 'Initiate').slotStatus(VENDOR_USER)).resolves.toMatchObject({ capacity: 1, held: 3, usable: 1 });
    });

    it('refuses to answer at all when the stake gate is unreadable', async () => {
      const service = withCapacity(3);
      await approvedVendor(VENDOR_USER, service);

      const dead = new VendorService(sql, {
        entitlementOf: async () => {
          const { MarketError } = await import('./vendor-service.js');
          throw new MarketError('Stake gate unavailable', 'market.stake_unavailable');
        },
      });
      // Fails closed: a read that cannot verify entitlement must not report a
      // vendor as listable, and must not guess a capacity to fill the gap.
      await expect(dead.slotStatus(VENDOR_USER)).rejects.toMatchObject({ code: 'market.stake_unavailable' });
    });
  });
});
