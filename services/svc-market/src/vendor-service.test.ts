import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { MarketError, VendorService, type VendorStatus } from './vendor-service.js';
import type { SlotEntitlementSource } from './stake-source.js';

/**
 * The refusals, proved to happen BEFORE the database is touched.
 *
 * The `sql` handed in is a Proxy that throws on any property access, so these
 * tests do not need Postgres and — more usefully — they fail if a guard is ever
 * moved to after the first query. A validation that runs inside the transaction
 * is a validation that has already opened one.
 */
const noDatabase = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`svc-market reached the database (.${String(property)}) before refusing — the guard ran too late`);
    },
    apply() {
      throw new Error('svc-market reached the database before refusing — the guard ran too late');
    },
  },
) as unknown as Sql;

const VENDOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * The stake gate, held to the same standard as the database: none of the
 * refusals below may reach it. A guard that consults svc-token before rejecting
 * a blank display name has made a network call to answer a form error — and
 * under an svc-token outage it would report `market.stake_unavailable` for a
 * problem the caller could have fixed themselves.
 */
const noStake: SlotEntitlementSource = {
  entitlementOf() {
    throw new Error('svc-market called the stake gate before refusing — the guard ran too late');
  },
};

const vendors = new VendorService(noDatabase, noStake);

describe('vet — nothing in svc-market decides an application', () => {
  it('refuses a caller who does not hold the operator scope', async () => {
    await expect(
      vendors.vet({ vendorId: VENDOR, decision: 'approved', reason: 'looks fine', actorId: OPERATOR, actorScope: 'market:write' }),
    ).rejects.toMatchObject({ code: 'market.vet_operator_required' });
  });

  // The one that matters most: a policy engine, a cron or an internal tool
  // reaching this method with no scope at all must be refused by NAME, not
  // silently allowed to write an approval nobody made.
  it('refuses a caller with no scope at all', async () => {
    await expect(
      vendors.vet({ vendorId: VENDOR, decision: 'rejected', reason: 'automated', actorId: OPERATOR, actorScope: '' }),
    ).rejects.toBeInstanceOf(MarketError);
  });

  it('refuses a decision with a blank reason', async () => {
    await expect(
      vendors.vet({ vendorId: VENDOR, decision: 'rejected', reason: '   ', actorId: OPERATOR, actorScope: 'market:ops' }),
    ).rejects.toMatchObject({ code: 'market.vet_reason_required' });
  });
});

describe('apply — the fields an operator has to read cannot be blank', () => {
  it('refuses a blank display name', async () => {
    await expect(vendors.applyAsVendor({ userId: OPERATOR, displayName: '  ', description: 'I sell things' })).rejects.toMatchObject({
      code: 'market.vendor_display_name_required',
    });
  });

  it('refuses a blank description', async () => {
    await expect(vendors.applyAsVendor({ userId: OPERATOR, displayName: 'Acme', description: '\n\t ' })).rejects.toMatchObject({
      code: 'market.vendor_description_required',
    });
  });
});

describe('listApplications — unset page size refuses before the database', () => {
  it('refuses a missing limit rather than inventing 50', async () => {
    await expect(vendors.listApplications()).rejects.toMatchObject({
      code: 'market.applications_list_limit_unset',
    });
  });
});

describe('history — unset page size refuses before the database', () => {
  it('refuses a missing limit rather than inventing 50', async () => {
    await expect(vendors.history(VENDOR)).rejects.toMatchObject({
      code: 'market.history_limit_unset',
    });
  });
});

describe('claimSlot — the cheap refusal happens before the expensive lookups', () => {
  /**
   * A blank `ref` is refused before the vendor is read and before svc-token is
   * asked. Both proxies above throw if either happens, so this test fails if the
   * check ever moves below them — which matters because the stake lookup is a
   * network call and the vendor read is a query, and neither should be spent on
   * a request that was malformed.
   */
  it('refuses a blank slot reference without a query or a stake lookup', async () => {
    await expect(vendors.claimSlot({ userId: VENDOR, ref: '   ' })).rejects.toMatchObject({ code: 'market.slot_ref_required' });
  });

  it('refuses an empty slot reference', async () => {
    await expect(vendors.claimSlot({ userId: VENDOR, ref: '' })).rejects.toBeInstanceOf(MarketError);
  });
});

describe('claimSlot — an unapproved vendor is refused without the stake gate', () => {
  /**
   * `myVendor` has already returned a row, and that row is stale on purpose:
   * it still says `approved`. The locked read is `applied`, `rejected`, or
   * `suspended`. Those three are decidable locally — the same way
   * `listingEligibility` answers them — so `entitlementOf` must not run.
   * A throw or a non-integer `vendorSlots` from that call would become
   * `market.stake_unavailable` and the router would map it to HTTP 500.
   */
  const VENDOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  function vendorSql(lockedStatus: VendorStatus, events: string[]): Sql {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const row = {
      id: VENDOR_ID,
      user_id: VENDOR,
      display_name: 'Acme',
      description: 'pending review',
      status: 'approved' as VendorStatus,
      created_at: at,
      updated_at: at,
    };

    const query = (strings: TemplateStringsArray): unknown[] => {
      const text = strings.join(' ');
      if (text.includes('FOR UPDATE') && text.includes('market.vendors')) {
        events.push('lock');
        return [{ id: row.id, status: lockedStatus }];
      }
      if (text.includes('user_id') && text.includes('market.vendors')) return [row];
      if (text.includes('market.vendor_slots')) return [];
      throw new Error(`unexpected sql: ${text.replace(/\s+/g, ' ').trim()}`);
    };

    const sql = (strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve(query(strings));
    const begin = async (options: unknown, fn?: (tx: typeof sql) => Promise<unknown>) => {
      const callback = typeof options === 'function' ? (options as (tx: typeof sql) => Promise<unknown>) : fn;
      if (!callback) throw new Error('begin without a callback');
      return callback(sql);
    };
    return Object.assign(sql, { begin }) as unknown as Sql;
  }

  function stakeThatMustNotRun(events: string[]): SlotEntitlementSource {
    return {
      entitlementOf() {
        events.push('stake');
        throw new MarketError('Stake gate unavailable', 'market.stake_unavailable');
      },
    };
  }

  for (const status of ['applied', 'rejected', 'suspended'] as const) {
    it(`returns market.vendor_not_approved for ${status} even when entitlementOf throws`, async () => {
      const events: string[] = [];
      const service = new VendorService(vendorSql(status, events), stakeThatMustNotRun(events));

      await expect(service.claimSlot({ userId: VENDOR, ref: 'listing-1' })).rejects.toMatchObject({
        code: 'market.vendor_not_approved',
      });
      expect(events).toContain('lock');
      expect(events).not.toContain('stake');
    });
  }
});
