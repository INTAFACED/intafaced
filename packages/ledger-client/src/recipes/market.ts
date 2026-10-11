import { mulBps, sub, type Amount } from '../money.js';
import type { EntryInput, PostRequest } from '../types.js';
import { InvalidEntryError } from '../types.js';
import { houseFees, userAvailable } from '../accounts.js';

/**
 * MARKET VENDOR + COMMERCE RECIPES (§8.7).
 *
 * ⚠ SHARED-PACKAGE CHANGE — flagged deliberately.
 *
 * Doctrine §8.7 vendor model names five legs: vet, listing fees, commissions,
 * premium placement, stake-gated slots. Stake capacity lives in svc-token
 * (`token.stake` / `vendorSlots`); vet + slots live in svc-market without a
 * second book. This file owns the **money** legs that may touch the ledger:
 *
 *   · `marketPurchase`           — house commission on a one-time sale (live)
 *   · `marketListingFee`         — vendor pays a listing fee (§13 until wired)
 *   · `marketPremiumPlacement`   — vendor pays for placement (§13 until wired)
 *
 * Amounts and bps are INPUTS. Nothing here invents a platform rate. Services
 * refuse blank owner config before calling; recipes still refuse blank/invalid
 * inputs so a miswired caller cannot post free-for-all revenue.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ LISTING FEE + PREMIUM PLACEMENT — §13 SOCKETS (D26-P1-M2 deepen)         ║
 * ║                                                                           ║
 * ║ These two recipes are DESIGNED, WRITTEN and TESTED so the vendor          ║
 * ║ lifecycle can be honest about listing/placement fees without inventing    ║
 * ║ magnitudes. They are deliberately NOT WIRED into svc-market:              ║
 * ║   · VendorService moves no value by law (stake gate only).                ║
 * ║   · Commerce createListing / purchase is D26-P1-M1 residual territory.    ║
 * ║   · Owner must publish fee amounts (or explicit 0) before any writer.     ║
 * ║ Landing them moves no value anywhere until a service posts them.          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Purchase rounding: **floor** on the commission (customer favour). Vendor +
 * house always sum exactly to the price (no remainder).
 */

const debit = (account: ReturnType<typeof userAvailable>, amount: Amount): EntryInput => ({
  account,
  direction: 'debit',
  amount,
});
const credit = (account: ReturnType<typeof userAvailable>, amount: Amount): EntryInput => ({
  account,
  direction: 'credit',
  amount,
});

function requirePositive(name: string, value: Amount): void {
  if (value <= 0n) throw new InvalidEntryError(`${name} must be positive`);
}

function requireId(name: string, value: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new InvalidEntryError(`${name} is required for market recipe idempotency`);
  return trimmed;
}

export interface MarketPurchaseInput {
  /** Client-supplied purchase id — the whole idempotency story. */
  purchaseId: string;
  listingId: string;
  buyerId: string;
  vendorUserId: string;
  assetId: string;
  /** Gross price the buyer pays — decimal-scaled Amount, never a JS number. */
  price: Amount;
  /**
   * House commission in basis points (0..9999). Required at the recipe layer so
   * a missing config cannot silently become zero by defaulting.
   */
  commissionBps: number;
}

/**
 * Buyer → vendor (net) + house commission.
 *
 * Idempotency key: `market.purchase:<purchaseId>` — never a UUID from the
 * clock, never a second post for the same purchaseId.
 *
 * Stake / eligibility gates stay in svc-market (computed listingEligibility).
 * This recipe assumes the caller already refused under-staked / suspended /
 * blank-commission vendors — it only conserves the disclosed split.
 */
export function marketPurchase(input: MarketPurchaseInput): PostRequest {
  requirePositive('purchase price', input.price);
  if (!Number.isInteger(input.commissionBps) || input.commissionBps < 0 || input.commissionBps > 9_999) {
    throw new InvalidEntryError(`market commissionBps must be an integer in 0..9999, got ${input.commissionBps}`);
  }
  requireId('purchaseId', input.purchaseId);
  const buyerId = requireId('buyerId', input.buyerId);
  const vendorUserId = requireId('vendorUserId', input.vendorUserId);
  const assetId = requireId('assetId', input.assetId);
  const listingId = requireId('listingId', input.listingId);
  if (buyerId === vendorUserId) {
    throw new InvalidEntryError('buyer and vendor must be different users');
  }

  // Floor — customer favour. ceil would invent house revenue the buyer did not
  // agree to pay beyond the listed price split.
  const commission = mulBps(input.price, input.commissionBps, 'floor');
  const vendorNet = sub(input.price, commission);
  if (vendorNet <= 0n) {
    throw new InvalidEntryError('Commission leaves the vendor with nothing — check commission bps');
  }

  const entries: EntryInput[] = [
    credit(userAvailable(buyerId, assetId), input.price),
    debit(userAvailable(vendorUserId, assetId), vendorNet),
    ...(commission > 0n ? [debit(houseFees('market', assetId), commission)] : []),
  ];

  return {
    idempotencyKey: `market.purchase:${input.purchaseId.trim()}`,
    module: 'market',
    reason: 'market.purchase',
    meta: {
      purchaseId: input.purchaseId.trim(),
      listingId,
      commissionBps: input.commissionBps,
      commission: commission.toString(),
      vendorNet: vendorNet.toString(),
    },
    entries,
  };
}

export interface MarketListingFeeInput {
  /** Listing (or slot-ref) id — idempotency key. One fee post per listing. */
  listingId: string;
  vendorUserId: string;
  assetId: string;
  /**
   * Fee amount the vendor pays. Required — never defaulted. Owner publishes the
   * magnitude (or an explicit free path that never calls this recipe). Zero is
   * refused here so "free listing" is silence at the caller, not a zero post.
   */
  amount: Amount;
}

/**
 * Vendor → house listing fee (§8.7 · §13 unwired).
 *
 * Idempotency: `market.listing_fee:<listingId>`.
 */
export function marketListingFee(input: MarketListingFeeInput): PostRequest {
  const listingId = requireId('listingId', input.listingId);
  requireId('vendorUserId', input.vendorUserId);
  requireId('assetId', input.assetId);
  requirePositive('listing fee', input.amount);

  return {
    idempotencyKey: `market.listing_fee:${listingId}`,
    module: 'market',
    reason: 'market.listing_fee',
    meta: {
      listingId,
      vendorUserId: input.vendorUserId,
      amount: input.amount.toString(),
      socket: '§13',
    },
    entries: [
      credit(userAvailable(input.vendorUserId, input.assetId), input.amount),
      debit(houseFees('market', input.assetId), input.amount),
    ],
  };
}

export interface MarketPremiumPlacementInput {
  /** Placement purchase id — not the listing id (one listing may buy placement more than once). */
  placementId: string;
  listingId: string;
  vendorUserId: string;
  assetId: string;
  /** Placement fee amount. Required — never invented. */
  amount: Amount;
}

/**
 * Vendor → house premium placement fee (§8.7 · §13 unwired).
 *
 * Ranking / featured catalogue order remains DIRECTION §8 owner residual —
 * this recipe only books the fee when a writer exists. Idempotency:
 * `market.premium_placement:<placementId>`.
 */
export function marketPremiumPlacement(input: MarketPremiumPlacementInput): PostRequest {
  const placementId = requireId('placementId', input.placementId);
  requireId('listingId', input.listingId);
  requireId('vendorUserId', input.vendorUserId);
  requireId('assetId', input.assetId);
  requirePositive('premium placement fee', input.amount);

  return {
    idempotencyKey: `market.premium_placement:${placementId}`,
    module: 'market',
    reason: 'market.premium_placement',
    meta: {
      placementId,
      listingId: input.listingId,
      vendorUserId: input.vendorUserId,
      amount: input.amount.toString(),
      socket: '§13',
    },
    entries: [
      credit(userAvailable(input.vendorUserId, input.assetId), input.amount),
      debit(houseFees('market', input.assetId), input.amount),
    ],
  };
}
