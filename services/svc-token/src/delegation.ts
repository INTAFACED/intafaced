import { TokenError } from './token-service.js';

/**
 * Voting-power delegation (MC-token-04).
 *
 * Parked while no chain GO is recorded (`chain.go`). A call writes no row,
 * picks no delegate, and does not treat the caller as their own delegate.
 * The read is null for the same reason: no data, not a zero weight.
 */

export const DELEGATION_PARKED = 'token.delegation_parked' as const;

/** Member ids only. A chain address is not a delegation this service can store. */
const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parkedDelegation(): { delegateeUserId: null; parked: typeof DELEGATION_PARKED } {
  return { delegateeUserId: null, parked: DELEGATION_PARKED };
}

/** Always refuses. Blank and malformed targets are named before the park. */
export function refuseDelegation(delegateeUserId: string | null | undefined): never {
  const raw = delegateeUserId ?? '';
  if (raw.trim() === '') {
    throw new TokenError('The delegation target is unset', 'token.delegation_delegatee_unset');
  }
  if (!MEMBER_ID.test(raw.trim())) {
    throw new TokenError('The delegation target is not a member id', 'token.delegation_delegatee_invalid');
  }
  throw new TokenError('Delegation is parked; no chain GO is recorded, so nothing was saved', 'token.delegation_parked');
}
