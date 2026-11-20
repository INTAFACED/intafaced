import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `holds/` throws, and what a caller is told for each (see `../errors.ts`). */
export const HOLDS_BANK_ERRORS = {
  'bank.received_hold_not_found': 'NOT_FOUND',
  'bank.received_hold_not_ready': 'CONFLICT',
  'bank.received_hold_decided': 'CONFLICT',
} as const satisfies BankErrorTable;
