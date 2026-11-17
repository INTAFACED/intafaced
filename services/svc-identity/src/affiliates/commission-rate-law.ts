/**
 * Affiliate commission accrual rate law (DIRECTION §8).
 *
 * Fee-share / IB tier rates are owner-only. Blank / unpublished → refuse-closed
 * at accrual — never invent any percentage as a platform
 * default. Mirrors services/svc-trade/src/copy/fee-share-law.ts.
 *
 * Payout already refused; the invent hole was accrual writing durable rows
 * under DEFAULT_ACCRUAL_TIERS. That constant is gone.
 */

import type { TierRate } from './commission.js';
import { CommissionError } from './commission.js';

export type AccrualTierLaw = { readonly published: false } | { readonly published: true; readonly tiers: readonly TierRate[] };

/** Production default — no invent. */
export const UNPUBLISHED_ACCRUAL_TIER_LAW: AccrualTierLaw = { published: false };

/**
 * Stable residual — grep-able in PRECONDITION_FAILED messages and audits.
 * Same class of residual as AFFILIATE_PAYOUT_RESIDUAL, but the refuse fires at
 * accrual (where a money claim is created), not only at payout.
 */
export const AFFILIATE_ACCRUAL_RATE_RESIDUAL =
  'DIRECTION §8 fee-share / IB rates are owner-only — refuse-closed at accrual (never invent commission percentages)';

export type AccrualRateRefuseCode = 'affiliate.accrual.rates_unset' | 'affiliate.accrual.invent_refused';

/**
 * Named refuse when neither the request nor owner-published env supplies tiers,
 * or when durable accrue is asked to invent via per-call tiers (D26-P1-O2).
 * Never invent fee-share rates to avoid a refuse.
 */
export class AccrualRateRefuseError extends Error {
  constructor(
    message: string,
    readonly code: AccrualRateRefuseCode,
    readonly residual: string,
  ) {
    super(message);
    this.name = 'AccrualRateRefuseError';
  }
}

const RATE_RE = /^(0(\.\d{1,18})?|1(\.0{1,18})?)$/;

function assertTierShape(raw: unknown, path: string): TierRate {
  if (!raw || typeof raw !== 'object') {
    throw new CommissionError(`${path} must be an object`, 'commission.rate');
  }
  const obj = raw as Record<string, unknown>;
  const hop = obj.hop;
  if (typeof hop !== 'number' || !Number.isInteger(hop) || hop < 0 || hop > 20) {
    throw new CommissionError(`${path}.hop must be an integer 0..20`, 'commission.rate');
  }
  if (typeof obj.rate !== 'string' || !RATE_RE.test(obj.rate.trim())) {
    throw new CommissionError(`${path}.rate must be a decimal string in [0,1]`, 'commission.rate');
  }
  return { hop, rate: obj.rate.trim() };
}

/**
 * Parse owner-published accrual tiers from env JSON.
 * Empty / whitespace → unpublished. Invalid → throw (fail boot, do not invent).
 *
 * Shape:
 *   { "published": false }
 *   { "published": true, "tiers": [{ "hop": 0, "rate": "<decimal 0..1>" }, ...] }
 */
export function parseAccrualTierLawJson(raw: string | null | undefined): AccrualTierLaw {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return UNPUBLISHED_ACCRUAL_TIER_LAW;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new CommissionError('IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON is not valid JSON', 'commission.rate');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new CommissionError('IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON must be an object', 'commission.rate');
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.published === false) return UNPUBLISHED_ACCRUAL_TIER_LAW;
  if (obj.published !== true) {
    throw new CommissionError('IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON.published must be true or false', 'commission.rate');
  }

  if (!Array.isArray(obj.tiers) || obj.tiers.length === 0) {
    throw new CommissionError('IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON.tiers must be a non-empty array when published', 'commission.rate');
  }
  if (obj.tiers.length > 20) {
    throw new CommissionError('IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON.tiers exceeds max 20', 'commission.rate');
  }

  const tiers = obj.tiers.map((t, i) => assertTierShape(t, `tiers[${i}]`));
  return { published: true, tiers };
}

/**
 * Resolve tiers for one accrue / dry-run call.
 *
 * Order:
 *   1. Non-empty request tiers (dry-run simulation only — see accrual-tree-authority.ts;
 *      durable accrue refuses invent via `affiliate.accrual.invent_refused` before calling here)
 *   2. Owner-published env law
 *   3. Refuse — never invent
 *
 * D26-P1-O2: production durable path must not pass requestTiers.
 */
export function resolveAccrualTiers(input: {
  readonly requestTiers?: readonly TierRate[] | null | undefined;
  readonly law: AccrualTierLaw;
}): readonly TierRate[] {
  if (input.requestTiers && input.requestTiers.length > 0) {
    return input.requestTiers;
  }
  if (input.law.published) {
    return input.law.tiers;
  }
  throw new AccrualRateRefuseError(
    'Affiliate commission accrual is refuse-closed until owner-published fee-share rates exist',
    'affiliate.accrual.rates_unset',
    AFFILIATE_ACCRUAL_RATE_RESIDUAL,
  );
}

/** True when law carries published tiers. */
export function accrualTierLawIsPublished(law: AccrualTierLaw): boolean {
  return law.published === true;
}

/** Status line for ops boards — never invents rates into the string. */
export function accrualTierLawStatusLine(law: AccrualTierLaw): string {
  if (!law.published) return 'published=0 tiers=0';
  return `published=1 tiers=${law.tiers.length}`;
}
