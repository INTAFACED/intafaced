/**
 * trade.futures product policy — honesty door (jobs capability + insurance list + ADL disclosure).
 *
 * Combines bot/integrator-facing notes that were split across capability, listing,
 * and disclosure modules. Does not start jobs, read pots, or invent owner numbers.
 */

/** Stable product copy version — bump only when the disclosed meaning changes. */
export const ADL_DISCLOSURE_VERSION = 'DIRECTION-2026-07-31:34' as const;

/**
 * In-product disclosure text. Describes mechanism existence only — no invented
 * threshold, ranking formula, or reduce size.
 */
export const ADL_DISCLOSURE_COPY =
  'Auto-deleveraging (ADL) is a last-resort risk control. If a liquidated ' +
  'position\u2019s shortfall cannot be covered by its margin and the insurance fund, ' +
  'the platform may reduce profitable opposite-side positions. ADL does not run ' +
  'silently: a disclosure event is recorded before any reduce, and thresholds or ' +
  'ranking are owner-configured (unset \u2192 ADL refuses rather than inventing ' +
  'parameters).';

export type FuturesJobsCapabilityNote = {
  readonly orderableEnabled: boolean;
  readonly orderableDefault: false;
  readonly jobsEnabled: boolean;
  readonly jobsDefault: false;
  readonly profitSourceConfigured: boolean;
  readonly profitSourceDefault: false;
  readonly nextFundingTimestamp: 'unpublished';
  readonly indexPrice: 'unpublished';
  readonly ladderNumbers: 'd3_unset';
  /** DIRECTION:33 — empty insurance pot blocks live list. Size stays owner law. */
  readonly insuranceEmptyBlocksLiveList: true;
  readonly insuranceTargetSize: 'owner_unset';
  /** BUILD-STOP D2 — no invented |rate| ceiling. True only when env is a non-empty string. */
  readonly fundingMaxAbsRateConfigured: boolean;
  readonly fundingMaxAbsRateDefault: false;
  /** Count only — never the UUID list. Omitted / non-positive → 0. */
  readonly fundingMarketCount: number;
  /** True only when a known venue adapter + non-empty symbol map is wired. Never echoes venue id or symbols. */
  readonly venueMarkConfigured: boolean;
  readonly venueMarkDefault: false;
  /** True only when TRADE_FUTURES_FUNDING_INTERVAL_MS is a named integer. Never echoes the ms. */
  readonly fundingIntervalConfigured: boolean;
  readonly fundingIntervalDefault: false;
};

export function presentFuturesJobsCapabilityNote(input: {
  readonly jobsEnabled?: boolean;
  readonly orderableEnabled?: boolean;
  readonly profitSourceConfigured?: boolean;
  readonly fundingMaxAbsRateConfigured?: boolean;
  readonly fundingMarketCount?: number;
  readonly venueMarkConfigured?: boolean;
  readonly fundingIntervalConfigured?: boolean;
}): FuturesJobsCapabilityNote {
  const raw = input.fundingMarketCount;
  const fundingMarketCount = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  return {
    orderableEnabled: input.orderableEnabled === true,
    orderableDefault: false,
    jobsEnabled: input.jobsEnabled === true,
    jobsDefault: false,
    profitSourceConfigured: input.profitSourceConfigured === true,
    profitSourceDefault: false,
    nextFundingTimestamp: 'unpublished',
    indexPrice: 'unpublished',
    ladderNumbers: 'd3_unset',
    insuranceEmptyBlocksLiveList: true,
    insuranceTargetSize: 'owner_unset',
    fundingMaxAbsRateConfigured: input.fundingMaxAbsRateConfigured === true,
    fundingMaxAbsRateDefault: false,
    fundingMarketCount,
    venueMarkConfigured: input.venueMarkConfigured === true,
    venueMarkDefault: false,
    fundingIntervalConfigured: input.fundingIntervalConfigured === true,
    fundingIntervalDefault: false,
  };
}

/** Ops/bot-facing listing policy. Does not read the pot (no invented funded). Size/schedule stay owner-unset. */
export function presentInsuranceListingPolicy(): {
  readonly emptyPotBlocksLiveList: true;
  readonly targetSize: 'owner_unset';
} {
  return { emptyPotBlocksLiveList: true, targetSize: 'owner_unset' };
}

export type FuturesPolicySummary = {
  readonly jobs: FuturesJobsCapabilityNote;
  readonly insuranceListing: ReturnType<typeof presentInsuranceListingPolicy>;
  readonly adlDisclosure: {
    readonly version: typeof ADL_DISCLOSURE_VERSION;
    readonly copy: typeof ADL_DISCLOSURE_COPY;
    readonly inventsThresholds: false;
    readonly inventsRanking: false;
  };
  readonly datedFutures: {
    readonly expiryRequiredCode: 'trade.dated_futures_expiry_required';
    readonly termsIncompleteCode: 'trade.dated_futures_terms_incomplete';
    readonly fixingUnconfiguredCode: 'trade.dated_futures_fixing_unconfigured';
    readonly settlementPriceUnsetCode: 'trade.dated_futures_settlement_price_unset';
    readonly expiredCode: 'trade.dated_futures_expired';
    readonly inventsLastTradeSettlement: false;
    readonly infersStyleFromSymbol: false;
  };
};

/** Public trade.futures policy door — mirrors capability + listing + ADL disclosure law. */
export function describeFuturesPolicy(input: Parameters<typeof presentFuturesJobsCapabilityNote>[0] = {}): FuturesPolicySummary {
  return {
    jobs: presentFuturesJobsCapabilityNote(input),
    insuranceListing: presentInsuranceListingPolicy(),
    adlDisclosure: {
      version: ADL_DISCLOSURE_VERSION,
      copy: ADL_DISCLOSURE_COPY,
      inventsThresholds: false,
      inventsRanking: false,
    },
    datedFutures: {
      expiryRequiredCode: 'trade.dated_futures_expiry_required',
      termsIncompleteCode: 'trade.dated_futures_terms_incomplete',
      fixingUnconfiguredCode: 'trade.dated_futures_fixing_unconfigured',
      settlementPriceUnsetCode: 'trade.dated_futures_settlement_price_unset',
      expiredCode: 'trade.dated_futures_expired',
      inventsLastTradeSettlement: false,
      infersStyleFromSymbol: false,
    },
  };
}
