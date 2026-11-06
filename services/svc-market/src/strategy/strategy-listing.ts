import { MarketError } from '../vendor-service.js';
import type { CommerceService, ListingRecord, ReviewedListingRecord } from '../commerce/commerce-service.js';

/**
 * Strategy marketplace glue on market.commerce — not a second shop.
 *
 * Publish is createListing(subscription) with periodSeconds required.
 * Token gate is the existing vendor stake / slot claim.
 * Copy-law: no fee from follower P&L. Catalogue is registration order, never +% return.
 * Compute-tier magnitudes stay owner-only — this file invents none.
 */

const PROFIT_SHARE_KEYS = [
  'profitShare',
  'profitShareBps',
  'pnlFee',
  'pnlShare',
  'performanceFee',
  'successFee',
  'highWaterMark',
  'hurdleRate',
] as const;

const RETURN_RANK_KEYS = ['returnRank', 'rankByReturn', 'returnPct', 'pnlPct'] as const;

export type StrategyListingInput = {
  userId: string;
  title: string;
  description: string;
  assetId: string;
  price: string;
  periodSeconds: number;
};

export function refuseStrategyCopyLaw(input: Record<string, unknown>): void {
  for (const key of PROFIT_SHARE_KEYS) {
    if (input[key] != null) {
      throw new MarketError('Strategy listings cannot charge a fee from follower P&L', 'market.strategy_profit_share_forbidden');
    }
  }
  for (const key of RETURN_RANK_KEYS) {
    if (input[key] != null) {
      throw new MarketError('Strategy catalogue is registration order — not ranked by return', 'market.strategy_return_rank_forbidden');
    }
  }
}

export function toStrategyCreateListingInput(input: StrategyListingInput & Record<string, unknown>): {
  userId: string;
  title: string;
  description: string;
  offerType: 'subscription';
  assetId: string;
  price: string;
  periodSeconds: number;
} {
  refuseStrategyCopyLaw(input);
  const periodSeconds = input.periodSeconds;
  if (periodSeconds == null || !Number.isInteger(periodSeconds) || periodSeconds <= 0) {
    throw new MarketError(
      'Strategy listings need a period in whole seconds — no default cadence is invented',
      'market.subscription_period_unset',
    );
  }
  return {
    userId: input.userId,
    title: input.title,
    description: input.description,
    offerType: 'subscription',
    assetId: input.assetId,
    price: input.price,
    periodSeconds,
  };
}

export async function createStrategyListing(
  commerce: Pick<CommerceService, 'createListing'>,
  input: StrategyListingInput & Record<string, unknown>,
): Promise<ReviewedListingRecord> {
  return commerce.createListing(toStrategyCreateListingInput(input));
}

export type StrategyCatalogueRow = {
  id: string;
  title: string;
  description: string;
  assetId: string;
  price: string;
  periodSeconds: number;
  createdAt: string;
};

/** Registration order. No return / P&L field is projected. */
export function strategyCatalogue(listings: ListingRecord[]): StrategyCatalogueRow[] {
  return listings
    .filter((row) => row.offerType === 'subscription' && row.periodSeconds != null && row.periodSeconds > 0)
    .slice()
    .sort((a, b) => {
      const byTime = a.createdAt.localeCompare(b.createdAt);
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
    })
    .map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      assetId: row.assetId,
      price: row.price,
      periodSeconds: row.periodSeconds as number,
      createdAt: row.createdAt,
    }));
}
