import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `account-details/` throws, and what a caller is told for each (see `../errors.ts`). */
export const ACCOUNT_DETAILS_BANK_ERRORS = {
  /** The currency asked for is not one the owner publishes account details for. */
  'bank.account_details_currency_unknown': 'BAD_REQUEST',
  /** The banking partner did not answer. Nothing was changed. */
  'bank.account_details_unavailable': 'SERVICE_UNAVAILABLE',
} as const satisfies BankErrorTable;
