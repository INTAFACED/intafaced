import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `statements/` throws, and what a caller is told for each (see `../errors.ts`). */
export const STATEMENTS_BANK_ERRORS = {
  /** No tax calculation provider is wired, so no tax statement is produced (J-bank-16 #3). */
  'vendor.tax': 'PRECONDITION_FAILED',
  /** PDF statements are one UTC calendar month. */
  'bank.statement_pdf_one_month': 'PRECONDITION_FAILED',
  /** A balance snapshot at a past date needs a past-balance read the ledger does not offer yet (PF-statements-01). */
  'bank.statement_balances_unavailable': 'PRECONDITION_FAILED',
  /** No export job of the caller's with that id (PF-statements-02). */
  'bank.statement_job_not_found': 'NOT_FOUND',
  /** The export job has no file yet: it is queued, rendering or failed (PF-statements-02). */
  'bank.statement_job_not_ready': 'PRECONDITION_FAILED',
  /** A background export asked for dates that have not ended yet (PF-statements-02). */
  'bank.statement_job_unfinished': 'BAD_REQUEST',
} as const satisfies BankErrorTable;
