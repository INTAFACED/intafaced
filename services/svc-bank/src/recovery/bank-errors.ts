import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `recovery/` throws, and what a caller is told for each (see `../errors.ts`). */
export const RECOVERY_BANK_ERRORS = {
  /** An API key or a sub-account asked: only the heir at their own keyboard opens or executes a claim. */
  'bank.recovery_delegated': 'FORBIDDEN',
  /** Staff asked: staff never claim or sweep a customer's balances, whatever their scopes. */
  'bank.recovery_staff_forbidden': 'FORBIDDEN',
  /** The account is not one identity lists for this heir now. */
  'bank.recovery_estate_not_found': 'NOT_FOUND',
  /** No claim by that id belongs to the caller. */
  'bank.recovery_claim_not_found': 'NOT_FOUND',
  /** The account already has a claim under another notice or heir. The first claim stands. */
  'bank.recovery_claim_conflict': 'CONFLICT',
  /** Identity refused the claim; the message names identity's code. Nothing moved. */
  'bank.recovery_claim_refused': 'PRECONDITION_FAILED',
  /** Some of the owner's value is held, staked or pledged, so nothing is swept until it is free. */
  'bank.recovery_blocked': 'PRECONDITION_FAILED',
} as const satisfies BankErrorTable;
