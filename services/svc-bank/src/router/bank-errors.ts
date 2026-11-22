import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `router/` throws, and what a caller is told for each (see `../errors.ts`). */
export const ROUTER_BANK_ERRORS = {
  /**
   * `ops.accrueInterest` was asked to pay a UTC day whose 00:00Z is still in
   * the future. Only a day that has begun is paid.
   */
  'bank.accrual_day_not_begun': 'PRECONDITION_FAILED',
  'bank.personal_send_review_door': 'PRECONDITION_FAILED',
} as const satisfies BankErrorTable;
