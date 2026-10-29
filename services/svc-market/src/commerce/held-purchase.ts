import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  formatAmount,
  IDEMPOTENCY_CONFLICT_CODE,
  LedgerError,
  parseAmount,
  recipes,
  type Amount,
  type LedgerClient,
  type LedgerTx,
  type PostRequest,
} from '@intafaced/ledger-client';
import { MarketError } from '../vendor-service.js';

/**
 * A purchase held until its refund window ends (§8.7, J-more-catalogue-02 #4 to #6).
 *
 * With the owner's refund window set, `purchase` posts `marketPurchaseHold`: the price moves from the buyer's available
 * balance into the buyer's own pot for that purchase, and the seller is paid nothing yet. Then one of two things
 * happens, once:
 *
 *   refund   inside the window, the buyer asks; `marketPurchaseRefund` (refund 1, the whole amount) moves the pot back.
 *   release  once the window has ended with no ask, `marketPurchaseRelease` pays the seller net and the house its
 *            commission, from the commission snapshot on the purchase.
 *
 * The ledger's pot is the arbiter: it cannot go negative, so a refund and a release can never both be paid. This table
 * only records which post happened. Both paths take the hold row `FOR UPDATE`, and the buyer's ask is written before
 * its refund posts (`refund_requested_at`), so a release that runs after a crash between the ask and the post posts the
 * asked-for refund instead of paying the seller ("count only refunds that posted before release": an ask in flight
 * always wins over the release, under its own refund key).
 *
 * One refund per purchase, for the whole amount: partial refunds are not built, so the refund number is always 1.
 */

export const MARKET_REFUND_POLICY_UNSET = 'market.refund_policy_unset' as const;
export const MARKET_REFUND_WINDOW_CLOSED = 'market.refund_window_closed' as const;
export const MARKET_PURCHASE_NOT_REFUNDABLE = 'market.purchase_not_refundable' as const;
export const MARKET_PURCHASE_NOT_FOUND = 'market.purchase_not_found' as const;
export const MARKET_PURCHASE_ALREADY_HELD = 'market.purchase_already_held' as const;

/** The one refund on a held purchase. Partial refunds are not built. */
const REFUND_NO = 1;

export type HoldState = 'held' | 'refunded' | 'released';

export interface PurchaseHold {
  state: HoldState;
  heldAmount: string;
  heldAt: string;
  windowEndsAt: string;
  refundRequestedAt: string | null;
  refundedAt: string | null;
  refundTxId: string | null;
  releasedAt: string | null;
  releaseTxId: string | null;
}

interface HoldRow {
  purchase_id: string;
  state: HoldState;
  held_amount: string;
  held_at: Date;
  window_ends_at: Date;
  refund_requested_at: Date | null;
  refunded_at: Date | null;
  refund_tx_id: string | null;
  released_at: Date | null;
  release_tx_id: string | null;
}

/** The hold columns with the purchase's own snapshot, for posting. */
interface HoldWithPurchase extends HoldRow {
  listing_id: string;
  buyer_id: string;
  asset_id: string;
  vendor_user_id: string;
  commission_bps: number;
}

export function toHold(row: HoldRow): PurchaseHold {
  return {
    state: row.state,
    heldAmount: formatAmount(parseAmount(row.held_amount)),
    heldAt: row.held_at.toISOString(),
    windowEndsAt: row.window_ends_at.toISOString(),
    refundRequestedAt: row.refund_requested_at ? row.refund_requested_at.toISOString() : null,
    refundedAt: row.refunded_at ? row.refunded_at.toISOString() : null,
    refundTxId: row.refund_tx_id,
    releasedAt: row.released_at ? row.released_at.toISOString() : null,
    releaseTxId: row.release_tx_id,
  };
}

const HOLD_COLUMNS = `h.purchase_id, h.state, h.held_amount::text AS held_amount, h.held_at, h.window_ends_at,
  h.refund_requested_at, h.refunded_at, h.refund_tx_id, h.released_at, h.release_tx_id`;

export interface HeldPurchaseDeps {
  sql: Sql;
  ledger: LedgerClient;
  now: () => Date;
  /** The owner's refund window in seconds, or null when unset. */
  refundWindowSeconds: number | null;
  /** The commerce service's receipt check: the ledger's answer is this exact request. */
  requireMatchingReceipt: (tx: LedgerTx, request: PostRequest) => Promise<void>;
  /** Best-effort affiliate legs once the house commission is paid (on release). Never throws. */
  afterRelease: (purchase: { id: string; vendorUserId: string; assetId: string; price: Amount; commissionBps: number }) => Promise<void>;
  log?: (message: string) => void;
}

export class HeldPurchases {
  constructor(private readonly deps: HeldPurchaseDeps) {}

  /** The hold of each purchase id that has one. */
  async holdsOf(purchaseIds: readonly string[]): Promise<Map<string, PurchaseHold>> {
    if (purchaseIds.length === 0) return new Map();
    const rows = await this.deps.sql.unsafe<HoldRow[]>(
      `SELECT ${HOLD_COLUMNS} FROM market.purchase_holds h WHERE h.purchase_id = ANY($1::uuid[])`,
      [purchaseIds as string[]],
    );
    return new Map(rows.map((row) => [row.purchase_id, toHold(row)]));
  }

  /**
   * "Buy again" while a purchase of this listing is held or still settling into a hold is one purchase: the new claim
   * is rejected before anything posts. Serialised per (listing, buyer), so of two claims racing, one goes on.
   * Returns false (and rejects the claim) when another purchase holds the place.
   */
  async claimIsTheOnlyHold(input: { purchaseId: string; listingId: string; buyerId: string }): Promise<boolean> {
    return transaction(
      this.deps.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`market.hold:${input.listingId}:${input.buyerId}`}))`;
        const [other] = await tx<Array<{ id: string }>>`
          SELECT p.id
            FROM market.purchases p
            LEFT JOIN market.purchase_holds h ON h.purchase_id = p.id
           WHERE p.listing_id = ${input.listingId}
             AND p.buyer_id = ${input.buyerId}
             AND p.id <> ${input.purchaseId}
             AND p.refund_window_seconds IS NOT NULL
             AND (p.status = 'pending' OR (p.status = 'settled' AND h.state = 'held'))
           LIMIT 1
        `;
        if (!other) return true;
        await tx`
          UPDATE market.purchases
             SET status = 'rejected', rejection_code = ${MARKET_PURCHASE_ALREADY_HELD}
           WHERE id = ${input.purchaseId} AND status = 'pending'
        `;
        return false;
      },
      { isolation: 'read committed' },
    );
  }

  /** The hold post for a claim snapshot. */
  holdRequest(claim: { id: string; listingId: string; buyerId: string; assetId: string; price: Amount }): PostRequest {
    return recipes.marketPurchaseHold({
      purchaseId: claim.id,
      listingId: claim.listingId,
      buyerId: claim.buyerId,
      assetId: claim.assetId,
      amount: claim.price,
    });
  }

  /**
   * Settle a claim whose hold posted: the purchase row and its hold row in one transaction. The window ends the
   * claim's own snapshot of seconds after the settle. Returns false when the row was no longer pending.
   */
  async settleHeld(input: {
    purchaseId: string;
    listingId: string;
    buyerId: string;
    price: Amount;
    windowSeconds: number;
    holdTxId: string;
  }): Promise<boolean> {
    const at = this.deps.now();
    const ends = new Date(at.getTime() + input.windowSeconds * 1000);
    return transaction(
      this.deps.sql,
      async (tx) => {
        const settled = await tx<Array<{ id: string }>>`
          UPDATE market.purchases
             SET status = 'settled', ledger_tx_id = ${input.holdTxId}, settled_at = ${at.toISOString()}::timestamptz,
                 rejection_code = NULL
           WHERE id = ${input.purchaseId} AND status = 'pending'
          RETURNING id
        `;
        if (settled.length === 0) return false;
        await tx`
          INSERT INTO market.purchase_holds (
            purchase_id, listing_id, buyer_id, held_amount, hold_tx_id, held_at, window_ends_at
          ) VALUES (
            ${input.purchaseId}, ${input.listingId}, ${input.buyerId}, ${formatAmount(input.price)}::numeric,
            ${input.holdTxId}, ${at.toISOString()}::timestamptz, ${ends.toISOString()}::timestamptz
          )
        `;
        return true;
      },
      { isolation: 'read committed' },
    );
  }

  /**
   * The buyer asks for the whole amount back. Inside the window only, with the owner's refund policy set. A retry
   * after the refund posted returns the same refunded hold; the refund posts once under `market:refund:<id>:1`.
   */
  async refund(input: { buyerId: string; purchaseId: string }): Promise<PurchaseHold> {
    const [purchase] = await this.deps.sql<Array<{ buyer_id: string; status: string }>>`
      SELECT buyer_id, status FROM market.purchases WHERE id = ${input.purchaseId}
    `;
    if (!purchase || purchase.buyer_id !== input.buyerId) {
      throw new MarketError('No purchase of yours has this id', MARKET_PURCHASE_NOT_FOUND);
    }
    if (this.deps.refundWindowSeconds === null) {
      throw new MarketError('The refund policy is not decided', MARKET_REFUND_POLICY_UNSET);
    }
    const asked = await transaction(
      this.deps.sql,
      async (tx) => {
        const [hold] = await tx.unsafe<HoldWithPurchase[]>(
          `SELECT ${HOLD_COLUMNS}, p.listing_id, p.buyer_id, p.asset_id, p.vendor_user_id, p.commission_bps
             FROM market.purchase_holds h JOIN market.purchases p ON p.id = h.purchase_id
            WHERE h.purchase_id = $1
            FOR UPDATE OF h`,
          [input.purchaseId],
        );
        if (!hold) throw new MarketError('This purchase was not held, so it has no refund window', MARKET_PURCHASE_NOT_REFUNDABLE);
        if (hold.state === 'refunded' || hold.refund_requested_at) return hold;
        if (hold.state === 'released' || this.deps.now() >= hold.window_ends_at) {
          throw new MarketError('The refund window has ended', MARKET_REFUND_WINDOW_CLOSED);
        }
        const [updated] = await tx.unsafe<HoldWithPurchase[]>(
          `UPDATE market.purchase_holds h SET refund_requested_at = $2::timestamptz
            FROM market.purchases p
            WHERE h.purchase_id = $1 AND p.id = h.purchase_id AND h.state = 'held' AND h.refund_requested_at IS NULL
           RETURNING ${HOLD_COLUMNS}, p.listing_id, p.buyer_id, p.asset_id, p.vendor_user_id, p.commission_bps`,
          [input.purchaseId, this.deps.now().toISOString()],
        );
        if (!updated) throw new MarketError('Refund ask was not written', 'market.purchase_not_written');
        return updated;
      },
      { isolation: 'read committed' },
    );
    if (asked.state === 'refunded') return toHold(asked);
    const tx = await this.post(this.refundRequest(asked));
    return this.finishRefund(input.purchaseId, tx.id);
  }

  /**
   * Finish every hold whose window has ended: an asked-for refund posts first; otherwise the pot is released to the
   * seller. A row another worker is on is skipped. Returns how many holds this run finished.
   */
  async releaseDue(limit = 20): Promise<number> {
    const due = await this.deps.sql<Array<{ purchase_id: string }>>`
      SELECT purchase_id FROM market.purchase_holds
       WHERE state = 'held' AND (window_ends_at <= ${this.deps.now().toISOString()}::timestamptz OR refund_requested_at IS NOT NULL)
       ORDER BY window_ends_at ASC, purchase_id ASC
       LIMIT ${limit}
    `;
    let done = 0;
    for (const { purchase_id } of due) {
      try {
        if (await this.finishOne(purchase_id)) done += 1;
      } catch (err) {
        // The pot stays held; the next run tries again under the same key.
        this.deps.log?.(`market.hold_finish_failed ${purchase_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return done;
  }

  private async finishOne(purchaseId: string): Promise<boolean> {
    return transaction(
      this.deps.sql,
      async (tx) => {
        const [hold] = await tx.unsafe<HoldWithPurchase[]>(
          `SELECT ${HOLD_COLUMNS}, p.listing_id, p.buyer_id, p.asset_id, p.vendor_user_id, p.commission_bps
             FROM market.purchase_holds h JOIN market.purchases p ON p.id = h.purchase_id
            WHERE h.purchase_id = $1 AND h.state = 'held'
            FOR UPDATE OF h SKIP LOCKED`,
          [purchaseId],
        );
        if (!hold) return false;
        if (hold.refund_requested_at) {
          const posted = await this.post(this.refundRequest(hold));
          const rows = await tx`
            UPDATE market.purchase_holds
               SET state = 'refunded', refund_tx_id = ${posted.id}, refunded_at = ${this.deps.now().toISOString()}::timestamptz
             WHERE purchase_id = ${purchaseId} AND state = 'held'
            RETURNING purchase_id
          `;
          return rows.length > 0;
        }
        if (this.deps.now() < hold.window_ends_at) return false;
        const held = parseAmount(hold.held_amount);
        const posted = await this.post(
          recipes.marketPurchaseRelease({
            purchaseId,
            listingId: hold.listing_id,
            buyerId: hold.buyer_id,
            assetId: hold.asset_id,
            amount: held,
            heldAmount: held,
            refundedAmount: 0n,
            vendorUserId: hold.vendor_user_id,
            commissionBps: hold.commission_bps,
          }),
        );
        const rows = await tx`
          UPDATE market.purchase_holds
             SET state = 'released', release_tx_id = ${posted.id}, released_at = ${this.deps.now().toISOString()}::timestamptz
           WHERE purchase_id = ${purchaseId} AND state = 'held' AND refund_requested_at IS NULL
          RETURNING purchase_id
        `;
        if (rows.length === 0) return false;
        await this.deps.afterRelease({
          id: purchaseId,
          vendorUserId: hold.vendor_user_id,
          assetId: hold.asset_id,
          price: held,
          commissionBps: hold.commission_bps,
        });
        return true;
      },
      { isolation: 'read committed' },
    );
  }

  private refundRequest(hold: HoldWithPurchase): PostRequest {
    return recipes.marketPurchaseRefund({
      purchaseId: hold.purchase_id,
      listingId: hold.listing_id,
      buyerId: hold.buyer_id,
      assetId: hold.asset_id,
      amount: parseAmount(hold.held_amount),
      refundNo: REFUND_NO,
    });
  }

  private async finishRefund(purchaseId: string, refundTxId: string): Promise<PurchaseHold> {
    await this.deps.sql`
      UPDATE market.purchase_holds
         SET state = 'refunded', refund_tx_id = ${refundTxId}, refunded_at = ${this.deps.now().toISOString()}::timestamptz
       WHERE purchase_id = ${purchaseId} AND state = 'held' AND refund_requested_at IS NOT NULL
    `;
    const [row] = await this.deps.sql.unsafe<HoldRow[]>(`SELECT ${HOLD_COLUMNS} FROM market.purchase_holds h WHERE h.purchase_id = $1`, [
      purchaseId,
    ]);
    if (!row || row.state !== 'refunded') throw new MarketError('Refund did not persist', 'market.purchase_not_written');
    return toHold(row);
  }

  private async post(request: PostRequest): Promise<LedgerTx> {
    const tx = await this.deps.ledger.post(request).catch((error: unknown) => {
      if (error instanceof LedgerError && error.code === IDEMPOTENCY_CONFLICT_CODE) {
        throw new MarketError('Ledger receipt does not match this purchase', 'market.purchase_receipt_mismatch');
      }
      throw error;
    });
    if (tx.entries.length > 0) await this.deps.requireMatchingReceipt(tx, request);
    return tx;
  }
}
