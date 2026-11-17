import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `direct-debits/` throws, and what a caller is told for each (see `../errors.ts`). */
export const DIRECT_DEBITS_BANK_ERRORS = {
  /** A direct debit presentment or refund request is not in shape (amount, date, reason). */
  'bank.dd_invalid': 'BAD_REQUEST',
  /** No mandate by that id for this person. Another person's reads the same. */
  'bank.dd_mandate_not_found': 'NOT_FOUND',
  /** No collection by that id for this person. */
  'bank.dd_collection_not_found': 'NOT_FOUND',
  /** The scheme knows no creditor by that id, so no mandate is set up. */
  'bank.dd_creditor_unknown': 'BAD_REQUEST',
  /** A mandate id was set up again with other terms. */
  'bank.dd_mandate_conflict': 'CONFLICT',
  /** A collection id was presented again with another amount or date. */
  'bank.dd_collection_conflict': 'CONFLICT',
  /** The ledger refused a collection's entry itself (an asset it does not hold, say): it failed and nothing was posted. */
  'bank.dd_collection_invalid': 'BAD_REQUEST',
  // The request is fine; the period it had to be made in is over.
  /** The guarantee period for this debit has ended. */
  'bank.dd_refund_window_closed': 'CONFLICT',
  /** No direct debit guarantee period is set, so a refund request is refused rather than assumed. */
  'bank.dd_guarantee_unset': 'PRECONDITION_FAILED',
} as const satisfies BankErrorTable;
