import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  router,
  publicProcedure,
  scopedProcedure,
  serviceProcedureFor,
  TRPCError,
  BANK_APPROVER_ELIGIBILITY_CALLERS,
  bankApproverEligibilityInputSchema,
  bankApproverEligibilitySchema,
  PAY_CUSTODY_DEPOSIT_RECORDS_MAX_LIMIT,
  PAY_CUSTODY_DEPOSIT_STATUSES,
  payCustodyDepositRecordSchema,
} from '@intafaced/contracts';
import { InsufficientFundsError, LedgerError, formatAmount, parseAmount } from '@intafaced/ledger-client';
import { DualControlError } from './dual-control.js';
import {
  ActionApprovalConsumeError,
  consumeBankOpsApproval,
  unwiredApprovalConsumer,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';
import { BankError } from './errors.js';
import {
  FRAUD_BLOCK_STANCES,
  FRAUD_PREVIEW_ACTIONS,
  FRAUD_RISK_BANDS,
  FRAUD_SIGNALS,
  fraudPreview,
  refuseFraudPreviewAction,
} from './cards/fraud-preview.js';
import { requireBankJobService } from './ops-job-hmac.js';
import { accountForSpace, type SpaceRecord } from './spaces/space-service.js';
import type { BankServices } from './bank-service.js';
import type { CardRecord } from './cards/card-service.js';
import { userFacingBankMessage } from './user-copy.js';
import { describeAutoInvestPolicy } from './auto-invest/auto-invest-policy.js';
import { BUSINESS_ROLES, describeBusinessPolicy } from './business/business-policy.js';
import { poolTotalsProcedure } from './ops/pool-totals.js';
import { loanBookProcedure } from './ops/loan-book.js';
import { loanServicingPreviewProcedures, type LoanMissedPaymentPolicy } from './loans/loan-servicing-preview.js';
import { cardProgrammeProcedure, setCardStatusProcedure } from './ops/card-programme.js';
import {
  createLimitsRouter,
  decideLimitRequestProcedure,
  LimitRequestService,
  limitRequestQueueProcedure,
} from './transfers/limit-requests.js';
import { createLoanProductProcedure } from './ops/loan-products.js';
import { rampHealthProcedure } from './ops/ramp-health.js';
import { transferHealthProcedure } from './ops/transfer-health.js';
import { failedTransfersProcedure } from './ops/failed-transfers.js';
import { customerBalanceEntriesProcedure, customerBalancesProcedure } from './ops/customer-balances.js';
import { transferDetailProcedure } from './ops/transfer-detail.js';
import { businessApprovalsProcedure } from './ops/business-approvals.js';
import { activityFailure, createActivityRouter } from './activity/activity.router.js';
import { createStatementsRouter } from './statements/statement.router.js';
import { createAccountDetailsRouter, createEligibilityRouter } from './account-details/account-details.router.js';
import { createCreditCardPreviewRouter } from './loans/credit-card-preview.router.js';
import { createBillsRouter, createGlobalRouter } from './personal-pay/router.js';
import { createPersonalRequestRouter } from './transfers/personal-request.router.js';
import { plainNote, plainReference } from './transfers/personal-pay.js';
import { stepUpOff, type StepUpGate } from './step-up/step-up-gate.js';
import { ALLOCATION_CLASSES, ALLOCATION_TYPES } from './portfolio/allocation.js';
import { BALANCE_ENTRIES_DEFAULT_LIMIT, BALANCE_ENTRIES_MAX_LIMIT } from './portfolio/portfolio-service.js';
import {
  addMemberBinding,
  removeMemberBinding,
  setMemberRoleBinding,
  approveBinding,
  createTransferBinding,
  issueCardBinding,
  proposeTransferBinding,
  revealCardBinding,
  revealCardPinBinding,
  setCardLimitsBinding,
  setCardPinBinding,
  runPayrollBinding,
  scheduleBinding,
  scheduleToUserBinding,
  toUserBinding,
  unfreezeCardBinding,
  type DoorBinding,
} from './step-up/money-out-fields.js';

/**
 * svc-bank's API.
 *
 * Two things to notice about what is NOT here.
 *
 * First, there is no procedure that writes a balance, because there is no
 * balance to write. `spaces.list` returns figures it just read from the ledger;
 * they are outputs, never inputs.
 *
 * Second, the scheduled jobs (standing-order runner, accrual, risk sweep,
 * auto-invest, pending resume) are NOT user-callable and not treasury-session
 * callable. They are HMAC as `svc-bank`, matching POST /internal/jobs/*. A
 * user able to trigger "run every due transfer" is a user able to choose when
 * other people's money moves.
 */

/** Money crosses the wire as a decimal string. Always. Never a number. */
/** 2-decimal USD figure on the wire. May be negative (a price move). */
const usd2String = z.string().regex(/^-?\d+\.\d{2}$/);
/** Full-precision signed decimal string (a per-asset value or price move). */
const signedAmountString = z.string().regex(/^-?\d+(\.\d{1,18})?$/);

const portfolioSummaryOutput = z.object({
  totalUsd: usd2String.nullable(),
  change24hUsd: usd2String.nullable(),
  cashUsd: usd2String.nullable(),
  cryptoUsd: usd2String.nullable(),
  priced: z.array(
    z.object({
      asset: z.string(),
      amount: z.string(),
      priceUsd: z.string(),
      valueUsd: z.string(),
      change24hUsd: signedAmountString.nullable(),
      pair: z.string().nullable(),
    }),
  ),
  unpriced: z.array(z.object({ asset: z.string(), amount: z.string(), reason: z.enum(['no_market', 'no_price_yet']) })),
  asOf: z.number().int(),
  windowStart: z.number().int().nullable(),
  /** Only when `valueIn` is `btc`. Both fields are null, with a reason, while no BTC price is published. */
  btc: z
    .object({
      total: z.string().nullable(),
      priceUsd: z.string().nullable(),
      reason: z.enum(['no_price_published', 'nothing_priced']).nullable(),
    })
    .optional(),
});

const destinationViewOutput = z.object({
  destinationId: z.string(),
  label: z.string().nullable(),
  kind: z.enum(['crypto', 'bank']),
  ref: z.string(),
  refMasked: z.string(),
  assetId: z.string().nullable(),
  network: z.string().nullable(),
  tag: z.string().nullable(),
  origin: z.enum(['legacy', 'customer']),
  state: z.enum(['pending', 'cooling', 'active', 'blocked', 'archived']),
  addedAt: z.string(),
  coolingOffEndsAt: z.string().nullable(),
  coolingBlocker: z.literal('bank.offramp_cooling_unset').nullable(),
});

const balanceAccountsOutput = z.object({
  /** Every account the caller can read balances for: `main`, then each named Space. */
  accounts: z.array(z.object({ accountId: z.string(), walletType: z.enum(['main', 'space']), name: z.string().nullable() })),
});

const balanceBreakdownOutput = z.object({
  assets: z.array(
    z.object({
      assetId: z.string(),
      total: signedAmountString,
      available: signedAmountString,
      locked: z.array(
        z.object({
          kind: z.string(),
          amount: signedAmountString,
          claims: z.array(z.object({ purpose: z.string(), amount: signedAmountString })),
        }),
      ),
    }),
  ),
});

const balanceEntriesOutput = z.object({
  assetId: z.string(),
  entries: z.array(
    z.object({
      entryId: z.string().nullable(),
      txId: z.string(),
      accountId: z.string(),
      reason: z.string(),
      direction: z.enum(['debit', 'credit']),
      amount: signedAmountString,
      postedAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
  sumCheck: z.object({ ok: z.literal(true), entriesSum: signedAmountString, balance: signedAmountString, entryCount: z.number().int() }),
});

const allocationOutput = z.object({
  totalValueUsd: signedAmountString,
  classes: z.array(
    z.object({
      class: z.enum(ALLOCATION_CLASSES),
      valueUsd: signedAmountString,
      share: signedAmountString,
      assets: z.array(z.object({ asset: z.string(), valueUsd: signedAmountString, share: signedAmountString })),
    }),
  ),
  types: z.array(z.object({ type: z.enum(ALLOCATION_TYPES), valueUsd: signedAmountString, share: signedAmountString })),
  unpriced: z.array(z.object({ asset: z.string(), amount: z.string(), reason: z.enum(['no_market', 'no_price_yet']) })),
  asOf: z.number().int(),
});

const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');

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
 * Rule 2 is why the switch is exhaustive over `BankErrorCode` and the default
 * carries a `never` assignment: adding a code without deciding what a caller
 * may be told now fails the typecheck instead of silently becoming a 400 with
 * the domain sentence attached.
 */

/** The generic answer. Detail lives in the log, joined by this reference. */
function opaqueFailure(err: unknown, context: string): TRPCError {
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
function publicDoorWireMessage(err: BankError): string {
  const facing = userFacingBankMessage(err.code, err.message);
  if (facing.includes(err.code)) return facing;
  if (
    err.code === 'bank.pool_underfunded' ||
    err.code === 'bank.mark_missing' ||
    err.code === 'bank.prices_unavailable' ||
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

function toTrpcError(err: unknown): TRPCError {
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
    const message = publicDoorWireMessage(err);
    switch (err.code) {
      case 'bank.space_not_found':
      case 'bank.schedule_not_found':
      case 'bank.activity_not_found':
      case 'bank.pool_not_found':
      case 'bank.position_not_found':
      case 'bank.loan_not_found':
      case 'bank.loan_product_not_found':
      case 'bank.personal_transfer_not_found':
      case 'bank.ops_transfer_not_found':
      case 'bank.personal_request_not_found':
      case 'bank.personal_request_payer_unknown':
      case 'bank.auto_invest_not_found':
      case 'bank.business_not_found':
      case 'bank.business_approval_not_found':
        return new TRPCError({ code: 'NOT_FOUND', message, cause: err });
      case 'bank.insufficient_funds':
        return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });
      case 'bank.not_owner':
      case 'bank.personal_request_not_payer':
      case 'bank.personal_request_not_payee':
        return new TRPCError({ code: 'FORBIDDEN', message, cause: err });
      case 'bank.pool_underfunded':
      case 'bank.earn_principal_mismatch':
        // Not the caller's fault and not something a retry fixes — the pool
        // needs funding (or books reconciled) before this day can accrue.
        return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });

      // ── Loans: refusals that are NOT the caller's fault ───────────────────
      //
      // Each of these is the platform declining to act, and every one of them
      // would be a lie as a 400. A borrower told "bad request" when the lending
      // reserve is empty, or when the price feed is too stale to seize collateral
      // on, will retry the request forever and learn nothing.
      case 'bank.loan_reserve_underfunded':
      case 'bank.mark_unusable':
      case 'bank.mark_missing':
      case 'bank.loan_health_price_unset':
      case 'bank.mark_invalid':
      case 'bank.no_liquidation_counterparty':
      case 'bank.loan_seizure_cross_asset':
      case 'bank.accrual_backlog':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });

      // The loudest one. Collateral was exhausted and the insurance fund could
      // not make the reserve whole — a platform-side loss, not a client error.
      case 'bank.bad_debt_uncovered':
      case 'bank.policy_incoherent':
        return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message, cause: err });

      // Ordering refusals. Genuinely the caller's request being wrong for the
      // current state of the loan, so 409 rather than 400: nothing about the
      // input is malformed, and the same request may succeed later.
      case 'bank.loan_not_settled':
      case 'bank.loan_not_drawable':
      // The last attempt on a pending loan is inside the in-flight bound: wait.
      case 'bank.loan_attempt_too_recent':
      case 'bank.loan_collateral_rejected':
      case 'bank.loan_liquidating':
      case 'bank.margin_call_required':
      case 'bank.loan_closed':
        return new TRPCError({ code: 'CONFLICT', message, cause: err });

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
      case 'bank.space_archived':
      case 'bank.space_locked':
      case 'bank.schedule_inactive':
      case 'bank.pool_closed':
      case 'bank.position_closed':
      case 'bank.position_locked':
      case 'bank.position_pending':
      case 'bank.loan_product_closed':
      case 'bank.auto_invest_inactive':
      case 'bank.auto_invest_invalid_threshold':
      case 'bank.auto_invest_roundup_exists':
      case 'bank.auto_invest_run_failed':
      case 'bank.auto_invest_below_threshold':
      case 'bank.business_closed':
      case 'bank.business_not_member':
      case 'bank.business_role_forbidden':
      case 'bank.business_invalid_threshold':
      case 'bank.business_invalid_name':
      case 'bank.business_approval_inactive':
      case 'bank.business_self_approve':
      case 'bank.business_rejected':
      case 'bank.business_cancelled':
      // CONFLICT rather than BAD_REQUEST: the request is well-formed, it just
      // collides with a loan that already exists under that id on other terms.
      case 'bank.loan_principal_mismatch':
      case 'bank.loan_collateral_mismatch':
      // The same class for the borrower half and for earn. All three name only
      // the id the caller already holds — never who the existing record belongs
      // to — so FORBIDDEN would be both wrong and more disclosing.
      case 'bank.loan_borrower_mismatch':
      case 'bank.position_conflict':
      case 'bank.schedule_conflict':
      case 'bank.business_payroll_conflict':
      case 'bank.business_request_conflict':
      case 'bank.personal_transfer_conflict':
      case 'bank.personal_request_conflict':
      case 'bank.personal_request_closed':
      case 'bank.personal_request_expired':
      case 'bank.personal_request_amount_mismatch':
      case 'bank.personal_request_payee_mismatch':
      case 'bank.personal_request_claim_held':
      case 'bank.business_change_pending':
      case 'bank.card_issue_conflict':
      case 'bank.card_command_conflict':
      case 'bank.card_replace_conflict':
      case 'bank.card_operator_frozen':
      case 'bank.business_conflict':
      case 'bank.transfer_message_conflict':
      case 'bank.activity_note_conflict':
      case 'bank.activity_dispute_conflict':
      case 'bank.activity_dispute_exists':
      case 'bank.activity_filter_conflict':
      case 'bank.limit_request_open':
      case 'bank.limit_request_conflict':
      case 'bank.limit_request_decided':
      case 'bank.loan_product_conflict':
        return new TRPCError({ code: 'CONFLICT', message, cause: err });

      case 'bank.same_space':
      case 'bank.asset_mismatch':
      case 'bank.position_id_required':
      case 'bank.schedule_id_required':
      case 'bank.repayment_id_required':
      case 'bank.business_request_id_required':
      case 'bank.event_id_required':
      case 'bank.below_minimum':
      case 'bank.native_asset_not_earnable':
      case 'bank.ltv_exceeded':
      /** Borrower short of collateral at open — same class as ltv_exceeded. */
      case 'bank.loan_collateral_short':
      case 'bank.card_not_found':
      case 'bank.card_not_active':
      case 'bank.card_limit_exceeded':
      case 'bank.card_shipping_address_required':
      case 'bank.card_pin_invalid':
      case 'bank.card_authorization_not_found':
      case 'bank.card_authorization_declined':
      case 'bank.card_authorization_closed':
      case 'bank.card_capture_exceeds_authorization':
      /** Disagrees with a claimed settlement row — same class as ramp_conflict. */
      case 'bank.card_settlement_amount_conflict':
      /** Disagrees with the kind a sequence was claimed for — same class as the amount. */
      case 'bank.card_settlement_kind_conflict':
      case 'bank.ramp_invalid_amount':
      case 'bank.ramp_invalid_asset':
      case 'bank.ramp_invalid_destination':
      case 'bank.ramp_conflict':
      case 'bank.business_payroll_empty':
      case 'bank.earn_resume_pending_limit_unset':
      case 'bank.loan_resume_pending_limit_unset':
      case 'bank.loan_accrue_batch_limit_unset':
      case 'bank.transfer_due_limit_unset':
      case 'bank.auto_invest_batch_limit_unset':
      case 'bank.loan_risk_sweep_limit_unset':
      case 'bank.earn_pools_list_limit_unset':
      case 'bank.loan_products_list_limit_unset':
      case 'bank.spaces_list_limit_unset':
      case 'bank.earn_positions_list_limit_unset':
      case 'bank.loans_list_limit_unset':
      case 'bank.cards_list_limit_unset':
      case 'bank.card_authorizations_list_limit_unset':
      case 'bank.schedules_list_limit_unset':
      case 'bank.executions_list_limit_unset':
      case 'bank.auto_invest_list_limit_unset':
      case 'bank.business_list_limit_unset':
      case 'bank.business_pending_list_limit_unset':
      case 'bank.business_approvals_list_limit_unset':
      case 'bank.business_cursor_invalid':
      case 'bank.business_recipient_query':
      case 'bank.onramps_list_limit_unset':
      case 'bank.offramps_list_limit_unset':
      case 'bank.convert_markets_limit_unset':
      case 'bank.validation_failed':
      case 'bank.activity_range':
      case 'bank.activity_note_empty':
      case 'bank.statement_range':
      case 'bank.personal_note_invalid':
      case 'bank.personal_reference_invalid':
      case 'bank.personal_transfer_limit_exceeded':
      case 'bank.personal_transfer_daily_limit_exceeded':
      case 'bank.personal_request_self':
      case 'bank.personal_request_list_limit_unset':
      case 'bank.ops_reason_too_short':
      case 'bank.card_programme_span_unset':
      case 'bank.card_programme_span_too_long':
      case 'bank.ramp_health_window_unset':
      case 'bank.transfer_health_window_unset':
      case 'bank.failed_transfers_window_unset':
      case 'bank.failed_transfers_limit_unset':
      case 'bank.account_details_currency_unknown':
      case 'bank.failed_transfers_cursor_invalid':
      case 'bank.ops_business_approvals_limit_unset':
      case 'bank.activity_filter_name_invalid':
      case 'bank.activity_filter_empty':
      case 'bank.activity_filter_limit_unset':
      case 'bank.limit_request_reason_too_short':
      case 'bank.limit_request_list_limit_unset':
      case 'bank.limit_grant_unset':
      case 'bank.loan_params_invalid':
        return new TRPCError({ code: 'BAD_REQUEST', message, cause: err });

      case 'bank.limit_request_not_found':
        return new TRPCError({ code: 'NOT_FOUND', message, cause: err });
      case 'bank.limit_request_self_decision':
        return new TRPCError({ code: 'FORBIDDEN', message, cause: err });

      // Named refusals where the platform, not the caller, is missing something.
      // Same shape and the same reason as `bank.no_liquidation_counterparty`.
      case 'bank.no_card_issuer':
      case 'bank.card_sim_not_live':
      case 'bank.cashback_pot_unfunded':
      case 'bank.rewards_issuer_unset':
      case 'bank.rewards_asset_ambiguous':
      case 'bank.card_pan_issuer_unset':
      case 'bank.card_pin_issuer_unset':
      case 'bank.card_wallet_issuer_unset':
      case 'bank.no_ramp_rail':
      case 'bank.live_ramp_unset':
      case 'bank.no_paycheck_rail':
      case 'bank.fiat_ramp_no_pay_adapter':
      case 'bank.no_fiat_rail':
      case 'bank.fiat_ramp_socket':
      case 'bank.onramp_rate_unset':
      case 'bank.onramp_quote_missing':
      case 'bank.onramp_quote_expired':
      case 'bank.onramp_instruction_missing':
      case 'bank.offramp_fee_unset':
      case 'bank.offramp_fee_inconsistent':
      case 'bank.deposit_custody_unset':
      case 'bank.deposit_catalogue_invalid':
      case 'bank.deposit_asset_unpublished':
      case 'bank.deposit_pending_unbounded':
      case 'bank.withdraw_destination_missing':
      case 'bank.destination_label_taken':
      case 'bank.address_book_full':
      case 'bank.address_book_cap_unset':
      case 'rail.bank':
      case 'bank.account_details_currencies_unset':
      case 'bank.eligibility_unset':
      case 'bank.fx_rate_unset':
      case 'bank.dest_user_missing':
      case 'bank.recipient_cannot_receive':
      case 'bank.recipient_check_unset':
      case 'bank.offramp_cooling_unset':
      case 'bank.offramp_cooling_active':
      case 'bank.earn_rate_unset':
      case 'bank.auto_invest_rate_unset':
      case 'bank.business_payroll_rate_unset':
      case 'bank.business_directory_unset':
      case 'bank.business_directory_incomplete':
      case 'bank.business_last_admin':
      case 'bank.business_close_blocked':
      case 'bank.business_member_has_pending':
      // The client must run its step-up sheet (passkey or TOTP) and retry with `stepUpApprovalId`.
      case 'bank.step_up_required':
      case 'bank.step_up_mismatch':
      case 'bank.step_up_used':
      case 'bank.activity_lookup_bounded':
      case 'portfolio.entries_do_not_sum':
      case 'bank.statement_pdf_one_month':
      case 'bank.statement_too_large':
      case 'bank.personal_transfer_terms_unset':
      case 'bank.personal_transfer_fee_unwired':
      case 'bank.pay_request_notify_unwired':
      case 'bank.party_handles_unset':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message, cause: err });

      // Kill switches. Same 503 class as the matching HTTP job endpoints —
      // operator flipped the flag off; tRPC must not be a back door past it.
      case 'bank.transfers_disabled':
      case 'bank.interest_accrual_disabled':
      case 'bank.loan_accrual_disabled':
      case 'bank.loan_risk_sweep_disabled':
      case 'bank.auto_invest_disabled':
      case 'bank.loans_disabled':
      case 'bank.cards_disabled':
        return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message, cause: err });

      // The ledger may have committed; the claim is held pending. Retry later
      // with the same id, never with a new one.
      case 'bank.ledger_outcome_unknown':
      // Identity could not answer; nothing was posted. Retry with the same id.
      case 'bank.recipient_check_unavailable':
      // Identity could not confirm the step-up approval; nothing was posted.
      case 'bank.step_up_unavailable':
      case 'bank.party_handles_unavailable':
      case 'bank.business_directory_unavailable':
        return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message, cause: err });

      case 'bank.business_directory_rate_limited':
        return new TRPCError({ code: 'TOO_MANY_REQUESTS', message, cause: err });

      // svc-trade's prices could not be read. A retry later may work; the
      // caller sent nothing wrong.
      case 'bank.prices_unavailable':
      case 'bank.statement_unavailable':
      case 'bank.ops_audit_unavailable':
      case 'bank.account_details_unavailable':
        return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message, cause: err });

      default: {
        // EXHAUSTIVENESS. If this line stops compiling, a `BankErrorCode` was
        // added without anyone deciding what a caller may be told about it —
        // which is exactly the omission that made the archived-space oracle.
        // Reachable at RUNTIME only for a code outside the declared union, and
        // an undeclared code is precisely the one whose message nobody vetted.
        const undeclared: never = err.code;
        return opaqueFailure(err, `bank.error:${String(undeclared)}`);
      }
    }
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

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

/**
 * A principal may only ever act on its own money, whatever its scopes say.
 *
 * WHY FORBIDDEN AND NOT NOT_FOUND. The trade-off is real and goes the other
 * way on the first reading: NOT_FOUND leaks strictly less, because it never
 * confirms that the id exists. We take FORBIDDEN anyway.
 *
 *   · It is the truth. Every id this guards is a v4 uuid the client already
 *     holds, so the overwhelmingly common way to reach this line is a user or
 *     an integration passing the wrong one. Telling them "no such schedule"
 *     sends them hunting for a record that is alive and well, and it is a lie
 *     we would have to keep telling in the logs too.
 *
 *   · The oracle it opens is worth almost nothing here. 122 bits of entropy
 *     means the id space is not enumerable, so FORBIDDEN discloses exactly one
 *     fact: a uuid the caller ALREADY OBTAINED belongs to someone else. An
 *     attacker who has the id has, by construction, already been somewhere they
 *     could see it.
 *
 * svc-agents' `ownedSession` makes the opposite call and returns NOT_FOUND for
 * both cases. That is a defensible reading of the same trade-off. What is not
 * defensible is doing both inside one service, so every ownership refusal in
 * svc-bank goes through this function and every one of them is FORBIDDEN.
 */
function assertSelf(principalUserId: string | undefined, ownerId: string): void {
  if (principalUserId !== ownerId) {
    // Note what this message does NOT contain: no name, no asset, no balance,
    // no id. The refusal-shape ADR's rule — a refusal may only describe objects
    // the caller was already entitled to see — is satisfied by this sentence in
    // either reading of the code above it. What the ADR would additionally
    // prefer is the CODE: `NOT_FOUND` rather than `FORBIDDEN`, so that "not
    // yours" cannot confirm an id. That is a change to who may see what, which
    // the ADR reserves to the owner, and this service argued the opposite case
    // in writing first. It stays FORBIDDEN, uniformly, until the owner moves it.
    throw new TRPCError({ code: 'FORBIDDEN', message: 'This account belongs to another user' });
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DESTINATION GATE — what a caller may be told about somebody else's space.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `transfers.create` and `transfers.schedule` each name TWO spaces and
 * owner-check ONE (see the written reason at those call sites). That is correct
 * for safety and it is the product. It was not correct for disclosure.
 *
 * `space-service.ts` writes its refusals for the person who owns the space:
 * `Space "Holiday fund" is archived`, `Cannot transfer USDT into a EUR space`.
 * Delivered to the owner those sentences are the most useful thing this service
 * says. Delivered to a stranger who guessed a uuid they are an oracle over
 * another user's accounts — existence, the user's own chosen NAME, and the
 * asset — for the price of a transfer that does not even have to succeed.
 *
 * So the message is not the bug and neither is the missing check. The bug is
 * that nothing between them decided whether THIS caller may hear it. This
 * function is that decision, and it has exactly two outcomes:
 *
 *   · the destination is the caller's       → return, and every refusal below
 *                                             reaches them intact, name and all
 *   · it is not, or there is no such space  → `NOT_FOUND`, naming NOTHING, and
 *                                             BYTE-IDENTICAL between the two
 *
 * The second bullet is the whole rule. "Exists but is not yours" and "does not
 * exist" are one answer here — not a lie, because relative to this caller there
 * is no such space in any sense they are entitled to.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: refuse the transfer. Paying a stranger is
 * the product (`bank-service.test.ts` pins that value moves between two
 * different users' spaces), so a destination that is somebody else's, live, and
 * in the right asset proceeds exactly as before. Only the FAILURES stop
 * describing it.
 *
 * The three conditions checked here are the three `space-service.ts` refuses a
 * credit on, and they are re-checked inside `TransferService` where they are
 * ENFORCED. This is not a second enforcement point; it is a disclosure gate
 * that happens to have to know the same three facts.
 */
const NO_SUCH_DESTINATION = 'No such space';

/** One construction site, so the two paths cannot drift apart by a byte. */
function noSuchDestination(): TRPCError {
  return new TRPCError({ code: 'NOT_FOUND', message: NO_SUCH_DESTINATION });
}

async function gateDestination(
  bank: BankServices,
  callerUserId: string | undefined,
  from: SpaceRecord,
  toSpaceId: string,
): Promise<{ mayDescribe: boolean }> {
  // One SELECT, and the same one, whether the row is there or not — `find`
  // rather than `get` for that reason. A lookup that throws for "absent" makes
  // the absent path do measurably different work from the present one, and the
  // ADR's done bar names timing as well as status.
  const to = await bank.spaces.find(toSpaceId);

  if (to !== null && to.userId === callerUserId) return { mayDescribe: true };

  // From here the caller is entitled to nothing about this space, so every
  // branch produces the same object. Ordering is irrelevant — they are equal.
  if (to === null) throw noSuchDestination();
  if (to.archivedAt) throw noSuchDestination();
  if (to.assetId !== from.assetId) throw noSuchDestination();

  // Otherwise: somebody else's live space in the right asset. Cross-user
  // transfer is the product; it proceeds, and a failure after this point comes
  // from the caller's OWN side — their funds, their lock — and is theirs to
  // read.
  return { mayDescribe: false };
}

/**
 * The backstop, for a refusal the gate above did not anticipate.
 *
 * `TransferService` resolves the destination again and could grow a new
 * destination-side precondition without this file noticing. These two codes can
 * only be about the destination once `from` has been fetched and its asset is
 * known, so they are flattened rather than trusted. `bank.space_archived` is
 * NOT in the list on purpose: the gate already covered the destination case,
 * which leaves the caller's OWN archived space as the remaining source, and
 * that message belongs to them.
 */
function hideDestinationDetail(err: unknown): unknown {
  if (err instanceof BankError && (err.code === 'bank.space_not_found' || err.code === 'bank.asset_mismatch')) {
    return noSuchDestination();
  }
  // A recipient who is frozen, closed or unknown reads exactly like a space that
  // does not exist: relative to this caller there is nothing to learn about them.
  if (err instanceof BankError && err.code === 'bank.recipient_cannot_receive') {
    return noSuchDestination();
  }
  return err;
}

const spaceOutput = z.object({
  id: z.string(),
  assetId: z.string(),
  kind: z.enum(['primary', 'named']),
  name: z.string(),
  goalTarget: z.string().nullable(),
  lockedUntil: z.string().nullable(),
  /** Read from the ledger at request time. Not stored, not cached. */
  balance: amountString,
  /** The ledger account this space is a view of — so a client can verify us. */
  ledgerAccount: z.object({ ownerType: z.string(), ownerId: z.string(), assetId: z.string(), kind: z.string() }),
});

/**
 * Optional kill switches for operator jobs. Production passes live env values
 * from `index.ts`; tests inject without loading `env` (which needs full service env).
 *
 * Every flag that gates an HTTP `/internal/jobs/*` endpoint MUST also gate the
 * matching `ops.*` mutation. A tRPC-only back door past an emergency stop is
 * the residual #1271 closed for transfers and that this options bag closes for
 * earn accrual, loan accrual, and the risk sweep.
 */
export type BankRouterOptions = {
  /** When false, `ops.runDueTransfers` refuses with `bank.transfers_disabled`. Default true. */
  scheduledTransfersEnabled?: boolean;
  /** When false, `ops.accrueInterest` refuses with `bank.interest_accrual_disabled`. Default true. */
  interestAccrualEnabled?: boolean;
  /** When false, `ops.accrueLoanInterest` refuses with `bank.loan_accrual_disabled`. Default true. */
  loanAccrualEnabled?: boolean;
  /** When false, `ops.runRiskSweep` refuses with `bank.loan_risk_sweep_disabled`. Default true. */
  loanRiskSweepEnabled?: boolean;
  /** When false, `ops.runAutoInvest` refuses with `bank.auto_invest_disabled`. Default true. */
  autoInvestEnabled?: boolean;
  /** True when trade.convert ConvertPort is wired at boot. */
  autoInvestConvertWired?: boolean;
  /**
   * Identity HMAC consume for treasury ops.* mutates. Blank IDENTITY_URL at boot
   * injects unwired — tests pass stubApprovalConsumer(approverId).
   */
  approvals?: ActionApprovalConsumer;
  /**
   * Money-out step-up (BANK_STEP_UP_MONEY_OUT). Omitted or `off` leaves the money-out doors as they
   * were. Card number, CVV and PIN reveal/set are the exception: they refuse
   * `bank.step_up_unavailable` until the mode is `required`. When `required`, sends to other users,
   * business payments and membership, card unfreeze/issue and standing orders to other people need
   * `stepUpApprovalId` (a same-person identity approval).
   */
  stepUp?: StepUpGate;
  /** BK-loan-09: owner-published missed-payment policy. Omitted: `loans.missedPaymentPolicy` reads `not_set`. */
  loanMissedPaymentPolicy?: LoanMissedPaymentPolicy | null;
};

/** Optional on the wire so a missing approval is `bank.step_up_required`, not a Zod error. */
const stepUpApprovalField = z.string().min(1).max(128).optional();

function refuseCardSecretWithoutStepUp(): never {
  throw new BankError(
    'Showing or setting card secrets needs step-up, and step-up is not switched on in this deployment.',
    'bank.step_up_unavailable',
  );
}

const actionApprovalFields = {
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().max(128).nullish(),
  operationId: z.string().max(128).nullish(),
};

export function createBankRouter(bank: BankServices, options: BankRouterOptions = {}) {
  const scheduledTransfersEnabled = options.scheduledTransfersEnabled ?? true;
  const interestAccrualEnabled = options.interestAccrualEnabled ?? true;
  const loanAccrualEnabled = options.loanAccrualEnabled ?? true;
  const loanRiskSweepEnabled = options.loanRiskSweepEnabled ?? true;
  const autoInvestEnabled = options.autoInvestEnabled ?? true;
  const autoInvestConvertWired = options.autoInvestConvertWired ?? false;
  const approvals = options.approvals ?? unwiredApprovalConsumer();
  // Same connection as the transfer reads; built lazily so mounts with a partial fake never touch it.
  let limitRequestService: LimitRequestService | undefined;
  const limitRequests = () => (limitRequestService ??= new LimitRequestService(bank.transferOps.sql));
  const stepUp = options.stepUp ?? stepUpOff;
  const stepUpEnforced = stepUp.mode === 'required';

  async function requireStepUp(
    principal: { readonly userId: string; readonly sid: string },
    binding: DoorBinding,
    approvalId: string | undefined,
    replay = true,
  ): Promise<void> {
    await stepUp.require({
      userId: principal.userId,
      sessionId: principal.sid,
      actionType: binding.actionType,
      fields: binding.fields,
      operationKey: binding.operationKey,
      approvalId,
      replay,
    });
  }

  /** The asset of a space the caller names, for the hash. Unknown spaces hash as '' and the service refuses them. */
  async function assetOfSpace(spaceId: string): Promise<string> {
    return (await bank.spaces.find(spaceId))?.assetId ?? '';
  }

  async function consumeOpsApproval(
    input: { readonly approvalId?: string | null; readonly operationId?: string | null },
    targetId: string,
    fields: Record<string, string>,
  ): Promise<string> {
    return consumeBankOpsApproval(approvals, input, targetId, fields);
  }

  /** HTTP job twin: HMAC as svc-bank. Session admin:treasury is 401 unsigned. */
  const jobProcedure = publicProcedure.use(({ ctx, next }) => {
    requireBankJobService(ctx.service);
    return next({ ctx });
  });

  const spaces = router({
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16).optional(),
          /**
           * Page size. Optional so omit reaches `bank.spaces_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(z.array(spaceOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const userId = ctx.principal.userId;
          const views = await bank.spaces.overview(userId, input.assetId, input.limit);
          return views.map((v) => ({
            id: v.id,
            assetId: v.assetId,
            kind: v.kind,
            name: v.name,
            goalTarget: v.goalTarget === null ? null : formatAmount(v.goalTarget),
            lockedUntil: v.lockedUntil?.toISOString() ?? null,
            balance: v.balance,
            ledgerAccount: accountForSpace(v),
          }));
        }),
      ),

    /** Assets the user holds with no space yet — sourced from the ledger, not this table. */
    unnamed: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.array(z.object({ assetId: z.string(), balance: amountString })))
      .query(async ({ ctx }) => guard(async () => bank.spaces.unnamedAssets(ctx.principal.userId))),

    create: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          name: z.string().min(1).max(64),
          goalTarget: amountString.optional(),
          lockedUntil: z.string().datetime({ offset: true }).optional(),
        }),
      )
      .output(z.object({ id: z.string(), name: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          // The primary space must exist before a named one is useful — it is
          // where value arrives from every other module.
          await bank.spaces.ensurePrimary(ctx.principal.userId, input.assetId);
          const space = await bank.spaces.create({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            name: input.name,
            goalTarget: input.goalTarget ? parseAmount(input.goalTarget) : null,
            lockedUntil: input.lockedUntil ? new Date(input.lockedUntil) : null,
          });
          return { id: space.id, name: space.name };
        }),
      ),

    archive: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ spaceId: z.string().uuid() }))
      .output(z.object({ archived: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const space = await bank.spaces.get(input.spaceId);
          assertSelf(ctx.principal.userId, space.userId);
          await bank.spaces.archive(input.spaceId);
          return { archived: true as const };
        }),
      ),

    unarchive: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ spaceId: z.string().uuid() }))
      .output(z.object({ archived: z.literal(false) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const space = await bank.spaces.get(input.spaceId);
          assertSelf(ctx.principal.userId, space.userId);
          await bank.spaces.unarchive(input.spaceId);
          return { archived: false as const };
        }),
      ),
  });

  const transfers = router({
    /**
     * The caller's own transfer history: money sent to or received from another person, and moves between their own
     * accounts. It is the activity feed narrowed to those kinds, so it has the same sources, paging and ownership
     * rules and no second list of its own. Every line is a posted ledger entry, so every line is `completed`; a failed
     * or skipped standing-order run is read with `transfers.executions`.
     */
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(200).optional(),
            cursor: z.string().min(1).max(16_384).optional(),
            assetId: z.string().min(1).max(16).optional(),
            from: z.string().datetime({ offset: true }).optional(),
            to: z.string().datetime({ offset: true }).optional(),
          })
          .strict()
          .optional(),
      )
      .output(
        z.object({
          items: z.array(
            z.object({
              id: z.string(),
              txId: z.string(),
              kind: z.enum(['transfer_in', 'transfer_out', 'space_move']),
              direction: z.enum(['in', 'out']),
              asset: z.string(),
              amount: amountString,
              postedAt: z.string().datetime(),
              status: z.literal('completed'),
              counterparty: z.object({ handle: z.string() }).nullable(),
              spaceName: z.string().nullable(),
              note: z.string().optional(),
              reference: z.string().optional(),
            }),
          ),
          nextCursor: z.string().nullable(),
        }),
      )
      .query(async ({ ctx, input }) => {
        try {
          const page = await bank.activity.list(ctx.principal.userId, {
            ...input,
            kind: ['transfer_in', 'transfer_out', 'space_move'],
          });
          return {
            items: page.items.map((item) => ({
              id: item.id,
              txId: item.txId,
              kind: item.kind as 'transfer_in' | 'transfer_out' | 'space_move',
              direction: item.direction,
              asset: item.asset,
              amount: item.amount,
              postedAt: item.postedAt,
              status: 'completed' as const,
              counterparty: item.counterparty,
              spaceName: item.spaceName,
              ...(item.note ? { note: item.note } : {}),
              ...(item.reference ? { reference: item.reference } : {}),
            })),
            nextCursor: page.nextCursor,
          };
        } catch (err) {
          activityFailure(err);
        }
      }),

    /**
     * `transferId` is supplied by the client so a retried request is the same
     * transfer, not a second one (§5: idempotency keys are business keys).
     */
    create: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          transferId: z.string().min(8).max(64),
          fromSpaceId: z.string().uuid(),
          toSpaceId: z.string().uuid(),
          amount: amountString,
          note: z
            .string()
            .min(1)
            .max(140)
            .refine((value) => !/[\u0000-\u001F]/.test(value), 'note has a control character')
            .optional(),
          reference: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[\x20-\x7E]+$/)
            .optional(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(z.object({ ledgerTxId: z.string(), amount: amountString }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const from = await bank.spaces.get(input.fromSpaceId);

          /**
           * ONLY THE `from` SIDE IS OWNER-CHECKED, AND THAT IS DELIBERATE.
           *
           * A transfer takes value out of `from` and puts it into `to`. The
           * side that can lose something is the debit, and it is checked here,
           * so this is not a hole: nobody can move money out of an account that
           * is not theirs.
           *
           * The credit side is NOT checked because paying somebody else is the
           * product. `bank-service.test.ts` pins that a transfer "moves value
           * between two different users spaces", and a check here would delete
           * that feature rather than secure it. An operation naming two objects
           * authorises against both OR carries a written reason for the
           * exemption at the call site; this paragraph is that reason, and it
           * exists so the next reader does not have to work out from an absence
           * whether the omission was a decision or an oversight.
           *
           * What the missing check DID cost was disclosure, not safety — see
           * `gateDestination`, which is the half that was actually missing.
           */
          assertSelf(ctx.principal.userId, from.userId);

          // Money to somebody else's space needs a step-up. A move between the caller's OWN spaces never
          // does. An unknown destination is treated as foreign, so this cannot tell a stranger which ids exist.
          if (stepUpEnforced) {
            const to = await bank.spaces.find(input.toSpaceId);
            if (to === null || to.userId !== ctx.principal.userId) {
              await requireStepUp(
                ctx.principal,
                createTransferBinding({
                  actor: ctx.principal.userId,
                  transferId: input.transferId,
                  fromSpaceId: input.fromSpaceId,
                  toSpaceId: input.toSpaceId,
                  assetId: from.assetId,
                  amount: input.amount,
                  note: input.note,
                  reference: input.reference,
                }),
                input.stepUpApprovalId,
              );
            }
          }

          const gate = await gateDestination(bank, ctx.principal.userId, from, input.toSpaceId);

          const result = await bank.transfers
            .transfer({
              transferId: input.transferId,
              fromSpaceId: input.fromSpaceId,
              toSpaceId: input.toSpaceId,
              amount: parseAmount(input.amount),
              note: input.note ?? null,
              reference: input.reference ?? null,
            })
            .catch(async (err: unknown) => {
              const shown = gate.mayDescribe ? err : hideDestinationDetail(err);
              // RC-wallet-09: the debit side is the caller's own space (assertSelf above), so these are the caller's own figures.
              throw await bank.spendFigures.refusal(shown, ctx.principal.userId, from.assetId);
            });
          return { ledgerTxId: result.ledgerTxId, amount: result.amount };
        }),
      ),

    toUser: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          transferId: z.string().min(8).max(64),
          fromSpaceId: z.string().uuid(),
          toUserId: z.string().min(1).max(64),
          amount: amountString,
          /** Recipient-visible plain text. Omitted means no note. */
          note: z.string().max(140).optional(),
          /** Printable payment reference. Omitted means none. */
          reference: z.string().max(64).optional(),
          /** Settles this open payment request. One payment, one request. */
          requestId: z.string().uuid().optional(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(
        z.object({
          ledgerTxId: z.string(),
          amount: amountString,
          note: z.string().nullable(),
          reference: z.string().nullable(),
          requestId: z.string().uuid().nullable(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const from = await bank.spaces.get(input.fromSpaceId);
          assertSelf(ctx.principal.userId, from.userId);
          const note = plainNote(input.note) ?? undefined;
          const reference = plainReference(input.reference) ?? undefined;
          if (stepUpEnforced && input.toUserId !== ctx.principal.userId) {
            await requireStepUp(
              ctx.principal,
              toUserBinding({
                actor: ctx.principal.userId,
                transferId: input.transferId,
                fromSpaceId: input.fromSpaceId,
                toUserId: input.toUserId,
                assetId: from.assetId,
                amount: input.amount,
                ...(note ? { note } : {}),
                ...(reference ? { reference } : {}),
                ...(input.requestId ? { requestId: input.requestId } : {}),
              }),
              input.stepUpApprovalId,
            );
          }
          const result = await bank.personalPay.send({
            actorUserId: ctx.principal.userId,
            transferId: input.transferId,
            fromSpaceId: input.fromSpaceId,
            toUserId: input.toUserId,
            amount: parseAmount(input.amount),
            note,
            reference,
            requestId: input.requestId ?? null,
          });
          return {
            ledgerTxId: result.ledgerTxId,
            amount: result.amount,
            note: result.note,
            reference: result.reference,
            requestId: result.requestId,
          };
        }),
      ),

    /** Receipt for one personal send. Parties only. A stranger gets the same not-found as a missing id. */
    get: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ ledgerTxId: z.string().min(1).max(128) }))
      .output(
        z.object({
          ledgerTxId: z.string(),
          transferId: z.string(),
          createdAt: z.string().datetime(),
          fromHandle: z.string().nullable(),
          toHandle: z.string().nullable(),
          handlesBlocker: z.string().nullable(),
          fee: z.null(),
          status: z.literal('posted'),
          amount: amountString,
          assetId: z.string(),
          note: z.string().nullable(),
          reference: z.string().nullable(),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const row = await bank.personalPay.get(ctx.principal.userId, input.ledgerTxId);
          return {
            ledgerTxId: row.ledgerTxId,
            transferId: row.transferId,
            createdAt: row.createdAt,
            fromHandle: row.fromHandle,
            toHandle: row.toHandle,
            handlesBlocker: row.handlesBlocker,
            fee: row.fee,
            status: row.status,
            amount: row.amount,
            assetId: row.assetId,
            note: row.note,
            reference: row.reference,
          };
        }),
      ),

    /**
     * Limits and fee for a personal send, before the review step.
     * Refuses when nothing is published. Never fills a zero fee or a default cap.
     */
    quote: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ assetId: z.string().min(1).max(16), amount: amountString }))
      .output(
        z.object({
          assetId: z.string(),
          amount: amountString,
          perTransferLimit: amountString,
          dailyLimit: amountString,
          spentToday: amountString,
          fee: amountString,
          feeBlocker: z.string().nullable(),
          withinPerTransfer: z.boolean(),
          withinDaily: z.boolean(),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => bank.personalPay.quote(ctx.principal.userId, input.assetId, parseAmount(input.amount))),
      ),

    scheduleToUser: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          fromSpaceId: z.string().uuid(),
          toUserId: z.string().min(1).max(64),
          amount: amountString,
          cadence: z.enum(['daily', 'weekly', 'monthly']),
          startsAt: z.string().datetime({ offset: true }),
          endsAt: z.string().datetime({ offset: true }).optional(),
          scheduleId: z.string().uuid(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(z.object({ id: z.string(), nextRunAt: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const from = await bank.spaces.get(input.fromSpaceId);
          assertSelf(ctx.principal.userId, from.userId);
          // Approval happens at creation. The order's amount and payee are immutable afterwards and it runs
          // without a session, so execution, pause and resume need none (cancel and pause are protective).
          if (stepUpEnforced && input.toUserId !== ctx.principal.userId) {
            await requireStepUp(
              ctx.principal,
              scheduleToUserBinding({
                actor: ctx.principal.userId,
                scheduleId: input.scheduleId,
                fromSpaceId: input.fromSpaceId,
                toUserId: input.toUserId,
                assetId: from.assetId,
                amount: input.amount,
                cadence: input.cadence,
                startsAt: input.startsAt,
                endsAt: input.endsAt,
              }),
              input.stepUpApprovalId,
            );
          }
          const schedule = await bank.transfers.scheduleToUser({
            userId: ctx.principal.userId,
            fromSpaceId: input.fromSpaceId,
            toUserId: input.toUserId,
            amount: parseAmount(input.amount),
            cadence: input.cadence,
            startsAt: new Date(input.startsAt),
            endsAt: input.endsAt ? new Date(input.endsAt) : null,
            scheduleId: input.scheduleId,
          });
          return { id: schedule.id, nextRunAt: schedule.nextRunAt.toISOString() };
        }),
      ),

    schedule: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          fromSpaceId: z.string().uuid(),
          toSpaceId: z.string().uuid(),
          amount: amountString,
          cadence: z.enum(['daily', 'weekly', 'monthly']),
          startsAt: z.string().datetime({ offset: true }),
          endsAt: z.string().datetime({ offset: true }).optional(),
          scheduleId: z.string().uuid(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(z.object({ id: z.string(), nextRunAt: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const from = await bank.spaces.get(input.fromSpaceId);
          // Same exemption, same reason as `transfers.create` above: the debit
          // side is the side that can lose value, and a standing order to
          // another user is the same product feature on a timer.
          assertSelf(ctx.principal.userId, from.userId);

          // A standing order to another person is approved at creation; an unknown destination counts as foreign.
          if (stepUpEnforced) {
            const to = await bank.spaces.find(input.toSpaceId);
            if (to === null || to.userId !== ctx.principal.userId) {
              await requireStepUp(
                ctx.principal,
                scheduleBinding({
                  actor: ctx.principal.userId,
                  scheduleId: input.scheduleId,
                  fromSpaceId: input.fromSpaceId,
                  toSpaceId: input.toSpaceId,
                  assetId: from.assetId,
                  amount: input.amount,
                  cadence: input.cadence,
                  startsAt: input.startsAt,
                  endsAt: input.endsAt,
                }),
                input.stepUpApprovalId,
              );
            }
          }

          // Same gate too, and it matters MORE here. A one-off transfer asks the
          // question once; a standing order that could be created against a
          // stranger's space and then have its asset mismatch reported back
          // turns the oracle into one a caller can leave running.
          const gate = await gateDestination(bank, ctx.principal.userId, from, input.toSpaceId);

          const schedule = await bank.transfers
            .schedule({
              userId: ctx.principal.userId,
              fromSpaceId: input.fromSpaceId,
              toSpaceId: input.toSpaceId,
              amount: parseAmount(input.amount),
              cadence: input.cadence,
              startsAt: new Date(input.startsAt),
              endsAt: input.endsAt ? new Date(input.endsAt) : null,
              scheduleId: input.scheduleId,
            })
            .catch((err: unknown) => {
              throw gate.mayDescribe ? err : hideDestinationDetail(err);
            });
          return { id: schedule.id, nextRunAt: schedule.nextRunAt.toISOString() };
        }),
      ),

    listSchedules: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.schedules_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            assetId: z.string(),
            amount: amountString,
            cadence: z.string(),
            nextRunAt: z.string(),
            status: z.string(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const schedules = await bank.transfers.listSchedules(ctx.principal.userId, input?.limit);
          return schedules.map((s) => ({
            id: s.id,
            assetId: s.assetId,
            amount: formatAmount(s.amount),
            cadence: s.cadence,
            nextRunAt: s.nextRunAt.toISOString(),
            status: s.status,
          }));
        }),
      ),

    /** What actually ran, and why anything did not. The user's answer to "where is my rent". */
    executions: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          scheduleId: z.string().uuid(),
          /**
           * Page size. Optional so omit reaches `bank.executions_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(
        z.array(
          z.object({
            occurrence: z.number().int(),
            amount: amountString,
            status: z.string(),
            ledgerTxId: z.string().nullable(),
            rejectionCode: z.string().nullable(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          // `bank:read` answers "may this principal read bank data". It never
          // answered "whose", and without the next two lines this returned
          // another user's transfer history, amounts and rejection codes
          // included, to anyone holding the scope and a schedule id.
          const schedule = await bank.transfers.getSchedule(input.scheduleId);
          assertSelf(ctx.principal.userId, schedule.userId);
          return bank.transfers.executions(input.scheduleId, input.limit);
        }),
      ),

    cancel: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ scheduleId: z.string().uuid() }))
      .output(z.object({ cancelled: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          // The ownership check runs BEFORE the cancel, not as a filter on its
          // result: `cancelSchedule` is an UPDATE, and a check made afterwards
          // would refuse a caller whose write had already landed.
          const schedule = await bank.transfers.getSchedule(input.scheduleId);
          assertSelf(ctx.principal.userId, schedule.userId);
          await bank.transfers.cancelSchedule(input.scheduleId);
          return { cancelled: true as const };
        }),
      ),

    /**
     * Hold a standing order. The reversible half of `cancel`.
     *
     * Same ownership ordering as `cancel`, for the same reason written there.
     */
    pause: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ scheduleId: z.string().uuid() }))
      .output(z.object({ status: z.string(), nextRunAt: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const schedule = await bank.transfers.getSchedule(input.scheduleId);
          assertSelf(ctx.principal.userId, schedule.userId);
          const paused = await bank.transfers.pauseSchedule(input.scheduleId);
          return { status: paused.status, nextRunAt: paused.nextRunAt.toISOString() };
        }),
      ),

    /**
     * Start a paused standing order again.
     *
     * `skipped` is in the OUTPUT, not just the record, because resuming does not
     * settle up. A client that renders `status: 'active'` and nothing else lets a
     * user believe the missed months are still coming; they are not, and the
     * moment to say so is the moment they ask for it. See `resumeSchedule` for
     * why skipping is the safe direction.
     */
    resume: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ scheduleId: z.string().uuid() }))
      .output(
        z.object({
          status: z.string(),
          nextRunAt: z.string(),
          /** Occurrences that came due while paused and will never fire. */
          skipped: z.array(z.number().int()),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const schedule = await bank.transfers.getSchedule(input.scheduleId);
          assertSelf(ctx.principal.userId, schedule.userId);
          const report = await bank.transfers.resumeSchedule(input.scheduleId);
          return {
            status: report.schedule.status,
            nextRunAt: report.schedule.nextRunAt.toISOString(),
            skipped: [...report.skipped],
          };
        }),
      ),
  });

  const earn = router({
    pools: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16).optional(),
          /**
           * Page size. Optional so omit reaches `bank.earn_pools_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            assetId: z.string(),
            kind: z.enum(['flexible', 'fixed']),
            name: z.string(),
            aprBps: z.number().int(),
            termDays: z.number().int().nullable(),
            minDeposit: amountString,
          }),
        ),
      )
      .query(async ({ input }) =>
        guard(async () => {
          const pools = await bank.earn.listPools(input.assetId, input.limit);
          return pools.map((p) => ({
            id: p.id,
            assetId: p.assetId,
            kind: p.kind,
            name: p.name,
            aprBps: p.aprBps,
            termDays: p.termDays,
            minDeposit: formatAmount(p.minDeposit),
          }));
        }),
      ),

    deposit: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ poolId: z.string().uuid(), amount: amountString, positionId: z.string().uuid() }))
      .output(z.object({ positionId: z.string(), maturesAt: z.string().nullable() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const position = await bank.earn.deposit({
            poolId: input.poolId,
            userId: ctx.principal.userId,
            amount: parseAmount(input.amount),
            positionId: input.positionId,
          });
          return { positionId: position.id, maturesAt: position.maturesAt?.toISOString() ?? null };
        }),
      ),

    withdraw: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ positionId: z.string().uuid() }))
      .output(z.object({ positionId: z.string(), principal: amountString }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const existing = await bank.earn.position(input.positionId);
          assertSelf(ctx.principal.userId, existing.userId);
          const closed = await bank.earn.withdraw(input.positionId);
          return { positionId: closed.id, principal: formatAmount(closed.principal) };
        }),
      ),

    positions: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.earn_positions_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            poolId: z.string(),
            assetId: z.string(),
            principal: amountString,
            maturesAt: z.string().nullable(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const positions = await bank.earn.positionsOf(ctx.principal.userId, input?.limit);
          return positions.map((p) => ({
            id: p.id,
            poolId: p.poolId,
            assetId: p.assetId,
            principal: formatAmount(p.principal),
            maturesAt: p.maturesAt?.toISOString() ?? null,
          }));
        }),
      ),
  });

  const analytics = router({
    spend: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          from: z.string().datetime({ offset: true }),
          to: z.string().datetime({ offset: true }),
        }),
      )
      .output(
        z.object({
          assetId: z.string(),
          from: z.string(),
          to: z.string(),
          outflowByCategory: z.record(z.string()),
          totalOutflow: z.string(),
          totalInflow: z.string(),
          net: z.string(),
          movements: z.number().int(),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const summary = await bank.analytics.spendSummary({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            range: { from: new Date(input.from), to: new Date(input.to) },
          });
          return {
            assetId: summary.assetId,
            from: summary.from,
            to: summary.to,
            outflowByCategory: summary.outflowByCategory,
            totalOutflow: summary.totalOutflow,
            totalInflow: summary.totalInflow,
            net: summary.net,
            movements: summary.movements,
          };
        }),
      ),
  });

  /**
   * PORTFOLIO (UI-SPEC §1.2, U3) — the one server-computed "Est. total value".
   *
   * Self-only: the owner is `ctx.principal.userId`, there is no input to name
   * anyone else. The rule (stablecoins at $1, last price of asset/USDT else
   * asset/USDC, `unpriced` otherwise, change as a price move on current holdings
   * and not P&L) is written once in `portfolio/valuation.ts`.
   */
  const portfolio = router({
    summary: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          // Not strict: a smuggled owner id is stripped here, as it always was (portfolio.router.test.ts).
          .object({
            assetId: z.string().min(1).max(16).optional(),
            valueIn: z.enum(['usd', 'btc']).optional(),
            /** The customer's display currency (PF-overview-03). USD and BTC only; any other code refuses `bank.fx_rate_unset`. */
            displayCurrency: z.string().min(2).max(8).optional(),
            /** `combined` (default), `main`, or the id of one of the caller's named spaces. */
            scope: z.string().min(1).max(64).optional(),
          })
          .optional(),
      )
      .output(portfolioSummaryOutput)
      .query(async ({ ctx, input }) => guard(async () => bank.portfolio.summary(ctx.principal.userId, input ?? {}))),
    /** The priced holdings by asset class and by available / locked (PF-balances-02). Same prices and refusals as `summary`. */
    allocation: scopedProcedure('bank:read', { module: 'bank' })
      .output(allocationOutput)
      .query(async ({ ctx }) => guard(async () => bank.portfolio.allocation(ctx.principal.userId))),
    /** The wallet selector: `main` and each named Space the caller can narrow `balanceBreakdown` to. */
    balanceAccounts: scopedProcedure('bank:read', { module: 'bank' })
      .output(balanceAccountsOutput)
      .query(async ({ ctx }) => guard(async () => bank.portfolio.accounts(ctx.principal.userId))),
    /**
     * Each asset split into spendable and every lock kind with the claim behind it (PF-balances-01). Read-only, self-only,
     * ledger reads only; the parts add up to the total exactly.
     */
    balanceBreakdown: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            scope: z.enum(['all', 'main']).optional(),
            /** `main` or the id of one named Space. Wins over `scope`. */
            accountId: z.union([z.literal('main'), z.string().uuid()]).optional(),
            assetId: z.string().min(1).max(16).optional(),
          })
          .strict()
          .optional(),
      )
      .output(balanceBreakdownOutput)
      .query(async ({ ctx, input }) =>
        guard(async () =>
          bank.portfolio.balanceBreakdown(ctx.principal.userId, input?.scope ?? 'all', {
            ...(input?.accountId === undefined ? {} : { accountId: input.accountId }),
            ...(input?.assetId === undefined ? {} : { assetId: input.assetId }),
          }),
        ),
      ),
    /**
     * Every ledger entry behind one asset's spendable balance, with the sum check on top (PF-balances-01). Read-only,
     * self-only. A sum that differs from the live balance refuses `portfolio.entries_do_not_sum` with the gap.
     */
    balanceEntries: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            assetId: z.string().min(1).max(16),
            /** `main` or the id of one named Space; absent = main and every Space. */
            accountId: z.union([z.literal('main'), z.string().uuid()]).optional(),
            cursor: z.string().min(1).max(16).optional(),
            limit: z.number().int().min(1).max(BALANCE_ENTRIES_MAX_LIMIT).default(BALANCE_ENTRIES_DEFAULT_LIMIT),
          })
          .strict(),
      )
      .output(balanceEntriesOutput)
      .query(async ({ ctx, input }) => {
        try {
          return await bank.portfolio.balanceEntries(ctx.principal.userId, {
            assetId: input.assetId,
            ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            limit: input.limit,
          });
        } catch (err) {
          return activityFailure(err);
        }
      }),
  });

  /**
   * LOANS (§8.1).
   *
   * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
   *
   * There is no user-callable `liquidate`, and no user-callable `mark`. Both are
   * operator surface, in `ops`, for the same reason the standing-order runner and
   * the accrual are: a user who can choose WHEN a mark is taken is a user who can
   * choose the price their own — or somebody else's — collateral is valued at.
   * The whole point of the deviation breaker and the staleness window in
   * `prices.ts` is that the mark is not the caller's to pick.
   *
   * Settled release stays all-or-nothing on `close`. Partial release of excess
   * (`releaseExcess`) is the exception: it asks for a mark and refuses
   * `bank.ltv_exceeded` if the remainder would sit above the product cap. A
   * missing mark refuses before any post. No invented rate.
   */
  const loans = router({
    products: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16).optional(),
          /**
           * Page size. Optional so omit reaches `bank.loan_products_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            debtAssetId: z.string(),
            collateralAssetId: z.string(),
            quoteAssetId: z.string(),
            aprBps: z.number().int(),
            maxLtvBps: z.number().int(),
            marginCallLtvBps: z.number().int(),
            liquidationLtvBps: z.number().int(),
            minPrincipal: amountString,
          }),
        ),
      )
      .query(async ({ input }) =>
        guard(async () => {
          const products = await bank.loans.listProducts(input.assetId, input.limit);
          return products.map((p) => ({
            id: p.id,
            name: p.name,
            debtAssetId: p.debtAssetId,
            collateralAssetId: p.collateralAssetId,
            quoteAssetId: p.quoteAssetId,
            aprBps: p.aprBps,
            maxLtvBps: p.maxLtvBps,
            // The two thresholds a borrower must be able to see BEFORE they
            // borrow. Publishing the liquidation level is not a courtesy: a
            // leveraged product whose liquidation price is discoverable only by
            // being liquidated is not a product anyone can manage.
            marginCallLtvBps: p.policy.marginCallLtvBps,
            liquidationLtvBps: p.policy.liquidationLtvBps,
            minPrincipal: formatAmount(p.minPrincipal),
          }));
        }),
      ),

    /**
     * `loanId` is supplied by the client so a retried request is the same loan,
     * not a second one (§5). A timeout on this call must not leave a borrower with
     * two leveraged positions against collateral they meant to pledge once.
     */
    open: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          loanId: z.string().uuid(),
          productId: z.string().uuid(),
          collateralAmount: amountString,
          principal: amountString,
        }),
      )
      .output(z.object({ loanId: z.string(), status: z.string(), ltvBps: z.number().int(), drawLedgerTxId: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const result = await bank.loans.open({
            loanId: input.loanId,
            productId: input.productId,
            userId: ctx.principal.userId,
            collateralAmount: parseAmount(input.collateralAmount),
            principal: parseAmount(input.principal),
          });
          return {
            loanId: result.loan.id,
            status: result.loan.status,
            ltvBps: result.ltvBps,
            drawLedgerTxId: result.drawLedgerTxId,
          };
        }),
      ),

    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.loans_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            productId: z.string(),
            debtAssetId: z.string(),
            collateralAssetId: z.string(),
            principal: amountString,
            outstandingPrincipal: amountString,
            outstandingInterest: amountString,
            collateral: amountString,
            aprBps: z.number().int(),
            status: z.string(),
            marginCalledAt: z.string().nullable(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.loans.loansOf(ctx.principal.userId, input?.limit);
          return Promise.all(
            rows.map(async (loan) => {
              const debt = await bank.loans.outstanding(loan.id);
              return {
                id: loan.id,
                productId: loan.productId,
                debtAssetId: loan.debtAssetId,
                collateralAssetId: loan.collateralAssetId,
                principal: formatAmount(loan.principal),
                // Derived at read time from write-once rows. There is no
                // `outstanding` column, and the schema comments say why.
                outstandingPrincipal: formatAmount(debt.principal),
                outstandingInterest: formatAmount(debt.interest),
                collateral: formatAmount(await bank.loans.collateralOf(loan)),
                aprBps: loan.aprBps,
                status: loan.status,
                marginCalledAt: loan.marginCalledAt?.toISOString() ?? null,
              };
            }),
          );
        }),
      ),

    /**
     * The borrower's own risk view.
     *
     * Read-only and portfolio-wide, so someone can see a margin call coming
     * rather than learning about it from the liquidation. It marks; it never acts.
     */
    health: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.object({
          debtValue: amountString,
          collateralValue: amountString,
          portfolioLtvBps: z.number().int(),
          loans: z.array(
            z.object({
              loanId: z.string(),
              debtValue: amountString,
              collateralValue: amountString,
              ltvBps: z.number().int(),
            }),
          ),
        }),
      )
      .query(async ({ ctx }) =>
        guard(async () => {
          const mark = await bank.loans.markUser(ctx.principal.userId);
          return {
            debtValue: formatAmount(mark.debtValue),
            collateralValue: formatAmount(mark.collateralValue),
            portfolioLtvBps: mark.portfolioLtvBps,
            loans: mark.loans.map((l) => ({
              loanId: l.loanId,
              debtValue: formatAmount(l.debtValue),
              collateralValue: formatAmount(l.collateralValue),
              ltvBps: l.ltvBps,
            })),
          };
        }),
      ),

    /**
     * `eventId` is the client retry key (§5). Required: omit used to allocate
     * MAX+1 and post a second loanCollateralLock. Same eventId + amount is one lock.
     */
    addCollateral: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ loanId: z.string().uuid(), eventId: z.string().uuid(), amount: amountString }))
      .output(z.object({ ledgerTxId: z.string(), sequence: z.number().int() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          return bank.loans.addCollateral({
            loanId: input.loanId,
            eventId: input.eventId,
            amount: parseAmount(input.amount),
          });
        }),
      ),

    /**
     * `eventId` is the client retry key (§5). Required: omit used to allocate
     * MAX+1 and post a second loanCollateralRelease. Same eventId + amount is
     * one release. Overlapping releases share the loan row lock, so they cannot
     * each pass the product cap.
     */
    /**
     * Redeem-excess read (BK-loan-05): the most collateral `releaseExcess` would
     * release now under the product's max LTV. Self-only. Posts nothing.
     */
    releasable: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ loanId: z.string().uuid() }))
      .output(
        z.object({
          loanId: z.string(),
          held: amountString,
          releasable: amountString,
          maxLtvBps: z.number().int(),
          ltvBps: z.number().int(),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          const read = await bank.loans.releasable(input.loanId);
          return {
            loanId: input.loanId,
            held: formatAmount(read.held),
            releasable: formatAmount(read.releasable),
            maxLtvBps: read.maxLtvBps,
            ltvBps: read.ltvBps,
          };
        }),
      ),

    releaseExcess: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ loanId: z.string().uuid(), eventId: z.string().uuid(), amount: amountString }))
      .output(z.object({ ledgerTxId: z.string(), sequence: z.number().int() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          return bank.loans.releaseExcess({
            loanId: input.loanId,
            eventId: input.eventId,
            amount: parseAmount(input.amount),
          });
        }),
      ),

    repay: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ loanId: z.string().uuid(), amount: amountString, eventId: z.string().uuid() }))
      .output(
        z.object({
          ledgerTxId: z.string(),
          interestPaid: amountString,
          principalPaid: amountString,
          remainingPrincipal: amountString,
          remainingInterest: amountString,
          closed: z.boolean(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          const result = await bank.loans.repay({
            loanId: input.loanId,
            amount: parseAmount(input.amount),
            eventId: input.eventId,
          });
          return {
            ledgerTxId: result.ledgerTxId,
            interestPaid: formatAmount(result.interestPaid),
            principalPaid: formatAmount(result.principalPaid),
            remainingPrincipal: formatAmount(result.remaining.principal),
            remainingInterest: formatAmount(result.remaining.interest),
            closed: result.closed,
          };
        }),
      ),

    /** Release collateral on a loan that owes nothing. Refuses otherwise. */
    close: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ loanId: z.string().uuid() }))
      .output(z.object({ released: amountString, ledgerTxId: z.string().nullable() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const loan = await bank.loans.loan(input.loanId);
          assertSelf(ctx.principal.userId, loan.userId);
          const result = await bank.loans.releaseSettled(input.loanId);
          return { released: formatAmount(result.released), ledgerTxId: result.ledgerTxId };
        }),
      ),
    // BK-loan-09: unsecured-loan servicing previews (typed Preview refusals) and the owner missed-payment policy.
    ...loanServicingPreviewProcedures(options.loanMissedPaymentPolicy),
  });

  /**
   * CARDS (§8.1) — the LEDGER half only.
   *
   * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
   *
   * There is no user-callable `authorize`, `capture` or `reverse`. Those three
   * are the ISSUER speaking, not the user, and they are in `ops` behind
   * `admin:treasury` for the same reason the risk sweep is: a user who can
   * decide their own authorisation is a user who can approve a purchase the
   * ledger would have declined, and a user who can trigger a capture can choose
   * when their own money leaves.
   *
   * On a live rail they do not become user procedures either. They become a
   * signed webhook endpoint owned by the issuer integration — which is
   * `socket.live-issuer`, a card-scheme sponsor and an issuing BIN, and is a
   * contract rather than code.
   *
   * ── EVERY SURFACE SAYS WHAT IT IS ──────────────────────────────────────────
   *
   * `simulated` is on the card output and it is not optional. A screen rendering
   * a card from this router cannot accidentally present it as a real one, and a
   * deployment with no issuer at all cannot get this far: it refuses with
   * `bank.no_card_issuer` before a row is written.
   */
  const cardOutput = z.object({
    id: z.string(),
    /** Which balance the card draws on. Every posting against it is in this asset. */
    assetId: z.string(),
    /**
     * What merchants charge this card in (§18).
     *
     * Equal to `assetId` means no conversion happens and no rate is consulted.
     * Different means every authorisation is quoted at the authorisation moment
     * — and refuses by name where no rate can be got, which on a fiat settlement
     * asset is every time, because this platform has no FX source.
     */
    settlementAssetId: z.string(),
    /** The programme id, which is also the ledger rail label. */
    issuer: z.string(),
    /** TRUE MEANS THERE IS NO CARD. Never omitted, never defaulted. */
    simulated: z.boolean(),
    /** Four digits. Not a card number and not part of one. */
    panTail: z.string(),
    status: z.enum(['active', 'frozen', 'closed']),
    cashbackBps: z.number().int(),
    perAuthorizationLimit: amountString,
    dailyLimit: amountString.nullable(),
    monthlyLimit: amountString.nullable(),
    cashLimit: amountString.nullable(),
    online: z.boolean(),
    contactless: z.boolean(),
    atm: z.boolean(),
    abroad: z.boolean(),
    cardType: z.enum(['virtual', 'physical']),
    shippingAddress: z
      .object({
        name: z.string(),
        line1: z.string(),
        line2: z.string().nullable(),
        city: z.string(),
        region: z.string().nullable(),
        postalCode: z.string(),
        country: z.string(),
      })
      .nullable(),
  });

  const shippingAddressInput = z.object({
    name: z.string().trim().min(1).max(120),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(120),
    region: z.string().trim().max(120).optional(),
    postalCode: z.string().trim().min(1).max(32),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/),
  });

  function presentCard(c: CardRecord) {
    return {
      id: c.id,
      assetId: c.assetId,
      settlementAssetId: c.settlementAssetId,
      issuer: c.issuer,
      simulated: c.simulated,
      panTail: c.panTail,
      status: c.status,
      cashbackBps: c.cashbackBps,
      perAuthorizationLimit: formatAmount(c.perAuthorizationLimit),
      dailyLimit: c.dailyLimit == null ? null : formatAmount(c.dailyLimit),
      monthlyLimit: c.monthlyLimit == null ? null : formatAmount(c.monthlyLimit),
      cashLimit: c.cashLimit == null ? null : formatAmount(c.cashLimit),
      online: c.online ?? true,
      contactless: c.contactless ?? true,
      atm: c.atm ?? true,
      abroad: c.abroad ?? true,
      cardType: c.cardType ?? 'virtual',
      shippingAddress: c.shippingAddress ?? null,
    };
  }

  function ceilingLoosens(current: bigint | null, next: bigint | null | undefined): boolean {
    if (next === undefined) return false;
    if (next === null) return current !== null;
    if (current === null) return false;
    return next > current;
  }

  function limitField(value: string | null | undefined): string {
    if (value === undefined) return '';
    if (value === null) return 'null';
    return value;
  }

  function shippingToken(address: z.infer<typeof shippingAddressInput> | undefined): string {
    if (!address) return '';
    return JSON.stringify({
      name: address.name.trim(),
      line1: address.line1.trim(),
      line2: address.line2?.trim() ?? '',
      city: address.city.trim(),
      region: address.region?.trim() ?? '',
      postalCode: address.postalCode.trim(),
      country: address.country.trim().toUpperCase(),
    });
  }

  const cards = router({
    /** What this deployment's card programme is — including that it is not one. */
    programme: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.object({ id: z.string(), simulated: z.boolean(), displayName: z.string() }))
      .query(async () => guard(async () => bank.cards.programme())),

    /**
     * Cashback already paid, in one asset, once a non-simulated issuer is connected.
     * card-sim and an unconfigured programme refuse `bank.rewards_issuer_unset`.
     * Nothing here posts a reward or invents a zero for a missing issuer.
     */
    rewards: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.object({ balance: amountString, asset: z.string(), simulated: z.literal(false) }))
      .query(({ ctx }) =>
        guard(async () => {
          const reward = await bank.cards.rewards(ctx.principal.userId);
          return { balance: formatAmount(reward.balance), asset: reward.assetId, simulated: false as const };
        }),
      ),

    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.cards_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(z.array(cardOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.cards.cardsOf(ctx.principal.userId, input?.limit);
          return rows.map((c) => presentCard(c));
        }),
      ),

    /**
     * `cardId` is supplied by the client so a retried request is the same card,
     * not a second one drawing on the same balance (§5).
     */
    issue: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().uuid(),
          assetId: z.string().min(1).max(16),
          /**
           * What merchants charge this card in. Omitted means the funding asset,
           * which is no conversion — the shape every card had before §18.
           *
           * A card may be issued with a settlement asset nothing can quote; the
           * refusal belongs on the authorisation, where the rate is needed, not
           * on a path that moves no money and could be refused by one transient
           * feed outage.
           */
          settlementAssetId: z.string().min(1).max(16).optional(),
          cashbackBps: z.number().int().min(0).max(10_000).optional(),
          perAuthorizationLimit: amountString,
          cardType: z.enum(['virtual', 'physical']).optional(),
          shippingAddress: shippingAddressInput.optional(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(cardOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              issueCardBinding({
                actor: ctx.principal.userId,
                cardId: input.cardId,
                assetId: input.assetId,
                settlementAssetId: input.settlementAssetId,
                cashbackBps: input.cashbackBps,
                perAuthorizationLimit: input.perAuthorizationLimit,
                cardType: input.cardType ?? 'virtual',
                shippingAddress: input.cardType === 'physical' ? shippingToken(input.shippingAddress) : '',
              }),
              input.stepUpApprovalId,
            );
          }
          const card = await bank.cards.issue({
            cardId: input.cardId,
            userId: ctx.principal.userId,
            assetId: input.assetId,
            ...(input.settlementAssetId === undefined ? {} : { settlementAssetId: input.settlementAssetId }),
            ...(input.cashbackBps === undefined ? {} : { cashbackBps: input.cashbackBps }),
            perAuthorizationLimit: parseAmount(input.perAuthorizationLimit),
            ...(input.cardType === undefined ? {} : { cardType: input.cardType }),
            ...(input.shippingAddress === undefined
              ? {}
              : {
                  shippingAddress: {
                    name: input.shippingAddress.name,
                    line1: input.shippingAddress.line1,
                    line2: input.shippingAddress.line2 ?? null,
                    city: input.shippingAddress.city,
                    region: input.shippingAddress.region ?? null,
                    postalCode: input.shippingAddress.postalCode,
                    country: input.shippingAddress.country,
                  },
                }),
          });
          return presentCard(card);
        }),
      ),

    /**
     * Freeze, unfreeze or close. The gesture a user reaches for first when
     * something is wrong, so it is user surface and not an operator ticket.
     */
    setStatus: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ cardId: z.string().uuid(), status: z.enum(['active', 'frozen', 'closed']), stepUpApprovalId: stepUpApprovalField }))
      .output(z.object({ id: z.string(), status: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          // Only UNFREEZING loosens a safeguard. Freeze and close are protective and never prompt; asking
          // for `active` on a card that already is changes nothing. One approval re-applies nothing: no replay.
          if (stepUpEnforced && input.status === 'active' && card.status !== 'active') {
            await requireStepUp(
              ctx.principal,
              unfreezeCardBinding({ actor: ctx.principal.userId, cardId: input.cardId, fromStatus: card.status }),
              input.stepUpApprovalId,
              false,
            );
          }
          const updated = await bank.cards.setStatus(input.cardId, input.status);
          return { id: updated.id, status: updated.status };
        }),
      ),

    /**
     * Spending ceilings. Step-up only when a ceiling is raised or removed.
     * Tightening does not prompt. `commandId` retries the same change.
     */
    setLimits: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().uuid(),
          commandId: z.string().uuid(),
          perAuthorizationLimit: amountString,
          dailyLimit: amountString.nullable().optional(),
          monthlyLimit: amountString.nullable().optional(),
          cashLimit: amountString.nullable().optional(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(cardOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          const per = parseAmount(input.perAuthorizationLimit);
          const daily = input.dailyLimit === undefined ? undefined : input.dailyLimit === null ? null : parseAmount(input.dailyLimit);
          const monthly =
            input.monthlyLimit === undefined ? undefined : input.monthlyLimit === null ? null : parseAmount(input.monthlyLimit);
          const cash = input.cashLimit === undefined ? undefined : input.cashLimit === null ? null : parseAmount(input.cashLimit);
          const loosens =
            per > card.perAuthorizationLimit ||
            ceilingLoosens(card.dailyLimit, daily) ||
            ceilingLoosens(card.monthlyLimit, monthly) ||
            ceilingLoosens(card.cashLimit, cash);
          if (stepUpEnforced && loosens) {
            await requireStepUp(
              ctx.principal,
              setCardLimitsBinding({
                actor: ctx.principal.userId,
                cardId: input.cardId,
                commandId: input.commandId,
                perAuthorizationLimit: input.perAuthorizationLimit,
                dailyLimit: limitField(input.dailyLimit),
                monthlyLimit: limitField(input.monthlyLimit),
                cashLimit: limitField(input.cashLimit),
              }),
              input.stepUpApprovalId,
            );
          }
          const updated = await bank.cards.setLimits({
            cardId: input.cardId,
            userId: ctx.principal.userId,
            commandId: input.commandId,
            perAuthorizationLimit: per,
            ...(daily === undefined ? {} : { dailyLimit: daily }),
            ...(monthly === undefined ? {} : { monthlyLimit: monthly }),
            ...(cash === undefined ? {} : { cashLimit: cash }),
          });
          return presentCard(updated);
        }),
      ),

    /** Online, contactless, ATM and abroad. `commandId` retries the same four flags. */
    setChannels: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().uuid(),
          commandId: z.string().uuid(),
          online: z.boolean(),
          contactless: z.boolean(),
          atm: z.boolean(),
          abroad: z.boolean(),
        }),
      )
      .output(cardOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          const updated = await bank.cards.setChannels({
            cardId: input.cardId,
            userId: ctx.principal.userId,
            commandId: input.commandId,
            online: input.online,
            contactless: input.contactless,
            atm: input.atm,
            abroad: input.abroad,
          });
          return presentCard(updated);
        }),
      ),

    /**
     * PAN, expiry and CVV from a live issuer. Step-up every time. Not stored.
     * card-sim refuses `bank.card_pan_issuer_unset` before step-up. With step-up
     * not `required`, the call refuses `bank.step_up_unavailable` and the issuer is not called.
     */
    reveal: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ cardId: z.string().uuid(), revealId: z.string().uuid(), stepUpApprovalId: stepUpApprovalField }))
      .output(z.object({ pan: z.string(), expiry: z.string(), cvv: z.string(), expiresAt: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          bank.cards.assertSecretIssuer('pan', 'revealCredentials');
          if (!stepUpEnforced) refuseCardSecretWithoutStepUp();
          await requireStepUp(
            ctx.principal,
            revealCardBinding({ actor: ctx.principal.userId, cardId: input.cardId, revealId: input.revealId }),
            input.stepUpApprovalId,
            false,
          );
          return bank.cards.reveal({ cardId: input.cardId, userId: ctx.principal.userId, revealId: input.revealId });
        }),
      ),

    pin: router({
      reveal: scopedProcedure('bank:read', { module: 'bank' })
        .input(z.object({ cardId: z.string().uuid(), revealId: z.string().uuid(), stepUpApprovalId: stepUpApprovalField }))
        .output(z.object({ pin: z.string(), expiresAt: z.string() }))
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const card = await bank.cards.card(input.cardId);
            assertSelf(ctx.principal.userId, card.userId);
            bank.cards.assertSecretIssuer('pin', 'revealPin');
            if (!stepUpEnforced) refuseCardSecretWithoutStepUp();
            await requireStepUp(
              ctx.principal,
              revealCardPinBinding({ actor: ctx.principal.userId, cardId: input.cardId, revealId: input.revealId }),
              input.stepUpApprovalId,
              false,
            );
            return bank.cards.revealPin({ cardId: input.cardId, userId: ctx.principal.userId, revealId: input.revealId });
          }),
        ),
      set: scopedProcedure('bank:write', { module: 'bank' })
        .input(
          z.object({
            cardId: z.string().uuid(),
            commandId: z.string().uuid(),
            pin: z.string().min(1).max(64),
            stepUpApprovalId: stepUpApprovalField,
          }),
        )
        .output(z.object({ ok: z.literal(true) }))
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const card = await bank.cards.card(input.cardId);
            assertSelf(ctx.principal.userId, card.userId);
            bank.cards.assertPinDigits(input.pin);
            bank.cards.assertSecretIssuer('pin', 'setPin');
            if (!stepUpEnforced) refuseCardSecretWithoutStepUp();
            await requireStepUp(
              ctx.principal,
              setCardPinBinding({ actor: ctx.principal.userId, cardId: input.cardId, commandId: input.commandId }),
              input.stepUpApprovalId,
            );
            return bank.cards.setPin({
              cardId: input.cardId,
              userId: ctx.principal.userId,
              commandId: input.commandId,
              pin: input.pin,
            });
          }),
        ),
    }),

    /** Opaque push-provisioning payload. Refuses until socket.live-issuer can produce one. */
    walletProvision: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().uuid(),
          provisionId: z.string().uuid(),
          wallet: z.enum(['apple', 'google']),
          nonce: z.string().min(1).max(4096),
        }),
      )
      .output(z.object({ payload: z.string(), expiresAt: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          return bank.cards.walletProvision({
            cardId: input.cardId,
            userId: ctx.principal.userId,
            provisionId: input.provisionId,
            wallet: input.wallet,
            nonce: input.nonce,
          });
        }),
      ),

    /**
     * Close this card and issue another with the same asset, ceilings and channels.
     * `replacementId` is the idempotency key.
     */
    replace: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().uuid(),
          replacementId: z.string().uuid(),
          reason: z.enum(['lost', 'stolen', 'damaged']),
        }),
      )
      .output(cardOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          const replaced = await bank.cards.replace({
            cardId: input.cardId,
            userId: ctx.principal.userId,
            replacementId: input.replacementId,
            reason: input.reason,
          });
          return presentCard(replaced);
        }),
      ),

    /**
     * Every decision taken on this card, approvals and declines alike.
     *
     * The declines are the point. "Why was I declined at the till" is the
     * question a card generates, and a history that only listed successful
     * purchases could not answer it.
     */
    authorizations: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().uuid(),
          /**
           * Page size. Optional so omit reaches `bank.card_authorizations_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            authorizationRef: z.string(),
            /** WHAT MOVED, in the card's funding asset. */
            amount: amountString,
            merchantCategory: z.string().nullable(),
            channel: z.enum(['card-present', 'online', 'contactless', 'atm', 'foreign']),
            decision: z.enum(['approved', 'declined']),
            declineCode: z.string().nullable(),
            status: z.string(),
            decidedAt: z.string(),
            /**
             * WHAT THE MERCHANT CHARGED, and the rate it converted at (§18).
             *
             * NULL where the card is charged in the asset it draws on — nothing
             * was converted, and rendering a rate of 1 would invent a
             * conversion that did not happen. Where it is present, the statement
             * can show the user the price they agreed at the till alongside the
             * units that actually left their balance, which is the pair a
             * converted spend is unreadable without.
             */
            conversion: z
              .object({
                settlementAssetId: z.string(),
                settlementAmount: amountString,
                rate: amountString,
                /** How the rate was derived — `MarkQuality` from the loan book. */
                rateQuality: z.string(),
                rateAsOf: z.string(),
              })
              .nullable(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          // `bank:read` answers "may this principal read bank data". It never
          // answered "whose" — same guard, same reason, as `transfers.executions`.
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          const rows = await bank.cards.authorizationsOf(input.cardId, input.limit);
          return rows.map((a) => ({
            id: a.id,
            authorizationRef: a.authorizationRef,
            amount: formatAmount(a.amount),
            merchantCategory: a.merchantCategory,
            channel: a.channel,
            decision: a.decision,
            declineCode: a.declineCode,
            status: a.status,
            decidedAt: a.decidedAt.toISOString(),
            conversion: a.conversion
              ? {
                  settlementAssetId: a.conversion.settlementAssetId,
                  settlementAmount: formatAmount(a.conversion.settlementAmount),
                  rate: formatAmount(a.conversion.rate),
                  rateQuality: a.conversion.quality,
                  rateAsOf: a.conversion.rateAsOf.toISOString(),
                }
              : null,
          }));
        }),
      ),
  });

  /**
   * Operator surface. Job twins of POST /internal/jobs/* are HMAC as svc-bank
   * (`jobProcedure`). Treasury-session mutations that move value (fund, seize,
   * card, ramp) stay `admin:treasury` — MFA via INTERACTIVE_ONLY plus identity
   * HMAC consume. Typed-in `confirmOperatorId` is not authority. HMAC jobs are
   * not this door. Bank maker-checker is not this door.
   */
  const ops = router({
    /**
     * BK-cops-09 fraud preview (/bank-ops/cards/fraud). TEST rows only, labelled
     * and blurred; no authorisation carries a score until an engine exists.
     */
    fraudPreview: scopedProcedure('admin:treasury')
      .output(
        z.object({
          label: z.literal('Preview · sample data'),
          engine: z.string(),
          preview: z.literal(true),
          blurred: z.literal(true),
          stances: z.array(z.enum(FRAUD_BLOCK_STANCES)),
          automaticBlocking: z.literal('unavailable'),
          rows: z.array(
            z.object({
              testAuthorisationRef: z.string().startsWith('TEST-'),
              test: z.literal(true),
              band: z.enum(FRAUD_RISK_BANDS),
              signals: z.array(z.enum(FRAUD_SIGNALS)),
            }),
          ),
        }),
      )
      .query(() => {
        const view = fraudPreview();
        return { ...view, stances: [...view.stances], rows: view.rows.map((r) => ({ ...r, signals: [...r.signals] })) };
      }),
    /** Every engine action on the fraud preview returns the typed Preview refusal and changes nothing. */
    fraudPreviewAction: scopedProcedure('admin:treasury')
      .input(z.object({ action: z.enum(FRAUD_PREVIEW_ACTIONS) }))
      .output(
        z.object({ kind: z.literal('preview'), engine: z.string(), action: z.enum(FRAUD_PREVIEW_ACTIONS), changed: z.literal(false) }),
      )
      .mutation(({ input }) => refuseFraudPreviewAction(input.action)),
    runDueTransfers: jobProcedure
      .input(z.object({ limit: z.number().int().min(1).max(10_000).optional() }))
      .output(
        z.object({
          schedulesConsidered: z.number().int(),
          settled: z.number().int(),
          rejected: z.number().int(),
          alreadyFired: z.number().int(),
          /** Schedules looked at only because a claim was left behind. An operator wants zero. */
          strandedSwept: z.number().int(),
          /** Schedules that threw mid-drive; occurrence not consumed; next pass retries. */
          failures: z.array(
            z.object({
              scheduleId: z.string(),
              reason: z.string(),
              code: z.string().optional(),
            }),
          ),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          // Parity with POST /internal/jobs/run-due-transfers: the flag is the
          // emergency stop for a mis-computed occurrence index. tRPC must not
          // be a back door past it.
          if (!scheduledTransfersEnabled) {
            throw new BankError('scheduled transfers are disabled', 'bank.transfers_disabled');
          }
          return bank.transfers.runDueTransfers({ limit: input.limit });
        }),
      ),

    /**
     * Fire due auto-invest rules (threshold sweeps always; DCA when convert is wired).
     * Kill-switch parity with HTTP `POST /internal/jobs/run-auto-invest`.
     */
    runAutoInvest: jobProcedure
      .input(z.object({ limit: z.number().int().min(1).max(10_000).optional() }))
      .output(
        z.object({
          considered: z.number().int(),
          settled: z.number().int(),
          skipped: z.number().int(),
          rejected: z.number().int(),
          failures: z.array(z.object({ ruleId: z.string(), code: z.string() })),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          if (!autoInvestEnabled) {
            throw new BankError('auto-invest is disabled', 'bank.auto_invest_disabled');
          }
          return bank.autoInvest.runDue({ limit: input.limit });
        }),
      ),

    accrueInterest: jobProcedure
      .input(z.object({ poolId: z.string().uuid().optional(), at: z.string().datetime({ offset: true }).optional() }))
      .output(
        z.object({
          results: z.array(
            z.object({
              poolId: z.string(),
              date: z.string(),
              paid: amountString,
              recipients: z.number().int(),
              alreadyAccrued: z.boolean(),
            }),
          ),
          /** Pools that threw (e.g. underfunded); day not consumed for those pools. */
          failures: z.array(
            z.object({
              poolId: z.string(),
              reason: z.string(),
              code: z.string().optional(),
            }),
          ),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          // Parity with POST /internal/jobs/accrue-interest.
          if (!interestAccrualEnabled) {
            throw new BankError('interest accrual is disabled', 'bank.interest_accrual_disabled');
          }
          const at = input.at ? new Date(input.at) : new Date();
          // Single-pool path stays loud: operator targeted that pool, so throw.
          if (input.poolId) {
            const r = await bank.earn.accrue({ poolId: input.poolId, at });
            return {
              results: [
                {
                  poolId: r.poolId,
                  date: r.date,
                  paid: formatAmount(r.paid),
                  recipients: r.recipients,
                  alreadyAccrued: r.alreadyAccrued,
                },
              ],
              failures: [],
            };
          }
          const report = await bank.earn.accrueAll(at);
          return {
            results: report.results.map((r) => ({
              poolId: r.poolId,
              date: r.date,
              paid: formatAmount(r.paid),
              recipients: r.recipients,
              alreadyAccrued: r.alreadyAccrued,
            })),
            failures: report.failures,
          };
        }),
      ),

    fundPool: scopedProcedure('admin:treasury')
      .input(
        z.object({
          poolId: z.string().uuid(),
          fundingId: z.string().min(4).max(64),
          amount: amountString,
          ...actionApprovalFields,
        }),
      )
      .output(z.object({ ledgerTxId: z.string(), confirmOperatorId: z.string() }))
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.fund_pool', {
            poolId: input.poolId,
            fundingId: input.fundingId,
            amount: input.amount,
          });
          const posted = await bank.earn.fundPool({
            poolId: input.poolId,
            fundingId: input.fundingId,
            amount: parseAmount(input.amount),
          });
          return { ...posted, confirmOperatorId };
        }),
      ),

    // ── Loans (§8.1) ─────────────────────────────────────────────────────────
    //
    // THE RISK SWEEP AND THE LADDER ARE OPERATOR SURFACE, NOT USER SURFACE.
    //
    // A user able to trigger a mark is a user able to choose when their own — or
    // a rival's — collateral is priced, which is precisely what the staleness
    // window and the deviation breaker exist to take out of anyone's hands. Same
    // reasoning as the standing-order runner above: safe to run twice is not a
    // reason to let an untrusted caller choose when.

    fundLoanReserve: scopedProcedure('admin:treasury')
      .input(
        z.object({
          debtAssetId: z.string().min(1).max(16),
          fundingId: z.string().min(4).max(64),
          amount: amountString,
          ...actionApprovalFields,
        }),
      )
      .output(z.object({ ledgerTxId: z.string(), confirmOperatorId: z.string() }))
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.fund_loan_reserve', {
            debtAssetId: input.debtAssetId,
            fundingId: input.fundingId,
            amount: input.amount,
          });
          const posted = await bank.loans.fundReserve({
            debtAssetId: input.debtAssetId,
            fundingId: input.fundingId,
            amount: parseAmount(input.amount),
          });
          return { ...posted, confirmOperatorId };
        }),
      ),

    accrueLoanInterest: jobProcedure
      .input(
        z.object({
          loanId: z.string().uuid().optional(),
          at: z.string().datetime({ offset: true }).optional(),
          limit: z.number().int().min(1).max(10_000).optional(),
        }),
      )
      .output(
        z.object({
          results: z.array(z.object({ loanId: z.string(), charged: amountString, days: z.number().int() })),
          failures: z.array(z.object({ loanId: z.string(), reason: z.string(), code: z.string().optional() })),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          // Parity with POST /internal/jobs/accrue-loan-interest.
          if (!loanAccrualEnabled) {
            throw new BankError('loan interest accrual is disabled', 'bank.loan_accrual_disabled');
          }
          const at = input.at ? new Date(input.at) : new Date();
          if (input.loanId) {
            const one = await bank.loans.accrue({ loanId: input.loanId, until: at });
            return {
              results: [{ loanId: one.loanId, charged: formatAmount(one.charged), days: one.days.length }],
              failures: [],
            };
          }
          const all = await bank.loans.accrueAll(at, input.limit);
          return {
            results: all.results.map((r) => ({ loanId: r.loanId, charged: formatAmount(r.charged), days: r.days })),
            failures: all.failures,
          };
        }),
      ),

    runRiskSweep: jobProcedure
      .input(z.object({ limit: z.number().int().min(1).max(10_000).optional() }))
      .output(
        z.object({
          marked: z.number().int(),
          called: z.number().int(),
          liquidated: z.number().int(),
          cleared: z.number().int(),
          // Loans the sweep declined to act on — an unusable mark, no
          // counterparty, a reserve that cannot cover. Surfaced rather than
          // swallowed: a silent refusal is a position nobody is watching.
          refused: z.array(z.object({ loanId: z.string(), reason: z.string() })),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          // Parity with POST /internal/jobs/run-risk-sweep. Defaults off in
          // production; a treasury caller must not liquidate past that stop.
          if (!loanRiskSweepEnabled) {
            throw new BankError('loan risk sweep is disabled', 'bank.loan_risk_sweep_disabled');
          }
          return bank.loans.runRiskSweep({ limit: input.limit });
        }),
      ),

    /**
     * Seize one underwater loan through ledger-client. Marks first — a missing
     * mark refuses `bank.mark_missing` before any post. Same kill as the sweep.
     */
    seizeLoan: scopedProcedure('admin:treasury')
      .input(z.object({ loanId: z.string().uuid(), ...actionApprovalFields }))
      .output(
        z.object({
          ledgerTxId: z.string(),
          collateralSold: amountString,
          proceeds: amountString,
          principalRepaid: amountString,
          interestRepaid: amountString,
          closed: z.boolean(),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.seize_loan', { loanId: input.loanId });
          if (!loanRiskSweepEnabled) {
            throw new BankError('loan risk sweep is disabled', 'bank.loan_risk_sweep_disabled');
          }
          const result = await bank.loans.seize({ loanId: input.loanId });
          return {
            ledgerTxId: result.ledgerTxId,
            collateralSold: formatAmount(result.collateralSold),
            proceeds: formatAmount(result.proceeds),
            principalRepaid: formatAmount(result.principalRepaid),
            interestRepaid: formatAmount(result.interestRepaid),
            closed: result.closed,
            confirmOperatorId,
          };
        }),
      ),

    /** Re-drive loans stuck between the collateral lock and the draw. */
    resumePendingLoans: jobProcedure
      .input(z.object({ limit: z.number().int().min(1).max(1_000).optional() }))
      .output(z.array(z.object({ loanId: z.string(), outcome: z.string(), reason: z.string().optional() })))
      .mutation(async ({ input }) => guard(async () => bank.loans.resumePending(input.limit))),

    /** Give up on a pending loan and give the borrower their collateral back. */
    abandonPendingLoan: scopedProcedure('admin:treasury')
      .input(z.object({ loanId: z.string().uuid(), ...actionApprovalFields }))
      .output(
        z.object({
          released: amountString,
          ledgerTxId: z.string().nullable(),
          /** True when the draw had in fact booked: the loan was completed to active and no collateral moved. */
          adopted: z.boolean(),
          drawLedgerTxId: z.string().nullable(),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.abandon_pending_loan', { loanId: input.loanId });
          const result = await bank.loans.abandonPending(input.loanId);
          return {
            released: formatAmount(result.released),
            ledgerTxId: result.ledgerTxId,
            adopted: result.adopted,
            drawLedgerTxId: result.drawLedgerTxId,
            confirmOperatorId,
          };
        }),
      ),

    /**
     * Re-drive earn deposits stuck between the ledger post and activate.
     * Same recovery shape as `resumePendingLoans`; key is bank.earn.deposit:<id>.
     */
    resumePendingEarn: jobProcedure
      .input(z.object({ limit: z.number().int().min(1).max(1_000).optional() }))
      .output(z.array(z.object({ positionId: z.string(), outcome: z.string(), reason: z.string().optional() })))
      .mutation(async ({ input }) => guard(async () => bank.earn.resumePending(input.limit))),

    // ── Cards (§8.1, ledger half) ────────────────────────────────────────────
    //
    // THE ISSUER'S SIDE OF THE CONVERSATION, NOT THE USER'S.
    //
    // On a live rail these three are a signed webhook from the issuer, arriving
    // on a deadline the card network sets. There is no live rail — that is
    // `socket.live-issuer`, a sponsor bank and an issuing BIN — so today they are
    // operator surface, and they must NEVER become user surface: a user who can
    // call `cardAuthorize` approves their own purchase, and a user who can call
    // `cardCapture` chooses when their own money leaves the book.
    //
    // The simulator is what makes them exercisable at all, and it says so on
    // every card it issues (`simulated: true`).

    cardAuthorize: scopedProcedure('admin:treasury')
      .input(
        z.object({
          cardId: z.string().uuid(),
          authorizationRef: z.string().min(4).max(128),
          /**
           * THE MERCHANT'S NUMBER, in the card's SETTLEMENT asset.
           *
           * The same asset the card draws on unless the card was issued with a
           * settlement asset of its own — in which case this is converted at a
           * rate quoted now and frozen, and refuses `bank.mark_missing` if no
           * rate can be got rather than guessing one.
           */
          amount: amountString,
          merchantCategory: z.string().min(1).max(64).optional(),
          channel: z.enum(['card-present', 'online', 'contactless', 'atm', 'foreign']).optional(),
          ...actionApprovalFields,
        }),
      )
      .output(
        z.object({
          authorizationId: z.string(),
          decision: z.enum(['approved', 'declined']),
          declineCode: z.string().nullable(),
          /** WHAT WAS HELD, in the funding asset. The converted figure on a converted card. */
          amount: amountString,
          /** The frozen quote, or null because this card converts nothing. */
          conversion: z
            .object({
              settlementAssetId: z.string(),
              settlementAmount: amountString,
              rate: amountString,
              rateQuality: z.string(),
              rateAsOf: z.string(),
            })
            .nullable(),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.card_authorize', {
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
            amount: input.amount,
          });
          const authorization = await bank.cards.authorize({
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
            amount: parseAmount(input.amount),
            ...(input.merchantCategory === undefined ? {} : { merchantCategory: input.merchantCategory }),
            ...(input.channel === undefined ? {} : { channel: input.channel }),
          });
          return {
            authorizationId: authorization.id,
            decision: authorization.decision,
            declineCode: authorization.declineCode,
            amount: formatAmount(authorization.amount),
            conversion: authorization.conversion
              ? {
                  settlementAssetId: authorization.conversion.settlementAssetId,
                  settlementAmount: formatAmount(authorization.conversion.settlementAmount),
                  rate: formatAmount(authorization.conversion.rate),
                  rateQuality: authorization.conversion.quality,
                  rateAsOf: authorization.conversion.rateAsOf.toISOString(),
                }
              : null,
            confirmOperatorId,
          };
        }),
      ),

    cardCapture: scopedProcedure('admin:treasury')
      .input(
        z.object({
          cardId: z.string().uuid(),
          authorizationRef: z.string().min(4).max(128),
          amount: amountString,
          ...actionApprovalFields,
        }),
      )
      .output(
        z.object({
          /** WHAT LEFT THE BOOK, in the funding asset. */
          captured: amountString,
          returned: amountString,
          captureLedgerTxId: z.string(),
          reversalLedgerTxId: z.string().nullable(),
          /**
           * What the merchant cleared and the FROZEN rate it converted at — the
           * rate the authorisation was decided on, re-read and never re-quoted.
           * Null on a card that converts nothing.
           */
          settlement: z.object({ assetId: z.string(), amount: amountString, rate: amountString }).nullable(),
          // Surfaced rather than swallowed. A reward the rewards pot could not
          // pay is a fact an operator needs on the day it happens — the same
          // reasoning as `runRiskSweep.refused`.
          cashback: z.object({
            status: z.enum(['none', 'paid', 'refused']),
            amount: amountString,
            reason: z.string().optional(),
          }),
          /**
           * Spare-change sweep. Capture still stands when this is skipped or
           * refused — same reporting rule as cashback.
           */
          roundUp: z.object({
            status: z.enum(['none', 'skipped', 'settled', 'refused']),
            amount: amountString,
            reason: z.string().optional(),
            positionId: z.string().optional(),
          }),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.card_capture', {
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
            amount: input.amount,
          });
          const result = await bank.cards.capture({
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
            amount: parseAmount(input.amount),
          });
          return {
            captured: formatAmount(result.captured),
            returned: formatAmount(result.returned),
            captureLedgerTxId: result.captureLedgerTxId,
            reversalLedgerTxId: result.reversalLedgerTxId,
            settlement: result.settlement
              ? {
                  assetId: result.settlement.assetId,
                  amount: formatAmount(result.settlement.amount),
                  rate: formatAmount(result.settlement.rate),
                }
              : null,
            cashback: {
              status: result.cashback.status,
              amount: formatAmount(result.cashback.amount),
              ...(result.cashback.status === 'refused' ? { reason: result.cashback.reason } : {}),
            },
            roundUp: {
              status: result.roundUp.status,
              amount: formatAmount(result.roundUp.amount),
              ...(result.roundUp.status === 'skipped' || result.roundUp.status === 'refused' ? { reason: result.roundUp.reason } : {}),
              ...(result.roundUp.status === 'settled' ? { positionId: result.roundUp.positionId } : {}),
            },
            confirmOperatorId,
          };
        }),
      ),

    /** The authorisation expired or was voided. The whole hold goes back. */
    cardReverse: scopedProcedure('admin:treasury')
      .input(
        z.object({
          cardId: z.string().uuid(),
          authorizationRef: z.string().min(4).max(128),
          ...actionApprovalFields,
        }),
      )
      .output(z.object({ returned: amountString, ledgerTxId: z.string(), confirmOperatorId: z.string() }))
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.card_reverse', {
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
          });
          const result = await bank.cards.reverse({ cardId: input.cardId, authorizationRef: input.authorizationRef });
          return { returned: formatAmount(result.returned), ledgerTxId: result.ledgerTxId, confirmOperatorId };
        }),
      ),

    /**
     * Re-drive card settlements that were claimed and never reached the ledger,
     * and report what is still held against the authorisation.
     *
     * The card equivalent of `resumePendingLoans`, and it exists for the same
     * reason: one failed post must not leave a user's hold unreachable. Takes no
     * amount — each row is re-driven for the amount it was claimed with, because
     * a recovery that can restate what moved is not a recovery.
     */
    cardResumeSettlement: scopedProcedure('admin:treasury')
      .input(
        z.object({
          cardId: z.string().uuid(),
          authorizationRef: z.string().min(4).max(128),
          ...actionApprovalFields,
        }),
      )
      .output(
        z.object({
          authorizationId: z.string(),
          resumed: z.array(
            z.object({
              sequence: z.number().int(),
              kind: z.enum(['capture', 'reversal']),
              amount: amountString,
              outcome: z.enum(['settled', 'failed']),
              ledgerTxId: z.string().optional(),
              reason: z.string().optional(),
            }),
          ),
          // Read from the ledger, not added up from our own rows. Zero is the
          // invariant an operator is actually checking for after a recovery.
          held: amountString,
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.card_resume_settlement', {
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
          });
          const result = await bank.cards.resumeSettlements({
            cardId: input.cardId,
            authorizationRef: input.authorizationRef,
          });
          return {
            authorizationId: result.authorizationId,
            resumed: result.resumed.map((row) => ({
              sequence: row.sequence,
              kind: row.kind,
              amount: formatAmount(row.amount),
              outcome: row.outcome,
              ...(row.ledgerTxId === undefined ? {} : { ledgerTxId: row.ledgerTxId }),
              ...(row.reason === undefined ? {} : { reason: row.reason }),
            })),
            held: formatAmount(result.held),
            confirmOperatorId,
          };
        }),
      ),

    /**
     * Move bank revenue into the pot cashback is paid from.
     *
     * The named source, in one call. Cashback is a share of fees the platform
     * really charged; a pot funded from anywhere else would make the advertised
     * rate a promise against revenue that has not happened.
     */
    fundCashbackPot: scopedProcedure('admin:treasury')
      .input(
        z.object({
          windowId: z.string().min(4).max(64),
          assetId: z.string().min(1).max(16),
          amount: amountString,
          ...actionApprovalFields,
        }),
      )
      .output(z.object({ ledgerTxId: z.string(), capacity: amountString, confirmOperatorId: z.string() }))
      .mutation(async ({ input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.fund_cashback_pot', {
            windowId: input.windowId,
            assetId: input.assetId,
            amount: input.amount,
          });
          const posted = await bank.cards.fundCashbackPot({
            windowId: input.windowId,
            assetId: input.assetId,
            amount: parseAmount(input.amount),
          });
          return {
            ledgerTxId: posted.ledgerTxId,
            capacity: formatAmount(await bank.cards.cashbackCapacity(input.assetId)),
            confirmOperatorId,
          };
        }),
      ),

    /**
     * The reserve identity, as a query rather than an investigation:
     * `balance(loanReserve) + Σ outstanding principal` against what was funded.
     */
    reconcileLoanReserve: scopedProcedure('admin:treasury')
      .input(z.object({ debtAssetId: z.string().min(1).max(16) }))
      .output(
        z.object({
          reserveBalance: amountString,
          outstandingPrincipal: amountString,
          badDebt: amountString,
          funded: amountString,
          drift: amountString,
          /** False until funded is journal-independent; do not treat drift 0 as green. */
          independent: z.boolean(),
          insuranceCapacity: amountString,
        }),
      )
      .query(async ({ input }) =>
        guard(async () => {
          const r = await bank.loans.reconcileReserve(input.debtAssetId);
          return {
            reserveBalance: formatAmount(r.reserveBalance),
            outstandingPrincipal: formatAmount(r.outstandingPrincipal),
            badDebt: formatAmount(r.badDebt),
            funded: formatAmount(r.funded),
            drift: formatAmount(r.drift),
            independent: r.independent,
            insuranceCapacity: formatAmount(await bank.loans.insuranceCapacity(input.debtAssetId)),
          };
        }),
      ),

    /**
     * Operator on-ramp credit for the CRYPTO ledger half.
     *
     * Not user-callable: a user who credits their own balance does not need a
     * ramp. Kind fiat refuses `bank.fiat_ramp_socket` before any row or ledger post.
     */
    creditOnramp: scopedProcedure('admin:treasury')
      .input(
        z.object({
          userId: z.string().min(1),
          assetId: z.string().min(1).max(16),
          amount: amountString,
          kind: z.enum(['crypto', 'fiat']).default('crypto'),
          railRef: z.string().min(1).max(256),
          ...actionApprovalFields,
        }),
      )
      .output(
        z.object({
          id: z.string(),
          userId: z.string(),
          assetId: z.string(),
          amount: amountString,
          kind: z.enum(['crypto', 'fiat']),
          rail: z.string(),
          railRef: z.string(),
          simulated: z.boolean(),
          status: z.string(),
          ledgerTxId: z.string().nullable(),
          confirmOperatorId: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const confirmOperatorId = await consumeOpsApproval(input, 'bank.credit_onramp', {
            userId: input.userId,
            assetId: input.assetId,
            amount: input.amount,
            kind: input.kind,
            railRef: input.railRef,
          });
          const row = await bank.ramps.creditOnramp({
            userId: input.userId,
            assetId: input.assetId,
            amount: parseAmount(input.amount),
            kind: input.kind,
            railRef: input.railRef,
            creditedBy: ctx.principal.userId,
          });
          return {
            id: row.id,
            userId: row.userId,
            assetId: row.assetId,
            amount: formatAmount(row.amount),
            kind: row.kind,
            rail: row.rail,
            railRef: row.railRef,
            simulated: row.simulated,
            status: row.status,
            ledgerTxId: row.ledgerTxId,
            confirmOperatorId,
          };
        }),
      ),

    poolTotals: poolTotalsProcedure(() => bank.earn.poolTotals(), guard),
    loanBook: loanBookProcedure(() => bank.loans.loanBook(), guard),
    limitRequests: limitRequestQueueProcedure(limitRequests, guard),
    decideLimitRequest: decideLimitRequestProcedure(limitRequests, guard),
    createLoanProduct: createLoanProductProcedure(bank, consumeOpsApproval, guard),
    cardProgramme: cardProgrammeProcedure(bank, guard),
    setCardStatus: setCardStatusProcedure(bank, consumeOpsApproval, guard),
    rampHealth: rampHealthProcedure(bank, guard),
    transferHealth: transferHealthProcedure(bank, guard),
    failedTransfers: failedTransfersProcedure(bank, guard),
    transferDetail: transferDetailProcedure(bank, guard),
    customerBalances: customerBalancesProcedure(bank, guard),
    customerBalanceEntries: customerBalanceEntriesProcedure(bank, guard),
    businessApprovals: businessApprovalsProcedure(bank, guard),
  });

  /**
   * RAMPS — crypto ledger half. Fiat is socket.psp-partners commercially.
   * Kind fiat refuses `bank.fiat_ramp_socket` before any row or ledger post.
   *
   * `simulated` is never omitted: this surface does not broadcast to a chain and
   * never claims a live PSP. Live confirmation stays in svc-pay; Class X is a
   * human decision to point working code at real money.
   */
  const rampProgrammeOutput = z.object({
    id: z.string(),
    simulated: z.boolean(),
    displayName: z.string(),
    cryptoRail: z.string().nullable(),
    fiatLeg: z.literal('socket.psp-partners'),
    fiatVia: z.literal('svc-pay.RailAdapter'),
  });

  const onrampOutput = z.object({
    id: z.string(),
    assetId: z.string(),
    amount: amountString,
    kind: z.enum(['crypto', 'fiat']),
    rail: z.string(),
    railRef: z.string(),
    simulated: z.boolean(),
    status: z.string(),
    ledgerTxId: z.string().nullable(),
    createdAt: z.string(),
  });

  const offrampOutput = z.object({
    id: z.string(),
    assetId: z.string(),
    amount: amountString,
    kind: z.enum(['crypto', 'fiat']),
    rail: z.string(),
    destinationRef: z.string(),
    clientRef: z.string(),
    simulated: z.boolean(),
    status: z.string(),
    holdLedgerTxId: z.string().nullable(),
    settleLedgerTxId: z.string().nullable(),
    createdAt: z.string(),
  });

  const autoInvestRuleOutput = z.object({
    id: z.string(),
    kind: z.enum(['threshold_sweep', 'dca', 'card_roundup']),
    assetId: z.string(),
    threshold: amountString.nullable(),
    targetPoolId: z.string().nullable(),
    buyAssetId: z.string().nullable(),
    amount: amountString.nullable(),
    cadence: z.enum(['daily', 'weekly', 'monthly']).nullable(),
    nextRunAt: z.string().nullable(),
    status: z.enum(['active', 'paused', 'cancelled']),
    createdAt: z.string(),
  });

  function mapRule(r: Awaited<ReturnType<typeof bank.autoInvest.listRules>>[number]) {
    return {
      id: r.id,
      kind: r.kind,
      assetId: r.assetId,
      threshold: r.threshold === null ? null : formatAmount(r.threshold),
      targetPoolId: r.targetPoolId,
      buyAssetId: r.buyAssetId,
      amount: r.amount === null ? null : formatAmount(r.amount),
      cadence: r.cadence,
      nextRunAt: r.nextRunAt?.toISOString() ?? null,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    };
  }

  const autoInvest = router({
    policy: publicProcedure.query(() => describeAutoInvestPolicy({ enabled: autoInvestEnabled, convertWired: autoInvestConvertWired })),

    /**
     * List this user's auto-invest rules. Rules hold no balance — they are
     * instructions; the ledger answers "how much".
     */
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.auto_invest_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(z.array(autoInvestRuleOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.autoInvest.listRules(ctx.principal.userId, input?.limit);
          return rows.map(mapRule);
        }),
      ),

    /**
     * Same-asset threshold sweep: keep `threshold` in primary available; move
     * excess into an earn pool of the same asset. No rate is consulted.
     */
    createThresholdSweep: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          threshold: amountString,
          targetPoolId: z.string().uuid(),
        }),
      )
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.createThresholdSweep({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            threshold: parseAmount(input.threshold),
            targetPoolId: input.targetPoolId,
          });
          return mapRule(rule);
        }),
      ),

    /**
     * Card round-up. Same-asset spare change → earn pool on capture.
     * `buyAssetId` that differs from `assetId` refuses `bank.auto_invest_rate_unset`
     * — the surface exists so the dishonest half is named, not silent.
     */
    createRoundUp: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          granularity: amountString,
          targetPoolId: z.string().uuid(),
          buyAssetId: z.string().min(1).max(16).optional(),
        }),
      )
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.createCardRoundUp({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            granularity: parseAmount(input.granularity),
            targetPoolId: input.targetPoolId,
            ...(input.buyAssetId ? { buyAssetId: input.buyAssetId } : {}),
          });
          return mapRule(rule);
        }),
      ),

    /**
     * DCA schedule. Refuses `bank.auto_invest_rate_unset` when this deployment
     * has no convert counterparty — §8 rates are never invented here.
     */
    createDca: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          spendAssetId: z.string().min(1).max(16),
          buyAssetId: z.string().min(1).max(16),
          amount: amountString,
          cadence: z.enum(['daily', 'weekly', 'monthly']),
          startsAt: z.string().datetime({ offset: true }),
        }),
      )
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.createDca({
            userId: ctx.principal.userId,
            spendAssetId: input.spendAssetId,
            buyAssetId: input.buyAssetId,
            amount: parseAmount(input.amount),
            cadence: input.cadence,
            startsAt: new Date(input.startsAt),
          });
          return mapRule(rule);
        }),
      ),

    cancel: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ ruleId: z.string().uuid() }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.getRule(input.ruleId);
          if (rule.userId !== ctx.principal.userId) {
            throw new BankError('Not your auto-invest rule', 'bank.not_owner');
          }
          await bank.autoInvest.cancelRule(input.ruleId);
          return { ok: true as const };
        }),
      ),

    /**
     * Hold a rule without cancelling. Runner only considers `active` rules.
     */
    pause: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ ruleId: z.string().uuid() }))
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.getRule(input.ruleId);
          if (rule.userId !== ctx.principal.userId) {
            throw new BankError('Not your auto-invest rule', 'bank.not_owner');
          }
          return mapRule(await bank.autoInvest.pauseRule(input.ruleId));
        }),
      ),

    /**
     * Resume a paused rule. Next runDue pass applies normal due rules — no
     * multi-fire invent of missed windows.
     */
    resume: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ ruleId: z.string().uuid() }))
      .output(autoInvestRuleOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const rule = await bank.autoInvest.getRule(input.ruleId);
          if (rule.userId !== ctx.principal.userId) {
            throw new BankError('Not your auto-invest rule', 'bank.not_owner');
          }
          return mapRule(await bank.autoInvest.resumeRule(input.ruleId));
        }),
      ),
  });

  const ramps = router({
    /** What this deployment's ramp programme is — including that it is not one. */
    programme: scopedProcedure('bank:read', { module: 'bank' })
      .output(rampProgrammeOutput)
      .query(async () => guard(async () => bank.ramps.programmeInfo())),

    /**
     * Live cash ramp. Refuses until a cash rail exists. Posts nothing.
     * The simulated programme is a different surface and stays marked simulated.
     */
    live: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ amount: amountString.optional() }).optional())
      .output(z.object({ ramp: z.null() }))
      .mutation(() =>
        guard(async () => {
          bank.ramps.liveRamp();
          return { ramp: null };
        }),
      ),

    /**
     * Fiat settle probe. Refuses with a typed code when no svc-pay adapter can
     * settle fiat (empty / sandbox / absent). Does not invent FX. Live partner
     * rails remain Class X — this door never claims simulated: false.
     */
    fiatSettle: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.object({
          canSettle: z.literal(true),
          onrampRailId: z.string(),
          offrampRailId: z.string(),
        }),
      )
      .query(async () => guard(async () => bank.ramps.fiatSettle())),

    onramps: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.onramps_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(z.array(onrampOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.ramps.onrampsOf(ctx.principal.userId, input?.limit);
          return rows.map((r) => ({
            id: r.id,
            assetId: r.assetId,
            amount: formatAmount(r.amount),
            kind: r.kind,
            rail: r.rail,
            railRef: r.railRef,
            simulated: r.simulated,
            status: r.status,
            ledgerTxId: r.ledgerTxId,
            createdAt: r.createdAt.toISOString(),
          }));
        }),
      ),

    offramps: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.offramps_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(z.array(offrampOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.ramps.offrampsOf(ctx.principal.userId, input?.limit);
          return rows.map((r) => ({
            id: r.id,
            assetId: r.assetId,
            amount: formatAmount(r.amount),
            kind: r.kind,
            rail: r.rail,
            destinationRef: r.destinationRef,
            clientRef: r.clientRef,
            simulated: r.simulated,
            status: r.status,
            holdLedgerTxId: r.holdLedgerTxId,
            settleLedgerTxId: r.settleLedgerTxId,
            createdAt: r.createdAt.toISOString(),
          }));
        }),
      ),

    /**
     * Persist a user withdraw dest (IBAN/IFSC/EVM) so a later offramp has a
     * real ref before withdrawHold. Does not move value and does not invent a PSP.
     */
    // `trade:withdraw` is the step-up scope: no API key may hold it and a normal session does not carry it,
    // `auth.stepUp` mints it for five minutes against a second factor (§9). `bank:write` alone let a leaked
    // key or an XSS-stolen access token change where money is sent and send it.
    setWithdrawDestination: scopedProcedure('trade:withdraw', { module: 'bank' })
      .input(
        z.object({
          kind: z.enum(['crypto', 'bank']),
          ref: z.string().min(1).max(256),
          label: z.string().min(1).max(64).optional(),
        }),
      )
      .output(z.object({ kind: z.string(), ref: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () =>
          bank.ramps.setWithdrawDestination({
            userId: ctx.principal.userId,
            kind: input.kind,
            ref: input.ref,
            ...(input.label !== undefined ? { label: input.label } : {}),
          }),
        ),
      ),

    /**
     * Saved wallets and bank accounts. Cooling end uses the owner window.
     * When that window is unpublished, `coolingOffEndsAt` is null and
     * `coolingBlocker` names `bank.offramp_cooling_unset`. No 24h default.
     */
    destinations: router({
      list: scopedProcedure('bank:read', { module: 'bank' })
        .output(z.array(destinationViewOutput))
        .query(async ({ ctx }) => guard(async () => bank.ramps.listDestinations(ctx.principal.userId))),

      /**
       * Save an address-book entry. `trade:withdraw` (the step-up scope), like removing one: a leaked key or a
       * stolen access token must not be able to add the address that money is then sent to. The same
       * (asset, network, address, tag) again returns the stored entry. The label is unique per customer, and the
       * number of entries is the owner's `BANK_ADDRESS_BOOK_CAP` (blank refuses `bank.address_book_cap_unset`).
       */
      save: scopedProcedure('trade:withdraw', { module: 'bank' })
        .input(
          z
            .object({
              assetId: z.string().min(1).max(16),
              network: z.string().min(2).max(32),
              ref: z.string().min(1).max(256),
              tag: z.string().min(1).max(64).optional(),
              label: z.string().min(1).max(64),
            })
            .strict(),
        )
        .output(destinationViewOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            bank.ramps.saveDestination({
              userId: ctx.principal.userId,
              assetId: input.assetId,
              network: input.network,
              ref: input.ref,
              ...(input.tag !== undefined ? { tag: input.tag } : {}),
              label: input.label,
            }),
          ),
        ),

      /**
       * Rename. Changes only the label, so `bank:write` is enough and the cooling window does not restart. It cannot
       * add or change an address; a stolen plain token could only swap labels between the customer's own saved ones.
       */
      rename: scopedProcedure('bank:write', { module: 'bank' })
        .input(z.object({ destinationId: z.string().uuid(), label: z.string().min(1).max(64) }).strict())
        .output(destinationViewOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            bank.ramps.renameDestination({ userId: ctx.principal.userId, destinationId: input.destinationId, label: input.label }),
          ),
        ),

      /** Remove, with the same step-up scope as saving. A withdrawal that already copied the address is not touched. */
      remove: scopedProcedure('trade:withdraw', { module: 'bank' })
        .input(z.object({ destinationId: z.string().uuid(), idempotencyKey: z.string().min(1).max(128) }))
        .output(z.object({ destinationId: z.string(), removed: z.literal(true) }))
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            bank.ramps.removeDestination({
              userId: ctx.principal.userId,
              destinationId: input.destinationId,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),
    }),

    /**
     * On-ramp quote. Pay amount, fee, and rate come from the rate source.
     * A blank PSP or a blank source refuses. This door does not invent them.
     */
    onrampQuote: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          amount: amountString,
          method: z.enum(['card', 'bank_transfer', 'wallet_pay']),
          country: z.string().regex(/^[A-Za-z]{2}$/),
        }),
      )
      .output(
        z.object({
          quoteId: z.string(),
          assetId: z.string(),
          amount: amountString,
          method: z.enum(['card', 'bank_transfer', 'wallet_pay']),
          country: z.string(),
          payAmount: amountString,
          fee: amountString,
          rate: amountString,
          payCurrency: z.string(),
          expiresAt: z.string(),
          simulated: z.literal(true),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () =>
          bank.ramps.onrampQuote({
            userId: ctx.principal.userId,
            assetId: input.assetId,
            amount: input.amount,
            method: input.method,
            country: input.country,
          }),
        ),
      ),

    /**
     * Customer on-ramp. Idempotent by `onrampId`. Stores the partner's hosted
     * URL or bank-transfer instruction and does not credit the ledger.
     * A blank partner refuses `bank.fiat_ramp_socket` before any row.
     */
    onrampCreate: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          onrampId: z.string().uuid(),
          quoteId: z.string().uuid(),
          method: z.enum(['card', 'bank_transfer', 'wallet_pay']),
        }),
      )
      .output(
        z.object({
          onrampId: z.string(),
          quoteId: z.string(),
          assetId: z.string(),
          amount: amountString,
          method: z.enum(['card', 'bank_transfer', 'wallet_pay']),
          payAmount: amountString,
          fee: amountString,
          rate: amountString,
          payCurrency: z.string(),
          status: z.literal('pending_payment'),
          simulated: z.literal(true),
          partnerRail: z.string(),
          hostedUrl: z.string().nullable(),
          bankInstructions: z.object({ reference: z.string(), accountName: z.string(), accountRef: z.string() }).nullable(),
          createdAt: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const row = await bank.ramps.onrampCreate({
            userId: ctx.principal.userId,
            onrampId: input.onrampId,
            quoteId: input.quoteId,
            method: input.method,
          });
          return {
            onrampId: row.onrampId,
            quoteId: row.quoteId,
            assetId: row.assetId,
            amount: row.amount,
            method: row.method,
            payAmount: row.payAmount,
            fee: row.fee,
            rate: row.rate,
            payCurrency: row.payCurrency,
            status: row.status,
            simulated: row.simulated,
            partnerRail: row.partnerRail,
            hostedUrl: row.hostedUrl,
            bankInstructions: row.bankInstructions,
            createdAt: row.createdAt,
          };
        }),
      ),

    /**
     * Off-ramp fee quote. Kind fiat refuses `bank.fiat_ramp_socket`.
     * Crypto refuses `bank.offramp_fee_unset` until a fee schedule is published.
     */
    offrampQuote: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          assetId: z.string().min(1).max(16),
          amount: amountString,
          kind: z.enum(['crypto', 'fiat']),
          destinationRef: z.string().min(1).max(256),
        }),
      )
      .output(
        z.object({
          assetId: z.string(),
          amount: amountString,
          kind: z.literal('crypto'),
          destinationRef: z.string(),
          fee: amountString,
          netAmount: amountString,
          expiresAt: z.string(),
          simulated: z.literal(true),
        }),
      )
      .query(async ({ input }) =>
        guard(async () =>
          bank.ramps.offrampQuote({
            assetId: input.assetId,
            amount: input.amount,
            kind: input.kind,
            destinationRef: input.destinationRef,
          }),
        ),
      ),

    /**
     * User off-ramp. `offrampId` + `clientRef` are client-supplied so a retry
     * is the same withdrawal (§5). Kind fiat refuses `bank.fiat_ramp_socket`
     * before any row or ledger post.
     * Crypto destination is persisted (or loaded) before withdrawHold.
     */
    // `trade:withdraw` is the step-up scope: no API key may hold it and a normal session does not carry it,
    // `auth.stepUp` mints it for five minutes against a second factor (§9). `bank:write` alone let a leaked
    // key or an XSS-stolen access token change where money is sent and send it.
    offramp: scopedProcedure('trade:withdraw', { module: 'bank' })
      .input(
        z.object({
          offrampId: z.string().uuid(),
          assetId: z.string().min(1).max(16),
          amount: amountString,
          kind: z.enum(['crypto', 'fiat']).default('crypto'),
          destinationRef: z.string().min(1).max(256).optional(),
          clientRef: z.string().min(1).max(128),
        }),
      )
      .output(offrampOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const row = await bank.ramps.offramp({
            offrampId: input.offrampId,
            userId: ctx.principal.userId,
            assetId: input.assetId,
            amount: parseAmount(input.amount),
            kind: input.kind,
            destinationRef: input.destinationRef,
            clientRef: input.clientRef,
          });
          return {
            id: row.id,
            assetId: row.assetId,
            amount: formatAmount(row.amount),
            kind: row.kind,
            rail: row.rail,
            destinationRef: row.destinationRef,
            clientRef: row.clientRef,
            simulated: row.simulated,
            status: row.status,
            holdLedgerTxId: row.holdLedgerTxId,
            settleLedgerTxId: row.settleLedgerTxId,
            createdAt: row.createdAt.toISOString(),
          };
        }),
      ),
  });

  const businessAccountOutput = z.object({
    id: z.string(),
    name: z.string(),
    assetId: z.string(),
    spendThreshold: amountString,
    status: z.enum(['active', 'closed']),
    createdAt: z.string(),
  });

  const businessApprovalOutput = z.object({
    id: z.string(),
    accountId: z.string(),
    makerUserId: z.string(),
    checkerUserId: z.string().nullable(),
    fromSpaceId: z.string(),
    toSpaceId: z.string(),
    assetId: z.string(),
    amount: amountString,
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
    transferId: z.string().nullable(),
    holdLedgerTxId: z.string().nullable(),
    ledgerTxId: z.string().nullable(),
    createdAt: z.string(),
  });

  const business = router({
    policy: publicProcedure.query(() => describeBusinessPolicy()),

    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.business_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(z.array(businessAccountOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.business.accountsOf(ctx.principal.userId, input?.limit);
          return rows.map((a) => ({
            id: a.id,
            name: a.name,
            assetId: a.assetId,
            spendThreshold: formatAmount(a.spendThreshold),
            status: a.status,
            createdAt: a.createdAt.toISOString(),
          }));
        }),
      ),

    create: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().uuid(),
          name: z.string().min(1).max(128),
          assetId: z.string().min(1).max(16),
          spendThreshold: amountString,
        }),
      )
      .output(businessAccountOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const a = await bank.business.createAccount({
            accountId: input.accountId,
            name: input.name,
            assetId: input.assetId,
            spendThreshold: parseAmount(input.spendThreshold),
            creatorUserId: ctx.principal.userId,
          });
          return {
            id: a.id,
            name: a.name,
            assetId: a.assetId,
            spendThreshold: formatAmount(a.spendThreshold),
            status: a.status,
            createdAt: a.createdAt.toISOString(),
          };
        }),
      ),

    addMember: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().uuid(),
          userId: z.string().min(1),
          role: z.enum(BUSINESS_ROLES),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(z.object({ accountId: z.string(), userId: z.string(), role: z.enum(BUSINESS_ROLES) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              addMemberBinding({ actor: ctx.principal.userId, accountId: input.accountId, userId: input.userId, role: input.role }),
              input.stepUpApprovalId,
            );
          }
          const m = await bank.business.addMember({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            userId: input.userId,
            role: input.role,
          });
          return { accountId: m.accountId, userId: m.userId, role: m.role };
        }),
      ),

    proposeTransfer: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().uuid(),
          fromSpaceId: z.string().uuid(),
          toSpaceId: z.string().uuid(),
          amount: amountString,
          clientId: z.string().uuid(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(
        z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('posted'),
            transferId: z.string(),
            ledgerTxId: z.string(),
          }),
          z.object({
            kind: z.literal('pending'),
            approval: businessApprovalOutput,
          }),
        ]),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              proposeTransferBinding({
                actor: ctx.principal.userId,
                clientId: input.clientId,
                accountId: input.accountId,
                fromSpaceId: input.fromSpaceId,
                toSpaceId: input.toSpaceId,
                assetId: await assetOfSpace(input.fromSpaceId),
                amount: input.amount,
              }),
              input.stepUpApprovalId,
            );
          }
          const result = await bank.business.proposeTransfer({
            accountId: input.accountId,
            makerUserId: ctx.principal.userId,
            fromSpaceId: input.fromSpaceId,
            toSpaceId: input.toSpaceId,
            amount: parseAmount(input.amount),
            clientId: input.clientId,
          });
          if (result.kind === 'posted') return result;
          const a = result.approval;
          return {
            kind: 'pending' as const,
            approval: {
              id: a.id,
              accountId: a.accountId,
              makerUserId: a.makerUserId,
              checkerUserId: a.checkerUserId,
              fromSpaceId: a.fromSpaceId,
              toSpaceId: a.toSpaceId,
              assetId: a.assetId,
              amount: formatAmount(a.amount),
              status: a.status,
              transferId: a.transferId,
              holdLedgerTxId: a.holdLedgerTxId,
              ledgerTxId: a.ledgerTxId,
              createdAt: a.createdAt.toISOString(),
            },
          };
        }),
      ),

    approve: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ approvalId: z.string().uuid(), stepUpApprovalId: stepUpApprovalField }))
      .output(z.object({ transferId: z.string(), ledgerTxId: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              approveBinding({ actor: ctx.principal.userId, approvalId: input.approvalId }),
              input.stepUpApprovalId,
            );
          }
          return bank.business.approve({ approvalId: input.approvalId, checkerUserId: ctx.principal.userId });
        }),
      ),

    reject: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ approvalId: z.string().uuid() }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          await bank.business.reject({ approvalId: input.approvalId, checkerUserId: ctx.principal.userId });
          return { ok: true as const };
        }),
      ),

    cancel: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ approvalId: z.string().uuid() }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          await bank.business.cancel({ approvalId: input.approvalId, actorUserId: ctx.principal.userId });
          return { ok: true as const };
        }),
      ),

    pending: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().uuid(),
          /**
           * Page size. Optional so omit reaches `bank.business_pending_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            accountId: z.string(),
            makerHandle: z.string().nullable(),
            makerHandleReason: z.enum(['handle_unresolved']).nullable(),
            receiverOwnerHandle: z.string().nullable(),
            receiverOwnerHandleReason: z.enum(['handle_unresolved']).nullable(),
            receiverOwnerName: z.string().nullable(),
            fromSpaceId: z.string(),
            toSpaceId: z.string(),
            assetId: z.string(),
            amount: amountString,
            status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
            transferId: z.string().nullable(),
            holdLedgerTxId: z.string().nullable(),
            ledgerTxId: z.string().nullable(),
            createdAt: z.string(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.business.listPending(input.accountId, ctx.principal.userId, input.limit);
          return rows.map((a) => ({
            id: a.id,
            accountId: a.accountId,
            makerHandle: a.makerHandle,
            makerHandleReason: a.makerHandleReason,
            receiverOwnerHandle: a.receiverOwnerHandle,
            receiverOwnerHandleReason: a.receiverOwnerHandleReason,
            receiverOwnerName: a.receiverOwnerName,
            fromSpaceId: a.fromSpaceId,
            toSpaceId: a.toSpaceId,
            assetId: a.assetId,
            amount: formatAmount(a.amount),
            status: a.status,
            transferId: a.transferId,
            holdLedgerTxId: a.holdLedgerTxId,
            ledgerTxId: a.ledgerTxId,
            createdAt: a.createdAt.toISOString(),
          }));
        }),
      ),

    members: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ accountId: z.string().uuid() }))
      .output(
        z.object({
          members: z.array(
            z.object({
              accountId: z.string(),
              userId: z.string(),
              role: z.enum(BUSINESS_ROLES),
              handle: z.string(),
            }),
          ),
          pendingControls: z.array(
            z.object({
              requestId: z.string(),
              kind: z.enum(['set_threshold', 'close']),
              spendThreshold: amountString.nullable(),
              proposedByHandle: z.string(),
              createdAt: z.string(),
            }),
          ),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const team = await bank.business.team(input.accountId, ctx.principal.userId);
          return {
            members: team.members,
            pendingControls: team.pendingControls.map((row) => ({
              requestId: row.requestId,
              kind: row.kind,
              spendThreshold: row.spendThreshold === null ? null : formatAmount(row.spendThreshold),
              proposedByHandle: row.proposedByHandle,
              createdAt: row.createdAt.toISOString(),
            })),
          };
        }),
      ),

    removeMember: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().uuid(),
          userId: z.string().min(1),
          requestId: z.string().uuid(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(z.object({ accountId: z.string(), userId: z.string(), removed: z.literal(true) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              removeMemberBinding({
                actor: ctx.principal.userId,
                accountId: input.accountId,
                userId: input.userId,
                requestId: input.requestId,
              }),
              input.stepUpApprovalId,
            );
          }
          return bank.business.removeMember({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            userId: input.userId,
            requestId: input.requestId,
          });
        }),
      ),

    setMemberRole: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().uuid(),
          userId: z.string().min(1),
          role: z.enum(BUSINESS_ROLES),
          requestId: z.string().uuid(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(z.object({ accountId: z.string(), userId: z.string(), role: z.enum(BUSINESS_ROLES) }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              setMemberRoleBinding({
                actor: ctx.principal.userId,
                accountId: input.accountId,
                userId: input.userId,
                role: input.role,
                requestId: input.requestId,
              }),
              input.stepUpApprovalId,
            );
          }
          return bank.business.setMemberRole({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            userId: input.userId,
            role: input.role,
            requestId: input.requestId,
          });
        }),
      ),

    resolveRecipientSpace: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().uuid(),
          assetId: z.string().min(1).max(16),
          handle: z.string().max(64).optional(),
          email: z.string().max(320).optional(),
        }),
      )
      .output(
        z.discriminatedUnion('found', [
          z.object({ found: z.literal(false) }),
          z.object({
            found: z.literal(true),
            handle: z.string(),
            assetId: z.string(),
            spaceId: z.string().uuid().nullable(),
          }),
        ]),
      )
      .query(async ({ ctx, input }) =>
        guard(async () =>
          bank.business.resolveRecipientSpace({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            assetId: input.assetId,
            handle: input.handle,
            email: input.email,
          }),
        ),
      ),

    approvals: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().uuid(),
          status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
          /**
           * Page size. Optional so omit reaches `bank.business_approvals_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
          cursor: z.string().min(1).max(512).optional(),
        }),
      )
      .output(
        z.object({
          items: z.array(
            z.object({
              id: z.string(),
              accountId: z.string(),
              makerHandle: z.string().nullable(),
              makerHandleReason: z.enum(['handle_unresolved']).nullable(),
              checkerHandle: z.string().nullable(),
              receiverOwnerHandle: z.string().nullable(),
              receiverOwnerHandleReason: z.enum(['handle_unresolved']).nullable(),
              receiverOwnerName: z.string().nullable(),
              fromSpaceId: z.string(),
              toSpaceId: z.string(),
              assetId: z.string(),
              amount: amountString,
              status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
              transferId: z.string().nullable(),
              holdLedgerTxId: z.string().nullable(),
              ledgerTxId: z.string().nullable(),
              createdAt: z.string(),
              decidedAt: z.string().nullable(),
            }),
          ),
          nextCursor: z.string().nullable(),
        }),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const page = await bank.business.listApprovals(input.accountId, ctx.principal.userId, {
            status: input.status,
            limit: input.limit,
            cursor: input.cursor,
          });
          return {
            nextCursor: page.nextCursor,
            items: page.items.map((a) => ({
              id: a.id,
              accountId: a.accountId,
              makerHandle: a.makerHandle,
              makerHandleReason: a.makerHandleReason,
              checkerHandle: a.checkerHandle,
              receiverOwnerHandle: a.receiverOwnerHandle,
              receiverOwnerHandleReason: a.receiverOwnerHandleReason,
              receiverOwnerName: a.receiverOwnerName,
              fromSpaceId: a.fromSpaceId,
              toSpaceId: a.toSpaceId,
              assetId: a.assetId,
              amount: formatAmount(a.amount),
              status: a.status,
              transferId: a.transferId,
              holdLedgerTxId: a.holdLedgerTxId,
              ledgerTxId: a.ledgerTxId,
              createdAt: a.createdAt.toISOString(),
              decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
            })),
          };
        }),
      ),

    setThreshold: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          accountId: z.string().uuid(),
          spendThreshold: amountString,
          requestId: z.string().uuid(),
        }),
      )
      .output(
        z.object({
          status: z.enum(['pending', 'applied']),
          requestId: z.string(),
          account: businessAccountOutput,
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const result = await bank.business.setThreshold({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            spendThreshold: parseAmount(input.spendThreshold),
            requestId: input.requestId,
          });
          return {
            status: result.status,
            requestId: result.requestId,
            account: {
              id: result.account.id,
              name: result.account.name,
              assetId: result.account.assetId,
              spendThreshold: formatAmount(result.account.spendThreshold),
              status: result.account.status,
              createdAt: result.account.createdAt.toISOString(),
            },
          };
        }),
      ),

    close: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().uuid(), requestId: z.string().uuid() }))
      .output(
        z.object({
          status: z.enum(['pending', 'applied']),
          requestId: z.string(),
          account: businessAccountOutput,
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const result = await bank.business.closeAccount({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            requestId: input.requestId,
          });
          return {
            status: result.status,
            requestId: result.requestId,
            account: {
              id: result.account.id,
              name: result.account.name,
              assetId: result.account.assetId,
              spendThreshold: formatAmount(result.account.spendThreshold),
              status: result.account.status,
              createdAt: result.account.createdAt.toISOString(),
            },
          };
        }),
      ),

    cancelControl: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ accountId: z.string().uuid(), requestId: z.string().uuid() }))
      .output(
        z.object({
          status: z.enum(['cancelled']),
          requestId: z.string(),
          account: businessAccountOutput,
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const result = await bank.business.cancelControl({
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            requestId: input.requestId,
          });
          return {
            status: result.status,
            requestId: result.requestId,
            account: {
              id: result.account.id,
              name: result.account.name,
              assetId: result.account.assetId,
              spendThreshold: formatAmount(result.account.spendThreshold),
              status: result.account.status,
              createdAt: result.account.createdAt.toISOString(),
            },
          };
        }),
      ),

    /**
     * Atomic multi-recipient payroll. One ledger post. Cross-asset lines
     * refuse `bank.business_payroll_rate_unset` — rates are owner law, never invented.
     */
    myRole: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ accountId: z.string().uuid() }))
      .output(z.object({ role: z.enum(BUSINESS_ROLES) }))
      .query(async ({ ctx, input }) => guard(async () => ({ role: await bank.business.myRole(input.accountId, ctx.principal.userId) }))),

    runPayroll: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          payrollId: z.string().uuid(),
          accountId: z.string().uuid(),
          fromSpaceId: z.string().uuid(),
          recipients: z
            .array(z.object({ toSpaceId: z.string().uuid(), amount: amountString }))
            .min(1)
            .max(64),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(
        z.object({
          payrollId: z.string(),
          accountId: z.string(),
          fromSpaceId: z.string(),
          assetId: z.string(),
          ledgerTxId: z.string(),
          recipients: z.array(z.object({ toSpaceId: z.string(), amount: amountString })),
          createdAt: z.string(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              runPayrollBinding({
                actor: ctx.principal.userId,
                payrollId: input.payrollId,
                accountId: input.accountId,
                fromSpaceId: input.fromSpaceId,
                assetId: await assetOfSpace(input.fromSpaceId),
                recipients: input.recipients,
              }),
              input.stepUpApprovalId,
            );
          }
          const run = await bank.business.runPayroll({
            payrollId: input.payrollId,
            accountId: input.accountId,
            actorUserId: ctx.principal.userId,
            fromSpaceId: input.fromSpaceId,
            recipients: input.recipients.map((r) => ({ toSpaceId: r.toSpaceId, amount: parseAmount(r.amount) })),
          });
          return {
            payrollId: run.payrollId,
            accountId: run.accountId,
            fromSpaceId: run.fromSpaceId,
            assetId: run.assetId,
            ledgerTxId: run.ledgerTxId,
            recipients: run.recipients.map((r) => ({ toSpaceId: r.toSpaceId, amount: formatAmount(r.amount) })),
            createdAt: run.createdAt.toISOString(),
          };
        }),
      ),

    /**
     * May this person approve for a team? Asked by svc-pay before it counts an approval on a multi-approval withdrawal
     * (W-withdraw-11). Service-only: `serviceProcedureFor` proves the caller is svc-pay before the input is parsed. A read; a
     * POST only because the caller signs the body.
     */
    approverEligibility: serviceProcedureFor(BANK_APPROVER_ELIGIBILITY_CALLERS)
      .input(bankApproverEligibilityInputSchema)
      .output(bankApproverEligibilitySchema)
      .mutation(async ({ input }) => guard(async () => bank.business.approverEligibility(input.accountId, input.userId))),
  });

  return router({
    health: publicProcedure
      .output(z.object({ ok: z.boolean(), service: z.literal('svc-bank') }))
      .query(() => ({ ok: true, service: 'svc-bank' as const })),
    /**
     * Paycheck deposit into the bank. Refuses until a paycheck rail exists.
     * The amount is not credited. Business payroll is a different action.
     */
    directDeposit: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ amount: amountString.optional() }).optional())
      .output(z.object({ deposit: z.null() }))
      .mutation(() =>
        guard(async () => {
          bank.spaces.directDeposit();
          return { deposit: null };
        }),
      ),
    spaces,
    transfers,
    earn,
    loans,
    cards,
    ramps,
    deposits: router({
      /**
       * Assets custody says can be paid in. A blank port refuses
       * `bank.deposit_custody_unset`. Minimums are the port's decimals.
       */
      assets: scopedProcedure('bank:read', { module: 'bank' })
        .output(
          z.object({
            assets: z.array(
              z.object({
                assetId: z.string(),
                networks: z.array(
                  z.object({
                    id: z.string(),
                    label: z.string(),
                    minimumDeposit: amountString,
                    confirmationsRequired: z.number().int().nonnegative(),
                    estimatedArrivalMinutes: z.number().int().nonnegative(),
                  }),
                ),
              }),
            ),
          }),
        )
        .query(() => guard(async () => bank.deposits.assets())),

      /**
       * Idempotent on (asset, network). The address is the one custody issued.
       * A blank port refuses before any row.
       */
      address: scopedProcedure('bank:write', { module: 'bank' })
        .input(z.object({ assetId: z.string().min(1).max(16), networkId: z.string().min(1).max(32) }))
        .output(
          z.object({
            assetId: z.string(),
            networkId: z.string(),
            address: z.string(),
            memo: z.string().nullable(),
            qrPayload: z.string().nullable(),
          }),
        )
        .mutation(async ({ ctx, input }) =>
          guard(async () => bank.deposits.address({ userId: ctx.principal.userId, assetId: input.assetId, networkId: input.networkId })),
        ),

      /**
       * Incoming deposits custody is still confirming. A blank port refuses.
       * An empty list means custody is connected and nothing is incoming.
       */
      pending: scopedProcedure('bank:read', { module: 'bank' })
        .output(
          z.object({
            items: z.array(
              z.object({
                id: z.string(),
                assetId: z.string(),
                networkId: z.string(),
                amount: amountString,
                confirmations: z.number().int().nonnegative(),
                confirmationsRequired: z.number().int().nonnegative().nullable(),
              }),
            ),
          }),
        )
        .query(async ({ ctx }) => guard(async () => bank.deposits.pending(ctx.principal.userId))),

      /**
       * The customer's own deposit history with its state and reason (W-deposit-05). Filters: coin, network, status, tx id,
       * address. A page with the true total. A blank port refuses `bank.deposit_custody_unset`.
       */
      list: scopedProcedure('bank:read', { module: 'bank' })
        .input(
          z
            .object({
              assetId: z.string().min(1).max(16).optional(),
              networkId: z.string().min(1).max(32).optional(),
              status: z.enum(PAY_CUSTODY_DEPOSIT_STATUSES).optional(),
              txId: z.string().min(1).max(128).optional(),
              address: z.string().min(1).max(256).optional(),
              offset: z.number().int().min(0).max(1_000_000).default(0),
              limit: z.number().int().min(1).max(PAY_CUSTODY_DEPOSIT_RECORDS_MAX_LIMIT).default(50),
            })
            .default({}),
        )
        .output(z.object({ items: z.array(payCustodyDepositRecordSchema), total: z.number().int().nonnegative() }))
        .query(async ({ ctx, input }) => guard(async () => bank.deposits.list(ctx.principal.userId, input))),
    }),
    autoInvest,
    business,
    analytics,
    portfolio,
    activity: createActivityRouter(bank),
    statements: createStatementsRouter(bank),
    accountDetails: createAccountDetailsRouter(bank, guard),
    eligibility: createEligibilityRouter(bank, guard),
    /** BK-loan-10 credit card preview: TEST rows and typed Preview refusals only. */
    creditCard: createCreditCardPreviewRouter(),
    bills: createBillsRouter(bank, stepUp),
    global: createGlobalRouter(bank, stepUp),
    personalRequest: createPersonalRequestRouter(bank, guard),
    limits: createLimitsRouter(limitRequests, guard),
    ops,
  });
}

export type BankRouter = ReturnType<typeof createBankRouter>;
