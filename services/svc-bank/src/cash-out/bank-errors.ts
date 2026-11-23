import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `cash-out/` throws, and what a caller is told for each (see `../errors.ts`). */
export const CASH_OUT_BANK_ERRORS = {
  /** The amount to cash out is more than the ledger's available balance for the asset. Nothing was kept. */
  'bank.cash_out_over_available': 'PRECONDITION_FAILED',
  /** No cash-out of this customer has this id. */
  'bank.cash_out_not_found': 'NOT_FOUND',
  /** The cash-out was not paid out (refused, still processing or failed), so it has no receipt. */
  'bank.cash_out_receipt_not_ready': 'PRECONDITION_FAILED',
  /** No receipt signing key is set, so no cash-out receipt is made. */
  'bank.cash_out_receipt_signing_unset': 'PRECONDITION_FAILED',
} as const satisfies BankErrorTable;
