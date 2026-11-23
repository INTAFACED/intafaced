import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `step-up/` throws, and what a caller is told for each (see `../errors.ts`). */
export const STEP_UP_BANK_ERRORS = {
  /** The approval was for a different payload (amount, payee, asset, id, cadence...). Ask again. */
  'bank.step_up_mismatch': 'PRECONDITION_FAILED',
  /** The approval was already spent on a different operation. Ask again. */
  'bank.step_up_used': 'PRECONDITION_FAILED',
} as const satisfies BankErrorTable;
