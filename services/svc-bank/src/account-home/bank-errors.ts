import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `account-home/` throws, and what a caller is told for each (see `../errors.ts`). */
export const ACCOUNT_HOME_BANK_ERRORS = {
  /** A currency that still holds a balance, a hold, an open order or a named space cannot be removed. */
  'bank.currency_in_use': 'PRECONDITION_FAILED',
  /** The profile a bank call names is not one the caller holds: an unknown or closed business, or one they are not a member of. */
  'bank.profile_not_held': 'FORBIDDEN',
} as const satisfies BankErrorTable;
