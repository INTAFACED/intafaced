import { z } from 'zod';
import {
  SECURITY_LOCK_UNLOCK_STEP_UP_PURPOSE,
  SECURITY_LOCK_UNLOCK_STEP_UP_SCOPE,
  securityLockSchema,
} from '@intafaced/contracts/identity';

/**
 * The customer security lock in Security (W-withdraw-09), backed by identity `securityLock.read`, `.set` and
 * `.requestUnlock`. Locking needs no confirmation of who you are; asking to unlock does, bound to a fresh request id, and
 * the lock still holds until the time identity fixed when it was asked for.
 */
export { securityLockSchema };
export const securityLockChangeSchema = securityLockSchema.extend({ changed: z.boolean() }).strict();
export type SecurityLockState = z.infer<typeof securityLockSchema>;

/** The body of `stepUp.begin` for an unlock request: the request id is both the bound field and the target. */
export function unlockStepUp(clientRequestId: string) {
  return {
    scope: SECURITY_LOCK_UNLOCK_STEP_UP_SCOPE,
    purpose: SECURITY_LOCK_UNLOCK_STEP_UP_PURPOSE,
    target: clientRequestId,
    fields: { clientRequestId },
  };
}

/** Which of the three states the card shows. */
export function lockStage(state: SecurityLockState): 'open' | 'locked' | 'unlocking' {
  if (!state.locked) return 'open';
  return state.unlocksAt ? 'unlocking' : 'locked';
}

const REFUSALS = new Map([
  ['identity.security_lock_unlock_wait_unset', 'refusedWaitUnset'],
  ['identity.delegated_refused', 'refusedDelegated'],
] as const);
export type SecurityLockRefusal = 'refusedWaitUnset' | 'refusedDelegated';

/** The card's own sentence for identity's typed refusals here, or null to show the general one. */
export function securityLockRefusal(answer: { ok: boolean; reason?: string; code?: string }): SecurityLockRefusal | null {
  if (answer.ok || answer.reason === 'uncertain' || !answer.code) return null;
  return REFUSALS.get(answer.code as never) ?? null;
}
