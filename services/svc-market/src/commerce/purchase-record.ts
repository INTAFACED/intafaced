import { decimalPriceFromDriver } from './commerce-price.js';

/**
 * One `market.purchases` row as the service reads it.
 *
 * `flow` is chosen at claim and never changes: 'pay' posts `marketPurchase` and the row settles; 'hold' posts
 * `marketPurchaseHold`, the row reads 'held' until its refund window ends, then 'released' or 'refunded'
 * (MC-market-02). `settled` stays the status of every pay-through purchase.
 */
export type PurchaseStatus = 'pending' | 'settled' | 'rejected' | 'held' | 'released' | 'refunded';
export type PurchaseFlow = 'pay' | 'hold';
export type PurchaseOutcome = 'release' | 'refund';

/** Statuses whose charge stands: the buyer has paid and access holds. A refunded purchase is not one. */
export const PAID_STATUSES = ['settled', 'held', 'released'] as const;
/** Statuses whose money has reached the seller. A held purchase has not yet. */
export const EARNED_STATUSES = ['settled', 'released'] as const;

export interface PurchaseRecord {
  id: string;
  listingId: string;
  buyerId: string;
  vendorId: string;
  vendorUserId: string;
  assetId: string;
  price: string;
  commissionBps: number;
  status: PurchaseStatus;
  /** The charge: `marketPurchase` on a pay-through purchase, `marketPurchaseHold` on a held one. */
  ledgerTxId: string | null;
  rejectionCode: string | null;
  createdAt: string;
  /** When the money reached the seller: the settle of a pay-through purchase, the release of a held one. */
  settledAt: string | null;
  /** Paid access end. Set on paid subscription purchases; null for one-time. */
  accessUntil: string | null;
  /**
   * Listing period at claim, in whole seconds. Null when the listing period
   * was null. Never a default month.
   */
  periodSeconds: number | null;
  flow: PurchaseFlow;
  /** The owner's refund window at claim, in whole seconds. Null on a pay-through purchase. */
  refundWindowSeconds: number | null;
  holdPostedAt: string | null;
  /** Held at plus the window. A refund is possible before it; the release after it. */
  refundWindowEndsAt: string | null;
  refundRequestedAt: string | null;
  /** The one outcome claimed for a held purchase. */
  outcome: PurchaseOutcome | null;
  /** The release or refund posting. */
  outcomeTxId: string | null;
  outcomeAt: string | null;
}

export interface PurchaseRow {
  id: string;
  listing_id: string;
  buyer_id: string;
  vendor_id: string;
  vendor_user_id: string;
  asset_id: string;
  price: unknown;
  commission_bps: number;
  status: PurchaseStatus;
  ledger_tx_id: string | null;
  rejection_code: string | null;
  created_at: Date;
  settled_at: Date | null;
  access_until: Date | null;
  period_seconds: number | string | null;
  flow: PurchaseFlow;
  refund_window_seconds: number | string | null;
  hold_posted_at: Date | null;
  refund_window_ends_at: Date | null;
  refund_requested_at: Date | null;
  outcome: PurchaseOutcome | null;
  outcome_tx_id: string | null;
  outcome_at: Date | null;
}

const whole = (value: number | string | null): number | null => (value == null || value === '' ? null : Number(value));
const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function toPurchase(row: PurchaseRow): PurchaseRecord {
  return {
    id: row.id,
    listingId: row.listing_id,
    buyerId: row.buyer_id,
    vendorId: row.vendor_id,
    vendorUserId: row.vendor_user_id,
    assetId: row.asset_id,
    price: decimalPriceFromDriver(row.price),
    commissionBps: row.commission_bps,
    status: row.status,
    ledgerTxId: row.ledger_tx_id,
    rejectionCode: row.rejection_code,
    createdAt: row.created_at.toISOString(),
    settledAt: iso(row.settled_at),
    accessUntil: iso(row.access_until),
    periodSeconds: whole(row.period_seconds),
    flow: row.flow,
    refundWindowSeconds: whole(row.refund_window_seconds),
    holdPostedAt: iso(row.hold_posted_at),
    refundWindowEndsAt: iso(row.refund_window_ends_at),
    refundRequestedAt: iso(row.refund_requested_at),
    outcome: row.outcome,
    outcomeTxId: row.outcome_tx_id,
    outcomeAt: iso(row.outcome_at),
  };
}
