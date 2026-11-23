import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `transfers/` throws, and what a caller is told for each (see `../errors.ts`). */
export const TRANSFERS_BANK_ERRORS = {
  'bank.schedule_not_found': 'NOT_FOUND',
  'bank.schedule_inactive': 'CONFLICT',
  /** Standing-order create omitted a caller-stable schedule id. */
  'bank.schedule_id_required': 'BAD_REQUEST',
  /** Retry reused a schedule id with different user, spaces, amount, cadence, or start. */
  'bank.schedule_conflict': 'CONFLICT',
  /** No operator row publishes a per-transfer limit, a daily limit, and a fee for this asset. */
  'bank.personal_transfer_terms_unset': 'PRECONDITION_FAILED',
  /** Published limits must be above zero, and the daily limit at least the per-transfer limit. Nothing is written. */
  'bank.personal_transfer_terms_invalid': 'BAD_REQUEST',
  'bank.personal_transfer_limit_exceeded': 'BAD_REQUEST',
  'bank.personal_transfer_daily_limit_exceeded': 'BAD_REQUEST',
  /** Same transfer id, different note, payee, amount, request, or reference. */
  'bank.personal_transfer_conflict': 'CONFLICT',
  'bank.held_send_not_found': 'NOT_FOUND',
  'bank.personal_send_in_review': 'PRECONDITION_FAILED',
  'bank.personal_send_rejected': 'PRECONDITION_FAILED',
  'bank.held_send_decided': 'CONFLICT',
  'bank.personal_transfer_not_found': 'NOT_FOUND',
  'bank.personal_note_invalid': 'BAD_REQUEST',
  /** A personal-send reference is not printable ASCII of 1 to 64 characters. */
  'bank.personal_reference_invalid': 'BAD_REQUEST',
  'bank.personal_request_not_found': 'NOT_FOUND',
  'bank.personal_request_closed': 'CONFLICT',
  'bank.personal_request_expired': 'CONFLICT',
  'bank.personal_request_not_payer': 'FORBIDDEN',
  'bank.personal_request_not_payee': 'FORBIDDEN',
  'bank.personal_request_amount_mismatch': 'CONFLICT',
  /** The transfer's recipient is not the request's payee. Nothing is posted. */
  'bank.personal_request_payee_mismatch': 'CONFLICT',
  'bank.personal_request_claim_held': 'CONFLICT',
  'bank.personal_request_conflict': 'CONFLICT',
  'bank.personal_request_self': 'BAD_REQUEST',
  'bank.personal_request_list_limit_unset': 'BAD_REQUEST',
  'bank.personal_request_payer_unknown': 'NOT_FOUND',
  /** The person asked blocked the asker on a report; the refusal does not say so. */
  'bank.personal_request_unavailable': 'PRECONDITION_FAILED',
  /** The owner's reminder cap for the window is used; the message carries the next allowed time. */
  'bank.personal_request_remind_capped': 'TOO_MANY_REQUESTS',
  'bank.personal_request_report_reason': 'BAD_REQUEST',
  /** No notices port for posted sends: the send stands, its notice stays owed. */
  'bank.transfer_notify_unwired': 'PRECONDITION_FAILED',
  /** A transfer id was reused with a different note or reference. */
  'bank.transfer_message_conflict': 'CONFLICT',
  /** A limit-increase request reason is shorter than 10 characters (BK-acct-04). */
  'bank.limit_request_reason_too_short': 'BAD_REQUEST',
  /** A request of that kind for that asset is already open. */
  'bank.limit_request_open': 'CONFLICT',
  /** A request id was reused for a different request. */
  'bank.limit_request_conflict': 'CONFLICT',
  /** Limit request page size unpublished. Blank is not 50. */
  'bank.limit_request_list_limit_unset': 'BAD_REQUEST',
  /** The decider is the customer who asked. */
  'bank.limit_request_self_decision': 'FORBIDDEN',
  /** Already decided, differently. */
  'bank.limit_request_decided': 'CONFLICT',
  /** An approval named no granted limit; it is never defaulted to the requested one. */
  'bank.limit_grant_unset': 'BAD_REQUEST',
} as const satisfies BankErrorTable;
