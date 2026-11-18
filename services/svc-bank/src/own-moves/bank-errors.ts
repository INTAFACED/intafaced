import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `own-moves/` throws, and what a caller is told for each (see `../errors.ts`). */
export const OWN_MOVES_BANK_ERRORS = {
  /** A move above what the partner reports in the person's account (J-derivatives-25 #3): nothing is sent. */
  'bank.own_move_above_free': 'CONFLICT',
  /** A move id asked again with other terms, or a second deposit for one move. */
  'bank.own_move_conflict': 'CONFLICT',
  /** A move nobody holds, or another person's. */
  'bank.own_move_not_found': 'NOT_FOUND',
  /** No partner send to a wallet is wired: nothing can move to the trading account. */
  'bank.own_move_rail_unset': 'PRECONDITION_FAILED',
} as const satisfies BankErrorTable;
