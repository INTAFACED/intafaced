import { randomUUID } from 'node:crypto';
import { TRPCError } from '@intafaced/contracts';
import { InsufficientFundsError, LedgerError } from '@intafaced/ledger-client';
import { DualControlError } from '../dual-control.js';
import { ActionApprovalConsumeError } from '../action-approval-consume.js';
import { BankError, type BankErrorCode } from '../errors.js';
import { userFacingBankMessage } from '../user-copy.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A MESSAGE IS A WIRE FORMAT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An error string that interpolates a value crosses a trust boundary the moment
 * a mapper passes it through, so `err.message` reaching a client is a
 * SERIALISATION DECISION rather than a debugging convenience. Every branch of
 * `toTrpcError` below now makes that decision explicitly, and the two rules it
 * makes are:
 *
 *   1. A refusal may only DESCRIBE objects the caller was already entitled to
 *      see. Where it cannot, it says so and names nothing.
 *   2. Nothing is passed through by DEFAULT. The `default:` branch used to
 *      return `err.message` verbatim for every code nobody had thought about,
 *      which is how `Space "Holiday fund" is archived` — a sentence written for
 *      an owner — ended up being delivered to a stranger who guessed a uuid.
 *   3. Ramp / card refusals the user reads are catalog keys via `@intafaced/i18n`.
 *      Missing keys render as the dotted code — never invented English.
 *
 * Rule 2 is why the table below is a `Record` over all of `BankErrorCode`:
 * adding a code without deciding what a caller may be told now fails the
 * typecheck instead of silently becoming a 400 with the domain sentence attached.
 */

/** The generic answer. Detail lives in the log, joined by this reference. */
export function opaqueFailure(err: unknown, context: string): TRPCError {
  const correlationId = randomUUID();
  // stderr in one line of JSON, which is what the platform's log shipper reads.
  // The message the CLIENT never sees is the message an operator most needs, so
  // this is the only copy of it and it must not be dropped on the floor.
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'svc-bank',
      event: 'bank.undisclosed_error',
      correlationId,
      context,
      code: (err as { code?: string }).code ?? null,
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    }),
  );
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    // The reference is the whole point: a user reporting "it said ref 8f3c…"
    // gets an operator to the exact line, without the line being published.
    message: `Bank operation failed (ref ${correlationId})`,
    cause: err,
  });
}

/**
 * HTTP /trpc serialises TRPCError.message, not BankError.cause.
 * Earn/cards invent-refusals (pool_underfunded, mark_missing) are not
 * i18n catalog keys; the stable code must ride in the message so a Fastify
 * client can branch. Owner-facing sentences (archived space, asset mismatch)
 * stay un-suffixed — stuffing every BankError code broke that door.
 */
export function publicDoorWireMessage(err: BankError): string {
  const facing = userFacingBankMessage(err.code, err.message);
  if (facing.includes(err.code)) return facing;
  if (
    err.code === 'bank.pool_underfunded' ||
    err.code === 'bank.mark_missing' ||
    err.code === 'bank.prices_unavailable' ||
    err.code === 'bank.value_range_invalid' ||
    err.code === 'bank.value_range_too_long' ||
    err.code === 'bank.value_history_too_large' ||
    err.code === 'bank.value_history_unavailable' ||
    err.code === 'bank.earn_principal_mismatch' ||
    err.code === 'bank.loan_seizure_cross_asset' ||
    err.code === 'bank.loan_health_price_unset' ||
    err.code === 'bank.recipient_cannot_receive' ||
    err.code === 'bank.recipient_check_unavailable' ||
    err.code === 'bank.recipient_check_unset' ||
    err.code === 'bank.step_up_required' ||
    err.code === 'bank.step_up_mismatch' ||
    err.code === 'bank.step_up_used' ||
    err.code === 'bank.step_up_unavailable'
  ) {
    return facing + ' (' + err.code + ')';
  }
  return facing;
}

/**
 * What each refusal tells the caller, by code. `Record` over the whole `BankErrorCode` union is rule 2:
 * adding a code without deciding what a caller may be told fails the typecheck.
 */
const BANK_ERROR_STATUS: Record<BankErrorCode, TRPCError['code']> = {
  'bank.space_not_found': 'NOT_FOUND',
  'bank.schedule_not_found': 'NOT_FOUND',
  'bank.activity_not_found': 'NOT_FOUND',
  'bank.pool_not_found': 'NOT_FOUND',
  'bank.position_not_found': 'NOT_FOUND',
  'bank.loan_not_found': 'NOT_FOUND',
  'bank.loan_product_not_found': 'NOT_FOUND',
  'bank.personal_transfer_not_found': 'NOT_FOUND',
  'bank.ops_transfer_not_found': 'NOT_FOUND',
  'bank.ops_authorization_not_found': 'NOT_FOUND',
  'bank.personal_request_not_found': 'NOT_FOUND',
  'bank.personal_request_payer_unknown': 'NOT_FOUND',
  'bank.auto_invest_not_found': 'NOT_FOUND',
  'bank.business_not_found': 'NOT_FOUND',
  'bank.business_approval_not_found': 'NOT_FOUND',
  'bank.insufficient_funds': 'BAD_REQUEST',
  'bank.not_owner': 'FORBIDDEN',
  'bank.personal_request_not_payer': 'FORBIDDEN',
  'bank.personal_request_not_payee': 'FORBIDDEN',
  // Not the caller's fault and not something a retry fixes — the pool
  // needs funding (or books reconciled) before this day can accrue.
  'bank.pool_underfunded': 'PRECONDITION_FAILED',
  'bank.earn_principal_mismatch': 'PRECONDITION_FAILED',

  // ── Loans: refusals that are NOT the caller's fault ───────────────────
  //
  // Each of these is the platform declining to act, and every one of them
  // would be a lie as a 400. A borrower told "bad request" when the lending
  // reserve is empty, or when the price feed is too stale to seize collateral
  // on, will retry the request forever and learn nothing.
  'bank.loan_reserve_underfunded': 'PRECONDITION_FAILED',
  'bank.mark_unusable': 'PRECONDITION_FAILED',
  'bank.mark_missing': 'PRECONDITION_FAILED',
  'bank.loan_health_price_unset': 'PRECONDITION_FAILED',
  'bank.mark_invalid': 'PRECONDITION_FAILED',
  'bank.no_liquidation_counterparty': 'PRECONDITION_FAILED',
  'bank.loan_seizure_cross_asset': 'PRECONDITION_FAILED',
  'bank.accrual_backlog': 'PRECONDITION_FAILED',

  // The loudest one. Collateral was exhausted and the insurance fund could
  // not make the reserve whole — a platform-side loss, not a client error.
  'bank.bad_debt_uncovered': 'INTERNAL_SERVER_ERROR',
  'bank.policy_incoherent': 'INTERNAL_SERVER_ERROR',

  // Ordering refusals. Genuinely the caller's request being wrong for the
  // current state of the loan, so 409 rather than 400: nothing about the
  // input is malformed, and the same request may succeed later.
  'bank.loan_not_settled': 'CONFLICT',
  'bank.loan_not_drawable': 'CONFLICT',
  // The last attempt on a pending loan is inside the in-flight bound: wait.
  'bank.loan_attempt_too_recent': 'CONFLICT',
  'bank.loan_collateral_rejected': 'CONFLICT',
  'bank.loan_liquidating': 'CONFLICT',
  'bank.margin_call_required': 'CONFLICT',
  'bank.loan_closed': 'CONFLICT',

  // ── The codes that used to fall through `default:` ────────────────────
  //
  // Every one of them was already reaching the client as a 400 carrying its
  // domain sentence. Nothing about that is wrong FOR AN OWNER — "Space
  // 'Holiday fund' is locked until …" is the most useful thing this service
  // can say to the person who set the lock, and the ADR is explicit that the
  // failure mode to avoid is a service so cautious the owner cannot act. So
  // the messages are kept and the codes are now DECIDED rather than
  // defaulted; who is allowed to hear them is settled one layer up, at the
  // call site that knows whose row it is.
  //
  // The split follows the loans block above. A state the row is in that a
  // later request could clear is 409; a request that is simply wrong for the
  // rules is 400.
  'bank.space_archived': 'CONFLICT',
  'bank.space_locked': 'CONFLICT',
  'bank.schedule_inactive': 'CONFLICT',
  'bank.pool_closed': 'CONFLICT',
  'bank.pool_conflict': 'CONFLICT',
  'bank.pool_terms_invalid': 'BAD_REQUEST',
  'bank.fixed_pool_rate_locked': 'CONFLICT',
  'bank.pool_rate_unchanged': 'CONFLICT',
  'bank.pool_status_unchanged': 'CONFLICT',
  'bank.pool_status_stale': 'CONFLICT',
  'bank.unbond_not_confirmed': 'BAD_REQUEST',
  'bank.position_unbonding': 'CONFLICT',
  'bank.earn_risk_wording_unset': 'PRECONDITION_FAILED',
  'bank.earn_release_failed': 'INTERNAL_SERVER_ERROR',
  'bank.position_closed': 'CONFLICT',
  'bank.position_locked': 'CONFLICT',
  'bank.position_pending': 'CONFLICT',
  'bank.auto_renew_fixed_only': 'BAD_REQUEST',
  'bank.position_matured': 'CONFLICT',
  'bank.account_not_active': 'CONFLICT',
  'bank.earn_renew_failed': 'INTERNAL_SERVER_ERROR',
  'bank.loan_product_closed': 'CONFLICT',
  'bank.auto_invest_inactive': 'CONFLICT',
  'bank.auto_invest_invalid_threshold': 'CONFLICT',
  'bank.auto_invest_roundup_exists': 'CONFLICT',
  'bank.auto_invest_target_invalid': 'BAD_REQUEST',
  'bank.auto_invest_run_failed': 'CONFLICT',
  'bank.auto_invest_below_threshold': 'CONFLICT',
  'bank.business_closed': 'CONFLICT',
  'bank.business_not_member': 'CONFLICT',
  'bank.business_role_forbidden': 'CONFLICT',
  'bank.business_invalid_threshold': 'CONFLICT',
  'bank.business_invalid_name': 'CONFLICT',
  'bank.business_approval_inactive': 'CONFLICT',
  'bank.business_self_approve': 'CONFLICT',
  'bank.business_rejected': 'CONFLICT',
  'bank.business_cancelled': 'CONFLICT',
  // CONFLICT rather than BAD_REQUEST: the request is well-formed, it just
  // collides with a loan that already exists under that id on other terms.
  'bank.loan_principal_mismatch': 'CONFLICT',
  'bank.loan_collateral_mismatch': 'CONFLICT',
  // The same class for the borrower half and for earn. All three name only
  // the id the caller already holds — never who the existing record belongs
  // to — so FORBIDDEN would be both wrong and more disclosing.
  'bank.loan_borrower_mismatch': 'CONFLICT',
  'bank.position_conflict': 'CONFLICT',
  'bank.schedule_conflict': 'CONFLICT',
  'bank.schedule_revision_conflict': 'CONFLICT',
  // The next run is too close: the request is fine, the moment is not.
  'bank.schedule_cutoff': 'CONFLICT',
  'bank.business_payroll_conflict': 'CONFLICT',
  'bank.business_request_conflict': 'CONFLICT',
  'bank.personal_transfer_conflict': 'CONFLICT',
  'bank.personal_request_conflict': 'CONFLICT',
  'bank.personal_request_closed': 'CONFLICT',
  'bank.personal_request_expired': 'CONFLICT',
  'bank.personal_request_amount_mismatch': 'CONFLICT',
  'bank.personal_request_payee_mismatch': 'CONFLICT',
  'bank.personal_request_claim_held': 'CONFLICT',
  'bank.business_change_pending': 'CONFLICT',
  'bank.card_issue_conflict': 'CONFLICT',
  'bank.card_command_conflict': 'CONFLICT',
  'bank.card_replace_conflict': 'CONFLICT',
  'bank.card_operator_frozen': 'CONFLICT',
  'bank.business_conflict': 'CONFLICT',
  'bank.transfer_message_conflict': 'CONFLICT',
  'bank.activity_note_conflict': 'CONFLICT',
  'bank.activity_dispute_conflict': 'CONFLICT',
  'bank.activity_dispute_exists': 'CONFLICT',
  'bank.asset_paused': 'CONFLICT',
  'bank.ops_revision_conflict': 'CONFLICT',
  'bank.activity_filter_conflict': 'CONFLICT',
  'bank.limit_request_open': 'CONFLICT',
  'bank.limit_request_conflict': 'CONFLICT',
  'bank.limit_request_decided': 'CONFLICT',
  'bank.loan_product_conflict': 'CONFLICT',
  'bank.wallet_proof_conflict': 'CONFLICT',

  'bank.same_space': 'BAD_REQUEST',
  'bank.asset_mismatch': 'BAD_REQUEST',
  'bank.position_id_required': 'BAD_REQUEST',
  'bank.schedule_id_required': 'BAD_REQUEST',
  'bank.repayment_id_required': 'BAD_REQUEST',
  'bank.business_request_id_required': 'BAD_REQUEST',
  'bank.event_id_required': 'BAD_REQUEST',
  'bank.below_minimum': 'BAD_REQUEST',
  'bank.native_asset_not_earnable': 'BAD_REQUEST',
  'bank.ltv_exceeded': 'BAD_REQUEST',
  /** Borrower short of collateral at open — same class as ltv_exceeded. */
  'bank.loan_collateral_short': 'BAD_REQUEST',
  'bank.card_not_found': 'BAD_REQUEST',
  'bank.card_not_active': 'BAD_REQUEST',
  'bank.card_limit_exceeded': 'BAD_REQUEST',
  'bank.card_shipping_address_required': 'BAD_REQUEST',
  'bank.card_pin_invalid': 'BAD_REQUEST',
  'bank.card_authorization_not_found': 'BAD_REQUEST',
  'bank.card_authorization_declined': 'BAD_REQUEST',
  'bank.card_authorization_closed': 'BAD_REQUEST',
  'bank.card_capture_exceeds_authorization': 'BAD_REQUEST',
  /** Disagrees with a claimed settlement row — same class as ramp_conflict. */
  'bank.card_settlement_amount_conflict': 'BAD_REQUEST',
  /** Disagrees with the kind a sequence was claimed for — same class as the amount. */
  'bank.card_settlement_kind_conflict': 'BAD_REQUEST',
  'bank.ramp_invalid_amount': 'BAD_REQUEST',
  'bank.ramp_invalid_asset': 'BAD_REQUEST',
  'bank.ramp_invalid_destination': 'BAD_REQUEST',
  'bank.withdraw_network_unsupported': 'BAD_REQUEST',
  'bank.address_checksum_mismatch': 'BAD_REQUEST',
  'bank.address_lookalike': 'BAD_REQUEST',
  'bank.destination_fraud_listed': 'BAD_REQUEST',
  'bank.wallet_proof_expired': 'BAD_REQUEST',
  'bank.wallet_proof_signature_invalid': 'BAD_REQUEST',
  'bank.wallet_proof_wrong_signer': 'BAD_REQUEST',
  'bank.ramp_conflict': 'BAD_REQUEST',
  'bank.rail_send_invalid': 'BAD_REQUEST',
  'bank.rail_send_conflict': 'BAD_REQUEST',
  'bank.business_payroll_empty': 'BAD_REQUEST',
  'bank.earn_resume_pending_limit_unset': 'BAD_REQUEST',
  'bank.earn_renew_batch_limit_unset': 'BAD_REQUEST',
  'bank.earn_release_batch_limit_unset': 'BAD_REQUEST',
  'bank.loan_resume_pending_limit_unset': 'BAD_REQUEST',
  'bank.loan_accrue_batch_limit_unset': 'BAD_REQUEST',
  'bank.transfer_due_limit_unset': 'BAD_REQUEST',
  'bank.auto_invest_batch_limit_unset': 'BAD_REQUEST',
  'bank.loan_risk_sweep_limit_unset': 'BAD_REQUEST',
  'bank.earn_pools_list_limit_unset': 'BAD_REQUEST',
  'bank.loan_products_list_limit_unset': 'BAD_REQUEST',
  'bank.spaces_list_limit_unset': 'BAD_REQUEST',
  'bank.earn_positions_list_limit_unset': 'BAD_REQUEST',
  'bank.earn_interest_list_limit_unset': 'BAD_REQUEST',
  'bank.earn_rate_history_limit_unset': 'BAD_REQUEST',
  'bank.shared_pots_list_limit_unset': 'BAD_REQUEST',
  'bank.joint_unset': 'PRECONDITION_FAILED',
  'bank.invite_expired': 'CONFLICT',
  'bank.invite_not_found': 'NOT_FOUND',
  'bank.invitee_not_found': 'NOT_FOUND',
  'bank.shared_pot_full': 'CONFLICT',
  'bank.shared_pot_invalid': 'BAD_REQUEST',
  'bank.space_forbidden': 'FORBIDDEN',
  'bank.loans_list_limit_unset': 'BAD_REQUEST',
  'bank.cards_list_limit_unset': 'BAD_REQUEST',
  'bank.card_authorizations_list_limit_unset': 'BAD_REQUEST',
  'bank.schedules_list_limit_unset': 'BAD_REQUEST',
  'bank.executions_list_limit_unset': 'BAD_REQUEST',
  'bank.auto_invest_list_limit_unset': 'BAD_REQUEST',
  'bank.business_list_limit_unset': 'BAD_REQUEST',
  'bank.business_pending_list_limit_unset': 'BAD_REQUEST',
  'bank.business_approvals_list_limit_unset': 'BAD_REQUEST',
  'bank.business_cursor_invalid': 'BAD_REQUEST',
  'bank.business_recipient_query': 'BAD_REQUEST',
  'bank.onramps_list_limit_unset': 'BAD_REQUEST',
  'bank.offramps_list_limit_unset': 'BAD_REQUEST',
  'bank.convert_markets_limit_unset': 'BAD_REQUEST',
  'bank.validation_failed': 'BAD_REQUEST',
  'bank.activity_range': 'BAD_REQUEST',
  'bank.activity_note_empty': 'BAD_REQUEST',
  'bank.statement_range': 'BAD_REQUEST',
  'bank.personal_note_invalid': 'BAD_REQUEST',
  'bank.personal_reference_invalid': 'BAD_REQUEST',
  'bank.personal_transfer_limit_exceeded': 'BAD_REQUEST',
  'bank.personal_transfer_daily_limit_exceeded': 'BAD_REQUEST',
  'bank.personal_request_self': 'BAD_REQUEST',
  'bank.personal_request_list_limit_unset': 'BAD_REQUEST',
  'bank.ops_reason_too_short': 'BAD_REQUEST',
  'bank.card_programme_span_unset': 'BAD_REQUEST',
  'bank.card_programme_span_too_long': 'BAD_REQUEST',
  'bank.ramp_health_window_unset': 'BAD_REQUEST',
  'bank.transfer_health_window_unset': 'BAD_REQUEST',
  'bank.failed_transfers_window_unset': 'BAD_REQUEST',
  'bank.failed_transfers_limit_unset': 'BAD_REQUEST',
  'bank.account_details_currency_unknown': 'BAD_REQUEST',
  'bank.failed_transfers_cursor_invalid': 'BAD_REQUEST',
  'bank.ops_business_approvals_limit_unset': 'BAD_REQUEST',
  'bank.activity_filter_name_invalid': 'BAD_REQUEST',
  'bank.activity_filter_empty': 'BAD_REQUEST',
  'bank.activity_filter_limit_unset': 'BAD_REQUEST',
  'bank.limit_request_reason_too_short': 'BAD_REQUEST',
  'bank.limit_request_list_limit_unset': 'BAD_REQUEST',
  'bank.limit_grant_unset': 'BAD_REQUEST',
  'bank.loan_params_invalid': 'BAD_REQUEST',
  'bank.personal_transfer_terms_invalid': 'BAD_REQUEST',
  'bank.asset_unknown': 'BAD_REQUEST',
  'bank.linked_account_invalid': 'BAD_REQUEST',

  'bank.limit_request_not_found': 'NOT_FOUND',
  'bank.wallet_proof_not_found': 'NOT_FOUND',
  'bank.payee_not_found': 'NOT_FOUND',
  'bank.linked_account_not_found': 'NOT_FOUND',
  'bank.cash_out_not_found': 'NOT_FOUND',
  'bank.limit_request_self_decision': 'FORBIDDEN',
  'bank.profile_not_held': 'FORBIDDEN',

  // Named refusals where the platform, not the caller, is missing something.
  // Same shape and the same reason as `bank.no_liquidation_counterparty`.
  'bank.no_card_issuer': 'PRECONDITION_FAILED',
  'bank.card_sim_not_live': 'PRECONDITION_FAILED',
  'bank.cashback_pot_unfunded': 'PRECONDITION_FAILED',
  'bank.rewards_issuer_unset': 'PRECONDITION_FAILED',
  'bank.rewards_asset_ambiguous': 'PRECONDITION_FAILED',
  'bank.card_pan_issuer_unset': 'PRECONDITION_FAILED',
  'bank.card_pin_issuer_unset': 'PRECONDITION_FAILED',
  'bank.card_wallet_issuer_unset': 'PRECONDITION_FAILED',
  'bank.no_ramp_rail': 'PRECONDITION_FAILED',
  'bank.live_ramp_unset': 'PRECONDITION_FAILED',
  'bank.no_paycheck_rail': 'PRECONDITION_FAILED',
  'bank.fiat_ramp_no_pay_adapter': 'PRECONDITION_FAILED',
  'bank.no_fiat_rail': 'PRECONDITION_FAILED',
  'bank.fiat_ramp_socket': 'PRECONDITION_FAILED',
  'bank.onramp_rate_unset': 'PRECONDITION_FAILED',
  'bank.onramp_quote_missing': 'PRECONDITION_FAILED',
  'bank.onramp_quote_expired': 'PRECONDITION_FAILED',
  'bank.onramp_instruction_missing': 'PRECONDITION_FAILED',
  'bank.offramp_fee_unset': 'PRECONDITION_FAILED',
  'bank.offramp_fee_inconsistent': 'PRECONDITION_FAILED',
  'bank.deposit_custody_unset': 'PRECONDITION_FAILED',
  'bank.deposit_catalogue_invalid': 'PRECONDITION_FAILED',
  'bank.deposit_asset_unpublished': 'PRECONDITION_FAILED',
  'bank.deposit_network_halted': 'PRECONDITION_FAILED',
  'bank.deposit_pending_unbounded': 'PRECONDITION_FAILED',
  'bank.deposit_address_cap_unset': 'PRECONDITION_FAILED',
  'bank.deposit_address_cap_reached': 'PRECONDITION_FAILED',
  'bank.deposit_address_expiry_unset': 'PRECONDITION_FAILED',
  'bank.deposit_address_numbers_used': 'PRECONDITION_FAILED',
  'bank.deposit_address_not_found': 'NOT_FOUND',
  'bank.deposit_address_label_invalid': 'BAD_REQUEST',
  'bank.withdraw_destination_missing': 'PRECONDITION_FAILED',
  'bank.destination_label_taken': 'PRECONDITION_FAILED',
  'bank.address_book_full': 'PRECONDITION_FAILED',
  'bank.address_book_cap_unset': 'PRECONDITION_FAILED',
  'bank.wallet_proof_window_unset': 'PRECONDITION_FAILED',
  'bank.wallet_proof_validity_unset': 'PRECONDITION_FAILED',
  'bank.linked_accounts_full': 'PRECONDITION_FAILED',
  'bank.cash_out_over_available': 'PRECONDITION_FAILED',
  'bank.cash_out_receipt_not_ready': 'PRECONDITION_FAILED',
  'bank.cash_out_receipt_signing_unset': 'PRECONDITION_FAILED',
  'bank.rail_send_over_available': 'PRECONDITION_FAILED',
  'bank.payee_cooling_unset': 'PRECONDITION_FAILED',
  'bank.payee_cooling_active': 'PRECONDITION_FAILED',
  'bank.payee_invite_unwired': 'PRECONDITION_FAILED',
  'bank.linked_account_unverified': 'PRECONDITION_FAILED',
  'rail.bank': 'PRECONDITION_FAILED',
  'bank.account_details_currencies_unset': 'PRECONDITION_FAILED',
  'bank.eligibility_unset': 'PRECONDITION_FAILED',
  'bank.fx_rate_unset': 'PRECONDITION_FAILED',
  'bank.dest_user_missing': 'PRECONDITION_FAILED',
  'bank.recipient_cannot_receive': 'PRECONDITION_FAILED',
  'bank.sender_cannot_send': 'PRECONDITION_FAILED',
  'bank.recipient_check_unset': 'PRECONDITION_FAILED',
  'bank.security_locked': 'PRECONDITION_FAILED',
  'bank.security_lock_unset': 'PRECONDITION_FAILED',
  'bank.account_frozen_self': 'PRECONDITION_FAILED',
  'bank.address_approval_not_pending': 'CONFLICT',
  'bank.address_approval_same_device': 'PRECONDITION_FAILED',
  'bank.address_approval_device_unknown': 'PRECONDITION_FAILED',
  'bank.address_approval_device_untrusted': 'PRECONDITION_FAILED',
  'bank.address_approval_device_unavailable': 'SERVICE_UNAVAILABLE',
  'bank.address_approval_link_unset': 'PRECONDITION_FAILED',
  'bank.address_approval_link_invalid': 'NOT_FOUND',
  'bank.address_approval_link_replaced': 'PRECONDITION_FAILED',
  'bank.address_approval_link_expired': 'PRECONDITION_FAILED',
  'bank.address_approval_mail_unavailable': 'SERVICE_UNAVAILABLE',
  'bank.address_approval_email_unproved': 'PRECONDITION_FAILED',
  'bank.offramp_cooling_unset': 'PRECONDITION_FAILED',
  'bank.offramp_cooling_active': 'PRECONDITION_FAILED',
  'bank.earn_rate_unset': 'PRECONDITION_FAILED',
  'bank.auto_invest_rate_unset': 'PRECONDITION_FAILED',
  'bank.business_payroll_rate_unset': 'PRECONDITION_FAILED',
  'bank.business_directory_unset': 'PRECONDITION_FAILED',
  'bank.business_directory_incomplete': 'PRECONDITION_FAILED',
  'bank.business_last_admin': 'PRECONDITION_FAILED',
  'bank.business_close_blocked': 'PRECONDITION_FAILED',
  'bank.business_member_has_pending': 'PRECONDITION_FAILED',
  // The client must run its step-up sheet (passkey or TOTP) and retry with `stepUpApprovalId`.
  'bank.step_up_required': 'PRECONDITION_FAILED',
  'bank.step_up_mismatch': 'PRECONDITION_FAILED',
  'bank.step_up_used': 'PRECONDITION_FAILED',
  'bank.activity_lookup_bounded': 'PRECONDITION_FAILED',
  'portfolio.entries_do_not_sum': 'PRECONDITION_FAILED',
  'bank.statement_pdf_one_month': 'PRECONDITION_FAILED',
  'bank.statement_too_large': 'PRECONDITION_FAILED',
  'bank.personal_transfer_terms_unset': 'PRECONDITION_FAILED',
  'bank.personal_transfer_fee_unwired': 'PRECONDITION_FAILED',
  'bank.pay_request_notify_unwired': 'PRECONDITION_FAILED',
  'bank.transfer_notify_unwired': 'PRECONDITION_FAILED',
  'bank.party_handles_unset': 'PRECONDITION_FAILED',
  'bank.account_terms_unset': 'PRECONDITION_FAILED',
  'bank.account_currencies_unset': 'PRECONDITION_FAILED',
  'bank.currency_in_use': 'PRECONDITION_FAILED',
  'bank.space_limit_unset': 'PRECONDITION_FAILED',
  'bank.space_limit_reached': 'PRECONDITION_FAILED',
  'bank.space_name_taken': 'CONFLICT',
  'bank.space_change_invalid': 'BAD_REQUEST',
  'bank.space_unlock_rule_unset': 'PRECONDITION_FAILED',
  'bank.space_not_locked': 'CONFLICT',
  'bank.sorter_terms_unset': 'PRECONDITION_FAILED',
  'bank.sorter_invalid': 'BAD_REQUEST',
  'bank.sorter_exists': 'CONFLICT',
  'bank.sorter_conflict': 'CONFLICT',
  'bank.sorter_not_found': 'NOT_FOUND',
  'bank.sorter_split_failed': 'CONFLICT',
  'bank.company_account_unwired': 'PRECONDITION_FAILED',
  'bank.loan_fee_unset': 'PRECONDITION_FAILED',
  'bank.loan_fee_unsupported': 'PRECONDITION_FAILED',
  'bank.loan_payoff_window_unset': 'PRECONDITION_FAILED',
  'bank.correction_invalid': 'BAD_REQUEST',
  'bank.correction_exceeds_interest': 'CONFLICT',
  'bank.correction_conflict': 'CONFLICT',
  'bank.loan_terms_missing': 'PRECONDITION_FAILED',
  'bank.schedule_edit_cutoff_unset': 'PRECONDITION_FAILED',
  'bank.dd_guarantee_unset': 'PRECONDITION_FAILED',
  'bank.calendar_window_invalid': 'BAD_REQUEST',
  'bank.rule_terms_unset': 'PRECONDITION_FAILED',
  'bank.reminder_lead_invalid': 'BAD_REQUEST',
  'bank.reminder_revision_conflict': 'CONFLICT',
  'bank.scheduled_notify_unwired': 'PRECONDITION_FAILED',
  'bank.dd_invalid': 'BAD_REQUEST',
  'bank.dd_creditor_unknown': 'BAD_REQUEST',
  'bank.dd_mandate_not_found': 'NOT_FOUND',
  'bank.dd_collection_not_found': 'NOT_FOUND',
  'bank.dd_mandate_conflict': 'CONFLICT',
  'bank.dd_collection_conflict': 'CONFLICT',
  'bank.dd_collection_invalid': 'BAD_REQUEST',
  'bank.dd_refund_not_collected': 'CONFLICT',
  // The request is fine; the period it had to be made in is over.
  'bank.dd_refund_window_closed': 'CONFLICT',
  'bank.recovery_unavailable': 'SERVICE_UNAVAILABLE',
  'bank.recovery_delegated': 'FORBIDDEN',
  'bank.recovery_staff_forbidden': 'FORBIDDEN',
  'bank.recovery_estate_not_found': 'NOT_FOUND',
  'bank.recovery_claim_not_found': 'NOT_FOUND',
  'bank.recovery_claim_conflict': 'CONFLICT',
  'bank.recovery_claim_refused': 'PRECONDITION_FAILED',
  'bank.recovery_blocked': 'PRECONDITION_FAILED',
  'bank.accrual_day_not_begun': 'PRECONDITION_FAILED',

  // Kill switches. Same 503 class as the matching HTTP job endpoints —
  // operator flipped the flag off; tRPC must not be a back door past it.
  'bank.transfers_disabled': 'SERVICE_UNAVAILABLE',
  'bank.interest_accrual_disabled': 'SERVICE_UNAVAILABLE',
  'bank.loan_accrual_disabled': 'SERVICE_UNAVAILABLE',
  'bank.loan_risk_sweep_disabled': 'SERVICE_UNAVAILABLE',
  'bank.auto_invest_disabled': 'SERVICE_UNAVAILABLE',
  'bank.loans_disabled': 'SERVICE_UNAVAILABLE',
  'bank.cards_disabled': 'SERVICE_UNAVAILABLE',

  // The ledger may have committed; the claim is held pending. Retry later
  // with the same id, never with a new one.
  'bank.ledger_outcome_unknown': 'SERVICE_UNAVAILABLE',
  // Identity could not answer; nothing was posted. Retry with the same id.
  'bank.recipient_check_unavailable': 'SERVICE_UNAVAILABLE',
  'bank.security_lock_unavailable': 'SERVICE_UNAVAILABLE',
  // Identity could not confirm the step-up approval; nothing was posted.
  'bank.step_up_unavailable': 'SERVICE_UNAVAILABLE',
  'bank.party_handles_unavailable': 'SERVICE_UNAVAILABLE',
  'bank.business_directory_unavailable': 'SERVICE_UNAVAILABLE',
  // The ledger's asset registry could not be read; nothing was saved. Retry later.
  'bank.asset_registry_unavailable': 'SERVICE_UNAVAILABLE',

  'bank.business_directory_rate_limited': 'TOO_MANY_REQUESTS',

  // svc-trade's prices could not be read. A retry later may work; the
  // caller sent nothing wrong.
  'bank.prices_unavailable': 'SERVICE_UNAVAILABLE',
  'bank.value_history_unavailable': 'SERVICE_UNAVAILABLE',
  'bank.value_range_invalid': 'BAD_REQUEST',
  'bank.value_range_too_long': 'BAD_REQUEST',
  'bank.value_history_too_large': 'BAD_REQUEST',
  'bank.statement_unavailable': 'SERVICE_UNAVAILABLE',
  'bank.ops_audit_unavailable': 'SERVICE_UNAVAILABLE',
  'bank.account_details_unavailable': 'SERVICE_UNAVAILABLE',
  // The pause read failed; the new borrow or deposit was refused rather than assumed open.
  'bank.asset_pause_unreadable': 'SERVICE_UNAVAILABLE',
  'bank.destination_fraud_list_unreadable': 'SERVICE_UNAVAILABLE',
};

export function toTrpcError(err: unknown): TRPCError {
  // An answer that has already been decided. Ownership refusals are thrown as
  // TRPCError from inside `guard`, and without this line every one of them was
  // re-wrapped as INTERNAL_SERVER_ERROR — a 500 that tells the caller to retry
  // something that can never succeed, and hides the refusal from any dashboard
  // grouping on status. That applied to the four `assertSelf` calls that were
  // already here, not only to the two added with this change.
  if (err instanceof TRPCError) return err;
  if (err instanceof DualControlError || err instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  if (err instanceof InsufficientFundsError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }
  if (err instanceof BankError) {
    // EXHAUSTIVENESS is the table's type. At runtime a code outside the declared union is
    // precisely the one whose message nobody vetted, so it gets the generic answer.
    if (!Object.hasOwn(BANK_ERROR_STATUS, err.code)) return opaqueFailure(err, `bank.error:${String(err.code)}`);
    return new TRPCError({ code: BANK_ERROR_STATUS[err.code], message: publicDoorWireMessage(err), cause: err });
  }
  if (err instanceof LedgerError) {
    // NOT `err.message`. `InsufficientFundsError` is handled above because it
    // describes the CALLER's own funds; every other LedgerError is a platform
    // fault whose message names accounts, owner ids and per-asset deltas —
    // internals of the book that no client asked about and none may read.
    return opaqueFailure(err, 'ledger.error');
  }
  return opaqueFailure(err, 'unknown');
}

export async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}
