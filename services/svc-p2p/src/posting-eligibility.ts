/**
 * WHAT A PERSON NEEDS BEFORE POSTING AN AD IN A FIAT (P-ads-merchant-12).
 *
 * Compliance publishes the posting thresholds per fiat currency in
 * `P2P_POSTING_THRESHOLDS`, a JSON object:
 *
 *   { "EUR": { "minKycTier": "basic", "minCompletedOrders": "5", "minCompletionRatePct": "90" }, "USD": "none" }
 *
 *   · a fiat with thresholds: every one must be met to post an ad in it;
 *   · "none": compliance says there is no posting threshold for that fiat, so
 *     only the jurisdiction gate applies (it runs on every P2P call);
 *   · a fiat not listed, or the setting blank: posting in it refuses
 *     `p2p.config_unset` naming the fiat (spec C3: a gate that admits posting
 *     treats an unpublished setting as closed);
 *   · a value that is not a whole list refuses every post with
 *     `p2p.posting_thresholds_invalid`, and no fiat is judged against it.
 *
 * Every threshold is a string: the tier a name from `KYC_TIERS`, the order
 * count a whole number, the completion rate a percent with at most two places.
 * The rate is compared in hundredths of a percent, never as a float.
 *
 * `postingChecks` is the one place a check is judged, so the checklist the form
 * shows and the refusal at post can never disagree.
 */
import { KYC_TIERS, tierSatisfies, type KycTier } from '@intafaced/config';
import { SCALE, parseAmount } from '@intafaced/ledger-client';

export const POSTING_THRESHOLDS_SETTING = 'P2P_POSTING_THRESHOLDS';

export const POSTING_CHECK_IDS = ['kyc_tier', 'completed_orders', 'completion_rate'] as const;
export type PostingCheckId = (typeof POSTING_CHECK_IDS)[number];
export const POSTING_CHECK_STATES = ['met', 'not_met', 'unknown'] as const;
export type PostingCheckState = (typeof POSTING_CHECK_STATES)[number];

export interface PostingCheck {
  readonly id: PostingCheckId;
  readonly state: PostingCheckState;
  /** The person's value now, as a string, or null when it cannot be read. */
  readonly current: string | null;
  /** What posting needs, as a string, or null when nothing is published. */
  readonly required: string | null;
  /** Why, as a code the app turns into words. Never prose from here. */
  readonly reason: string;
}

export interface FiatPostingThreshold {
  readonly minKycTier?: KycTier;
  readonly minCompletedOrders?: string;
  readonly minCompletionRatePct?: string;
}

export type PostingThresholds =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid' }
  | { readonly status: 'active'; readonly byFiat: ReadonlyMap<string, FiatPostingThreshold | 'none'> };

/** What the policy says for one fiat. */
export const POSTING_POLICIES = ['thresholds', 'none', 'unset', 'invalid'] as const;
export type FiatPostingPolicy = (typeof POSTING_POLICIES)[number];

const FIAT = /^[A-Z]{3}$/;
const COUNT = /^\d{1,9}$/;
const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/;
const THRESHOLD_KEYS = new Set(['minKycTier', 'minCompletedOrders', 'minCompletionRatePct']);

/** A percent string ("90", "95.24") in hundredths of a percent, or null when it is not one. */
export function percentHundredths(value: string): number | null {
  if (!PERCENT.test(value)) return null;
  const hundredths = Number(parseAmount(value) / (SCALE / 100n));
  return hundredths <= 10_000 ? hundredths : null;
}

function parseThreshold(value: unknown): FiatPostingThreshold | 'none' | null {
  if (value === 'none') return 'none';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([key]) => !THRESHOLD_KEYS.has(key))) return null;
  const { minKycTier, minCompletedOrders, minCompletionRatePct } = value as Record<string, unknown>;
  if (minKycTier !== undefined && !(typeof minKycTier === 'string' && (KYC_TIERS as readonly string[]).includes(minKycTier))) return null;
  if (minCompletedOrders !== undefined && !(typeof minCompletedOrders === 'string' && COUNT.test(minCompletedOrders))) return null;
  if (minCompletionRatePct !== undefined && !(typeof minCompletionRatePct === 'string' && percentHundredths(minCompletionRatePct) !== null))
    return null;
  return {
    ...(minKycTier === undefined ? {} : { minKycTier: minKycTier as KycTier }),
    ...(minCompletedOrders === undefined ? {} : { minCompletedOrders }),
    ...(minCompletionRatePct === undefined ? {} : { minCompletionRatePct }),
  };
}

export function parsePostingThresholds(raw: string | undefined): PostingThresholds {
  if (raw === undefined || raw.trim() === '') return { status: 'absent' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: 'invalid' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { status: 'invalid' };
  const byFiat = new Map<string, FiatPostingThreshold | 'none'>();
  for (const [fiat, entry] of Object.entries(value)) {
    const threshold = FIAT.test(fiat) ? parseThreshold(entry) : null;
    if (threshold === null) return { status: 'invalid' };
    byFiat.set(fiat, threshold);
  }
  return byFiat.size === 0 ? { status: 'invalid' } : { status: 'active', byFiat };
}

export function fiatPostingPolicy(
  thresholds: PostingThresholds,
  fiatCurrency: string,
): { policy: FiatPostingPolicy; threshold: FiatPostingThreshold | null } {
  if (thresholds.status === 'invalid') return { policy: 'invalid', threshold: null };
  const entry = thresholds.status === 'active' ? thresholds.byFiat.get(fiatCurrency) : undefined;
  if (entry === undefined) return { policy: 'unset', threshold: null };
  return entry === 'none' ? { policy: 'none', threshold: null } : { policy: 'thresholds', threshold: entry };
}

/** Whether judging this threshold needs the person's order history (a read of their trades). */
export function needsOrderHistory(threshold: FiatPostingThreshold): boolean {
  return threshold.minCompletedOrders !== undefined || threshold.minCompletionRatePct !== undefined;
}

/** The person's facts a threshold is judged on. */
export interface PostingFacts {
  /** The signed-in verification level, or undefined when none came with the request. */
  readonly tier: KycTier | undefined;
  readonly completedOrders: number;
  /** Lifetime orders with an outcome, the rate's denominator; the threshold is judged on the counts, never the rounded rate. */
  readonly countedOrders: number;
  /** Lifetime completion rate as a percent string, shown to the person, or null when no order has an outcome. */
  readonly completionRatePct: string | null;
}

function judge(id: PostingCheckId, met: boolean, current: string, required: string): PostingCheck {
  return { id, state: met ? 'met' : 'not_met', current, required, reason: met ? 'posting.met' : 'p2p.posting_threshold_not_met' };
}

/** One check per published threshold, in the order the checklist shows them. */
export function postingChecks(threshold: FiatPostingThreshold, facts: PostingFacts): PostingCheck[] {
  const checks: PostingCheck[] = [];
  if (threshold.minKycTier !== undefined) {
    const required = threshold.minKycTier;
    checks.push(
      facts.tier === undefined
        ? { id: 'kyc_tier', state: 'unknown', current: null, required, reason: 'p2p.verification_level_unwired' }
        : judge('kyc_tier', tierSatisfies(facts.tier, required), facts.tier, required),
    );
  }
  if (threshold.minCompletedOrders !== undefined) {
    const required = threshold.minCompletedOrders;
    checks.push(judge('completed_orders', facts.completedOrders >= Number(required), String(facts.completedOrders), required));
  }
  if (threshold.minCompletionRatePct !== undefined) {
    const required = threshold.minCompletionRatePct;
    // completed / counted >= required%, as completed * 10000 >= required in hundredths * counted: exact, so a rate that
    // rounds up to the target (89.995% shown as 90.00) does not meet a 90% threshold.
    const met = BigInt(facts.completedOrders) * 10_000n >= BigInt(percentHundredths(required)!) * BigInt(facts.countedOrders);
    checks.push(
      facts.countedOrders === 0 || facts.completionRatePct === null
        ? { id: 'completion_rate', state: 'unknown', current: null, required, reason: 'p2p.completion_rate_none' }
        : judge('completion_rate', met, facts.completionRatePct, required),
    );
  }
  return checks;
}

/** A tier name from the request, or undefined when it is not one of `KYC_TIERS`. */
export function asKycTier(value: string | undefined): KycTier | undefined {
  return KYC_TIERS.find((tier) => tier === value);
}
