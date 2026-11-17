import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `portfolio/` throws, and what a caller is told for each (see `../errors.ts`). */
export const PORTFOLIO_BANK_ERRORS = {
  /** `portfolio.valueOverTime`: svc-ledger's holdings history could not be read (or is not wired). Nothing is guessed. */
  'bank.value_history_unavailable': 'SERVICE_UNAVAILABLE',
} as const satisfies BankErrorTable;
