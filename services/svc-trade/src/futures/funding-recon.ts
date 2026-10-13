/**
 * Funding recon across surfaces (CARD F7 / PTX-M10-R05 / PX-S06).
 *
 * Predict / accrue / settle / correct / report share ONE recipe:
 * `planFundingSettlement` with one owner rate. UI/API/ledger cannot diverge
 * by silent default (a blank predict rate is not 0 while settle waits).
 * This mill does not invent a rate and does not recut svc-ledger.
 *
 * Hitch: settle already posts `recipes.futuresFundingPay` via
 * `planFundingSettlement` in funding-tick.ts. This file is the recon door
 * every surface must call so they cannot pick a second rate.
 */
import { formatAmount, type PostRequest } from '@intafaced/ledger-client';
import { planFundingSettlement, type FundingLeg, type FundingOpenPosition, type FundingPlanInput } from './funding-settlement.js';

export const FUNDING_SURFACES = ['predict', 'accrue', 'settle', 'correct', 'report'] as const;
export type FundingSurface = (typeof FUNDING_SURFACES)[number];

export const FUNDING_RATE_UNSET = 'trade.funding_rate_unset' as const;
export const FUNDING_RECON_DIVERGED = 'trade.funding_recon_diverged' as const;

export type FundingReconRefuseCode = typeof FUNDING_RATE_UNSET | typeof FUNDING_RECON_DIVERGED;

export class FundingReconError extends Error {
  readonly code: FundingReconRefuseCode;
  readonly status = 400;
  constructor(code: FundingReconRefuseCode, message: string) {
    super(message);
    this.name = 'FundingReconError';
    this.code = code;
  }
}

export type FundingReconCheck =
  | {
      readonly ok: true;
      readonly rate: string;
      readonly legs: readonly FundingLeg[];
      readonly fingerprint: string;
    }
  | { readonly ok: false; readonly code: FundingReconRefuseCode; readonly reason: string };

/** Owner decimal string. Blank / null / non-string refuses — never invent a rate. */
export function requireOwnerFundingRate(rate: unknown): string {
  if (rate == null || typeof rate !== 'string' || rate.trim() === '') {
    throw new FundingReconError(
      FUNDING_RATE_UNSET,
      'funding rate is unset — refuse rather than invent a rate for predict/accrue/settle/correct/report',
    );
  }
  return rate.trim();
}

function fingerprintLegs(legs: readonly FundingLeg[]): string {
  return legs.map((l) => `${l.recipe.idempotencyKey}:${l.payerPositionId}:${l.payeePositionId}:${formatAmount(l.amount)}`).join('|');
}

export interface FundingReconInput {
  readonly periodId: string;
  readonly marketId: string;
  readonly rate: unknown;
  readonly maxAbsRate: string | null;
  readonly positions: readonly FundingOpenPosition[];
  /** Optional per-surface rates. Any that differ from `rate` refuse recon. */
  readonly surfaceRates?: Partial<Record<FundingSurface, unknown>>;
}

function planFromOwnerRate(input: FundingReconInput, rate: string): FundingReconCheck {
  const planInput: FundingPlanInput = {
    periodId: input.periodId,
    marketId: input.marketId,
    rate,
    maxAbsRate: input.maxAbsRate,
    positions: input.positions,
  };
  const legs = planFundingSettlement(planInput);
  return { ok: true, rate, legs, fingerprint: fingerprintLegs(legs) };
}

/**
 * One recipe for one surface. Same owner rate as every other surface.
 * Does not post. Does not invent a rate.
 */
export function fundingRecipeForSurface(surface: FundingSurface, input: FundingReconInput): FundingReconCheck {
  void surface;
  try {
    const rate = requireOwnerFundingRate(input.rate);
    return planFromOwnerRate(input, rate);
  } catch (err) {
    if (err instanceof FundingReconError) {
      return { ok: false, code: err.code, reason: err.message };
    }
    throw err;
  }
}

/**
 * Reconcile all five surfaces onto one recipe. A silent default on any
 * surface (blank predict vs published settle, or two different decimals)
 * refuses rather than letting UI/API/ledger diverge.
 */
export function reconFundingSurfaces(input: FundingReconInput): FundingReconCheck {
  let ownerRate: string;
  try {
    ownerRate = requireOwnerFundingRate(input.rate);
  } catch (err) {
    if (err instanceof FundingReconError) {
      return { ok: false, code: err.code, reason: err.message };
    }
    throw err;
  }

  for (const surface of FUNDING_SURFACES) {
    const extra = input.surfaceRates?.[surface];
    if (extra === undefined) continue;
    let named: string;
    try {
      named = requireOwnerFundingRate(extra);
    } catch (err) {
      if (err instanceof FundingReconError) {
        return {
          ok: false,
          code: FUNDING_RECON_DIVERGED,
          reason: `${surface} funding rate is unset while owner rate is published — refuse a silent default`,
        };
      }
      throw err;
    }
    if (named !== ownerRate) {
      return {
        ok: false,
        code: FUNDING_RECON_DIVERGED,
        reason: `${surface} funding rate ${JSON.stringify(named)} diverges from owner rate ${JSON.stringify(ownerRate)} — refuse rather than let UI/API/ledger disagree`,
      };
    }
  }

  const recipes: FundingReconCheck[] = FUNDING_SURFACES.map((surface) => fundingRecipeForSurface(surface, input));
  const first = recipes[0]!;
  if (!first.ok) return first;
  for (let i = 1; i < recipes.length; i++) {
    const next = recipes[i]!;
    if (!next.ok) return next;
    if (next.fingerprint !== first.fingerprint) {
      return {
        ok: false,
        code: FUNDING_RECON_DIVERGED,
        reason: `${FUNDING_SURFACES[i]} recipe diverges from predict — refuse rather than let UI/API/ledger disagree`,
      };
    }
  }
  return first;
}

/** Settle surface posts these recipes. Predict/accrue/correct/report read the same legs and do not post. */
export function settleRecipesFromRecon(check: Extract<FundingReconCheck, { ok: true }>): readonly PostRequest[] {
  return check.legs.map((l) => l.recipe);
}
