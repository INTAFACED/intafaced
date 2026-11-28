import { describe, expect, it } from 'vitest';
import { decideVendorSlot, usableSlots } from './slot-access.js';

/**
 * The slot rule, with no database and no svc-token.
 *
 * These run everywhere, including on a machine with no Docker — which is the
 * point of `decideVendorSlot` being pure. The DB-backed oversell proof in
 * `vendor-slots.test.ts` tests that the LOCK holds; this file tests that the
 * DECISION is right, and the two failures are different.
 *
 * No tier number is written down here either. Capacities are passed in as
 * arguments the way svc-token would supply them, so retuning `vendorSlots`
 * cannot make this file wrong (docs/ops/trk/market.vendors.md:156).
 */

describe('decideVendorSlot — the gate is checked before the count', () => {
  it('refuses an unapproved vendor before it looks at stake or capacity', () => {
    // Sovereign-sized capacity, no slots held: only the status can refuse this.
    for (const status of ['applied', 'rejected', 'suspended'] as const) {
      expect(decideVendorSlot({ status, capacity: 50 }, { open: 0 })).toMatchObject({
        allowed: false,
        code: 'market.vendor_not_approved',
      });
    }
  });

  /**
   * THE ORDER TEST, and the reason this file exists as much as the oversell one.
   *
   * A vendor with no stake AND no free capacity must be told to stake, not that
   * the tier is full — "full" sends them away to wait for something they could
   * never have used. Capacity 0 with 0 held is exactly that overlap.
   */
  it('tells a vendor with no stake to stake, not that they are full', () => {
    expect(decideVendorSlot({ status: 'approved', capacity: 0 }, { open: 0 })).toMatchObject({
      allowed: false,
      code: 'market.stake_required',
    });
  });

  it('admits an approved vendor with a free slot', () => {
    expect(decideVendorSlot({ status: 'approved', capacity: 3 }, { open: 2 })).toEqual({ allowed: true });
  });

  it('refuses the claim that would take a vendor one past their capacity', () => {
    expect(decideVendorSlot({ status: 'approved', capacity: 3 }, { open: 3 })).toMatchObject({
      allowed: false,
      code: 'market.slots_exhausted',
    });
  });

  /**
   * A vendor whose tier DROPPED while holding slots — 3 held, entitled to 1.
   * They may not take more; the ones they hold are handled by `usableSlots`.
   */
  it('refuses a vendor already over a capacity that shrank under them', () => {
    expect(decideVendorSlot({ status: 'approved', capacity: 1 }, { open: 3 })).toMatchObject({
      allowed: false,
      code: 'market.slots_exhausted',
    });
  });

  it('never admits on a capacity of zero, however that zero arrived', () => {
    for (const open of [0, 1, 99]) {
      expect(decideVendorSlot({ status: 'approved', capacity: 0 }, { open })).toMatchObject({ allowed: false });
    }
  });
});

describe('usableSlots — DoD clause 5, suspended or under-staked cannot present as listed', () => {
  it('is zero for a suspended vendor even if a release was missed', () => {
    expect(usableSlots({ status: 'suspended', capacity: 10 }, { open: 4 })).toBe(0);
  });

  it('is zero the moment a vendor unstakes, with no release and no event', () => {
    // The whole mechanism: capacity is re-read, so dropping to Base is instant.
    expect(usableSlots({ status: 'approved', capacity: 0 }, { open: 3 })).toBe(0);
  });

  it('clamps to the CURRENT entitlement when a tier shrinks under held slots', () => {
    expect(usableSlots({ status: 'approved', capacity: 1 }, { open: 3 })).toBe(1);
  });

  it('never reports more than are actually held', () => {
    expect(usableSlots({ status: 'approved', capacity: 10 }, { open: 2 })).toBe(2);
  });
});

describe('pin: refuse unset owner stake/slot magnitudes — do not invent a slot count', () => {
  it('refuses a claim when capacity is unset rather than admitting a free slot', () => {
    for (const capacity of [undefined, null, Number.NaN, 1.5, -1] as number[]) {
      expect(decideVendorSlot({ status: 'approved', capacity }, { open: 0 })).toMatchObject({
        allowed: false,
        code: 'market.stake_unavailable',
      });
    }
  });

  it('reports zero usable slots when capacity is unset — never a guessed quota', () => {
    for (const capacity of [undefined, null, Number.NaN] as number[]) {
      expect(usableSlots({ status: 'approved', capacity }, { open: 3 })).toBe(0);
    }
  });
});
