import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `linked-accounts/` throws, and what a caller is told for each (see `../errors.ts`). */
export const LINKED_ACCOUNTS_BANK_ERRORS = {
  /** A linked bank account's IBAN, name or holder name is not usable. Nothing was linked. */
  'bank.linked_account_invalid': 'BAD_REQUEST',
  /** The customer has as many linked bank accounts as the owner's address-book cap allows. */
  'bank.linked_accounts_full': 'PRECONDITION_FAILED',
  /** No linked bank account of this customer has this id. */
  'bank.linked_account_not_found': 'NOT_FOUND',
} as const satisfies BankErrorTable;
