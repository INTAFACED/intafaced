import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `pay-yourself/` throws, and what a caller is told for each (see `../errors.ts`). */
export const PAY_YOURSELF_BANK_ERRORS = {
  /** No partner pay-in a venue can withdraw to is wired (J-bank-31): nothing can be paid to the partner account. */
  'bank.pay_in_unset': 'PRECONDITION_FAILED',
  /** A pay yourself move key sent again with another amount, owner or nonce (J-bank-31). */
  'bank.pay_yourself_conflict': 'CONFLICT',
  /** A pay yourself move nobody holds, or one already signed (J-bank-31). */
  'bank.pay_yourself_move_not_found': 'NOT_FOUND',
} as const satisfies BankErrorTable;
