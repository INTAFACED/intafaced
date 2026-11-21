import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `partner/` throws, and what a caller is told for each (see `../errors.ts`). */
export const PARTNER_BANK_ERRORS = {
  /** The partner has no such information request for this person. */
  'bank.info_request_not_found': 'NOT_FOUND',
  /** An information request takes one answer: it is already under review. */
  'bank.info_request_not_open': 'CONFLICT',
  /** An information request past the partner's deadline takes no answer here. */
  'bank.info_request_past_deadline': 'PRECONDITION_FAILED',
  /** The partner has no such periodic review for this person. */
  'bank.review_not_found': 'NOT_FOUND',
  /** A periodic review is already answered. */
  'bank.review_not_open': 'CONFLICT',
  /** The partner holds the account under a legal hold, so it is not closed or paid out (BK-acct-06). */
  'bank.closure_legal_hold': 'PRECONDITION_FAILED',
  /** Closing an account that holds money needs a destination for the balance (BK-acct-06). */
  'bank.closure_destination_required': 'PRECONDITION_FAILED',
  /** A closure of this account is already under way. */
  'bank.closure_pending': 'CONFLICT',
  /** A closure id reused with another destination. */
  'bank.closure_conflict': 'CONFLICT',
  /** No closure is waiting for its payout. */
  'bank.closure_not_found': 'NOT_FOUND',
  /** The bank account is already closed. */
  'bank.account_closed': 'CONFLICT',
  /** Only a closed account can be reopened. */
  'bank.account_not_closed': 'CONFLICT',
  /** The account closed longer ago than the owner's reopen window. */
  'bank.reopen_window_passed': 'PRECONDITION_FAILED',
  /** A data request id reused for another kind of request. */
  'bank.data_request_conflict': 'CONFLICT',
} as const satisfies BankErrorTable;
