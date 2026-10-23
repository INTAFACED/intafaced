import { TokenError } from './token-service.js';

/**
 * Voting-power delegation (MC-token-04).
 *
 * INTACHAIN P1 GO is recorded. There is still no chain service and no on-chain
 * delegate registry, so the protocol blocker is `no_chain_service`. A call
 * writes no row, picks no delegate, and does not treat the caller as their
 * own delegate. The read is a null delegatee with that blocker, not a weight.
 */

export const DELEGATION_UNAVAILABLE = 'token.delegation_unavailable' as const;
export const DELEGATION_BLOCKER = 'no_chain_service' as const;

/** Member ids only. A chain address is not a delegation this service can store. */
const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function unavailableDelegation(): { delegateeUserId: null; blocker: typeof DELEGATION_BLOCKER } {
  return { delegateeUserId: null, blocker: DELEGATION_BLOCKER };
}

/** Always refuses. Blank and non-member targets are named before the chain blocker. */
export function refuseDelegation(delegateeUserId: string | null | undefined): never {
  const raw = delegateeUserId ?? '';
  if (raw.trim() === '') {
    throw new TokenError('The delegation target is unset', 'token.delegation_delegatee_unset');
  }
  if (!MEMBER_ID.test(raw.trim())) {
    throw new TokenError('The delegation target is not a member id', 'token.delegation_delegatee_invalid');
  }
  throw new TokenError(
    'There is no chain service and no on-chain delegate registry, so nothing was saved',
    DELEGATION_UNAVAILABLE,
    undefined,
    undefined,
    DELEGATION_BLOCKER,
  );
}
