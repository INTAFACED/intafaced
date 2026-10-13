import type { VendorStatus } from './vendor-service.js';

/**
 * WHO MAY HOLD A LISTING SLOT (§8.7, `market.vendors` Stage 2).
 *
 * A pure decision over facts the caller has already gathered: what the vendor's
 * lifecycle status is, how many slots their stake tier entitles them to, and how
 * many they already hold. No I/O, so the rule is one function that the claim
 * path, the slot read and the tests below cannot drift apart on.
 *
 * ── THE ORDER OF THE CHECKS IS DELIBERATE ───────────────────────────────────
 *
 * The GATE is checked before the SLOT COUNT, the same inversion
 * `services/svc-academy/src/access/room-access.ts` makes and for the same
 * reason: telling somebody their tier is full when they were never eligible
 * sends them away to wait for capacity they could not have used. Telling them to
 * stake first is something they can act on.
 *
 * ── NO STAKE NUMBER APPEARS IN THIS FILE ────────────────────────────────────
 *
 * `capacity` arrives as a number that svc-token computed from its own tier table
 * (`economics/staking.ts`, `vendorSlots`). There is no threshold here, no tier
 * name compared against a constant, and nothing that would still work if
 * svc-token retuned the schedule. `docs/ops/trk/market.vendors.md:76`: "market
 * must not invent parallel stake numbers".
 */

export interface SlotEntitlement {
  /** The vendor's lifecycle status, read under the same lock as the claim. */
  status: VendorStatus;
  /**
   * How many slots the vendor's CURRENT stake tier entitles them to —
   * `AccessTier.vendorSlots`, read from svc-token at claim time. Zero is a real
   * value and it is the Base tier: somebody who has never staked.
   */
  capacity: number;
}

export interface SlotRequest {
  /** Slots the vendor holds and has not released. A COUNT, never a counter. */
  open: number;
}

export type SlotDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: 'market.vendor_not_approved' | 'market.stake_required' | 'market.slots_exhausted' | 'market.stake_unavailable';
      reason: string;
    };

/** Owner slot capacity is a non-negative integer from svc-token — never a guessed count. */
function ownerSlotCapacitySet(capacity: unknown): capacity is number {
  return typeof capacity === 'number' && Number.isInteger(capacity) && capacity >= 0;
}

export function decideVendorSlot(entitlement: SlotEntitlement, request: SlotRequest): SlotDecision {
  /**
   * Approval first, because it is the fact that outranks the other two. A
   * suspended vendor with a Sovereign stake still may not list, and telling them
   * "stake more" would be a lie about why they were refused.
   *
   * It also outranks an unreadable magnitude. An applied, rejected, or suspended
   * vendor is decidable with no slot count at all — the same order as
   * `listingEligibility`. Checking `capacity` first would turn that local
   * refusal into `market.stake_unavailable` whenever svc-token is down or
   * `vendorSlots` is not an integer.
   */
  if (entitlement.status !== 'approved') {
    return {
      allowed: false,
      code: 'market.vendor_not_approved',
      reason: 'Only an approved vendor may hold a listing slot.',
    };
  }

  /**
   * Unset / unusable owner magnitudes refuse closed, and only once the status
   * can still be allowed. Coercing `undefined` would skip the zero-capacity
   * stake gate (`undefined <= 0` is false) and then admit (`0 >= undefined` is
   * false) — inventing a free slot. This is not a guess at the count.
   */
  if (!ownerSlotCapacitySet(entitlement.capacity)) {
    return {
      allowed: false,
      code: 'market.stake_unavailable',
      reason: 'Owner stake/slot magnitudes are unset — refuse rather than invent a slot count.',
    };
  }

  /**
   * Capacity of zero is the STAKE gate, not a full tier — it is the Base tier,
   * which entitles nobody to anything. Reported as `stake_required` rather than
   * `slots_exhausted` because those are two different instructions.
   */
  if (entitlement.capacity <= 0) {
    return {
      allowed: false,
      code: 'market.stake_required',
      reason: 'Listing slots are open to stakers. Stake IFC to earn a slot.',
    };
  }

  if (request.open >= entitlement.capacity) {
    return {
      allowed: false,
      code: 'market.slots_exhausted',
      reason: 'Every slot your stake tier entitles you to is already in use. Release one, or stake for a higher tier.',
    };
  }

  return { allowed: true };
}

/**
 * How many of a vendor's open slots are USABLE right now — DoD clause 5,
 * "suspended / under-staked vendors cannot present as listed".
 *
 * ── WHY A DERIVED NUMBER RATHER THAN A RELEASE JOB ──────────────────────────
 *
 * A slot is released when a vendor is suspended, because svc-market records that
 * transition itself and can act on it in the same transaction (`vet`). Unstaking
 * is not like that: it happens inside svc-token, there is no accepted bus subject
 * for it, and `tooling/ci/event-wiring.mjs` correctly reds on a subject with no
 * publisher. Polling svc-token for stake changes would be a second source of
 * truth on a timer.
 *
 * So the honest mechanism is to re-derive on every read: a vendor who has
 * dropped from Operator (3 slots) to Base (0) holds three rows that count for
 * nothing the instant anybody asks. The slot rows are not a lie — they record
 * what was claimed — but ENTITLEMENT is always the live tier, never the row
 * count. Stage 3's public read consumes this, and cannot present a slot the
 * vendor's current stake does not cover.
 *
 * A suspended vendor is zero regardless, so a missed release cannot leave one
 * presenting as listed either.
 */
export function usableSlots(entitlement: SlotEntitlement, request: SlotRequest): number {
  if (entitlement.status !== 'approved') return 0;
  if (!ownerSlotCapacitySet(entitlement.capacity)) return 0;
  return Math.max(0, Math.min(request.open, entitlement.capacity));
}
