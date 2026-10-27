/**
 * The derivatives gate in front of a futures open (D-account-07).
 *
 * One check: the caller holds the verification tier the published eligibility rules name
 * (`trade.identity_level_insufficient`, `trade.identity_level_unavailable`). The risk agreement, the margin terms
 * and the suitability quiz no longer gate an open (owner decision 2026-10-27, until launch prep).
 *
 * Only a closing or reducing action skips it, and that skip lives in `PositionService.open` (a reduce-only open) and
 * in `close*`, which never call it.
 */
import { assertIdentityLevel, EligibilityError, type EligibilityStore } from './derivatives-eligibility.js';

/** What the open knows about the caller. `tier` is the principal's verification tier; `region` is the edge region. */
export interface DerivativesAccessSubject {
  readonly userId: string;
  readonly tier: string | null;
  readonly region: string | null;
}

export type DerivativesAccessGate = (subject: DerivativesAccessSubject) => Promise<void>;

export function derivativesAccessGate(deps: { readonly eligibility: EligibilityStore }): DerivativesAccessGate {
  return async (subject) => {
    await assertIdentityLevel(deps.eligibility, { userId: subject.userId, tier: subject.tier });
  };
}

/** A refusal from this gate. Used by the REST layer to answer with the typed body. */
export function isDerivativesAccessError(err: unknown): err is EligibilityError {
  return err instanceof EligibilityError;
}

export function presentDerivativesAccessError(err: EligibilityError): {
  error: string;
  message: string;
  [detail: string]: unknown;
} {
  return { ...err.detail, error: err.code, message: err.message };
}
