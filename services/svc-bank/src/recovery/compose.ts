import type { BankRoot } from '../bank-root.js';
import type { SpaceService } from '../spaces/space-service.js';
import { unconfiguredIdentityRecovery, type IdentityRecoveryPort } from './identity-recovery.js';
import { RecoveryClaimService } from './recovery-claims.js';

/** An heir's claim on a dead owner's balances. An area of svc-bank (`area-chain.ts`). */
export interface RecoveryServices {
  /** RC-identity-08: the heir's claim on a dead owner's balances, swept once the owner's recovery keys sign it. */
  readonly recovery: RecoveryClaimService;
}

export interface RecoveryServiceOptions {
  /** Identity's recovery claim doors (RC-identity-08). Unset = every claim refuses `bank.recovery_unavailable`. */
  identityRecovery?: IdentityRecoveryPort;
}

export function composeRecoveryArea(
  root: BankRoot,
  made: { readonly spaces: SpaceService },
  options: RecoveryServiceOptions,
): RecoveryServices {
  return {
    recovery: new RecoveryClaimService(root.sql, root.ledger, made.spaces, options.identityRecovery ?? unconfiguredIdentityRecovery()),
  };
}
