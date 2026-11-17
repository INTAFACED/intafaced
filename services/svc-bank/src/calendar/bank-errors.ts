import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `calendar/` throws, and what a caller is told for each (see `../errors.ts`). */
export const CALENDAR_BANK_ERRORS = {
  /** A money calendar read is 1 to 62 days from a valid date. */
  'bank.calendar_window_invalid': 'BAD_REQUEST',
} as const satisfies BankErrorTable;
