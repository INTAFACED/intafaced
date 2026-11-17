import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `auto-invest/` throws, and what a caller is told for each (see `../errors.ts`). */
export const AUTO_INVEST_BANK_ERRORS = {
  'bank.auto_invest_not_found': 'NOT_FOUND',
  'bank.auto_invest_inactive': 'CONFLICT',
  'bank.auto_invest_invalid_threshold': 'CONFLICT',
  /** Second live card_roundup on the same (user, asset). Pause/cancel first. */
  'bank.auto_invest_roundup_exists': 'CONFLICT',
  'bank.auto_invest_below_threshold': 'CONFLICT',
} as const satisfies BankErrorTable;
