import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `safety/` throws, and what a caller is told for each (see `../errors.ts`). */
export const SAFETY_BANK_ERRORS = {
  /** The person's own step-up extras hold a send above their allowance while a chosen check cannot be done (BK-safe-01). Nothing was sent. */
  'bank.extra_controls_pending': 'PRECONDITION_FAILED',
  /** Identity could not answer the extra-checks read (outage, timeout, bad reply). Nothing was sent; retry. */
  'bank.extra_controls_unavailable': 'SERVICE_UNAVAILABLE',
  /** No IDENTITY_URL: this deployment cannot read the extra checks, so sends to another person refuse. A deployment gap. */
  'bank.extra_controls_unset': 'PRECONDITION_FAILED',
} as const satisfies BankErrorTable;
