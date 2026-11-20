import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `rules/` throws, and what a caller is told for each (see `../errors.ts`). */
export const RULES_BANK_ERRORS = {
  /** A reminder lead time is one of the offered choices, or off. */
  'bank.reminder_lead_invalid': 'BAD_REQUEST',
  /** The reminder rule changed since the revision the write read. */
  'bank.reminder_revision_conflict': 'CONFLICT',
} as const satisfies BankErrorTable;
