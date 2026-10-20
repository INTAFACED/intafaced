/**
 * The derivatives gate in front of a futures open (D-account-07).
 *
 * One call, two checks, both refusing honestly when the owner has published nothing:
 *
 *   1. the current version of each required agreement is published for the caller's region and accepted
 *      (`trade.agreement_unpublished`, `trade.agreement_region_unavailable`, `trade.agreement_required`);
 *   2. the caller holds the derivatives level under the current rule version, at or above the rule's verification tier
 *      (`trade.derivatives_eligibility_unset`, `trade.identity_level_insufficient`, `trade.identity_level_unavailable`).
 *
 * There is no switch that turns the gate off in production: unset means refused. Only a closing or reducing action
 * skips it, and that skip lives in `PositionService.open` (a reduce-only open) and in `close*`, which never call it.
 */
import { AgreementError, assertAgreementsAccepted, type AgreementKind, type RiskAgreementStore } from './risk-agreements.js';
import { assertEligible, EligibilityError, type EligibilityStore } from './derivatives-eligibility.js';

/** What the open knows about the caller. `tier` is the principal's verification tier; `region` is the edge region. */
export interface DerivativesAccessSubject {
  readonly userId: string;
  readonly tier: string | null;
  readonly region: string | null;
}

export type DerivativesAccessGate = (subject: DerivativesAccessSubject) => Promise<void>;

/** The kinds a futures open needs. Margin terms are checked by the margin-borrow door, which is not on this branch. */
export const FUTURES_OPEN_AGREEMENT_KINDS: readonly AgreementKind[] = ['derivatives_risk'];

export function derivativesAccessGate(deps: {
  readonly agreements: RiskAgreementStore;
  readonly eligibility: EligibilityStore;
  readonly kinds?: readonly AgreementKind[];
}): DerivativesAccessGate {
  const kinds = deps.kinds ?? FUTURES_OPEN_AGREEMENT_KINDS;
  return async (subject) => {
    await assertAgreementsAccepted(deps.agreements, { userId: subject.userId, kinds, region: subject.region });
    await assertEligible(deps.eligibility, { userId: subject.userId, tier: subject.tier });
  };
}

/** A refusal from this gate. Used by the REST layer to answer with the typed body. */
export function isDerivativesAccessError(err: unknown): err is AgreementError | EligibilityError {
  return err instanceof AgreementError || err instanceof EligibilityError;
}

export function presentDerivativesAccessError(err: AgreementError | EligibilityError): {
  error: string;
  message: string;
  [detail: string]: unknown;
} {
  return { ...err.detail, error: err.code, message: err.message };
}
