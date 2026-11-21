import type { BankErrorTable } from '../bank-error-table.js';

/** The refusals `business/` throws, and what a caller is told for each (see `../errors.ts`). */
export const BUSINESS_BANK_ERRORS = {
  'bank.business_not_found': 'NOT_FOUND',
  'bank.business_closed': 'CONFLICT',
  'bank.business_not_member': 'CONFLICT',
  'bank.business_role_forbidden': 'CONFLICT',
  /** A named role with no permission, or one not on the list. */
  'bank.business_role_invalid': 'BAD_REQUEST',
  /** A role, invite or assignment granting a permission the actor does not hold. Nothing was created. */
  'bank.business_role_grant_exceeds': 'FORBIDDEN',
  /** The business already has a role or department of that name. */
  'bank.business_role_name_taken': 'CONFLICT',
  'bank.business_role_not_found': 'NOT_FOUND',
  /** Only the business's owner may do this (approve an advisor, fund its TEST partner account). */
  'bank.business_owner_only': 'FORBIDDEN',
  'bank.business_advisor_not_found': 'NOT_FOUND',
  'bank.business_already_member': 'CONFLICT',
  'bank.business_invalid_handle': 'BAD_REQUEST',
  'bank.business_person_not_found': 'NOT_FOUND',
  'bank.business_invalid_email': 'BAD_REQUEST',
  /** An invite opened after its owner-set lifetime; the business can send it again. */
  'bank.business_invite_expired': 'PRECONDITION_FAILED',
  'bank.business_invite_revoked': 'PRECONDITION_FAILED',
  /** An invite that was sent again: only the newest link works. */
  'bank.business_invite_replaced': 'PRECONDITION_FAILED',
  'bank.business_invite_used': 'CONFLICT',
  'bank.business_invite_not_found': 'NOT_FOUND',
  /** Resend or revoke of an invite that is no longer open. */
  'bank.business_invite_inactive': 'CONFLICT',
  /** An email invite opened by an account with another email. */
  'bank.business_invite_wrong_person': 'FORBIDDEN',
  'bank.business_rule_invalid': 'BAD_REQUEST',
  'bank.business_payee_invalid': 'BAD_REQUEST',
  /** The rule asks for more distinct approvers than the business has besides the maker. */
  'bank.business_approvers_short': 'PRECONDITION_FAILED',
  /** One person approving the same payment twice: approvers are distinct. */
  'bank.business_already_approved': 'CONFLICT',
  'bank.business_budget_invalid': 'BAD_REQUEST',
  'bank.business_department_not_found': 'NOT_FOUND',
  'bank.business_invalid_threshold': 'CONFLICT',
  'bank.business_invalid_name': 'CONFLICT',
  'bank.business_approval_not_found': 'NOT_FOUND',
  'bank.business_approval_inactive': 'CONFLICT',
  'bank.business_self_approve': 'CONFLICT',
  /** A bill field, vendor cap, limit or split line not in shape. */
  'bank.bill_field_invalid': 'BAD_REQUEST',
  /** A bill edited or sent on while it is not in the inbox. */
  'bank.bill_not_editable': 'CONFLICT',
  /** A bill sent on before it names a vendor, an amount and a due date. */
  'bank.bill_incomplete': 'PRECONDITION_FAILED',
  /** A bill flagged as a possible duplicate, not yet cleared: it is not paid. */
  'bank.bill_duplicate_uncleared': 'PRECONDITION_FAILED',
  /** A bill paid before it is approved. */
  'bank.bill_not_approved': 'CONFLICT',
  /** A split whose lines do not add up to the bill exactly. */
  'bank.split_total_mismatch': 'BAD_REQUEST',
  /** A scheduled payment for today or earlier. */
  'bank.bill_schedule_invalid': 'BAD_REQUEST',
  /** A Bill Pay limit is blank: no bill is paid until the business sets all three. */
  'bank.bill_limit_unset': 'PRECONDITION_FAILED',
  /** A bill payment over a Bill Pay limit. */
  'bank.bill_limit_exceeded': 'PRECONDITION_FAILED',
  /** A cancel of a bill payment already sent to the partner. */
  'bank.bill_payment_sent': 'CONFLICT',
  /** A return reported for a bill payment that was never sent. */
  'bank.bill_payment_not_sent': 'CONFLICT',
  'bank.bill_not_found': 'NOT_FOUND',
  'bank.bill_payment_not_found': 'NOT_FOUND',
  /** A bulk payment file with no header naming its columns, no lines, too many lines, or over 256 KiB. */
  'bank.bulk_file_invalid': 'BAD_REQUEST',
  /** The business's partner balance does not cover a run's total: nothing was sent, add money and confirm again. */
  'bank.bulk_run_unfunded': 'PRECONDITION_FAILED',
  /** A run with no valid line: there is nothing to send. */
  'bank.bulk_run_empty': 'PRECONDITION_FAILED',
  'bank.bulk_run_not_found': 'NOT_FOUND',
  /** A contractor, invoice or payroll field not in shape. */
  'bank.contractor_field_invalid': 'BAD_REQUEST',
  'bank.contractor_not_found': 'NOT_FOUND',
  /** The contractor already has an invoice with this number. */
  'bank.contractor_invoice_duplicate': 'CONFLICT',
  /** An invoice in a batch is already being paid or paid. */
  'bank.contractor_invoice_not_open': 'CONFLICT',
  /** An onboarding link we do not know. */
  'bank.contractor_invite_invalid': 'NOT_FOUND',
  /** An onboarding link already used by someone else. */
  'bank.contractor_invite_used': 'CONFLICT',
  /** A payroll wallet address or offer not in shape. */
  'bank.payroll_wallet_invalid': 'BAD_REQUEST',
  /** Crypto payroll needs the business's own wallet connected first: it signs every run. */
  'bank.payroll_wallet_missing': 'PRECONDITION_FAILED',
  /** A payroll member with no wallet address. */
  'bank.contractor_wallet_missing': 'PRECONDITION_FAILED',
  /** A signature not from the wallet named: nothing was connected or signed. */
  'bank.payroll_signature_invalid': 'BAD_REQUEST',
  /** A card limit, merchant, amount, receipt rule or claim description not in shape. */
  'bank.business_card_field_invalid': 'BAD_REQUEST',
  /** No business card or card purchase with that id is yours to see. */
  'bank.business_card_not_found': 'NOT_FOUND',
  'bank.business_card_frozen': 'PRECONDITION_FAILED',
  /** A receipt file with no name, of a type we do not take, empty or over 512 KiB. */
  'bank.receipt_invalid': 'BAD_REQUEST',
  'bank.reimbursement_not_found': 'NOT_FOUND',
  /** A coding rule's payee text, a category or a GL code not in shape, or a bulk code of no lines or too many. */
  'bank.business_books_field_invalid': 'BAD_REQUEST',
  /** A line named for coding is not on the business's statement for the period. */
  'bank.business_line_not_found': 'NOT_FOUND',
  /** A statement starts before the partner's history window. */
  'bank.statement_history_window': 'BAD_REQUEST',
  /** Our lines do not give the partner statement's closing balance or line count: no file is made. */
  'bank.statement_mismatch': 'CONFLICT',
  'bank.business_rejected': 'CONFLICT',
  'bank.business_cancelled': 'CONFLICT',
  /** Payroll with no recipients is not a run. */
  'bank.business_payroll_empty': 'BAD_REQUEST',
  /** Business propose omitted a caller-stable client id. */
  'bank.business_request_id_required': 'BAD_REQUEST',
  /** Retry reused a propose client id with different account, spaces, or amount. */
  'bank.business_request_conflict': 'CONFLICT',
  /** A person on the page has no public handle, so the page is not shown. */
  'bank.business_directory_incomplete': 'PRECONDITION_FAILED',
  /** The caller sent both a handle and an email, or neither. */
  'bank.business_recipient_query': 'BAD_REQUEST',
  /** Removing or demoting the only administrator. */
  'bank.business_last_admin': 'PRECONDITION_FAILED',
  /** A close or threshold change of this kind is already waiting. */
  'bank.business_change_pending': 'CONFLICT',
  /** Close while a payment is still waiting for a decision. */
  'bank.business_close_blocked': 'PRECONDITION_FAILED',
  /** This teammate still has a payment waiting as its maker. Decide or cancel it before removal. */
  'bank.business_member_has_pending': 'PRECONDITION_FAILED',
  /** business.approvals cursor could not be read. */
  'bank.business_cursor_invalid': 'BAD_REQUEST',
  /**
   * The same business id already exists for someone else, or for different
   * rules. Both answers use this one code so the caller cannot tell them apart.
   */
  'bank.business_conflict': 'CONFLICT',
} as const satisfies BankErrorTable;
