import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `salary/` throws, and what a caller is told for each (see `../errors.ts`). */
export const SALARY_BANK_ERRORS = {
  /** The partner bank has not given the name the account is held in, so no salary form is made (J-bank-30). */
  'bank.direct_deposit_holder_unknown': 'PRECONDITION_FAILED',
  /** A payroll credit named account details nobody holds, or in a currency they do not take. */
  'bank.direct_deposit_details_unknown': 'NOT_FOUND',
  /** A payroll network id sent again with other details. */
  'bank.direct_deposit_conflict': 'CONFLICT',
  /** A payroll credit named an account holder other than the one the partner holds the account in: returned. */
  'bank.direct_deposit_name_mismatch': 'CONFLICT',
  /** A reversal named a network id the network never carried. */
  'bank.direct_deposit_not_found': 'NOT_FOUND',
  /** A reversal of a credit that was returned or never finished. */
  'bank.direct_deposit_not_received': 'CONFLICT',
  /** A reversal after the owner's window. */
  'bank.direct_deposit_reversal_window': 'CONFLICT',
  /** The account no longer holds what the employer asks back. */
  'bank.direct_deposit_reversal_insufficient': 'CONFLICT',
} as const satisfies BankErrorTable;
