import type { Sql } from 'postgres';
import { parseAmount, recipes, type Amount, type LedgerClient, type LedgerTx } from '@intafaced/ledger-client';
import { MarketError } from '../vendor-service.js';
import { postWithReceipt, requireMatchingReceipt } from './ledger-receipt.js';
import { toPurchase, type PurchaseRecord, type PurchaseRow } from './purchase-record.js';

/**
 * A purchase held until its refund window ends (MC-market-02, J-more-catalogue-02 #4 to #6).
 *
 * Whether a new purchase is held is the owner's switch (`MARKET_PURCHASE_HOLD`), never whether a window happens to be
 * filled. With the switch on, the window (`MARKET_REFUND_WINDOW_SECONDS`) is copied onto the claim; a blank window
 * refuses `market.refund_window_unset`, and a blank sweep interval (`MARKET_RELEASE_SWEEP_SECONDS`, so nothing would
 * ever release the pot) refuses `market.release_sweep_unset`, both before any claim row. With it off, purchases pay
 * through as before.
 *
 *   hold      `marketPurchaseHold`     market:hold:<purchase>       pending → held
 *   refund    `marketPurchaseRefund`   market:refund:<purchase>:1   held → refunded   (the seller, inside the window)
 *   release   `marketPurchaseRelease`  market:release:<purchase>    held → released  (the sweep, once the window ended)
 *
 * Exactly one outcome wins: each first claims `outcome` with one conditional update from held with no outcome, a refund
 * only before the window's end and a release only from it, and the database refuses to change a claimed outcome. The
 * posting follows the claim, so a crash between them leaves a held row with its outcome claimed; the sweep and a retried
 * refund post again under the same key (the ledger answers with the original transaction) and finish it. The whole
 * price is refunded or released, so refund number 1 is the only refund on a purchase.
 *
 * The seller's money (and the affiliate leg on the house commission) arrives only at release.
 */

export const MARKET_REFUND_WINDOW_UNSET = 'market.refund_window_unset' as const;
export const MARKET_RELEASE_SWEEP_UNSET = 'market.release_sweep_unset' as const;
export const MARKET_HELD_POT_SHORT = 'market.held_pot_short' as const;
export const MARKET_PURCHASE_ALREADY_HELD = 'market.purchase_already_held' as const;
export const MARKET_REFUND_NOT_HELD = 'market.refund_not_held' as const;
export const MARKET_REFUND_FORBIDDEN = 'market.refund_forbidden' as const;
export const MARKET_PURCHASE_NOT_FOUND = 'market.purchase_not_found' as const;

/** The owner's hold switch and refund window. Off: every purchase pays through. */
export interface PurchaseHoldConfig {
  on: boolean;
  /** Whole seconds, or null while the owner has not set one. Never defaulted. */
  refundWindowSeconds: number | null;
  /** Whole seconds between release sweeps, or null while the owner has not set one. Never defaulted. */
  releaseSweepSeconds: number | null;
}

export interface HeldPurchaseDeps {
  sql: Sql;
  ledger: LedgerClient;
  now: () => Date;
  /**
   * Best-effort affiliate legs on the house commission, after a release posts and before its row is marked released,
   * so a crash between them is sent again (under the legs' own keys) when the sweep finishes the row. Never throws.
   */
  afterRelease: (purchase: PurchaseRecord, price: Amount) => Promise<void>;
  /** Told about each row a sweep could not finish; that row stays held for the next sweep. */
  onSweepError?: (purchaseId: string, err: unknown) => void;
}

export interface ReleaseSweepResult {
  released: number;
  refunded: number;
  failed: number;
}

/** The claim's flow for a new purchase: the switch decides, and a blank window refuses before any row. */
export function claimFlow(config: PurchaseHoldConfig | undefined): { flow: 'pay' | 'hold'; refundWindowSeconds: number | null } {
  if (!config?.on) return { flow: 'pay', refundWindowSeconds: null };
  const seconds = config.refundWindowSeconds;
  if (seconds == null || !Number.isInteger(seconds) || seconds <= 0) {
    throw new MarketError(
      'The refund window is not set — a held purchase cannot start until the owner sets it',
      MARKET_REFUND_WINDOW_UNSET,
    );
  }
  const sweep = config.releaseSweepSeconds;
  if (sweep == null || !Number.isInteger(sweep) || sweep <= 0) {
    throw new MarketError(
      'The release sweep is not set — a held purchase would never be released, so none can start until the owner sets it',
      MARKET_RELEASE_SWEEP_UNSET,
    );
  }
  return { flow: 'hold', refundWindowSeconds: seconds };
}

function positive(price: string): Amount {
  const amount = parseAmount(price);
  if (amount <= 0n) throw new MarketError('Purchase price must be positive', 'market.listing_invalid_price');
  return amount;
}

/** A refund or release draws on the buyer's held pot: too little there is a broken book, never the buyer's balance. */
const potShort = { insufficient: () => new MarketError('The held pot is short of this purchase', MARKET_HELD_POT_SHORT) };

const heldInput = (p: PurchaseRecord) => ({
  purchaseId: p.id,
  listingId: p.listingId,
  buyerId: p.buyerId,
  assetId: p.assetId,
  amount: positive(p.price),
});

export class HeldPurchases {
  constructor(private readonly deps: HeldPurchaseDeps) {}

  private async load(purchaseId: string): Promise<PurchaseRecord | null> {
    const [row] = await this.deps.sql<PurchaseRow[]>`SELECT * FROM market.purchases WHERE id = ${purchaseId}`;
    return row ? toPurchase(row) : null;
  }

  /**
   * Charge a claimed hold-flow purchase into its pot and mark it held. Posts from the claim snapshot only. A retry posts
   * the same key and body and gets the original transaction, so a lost reply holds the money once.
   */
  async hold(claimed: PurchaseRecord): Promise<PurchaseRecord> {
    if (claimed.flow !== 'hold' || claimed.refundWindowSeconds == null) {
      throw new MarketError('This purchase is not a held purchase', 'market.purchase_conflict');
    }
    const tx = await postWithReceipt(this.deps.ledger, recipes.marketPurchaseHold(heldInput(claimed)));
    return this.markHeld(claimed, tx.id);
  }

  /**
   * A pending held purchase whose hold is already on the ledger (the reply or the row's update was lost) is finished
   * from that receipt, whatever the listing's state now: the buyer's money is in the pot and the row must say so. Null
   * when the ledger holds no such hold or cannot be asked, so the caller's fresh gates still apply. Never posts.
   */
  async resumePostedHold(pending: PurchaseRecord): Promise<PurchaseRecord | null> {
    if (pending.status !== 'pending' || pending.flow !== 'hold' || pending.refundWindowSeconds == null) return null;
    const request = recipes.marketPurchaseHold(heldInput(pending));
    let tx: LedgerTx | null;
    try {
      tx = await this.deps.ledger.getTxByKey(request.idempotencyKey);
    } catch {
      return null;
    }
    if (!tx) return null;
    await requireMatchingReceipt(this.deps.ledger, tx, request);
    return this.markHeld(pending, tx.id);
  }

  private async markHeld(claimed: PurchaseRecord, txId: string): Promise<PurchaseRecord> {
    if (claimed.refundWindowSeconds == null) {
      throw new MarketError('This purchase is not a held purchase', 'market.purchase_conflict');
    }
    const holdPostedAt = this.deps.now();
    const endsAt = new Date(holdPostedAt.getTime() + claimed.refundWindowSeconds * 1000);
    const [row] = await this.deps.sql<PurchaseRow[]>`
      UPDATE market.purchases
         SET status = 'held',
             ledger_tx_id = ${txId},
             hold_posted_at = ${holdPostedAt.toISOString()}::timestamptz,
             refund_window_ends_at = ${endsAt.toISOString()}::timestamptz
       WHERE id = ${claimed.id}
         AND status = 'pending'
         AND flow = 'hold'
      RETURNING *
    `;
    if (row) return toPurchase(row);
    const reload = await this.load(claimed.id);
    if (reload && reload.status !== 'pending' && reload.status !== 'rejected') return reload;
    if (reload?.status === 'rejected') {
      throw new MarketError(reload.rejectionCode ?? 'Purchase previously rejected', 'market.purchase_conflict');
    }
    throw new MarketError('Purchase hold returned no row', 'market.purchase_not_written');
  }

  /**
   * The buyer asks for a refund of a held purchase inside its window. Records when, once; the seller decides. A second
   * request returns the stored row.
   */
  async requestRefund(input: { buyerId: string; purchaseId: string }): Promise<PurchaseRecord> {
    const purchase = await this.load(input.purchaseId);
    if (!purchase || purchase.buyerId !== input.buyerId) {
      throw new MarketError('No purchase of yours has that id', MARKET_PURCHASE_NOT_FOUND);
    }
    const nowIso = this.deps.now().toISOString();
    const [row] = await this.deps.sql<PurchaseRow[]>`
      UPDATE market.purchases
         SET refund_requested_at = COALESCE(refund_requested_at, ${nowIso}::timestamptz)
       WHERE id = ${purchase.id}
         AND status = 'held'
         AND outcome IS NULL
         AND refund_window_ends_at > ${nowIso}::timestamptz
      RETURNING *
    `;
    if (row) return toPurchase(row);
    throw new MarketError('Only a held purchase inside its refund window can be refunded', MARKET_REFUND_NOT_HELD);
  }

  /**
   * The seller refunds a held purchase inside its window: the whole price goes back to the buyer once. Anyone but the
   * purchase's seller is refused. A retry after a lost reply posts the same key and finishes the row.
   */
  async refund(input: { sellerUserId: string; purchaseId: string }): Promise<PurchaseRecord> {
    const purchase = await this.load(input.purchaseId);
    if (!purchase) throw new MarketError('No purchase has that id', MARKET_PURCHASE_NOT_FOUND);
    if (purchase.vendorUserId !== input.sellerUserId) {
      throw new MarketError('Only the seller of this purchase can refund it', MARKET_REFUND_FORBIDDEN);
    }
    if (purchase.status === 'refunded') return purchase;
    const nowIso = this.deps.now().toISOString();
    const [claimed] = await this.deps.sql<PurchaseRow[]>`
      UPDATE market.purchases
         SET outcome = 'refund'
       WHERE id = ${purchase.id}
         AND status = 'held'
         AND outcome IS NULL
         AND refund_window_ends_at > ${nowIso}::timestamptz
      RETURNING *
    `;
    const current = claimed ? toPurchase(claimed) : await this.load(purchase.id);
    if (!current || current.status !== 'held' || current.outcome !== 'refund') {
      if (current?.status === 'refunded') return current;
      throw new MarketError('Only a held purchase inside its refund window can be refunded', MARKET_REFUND_NOT_HELD);
    }
    return this.finishRefund(current);
  }

  private async finishRefund(purchase: PurchaseRecord): Promise<PurchaseRecord> {
    const tx = await postWithReceipt(this.deps.ledger, recipes.marketPurchaseRefund({ ...heldInput(purchase), refundNo: 1 }), potShort);
    const [row] = await this.deps.sql<PurchaseRow[]>`
      UPDATE market.purchases
         SET status = 'refunded',
             outcome_tx_id = ${tx.id},
             outcome_at = ${this.deps.now().toISOString()}::timestamptz
       WHERE id = ${purchase.id}
         AND status = 'held'
         AND outcome = 'refund'
      RETURNING *
    `;
    if (row) return toPurchase(row);
    const reload = await this.load(purchase.id);
    if (reload?.status === 'refunded') return reload;
    throw new MarketError('Refund returned no row', 'market.purchase_not_written');
  }

  private async finishRelease(purchase: PurchaseRecord): Promise<PurchaseRecord> {
    const price = positive(purchase.price);
    const tx = await postWithReceipt(
      this.deps.ledger,
      recipes.marketPurchaseRelease({
        ...heldInput(purchase),
        heldAmount: price,
        refundedAmount: 0n,
        vendorUserId: purchase.vendorUserId,
        commissionBps: purchase.commissionBps,
      }),
      potShort,
    );
    // The affiliate legs go before the row is marked released, as the pay-through path sends them before settling: a
    // crash after the update would leave no held row for the sweep to finish, and the legs would never be sent.
    await this.deps.afterRelease({ ...purchase, outcomeTxId: tx.id }, price);
    const atIso = this.deps.now().toISOString();
    const [row] = await this.deps.sql<PurchaseRow[]>`
      UPDATE market.purchases
         SET status = 'released',
             outcome_tx_id = ${tx.id},
             outcome_at = ${atIso}::timestamptz,
             settled_at = ${atIso}::timestamptz
       WHERE id = ${purchase.id}
         AND status = 'held'
         AND outcome = 'release'
      RETURNING *
    `;
    if (row) return toPurchase(row);
    const reload = await this.load(purchase.id);
    if (reload?.status === 'released') return reload;
    throw new MarketError('Release returned no row', 'market.purchase_not_written');
  }

  /**
   * Release every held purchase whose window has ended, and finish any outcome a crash left claimed. One row's failure
   * (a ledger outage, a frozen account) leaves that row held for the next sweep and does not stop the others. Claimed
   * rows are finished in random order, so rows that keep failing can never fill every sweep and starve the rest.
   */
  async sweep(limit = 100): Promise<ReleaseSweepResult> {
    const nowIso = this.deps.now().toISOString();
    await this.deps.sql`
      UPDATE market.purchases
         SET outcome = 'release'
       WHERE id IN (
         SELECT id FROM market.purchases
          WHERE status = 'held'
            AND outcome IS NULL
            AND refund_window_ends_at <= ${nowIso}::timestamptz
          ORDER BY refund_window_ends_at ASC, id ASC
          LIMIT ${limit}
       )
         AND status = 'held'
         AND outcome IS NULL
         AND refund_window_ends_at <= ${nowIso}::timestamptz
    `;
    const rows = await this.deps.sql<PurchaseRow[]>`
      SELECT * FROM market.purchases
       WHERE status = 'held'
         AND outcome IS NOT NULL
       ORDER BY random()
       LIMIT ${limit}
    `;
    const result: ReleaseSweepResult = { released: 0, refunded: 0, failed: 0 };
    for (const row of rows) {
      const purchase = toPurchase(row);
      try {
        if (purchase.outcome === 'release') {
          await this.finishRelease(purchase);
          result.released += 1;
        } else {
          await this.finishRefund(purchase);
          result.refunded += 1;
        }
      } catch (err) {
        result.failed += 1;
        this.deps.onSweepError?.(purchase.id, err);
      }
    }
    return result;
  }

  /** The seller's held purchases with a refund request, oldest first. */
  async refundRequests(sellerUserId: string, limit: number): Promise<PurchaseRecord[]> {
    const rows = await this.deps.sql<PurchaseRow[]>`
      SELECT * FROM market.purchases
       WHERE vendor_user_id = ${sellerUserId}
         AND status = 'held'
         AND refund_requested_at IS NOT NULL
       ORDER BY refund_requested_at ASC, id ASC
       LIMIT ${limit}
    `;
    return rows.map(toPurchase);
  }
}
