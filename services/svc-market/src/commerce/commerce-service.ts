import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  formatAmount,
  IDEMPOTENCY_CONFLICT_CODE,
  LedgerError,
  MoneyError,
  parseAmount,
  recipes,
  sub,
  type Amount,
  type LedgerClient,
  type LedgerTx,
  type PostRequest,
} from '@intafaced/ledger-client';
import { decimalPriceFromDriver, purchasePriceTermsMatch } from './commerce-price.js';
import type { ActionApproval } from '@intafaced/contracts';
import { marketActionPayloadHash, readApprovalIds, type ActionApprovalConsumer } from '../action-approval-consume.js';
import { commissionOfSnapshot, queryOpsSales, type OpsSalesPage, type OpsSalesQuery } from '../ops/ops-sales.js';
import {
  affiliateLegAfterMarketPurchase,
  fireAffiliateAccrue,
  NoopAffiliateAccrue,
  type AffiliateAccruePort,
} from '../affiliate-accrue.js';
import { fireAffiliatePayout, NoopAffiliatePayout, type AffiliatePayoutPort } from '../affiliate-payout.js';
import {
  listingCategoryEnum,
  MARKET_CATEGORY_BUSINESS_KEY_REQUIRED,
  MARKET_CATEGORY_INVALID,
  MARKET_CATEGORY_NOT_WRITTEN,
  MARKET_CATEGORY_REASON_SHORT,
  optionalListingCategory,
  requireListingCategory,
} from './listing-categories.js';
import { MARKET_OPS_SCOPE, MarketError, type PublicVendorProfile, type VendorService } from '../vendor-service.js';
import { HeldPurchases, MARKET_PURCHASE_ALREADY_HELD, type PurchaseHold } from './held-purchase.js';

/** Public `listings` page size unpublished. Blank is not 50. */
export const MARKET_PUBLIC_LISTINGS_LIST_LIMIT_UNSET = 'market.public_listings_list_limit_unset' as const;

/** Owner `myListings` page size unpublished. Blank is not 50. */
export const MARKET_MY_LISTINGS_LIST_LIMIT_UNSET = 'market.my_listings_list_limit_unset' as const;

/** Owner `myPurchases` page size unpublished. Blank is not 50. */
export const MARKET_MY_PURCHASES_LIST_LIMIT_UNSET = 'market.my_purchases_list_limit_unset' as const;

/** Owner-published public-listings page size. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertPublicListingsListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new MarketError(MARKET_PUBLIC_LISTINGS_LIST_LIMIT_UNSET, MARKET_PUBLIC_LISTINGS_LIST_LIMIT_UNSET);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new MarketError(MARKET_PUBLIC_LISTINGS_LIST_LIMIT_UNSET, MARKET_PUBLIC_LISTINGS_LIST_LIMIT_UNSET);
  }
  return Math.min(50, n);
}

/** Owner-published my-listings page size. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertMyListingsListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new MarketError(MARKET_MY_LISTINGS_LIST_LIMIT_UNSET, MARKET_MY_LISTINGS_LIST_LIMIT_UNSET);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new MarketError(MARKET_MY_LISTINGS_LIST_LIMIT_UNSET, MARKET_MY_LISTINGS_LIST_LIMIT_UNSET);
  }
  return Math.min(50, n);
}

/** Owner-published my-purchases page size. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertMyPurchasesListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new MarketError(MARKET_MY_PURCHASES_LIST_LIMIT_UNSET, MARKET_MY_PURCHASES_LIST_LIMIT_UNSET);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new MarketError(MARKET_MY_PURCHASES_LIST_LIMIT_UNSET, MARKET_MY_PURCHASES_LIST_LIMIT_UNSET);
  }
  return Math.min(50, n);
}

/**
 * market.commerce — listings + one-time purchase with house commission (§8.7).
 *
 * No second balance book. Price and commission move only via `marketPurchase`.
 * Listing eligibility is re-computed from VendorService on every write that
 * cares — never a stored `is_listed` flag. Stake law stays in VendorService;
 * this class owns the commission half of the vendor→commerce lifecycle.
 *
 * House commission bps is owner-gated (D26-P1-M1 / M2 / D26-P0-10). When the
 * deployment has no rate configured (`commissionBps === null`):
 *   - createListing refuses before insert or slot claim
 *   - publicListings returns [] (shopfront does not advertise unsellable stock)
 *   - a fresh purchase refuses before any row or post
 * A purchase that already posted `marketPurchase` still settles on retry.
 * Never invent a platform rate. Explicit `0` is an owner free-commission
 * decision, not silence. Ledger recipe refuses blank/invalid bps so a
 * miswired caller cannot invent free commission at post time (#1761 owns
 * listing/premium fee recipe deepen — do not dual-edit market.ts here).
 *
 * Stage C3 listing subscriptions: one period is paid with the same
 * `marketPurchase` recipe as a one-time sale. Period seconds come from the
 * listing and are copied onto the purchase at claim — never a default month.
 * Cancel is a flag (no reverse recipe).
 * Past-due is computed from the clock vs `access_until`, never a fake paid
 * status. Leftover subscription rows without a period stay unsellable.
 */

export type OfferType = 'one_time' | 'subscription';
export type ListingStatus = 'active' | 'archived' | 'taken_down';
export type ListingSort = 'newest' | 'priceAsc' | 'priceDesc' | 'title';

export const MARKET_LISTINGS_SORT_UNSET = 'market.listings_sort_unset' as const;
export const MARKET_LISTINGS_SORT_UNKNOWN = 'market.listings_sort_unknown' as const;
export const MARKET_LISTINGS_CURSOR_INVALID = 'market.listings_cursor_invalid' as const;
export const MARKET_LISTING_TAKEN_DOWN = 'market.listing_taken_down' as const;
export const MARKET_TAKEDOWN_REASON_SHORT = 'market.takedown_reason_short' as const;
export const MARKET_TAKEDOWN_APPROVAL_MISMATCH = 'market.takedown_approval_mismatch' as const;
export const MARKET_CLIENT_REQUEST_ID_REQUIRED = 'market.client_request_id_required' as const;
export const MARKET_IDEMPOTENCY_CONFLICT = 'market.idempotency_conflict' as const;
export const MARKET_EARNINGS_WINDOW_UNSET = 'market.earnings_window_unset' as const;
export const MARKET_EARNINGS_VENDOR_REQUIRED = 'market.earnings_vendor_required' as const;
export const MARKET_OPS_REQUIRED = 'market.ops_required' as const;

const LISTING_SORTS: readonly ListingSort[] = ['newest', 'priceAsc', 'priceDesc', 'title'];
const CATALOGUE_BATCH = 64;
export type PurchaseStatus = 'pending' | 'settled' | 'rejected';

export interface ListingRecord {
  id: string;
  vendorId: string;
  title: string;
  description: string;
  offerType: OfferType;
  assetId: string;
  /** Decimal string — never a JS number. */
  price: string;
  /**
   * Access window length in whole seconds. Required on subscription listings.
   * Null on one-time listings and on leftover C3-era rows. Never defaulted.
   */
  periodSeconds: number | null;
  status: ListingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PublicListingRecord extends ListingRecord {
  /** That vendor's listings with status `active`. Integer, not a float. */
  vendorListingCount: number;
}

/** Shopfront detail. Vendor is the public profile — no seller user id. */
export interface PublicListingDetail {
  listing: ListingRecord;
  vendor: PublicVendorProfile;
  /** Listings of this vendor with status `active`. A count, not money. */
  activeListingCount: number;
}

export interface PublicListingsPage {
  items: PublicListingRecord[];
  nextCursor: string | null;
}

export interface EarningsSale {
  purchaseId: string;
  listingId: string;
  assetId: string;
  gross: string;
  commission: string;
  net: string;
  ledgerTxId: string;
  settledAt: string;
}

export interface EarningsAsset {
  assetId: string;
  gross: string;
  commission: string;
  net: string;
}

export interface EarningsReport {
  from: string;
  to: string;
  assets: EarningsAsset[];
  /** Settled sales in the window. Each ledger id is the purchase posting. */
  sales: EarningsSale[];
}

export interface TakedownResult {
  listingId: string;
  status: 'taken_down';
  reason: string;
  actorId: string;
  takenDownAt: string;
}

export interface ListingCategoryResult {
  listingId: string;
  category: string;
  actorId: string;
  reason: string;
  businessKey: string;
  recordedAt: string;
}

interface CategoryEventRow {
  id: string;
  business_key: string;
  listing_id: string;
  category: string;
  actor_id: string;
  reason: string;
  created_at: Date;
}

function toCategoryResult(row: CategoryEventRow): ListingCategoryResult {
  return {
    listingId: row.listing_id,
    category: row.category,
    actorId: row.actor_id,
    reason: row.reason,
    businessKey: row.business_key,
    recordedAt: row.created_at.toISOString(),
  };
}

function sameCategoryEvent(
  row: CategoryEventRow,
  filed: { listingId: string; category: string; reason: string; actorId: string },
): boolean {
  return (
    row.listing_id === filed.listingId && row.category === filed.category && row.reason === filed.reason && row.actor_id === filed.actorId
  );
}

function postgresCode(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
}

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
  ledgerTxId: string | null;
  rejectionCode: string | null;
  createdAt: string;
  settledAt: string | null;
  /** Paid access end. Set on settled subscription purchases; null for one-time. */
  accessUntil: string | null;
  /**
   * Listing period at claim, in whole seconds. Null when the listing period
   * was null. Never a default month.
   */
  periodSeconds: number | null;
  /** The owner's refund window at claim, in whole seconds. Null: a direct sale with no hold. */
  refundWindowSeconds: number | null;
  /** The hold once a held purchase settled: held, refunded or released. Null for a direct sale or before settle. */
  hold: PurchaseHold | null;
}

interface ListingRow {
  id: string;
  vendor_id: string;
  title: string;
  description: string;
  offer_type: OfferType;
  asset_id: string;
  /** Driver may yield a JS number if numeric is not text-mode — refuse, never String(). */
  price: unknown;
  period_seconds: number | string | null;
  /** Null on strategy and legacy one-time rows. Slug when this row is non-strategy. */
  category?: string | null;
  status: ListingStatus;
  created_at: Date;
  updated_at: Date;
  vendor_listing_count?: string;
  /** Microseconds since epoch, text, for the newest keyset. */
  created_us?: string;
}

interface PurchaseRow {
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
  refund_window_seconds?: number | string | null;
}

function toListing(row: ListingRow): ListingRecord {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    title: row.title,
    description: row.description,
    offerType: row.offer_type,
    assetId: row.asset_id,
    price: decimalPriceFromDriver(row.price),
    periodSeconds: row.period_seconds == null || row.period_seconds === '' ? null : Number(row.period_seconds),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toPurchase(row: PurchaseRow): PurchaseRecord {
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
    settledAt: row.settled_at ? row.settled_at.toISOString() : null,
    accessUntil: row.access_until ? row.access_until.toISOString() : null,
    periodSeconds: row.period_seconds == null || row.period_seconds === '' ? null : Number(row.period_seconds),
    refundWindowSeconds: row.refund_window_seconds == null || row.refund_window_seconds === '' ? null : Number(row.refund_window_seconds),
    hold: null,
  };
}

export interface SubscriptionAccess {
  granted: true;
  listingId: string;
  buyerId: string;
  accessUntil: string;
}

function addSeconds(from: Date, seconds: number): Date {
  return new Date(from.getTime() + seconds * 1000);
}

export interface CommerceConfig {
  /**
   * House commission in bps, or `null` when the owner has not set a rate.
   * Null is the refuse-closed default — never silently 0.
   */
  commissionBps: number | null;
  /** Identity accrue after house commission posts. Default noop without IDENTITY_URL. */
  affiliateAccrue?: AffiliateAccruePort;
  /** Identity payout after accrue. Default noop without IDENTITY_URL. */
  affiliatePayout?: AffiliatePayoutPort;
  /** Clock for access windows. Tests inject; production uses wall time. */
  now?: () => Date;
  /**
   * The owner's refund window in whole seconds, or null / absent when unset. Set: purchases are held until it ends.
   * Unset: a direct sale, and a refund ask refuses `market.refund_policy_unset`. Never a default.
   */
  refundWindowSeconds?: number | null;
  /** Where the held-purchase jobs report a hold or claim they could not finish this run. */
  log?: (message: string) => void;
}

export class CommerceService {
  private readonly affiliateAccrue: AffiliateAccruePort;
  private readonly affiliatePayout: AffiliatePayoutPort;
  readonly held: HeldPurchases;

  constructor(
    private readonly sql: Sql,
    private readonly vendors: VendorService,
    private readonly ledger: LedgerClient,
    private readonly config: CommerceConfig,
  ) {
    this.affiliateAccrue = config.affiliateAccrue ?? new NoopAffiliateAccrue();
    this.affiliatePayout = config.affiliatePayout ?? new NoopAffiliatePayout();
    this.held = new HeldPurchases({
      sql,
      ledger,
      now: () => this.now(),
      refundWindowSeconds: config.refundWindowSeconds ?? null,
      requireMatchingReceipt: (tx, request) => this.requireMatchingReceipt(tx, request),
      afterRelease: (p) => this.afterHeldRelease(p),
      log: config.log,
    });
  }

  /** Each purchase with its hold, when it has one. */
  private async withHolds(rows: PurchaseRecord[]): Promise<PurchaseRecord[]> {
    const holds = await this.held.holdsOf(rows.map((row) => row.id));
    return rows.map((row) => ({ ...row, hold: holds.get(row.id) ?? null }));
  }

  /** The buyer's refund ask on a held purchase; returns the purchase as stored after it. */
  async refundPurchase(input: { buyerId: string; purchaseId: string }): Promise<PurchaseRecord> {
    await this.held.refund(input);
    const [row] = await this.sql<PurchaseRow[]>`SELECT * FROM market.purchases WHERE id = ${input.purchaseId}`;
    if (!row) throw new MarketError('Refund did not persist', 'market.purchase_not_written');
    const [withHold] = await this.withHolds([toPurchase(row)]);
    return withHold!;
  }

  private now(): Date {
    return this.config.now?.() ?? new Date();
  }

  /** What this deployment's commission rate is — including that it is not one. */
  programme(): { commissionBps: number | null; commissionConfigured: boolean } {
    return {
      commissionBps: this.config.commissionBps,
      commissionConfigured: this.config.commissionBps !== null,
    };
  }

  /**
   * Refuse-closed commission gate for every money-adjacent commerce door.
   * Blank env is not free commission — that requires an explicit owner `0`.
   */
  private requireCommissionConfigured(): number {
    if (this.config.commissionBps === null) {
      throw new MarketError(
        'House commission rate is not configured — marketplace commerce refuses until the owner sets MARKET_HOUSE_COMMISSION_BPS',
        'market.commission_not_configured',
      );
    }
    return this.config.commissionBps;
  }

  async createListing(input: {
    userId: string;
    title: string;
    description: string;
    offerType: OfferType;
    assetId: string;
    /** Decimal string. */
    price: string;
    /** Whole seconds. Required for subscription; forbidden for one-time. No default. */
    periodSeconds?: number | null;
    /**
     * Product-enum slug. Optional on one-time: null, omitted, and whitespace
     * stay uncategorised. Checked only when a slug is given.
     * Strategy listings stay uncategorised in this slice — a slug there refuses.
     */
    category?: string | null;
  }): Promise<ListingRecord> {
    // Commission law before stake burn: a blank rate must not consume a slot
    // for inventory that can never settle (D26-P1-M2). Same door for
    // subscription listings — C3 does not invent a free-cut shopfront.
    this.requireCommissionConfigured();

    const periodSeconds = this.resolveCreatePeriod(input.offerType, input.periodSeconds);

    const title = input.title.trim();
    const description = input.description.trim();
    const assetId = input.assetId.trim();
    if (!title) throw new MarketError('A listing needs a title', 'market.listing_title_required');
    if (!description) throw new MarketError('A listing needs a description', 'market.listing_description_required');
    if (!assetId) throw new MarketError('A listing needs an asset id', 'market.listing_asset_required');

    let price;
    try {
      price = parseAmount(input.price);
    } catch {
      throw new MarketError('Listing price must be a positive decimal string', 'market.listing_invalid_price');
    }
    if (price <= 0n) {
      throw new MarketError('Listing price must be positive', 'market.listing_invalid_price');
    }

    // Create gate ≠ public "listed". A vendor is listed only AFTER they hold a
    // usable slot; the first listing is what claims that slot. Using
    // listingEligibility here would refuse every first listing with
    // market.slot_required (chicken-and-egg). Create requires: approved vendor
    // + claimSlot success (stake capacity / not exhausted). Public catalogue and
    // purchase still re-read listingEligibility so unstaked vendors drop out.
    const vendor = await this.vendors.myVendor(input.userId);
    if (!vendor) {
      throw new MarketError('You have not applied to be a vendor', 'market.vendor_not_found');
    }
    if (vendor.status !== 'approved') {
      throw new MarketError('Only an approved vendor can create listings', 'market.vendor_not_approved');
    }

    // One-time may stay null. A given slug must be the product enum.
    // Strategy rows stay null. Do not backfill existing uncategorised rows.
    const category = this.categoryForCreate(input.offerType, input.category);

    const priceStr = formatAmount(price);

    // Insert listing first so the id can name the slot claim (idempotent ref).
    const inserted = await this.sql<ListingRow[]>`
      INSERT INTO market.listings (
        vendor_id, title, description, offer_type, asset_id, price, period_seconds, status, category
      )
      VALUES (
        ${vendor.id},
        ${title},
        ${description},
        ${input.offerType},
        ${assetId},
        ${priceStr}::numeric,
        ${periodSeconds},
        'active',
        ${category}
      )
      RETURNING *
    `;
    const row = inserted[0];
    if (!row) throw new MarketError('Listing insert returned no row', 'market.listing_not_written');

    try {
      await this.vendors.claimSlot({ userId: input.userId, ref: row.id });
    } catch (err) {
      // Roll the orphan listing back — a listing without a slot must not stay active.
      await this.sql`DELETE FROM market.listings WHERE id = ${row.id}`;
      throw err;
    }

    return toListing(row);
  }

  /** Product enum. Not an owner env list, and not empty when the shop is quiet. */
  listingCategories(): readonly string[] {
    return listingCategoryEnum();
  }

  /**
   * Category stored on create. One-time: null when omitted. Strategy: always
   * null — a slug on a strategy listing is not filed in this slice.
   */
  private categoryForCreate(offerType: OfferType, category: string | null | undefined): string | null {
    if (offerType === 'subscription') {
      if (category != null && category.trim() !== '') {
        throw new MarketError(MARKET_CATEGORY_INVALID, MARKET_CATEGORY_INVALID);
      }
      return null;
    }
    return optionalListingCategory(category);
  }

  /**
   * One-time listing that names a product category. Not a strategy subscription.
   * Blank category is not "uncategorised" on this door. Blank price is not free.
   * Strategy publish stays on createListing(subscription) and writes no category.
   * createListing(one_time) may omit the category until the screen picker ships.
   */
  async createNonStrategyListing(input: {
    userId: string;
    title: string;
    description: string;
    assetId: string;
    price?: string | null;
    category?: string | null;
  }): Promise<ListingRecord & { category: string }> {
    const category = requireListingCategory(input.category);
    if (input.price == null || input.price.trim() === '') {
      throw new MarketError('Listing price must be a positive decimal string', 'market.listing_invalid_price');
    }
    const row = await this.createListing({
      userId: input.userId,
      title: input.title,
      description: input.description,
      offerType: 'one_time',
      assetId: input.assetId,
      price: input.price,
      category,
    });
    return { ...row, category };
  }

  async archiveListing(input: { userId: string; listingId: string }): Promise<ListingRecord> {
    const listing = await this.requireOwnedListing(input.userId, input.listingId);
    if (listing.status === 'taken_down') {
      throw new MarketError(MARKET_LISTING_TAKEN_DOWN, MARKET_LISTING_TAKEN_DOWN);
    }
    if (listing.status === 'archived') return listing;

    const updated = await this.sql<ListingRow[]>`
      UPDATE market.listings
         SET status = 'archived', updated_at = now()
       WHERE id = ${input.listingId}
      RETURNING *
    `;
    const row = updated[0];
    if (!row) throw new MarketError('No listing with that id', 'market.listing_not_found');
    // Free the slot so capacity returns — release is idempotent on missing.
    try {
      await this.vendors.releaseSlot({ userId: input.userId, ref: input.listingId });
    } catch {
      // Slot may already be released (e.g. vendor suspended). Archive still stands.
    }
    return toListing(row);
  }

  /**
   * Caller's own listings. Page size is owner-published — omit is not 50.
   * Unset limit refuses before the dump, including when the caller has no vendor.
   */
  async myListings(userId: string, opts?: { limit?: number }): Promise<ListingRecord[]> {
    const limit = assertMyListingsListLimit(opts?.limit);
    const mine = await this.vendors.myVendor(userId);
    if (!mine) return [];
    const rows = await this.sql<ListingRow[]>`
      SELECT * FROM market.listings
       WHERE vendor_id = ${mine.id}
       ORDER BY created_at DESC
       LIMIT ${limit}
    `;
    return rows.map(toListing);
  }

  async getListing(listingId: string): Promise<ListingRecord | null> {
    const [row] = await this.sql<ListingRow[]>`SELECT * FROM market.listings WHERE id = ${listingId}`;
    return row ? toListing(row) : null;
  }

  /**
   * One shopfront listing (MC-market-01). Blank commission refuses before the
   * read. Missing, archived, taken down, a subscription with no period, an
   * unlisted vendor and a slot that is not live are the same null.
   * `market.stake_unavailable` is not folded into that null.
   */
  async publicListing(listingId: string): Promise<PublicListingDetail | null> {
    this.requireCommissionConfigured();
    const [row] = await this.sql<ListingRow[]>`
      SELECT id, vendor_id, title, description, offer_type, asset_id, price::text AS price,
             period_seconds, status, created_at, updated_at
        FROM market.listings
       WHERE id = ${listingId}
    `;
    if (!row || row.status !== 'active') return null;
    if (row.offer_type === 'subscription' && (row.period_seconds == null || row.period_seconds === '')) return null;

    const eligibility = await this.vendors.listingEligibility({ vendorId: row.vendor_id });
    if (!eligibility.listed) return null;
    if (!(await this.listingHoldsLiveSlot(row.id, row.vendor_id))) return null;
    const entitled = await this.vendors.entitledListingRefs(row.vendor_id);
    if (!entitled.has(row.id)) return null;
    const vendor = await this.vendors.publicProfile(row.vendor_id);
    if (!vendor) return null;

    const [countRow] = await this.sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n
        FROM market.listings
       WHERE vendor_id = ${row.vendor_id}
         AND status = 'active'
    `;
    const activeListingCount = Number(countRow?.n);
    if (!Number.isInteger(activeListingCount) || activeListingCount < 1) {
      throw new MarketError('market.vendor_listing_count_unreadable', 'market.vendor_listing_count_unreadable');
    }
    return { listing: toListing(row), vendor, activeListingCount };
  }

  /**
   * Public catalogue of active listings whose vendor is currently listed.
   * Eligibility is re-checked; a stored active flag alone is not enough.
   * A listing without a live slot `ref = listing.id` is dropped (crash orphan
   * after insert-before-claim must not sell). Stake outages drop the row like
   * `listedVendors` — nobody rather than a 500 for the whole page.
   *
   * Blank house commission → `[]`. Advertising inventory that purchase will
   * refuse invents a working marketplace; empty is the refuse-closed shopfront.
   *
   * Subscription listings appear only when they carry a period — leftover rows
   * without one cannot be sold, so they stay off the shopfront.
   * `taken_down` and `archived` are not `active`, so they never appear.
   *
   * Order is registration (`created_at ASC, id ASC`), same boring rule as `listed`
   * vendors — ranking / featured / newest-first is the paged procedure and owner-only.
   * Oldest-first also matches over-capacity prune (entitled slots keep the
   * earliest listings).
   *
   * Page size is owner-published — omit is not 50.
   */
  async publicListings(opts?: { limit?: number }): Promise<ListingRecord[]> {
    const limit = assertPublicListingsListLimit(opts?.limit);
    // Blank commission → empty shopfront. Do not advertise inventory that
    // purchase will refuse; that would invent a working marketplace.
    if (this.config.commissionBps === null) return [];
    const rows = await this.sql<ListingRow[]>`
      SELECT * FROM market.listings
       WHERE status = 'active'
         AND (
           offer_type = 'one_time'
           OR (offer_type = 'subscription' AND period_seconds IS NOT NULL)
         )
       ORDER BY created_at ASC, id ASC
       LIMIT ${limit * 3}
    `;
    const out: ListingRecord[] = [];
    for (const row of rows) {
      if (out.length >= limit) break;
      try {
        const elig = await this.vendors.listingEligibility({ vendorId: row.vendor_id });
        if (!elig.listed) continue;
        if (!(await this.listingHoldsLiveSlot(row.id, row.vendor_id))) continue;
        // Over-held after unstake: only the oldest usable slots stay shopfront.
        const entitled = await this.vendors.entitledListingRefs(row.vendor_id);
        if (!entitled.has(row.id)) continue;
        out.push(toListing(row));
      } catch (err) {
        // stake_unavailable and friends — drop this vendor's rows, keep the page.
        if (err instanceof MarketError && err.code === 'market.stake_unavailable') continue;
        throw err;
      }
    }
    return out;
  }

  /**
   * Active one-time listings in one product category. Strategy rows stay out
   * (`offer_type = subscription` or a null category). Blank category is not
   * the whole catalogue. Blank commission returns [] after the category and
   * limit checks, same as `publicListings`.
   *
   * This is a short page (limit only). A cursor for the category page is a
   * later slice — this method does not invent one.
   */
  async publicListingsByCategory(opts?: {
    category?: string | null;
    limit?: number;
  }): Promise<Array<ListingRecord & { category: string }>> {
    const limit = assertPublicListingsListLimit(opts?.limit);
    const category = requireListingCategory(opts?.category ?? null);
    if (this.config.commissionBps === null) return [];
    const rows = await this.sql<ListingRow[]>`
      SELECT * FROM market.listings
       WHERE status = 'active'
         AND offer_type = 'one_time'
         AND category = ${category}
       ORDER BY created_at ASC, id ASC
       LIMIT ${limit * 3}
    `;
    const out: Array<ListingRecord & { category: string }> = [];
    for (const row of rows) {
      if (out.length >= limit) break;
      if (row.category !== category) continue;
      try {
        const elig = await this.vendors.listingEligibility({ vendorId: row.vendor_id });
        if (!elig.listed) continue;
        if (!(await this.listingHoldsLiveSlot(row.id, row.vendor_id))) continue;
        const entitled = await this.vendors.entitledListingRefs(row.vendor_id);
        if (!entitled.has(row.id)) continue;
        out.push({ ...toListing(row), category });
      } catch (err) {
        if (err instanceof MarketError && err.code === 'market.stake_unavailable') continue;
        throw err;
      }
    }
    return out;
  }

  /**
   * Paged public catalogue. Same visibility as `publicListings`: active rows
   * only, so a taken-down listing stays out. Search, offer, asset, and sort
   * live here. `sort` is required — omit or blank is `market.listings_sort_unset`.
   * There is no default order. Price order is the numeric column, with id as
   * the tie-break. The cursor is an opaque keyset of that pair.
   * Page size is owner-published — omit is not 50. Blank house commission
   * returns an empty page after the limit and sort checks.
   */
  async publicListingsPage(opts?: {
    q?: string | undefined;
    offerType?: OfferType | undefined;
    assetId?: string | undefined;
    sort?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  }): Promise<PublicListingsPage> {
    const limit = assertPublicListingsListLimit(opts?.limit);
    const sort = resolveListingSort(opts?.sort);
    if (this.config.commissionBps === null) return { items: [], nextCursor: null };
    const cursor = decodeListingCursor(opts?.cursor, sort);
    const offerType = opts?.offerType ?? null;
    const assetId = opts?.assetId?.trim() ? opts.assetId.trim() : null;
    const needle = opts?.q?.trim() ? opts.q.trim().toLowerCase() : null;
    const items: PublicListingRecord[] = [];
    let scan = cursor;
    for (;;) {
      const rows = await this.catalogueBatch(sort, scan, offerType, assetId, needle);
      if (rows.length === 0) return { items, nextCursor: null };
      for (const row of rows) {
        scan = cursorFromRow(sort, row);
        if (!(await this.catalogueRowVisible(row))) continue;
        items.push(toPublicListing(row));
        if (items.length === limit) {
          return { items, nextCursor: encodeListingCursor(scan) };
        }
      }
      if (rows.length < CATALOGUE_BATCH) return { items, nextCursor: null };
    }
  }

  /**
   * Automatic recurring charge is not a second recipe. One period is `purchase`.
   * Named refuse so this door cannot be mistaken for a silent scheduler.
   */
  async subscribe(_input?: { listingId?: string }): Promise<never> {
    throw new MarketError(
      'Automatic recurring subscribe is not built — buy one period with purchase',
      'market.subscription_recurring_not_built',
    );
  }

  /**
   * One-time or one-period subscription purchase via `marketPurchase`.
   *
   * A pending row whose ledger already has this purchase settles before the
   * fresh gates only when an actual matching rich receipt is available. Price
   * and bps stay the snapshot on the row. The deployed HTTP port cannot look
   * the key up; without that proof the current fresh gates still apply.
   * A permitted retry posts the original key and terms. Settle is one update from
   * pending. This service does not post a reversing entry.
   *
   * Fresh order: commission configured → eligibility → claim row → re-check
   * sell gates → post from the claim snapshot → settle only while still pending.
   */
  async purchase(input: { buyerId: string; listingId: string; purchaseId: string }): Promise<PurchaseRecord> {
    const [stored] = await this.withHolds([await this.purchaseOnce(input)]);
    return stored!;
  }

  private async purchaseOnce(input: { buyerId: string; listingId: string; purchaseId: string }): Promise<PurchaseRecord> {
    if (!input.purchaseId?.trim()) {
      throw new MarketError('purchaseId is required', 'market.purchase_id_required');
    }

    const resumed = await this.resumePostedPurchase(input);
    if (resumed) return resumed;

    const commissionBps = this.requireCommissionConfigured();

    const listing = await this.getListing(input.listingId);
    if (listing?.status === 'taken_down') {
      throw new MarketError(MARKET_LISTING_TAKEN_DOWN, MARKET_LISTING_TAKEN_DOWN);
    }
    if (!listing || listing.status !== 'active') {
      throw new MarketError('No active listing with that id', 'market.listing_not_found');
    }
    if (listing.offerType === 'subscription') {
      this.requireSubscriptionPeriod(listing);
      await this.assertNotCancelled(listing.id, input.buyerId);
    }

    await this.assertListingSellable(listing);

    // Self-purchase compares the vendor's user. The payee written on the row
    // is selected from that vendor inside the claim, not from this read.
    const [vendorRow] = await this.sql<Array<{ user_id: string }>>`
      SELECT user_id FROM market.vendors WHERE id = ${listing.vendorId}
    `;
    if (!vendorRow) {
      throw new MarketError('No vendor for that listing', 'market.vendor_not_found');
    }
    if (vendorRow.user_id === input.buyerId) {
      throw new MarketError('You cannot buy your own listing', 'market.purchase_self');
    }

    const price = this.positiveDecimalPrice(listing.price);

    // A live hold on this listing makes "Buy again" one purchase: refuse before writing a claim. The claim itself
    // re-checks under a lock, for two claims racing.
    // Checked with the window off too: a direct purchase never stacks on a purchase still held from before.
    const [live] = await this.sql<Array<{ purchase_id: string }>>`
      SELECT purchase_id FROM market.purchase_holds
       WHERE listing_id = ${listing.id} AND buyer_id = ${input.buyerId} AND state = 'held' AND purchase_id <> ${input.purchaseId}
       LIMIT 1
    `;
    if (live) throw new MarketError('A purchase of this listing is already held or settling', MARKET_PURCHASE_ALREADY_HELD);

    // Claim / idempotent resume. Payee, asset, and period are copied from the
    // listing and vendor rows inside the insert — not taken as separate arguments.
    // A null listing period stays null. No default month.
    const claimed = await this.claimPurchase({
      purchaseId: input.purchaseId,
      listingId: listing.id,
      buyerId: input.buyerId,
      price: formatAmount(price),
      commissionBps,
      refundWindowSeconds: this.config.refundWindowSeconds ?? null,
    });
    if (claimed.status === 'pending' && claimed.refundWindowSeconds !== null) {
      const clearance = await this.held.clearHold({ purchaseId: claimed.id, listingId: claimed.listingId, buyerId: claimed.buyerId });
      if (clearance === 'refused') {
        const [now] = await this.sql<PurchaseRow[]>`SELECT * FROM market.purchases WHERE id = ${claimed.id}`;
        if (now?.status === 'settled') return this.ensureSubscriptionAccess(toPurchase(now), listing);
        if (now?.status === 'rejected' && now.rejection_code !== MARKET_PURCHASE_ALREADY_HELD) {
          throw new MarketError(now.rejection_code ?? 'Purchase previously rejected', 'market.purchase_conflict');
        }
        throw new MarketError('A purchase of this listing is already held or settling', MARKET_PURCHASE_ALREADY_HELD);
      }
    }
    if (claimed.status === 'settled') {
      return this.ensureSubscriptionAccess(claimed, listing);
    }
    if (claimed.status === 'rejected') {
      if (claimed.rejectionCode === MARKET_PURCHASE_ALREADY_HELD) {
        throw new MarketError('A purchase of this listing is already held or settling', MARKET_PURCHASE_ALREADY_HELD);
      }
      throw new MarketError(claimed.rejectionCode ?? 'Purchase previously rejected', 'market.purchase_conflict');
    }

    // Re-check after claim so a stake drop / suspend between claim and post cannot sell.
    const liveListing = await this.getListing(claimed.listingId);
    if (liveListing?.status === 'taken_down') {
      throw new MarketError(MARKET_LISTING_TAKEN_DOWN, MARKET_LISTING_TAKEN_DOWN);
    }
    if (!liveListing || liveListing.status !== 'active') {
      throw new MarketError('No active listing with that id', 'market.listing_not_found');
    }
    await this.assertListingSellable(liveListing);
    if (liveListing.offerType === 'subscription') {
      if (this.paidPeriodSeconds(claimed) == null) {
        throw new MarketError(
          'This subscription listing has no period — it cannot be sold until the vendor sets one',
          'market.subscription_period_unset',
        );
      }
      await this.assertNotCancelled(liveListing.id, claimed.buyerId);
    }

    // Post only from the claim snapshot — never re-read live env bps or a
    // price that may have changed under a different write path later.
    // A blank snapshot stays a typed refusal. Do not substitute the live
    // listing price or a made-up amount.
    const snapshotPrice = this.positiveDecimalPrice(claimed.price);
    const snapshotBps = claimed.commissionBps;

    if (claimed.refundWindowSeconds !== null) {
      return this.postHeld(claimed, snapshotPrice, claimed.refundWindowSeconds, liveListing);
    }

    try {
      const request = recipes.marketPurchase({
        purchaseId: claimed.id,
        listingId: claimed.listingId,
        buyerId: claimed.buyerId,
        vendorUserId: claimed.vendorUserId,
        assetId: claimed.assetId,
        price: snapshotPrice,
        commissionBps: snapshotBps,
      });
      const tx = await this.ledger.post(request).catch((error: unknown) => {
        // The ledger refuses a reused key whose body differs: another buyer's or other terms' payment
        // already holds this purchase id. Same answer as the receipt check below.
        if (error instanceof LedgerError && error.code === IDEMPOTENCY_CONFLICT_CODE) {
          throw new MarketError('Ledger receipt does not match this purchase', 'market.purchase_receipt_mismatch');
        }
        throw error;
      });
      // Older clients return the original receipt even when this key was used
      // with different terms. Never settle that different payment as this sale.
      if (tx.entries.length > 0) await this.requireMatchingReceipt(tx, request);

      // One update from pending. 0005 refuses a pending ledger_tx_id, and
      // refuses a later status rewrite. This service does not post a reverse.
      await this.notifyMarketAffiliateAccrue(claimed, snapshotPrice, snapshotBps);
      await this.notifyMarketAffiliatePayout(claimed, snapshotPrice, snapshotBps);

      const settledAtIso = this.now().toISOString();
      const settledRows = await this.sql<PurchaseRow[]>`
        UPDATE market.purchases
           SET status = 'settled',
               ledger_tx_id = ${tx.id},
               settled_at = ${settledAtIso}::timestamptz,
               rejection_code = NULL
         WHERE id = ${claimed.id}
           AND status = 'pending'
        RETURNING *
      `;
      const settled = settledRows[0];
      if (settled) return this.ensureSubscriptionAccess(toPurchase(settled), liveListing);

      // Another resume may have settled first, or a race rejected the row.
      const [reload] = await this.sql<PurchaseRow[]>`
        SELECT * FROM market.purchases WHERE id = ${claimed.id}
      `;
      if (reload?.status === 'settled') return this.ensureSubscriptionAccess(toPurchase(reload), liveListing);
      if (reload?.status === 'rejected') {
        throw new MarketError(reload.rejection_code ?? 'Purchase previously rejected', 'market.purchase_conflict');
      }
      throw new MarketError('Purchase settle returned no row', 'market.purchase_not_written');
    } catch (err) {
      if (err instanceof MarketError) throw err;
      const code =
        err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
          ? (err as { code: string }).code
          : 'market.purchase_failed';
      // A current rejection cannot erase an earlier uncertain post under this
      // key. Rows do not prove authoritative absence of all prior effects.
      // Retain the immutable pending claim for reconciliation on every error.
      if (code === 'ledger.insufficient_funds') {
        throw new MarketError('Insufficient balance for this purchase', 'market.insufficient_funds');
      }
      throw err;
    }
  }

  /**
   * Post the hold for a cleared claim and settle it. The seller is paid nothing and no affiliate leg fires until
   * release. Each post is begun under the clearance lock first, only while the claim is still pending, so the
   * stale-claim sweep never releases a claim whose post may still land. When the claim's only post fails in a way that
   * proves nothing committed, the claim is released and the buyer may buy again; any other failure keeps it pending for
   * a retry or the sweep. A retry posts the same key and terms; the ledger answers the first post.
   */
  private async postHeld(claimed: PurchaseRecord, price: Amount, windowSeconds: number, listing: ListingRecord): Promise<PurchaseRecord> {
    const request = this.held.holdRequest({ ...claimed, price });
    const claim = { purchaseId: claimed.id, listingId: claimed.listingId, buyerId: claimed.buyerId };
    const attemptNo = await this.held.beginHoldPost(claim);
    if (attemptNo === null) {
      const [now] = await this.sql<PurchaseRow[]>`SELECT * FROM market.purchases WHERE id = ${claimed.id}`;
      if (now?.status === 'settled') return this.ensureSubscriptionAccess(toPurchase(now), listing);
      throw new MarketError(now?.rejection_code ?? 'Purchase previously rejected', 'market.purchase_conflict');
    }
    let tx: LedgerTx;
    try {
      tx = await this.ledger.post(request).catch((error: unknown) => {
        if (error instanceof LedgerError && error.code === IDEMPOTENCY_CONFLICT_CODE) {
          throw new MarketError('Ledger receipt does not match this purchase', 'market.purchase_receipt_mismatch');
        }
        throw error;
      });
    } catch (err) {
      if (err instanceof MarketError) throw err;
      const insufficient =
        err !== null && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'ledger.insufficient_funds';
      await this.held.releaseRefusedClaim(
        claim,
        attemptNo,
        err,
        insufficient ? 'market.insufficient_funds' : 'market.purchase_hold_refused',
      );
      if (insufficient) throw new MarketError('Insufficient balance for this purchase', 'market.insufficient_funds');
      throw err;
    }
    if (tx.entries.length > 0) await this.requireMatchingReceipt(tx, request);
    await this.held.settleHeld({
      purchaseId: claimed.id,
      listingId: claimed.listingId,
      buyerId: claimed.buyerId,
      price,
      windowSeconds,
      holdTxId: tx.id,
    });
    const [reload] = await this.sql<PurchaseRow[]>`SELECT * FROM market.purchases WHERE id = ${claimed.id}`;
    if (reload?.status === 'settled') return this.ensureSubscriptionAccess(toPurchase(reload), listing);
    if (reload?.status === 'rejected') {
      throw new MarketError(reload.rejection_code ?? 'Purchase previously rejected', 'market.purchase_conflict');
    }
    throw new MarketError('Purchase settle returned no row', 'market.purchase_not_written');
  }

  /** A held purchase's affiliate legs fire once its release paid the house commission. Best-effort; never throws. */
  private async afterHeldRelease(p: {
    id: string;
    vendorUserId: string;
    assetId: string;
    price: Amount;
    commissionBps: number;
  }): Promise<void> {
    const claimed = { id: p.id, vendorUserId: p.vendorUserId, assetId: p.assetId } as PurchaseRecord;
    await this.notifyMarketAffiliateAccrue(claimed, p.price, p.commissionBps);
    await this.notifyMarketAffiliatePayout(claimed, p.price, p.commissionBps);
  }

  /** Best-effort; never throws. marketPurchase already posted. */
  private async notifyMarketAffiliateAccrue(claimed: PurchaseRecord, snapshotPrice: Amount, snapshotBps: number): Promise<void> {
    await fireAffiliateAccrue(
      this.affiliateAccrue,
      affiliateLegAfterMarketPurchase({
        purchaseId: claimed.id,
        vendorUserId: claimed.vendorUserId,
        snapshotPrice,
        snapshotBps,
        feeAsset: claimed.assetId,
      }),
    );
  }

  /** Best-effort payout after accrue; never throws. marketPurchase already posted. */
  private async notifyMarketAffiliatePayout(claimed: PurchaseRecord, snapshotPrice: Amount, snapshotBps: number): Promise<void> {
    await fireAffiliatePayout(
      this.affiliatePayout,
      affiliateLegAfterMarketPurchase({
        purchaseId: claimed.id,
        vendorUserId: claimed.vendorUserId,
        snapshotPrice,
        snapshotBps,
        feeAsset: claimed.assetId,
      }),
    );
  }

  /**
   * Caller's own purchases. Page size is owner-published — omit is not 50.
   */
  async purchasesOf(buyerId: string, opts?: { limit?: number }): Promise<PurchaseRecord[]> {
    const limit = assertMyPurchasesListLimit(opts?.limit);
    const rows = await this.sql<PurchaseRow[]>`
      SELECT * FROM market.purchases WHERE buyer_id = ${buyerId} ORDER BY created_at DESC
       LIMIT ${limit}
    `;
    return this.withHolds(rows.map(toPurchase));
  }

  /**
   * Vendor earnings for a required window. Gross, commission, and net are exact
   * decimals. Commission is each settled row's own `commission_bps`, floored
   * the same way `marketPurchase` floors. The sale list is those ledger postings.
   * No payout schedule and no payout batch.
   */
  opsSales(input: OpsSalesQuery): Promise<OpsSalesPage> {
    return queryOpsSales(this.sql, input);
  }

  async myEarnings(input: { userId: string; from?: string | undefined; to?: string | undefined }): Promise<EarningsReport> {
    const window = requireEarningsWindow(input.from, input.to);
    const mine = await this.vendors.myVendor(input.userId);
    if (!mine || (mine.status !== 'approved' && mine.status !== 'suspended')) {
      throw new MarketError(MARKET_EARNINGS_VENDOR_REQUIRED, MARKET_EARNINGS_VENDOR_REQUIRED);
    }
    const fromIso = window.from.toISOString();
    const toIso = window.to.toISOString();
    const rows = await this.sql<
      Array<{
        id: string;
        listing_id: string;
        asset_id: string;
        price: string;
        commission_bps: number;
        ledger_tx_id: string | null;
        settled_at: Date;
      }>
    >`
      SELECT p.id, p.listing_id, p.asset_id, p.price::text AS price, p.commission_bps,
             -- A released hold paid the seller in its release post, not in the hold.
             -- ... and on the day it was released, not the day it was held.
             COALESCE(h.release_tx_id, p.ledger_tx_id) AS ledger_tx_id, COALESCE(h.released_at, p.settled_at) AS settled_at
        FROM market.purchases p
        LEFT JOIN market.purchase_holds h ON h.purchase_id = p.id
       WHERE p.vendor_id = ${mine.id}
         AND p.status = 'settled'
         -- A held purchase is the seller's only once released.
         AND (h.purchase_id IS NULL OR h.state = 'released')
         AND COALESCE(h.released_at, p.settled_at) >= ${fromIso}::timestamptz
         AND COALESCE(h.released_at, p.settled_at) <= ${toIso}::timestamptz
       ORDER BY COALESCE(h.released_at, p.settled_at) ASC, p.id ASC
    `;
    const byAsset = new Map<string, { gross: Amount; commission: Amount; net: Amount }>();
    const sales: EarningsSale[] = [];
    for (const row of rows) {
      if (!row.ledger_tx_id || !row.settled_at) {
        throw new MarketError('Settled purchase is missing its ledger posting', 'market.purchase_not_written');
      }
      const gross = parseAmount(row.price);
      const commission = commissionOfSnapshot(row.price, row.commission_bps);
      const net = sub(gross, commission);
      const bucket = byAsset.get(row.asset_id) ?? { gross: 0n, commission: 0n, net: 0n };
      bucket.gross += gross;
      bucket.commission += commission;
      bucket.net += net;
      byAsset.set(row.asset_id, bucket);
      sales.push({
        purchaseId: row.id,
        listingId: row.listing_id,
        assetId: row.asset_id,
        gross: formatAmount(gross),
        commission: formatAmount(commission),
        net: formatAmount(net),
        ledgerTxId: row.ledger_tx_id,
        settledAt: row.settled_at.toISOString(),
      });
    }
    const assets = [...byAsset.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([assetId, bucket]) => ({
        assetId,
        gross: formatAmount(bucket.gross),
        commission: formatAmount(bucket.commission),
        net: formatAmount(bucket.net),
      }));
    return { from: fromIso, to: toIso, assets, sales };
  }

  /**
   * Operator category. `market:ops` is checked again here. The slug and the
   * audit row (actor, reason, business key) commit in one transaction.
   * The same business key returns the stored row and does not write a second
   * one. A reused key with a different listing, slug, reason, or actor conflicts.
   * Strategy listings stay uncategorised in this slice.
   */
  async setListingCategory(input: {
    actorId: string;
    actorScope: string;
    listingId: string;
    category: string | null | undefined;
    reason: string;
    businessKey: string;
  }): Promise<ListingCategoryResult> {
    if (input.actorScope !== MARKET_OPS_SCOPE) {
      throw new MarketError(MARKET_OPS_REQUIRED, MARKET_OPS_REQUIRED);
    }
    const businessKey = input.businessKey?.trim() ?? '';
    if (!businessKey || businessKey.length > 128) {
      throw new MarketError(MARKET_CATEGORY_BUSINESS_KEY_REQUIRED, MARKET_CATEGORY_BUSINESS_KEY_REQUIRED);
    }
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 10 || reason.length > 2000) {
      throw new MarketError(MARKET_CATEGORY_REASON_SHORT, MARKET_CATEGORY_REASON_SHORT);
    }
    const category = requireListingCategory(input.category);
    const filed = { listingId: input.listingId, category, reason, actorId: input.actorId };
    try {
      return await transaction(this.sql, async (tx) => {
        const [prior] = await tx<CategoryEventRow[]>`
          SELECT * FROM market.listing_category_events WHERE business_key = ${businessKey} FOR UPDATE
        `;
        if (prior) {
          if (!sameCategoryEvent(prior, filed)) {
            throw new MarketError(MARKET_IDEMPOTENCY_CONFLICT, MARKET_IDEMPOTENCY_CONFLICT);
          }
          return toCategoryResult(prior);
        }
        const [locked] = await tx<ListingRow[]>`
          SELECT * FROM market.listings WHERE id = ${input.listingId} FOR UPDATE
        `;
        if (!locked) throw new MarketError('No listing with that id', 'market.listing_not_found');
        if (locked.offer_type !== 'one_time') {
          throw new MarketError(MARKET_CATEGORY_INVALID, MARKET_CATEGORY_INVALID);
        }
        const [updated] = await tx<Array<{ id: string }>>`
          UPDATE market.listings
             SET category = ${category}, updated_at = now()
           WHERE id = ${input.listingId}
          RETURNING id
        `;
        if (!updated) throw new MarketError('No listing with that id', 'market.listing_not_found');
        const [inserted] = await tx<CategoryEventRow[]>`
          INSERT INTO market.listing_category_events (
            business_key, listing_id, category, actor_id, reason
          ) VALUES (
            ${businessKey},
            ${input.listingId},
            ${category},
            ${input.actorId},
            ${reason}
          )
          RETURNING *
        `;
        if (!inserted) throw new MarketError(MARKET_CATEGORY_NOT_WRITTEN, MARKET_CATEGORY_NOT_WRITTEN);
        return toCategoryResult(inserted);
      });
    } catch (err) {
      if (err instanceof MarketError) throw err;
      if (postgresCode(err) !== '23505') throw err;
      const [prior] = await this.sql<CategoryEventRow[]>`
        SELECT * FROM market.listing_category_events WHERE business_key = ${businessKey}
      `;
      if (prior && sameCategoryEvent(prior, filed)) return toCategoryResult(prior);
      throw new MarketError(MARKET_IDEMPOTENCY_CONFLICT, MARKET_IDEMPOTENCY_CONFLICT);
    }
  }

  /**
   * Operator takedown. Identity consume is the gate; the status, audit columns,
   * slot release, and client-id row commit together. A replay of the same client
   * id returns the stored result and does not consume again or post a ledger entry.
   */
  async takedownListing(
    input: {
      actorId: string;
      actorScope: string;
      listingId: string;
      reason: string;
      approvalId?: string | null;
      operationId?: string | null;
      clientRequestId: string;
    },
    approvals: ActionApprovalConsumer,
  ): Promise<TakedownResult> {
    if (input.actorScope !== MARKET_OPS_SCOPE) {
      throw new MarketError(MARKET_OPS_REQUIRED, MARKET_OPS_REQUIRED);
    }
    const clientRequestId = input.clientRequestId?.trim() ?? '';
    if (!clientRequestId || clientRequestId.length > 128) {
      throw new MarketError(MARKET_CLIENT_REQUEST_ID_REQUIRED, MARKET_CLIENT_REQUEST_ID_REQUIRED);
    }
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 10 || reason.length > 2000) {
      throw new MarketError(MARKET_TAKEDOWN_REASON_SHORT, MARKET_TAKEDOWN_REASON_SHORT);
    }
    const ids = readApprovalIds(input);
    const [prior] = await this.sql<Array<{ listing_id: string; result: TakedownResult }>>`
      SELECT listing_id, result FROM market.listing_takedowns WHERE client_request_id = ${clientRequestId}
    `;
    if (prior) {
      if (prior.listing_id !== input.listingId) {
        throw new MarketError(MARKET_IDEMPOTENCY_CONFLICT, MARKET_IDEMPOTENCY_CONFLICT);
      }
      const stored = prior.result as TakedownResult | string;
      return typeof stored === 'string' ? (JSON.parse(stored) as TakedownResult) : stored;
    }
    const listing = await this.getListing(input.listingId);
    if (!listing) throw new MarketError('No listing with that id', 'market.listing_not_found');
    if (listing.status === 'taken_down') {
      throw new MarketError(MARKET_LISTING_TAKEN_DOWN, MARKET_LISTING_TAKEN_DOWN);
    }
    const payloadHash = marketActionPayloadHash('market.takedown', { listingId: input.listingId, reason });
    const consumed = await approvals.consume({
      approvalId: ids.approvalId,
      operationId: ids.operationId,
      payloadHash,
      targetService: 'svc-market',
      targetId: input.listingId,
      expectedVersion: '1',
    });
    assertTakedownApproval(consumed, input.listingId, payloadHash);
    return transaction(this.sql, async (tx) => {
      const [locked] = await tx<ListingRow[]>`
        SELECT * FROM market.listings WHERE id = ${input.listingId} FOR UPDATE
      `;
      if (!locked) throw new MarketError('No listing with that id', 'market.listing_not_found');
      if (locked.status === 'taken_down') {
        throw new MarketError(MARKET_LISTING_TAKEN_DOWN, MARKET_LISTING_TAKEN_DOWN);
      }
      const [updated] = await tx<Array<{ taken_down_at: Date }>>`
        UPDATE market.listings
           SET status = 'taken_down',
               taken_down_reason = ${reason},
               taken_down_actor_id = ${input.actorId},
               taken_down_at = now(),
               updated_at = now()
         WHERE id = ${input.listingId}
           AND status <> 'taken_down'
        RETURNING taken_down_at
      `;
      if (!updated?.taken_down_at) {
        throw new MarketError(MARKET_LISTING_TAKEN_DOWN, MARKET_LISTING_TAKEN_DOWN);
      }
      await tx`
        UPDATE market.vendor_slots
           SET released_at = now()
         WHERE vendor_id = ${locked.vendor_id}
           AND ref = ${input.listingId}
           AND released_at IS NULL
      `;
      const result: TakedownResult = {
        listingId: input.listingId,
        status: 'taken_down',
        reason,
        actorId: input.actorId,
        takenDownAt: updated.taken_down_at.toISOString(),
      };
      await tx`
        INSERT INTO market.listing_takedowns (
          client_request_id, listing_id, actor_id, approval_id, reason, result
        ) VALUES (
          ${clientRequestId},
          ${input.listingId},
          ${input.actorId},
          ${ids.approvalId},
          ${reason},
          ${tx.json(JSON.parse(JSON.stringify(result)))}
        )
      `;
      return result;
    });
  }

  /**
   * Buyer cancel. Stops new paid windows. Does not post a reverse recipe —
   * remaining time until `access_until` still grants access; after that the
   * named code is cancelled, not past-due.
   */
  async cancelSubscription(input: {
    buyerId: string;
    listingId: string;
  }): Promise<{ listingId: string; buyerId: string; cancelledAt: string }> {
    const listing = await this.getListing(input.listingId);
    if (!listing || listing.offerType !== 'subscription') {
      throw new MarketError('No subscription listing with that id', 'market.listing_not_found');
    }
    const paidUntil = await this.maxAccessUntil(listing.id, input.buyerId);
    if (!paidUntil) {
      throw new MarketError('No paid subscription to cancel', 'market.subscription_no_access');
    }
    const [existing] = await this.sql<Array<{ cancelled_at: Date | null }>>`
      SELECT cancelled_at FROM market.subscription_state
       WHERE listing_id = ${listing.id} AND buyer_id = ${input.buyerId}
    `;
    if (existing?.cancelled_at) {
      return { listingId: listing.id, buyerId: input.buyerId, cancelledAt: existing.cancelled_at.toISOString() };
    }
    const at = this.now();
    await this.sql`
      INSERT INTO market.subscription_state (listing_id, buyer_id, cancelled_at, updated_at)
      VALUES (${listing.id}, ${input.buyerId}, ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz)
      ON CONFLICT (listing_id, buyer_id) DO UPDATE
        SET cancelled_at = COALESCE(market.subscription_state.cancelled_at, EXCLUDED.cancelled_at),
            updated_at = EXCLUDED.updated_at
    `;
    const [row] = await this.sql<Array<{ cancelled_at: Date }>>`
      SELECT cancelled_at FROM market.subscription_state
       WHERE listing_id = ${listing.id} AND buyer_id = ${input.buyerId}
    `;
    if (!row?.cancelled_at) {
      throw new MarketError('Cancel did not persist', 'market.subscription_cancel_failed');
    }
    return { listingId: listing.id, buyerId: input.buyerId, cancelledAt: row.cancelled_at.toISOString() };
  }

  /**
   * Time-bounded access. Past-due is a named refuse, never a fake paid row.
   * A settled purchase whose `access_until` never stuck is stamped from that
   * row's period snapshot and `settled_at`. The live listing period is not read.
   */
  async subscriptionAccess(input: { buyerId: string; listingId: string }): Promise<SubscriptionAccess> {
    const listing = await this.getListing(input.listingId);
    if (!listing || listing.offerType !== 'subscription') {
      throw new MarketError('No subscription listing with that id', 'market.listing_not_found');
    }
    await this.stampMissingSubscriptionAccess(listing, input.buyerId);
    const paidUntil = await this.maxAccessUntil(listing.id, input.buyerId);
    if (!paidUntil) {
      throw new MarketError('No paid subscription access', 'market.subscription_no_access');
    }
    const cancelledAt = await this.cancelledAt(listing.id, input.buyerId);
    const now = this.now();
    if (now >= paidUntil) {
      if (cancelledAt) {
        throw new MarketError('Subscription was cancelled and the paid window has ended', 'market.subscription_cancelled');
      }
      throw new MarketError('Subscription access is past due', 'market.subscription_past_due');
    }
    return {
      granted: true,
      listingId: listing.id,
      buyerId: input.buyerId,
      accessUntil: paidUntil.toISOString(),
    };
  }

  private resolveCreatePeriod(offerType: OfferType, periodSeconds?: number | null): number | null {
    if (offerType === 'one_time') {
      if (periodSeconds != null) {
        throw new MarketError('One-time listings do not take a subscription period', 'market.period_not_applicable');
      }
      return null;
    }
    if (periodSeconds == null || !Number.isInteger(periodSeconds) || periodSeconds <= 0) {
      throw new MarketError(
        'Subscription listings need a period in whole seconds — no default cadence is invented',
        'market.subscription_period_unset',
      );
    }
    return periodSeconds;
  }

  private requireSubscriptionPeriod(listing: ListingRecord): number {
    if (listing.periodSeconds == null || !Number.isInteger(listing.periodSeconds) || listing.periodSeconds <= 0) {
      throw new MarketError(
        'This subscription listing has no period — it cannot be sold until the vendor sets one',
        'market.subscription_period_unset',
      );
    }
    return listing.periodSeconds;
  }

  /** Paid term on the purchase. Null stays null — no default month. */
  private paidPeriodSeconds(purchase: PurchaseRecord): number | null {
    const period = purchase.periodSeconds;
    if (period == null || !Number.isInteger(period) || period <= 0) return null;
    return period;
  }

  private async assertNotCancelled(listingId: string, buyerId: string): Promise<void> {
    const cancelledAt = await this.cancelledAt(listingId, buyerId);
    if (cancelledAt) {
      throw new MarketError('This subscription was cancelled — new access is stopped', 'market.subscription_cancelled');
    }
  }

  private async cancelledAt(listingId: string, buyerId: string): Promise<Date | null> {
    const [row] = await this.sql<Array<{ cancelled_at: Date | null }>>`
      SELECT cancelled_at FROM market.subscription_state
       WHERE listing_id = ${listingId} AND buyer_id = ${buyerId}
    `;
    return row?.cancelled_at ?? null;
  }

  private async maxAccessUntil(listingId: string, buyerId: string): Promise<Date | null> {
    const [row] = await this.sql<Array<{ until: Date | null }>>`
      SELECT max(access_until) AS until
        FROM market.purchases
       WHERE listing_id = ${listingId}
         AND buyer_id = ${buyerId}
         AND status = 'settled'
         AND access_until IS NOT NULL
         -- A refunded purchase gives no access.
         AND NOT EXISTS (
           SELECT 1 FROM market.purchase_holds h WHERE h.purchase_id = market.purchases.id AND h.state = 'refunded'
         )
    `;
    return row?.until ?? null;
  }

  /**
   * Finish a purchase whose `marketPurchase` is already on the ledger.
   * Returns null when this id was not posted yet, so fresh gates still apply.
   * Does not call `ledger.post`.
   */
  private async resumePostedPurchase(input: { buyerId: string; listingId: string; purchaseId: string }): Promise<PurchaseRecord | null> {
    const [row] = await this.sql<PurchaseRow[]>`SELECT * FROM market.purchases WHERE id = ${input.purchaseId}`;
    if (!row) return null;
    const existing = toPurchase(row);
    if (existing.buyerId !== input.buyerId || existing.listingId !== input.listingId) return null;
    if (existing.status === 'rejected') return null;

    const listing = await this.getListing(existing.listingId);
    if (!listing) return null;

    if (existing.status === 'settled') {
      return this.ensureSubscriptionAccess(existing, listing);
    }
    if (existing.status !== 'pending') return null;

    // A held claim whose hold posted settles from its snapshot before any gate is read again: a listing archived or a
    // setting cleared since cannot leave the buyer's pot without its hold row.
    if (existing.refundWindowSeconds !== null) {
      const hold = await this.held.postedHold({ ...existing, price: this.positiveDecimalPrice(existing.price) }).catch((err: unknown) => {
        if (err instanceof MarketError) throw err;
        return null;
      });
      if (!hold) return null;
      await this.held.settleHeld({
        purchaseId: existing.id,
        listingId: existing.listingId,
        buyerId: existing.buyerId,
        price: this.positiveDecimalPrice(existing.price),
        windowSeconds: existing.refundWindowSeconds,
        holdTxId: hold.id,
      });
      const [reload] = await this.sql<PurchaseRow[]>`SELECT * FROM market.purchases WHERE id = ${existing.id}`;
      if (reload?.status === 'settled') return this.ensureSubscriptionAccess(toPurchase(reload), listing);
      return null;
    }

    const posted = await this.postedMarketPurchase(existing);
    if (!posted) return null;

    const snapshotPrice = this.positiveDecimalPrice(existing.price);
    await this.notifyMarketAffiliateAccrue(existing, snapshotPrice, existing.commissionBps);
    await this.notifyMarketAffiliatePayout(existing, snapshotPrice, existing.commissionBps);

    const settledAtIso = this.now().toISOString();
    const settledRows = await this.sql<PurchaseRow[]>`
      UPDATE market.purchases
         SET status = 'settled',
             ledger_tx_id = ${posted.id},
             settled_at = ${settledAtIso}::timestamptz,
             rejection_code = NULL
       WHERE id = ${existing.id}
         AND status = 'pending'
      RETURNING *
    `;
    const settled = settledRows[0];
    if (settled) return this.ensureSubscriptionAccess(toPurchase(settled), listing);

    const [reload] = await this.sql<PurchaseRow[]>`SELECT * FROM market.purchases WHERE id = ${existing.id}`;
    if (reload?.status === 'settled') return this.ensureSubscriptionAccess(toPurchase(reload), listing);
    if (reload?.status === 'rejected') {
      throw new MarketError(reload.rejection_code ?? 'Purchase previously rejected', 'market.purchase_conflict');
    }
    throw new MarketError('Purchase settle returned no row', 'market.purchase_not_written');
  }

  /**
   * The matching posted `market.purchase:<id>` transaction, or null when
   * lookup is unavailable or reports no receipt. Null is not absence proof.
   *
   * A pending row does not store `ledger_tx_id` (0005). Resume asks the ledger
   * by idempotency key. The HTTP client's `getTxByKey` throws; that throw
   * permits no bypass of current fresh gates and no terminal rejection.
   */
  private async postedMarketPurchase(purchase: PurchaseRecord): Promise<{ id: string } | null> {
    let tx: LedgerTx | null;
    try {
      tx = await this.ledger.getTxByKey(`market.purchase:${purchase.id.trim()}`);
    } catch {
      // The deployed HTTP port has no lookup. Request echoes and a stored ID
      // alone are not proof that the ledger holds these exact sale terms.
      return null;
    }
    if (!tx) return null;
    await this.requireMatchingReceipt(
      tx,
      recipes.marketPurchase({
        purchaseId: purchase.id,
        listingId: purchase.listingId,
        buyerId: purchase.buyerId,
        vendorUserId: purchase.vendorUserId,
        assetId: purchase.assetId,
        price: this.positiveDecimalPrice(purchase.price),
        commissionBps: purchase.commissionBps,
      }),
    );
    return { id: tx.id };
  }

  private async requireMatchingReceipt(tx: LedgerTx, request: PostRequest): Promise<void> {
    const refuse = () => new MarketError('Ledger receipt does not match this purchase', 'market.purchase_receipt_mismatch');
    if (
      !tx.id ||
      tx.idempotencyKey !== request.idempotencyKey ||
      tx.module !== request.module ||
      tx.reason !== request.reason ||
      Object.entries(request.meta ?? {}).some(([key, value]) => tx.meta[key] !== value) ||
      tx.entries.length !== request.entries.length
    ) {
      throw refuse();
    }
    const expected = await Promise.all(
      request.entries.map(async (entry) => ({
        accountId: (await this.ledger.balance(entry.account)).accountId,
        assetId: entry.account.assetId,
        direction: entry.direction,
        amount: entry.amount,
      })),
    );
    const actual = [...tx.entries];
    for (const entry of expected) {
      const at = actual.findIndex(
        (posted) =>
          posted.accountId === entry.accountId &&
          posted.assetId === entry.assetId &&
          posted.direction === entry.direction &&
          posted.amount === entry.amount,
      );
      if (at < 0) throw refuse();
      actual.splice(at, 1);
    }
  }

  /**
   * Snapshot price from the purchase or listing string already in hand.
   * Blank, malformed, or non-positive stays `market.listing_invalid_price`.
   * Never substitutes another price.
   */
  private positiveDecimalPrice(price: string): Amount {
    let amount: Amount;
    try {
      amount = parseAmount(price);
    } catch (err) {
      if (err instanceof MoneyError) {
        throw new MarketError('Purchase price must be a positive decimal string', 'market.listing_invalid_price');
      }
      throw err;
    }
    if (amount <= 0n) {
      throw new MarketError('Purchase price must be positive', 'market.listing_invalid_price');
    }
    return amount;
  }

  /**
   * Stamp settled subscription rows that lost `access_until`. Period is the
   * purchase snapshot. A null snapshot is left null. No price is invented.
   */
  private async stampMissingSubscriptionAccess(listing: ListingRecord, buyerId: string): Promise<void> {
    if (listing.offerType !== 'subscription') return;
    const rows = await this.sql<PurchaseRow[]>`
      SELECT * FROM market.purchases
       WHERE listing_id = ${listing.id}
         AND buyer_id = ${buyerId}
         AND status = 'settled'
         AND ledger_tx_id IS NOT NULL
         AND access_until IS NULL
         AND period_seconds IS NOT NULL
         AND period_seconds > 0
         AND NOT EXISTS (
           SELECT 1 FROM market.purchase_holds h WHERE h.purchase_id = market.purchases.id AND h.state = 'refunded'
         )
       ORDER BY settled_at ASC, id ASC
    `;
    for (const row of rows) {
      await this.ensureSubscriptionAccess(toPurchase(row), listing);
    }
  }

  /**
   * Stamp `access_until` from the purchase period snapshot. Idempotent on the
   * same purchase id so a crash re-drive cannot stack extra time.
   *
   * Two settled purchases of the same listing and buyer can both reach this
   * before either has written `access_until`. The prior window is
   * `max(access_until)` excluding this id. The advisory lock on (listing, buyer)
   * is held from that read through the write, at read committed, so the second
   * statement sees the end the first purchase committed. The second period
   * starts at the first period's end. A row that already has `access_until`
   * is returned as stored. Pending and rejected rows are not stamped.
   */
  private async ensureSubscriptionAccess(purchase: PurchaseRecord, listing: ListingRecord): Promise<PurchaseRecord> {
    if (listing.offerType !== 'subscription') return purchase;
    if (purchase.status !== 'settled' || purchase.ledgerTxId == null) return purchase;
    if (purchase.accessUntil) return purchase;
    if (this.paidPeriodSeconds(purchase) == null) return purchase;
    return transaction(
      this.sql,
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${listing.id}), hashtext(${purchase.buyerId}))`;
        const [current] = await tx<PurchaseRow[]>`SELECT * FROM market.purchases WHERE id = ${purchase.id}`;
        if (!current) return purchase;
        const snap = toPurchase(current);
        if (snap.status !== 'settled' || snap.ledgerTxId == null) return snap;
        if (snap.accessUntil) return snap;
        const period = this.paidPeriodSeconds(snap);
        if (period == null) return snap;
        const now = current.settled_at ? new Date(current.settled_at) : this.now();
        const previous = await this.maxAccessUntilExcluding(tx, listing.id, purchase.buyerId, purchase.id);
        const base = previous && previous > now ? previous : now;
        const untilIso = addSeconds(base, period).toISOString();
        const updated = await tx<PurchaseRow[]>`
          UPDATE market.purchases
             SET access_until = ${untilIso}::timestamptz
           WHERE id = ${purchase.id}
             AND status = 'settled'
             AND ledger_tx_id IS NOT NULL
             AND access_until IS NULL
          RETURNING *
        `;
        const row = updated[0];
        if (row) return toPurchase(row);
        const [reload] = await tx<PurchaseRow[]>`SELECT * FROM market.purchases WHERE id = ${purchase.id}`;
        return reload ? toPurchase(reload) : purchase;
      },
      { isolation: 'read committed' },
    );
  }

  private async maxAccessUntilExcluding(sql: Sql, listingId: string, buyerId: string, exceptPurchaseId: string): Promise<Date | null> {
    const [row] = await sql<Array<{ until: Date | null }>>`
      SELECT max(access_until) AS until
        FROM market.purchases
       WHERE listing_id = ${listingId}
         AND buyer_id = ${buyerId}
         AND status = 'settled'
         AND access_until IS NOT NULL
         AND id <> ${exceptPurchaseId}
         -- A refunded purchase gives no access, so a new period never starts at its end.
         AND NOT EXISTS (
           SELECT 1 FROM market.purchase_holds h WHERE h.purchase_id = market.purchases.id AND h.state = 'refunded'
         )
    `;
    return row?.until ?? null;
  }

  private async requireOwnedListing(userId: string, listingId: string): Promise<ListingRecord> {
    const listing = await this.getListing(listingId);
    if (!listing) throw new MarketError('No listing with that id', 'market.listing_not_found');
    const mine = await this.vendors.myVendor(userId);
    if (!mine || mine.id !== listing.vendorId) {
      throw new MarketError('That listing is not yours', 'market.listing_not_owned');
    }
    return listing;
  }

  /**
   * True when this listing id is the `ref` of an unreleased vendor slot.
   * Create writes the listing then claims; if claim never ran, sell/catalogue refuse.
   */
  private async listingHoldsLiveSlot(listingId: string, vendorId: string): Promise<boolean> {
    const rows = await this.sql<Array<{ id: string }>>`
      SELECT id FROM market.vendor_slots
       WHERE vendor_id = ${vendorId}
         AND ref = ${listingId}
         AND released_at IS NULL
       LIMIT 1
    `;
    return rows.length > 0;
  }

  /**
   * Vendor still listed + this listing still holds its own open slot + the
   * listing is inside the usable stake quota (oldest open slots first).
   * Used before claim and again immediately before ledger post (TOCTOU close).
   */
  private async assertListingSellable(listing: ListingRecord): Promise<void> {
    const eligibility = await this.vendors.listingEligibility({ vendorId: listing.vendorId });
    if (!eligibility.listed) {
      throw new MarketError(eligibility.reason ?? 'Vendor is not eligible to sell', eligibility.code ?? 'market.vendor_not_approved');
    }
    if (!(await this.listingHoldsLiveSlot(listing.id, listing.vendorId))) {
      throw new MarketError(
        'This listing has no live slot — it cannot be sold until the vendor reclaims one',
        'market.listing_slot_missing',
      );
    }
    const entitled = await this.vendors.entitledListingRefs(listing.vendorId);
    if (!entitled.has(listing.id)) {
      throw new MarketError(
        'This listing is outside the vendor stake quota — only the oldest live slots remain sellable',
        'market.listing_over_capacity',
      );
    }
  }

  private async claimPurchase(input: {
    purchaseId: string;
    listingId: string;
    buyerId: string;
    price: string;
    commissionBps: number;
    refundWindowSeconds: number | null;
  }): Promise<PurchaseRecord> {
    try {
      const inserted = await this.sql<PurchaseRow[]>`
        INSERT INTO market.purchases (
          id, listing_id, buyer_id, vendor_id, vendor_user_id,
          asset_id, price, commission_bps, period_seconds, refund_window_seconds, status
        )
        SELECT
          ${input.purchaseId},
          l.id,
          ${input.buyerId},
          l.vendor_id,
          v.user_id,
          l.asset_id,
          ${input.price}::numeric,
          ${input.commissionBps},
          l.period_seconds,
          ${input.refundWindowSeconds},
          'pending'
        FROM market.listings l
        JOIN market.vendors v ON v.id = l.vendor_id
        WHERE l.id = ${input.listingId}
        RETURNING *
      `;
      const row = inserted[0];
      if (!row) throw new MarketError('Purchase claim returned no row', 'market.purchase_not_written');
      return toPurchase(row);
    } catch (err) {
      // Unique violation → load existing and compare terms.
      const existing = await this.sql<PurchaseRow[]>`
        SELECT * FROM market.purchases WHERE id = ${input.purchaseId}
      `;
      if (existing.length === 0) throw err;
      const row = existing[0]!;
      const [live] = await this.sql<Array<{ vendor_id: string; user_id: string; asset_id: string }>>`
        SELECT l.vendor_id, v.user_id, l.asset_id
          FROM market.listings l
          JOIN market.vendors v ON v.id = l.vendor_id
         WHERE l.id = ${input.listingId}
      `;
      // Commission bps is NOT part of the client-facing terms match: it was
      // snapshotted on first claim. Re-drive after an env bps change must settle
      // the original split, not stuck as purchase_conflict or re-split.
      // Period seconds is the same kind of snapshot. A later listing period
      // does not conflict and is not re-read.
      // Payee and asset are the listing and vendor rows, not caller fields.
      const termsMatch =
        live !== undefined &&
        row.listing_id === input.listingId &&
        row.buyer_id === input.buyerId &&
        row.vendor_id === live.vendor_id &&
        row.vendor_user_id === live.user_id &&
        row.asset_id === live.asset_id &&
        purchasePriceTermsMatch(row.price, input.price);
      if (!termsMatch) {
        throw new MarketError(`Purchase id ${input.purchaseId} was already used with different terms`, 'market.purchase_conflict');
      }
      return toPurchase(row);
    }
  }

  private async catalogueRowVisible(row: ListingRow): Promise<boolean> {
    try {
      const elig = await this.vendors.listingEligibility({ vendorId: row.vendor_id });
      if (!elig.listed) return false;
      if (!(await this.listingHoldsLiveSlot(row.id, row.vendor_id))) return false;
      const entitled = await this.vendors.entitledListingRefs(row.vendor_id);
      return entitled.has(row.id);
    } catch (err) {
      if (err instanceof MarketError && err.code === 'market.stake_unavailable') return false;
      throw err;
    }
  }

  private catalogueBatch(
    sort: ListingSort,
    cursor: ListingCursor | null,
    offerType: string | null,
    assetId: string | null,
    needle: string | null,
  ): Promise<ListingRow[]> {
    const createdUs = sort === 'newest' ? (cursor?.createdAt ?? null) : null;
    const price = sort === 'priceAsc' || sort === 'priceDesc' ? (cursor?.price ?? null) : null;
    const title = sort === 'title' ? (cursor?.title ?? null) : null;
    const id = cursor?.id ?? null;
    const where = this.sql`
      l.status = 'active'
      AND (
        l.offer_type = 'one_time'
        OR (l.offer_type = 'subscription' AND l.period_seconds IS NOT NULL)
      )
      AND (${offerType}::text IS NULL OR l.offer_type = ${offerType})
      AND (${assetId}::text IS NULL OR l.asset_id = ${assetId})
      AND (${needle}::text IS NULL OR strpos(lower(l.title), ${needle}) > 0)
    `;
    const count = this.sql`
      (
        SELECT count(*)::text FROM market.listings c
         WHERE c.vendor_id = l.vendor_id AND c.status = 'active'
      ) AS vendor_listing_count,
      floor(extract(epoch FROM l.created_at) * 1000000)::text AS created_us
    `;
    if (sort === 'newest') {
      return this.sql<ListingRow[]>`
        SELECT l.*, ${count}
          FROM market.listings l
         WHERE ${where}
           AND (
             ${createdUs}::numeric IS NULL
             OR (floor(extract(epoch FROM l.created_at) * 1000000), l.id) < (${createdUs}::numeric, ${id}::uuid)
           )
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT ${CATALOGUE_BATCH}
      `;
    }
    if (sort === 'priceAsc') {
      return this.sql<ListingRow[]>`
        SELECT l.*, ${count}
          FROM market.listings l
         WHERE ${where}
           AND (
             ${price}::numeric IS NULL
             OR (l.price, l.id) > (${price}::numeric, ${id}::uuid)
           )
         ORDER BY l.price ASC, l.id ASC
         LIMIT ${CATALOGUE_BATCH}
      `;
    }
    if (sort === 'priceDesc') {
      return this.sql<ListingRow[]>`
        SELECT l.*, ${count}
          FROM market.listings l
         WHERE ${where}
           AND (
             ${price}::numeric IS NULL
             OR (l.price, l.id) < (${price}::numeric, ${id}::uuid)
           )
         ORDER BY l.price DESC, l.id DESC
         LIMIT ${CATALOGUE_BATCH}
      `;
    }
    return this.sql<ListingRow[]>`
      SELECT l.*, ${count}
        FROM market.listings l
       WHERE ${where}
         AND (
           ${title}::text IS NULL
           OR (l.title, l.id) > (${title}, ${id}::uuid)
         )
       ORDER BY l.title ASC, l.id ASC
       LIMIT ${CATALOGUE_BATCH}
    `;
  }
}

interface ListingCursor {
  sort: ListingSort;
  id: string;
  createdAt?: string;
  price?: string;
  title?: string;
}

function toPublicListing(row: ListingRow): PublicListingRecord {
  const count = Number(row.vendor_listing_count);
  if (!Number.isInteger(count) || count < 0) {
    throw new MarketError('market.vendor_listing_count_unreadable', 'market.vendor_listing_count_unreadable');
  }
  return { ...toListing(row), vendorListingCount: count };
}

function resolveListingSort(sort: string | undefined): ListingSort {
  if (sort === undefined || sort.trim() === '') {
    throw new MarketError(MARKET_LISTINGS_SORT_UNSET, MARKET_LISTINGS_SORT_UNSET);
  }
  if ((LISTING_SORTS as readonly string[]).includes(sort)) return sort as ListingSort;
  throw new MarketError(MARKET_LISTINGS_SORT_UNKNOWN, MARKET_LISTINGS_SORT_UNKNOWN);
}

function cursorFromRow(sort: ListingSort, row: ListingRow): ListingCursor {
  if (sort === 'newest') {
    if (!row.created_us) throw new MarketError(MARKET_LISTINGS_CURSOR_INVALID, MARKET_LISTINGS_CURSOR_INVALID);
    return { sort, id: row.id, createdAt: row.created_us };
  }
  if (sort === 'title') return { sort, id: row.id, title: row.title };
  return { sort, id: row.id, price: decimalPriceFromDriver(row.price) };
}

function encodeListingCursor(cursor: ListingCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString('base64url');
}

function decodeListingCursor(cursor: string | undefined, sort: ListingSort): ListingCursor | null {
  if (cursor === undefined || cursor.trim() === '') return null;
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v?: unknown;
      sort?: unknown;
      id?: unknown;
      createdAt?: unknown;
      price?: unknown;
      title?: unknown;
    };
    if (raw.v !== 1 || raw.sort !== sort || typeof raw.id !== 'string') {
      throw new MarketError(MARKET_LISTINGS_CURSOR_INVALID, MARKET_LISTINGS_CURSOR_INVALID);
    }
    if (sort === 'newest' && typeof raw.createdAt === 'string') return { sort, id: raw.id, createdAt: raw.createdAt };
    if (sort === 'title' && typeof raw.title === 'string') return { sort, id: raw.id, title: raw.title };
    if ((sort === 'priceAsc' || sort === 'priceDesc') && typeof raw.price === 'string') {
      return { sort, id: raw.id, price: raw.price };
    }
    throw new MarketError(MARKET_LISTINGS_CURSOR_INVALID, MARKET_LISTINGS_CURSOR_INVALID);
  } catch (err) {
    if (err instanceof MarketError) throw err;
    throw new MarketError(MARKET_LISTINGS_CURSOR_INVALID, MARKET_LISTINGS_CURSOR_INVALID);
  }
}

function requireEarningsWindow(from: string | undefined, to: string | undefined): { from: Date; to: Date } {
  const start = from && from.trim() ? new Date(from) : null;
  const end = to && to.trim() ? new Date(to) : null;
  if (!start || !end || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end.getTime() < start.getTime()) {
    throw new MarketError(MARKET_EARNINGS_WINDOW_UNSET, MARKET_EARNINGS_WINDOW_UNSET);
  }
  return { from: start, to: end };
}

function assertTakedownApproval(row: ActionApproval, listingId: string, payloadHash: string): void {
  const approver = row.approverId?.trim() ?? '';
  const requester = row.requesterId.trim();
  if (
    row.status !== 'CONSUMED' ||
    row.actionType !== 'market.takedown' ||
    row.targetService !== 'svc-market' ||
    row.targetId !== listingId ||
    row.payloadHash !== payloadHash ||
    !approver ||
    approver.toLowerCase() === requester.toLowerCase()
  ) {
    throw new MarketError(MARKET_TAKEDOWN_APPROVAL_MISMATCH, MARKET_TAKEDOWN_APPROVAL_MISMATCH);
  }
}
