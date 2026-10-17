/**
 * DIRECTION:33 — INSURANCE FUND LISTING GATE
 *
 * "Insurance fund must exist and be funded before a single real-money position
 * opens. … If it is empty, futures do not list."
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS / IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * IS: refuse-closed production listing (and enable-to-active) when the named
 * insurance account holds nothing. Any positive balance is "funded" for this
 * gate — enough to prove the pot exists and can take a shortfall leg.
 *
 * IS NOT: target size, fee share, capitalisation schedule, or ADL policy.
 * Those remain owner-open (D4 / owner packet). This unit deliberately does not
 * invent a number.
 *
 * Account identity comes from `recipeInsuranceAccount` so the listing gate and
 * the shortfall bound cannot drift onto different pots.
 */
import { formatAmount, type AccountRef, type Amount, type Balance } from '@intafaced/ledger-client';
import { logRefusalSpec } from '../refusal-spec-log.js';
import { recipeInsuranceAccount } from './insurance-bound.js';
import { formatAccountRef } from './profit-source.js';

/** Honest refuse code when real-money futures would list against an empty fund. */
export const INSURANCE_FUND_EMPTY = 'trade.insurance_fund_empty' as const;

export interface InsuranceListingGateInput {
  readonly kind: string;
  readonly status: string;
  /** Paper / drills — DIRECTION gates real-money only. */
  readonly paper: boolean;
  /** Quote asset of the futures market (insurance pot is per asset). */
  readonly quoteAsset: string;
  readonly balance: (ref: AccountRef) => Promise<Balance>;
}

export interface InsuranceListingGateOk {
  readonly ok: true;
  readonly account: AccountRef;
  readonly available: Amount;
}

export interface InsuranceListingGateRefuse {
  readonly ok: false;
  readonly account: AccountRef;
  readonly available: Amount;
  readonly reason: string;
  readonly code: typeof INSURANCE_FUND_EMPTY;
}

export type InsuranceListingGateCheck = InsuranceListingGateOk | InsuranceListingGateRefuse;

/**
 * Does this listing / enable require a funded insurance pot, and if so is it
 * funded?
 *
 * Non-futures, paper, and non-active statuses skip the balance read — modelling
 * a pending futures row without capital is honest; opening real-money risk is not.
 */
export async function checkInsuranceFundedForListing(input: InsuranceListingGateInput): Promise<InsuranceListingGateCheck> {
  const account = recipeInsuranceAccount(input.quoteAsset);

  if (input.kind !== 'futures' || input.paper || input.status !== 'active') {
    return { ok: true, account, available: 0n };
  }

  const { amount: available } = await input.balance(account);
  if (available <= 0n) {
    logRefusalSpec('trade.insurance_fund_empty');
    return {
      ok: false,
      account,
      available,
      code: INSURANCE_FUND_EMPTY,
      reason:
        `Futures cannot be listed for real money yet: insurance fund ${formatAccountRef(account)} ` +
        `holds ${formatAmount(available)} ${input.quoteAsset}. A positive balance is required. The target size is not set here.`,
    };
  }

  return { ok: true, account, available };
}

export { presentInsuranceListingPolicy } from './futures-policy.js';
