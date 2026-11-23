import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `ops/` throws, and what a caller is told for each (see `../errors.ts`). */
export const OPS_BANK_ERRORS = {
  /** Card programme from/to was omitted, unreadable, or not a positive span. */
  'bank.card_programme_span_unset': 'BAD_REQUEST',
  /** Card programme span is longer than 92 days. */
  'bank.card_programme_span_too_long': 'BAD_REQUEST',
  /** Ramp health window was omitted or outside 1..720 hours. */
  'bank.ramp_health_window_unset': 'BAD_REQUEST',
  'bank.onramp_quotes_limit_unset': 'BAD_REQUEST',
  /** Transfer health window was omitted or outside 1..720 hours. */
  'bank.transfer_health_window_unset': 'BAD_REQUEST',
  /** Failed-transfer window was omitted or outside 1..720 hours. */
  'bank.failed_transfers_window_unset': 'BAD_REQUEST',
  /** Failed-transfer page size unpublished. Blank is not 50. */
  'bank.failed_transfers_limit_unset': 'BAD_REQUEST',
  /** Failed-transfer cursor was not a page this service issued. */
  'bank.failed_transfers_cursor_invalid': 'BAD_REQUEST',
  /**
   * Operator transfer drill-down. Unknown and malformed ids share this code
   * so the shape of the id is not an existence oracle.
   */
  'bank.ops_transfer_not_found': 'NOT_FOUND',
  /** Operator business-approval page size unpublished. Blank is not 50. */
  'bank.ops_business_approvals_limit_unset': 'BAD_REQUEST',
  /** A desk read of a customer's balances could not be recorded, so it was not made. */
  'bank.ops_audit_unavailable': 'SERVICE_UNAVAILABLE',
  /** New borrowing or new supply is paused for this asset by the desk (BK-loan-07). Repay and withdraw still work. */
  'bank.asset_paused': 'CONFLICT',
  // The pause read failed; the new borrow or deposit was refused rather than assumed open.
  /** The asset pause state could not be read, so a new borrow or deposit was refused rather than assumed open. */
  'bank.asset_pause_unreadable': 'SERVICE_UNAVAILABLE',
} as const satisfies BankErrorTable;
