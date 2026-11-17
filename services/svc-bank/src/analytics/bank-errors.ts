import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `analytics/` throws, and what a caller is told for each (see `../errors.ts`). */
export const ANALYTICS_BANK_ERRORS = {
  /** A budget's category, target or alert share is not one the bank takes (BK-acct-08). */
  'bank.budget_invalid': 'BAD_REQUEST',
  /** A month comparison takes two to twelve distinct months, none in the future (BK-acct-08). */
  'bank.compare_months': 'BAD_REQUEST',
} as const satisfies BankErrorTable;
