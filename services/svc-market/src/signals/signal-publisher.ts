import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { MarketError, type VendorRecord } from '../vendor-service.js';
import type { CommerceService, ListingRecord } from '../commerce/commerce-service.js';
import { refuseStrategyCopyLaw } from '../strategy/strategy-listing.js';

/**
 * Signal publishing, provider vetting and provider earnings (CB-bots-api-signal-05, -06, -07; J-copy-bots-otc-22).
 *
 * A provider publishes a signal under their own publish key; a retried publish answers the first. Before the first
 * publish the provider is vetted once against the owner's criteria (lowest verification tier, fewest fills of their own
 * orders); both blank refuses `market.provider_criteria_not_set`, and the record of what was seen is kept. Fee models
 * are free and a monthly fee: a monthly fee signal holds one Market subscription listing, which buyers pay through the
 * existing purchase and which the provider's earnings read. A profit share is refused as forbidden (copy law); an
 * automatic recurring subscription is refused as not built. Archiving withdraws the signal and its listing; buyers keep
 * the period they paid for (the listing's purchases are untouched). Nothing here moves money.
 */

export const SIGNAL_TIERS = ['none', 'basic', 'full', 'institutional'] as const;
export type SignalTier = (typeof SIGNAL_TIERS)[number];

export const PROVIDER_CRITERIA_NOT_SET = 'market.provider_criteria_not_set';
export const PROVIDER_CRITERIA_NOT_MET = 'market.provider_criteria_not_met';
export const PROVIDER_RECORD_UNAVAILABLE = 'market.provider_record_unavailable';
export const PRICE_NOT_SET = 'market.price_not_set';
export const SIGNAL_NOT_FOUND = 'market.signal_not_found';
export const SIGNAL_KEY_CONFLICT = 'market.signal_key_conflict';
export const SIGNAL_PERIOD_UNSET = 'market.subscription_period_unset';
export const SIGNAL_RECURRING_NOT_BUILT = 'market.subscription_recurring_not_built';
export const SIGNAL_PROFIT_SHARE_FORBIDDEN = 'market.strategy_profit_share_forbidden';

export interface ProviderCriteria {
  readonly minTier: Exclude<SignalTier, 'none'>;
  readonly minFills: number;
}

export interface TrackRecord {
  readonly fills: number;
  readonly firstFillAt: string | null;
}

/** svc-trade's count of a provider's own fills. Fails closed: any read problem refuses. */
export interface TrackRecordSource {
  recordOf(userId: string): Promise<TrackRecord>;
}

export interface SignalVetting {
  readonly minTier: string;
  readonly minFills: number;
  readonly tierSeen: string;
  readonly fillsSeen: number;
  readonly firstFillAt: string | null;
  readonly passedAt: string;
}

export interface SignalRecord {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly assetId: string;
  readonly recommendedAmount: string | null;
  readonly feeModel: 'free' | 'monthly';
  readonly price: string | null;
  readonly periodSeconds: number | null;
  readonly listingId: string | null;
  readonly state: 'pending' | 'published' | 'archived';
  readonly createdAt: string;
  readonly archivedAt: string | null;
}

export interface PublishInput {
  readonly userId: string;
  readonly tier: SignalTier;
  readonly publishKey: string;
  readonly title: string;
  readonly description: string;
  readonly assetId: string;
  readonly recommendedAmount?: string | null | undefined;
  readonly feeModel: string;
  readonly price?: string | null | undefined;
  readonly periodSeconds?: number | null | undefined;
  readonly [extra: string]: unknown;
}

export interface SignalEarnings {
  readonly from: string;
  readonly to: string;
  readonly settlement: 'at_sale';
  readonly assets: Array<{ assetId: string; gross: string; commission: string; net: string; sales: number }>;
  /** Profit share is not offered by the platform: no received or pending figure exists. */
  readonly profitShare: null;
}

type SignalRow = {
  id: string;
  vendor_id: string;
  publish_key: string;
  title: string;
  description: string;
  asset_id: string;
  recommended_amount: string | null;
  fee_model: 'free' | 'monthly';
  price: string | null;
  period_seconds: number | null;
  listing_id: string | null;
  status: 'pending' | 'published' | 'archived';
  created_at: Date;
  archived_at: Date | null;
};

type VettingRow = {
  min_tier: string;
  min_fills: number;
  tier_seen: string;
  fills_seen: number;
  first_fill_at: Date | null;
  passed_at: Date;
};

const SIGNAL_COLUMNS = `id, vendor_id, publish_key, title, description, asset_id, recommended_amount::text AS recommended_amount,
  fee_model, price::text AS price, period_seconds, listing_id, status, created_at, archived_at`;

export function tierRank(tier: string): number {
  const i = (SIGNAL_TIERS as readonly string[]).indexOf(tier);
  return i < 0 ? 0 : i;
}

function toSignal(row: SignalRow): SignalRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    assetId: row.asset_id,
    recommendedAmount: row.recommended_amount === null ? null : formatAmount(parseAmount(row.recommended_amount)),
    feeModel: row.fee_model,
    price: row.price === null ? null : formatAmount(parseAmount(row.price)),
    periodSeconds: row.period_seconds,
    listingId: row.listing_id,
    state: row.status,
    createdAt: row.created_at.toISOString(),
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
  };
}

function toVetting(row: VettingRow): SignalVetting {
  return {
    minTier: row.min_tier,
    minFills: row.min_fills,
    tierSeen: row.tier_seen,
    fillsSeen: row.fills_seen,
    firstFillAt: row.first_fill_at ? row.first_fill_at.toISOString() : null,
    passedAt: row.passed_at.toISOString(),
  };
}

/** A positive decimal string, or a typed refusal naming the field. */
function positiveAmount(raw: string, code: string, what: string): string {
  let value: bigint;
  try {
    value = parseAmount(raw.trim());
  } catch {
    throw new MarketError(`${what} must be a positive decimal string`, code);
  }
  if (value <= 0n) throw new MarketError(`${what} must be positive`, code);
  return formatAmount(value);
}

export interface SignalPublisherDeps {
  readonly sql: Sql;
  readonly commerce: Pick<CommerceService, 'createListing' | 'archiveListing' | 'myEarnings'>;
  readonly myVendor: (userId: string) => Promise<VendorRecord | null>;
  readonly criteria: ProviderCriteria | null;
  readonly trackRecord: TrackRecordSource | null;
}

export class SignalPublisher {
  constructor(private readonly deps: SignalPublisherDeps) {}

  /** The criteria in force, or null while the owner has not set them. */
  criteria(): ProviderCriteria | null {
    return this.deps.criteria;
  }

  async publish(input: PublishInput): Promise<{ signal: SignalRecord; vetting: SignalVetting; replayed: boolean }> {
    // Copy law first: a profit share is forbidden whatever else the request says.
    refuseStrategyCopyLaw(input as Record<string, unknown>);
    if (input.feeModel === 'profit_share') {
      throw new MarketError('A signal cannot charge a share of its subscribers’ profit', SIGNAL_PROFIT_SHARE_FORBIDDEN);
    }
    if (input.feeModel === 'recurring') {
      throw new MarketError('Automatic recurring subscribe is not built — a buyer pays one period at a time', SIGNAL_RECURRING_NOT_BUILT);
    }
    if (input.feeModel !== 'free' && input.feeModel !== 'monthly') {
      throw new MarketError('A signal’s fee model is free or a monthly fee', 'market.signal_fee_model_invalid');
    }
    const publishKey = input.publishKey.trim();
    if (!publishKey) throw new MarketError('A publish needs its key', 'market.signal_key_required');

    const vendor = await this.deps.myVendor(input.userId);
    if (!vendor) throw new MarketError('You have not applied to sell in the Market', 'market.vendor_not_found');

    // A retried publish answers the first, before anything else is read or checked again.
    const existing = await this.byKey(vendor.id, publishKey);
    if (existing && existing.status !== 'pending') {
      const vetting = await this.vettingOf(vendor.id);
      if (!vetting) throw new MarketError('Published signal is missing its vetting', 'market.signal_vetting_missing');
      return { signal: toSignal(existing), vetting, replayed: true };
    }

    const criteria = this.deps.criteria;
    if (!criteria) {
      throw new MarketError('Signal provider criteria are not set', PROVIDER_CRITERIA_NOT_SET);
    }
    if (vendor.status !== 'approved') {
      throw new MarketError('Only an approved Market seller can publish a signal', 'market.vendor_not_approved');
    }

    const title = input.title.trim();
    const description = input.description.trim();
    const assetId = input.assetId.trim();
    if (!title) throw new MarketError('A signal needs a title', 'market.listing_title_required');
    if (!description) throw new MarketError('A signal needs a description', 'market.listing_description_required');
    if (!assetId) throw new MarketError('A signal needs an asset', 'market.listing_asset_required');
    const recommendedAmount =
      input.recommendedAmount == null || input.recommendedAmount.trim() === ''
        ? null
        : positiveAmount(input.recommendedAmount, 'market.signal_recommended_amount_invalid', 'The recommended amount');

    let price: string | null = null;
    let periodSeconds: number | null = null;
    if (input.feeModel === 'monthly') {
      if (input.price == null || input.price.trim() === '') {
        throw new MarketError('A monthly fee needs its price', PRICE_NOT_SET);
      }
      price = positiveAmount(input.price, 'market.listing_invalid_price', 'The price');
      if (input.periodSeconds == null || !Number.isInteger(input.periodSeconds) || input.periodSeconds <= 0) {
        throw new MarketError('A monthly fee needs its period in whole seconds — no default is invented', SIGNAL_PERIOD_UNSET);
      }
      periodSeconds = input.periodSeconds;
    }

    const vetting = await this.vetOnce(vendor, input.userId, input.tier, criteria);

    const row =
      existing ??
      (await this.insertSignal({
        vendorId: vendor.id,
        publishKey,
        title,
        description,
        assetId,
        recommendedAmount,
        feeModel: input.feeModel,
        price,
        periodSeconds,
      }));
    if (row.publish_key !== publishKey || row.fee_model !== input.feeModel || row.title !== title) {
      throw new MarketError('That publish key names a different signal', SIGNAL_KEY_CONFLICT);
    }
    if (row.status !== 'pending') return { signal: toSignal(row), vetting, replayed: true };

    // A monthly fee signal is sold through one Market subscription listing; a free one has none.
    // A publish that stopped after its listing was made and before it was recorded here finds that listing again by
    // its signal's own terms, so a retry never makes a second one.
    let listing: Pick<ListingRecord, 'id'> | null = null;
    if (row.fee_model === 'monthly') listing = await this.orphanListing(row);
    if (row.fee_model === 'monthly' && !listing) {
      listing = await this.deps.commerce.createListing({
        userId: input.userId,
        title: row.title,
        description: row.description,
        offerType: 'subscription',
        assetId: row.asset_id,
        price: row.price as string,
        periodSeconds: row.period_seconds as number,
      });
    }
    const [published] = await this.deps.sql<SignalRow[]>`
      UPDATE market.signals SET status = 'published', listing_id = ${listing?.id ?? null}
       WHERE id = ${row.id} AND status = 'pending'
      RETURNING ${this.deps.sql.unsafe(SIGNAL_COLUMNS)}`;
    const final = published ?? (await this.byKey(vendor.id, publishKey));
    if (!final) throw new MarketError('Signal vanished while publishing', SIGNAL_NOT_FOUND);
    return { signal: toSignal(final), vetting, replayed: false };
  }

  /** Withdraws the signal and its listing. Buyers keep the period they paid for. A second archive answers the first. */
  async archive(input: { userId: string; signalId: string }): Promise<SignalRecord> {
    const vendor = await this.deps.myVendor(input.userId);
    if (!vendor) throw new MarketError('No signal with that id', SIGNAL_NOT_FOUND);
    const [row] = await this.deps.sql<SignalRow[]>`
      SELECT ${this.deps.sql.unsafe(SIGNAL_COLUMNS)} FROM market.signals WHERE id = ${input.signalId} AND vendor_id = ${vendor.id}`;
    if (!row) throw new MarketError('No signal with that id', SIGNAL_NOT_FOUND);
    if (row.status === 'archived') return toSignal(row);
    if (row.listing_id) await this.deps.commerce.archiveListing({ userId: input.userId, listingId: row.listing_id });
    const [archived] = await this.deps.sql<SignalRow[]>`
      UPDATE market.signals SET status = 'archived', archived_at = now()
       WHERE id = ${row.id} AND status <> 'archived'
      RETURNING ${this.deps.sql.unsafe(SIGNAL_COLUMNS)}`;
    if (archived) return toSignal(archived);
    const [again] = await this.deps.sql<SignalRow[]>`
      SELECT ${this.deps.sql.unsafe(SIGNAL_COLUMNS)} FROM market.signals WHERE id = ${row.id}`;
    return toSignal(again as SignalRow);
  }

  /** The caller's signals, newest first, and their vetting (null before the first publish). */
  async mine(userId: string, limit: number): Promise<{ signals: SignalRecord[]; vetting: SignalVetting | null }> {
    const vendor = await this.deps.myVendor(userId);
    if (!vendor) return { signals: [], vetting: null };
    const rows = await this.deps.sql<SignalRow[]>`
      SELECT ${this.deps.sql.unsafe(SIGNAL_COLUMNS)} FROM market.signals
       WHERE vendor_id = ${vendor.id} AND status <> 'pending'
       ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
    return { signals: rows.map(toSignal), vetting: await this.vettingOf(vendor.id) };
  }

  /** Published signals in publish order, oldest first. Archived ones are withdrawn. No return figure is projected. */
  async catalogue(limit: number): Promise<SignalRecord[]> {
    const rows = await this.deps.sql<SignalRow[]>`
      SELECT ${this.deps.sql.unsafe(SIGNAL_COLUMNS)} FROM market.signals
       WHERE status = 'published' ORDER BY created_at ASC, id ASC LIMIT ${limit}`;
    return rows.map(toSignal);
  }

  /**
   * The provider's earnings from their monthly fee signals, per asset: gross is the sum of the settled sales, net is
   * gross less the house commission each sale carried. Settled at sale; no monthly batch, no pending figure.
   */
  async earnings(input: { userId: string; from: string; to: string }): Promise<SignalEarnings> {
    const vendor = await this.deps.myVendor(input.userId);
    if (!vendor) throw new MarketError('market.earnings_vendor_required', 'market.earnings_vendor_required');
    const report = await this.deps.commerce.myEarnings({ userId: input.userId, from: input.from, to: input.to });
    const rows = await this.deps.sql<Array<{ listing_id: string }>>`
      SELECT listing_id FROM market.signals WHERE vendor_id = ${vendor.id} AND listing_id IS NOT NULL`;
    const signalListings = new Set(rows.map((r) => r.listing_id));
    const byAsset = new Map<string, { gross: bigint; commission: bigint; net: bigint; sales: number }>();
    for (const sale of report.sales) {
      if (!signalListings.has(sale.listingId)) continue;
      const bucket = byAsset.get(sale.assetId) ?? { gross: 0n, commission: 0n, net: 0n, sales: 0 };
      bucket.gross += parseAmount(sale.gross);
      bucket.commission += parseAmount(sale.commission);
      bucket.net += parseAmount(sale.net);
      bucket.sales += 1;
      byAsset.set(sale.assetId, bucket);
    }
    return {
      from: report.from,
      to: report.to,
      settlement: 'at_sale',
      assets: [...byAsset.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([assetId, b]) => ({
          assetId,
          gross: formatAmount(b.gross),
          commission: formatAmount(b.commission),
          net: formatAmount(b.net),
          sales: b.sales,
        })),
      profitShare: null,
    };
  }

  private async byKey(vendorId: string, publishKey: string): Promise<SignalRow | null> {
    const [row] = await this.deps.sql<SignalRow[]>`
      SELECT ${this.deps.sql.unsafe(SIGNAL_COLUMNS)} FROM market.signals WHERE vendor_id = ${vendorId} AND publish_key = ${publishKey}`;
    return row ?? null;
  }

  private async orphanListing(row: SignalRow): Promise<{ id: string } | null> {
    const [found] = await this.deps.sql<Array<{ id: string }>>`
      SELECT l.id FROM market.listings l
       WHERE l.vendor_id = ${row.vendor_id} AND l.offer_type = 'subscription' AND l.title = ${row.title}
         AND l.asset_id = ${row.asset_id} AND l.price = ${row.price}::numeric AND l.period_seconds = ${row.period_seconds}
         AND l.created_at >= ${row.created_at}
         AND NOT EXISTS (SELECT 1 FROM market.signals s WHERE s.listing_id = l.id)
       ORDER BY l.created_at ASC, l.id ASC LIMIT 1`;
    return found ?? null;
  }

  private async vettingOf(vendorId: string): Promise<SignalVetting | null> {
    const [row] = await this.deps.sql<VettingRow[]>`
      SELECT min_tier, min_fills, tier_seen, fills_seen, first_fill_at, passed_at
        FROM market.signal_vettings WHERE vendor_id = ${vendorId}`;
    return row ? toVetting(row) : null;
  }

  /** The one vetting of this provider: a pass already recorded stands; otherwise the criteria are checked now. */
  private async vetOnce(vendor: VendorRecord, userId: string, tier: SignalTier, criteria: ProviderCriteria): Promise<SignalVetting> {
    const passed = await this.vettingOf(vendor.id);
    if (passed) return passed;
    if (!this.deps.trackRecord) {
      throw new MarketError('The provider’s trading record cannot be read', PROVIDER_RECORD_UNAVAILABLE);
    }
    const record = await this.deps.trackRecord.recordOf(userId);
    const tierOk = tierRank(tier) >= tierRank(criteria.minTier);
    const fillsOk = record.fills >= criteria.minFills;
    if (!tierOk || !fillsOk) {
      throw new MarketError('The provider does not meet the signal provider criteria', PROVIDER_CRITERIA_NOT_MET, {
        minTier: criteria.minTier,
        minFills: criteria.minFills,
        tierSeen: tier,
        fillsSeen: record.fills,
      });
    }
    const [row] = await this.deps.sql<VettingRow[]>`
      INSERT INTO market.signal_vettings (vendor_id, user_id, min_tier, min_fills, tier_seen, fills_seen, first_fill_at)
      VALUES (${vendor.id}, ${userId}, ${criteria.minTier}, ${criteria.minFills}, ${tier}, ${record.fills}, ${record.firstFillAt})
      ON CONFLICT (vendor_id) DO NOTHING
      RETURNING min_tier, min_fills, tier_seen, fills_seen, first_fill_at, passed_at`;
    if (row) return toVetting(row);
    const raced = await this.vettingOf(vendor.id);
    if (!raced) throw new MarketError('Vetting was not recorded', 'market.signal_vetting_missing');
    return raced;
  }

  private async insertSignal(input: {
    vendorId: string;
    publishKey: string;
    title: string;
    description: string;
    assetId: string;
    recommendedAmount: string | null;
    feeModel: 'free' | 'monthly';
    price: string | null;
    periodSeconds: number | null;
  }): Promise<SignalRow> {
    const [row] = await this.deps.sql<SignalRow[]>`
      INSERT INTO market.signals (vendor_id, publish_key, title, description, asset_id, recommended_amount, fee_model, price, period_seconds, status)
      VALUES (${input.vendorId}, ${input.publishKey}, ${input.title}, ${input.description}, ${input.assetId},
              ${input.recommendedAmount}, ${input.feeModel}, ${input.price}, ${input.periodSeconds}, 'pending')
      ON CONFLICT (vendor_id, publish_key) DO NOTHING
      RETURNING ${this.deps.sql.unsafe(SIGNAL_COLUMNS)}`;
    if (row) return row;
    const raced = await this.byKey(input.vendorId, input.publishKey);
    if (!raced) throw new MarketError('Signal was not recorded', SIGNAL_NOT_FOUND);
    return raced;
  }
}

/** The owner's criteria from the environment: both set, or none. */
export function providerCriteriaFromEnv(env: {
  MARKET_SIGNAL_PROVIDER_MIN_TIER?: 'basic' | 'full' | 'institutional' | undefined;
  MARKET_SIGNAL_PROVIDER_MIN_FILLS?: number | undefined;
}): ProviderCriteria | null {
  if (env.MARKET_SIGNAL_PROVIDER_MIN_TIER === undefined || env.MARKET_SIGNAL_PROVIDER_MIN_FILLS === undefined) return null;
  return { minTier: env.MARKET_SIGNAL_PROVIDER_MIN_TIER, minFills: env.MARKET_SIGNAL_PROVIDER_MIN_FILLS };
}

const TRACK_RECORD_TIMEOUT_MS = 5_000;

/** svc-trade `GET /internal/track-record/:userId`. Any transport error, non-200 or bad body refuses; never zero. */
export function createTrackRecordClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): TrackRecordSource {
  const url = baseUrl.replace(/\/$/, '');
  const sign = serviceCallSigner({ service: 'svc-market', audience: 'svc-trade', legacySecret: internalSecret, s2s });
  return {
    async recordOf(userId: string) {
      const target = `${url}/internal/track-record/${encodeURIComponent(userId)}`;
      let response: Response;
      try {
        response = await fetch(target, {
          method: 'GET',
          signal: AbortSignal.timeout(TRACK_RECORD_TIMEOUT_MS),
          headers: {
            'content-type': 'application/json',
            ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
          },
        });
      } catch {
        throw new MarketError('The provider’s trading record cannot be read', PROVIDER_RECORD_UNAVAILABLE);
      }
      if (!response.ok) throw new MarketError('The provider’s trading record cannot be read', PROVIDER_RECORD_UNAVAILABLE);
      const body = (await response.json().catch(() => null)) as { fills?: unknown; firstFillAt?: unknown } | null;
      if (!body || typeof body.fills !== 'number' || !Number.isInteger(body.fills) || body.fills < 0) {
        throw new MarketError('The provider’s trading record cannot be read', PROVIDER_RECORD_UNAVAILABLE);
      }
      const firstFillAt = typeof body.firstFillAt === 'string' ? body.firstFillAt : null;
      return { fills: body.fills, firstFillAt };
    },
  };
}
