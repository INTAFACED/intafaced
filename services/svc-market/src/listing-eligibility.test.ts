import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MARKET_OPS_SCOPE, VendorService } from './vendor-service.js';
import { createStakeSource, type SlotEntitlementSource, type VendorEntitlement } from './stake-source.js';

/**
 * PUBLIC LIST ELIGIBILITY AGAINST A REAL POSTGRES (§8.7, `market.vendors`
 * Stage 3 — DoD clause 5: "suspended / under-staked vendors cannot present as
 * listed").
 *
 * ── WHY THIS NEEDS A REAL DATABASE ─────────────────────────────────────────
 *
 * The whole claim is that eligibility is DERIVED from rows that outlive the fact
 * that earned them: a slot row that nothing released, sitting next to a stake
 * tier that has since collapsed. An in-memory double would have to be told what
 * rows survive an unstake, and it would be told by the same person writing the
 * assertion. The rows have to be really there.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run database via `createTestDatabase` so schema-qualified
 * `market.*` SQL stays on `market`). Local without that env starts Testcontainers
 * `postgres:16-alpine`. Docker/PG down is a failed suite, not a green skip.
 *
 * ── THE ONE THAT MATTERS ───────────────────────────────────────────────────
 *
 * "a slot holder who has since dropped below their tier is not listed". Nothing
 * in this service releases that slot — svc-market never learns anybody unstaked
 * — so if eligibility were a stored flag, or a `COUNT` of slot rows, that vendor
 * would still be presenting as listed. Every other test here is a fence around
 * that one.
 */

const here = dirname(fileURLToPath(import.meta.url));

const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const VENDOR_USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const LATER_USER = '44444444-4444-4444-8444-444444444444';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const UNKNOWN_VENDOR = '99999999-9999-4999-8999-999999999999';

const H8A_IMAGE = 'postgres:16-alpine';

/**
 * A stake source whose answer can change between reads — which is the point.
 *
 * `FixedEntitlement` would prove eligibility is computed from SOME capacity;
 * only a source that changes under a live service proves it is re-read rather
 * than captured when the service was constructed. Unstaking is exactly that:
 * the same vendor, the same slot rows, a different answer a second later.
 */
class MutableEntitlement implements SlotEntitlementSource {
  constructor(
    public vendorSlots: number,
    public tierName = 'Operator',
  ) {}

  async entitlementOf(): Promise<VendorEntitlement> {
    return { tierName: this.tierName, vendorSlots: this.vendorSlots };
  }
}

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
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
      `H8a: market listing-eligibility is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-market listing eligibility PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('svc-market listing eligibility', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  /** A stake gate every test can move under the service's feet. */
  let stakes: MutableEntitlement;
  let service: VendorService;

  /** An approved vendor holding `slots` listing slots — the shape that is listed. */
  async function listedVendor(userId: string, slots = 1): Promise<string> {
    const vendor = await service.applyAsVendor({ userId, displayName: `Vendor ${userId.slice(0, 4)}`, description: 'I sell things' });
    await service.vet({
      vendorId: vendor.id,
      decision: 'approved',
      reason: 'documents check out',
      actorId: OPERATOR,
      actorScope: MARKET_OPS_SCOPE,
    });
    for (let i = 0; i < slots; i += 1) {
      await service.claimSlot({ userId, ref: `listing-${i}` });
    }
    return vendor.id;
  }

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'market', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`TRUNCATE market.vendor_slots, market.vendor_status_events, market.vendors RESTART IDENTITY CASCADE`;
    stakes = new MutableEntitlement(3);
    service = new VendorService(sql, stakes);
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  describe('the vendor who unstaked — DoD clause 5', () => {
    /**
     * THE TEST THIS STAGE EXISTS FOR.
     *
     * Claim three slots at Operator, drop to Base, and read again. Nothing
     * released the slots — `vendor_slots` still holds three open rows, and the
     * assertion below checks that, so the test cannot pass by the rows quietly
     * disappearing and taking the interesting case with them.
     */
    it('does not present a slot holder as listed once their stake no longer covers it', async () => {
      const vendorId = await listedVendor(VENDOR_USER, 3);
      await expect(service.publicProfile(vendorId)).resolves.toMatchObject({ id: vendorId });

      // The unstake. Nothing in svc-market is told; only svc-token's answer moves.
      stakes.vendorSlots = 0;

      const rowsStillThere = await sql<Array<{ count: string }>>`
        SELECT COUNT(*)::text AS count FROM market.vendor_slots WHERE vendor_id = ${vendorId} AND released_at IS NULL
      `;
      expect(rowsStillThere[0]?.count).toBe('3');

      await expect(service.publicProfile(vendorId)).resolves.toBeNull();
      await expect(service.listedVendors({ limit: 20 })).resolves.toEqual([]);
      await expect(service.listingEligibility({ vendorId })).resolves.toMatchObject({
        listed: false,
        code: 'market.stake_required',
      });
    });

    /**
     * A PARTIAL drop still leaves them listed, and that is not a bug. Somebody
     * at Initiate is entitled to a slot; clause 5 is about vendors whose stake
     * covers NOTHING. Which of their over-held listings stays live is
     * `market.commerce`'s to decide when it exists — this mountain answers at the
     * vendor level.
     */
    it('keeps a vendor listed when their reduced tier still covers at least one slot', async () => {
      const vendorId = await listedVendor(VENDOR_USER, 3);
      stakes.vendorSlots = 1;
      await expect(service.publicProfile(vendorId)).resolves.toMatchObject({ id: vendorId });
    });

    it('lists them again the moment they re-stake, with no release or re-claim', async () => {
      const vendorId = await listedVendor(VENDOR_USER, 1);
      stakes.vendorSlots = 0;
      await expect(service.publicProfile(vendorId)).resolves.toBeNull();

      stakes.vendorSlots = 3;
      await expect(service.publicProfile(vendorId)).resolves.toMatchObject({ id: vendorId });
    });
  });

  describe('the states that are not listed', () => {
    /**
     * The belt-and-braces case. `vet` releases slots in the same transaction as
     * a suspension, so this forces the state that transaction exists to prevent
     * — suspended, slots still open — with a direct UPDATE. If the read path
     * trusted the slot rows, this vendor would still be on the marketplace after
     * a crash between two writes.
     */
    it('does not present a suspended vendor whose slots were never released', async () => {
      const vendorId = await listedVendor(VENDOR_USER, 1);
      await sql`UPDATE market.vendors SET status = 'suspended'::market.vendor_status WHERE id = ${vendorId}`;

      const open = await sql<Array<{ count: string }>>`
        SELECT COUNT(*)::text AS count FROM market.vendor_slots WHERE vendor_id = ${vendorId} AND released_at IS NULL
      `;
      expect(open[0]?.count).toBe('1');

      await expect(service.publicProfile(vendorId)).resolves.toBeNull();
      await expect(service.listedVendors({ limit: 20 })).resolves.toEqual([]);
    });

    it('does not present an approved vendor who holds no slot', async () => {
      const vendor = await service.applyAsVendor({ userId: VENDOR_USER, displayName: 'Acme', description: 'I sell things' });
      await service.vet({
        vendorId: vendor.id,
        decision: 'approved',
        reason: 'ok',
        actorId: OPERATOR,
        actorScope: MARKET_OPS_SCOPE,
      });

      await expect(service.publicProfile(vendor.id)).resolves.toBeNull();
      await expect(service.listedVendors({ limit: 20 })).resolves.toEqual([]);
      await expect(service.listingEligibility({ vendorId: vendor.id })).resolves.toMatchObject({
        listed: false,
        code: 'market.slot_required',
      });
    });

    it('does not present an undecided application', async () => {
      const vendor = await service.applyAsVendor({ userId: VENDOR_USER, displayName: 'Acme', description: 'I sell things' });
      await expect(service.publicProfile(vendor.id)).resolves.toBeNull();
      await expect(service.listingEligibility({ vendorId: vendor.id })).resolves.toMatchObject({
        listed: false,
        code: 'market.vendor_not_approved',
      });
    });

    /**
     * A REJECTED vendor and an UNKNOWN id are indistinguishable from outside,
     * and that is the requirement: a public read that could tell them apart is
     * an enumeration of everybody an operator has thrown off the marketplace.
     * The DIFFERENCE survives on the internal seam, one line below, where the
     * caller is a service and not a stranger.
     */
    it('answers the same null for a rejected vendor and an id that never existed', async () => {
      const vendor = await service.applyAsVendor({ userId: VENDOR_USER, displayName: 'Acme', description: 'I sell things' });
      await service.vet({
        vendorId: vendor.id,
        decision: 'rejected',
        reason: 'suspected counterfeit stock',
        actorId: OPERATOR,
        actorScope: MARKET_OPS_SCOPE,
      });

      await expect(service.publicProfile(vendor.id)).resolves.toBeNull();
      await expect(service.publicProfile(UNKNOWN_VENDOR)).resolves.toBeNull();

      await expect(service.listingEligibility({ vendorId: vendor.id })).resolves.toMatchObject({
        code: 'market.vendor_not_approved',
      });
      await expect(service.listingEligibility({ vendorId: UNKNOWN_VENDOR })).resolves.toMatchObject({
        vendorId: null,
        code: 'market.vendor_not_found',
      });
    });
  });

  describe('what the public profile carries', () => {
    it('carries four fields and none of the operator internals', async () => {
      const vendorId = await listedVendor(VENDOR_USER, 1);
      await service.vet({
        vendorId,
        decision: 'suspended',
        reason: 'a reason no stranger may read',
        actorId: OPERATOR,
        actorScope: MARKET_OPS_SCOPE,
      });
      await service.vet({
        vendorId,
        decision: 'approved',
        reason: 'reinstated',
        actorId: OPERATOR,
        actorScope: MARKET_OPS_SCOPE,
      });
      // The suspension released the slot; take one again so they are listed.
      await service.claimSlot({ userId: VENDOR_USER, ref: 'listing-again' });

      const profile = await service.publicProfile(vendorId);
      expect(profile).not.toBeNull();
      // EXACTLY these keys. An added field on a public response is a disclosure
      // decision, and this assertion is what makes somebody make it on purpose.
      expect(Object.keys(profile!).sort()).toEqual(['createdAt', 'description', 'displayName', 'id']);

      const serialised = JSON.stringify(profile);
      for (const secret of [VENDOR_USER, OPERATOR, 'a reason no stranger may read', 'reinstated', MARKET_OPS_SCOPE, 'Operator']) {
        expect(serialised).not.toContain(secret);
      }
    });
  });

  describe('the directory', () => {
    it('returns listed vendors in registration order and drops the rest', async () => {
      const first = await listedVendor(VENDOR_USER, 1);
      const second = await listedVendor(OTHER_USER, 1);

      await expect(service.listedVendors({ limit: 20 })).resolves.toMatchObject([{ id: first }, { id: second }]);

      await sql`UPDATE market.vendors SET status = 'suspended'::market.vendor_status WHERE id = ${first}`;
      await expect(service.listedVendors({ limit: 20 })).resolves.toMatchObject([{ id: second }]);
    });

    it('checks only the requested candidate window in parallel during a stake outage', async () => {
      await listedVendor(VENDOR_USER, 1);
      await listedVendor(OTHER_USER, 1);
      await listedVendor(LATER_USER, 1);
      const called: string[] = [];
      let active = 0;
      let peak = 0;
      const reading = new VendorService(sql, {
        async entitlementOf(userId: string): Promise<VendorEntitlement> {
          called.push(userId);
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          throw new Error('stake outage');
        },
      });
      await expect(reading.listedVendors({ limit: 2 })).resolves.toEqual([]);
      expect([...called].sort()).toEqual([VENDOR_USER, OTHER_USER].sort());
      expect(peak).toBe(2);
    });

    it('keeps registration order even when the later parallel lookup finishes first', async () => {
      const first = await listedVendor(VENDOR_USER, 1);
      const second = await listedVendor(OTHER_USER, 1);
      await listedVendor(LATER_USER, 1);
      const finished: string[] = [];
      // The earlier vendor's lookup waits for the later one to finish, so the later one
      // always finishes first. A fixed 30 ms head start was not enough: each lookup reads
      // its slot count first, and on a busy runner the second read can land after the
      // first lookup's timer (#6232). Reads made one after another never release the wait,
      // and the 2 s fallback then leaves the order wrong, so the check still fails.
      let laterDone!: () => void;
      const later = new Promise<void>((resolve) => (laterDone = resolve));
      const reading = new VendorService(sql, {
        async entitlementOf(userId: string): Promise<VendorEntitlement> {
          if (userId === VENDOR_USER) await Promise.race([later, new Promise((resolve) => setTimeout(resolve, 2_000))]);
          finished.push(userId);
          if (userId === OTHER_USER) laterDone();
          return { tierName: 'Operator', vendorSlots: 1 };
        },
      });
      await expect(reading.listedVendors({ limit: 2 })).resolves.toMatchObject([{ id: first }, { id: second }]);
      expect(finished).toEqual([OTHER_USER, VENDOR_USER]);
    });

    it('drops status and slot changes committed during the parallel stake reads', async () => {
      const suspended = await listedVendor(VENDOR_USER, 1);
      await listedVendor(OTHER_USER, 1);
      const eligible = await listedVendor(LATER_USER, 1);
      const reading = new VendorService(sql, {
        async entitlementOf(userId: string): Promise<VendorEntitlement> {
          if (userId === VENDOR_USER) await sql`UPDATE market.vendors SET status = 'suspended' WHERE id = ${suspended}`;
          if (userId === OTHER_USER) await service.releaseSlot({ userId, ref: 'listing-0' });
          return { tierName: 'Operator', vendorSlots: 1 };
        },
      });
      await expect(reading.listedVendors({ limit: 3 })).resolves.toMatchObject([{ id: eligible }]);
    });
  });

  /**
   * FAIL CLOSED, AGAINST A SERVER THAT REALLY 500s.
   *
   * Not a mocked rejection: a `node:http` server returns 500 so the directory
   * path is proved against a real non-2xx (PR #1100 merged the historic
   * always-500 bigint bug; outages still exist). Nobody appears — not everybody.
   */
  describe('when the stake source is down', () => {
    let server: Server | undefined;

    async function serve500(): Promise<string> {
      server = createServer((_req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ statusCode: 500, message: 'Do not know how to serialize a BigInt' }));
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (typeof address === 'string' || address === null) throw new Error('no port');
      return `http://127.0.0.1:${address.port}`;
    }

    afterAll(async () => {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    });

    it('shows nobody rather than everybody', async () => {
      const first = await listedVendor(VENDOR_USER, 1);
      await listedVendor(OTHER_USER, 1);
      await expect(service.listedVendors({ limit: 20 })).resolves.toHaveLength(2);

      const url = await serve500();
      const closed = new VendorService(sql, createStakeSource(url, 'a-market-listing-test-secret-long-enough'));

      // The directory empties — per-vendor fail-closed, so one flaky lookup
      // costs one vendor and a total outage costs the page.
      await expect(closed.listedVendors({ limit: 20 })).resolves.toEqual([]);

      /**
       * The single read THROWS rather than returning null. Both refuse to show
       * the vendor, which is the fail-closed requirement — but a null here would
       * become a 404, and a 404 asserts this vendor does not exist. That is
       * false, and it is the kind of false a client caches.
       */
      await expect(closed.publicProfile(first)).rejects.toMatchObject({ code: 'market.stake_unavailable' });
      await expect(closed.listingEligibility({ vendorId: first })).rejects.toMatchObject({ code: 'market.stake_unavailable' });
    });

    /**
     * An outage must not turn a suspended vendor into a 500 either. Everything
     * decidable from local rows is decided before the network call, so the states
     * that were never eligible keep answering while svc-token is down.
     */
    it('still answers for vendors whose refusal never needed svc-token', async () => {
      const vendorId = await listedVendor(VENDOR_USER, 1);
      await sql`UPDATE market.vendors SET status = 'suspended'::market.vendor_status WHERE id = ${vendorId}`;

      const url = await serve500();
      const closed = new VendorService(sql, createStakeSource(url, 'a-market-listing-test-secret-long-enough'));

      await expect(closed.publicProfile(vendorId)).resolves.toBeNull();
      await expect(closed.publicProfile(UNKNOWN_VENDOR)).resolves.toBeNull();
    });
  });

  /**
   * Status and the open count are read BEFORE `entitlementOf`, then the stake
   * call yields. `vet` or `releaseSlot` can commit in that gap. The verdict has
   * to come from a read that happens after the call, not from the values that
   * authorised the call.
   */
  describe('facts that move during the stake read', () => {
    function stakeThatMoves(during: () => Promise<void>): SlotEntitlementSource {
      return {
        async entitlementOf(): Promise<VendorEntitlement> {
          await during();
          return { tierName: 'Operator', vendorSlots: 1 };
        },
      };
    }

    it('returns market.vendor_not_approved when vet suspends during entitlementOf', async () => {
      const vendorId = await listedVendor(VENDOR_USER, 1);
      let suspended = false;
      const racing = new VendorService(
        sql,
        stakeThatMoves(async () => {
          await service.vet({
            vendorId,
            decision: 'suspended',
            reason: 'suspended while the stake read was in flight',
            actorId: OPERATOR,
            actorScope: MARKET_OPS_SCOPE,
          });
          suspended = true;
        }),
      );

      await expect(racing.listingEligibility({ vendorId })).resolves.toMatchObject({
        vendorId,
        listed: false,
        code: 'market.vendor_not_approved',
      });
      expect(suspended).toBe(true);
      await expect(racing.publicProfile(vendorId)).resolves.toBeNull();
    });

    it('returns market.slot_required when releaseSlot frees the last slot during entitlementOf', async () => {
      const vendorId = await listedVendor(VENDOR_USER, 1);
      let released = false;
      const racing = new VendorService(
        sql,
        stakeThatMoves(async () => {
          const result = await service.releaseSlot({ userId: VENDOR_USER, ref: 'listing-0' });
          expect(result.released).toBe(true);
          released = true;
        }),
      );

      await expect(racing.listingEligibility({ vendorId })).resolves.toMatchObject({
        vendorId,
        listed: false,
        code: 'market.slot_required',
      });
      expect(released).toBe(true);
      await expect(racing.publicProfile(vendorId)).resolves.toBeNull();
    });

    it('stays listed when the vendor is still approved and still holds a covered slot', async () => {
      const vendorId = await listedVendor(VENDOR_USER, 1);
      let sawStake = false;
      const racing = new VendorService(
        sql,
        stakeThatMoves(async () => {
          sawStake = true;
        }),
      );

      await expect(racing.listingEligibility({ vendorId })).resolves.toEqual({ vendorId, listed: true });
      expect(sawStake).toBe(true);
      await expect(racing.publicProfile(vendorId)).resolves.toMatchObject({ id: vendorId });
    });
  });

  /**
   * THE SEAM `market.commerce` CALLS. Commerce holds a principal, not a vendor
   * id, so the same rule has to be reachable by `userId` — and it has to give a
   * REASON, because "refuse if not listed/eligible" is only useful to the vendor
   * on the other end if it says which of the four things to fix.
   */
  describe('the commerce seam', () => {
    it('answers by userId with a code commerce can act on', async () => {
      const vendorId = await listedVendor(VENDOR_USER, 1);
      await expect(service.listingEligibility({ userId: VENDOR_USER })).resolves.toEqual({ vendorId, listed: true });

      stakes.vendorSlots = 0;
      await expect(service.listingEligibility({ userId: VENDOR_USER })).resolves.toMatchObject({
        vendorId,
        listed: false,
        code: 'market.stake_required',
      });

      await expect(service.listingEligibility({ userId: OTHER_USER })).resolves.toMatchObject({
        vendorId: null,
        code: 'market.vendor_not_found',
      });
    });
  });
});
