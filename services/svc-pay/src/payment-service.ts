import { heldClearingOf, type HeldClearing } from './payment-service/funds.js';
import { checkoutUrlFor, paymentLinkCreateFingerprint, paymentLinkCreateKey } from './payment-link-create.js';
import { linkPrice } from './link-price.js';
import { checkoutLookOf, type CheckoutLook } from './checkout-branding/branding.js';
import {
  confirmationFingerprint,
  parseInactiveMessage,
  parseLinkConfirmation,
  paymentLinkEmbedSnippet,
  type LinkConfirmation,
} from './payment-link-share.js';
import {
  type BookedCaptureCompletion,
  type CaptureReconcileInput,
  type CaptureReconcileMode,
  type CaptureReconcileReport,
} from './capture-reconcile.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { preparePaymentAdmission, type PreparedPaymentOperation } from './payment-admission.js';
import { FRESH, NOOP_GUARDS, type GuardReplay, type PayGuards } from './seams/guards.js';
import { type PayHaltStore } from './halts/store.js';
import type { PayHaltTarget } from './halts/types.js';
import type { OwnerIdentityAuthorityPort } from './payment-authority.js';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, type Amount, type LedgerClient, type LedgerTx, type PostRequest } from '@intafaced/ledger-client';
import { liveAccountsIn } from './sandbox-ledger-guard.js';
import { type PaymentIntent, type RailAdapter, type RailEvent, type RailWebhookRequest } from './rails/rail-adapter.js';
import type { RailRegistry } from './rails/registry.js';
import { PublicCheckoutUnavailable, type ValueMovementPolicy } from './rails/posture.js';
import {
  REFERENCE_RAIL_ROUTING_PROFILES,
  selectSmartCheckoutRail,
  SmartRoutingApprovalRateUnsetError,
  SmartRoutingNoRailError,
  toRoutingDecisionRecord,
  type RailRoutingProfile,
} from './routing/decide.js';
import { RoutingInputError } from './routing-inputs.js';
import { merchantKybMoneyGateRefusal } from './merchant-kyb-money-gate.js';
import { assertCategoryAllows, categoryRails, checkoutCategoryRule } from './onboarding-policy/category.js';
import { methodRailsOf, type MethodRails } from './checkout-methods/catalogue.js';
import { checkoutMethodFor } from './checkout-methods/methods.js';
import { givenPayerName, type PayerNameMatchRule } from './payer-name/match.js';
import { NAME_CHECKED_METHOD, isHeldOpenPayment, recordGivenPayerName } from './payer-name/holds.js';
import { assertOnlyPayoutDestinations, type MerchantPayoutDestinations } from './merchant-payout-destination.js';
import { encodeListCursor } from './list-page.js';
import { type PaymentAttemptView } from './payments/attempts.js';
import { type PaymentListSummary } from './payments/list-summary.js';
import { type MerchantFailure } from './merchant-failure.js';
import { type StoredPricingSnapshot } from './control/snapshots.js';
import { type IdentityPayoutAdmissionPort } from './payout-admission.js';
import { chargebackLedgerEffect, type ChargebackLedgerEffect } from './chargeback-ledger-effect.js';
import {
  defaultDisputeCaseStore,
  type ChargebackLedgerRefuse,
  type DisputeCaseStatus,
  type DisputeCaseStore,
  type RailResolutionOutcome,
} from './fraud/dispute-case.js';
import { NoopAffiliateAccrue, type AffiliateAccruePort } from './affiliate-accrue.js';
import { NoopAffiliatePayout, type AffiliatePayoutPort } from './affiliate-payout.js';
import {
  listMerchantPayoutDestinations,
  removeMerchantPayoutDestination,
  setDefaultMerchantPayoutDestination,
} from './portal-reads/destinations.js';
import { readPayoutLifecycle as readPayoutLifecycleProjection } from './portal-reads/lifecycle.js';
import { listMerchantRefunds, locateRefundMerchant, readMerchantRefund } from './portal-reads/refunds.js';
import { listMerchantStatement } from './portal-reads/statement.js';
import * as merchants from './payment-service/merchants.js';
import * as paymentReads from './payment-service/payment-reads.js';
import * as lifecycle from './payment-service/lifecycle.js';
import * as refunds from './payment-service/refunds.js';
import * as webhooks from './payment-service/webhooks.js';
import * as settlement from './payment-service/settlement.js';
import * as payouts from './payment-service/payouts.js';
import * as chargebacks from './payment-service/chargebacks.js';
import {
  PayError,
  assertOwnerPageLimit,
  toMerchant,
  listFilters,
  paymentCreationPayload,
  insertPayment,
  appendEvent,
  totalsFor,
  toPayment,
} from './payment-service/internal.js';

export {
  PayError,
  assertPaymentHistoryLimit,
  assertPaymentListLimit,
  assertSettlementListLimit,
  publishedDefaultFeeBps,
} from './payment-service/internal.js';

/**
 * svc-pay — THE PAYMENTS CORE (§6.1).
 *
 * Gateway mode only in this PR. PSP mode, PayFac trees, smart routing, fraud
 * scoring, the checkout builder, subscriptions and plugins are each their own
 * tracker feature; none of them changes anything in this file, which is the
 * point of the shape it has.
 *
 * THREE RULES GOVERN EVERY METHOD HERE.
 *
 * 1. Value moves only through a ledger recipe (Doctrine §0.6). This service
 *    holds no balance. What it holds is a payment id, a merchant id, and an
 *    opinion about what should happen next.
 *
 * 2. Idempotency keys are business keys. `payment.capture:<paymentId>`,
 *    `settlement:<merchantId>:<window>:<assetId>`. A PSP webhook WILL be
 *    delivered twice; that is normal, not exceptional, and every path here is
 *    written on the assumption that it already has been.
 *
 * 3. Every transition appends to `payment_events`. Nothing is overwritten —
 *    the database enforces it with a trigger. `payments.status` is a
 *    projection; the event log is the truth, and it is what the captured and
 *    refunded totals are computed from rather than a column that could drift.
 *
 * ORDERING, AND WHOSE FUNDS ARE STRANDED IF THIS CRASHES EXACTLY HERE.
 *
 * The rule that decides operation order is the direction of the money:
 *
 *   INBOUND  (capture) — the rail moves first, the ledger books second. We only
 *                        ever book value we know has arrived. A crash between
 *                        them leaves money at the rail that is not yet in the
 *                        book: the classic "captured but not settled". Nothing
 *                        is lost, because both halves are idempotent on the
 *                        payment id and re-running finishes the job.
 *
 *   OUTBOUND (refund, payout) — the LEDGER moves first, the rail second. The
 *                        merchant must be shown to have the money before any of
 *                        it is sent somewhere irreversible. A crash between them
 *                        leaves the book correct and a status projection behind,
 *                        which is a reporting problem, not a money problem.
 *
 * Getting those two the wrong way round is how a gateway sends a refund out of
 * a balance that could not cover it.
 */

export type PaymentStatus = 'created' | 'authorized' | 'captured' | 'settled' | 'refunded' | 'disputed' | 'failed';
export type SettlementStatus = 'pending' | 'posted' | 'paid_out' | 'failed';

export type PayErrorCode =
  | 'pay.merchant_not_found'
  /** The principal does not own this merchant. One rule, in merchant-ownership.ts. */
  | 'pay.merchant_forbidden'
  /** Opening an account must not return a row that already has a parent. */
  | 'pay.merchant_parent_present'
  /** `PAY_MERCHANT_STARTER_FEE_BPS` is unset. Blank is not a fee. */
  | 'pay.starter_fee_unpublished'
  | 'pay.dispute_not_found'
  /**
   * Principal is in the subject's PayFac tree but lacks the named permission area.
   * Distinct from merchant_forbidden so a parent that was never granted refund
   * does not look like a stranger.
   */
  | 'pay.submerchant_permission_denied'
  | 'pay.merchant_inactive'
  | 'pay.merchant_pricing_invalid'
  /** A merchant name that is blank, over 120 characters or holds a control character. */
  | 'pay.merchant_name_invalid'
  /** Owner `PAY_DEFAULT_FEE_BPS` unpublished. Blank env is not 0. */
  | 'pay.fee_bps_unset'
  /** KYB transition refused (wrong status, or stub decide blocked under live-only). */
  | 'pay.kyb_invalid'
  | 'pay.kyb_operator_required'
  /** The approval was reviewed against a different merchant identity. */
  | 'pay.kyb_identity_changed'
  /** decideKyb has no database, so it cannot bind the approval to the live identity. */
  | 'pay.kyb_profile_unbound'
  /**
   * Live acquiring money door — merchant lacks approved KYB (D26-P1-P10 Layer B).
   * Distinct from scope issuance (Layer A); never invents `pay:*`.
   */
  | 'pay.kyb_required'
  /** RC-merchant-08: the business's category is prohibited; no payment or checkout session is opened. */
  | 'pay.category_prohibited'
  | 'pay.category_not_chosen'
  /** RC-merchant-08: the business's category is restricted and its reserve terms are blank. */
  | 'pay.reserve_terms_unset'
  /** RC-merchant-08: the business's category takes payments on the crypto-native rail only. */
  | 'pay.category_rail_refused'
  | 'pay.payment_not_found'
  /** payment.list page size unpublished. Blank is not 50. */
  | 'pay.payment_list_limit_unset'
  /** payment.history page size unpublished. Blank is not 50 — never dump every payment_events row. */
  | 'pay.payment_history_limit_unset'
  /** merchant.listLinks page size unpublished. Blank is not 50 — never dump every link. */
  | 'pay.payment_link_list_limit_unset'
  | 'pay.profile_not_found'
  | 'pay.link_not_found'
  /** The link is off and the merchant stored a sentence for the payer. */
  | 'pay.link_inactive'
  | 'pay.link_expired'
  /** The link's `maxUses` has been reached. Never resolved by retrying. */
  | 'pay.link_exhausted'
  /** A merchant asked for a link that never expires, or one past the lifetime cap. */
  | 'pay.link_expiry_invalid'
  /** Confirmation message or redirect was blank. Nothing was stored. */
  | 'pay.link_confirmation_unset'
  /** Confirmation redirect was not an https address. Nothing was stored. */
  | 'pay.link_redirect_not_https'
  /** Owner `PAY_LINK_DEFAULT_TTL_DAYS` unpublished. Blank env is not 30. */
  | 'pay.link_ttl_unset'
  /** Owner `PAY_LINK_MAX_TTL_DAYS` unpublished. Blank env is not 365. */
  | 'pay.link_max_ttl_unset'
  // ── Hosted checkout (public, unauthenticated — `openCheckoutSession`) ──
  /** Owner `PAY_CHECKOUT_SESSION_TTL_SECONDS` unpublished. Blank env is not 900. */
  | 'pay.checkout_session_ttl_unset'
  /** Owner `PAY_CHECKOUT_MAX_OPEN_SESSIONS` unpublished. Blank env is not 25. */
  | 'pay.checkout_max_open_sessions_unset'
  | 'pay.checkout_session_not_found'
  | 'pay.checkout_session_expired'
  /** The session is completed or cancelled — anything but open. */
  | 'pay.checkout_session_closed'
  /** A variable-amount link needs the payer to say how much. */
  | 'pay.checkout_amount_required'
  /** Too many sessions open on one link. The cheap floor under an anonymous caller. */
  | 'pay.checkout_busy'
  /** Public checkout rail list is empty — refuse by name, never a silent charge. */
  | 'pay.checkout_rails_unset'
  /** Card/PSP acquiring unset (`socket.psp-partners`) — refuse by name, never fake success. */
  | 'pay.psp_unset'
  /**
   * Smart routing (D26-P1-P3) — a required geo/method/risk dim was blank.
   * Never invent a country, method, risk band, or approval rate.
   */
  | 'pay.routing_input_missing'
  /** Smart routing ran; no configured rail honestly accepts these dims. */
  | 'pay.routing_no_rail'
  /** Smart routing ran; no rail that could take it has an owner-declared success fraction (PAY_CHECKOUT_SUCCESS_RATES). */
  | 'pay.routing_approval_rate_unset'
  /** M-adv-payments-core-11: more than one method the business offers can take this payment; the payer picks one. */
  | 'pay.checkout_method_required'
  /** M-adv-payments-core-11: the payer named a method the business does not offer for this payment. */
  | 'pay.checkout_method_not_offered'
  /** M-adv-payments-core-11: none of the methods the business offers for this payment has a rail. */
  | 'pay.checkout_no_method'
  /** RC-merchant-09: a bank transfer needs the name on the payer's bank account before it opens. Nothing was written. */
  | 'pay.payer_name_required'
  /** RC-merchant-09: the bank transfer's name did not pass the owner's rule; the payment is held for review and nothing moves. */
  | 'pay.payer_name_held'
  | 'pay.invalid_amount'
  | 'pay.identity_admission_unavailable'
  | 'pay.identity_admission_denied'
  | 'pay.identity_admission_conflict'
  | 'pay.payout_admission_missing'
  | 'pay.payout_recovery_conflict'
  | 'pay.invalid_transition'
  | 'pay.capture_exceeds_authorized'
  | 'pay.partial_capture_unsupported'
  /** PAY_CAPTURE_RECONCILE is off. The job refuses and does not read payments. */
  | 'pay.capture_reconcile_disabled'
  /** Reconcile batch size unpublished. Blank is not a default pass. */
  | 'pay.capture_reconcile_batch_limit_unset'
  | 'pay.refund_exceeds_captured'
  /** Refund refused — nothing was captured. Before ledger-client posts. */
  | 'pay.nothing_captured'
  | 'pay.refund_in_flight'
  /**
   * An explicit `refundId` already ran to `refund.reversed` (rail refused after
   * the merchant was debited and the reverse posted). The ledger key
   * `payment.refund:<paymentId>:<refundId>` is spent: a re-post is a silent
   * no-op, so reusing the id would let the rail pay out while the book does not
   * re-debit. Caller must supply a **new** business key for a genuine second attempt.
   */
  | 'pay.refund_id_spent'
  | 'pay.refund_id_conflict'
  /** A redelivered chargeback names a different amount than the opening already planned for that dispute. */
  | 'pay.chargeback_plan_conflict'
  /** Merchant pots cannot cover the dispute and the insurance fund cannot cover the rest. */
  | 'pay.chargeback_shortfall_unfunded'
  /** A won or lost ledger post failed. The dispute row was not moved. */
  | 'pay.chargeback_ledger_failed'
  /** The outcome lock was not acquired within 2s. Nothing was posted and the rail can redeliver. */
  | 'pay.chargeback_outcome_busy'
  /**
   * A pending settlement window has already frozen this payment into its set.
   * Pre-settlement refunds would drain clearing under the frozen gross and let
   * a later post take another payment's funds (or stick forever). Wait for the
   * window to post, then refund from the merchant's available balance.
   */
  | 'pay.settlement_in_flight'
  /**
   * Frozen settlement numbers no longer match live captured−refunded totals.
   * Refusing to post is the only honest answer — inventing a new gross under the
   * same settlement key would disagree with the ledger idempotency key.
   */
  | 'pay.settlement_desynced'
  /**
   * This window's ledger key already holds a personal-balance settlement whose
   * amounts do not match the frozen row. Releasing it would free the payments
   * for a second credit, so the row stays pending.
   */
  | 'pay.settlement_ledger_conflict'
  /**
   * A settlement key is missing, or its post is neither the personal-balance
   * shape nor the proceeds shape. Paying, refunding, or adopting it would
   * guess which pot holds the net.
   */
  | 'pay.settlement_book_unrecognised'
  | 'pay.settlement_not_pending'
  | 'pay.settlement_released'
  | 'pay.settlement_exceeds_proceeds'
  | 'pay.rail_declined'
  | 'pay.rail_failed'
  | 'pay.rail_outcome_unknown'
  | 'pay.ledger_outcome_unknown'
  | 'pay.rail_amount_mismatch'
  | 'pay.rail_pending'
  | 'pay.webhook_invalid'
  | 'pay.webhook_unmatched'
  /** Merchant outbound webhook endpoint URL refused (ADR §2.4). */
  | 'pay.webhook_url_invalid'
  | 'pay.webhook_endpoint_not_found'
  /**
   * Outbound merchant webhooks are not wired on this process (REST asked, no
   * service) or a delivery has no signing secret. Named refuse — never HMAC
   * with an empty key, never a Fastify 404 that looks like the surface is gone.
   */
  | 'pay.webhook_not_configured'
  /** webhook-deliveries list page size unpublished. Blank is not 50. */
  | 'pay.webhook_delivery_list_limit_unset'
  /** webhook-endpoints list page size unpublished. Blank is not 50 — never dump every endpoint. */
  | 'pay.webhook_endpoint_list_limit_unset'
  | 'pay.nothing_to_settle'
  | 'pay.payout_clearing_pending'
  | 'pay.fee_exceeds_gross'
  | 'pay.invalid_window'
  | 'pay.settlement_not_found'
  /** settlement.list page size unpublished. Blank is not 50. */
  | 'pay.settlement_list_limit_unset'
  /** A refund event id that is missing or not this caller's. Same refusal either way. */
  | 'pay.refund_not_found'
  /** Destination inventory page size unpublished. Blank is not 50. */
  | 'pay.destination_list_limit_unset'
  /** No saved destination with this id for this merchant. Same answer as a foreign id. */
  | 'pay.payout_destination_not_found'
  /** Remove refused: a payout that still names this destination has not finished. */
  | 'pay.payout_destination_in_flight'
  /** Remove refused: a verified destination changes only through step-up plus the hold. */
  | 'pay.payout_destination_verified_locked'
  /** Refund list page size unpublished. Blank is not 50. */
  | 'pay.refund_list_limit_unset'
  /** Statement page size unpublished. Blank is not 50. */
  | 'pay.statement_list_limit_unset'
  /** `merchant.statement.list` without both `from` and `to`. A statement is not the whole history. */
  | 'pay.statement_range_required'
  /** Statement window longer than the 92-day technical safety bound. */
  | 'pay.statement_range_too_wide'
  /** More than 2000 candidate ledger keys in one statement request. */
  | 'pay.statement_too_large'
  /** A statement scan for this merchant is still leased, or this process is already running two. */
  | 'pay.statement_busy'
  | 'pay.list_cursor_invalid'
  | 'pay.list_search_invalid'
  | 'pay.list_asset_invalid'
  | 'pay.list_range_invalid'
  /** Amount filter was blank or not a decimal string. Not treated as zero. */
  | 'pay.list_amount_invalid'
  /** amountMin is above amountMax. */
  | 'pay.list_amount_range_invalid'
  /** The count query did not return integer text. The page is not guessed. */
  | 'pay.list_summary_unreadable'
  /** A stored checkout profile is not an object, or its domain list is not strings. */
  | 'pay.checkout_settings_unreadable'
  // ── User money in and out (`user-money-service.ts`) ──
  | 'pay.rail_unknown'
  /** The rail exists but does not accept hand-typed operator credits. */
  | 'pay.rail_not_creditable'
  /** A rail reference already credited something else. Never resolved by retrying. */
  | 'pay.deposit_conflict'
  | 'pay.withdrawal_not_found'
  /** The history / eligibility reads are not wired in this process. */
  | 'pay.withdrawal_history_unwired'
  | 'pay.withdrawal_eligibility_unwired'
  /** Funds from a card, ACH or PayPal purchase are held: tradable, not withdrawable until release (W-withdraw-13). */
  | 'pay.withdrawal_amount_held'
  /** Held funds exist and the owner has not set the release period; it is never guessed. */
  | 'pay.purchase_hold_period_unset'
  /** A page cursor this history never issued. */
  | 'pay.withdrawal_cursor_invalid'
  | 'pay.withdrawal_not_cancellable'
  | 'pay.withdrawal_not_reversible'
  | 'pay.withdrawal_canceled'
  /** W-withdraw-14: the address is one of the sender's own deposit addresses on the platform. Nothing is claimed. */
  | 'pay.withdrawal_self_send'
  /** W-withdraw-14: an internal send named an address that belongs to no account on the platform. */
  | 'pay.internal_destination_external'
  /** W-withdraw-14: the platform address is frozen, past its expiry, or names more than one account; nothing is claimed. */
  | 'pay.internal_destination_unavailable'
  /** W-withdraw-14: this process has no svc-bank client for internal settlement. */
  | 'pay.internal_settlement_unwired'
  /** W-withdraw-14: svc-bank proved nothing was posted and refused the send (`failureCode` names its reason). */
  | 'pay.internal_settlement_refused'
  | 'pay.internal_asset_unsupported'
  | 'pay.withdrawal_platform_address'
  /**
   * J-wallet-05 #6 (issue #6517): a send out of the platform goes only to an address svc-bank's address book holds for that
   * asset on that network, approved and past its cooling-off. Each answer that is not `ready` has its own code; nothing is
   * claimed or held. `_unavailable`: the address book could not be asked.
   */
  | 'pay.withdrawal_destination_not_saved'
  | 'pay.withdrawal_destination_network_mismatch'
  | 'pay.withdrawal_destination_unapproved'
  | 'pay.withdrawal_destination_cooling'
  | 'pay.withdrawal_destination_cooling_unset'
  | 'pay.withdrawal_destination_locked'
  | 'pay.withdrawal_destination_blocked'
  | 'pay.withdrawal_destination_unavailable'
  /** svc-ledger refused a withdrawal post whose fee is not its hold's (`ledger.withdraw_fee_unbound`): nothing posted, an operator looks. */
  | 'pay.withdrawal_fee_unbound'
  /** No custody signer for the network a send out of the platform names (or none named): refused before any claim or hold. */
  | 'pay.wallet_withdraw_unavailable'
  /** W-withdraw-06: no owner-set depth for a send out of the platform to settle at (`PAY_WITHDRAW_MIN_CONFIRMATIONS` blank): refused before any claim or hold. */
  | 'pay.withdraw_confirmations_unset'
  /** A send names a tag or memo on a network whose rules take none (J-wallet-05 #1): refused before anything is asked or held. */
  | 'pay.withdrawal_tag_not_taken'
  /** A send names a tag on a network that takes one: svc-pay keeps no tag for a send, so it is refused, never dropped. */
  | 'pay.withdrawal_tag_unsupported'
  | 'pay.wallet_fee_unset'
  | 'pay.wallet_cap_unset'
  | 'pay.wallet_forbidden'
  | 'pay.wallet_not_found'
  | 'pay.wallet_unconfigured'
  /** withdrawal.mine page size unpublished. Blank is not 50. */
  | 'pay.withdrawal_list_limit_unset'
  /** A client reference already names a different withdrawal. */
  | 'pay.withdrawal_conflict'
  /** Row already terminal-failed; caller must open a new clientRef. */
  | 'pay.withdrawal_failed'
  /**
   * Live API key named a sandbox rail (or deployment refused sandbox value
   * movement). ADR pay.public-api §2.5 / posture assertRailMayMoveValue.
   */
  | 'pay.sandbox_rail_refused'
  /**
   * A sandbox API key would have observed or returned a live-mode payment.
   * Sandbox credentials must not look live (ADR §2.5).
   */
  | 'pay.sandbox_looks_live'
  /**
   * A sandbox key, or a payment created with one, named a recipe whose
   * accounts are the live book (clearing, proceeds, the owner's balance,
   * house fees, the insurance fund, or a live rail). NOTHING WAS POSTED.
   */
  | 'pay.sandbox_live_account_refused'
  /**
   * Payment has no rail id, so `mode` cannot be disclosed. Refusing is the
   * safe direction — defaulting missing rail to `live` is the lie.
   */
  | 'pay.rail_mode_undisclosed'
  /** Request body failed a surface-level validation (missing railAdapter, …). */
  | 'pay.validation_failed'
  /**
   * Payout destination kind does not match the rail (e.g. IBAN on crypto-native).
   * Refused BEFORE withdrawHold so no ledger row is left stranded.
   */
  | 'pay.destination_kind_mismatch'
  | 'pay.invalid_destination_ref'
  /** Crypto payout has no stored verified dest — refused BEFORE withdrawHold. */
  | 'pay.payout_destination_missing'
  /** settlement.payout named a destination. A payout cannot choose or change one. */
  | 'pay.payout_destination_not_allowed'
  /** PAY_DESTINATION_HOLD_SECONDS is blank. A destination change is refused. */
  | 'pay.destination_hold_unset'
  /** Destination add/change had no usable step-up approval. */
  | 'pay.destination_step_up_required'
  /** An API key cannot add or change a payout destination. */
  | 'pay.destination_api_key_refused'
  /** The session is not interactive (no MFA, or a sub-account). */
  | 'pay.destination_session_required'
  /** The caller is not an owner or admin of this merchant. */
  | 'pay.destination_role_forbidden'
  | 'pay.subscription_not_found'
  /** mandate.list page size unpublished. Blank is not 50. */
  | 'pay.subscription_mandate_list_limit_unset'
  /** subscription.list page size unpublished. Blank is not 50. */
  | 'pay.subscription_list_limit_unset'
  /** subscription.listExecutions page size unpublished. Blank is not 50. */
  | 'pay.subscription_execution_list_limit_unset'
  /** subscription.cycles page size unpublished. Blank is not 50. */
  | 'pay.subscription_cycle_list_limit_unset'
  /** runDueSubscriptions worker batch unpublished. Blank is not 50. */
  | 'pay.due_subscriptions_batch_limit_unset'
  /** processDue worker batch unpublished. Blank is not 25. */
  | 'pay.due_webhook_deliveries_batch_limit_unset'
  | 'pay.mandate_not_found'
  | 'pay.subscription_reconsent_required'
  | 'pay.subscription_inactive'
  | 'pay.mandate_inactive'
  | 'pay.subscription_invalid'
  | 'pay.subscription_driver_absent'
  | 'pay.mandate_rail_absent'
  /**
   * Recurring pre-charge notify is unpublished (`socket.pay-precharge-notify`).
   * Named refuse when a path would invent delivery or claim `notified: true`.
   * Crypto invoice-and-watch still opens an invoice; it must carry this code
   * on the cycle report so the gap is never a silent skip.
   */
  | 'pay.precharge_notify_unpublished'
  | 'pay.subscription_notify_unwired'
  | 'pay.subscription_notify_failed'
  // ── Recurring charge cycle (`subscriptions/charge-cycle.ts`) ──
  /**
   * The charge is larger than the mandate authorises, or falls outside its
   * window. Checked at the moment of the CHARGE, not the moment of the plan: a
   * period claimed under one mandate reading can be retried after those terms
   * were lowered or replaced. The mandate is the ceiling, in money and in time.
   */
  | 'pay.subscription_exceeds_mandate'
  /**
   * No fee rate is published for this merchant and no default is configured.
   * Refuse-closed, per the standing ruling that an unset rate does not fall back
   * to a source seed, a zero, or a "sensible default" — `fee-share-law.ts` is the
   * reference. Refused BEFORE the period is claimed, so the period stays owed and
   * no attempt is spent on an operator's configuration gap.
   */
  | 'pay.subscription_fee_unpublished'
  /**
   * An invoice for a period was still unpaid a full interval later. Not a
   * caller's mistake — the code exists so an unsettled period is a named fact
   * rather than a row that sits `invoiced` forever while the subscription
   * reports itself healthy and collects nothing.
   */
  | 'pay.subscription_invoice_unpaid'
  | 'pay.subscription_due_pass_fault'
  /**
   * Resuming would re-space periods past the mandate's `endsAt`.
   *
   * `adr/2026-08-08-twap-overdue-slice-disposition.md` forbids compressing the
   * schedule to fit and rejects silently dropping the tail. What is left is to
   * refuse and say by how much, so the merchant re-consents with a new mandate —
   * the same disposition that ADR gives a resume past 2× the original duration.
   */
  | 'pay.subscription_resume_exceeds_mandate'
  /**
   * Idempotency-Key was blank or longer than 255 characters — the same cap the
   * public REST door already uses. Nothing was written.
   */
  | 'pay.idempotency_required'
  /**
   * This Idempotency-Key is already stored for a different create body
   * (subscription.create or merchant.createLink). Replaying either result
   * would be a guess.
   */
  | 'pay.idempotency_conflict'
  /**
   * The mandate already has a subscription that is not cancelled and not
   * completed. Paused still counts: the schedule exists.
   */
  | 'pay.subscription_mandate_open'
  /** A subscription started from a catalogue price: no such price of this business. */
  | 'pay.price_not_found'
  /** That price is archived (or replaced), so nothing new starts on it. */
  | 'pay.price_archived'
  /** That price's product is archived, so nothing new starts on it. */
  | 'pay.product_archived'
  /** The mandate's asset, amount or cadence is not the price's: a monthly fixed price equal to the mandate's terms. */
  | 'pay.subscription_price_terms_differ'
  /** A payment link sells one payment of one amount: a monthly price or one the customer chooses is refused. */
  | 'pay.link_price_not_one_time'
  /** A payment link made from a price was sent an amount or asset that is not the price's. */
  | 'pay.link_price_terms_differ';

/** Owner link default lifetime unpublished. Blank PAY_LINK_DEFAULT_TTL_DAYS is not 30. */
export function publishedLinkDefaultTtlDays(days: number | null | undefined): number {
  if (days == null) {
    throw new PayError(
      'PAY_LINK_DEFAULT_TTL_DAYS is unset. Blank refuses — never 30. Owner must set a positive integer (30 is allowed if explicit).',
      'pay.link_ttl_unset',
    );
  }
  if (!Number.isInteger(days) || days < 1 || days > 3_650) {
    throw new PayError(`PAY_LINK_DEFAULT_TTL_DAYS must be an integer 1..3650, got ${days}`, 'pay.link_expiry_invalid');
  }
  return days;
}

/** Owner link max lifetime unpublished. Blank PAY_LINK_MAX_TTL_DAYS is not 365. */
export function publishedLinkMaxTtlDays(days: number | null | undefined): number {
  if (days == null) {
    throw new PayError(
      'PAY_LINK_MAX_TTL_DAYS is unset. Blank refuses — never 365. Owner must set a positive integer (365 is allowed if explicit).',
      'pay.link_max_ttl_unset',
    );
  }
  if (!Number.isInteger(days) || days < 1 || days > 3_650) {
    throw new PayError(`PAY_LINK_MAX_TTL_DAYS must be an integer 1..3650, got ${days}`, 'pay.link_expiry_invalid');
  }
  return days;
}

/** Owner checkout-session handoff unpublished. Blank PAY_CHECKOUT_SESSION_TTL_SECONDS is not 900. */
export function publishedCheckoutSessionTtlSeconds(seconds: number | null | undefined): number {
  if (seconds == null) {
    throw new PayError(
      'PAY_CHECKOUT_SESSION_TTL_SECONDS is unset. Blank refuses — never 900. Owner must set an integer 60..86400 (900 is allowed if explicit).',
      'pay.checkout_session_ttl_unset',
    );
  }
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86_400) {
    throw new PayError(`PAY_CHECKOUT_SESSION_TTL_SECONDS must be an integer 60..86400, got ${seconds}`, 'pay.checkout_session_ttl_unset');
  }
  return seconds;
}

/** Owner open-session cap unpublished. Blank PAY_CHECKOUT_MAX_OPEN_SESSIONS is not 25. */
export function publishedMaxOpenSessionsPerLink(n: number | null | undefined): number {
  if (n == null) {
    throw new PayError(
      'PAY_CHECKOUT_MAX_OPEN_SESSIONS is unset. Blank refuses — never 25. Owner must set an integer 1..10000 (25 is allowed if explicit).',
      'pay.checkout_max_open_sessions_unset',
    );
  }
  if (!Number.isInteger(n) || n < 1 || n > 10_000) {
    throw new PayError(`PAY_CHECKOUT_MAX_OPEN_SESSIONS must be an integer 1..10000, got ${n}`, 'pay.checkout_max_open_sessions_unset');
  }
  return n;
}

/** merchant.listLinks page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertPaymentLinkListLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.payment_link_list_limit_unset',
    200,
    'merchant.listLinks page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
  );
}

/** withdrawal.mine page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertWithdrawalListLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.withdrawal_list_limit_unset',
    200,
    'withdrawal.mine page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
  );
}

/** webhook-deliveries page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertWebhookDeliveryListLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.webhook_delivery_list_limit_unset',
    200,
    'webhook-deliveries page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
  );
}

/** webhook-endpoints page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertWebhookEndpointListLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.webhook_endpoint_list_limit_unset',
    200,
    'webhook-endpoints page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
  );
}

/** mandate.list page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertMandateListLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.subscription_mandate_list_limit_unset',
    200,
    'mandate.list page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
  );
}

/** subscription.list page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertSubscriptionListLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.subscription_list_limit_unset',
    200,
    'subscription.list page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
  );
}

/** subscription.listExecutions page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertExecutionListLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.subscription_execution_list_limit_unset',
    200,
    'subscription.listExecutions page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
  );
}

/** subscription.cycles page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertCycleListLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.subscription_cycle_list_limit_unset',
    200,
    'subscription.cycles page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
  );
}

/**
 * runDueSubscriptions worker batch unpublished. Blank / non-finite refuses.
 * Never invent 50. Owner may pass 50. Out-of-range is not clamped — the cron
 * door already refuses rather than silently shrinking a charge-cycle pass.
 */
export function assertDueSubscriptionsBatchLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new PayError(
      'runDueSubscriptions batch size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
      'pay.due_subscriptions_batch_limit_unset',
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new PayError(`limit must be an integer 1..500, got ${limit}`, 'pay.validation_failed');
  }
  return limit;
}

/**
 * processDue worker batch unpublished. Blank / non-finite refuses.
 * Never invent 25. Owner may pass 25. Out-of-range is not clamped.
 */
export function assertDueWebhookDeliveriesBatchLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new PayError(
      'processDue batch size is unset. Blank refuses — never 25. Pass a positive integer (25 is allowed if explicit).',
      'pay.due_webhook_deliveries_batch_limit_unset',
    );
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new PayError(`limit must be an integer 1..500, got ${limit}`, 'pay.validation_failed');
  }
  return limit;
}

/**
 * §6.1 "custom pricing", as this PR needs it: one rate, in basis points.
 *
 * Optional on read because the column is jsonb and a merchant onboarded by
 * another path may not have one. Settlement then refuses to run rather than
 * quietly settling at zero — see `PayServiceOptions.defaultFeeBps`.
 */
export interface MerchantPricing {
  readonly feeBps?: number;
}

export interface MerchantRecord {
  id: string;
  userId: string;
  mode: 'gateway' | 'psp' | 'payfac';
  tier: number;
  kybStatus: 'none' | 'pending' | 'approved' | 'rejected';
  /** Merchant-supplied dossier handle. Null until submitKyb. */
  kybRef: string | null;
  status: 'pending' | 'active' | 'suspended' | 'closed';
  pricing: MerchantPricing;
  settlementPrefs: Record<string, unknown>;
}

export interface PaymentRecord {
  id: string;
  merchantId: string;
  profileId: string | null;
  /** Scaled bigint. What the rail authorized once a rail has spoken. */
  amount: Amount;
  assetId: string;
  method: string;
  railAdapter: string;
  railRef: string | null;
  status: PaymentStatus;
  createdAt: Date;
}

export interface PaymentView extends PaymentRecord {
  capturedAmount: Amount;
  refundedAmount: Amount;
}

/** A payment read: the row, plus the fee snapshot and failure stored for it. Both are null when nothing was stored. */
export interface PaymentRead extends PaymentView {
  pricingSnapshot: StoredPricingSnapshot | null;
  failure: MerchantFailure | null;
}

export interface PaymentPage {
  items: PaymentRead[];
  nextCursor: string | null;
  /** Every row matching the filter, including rows past this page. */
  summary: PaymentListSummary;
}

export interface PaymentEventRecord {
  id: string;
  event: string;
  payload: Record<string, unknown>;
  railEventId: string | null;
  ts: Date;
}

export interface SettlementRecord {
  id: string;
  merchantId: string;
  window: string;
  assetId: string;
  gross: Amount;
  fees: Amount;
  net: Amount;
  payoutMethod: string | null;
  payoutRef: string | null;
  /** Rail refusals so far. Part of the payout hold's idempotency key. */
  payoutAttempts: number;
  status: SettlementStatus;
  /**
   * On a settlement run (RC-merchant-10): the payments the rail still holds, which this run did not post and which stay
   * in clearing. Present only when there are some.
   */
  clearingPending?: HeldClearing[];
}

/**
 * Settlement read. Timestamps and the failure code are whatever was written at
 * the transition. Older rows leave them null. The pricing snapshot is the stored
 * control row, or null. Nothing here is recomputed from today's pricing.
 */
export interface SettlementRead extends SettlementRecord {
  createdAt: Date;
  sentAt: Date | null;
  settledAt: Date | null;
  failedAt: Date | null;
  failure: MerchantFailure | null;
  pricingSnapshot: StoredPricingSnapshot | null;
}

export interface SettlementPage {
  items: SettlementRead[];
  nextCursor: string | null;
}

export interface SettlementLine {
  paymentId: string;
  /** Net frozen into the window. Null when the included event has no amount. */
  amount: Amount | null;
  assetId: string;
  createdAt: Date;
  /** False for a freeze event written before the included amount was stored. */
  includedAmountKnown: boolean;
}

export interface SettlementLinePage {
  items: SettlementLine[];
  nextCursor: string | null;
}

export interface WebhookOutcome {
  readonly railId: string;
  readonly eventId: string;
  readonly type: string;
  /** True when this exact delivery has already been processed. Nothing changed. */
  readonly duplicate: boolean;
  readonly paymentId: string | null;
  readonly applied: boolean;
}

/** What the webhook path hands a verified chain delivery that matches no payment: a customer deposit, if the address is one. */
export interface CustodyDepositReceiver {
  receive(input: {
    address: string;
    txHash: string;
    outputIndex: number;
    assetId: string;
    amount: Amount;
    confirmations: number;
  }): Promise<{ state: 'unmatched' } | { state: 'recorded' }>;
  /**
   * The chain took a transfer back (W-deposit-06): reverse its credit once, or close the record if nothing was credited.
   * `unmatched` is an address no customer holds; `unknown` is a customer address with no record of that transfer.
   */
  reverse?(input: { address: string; txHash: string; outputIndex: number }): Promise<{ state: 'unmatched' | 'unknown' | 'recorded' }>;
}

export interface PayServiceOptions {
  /** Routes a chain delivery to a customer deposit address to the deposit record. Omitted: such a delivery is unmatched. */
  readonly custodyDeposits?: CustodyDepositReceiver;

  /**
   * Guard hooks called on payment admission, payout, settlement and conversion
   * paths (seams/guards.ts). Omitted = no-ops, i.e. behaviour before the seams.
   */
  readonly guards?: PayGuards;

  /**
   * Auto-trip streak writer. A rail-health payout or refund outcome is reported
   * here. Omitted, or constructed with no failure count, records nothing:
   * auto-trip stays off. A throw from the writer does not change the money result.
   */
  readonly haltStore?: PayHaltStore;

  /**
   * Dispute cases. Production passes the Postgres store. Omitted keeps the
   * process-local store so unit tests do not need a dispute table.
   */
  readonly disputeCases?: DisputeCaseStore;

  /**
   * Fee rate used when a merchant's pricing does not state one.
   *
   * There is no silent default of zero: a merchant settled at 0 bps by accident
   * is revenue that is not merely lost but invisible, because nothing ever
   * errors. If this is not configured and the merchant has no rate, settlement
   * refuses to run.
   */
  readonly defaultFeeBps?: number | null;

  /**
   * Whether a SANDBOX rail may be asked to send money out of the platform —
   * a merchant payout, or a refund to a payer.
   *
   * See `rails/posture.ts`. `allow-sandbox` in dev and test, where the sandbox
   * rails are the fixture; `live-only` in staging and prod, decided once at boot
   * so the boot refusal and the runtime check cannot disagree.
   */
  readonly valueMovement?: ValueMovementPolicy;

  /**
   * The same decision for the PUBLIC hosted checkout, and it is a SEPARATE knob
   * for one reason: `PAY_ALLOW_SANDBOX_RAILS` must not relax it.
   *
   * That override means "no user of this deployment is being told anything true
   * about their money" — a statement an operator can make about a pilot, a demo
   * or a load test, because everyone it covers is inside the exercise. A hosted
   * checkout is reachable by STRANGERS who followed a link and agreed to
   * nothing, and their consent is not the operator's to give.
   *
   * `assertRailPosture` computes it from the environment alone
   * (`RailPosture.publicCheckoutPolicy`). Defaults to `valueMovement` so a
   * caller that does not care cannot end up more permissive than the payout gate.
   */
  readonly publicCheckoutMovement?: ValueMovementPolicy;

  /**
   * Which rails may serve the PUBLIC hosted checkout, in preference order, and
   * the payment method each one represents.
   *
   * CONFIGURATION, NEVER A REQUEST FIELD. A hosted checkout that lets its caller
   * name a rail — or a payment link that resolves to one — is exactly where the
   * sandbox-withdrawal P0 comes back, so the payer never names one and this list
   * is the only thing that decides.
   *
   * Default is `crypto-native` alone. It is the only v1 rail that could ever be
   * live (§13: "crypto-native is real from day one"), and `card-sandbox` must
   * never take money from an anonymous third party even in dev — a sandbox
   * capture on the public surface credits a merchant nobody paid.
   */
  readonly checkoutRails?: readonly CheckoutRail[];

  /**
   * Operator-declared checkout risk band (D26-P1-P3). Blank = missing.
   * Never invented. Public callers cannot set this — tests may pass `riskBand` on open.
   */
  readonly checkoutRiskBand?: string | null;

  /** Eligibility profiles for smart checkout. Default is the v1 reference set. */
  readonly routingProfiles?: readonly RailRoutingProfile[];

  /**
   * RC-merchant-09: the owner's rule for comparing the name on a bank transfer with the name the payer gave
   * (`PAY_PAYER_NAME_MATCH_RULE`). Unset, every bank transfer is held for review: a rule is never guessed.
   */
  readonly payerNameMatchRule?: PayerNameMatchRule | null;

  /**
   * How long a browser handoff stays open (seconds). Never applied to the payment.
   * Unset / null refuses open — never invent 900. Owner may pass 900 explicitly.
   */
  readonly checkoutSessionTtlSeconds?: number | null;

  /**
   * Applied when a merchant creates a link without naming an expiry.
   * Unset / null refuses mint — never invent 30. Owner may pass 30 explicitly.
   */
  readonly linkDefaultTtlDays?: number | null;

  /**
   * The hard ceiling on a link's lifetime. A capability URL does not live forever.
   * Unset / null refuses mint — never invent 365. Owner may pass 365 explicitly.
   */
  readonly linkMaxTtlDays?: number | null;

  /**
   * Edge prefix for the hosted checkout path (`PAY_PUBLIC_BASE_PATH`).
   * Empty or omitted means the service's own `/checkout` route. Never a host.
   */
  readonly checkoutPublicBasePath?: string;

  /**
   * Open sessions allowed against one link at once. An anti-abuse floor, not a rate limiter.
   * Unset / null refuses open — never invent 25. Owner may pass 25 explicitly.
   */
  readonly maxOpenSessionsPerLink?: number | null;

  /** Injectable clock. Expiry is half of this feature, so it has to be drivable. */
  readonly now?: () => Date;

  /** Test failpoint after settlement owns the merchant lock; never wired at boot. */
  readonly afterSettlementMerchantLock?: () => void | Promise<void>;

  /**
   * Test failpoint inside the settlement posting transaction, before the
   * merchant eligibility lock that authorizes the credit. Never wired at boot.
   */
  readonly beforeSettlementPostMerchantLock?: () => void | Promise<void>;

  /**
   * Outbound merchant webhook notifier (pay.public-api step 3 / ADR §2.4).
   *
   * Called AFTER the money transaction commits. Must never move value. Failures
   * are swallowed by the caller so a delivery journal blip cannot unwind a
   * capture — at-least-once enqueue is best-effort after commit.
   */
  readonly afterPaymentEvent?: (event: {
    type: 'payment.authorized' | 'payment.captured' | 'payment.refunded' | 'payment.failed';
    payment: PaymentView;
  }) => void | Promise<void>;

  /**
   * D26-P1-O2 — identity affiliate accrue after house pay fees post.
   * Default noop. Failures must not unwind settlement.
   */
  readonly affiliateAccrue?: AffiliateAccruePort;

  /**
   * Identity affiliate payout after accrue. Default noop. Failures must not
   * unwind settlement. Body is `{ feeEventId }` only.
   */
  readonly affiliatePayout?: AffiliatePayoutPort;

  /**
   * Persisted merchant payout destinations. Crypto-native payout requires a
   * stored EVM dest before withdrawHold. Default refuses closed (no invented ref).
   */
  readonly payoutDestinations?: MerchantPayoutDestinations;
  /** Production always installs this owner-bound port; omission is an isolated test fixture. */
  readonly identityOperationAdmission?: IdentityPayoutAdmissionPort;
  readonly identityAuthorityGuard?: OwnerIdentityAuthorityPort;
  /** Test failpoint after durable payout admission, before money leaves available. */
  readonly afterPayoutAdmission?: () => void | Promise<void>;

  /**
   * How many chargeback outcome locks this process may hold at once.
   * Must stay below the pool size: the lock connection cannot serve the queries
   * the outcome itself runs. Omitted means 1, so a test pool is never filled by waiters.
   */
  readonly chargebackOutcomeSlots?: number;
}

/** One entry in `checkoutRails`: which adapter, and what `payments.method` it writes. */
export interface CheckoutRail {
  readonly railId: string;
  /** 'crypto' | 'card' | 'bank_transfer' — what the payer is actually doing. */
  readonly method: string;
}

export type CheckoutSessionStatus = 'open' | 'completed' | 'expired' | 'cancelled';

/**
 * What a public checkout session looks like to the payer's browser.
 *
 * NOTE WHAT IS ABSENT: no merchant id, no link id, no rail adapter id, no
 * payment id, no profile configuration. A public surface returns what this one
 * payer needs in order to pay, and nothing that would let them enumerate
 * anything or correlate two merchants.
 */
export interface CheckoutSessionView {
  readonly id: string;
  readonly status: CheckoutSessionStatus;
  readonly label: string;
  /** Decimal string. Frozen at open; never re-read from a request afterwards. */
  readonly amount: string;
  readonly currency: string;
  readonly method: string;
  readonly expiresAt: string;
  /**
   * How the payer actually pays: a rail reference, and what to send to it.
   *
   * Null while the rail has not answered yet. On `crypto-native` the rail
   * reference IS the acceptance address, derived from the payment id — which is
   * why this is generic rather than an `{ address }` the core would have had to
   * learn a rail's shape to produce.
   */
  readonly instruction: { readonly reference: string; readonly amount: string; readonly currency: string } | null;
  /**
   * Part of the amount has arrived and the rest has not (J-merchant-04 step 5): decimal strings, as the rail last
   * counted final transfers; `confirming` is sent but not yet final. Null until something final has arrived. Nothing is
   * credited to the merchant before it is all in.
   */
  readonly progress?: { readonly received: string; readonly missing: string; readonly confirming: string } | null;
  /**
   * RC-merchant-09: the payer's bank transfer arrived and is held for a review of the name it came from. Nothing has
   * been taken from it; the business is paid only if the review lets it through.
   */
  readonly heldForReview?: boolean;
  readonly confirmationMessage?: string | null;
  readonly confirmationUrl?: string | null;
}

interface LinkRow {
  id: string;
  merchant_id: string;
  profile_id: string | null;
  label: string;
  amount: string | null;
  currency: string | null;
  active: boolean;
  expires_at: Date | null;
  max_uses: number | null;
  uses: number;
  checkout_config: Record<string, unknown> | null;
  inactive_message: string | null;
}

interface CheckoutSessionRow {
  id: string;
  link_id: string;
  merchant_id: string;
  payment_id: string | null;
  amount: string;
  currency: string;
  rail_adapter: string;
  instruction: Record<string, unknown>;
  status: CheckoutSessionStatus;
  expires_at: Date;
}

export interface PaymentRow {
  id: string;
  merchant_id: string;
  profile_id: string | null;
  amount: string;
  currency: string;
  method: string;
  rail_adapter: string;
  rail_ref: string | null;
  status: PaymentStatus;
  created_at: Date;
}

export interface MerchantRow {
  id: string;
  user_id: string;
  mode: MerchantRecord['mode'];
  tier: number;
  kyb_status: MerchantRecord['kybStatus'];
  kyb_ref: string | null;
  status: MerchantRecord['status'];
  pricing: Record<string, unknown>;
  settlement_prefs: Record<string, unknown>;
}

export interface SettlementRow {
  id: string;
  merchant_id: string;
  window: string;
  asset_id: string;
  gross: string;
  fees: string;
  net: string;
  payout_method: string | null;
  payout_ref: string | null;
  payout_attempts: number;
  status: SettlementStatus;
}

export interface SettlementDetailRow extends SettlementRow {
  created_at: Date;
  sent_at: Date | null;
  settled_at: Date | null;
  failed_at: Date | null;
  failure_code: string | null;
  created_at_cursor: string;
}

/** JSON object as stored. An array or a scalar is unreadable, not an empty object. */
function storedJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function storedDomainList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null;
  return value;
}

/** The v1 public checkout estate: one rail, and the only one that can ever be live. */
export const DEFAULT_CHECKOUT_RAILS: readonly CheckoutRail[] = [{ railId: 'crypto-native', method: 'crypto' }];

function isCardishCheckoutRail(rail: CheckoutRail): boolean {
  return rail.method.trim().toLowerCase() === 'card' || /card|psp|acquirer/i.test(rail.railId);
}

/**
 * The public checkout list is entirely card/PSP, and none of those rails is a
 * registered non-absent adapter. That is `socket.psp-partners` unset — not a
 * missing geo field and not a sandbox that could still fake a capture.
 */
function checkoutRailsAreUnsetPsp(checkoutRails: readonly CheckoutRail[], rails: RailRegistry): boolean {
  if (checkoutRails.length === 0) return false;
  if (!checkoutRails.every(isCardishCheckoutRail)) return false;
  return checkoutRails.every((r) => !rails.has(r.railId) || rails.get(r.railId).mode === 'absent');
}

/**
 * `PayService` as the area files in `payment-service/` see it: its public surface plus the private members those
 * files run on. The class passes itself through `internal`, so only the class and its area files reach these
 * members; any other caller still gets a compile error for them.
 */
export type PayServiceInternal = { [K in keyof PayService]: PayService[K] } & {
  sql: PayService['sql'];
  ledger: PayService['ledger'];
  rails: PayService['rails'];
  accountRailOutcome: PayService['accountRailOutcome'];
  acquireChargebackOutcomeSlot: PayService['acquireChargebackOutcomeSlot'];
  admitPaymentOperation: PayService['admitPaymentOperation'];
  affiliateAccrue: PayService['affiliateAccrue'];
  affiliatePayout: PayService['affiliatePayout'];
  afterPayoutAdmission: PayService['afterPayoutAdmission'];
  afterSettlementMerchantLock: PayService['afterSettlementMerchantLock'];
  applyWebhook: PayService['applyWebhook'];
  assertListStatus: PayService['assertListStatus'];
  assertMerchantActive: PayService['assertMerchantActive'];
  beforeSettlementPostMerchantLock: PayService['beforeSettlementPostMerchantLock'];
  bookDisputeResolution: PayService['bookDisputeResolution'];
  chargebackBookedTx: PayService['chargebackBookedTx'];
  chargebackLedgerRefusal: PayService['chargebackLedgerRefusal'];
  chargebackOutcomeHeld: PayService['chargebackOutcomeHeld'];
  chargebackOutcomeSlots: PayService['chargebackOutcomeSlots'];
  chargebackOutcomeTails: PayService['chargebackOutcomeTails'];
  chargebackOutcomeWaiters: PayService['chargebackOutcomeWaiters'];
  chargebackSettledPot: PayService['chargebackSettledPot'];
  chargebackSplit: PayService['chargebackSplit'];
  classifyPaymentAdmission: PayService['classifyPaymentAdmission'];
  custodyDeposits: PayService['custodyDeposits'];
  defaultFeeBps: PayService['defaultFeeBps'];
  disputeCases: PayService['disputeCases'];
  enqueueChargebackOutcome: PayService['enqueueChargebackOutcome'];
  ensureChargebackPlanLive: PayService['ensureChargebackPlanLive'];
  existingPaymentCreation: PayService['existingPaymentCreation'];
  finishBookedCapture: PayService['finishBookedCapture'];
  guards: PayService['guards'];
  haltStore: PayService['haltStore'];
  hasUnresolvedDispute: PayService['hasUnresolvedDispute'];
  identityAuthorityGuard: PayService['identityAuthorityGuard'];
  identityOperationAdmission: PayService['identityOperationAdmission'];
  lockChargebackOutcome: PayService['lockChargebackOutcome'];
  lockMerchantEligibility: PayService['lockMerchantEligibility'];
  markDisputedIfLive: PayService['markDisputedIfLive'];
  markFailed: PayService['markFailed'];
  notifyPayAffiliateAccrue: PayService['notifyPayAffiliateAccrue'];
  notifyPayAffiliatePayout: PayService['notifyPayAffiliatePayout'];
  notifyPaymentEvent: PayService['notifyPaymentEvent'];
  now: PayService['now'];
  paymentFactsFor: PayService['paymentFactsFor'];
  paymentIsSandbox: PayService['paymentIsSandbox'];
  payerNameMatchRule: PayService['payerNameMatchRule'];
  payoutDestinations: PayService['payoutDestinations'];
  postChargebackOpenOrRefuse: PayService['postChargebackOpenOrRefuse'];
  postPendingSettlement: PayService['postPendingSettlement'];
  prepareSettlement: PayService['prepareSettlement'];
  recognisedPayoutBook: PayService['recognisedPayoutBook'];
  recordChargebackLedgerEffect: PayService['recordChargebackLedgerEffect'];
  recordChargebackPlanConflict: PayService['recordChargebackPlanConflict'];
  recoverBookedRefund: PayService['recoverBookedRefund'];
  refundInner: PayService['refundInner'];
  refuseSandboxLive: PayService['refuseSandboxLive'];
  releaseChargebackOutcomeSlot: PayService['releaseChargebackOutcomeSlot'];
  resolvePayoutDestination: PayService['resolvePayoutDestination'];
  restoreAfterWonDispute: PayService['restoreAfterWonDispute'];
  reverseChargeback: PayService['reverseChargeback'];
  settledPotForPayment: PayService['settledPotForPayment'];
  settlementIncludesSandbox: PayService['settlementIncludesSandbox'];
  settlementPage: PayService['settlementPage'];
  throwUnfundedChargebackShortfall: PayService['throwUnfundedChargebackShortfall'];
  valueMovement: PayService['valueMovement'];
  view: PayService['view'];
  voidChargebackPlan: PayService['voidChargebackPlan'];
  withChargebackOutcomeLock: PayService['withChargebackOutcomeLock'];
  withChargebackOutcomeSlot: PayService['withChargebackOutcomeSlot'];
  writeKybDecision: PayService['writeKybDecision'];
};

export class PayService {
  /** This service as its area files in `payment-service/` see it: see `PayServiceInternal`. */
  private get internal(): PayServiceInternal {
    return this as unknown as PayServiceInternal;
  }

  private readonly defaultFeeBps: number | null;
  private readonly valueMovement: ValueMovementPolicy;
  private readonly publicCheckoutMovement: ValueMovementPolicy;
  private readonly checkoutRails: readonly CheckoutRail[];
  private readonly checkoutRiskBand: string | undefined;
  private readonly routingProfiles: readonly RailRoutingProfile[];
  private readonly payerNameMatchRule: PayerNameMatchRule | null;
  private readonly checkoutSessionTtlSeconds: number | null;
  private readonly linkDefaultTtlDays: number | null;
  private readonly linkMaxTtlDays: number | null;
  private readonly checkoutPublicBasePath: string;
  private readonly maxOpenSessionsPerLink: number | null;
  private readonly now: () => Date;
  private readonly custodyDeposits: CustodyDepositReceiver | undefined;
  private readonly afterPaymentEvent:
    | ((event: {
        type: 'payment.authorized' | 'payment.captured' | 'payment.refunded' | 'payment.failed';
        payment: PaymentView;
      }) => void | Promise<void>)
    | undefined;
  private readonly afterSettlementMerchantLock: (() => void | Promise<void>) | undefined;
  private readonly beforeSettlementPostMerchantLock: (() => void | Promise<void>) | undefined;
  private readonly affiliateAccrue: AffiliateAccruePort;
  private readonly affiliatePayout: AffiliatePayoutPort;
  private readonly payoutDestinations: MerchantPayoutDestinations;
  private readonly identityOperationAdmission: IdentityPayoutAdmissionPort | undefined;
  private readonly identityAuthorityGuard: OwnerIdentityAuthorityPort | undefined;
  private readonly afterPayoutAdmission: (() => void | Promise<void>) | undefined;
  private readonly guards: PayGuards;
  private readonly haltStore: PayHaltStore | undefined;
  private readonly disputeCases: DisputeCaseStore;
  private readonly chargebackOutcomeSlots: number;
  private chargebackOutcomeHeld: number;
  private readonly chargebackOutcomeWaiters: Array<() => void>;
  private readonly chargebackOutcomeTails: Map<string, Promise<void>>;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly rails: RailRegistry,
    options: PayServiceOptions = {},
  ) {
    this.defaultFeeBps = options.defaultFeeBps ?? null;
    this.valueMovement = options.valueMovement ?? 'allow-sandbox';
    this.publicCheckoutMovement = options.publicCheckoutMovement ?? this.valueMovement;
    this.checkoutRails = options.checkoutRails ?? DEFAULT_CHECKOUT_RAILS;
    this.checkoutRiskBand = options.checkoutRiskBand?.trim() || undefined;
    this.routingProfiles = options.routingProfiles ?? REFERENCE_RAIL_ROUTING_PROFILES;
    this.payerNameMatchRule = options.payerNameMatchRule ?? null;
    this.checkoutSessionTtlSeconds = options.checkoutSessionTtlSeconds ?? null;
    this.linkDefaultTtlDays = options.linkDefaultTtlDays ?? null;
    this.linkMaxTtlDays = options.linkMaxTtlDays ?? null;
    this.checkoutPublicBasePath = options.checkoutPublicBasePath?.replace(/\/+$/, '') || '';
    this.maxOpenSessionsPerLink = options.maxOpenSessionsPerLink ?? null;
    this.now = options.now ?? (() => new Date());
    this.afterPaymentEvent = options.afterPaymentEvent;
    this.custodyDeposits = options.custodyDeposits;
    this.afterSettlementMerchantLock = options.afterSettlementMerchantLock;
    this.beforeSettlementPostMerchantLock = options.beforeSettlementPostMerchantLock;
    this.affiliateAccrue = options.affiliateAccrue ?? new NoopAffiliateAccrue();
    this.affiliatePayout = options.affiliatePayout ?? new NoopAffiliatePayout();
    this.payoutDestinations = options.payoutDestinations ?? assertOnlyPayoutDestinations();
    this.identityOperationAdmission = options.identityOperationAdmission;
    this.identityAuthorityGuard = options.identityAuthorityGuard;
    this.afterPayoutAdmission = options.afterPayoutAdmission;
    this.guards = options.guards ?? NOOP_GUARDS;
    this.haltStore = options.haltStore;
    this.disputeCases = options.disputeCases ?? defaultDisputeCaseStore;
    this.chargebackOutcomeSlots = chargebackOutcomeSlotCount(options.chargebackOutcomeSlots);
    this.chargebackOutcomeHeld = 0;
    this.chargebackOutcomeWaiters = [];
    this.chargebackOutcomeTails = new Map();
  }

  /**
   * The payment methods the public checkout can take (M-adv-payments-core-11): the checkout rails this environment lets
   * take strangers' money, with the countries their routing profiles declare.
   */
  checkoutMethodRails(onlyRails?: readonly string[]): MethodRails {
    return methodRailsOf({
      checkoutRails: this.checkoutRails,
      profiles: this.routingProfiles,
      rails: this.rails,
      policy: this.publicCheckoutMovement,
      ...(onlyRails ? { onlyRails } : {}),
    });
  }

  /** The book `payoutSettlement` reads. Tests use it to store a verified destination. */
  destinationBook(): MerchantPayoutDestinations {
    return this.payoutDestinations;
  }

  /**
   * Unique method on the operator checkout list, if there is exactly one.
   * Several methods with no caller method → missing (refuse, do not invent).
   */
  private uniqueCheckoutMethod(): string | undefined {
    const methods = [...new Set(this.checkoutRails.map((r) => r.method.trim()).filter(Boolean))];
    return methods.length === 1 ? methods[0] : undefined;
  }

  /** D26-P1-P3 — geo/method/risk rail pick. Payer never names a rail id. */
  private selectCheckoutRail(
    input: { geoCountry?: string; method?: string; riskBand?: string },
    /** RC-merchant-08: the rails the business's category allows; omitted, no category limit. */
    onlyRails?: readonly string[],
  ) {
    // BEFORE smart routing. An empty list used to surface as
    // `pay.routing_input_missing` (no unique method) — that names the payer's
    // form, not the operator gap. Unset PSP used to surface as
    // `pay.routing_no_rail`. Both are silent-adjacent: the public door must
    // refuse by the name of what is missing, and must not open a session.
    if (this.checkoutRails.length === 0) {
      throw new PublicCheckoutUnavailable(null, 'none-configured');
    }
    if (checkoutRailsAreUnsetPsp(this.checkoutRails, this.rails)) {
      throw new PublicCheckoutUnavailable(null, 'psp-unset');
    }
    try {
      return selectSmartCheckoutRail({
        inputs: {
          geoCountry: input.geoCountry,
          method: input.method ?? this.uniqueCheckoutMethod(),
          riskBand: input.riskBand ?? this.checkoutRiskBand,
        },
        preference: this.checkoutRails.map((r) => r.railId),
        profiles: this.routingProfiles,
        rails: this.rails,
        policy: this.publicCheckoutMovement,
        now: this.now(),
        ...(onlyRails ? { onlyRails } : {}),
      });
    } catch (e) {
      if (e instanceof RoutingInputError) {
        throw new PayError(e.message, 'pay.routing_input_missing', { missing: e.missing });
      }
      if (e instanceof SmartRoutingApprovalRateUnsetError) {
        throw new PayError(e.message, 'pay.routing_approval_rate_unset', { considered: e.considered });
      }
      if (e instanceof SmartRoutingNoRailError) {
        const posture = e.considered.filter((c) => c.reason === 'sandbox' || c.reason === 'absent' || c.reason === 'unhealthy');
        const other = e.considered.filter(
          (c) => c.outcome === 'skipped' && c.reason !== 'sandbox' && c.reason !== 'absent' && c.reason !== 'unhealthy',
        );
        if (posture.length > 0 && other.length === 0) {
          const reason = posture[0]!.reason as 'sandbox' | 'absent' | 'unhealthy';
          throw new PublicCheckoutUnavailable(posture[0]!.railId, reason);
        }
        if (onlyRails && e.considered.some((c) => c.reason === 'category-restricted')) {
          throw new PayError(
            `This business takes payments on ${onlyRails.join(', ')} only, and none of those can take this one`,
            'pay.category_rail_refused',
            {
              allowed: onlyRails,
              considered: e.considered,
            },
          );
        }
        throw new PayError(e.message, 'pay.routing_no_rail', { considered: e.considered });
      }
      throw e;
    }
  }

  /** Fire-and-forget outbound notify — never throws into the money path. */
  private notifyPaymentEvent(
    type: 'payment.authorized' | 'payment.captured' | 'payment.refunded' | 'payment.failed',
    payment: PaymentView,
  ): void {
    if (!this.afterPaymentEvent) return;
    void Promise.resolve(this.afterPaymentEvent({ type, payment })).catch(() => undefined);
  }

  async createMerchant(input: {
    userId: string;
    mode?: MerchantRecord['mode'];
    tier?: number;
    kybStatus?: MerchantRecord['kybStatus'];
    status?: MerchantRecord['status'];
    /** A rate is required at onboarding. There is no implicit free processing. */
    pricing: { feeBps: number };
    settlementPrefs?: Record<string, unknown>;
    /** Optional trading name and registered name (0071). Stored on first creation only. */
    displayName?: string | null;
    legalName?: string | null;
  }): Promise<MerchantRecord> {
    return merchants.createMerchant(this.internal, input);
  }

  async getMerchant(merchantId: string, connection: Sql = this.sql): Promise<MerchantRecord> {
    return merchants.getMerchant(this.internal, merchantId, connection);
  }

  private async lockMerchantEligibility(sql: Sql, merchantId: string): Promise<MerchantRecord> {
    return merchants.lockMerchantEligibility(this.internal, sql, merchantId);
  }

  async getMerchantByUserId(userId: string): Promise<MerchantRecord | null> {
    return merchants.getMerchantByUserId(this.internal, userId);
  }

  async submitKyb(input: { merchantId: string; kybRef: string; actor: KybActor }): Promise<MerchantRecord> {
    return merchants.submitKyb(this.internal, input);
  }

  async decideKyb(input: {
    merchantId: string;
    decision: 'approved' | 'rejected';
    identityHash: string;
    /**
     * Runs under the merchant row lock after the live identity matches
     * `identityHash`, and before the status write. The KYB routers consume
     * the founder approval here so a mismatch refuses without consuming it.
     */
    beforeWrite?: () => Promise<void>;
    actor: KybActor;
  }): Promise<MerchantRecord> {
    return merchants.decideKyb(this.internal, input);
  }

  async decideKybStub(input: { merchantId: string; decision: 'approved' | 'rejected'; actor: KybActor }): Promise<MerchantRecord> {
    return merchants.decideKybStub(this.internal, input);
  }

  private async writeKybDecision(
    merchantId: string,
    decision: 'approved' | 'rejected',
    actor: KybActor,
    reason: string,
    binding?: { identityHash: string; beforeWrite?: () => Promise<void> },
  ): Promise<MerchantRecord> {
    return merchants.writeKybDecision(this.internal, merchantId, decision, actor, reason, binding);
  }

  async listPayments(input: {
    merchantId: string;
    status?: PaymentStatus;
    limit?: number;
    cursor?: string;
    search?: string;
    assetId?: string;
    from?: string;
    to?: string;
    linkId?: string;
    amountMin?: string;
    amountMax?: string;
    /**
     * Sandbox keys pass `sandbox` so the page and its cursor are chosen from
     * sandbox rails only. Filtering after the page would let `nextCursor`
     * name a live payment the caller must not see.
     */
    railMode?: 'sandbox';
    /** False for a caller who reads the rail reference masked, so a search cannot confirm a guessed reference. */
    searchRailRef?: boolean;
  }): Promise<PaymentPage> {
    return paymentReads.listPayments(this.internal, input);
  }

  async listPaymentAttempts(paymentId: string): Promise<PaymentAttemptView[]> {
    return paymentReads.listPaymentAttempts(this.internal, paymentId);
  }

  /** J-merchant-05 #4: the newest pending rail result's confirmation count, with when it was recorded. */
  async paymentConfirmations(paymentId: string): Promise<{ seen: number; required: number; asOf: string } | null> {
    return paymentReads.paymentConfirmations(this.internal, paymentId);
  }

  async paymentFacts(paymentId: string): Promise<{ pricingSnapshot: StoredPricingSnapshot | null; failure: MerchantFailure | null }> {
    return paymentReads.paymentFacts(this.internal, paymentId);
  }

  private async paymentFactsFor(
    ids: string[],
  ): Promise<Map<string, { pricingSnapshot: StoredPricingSnapshot | null; failure: MerchantFailure | null }>> {
    return paymentReads.paymentFactsFor(this.internal, ids);
  }

  private assertListStatus(status: string | undefined, allowed: readonly string[]): void {
    return paymentReads.assertListStatus(this.internal, status, allowed);
  }

  async createProfile(input: {
    merchantId: string;
    checkoutConfig?: Record<string, unknown>;
    feeRouting?: Record<string, unknown>;
    domains?: readonly string[];
  }): Promise<{ id: string; merchantId: string }> {
    await this.getMerchant(input.merchantId);

    const rows = await this.sql<Array<{ id: string }>>`
      INSERT INTO pay.payment_profiles (merchant_id, checkout_config, fee_routing, domains)
      VALUES (
        ${input.merchantId}, ${this.sql.json((input.checkoutConfig ?? {}) as never)},
        ${this.sql.json((input.feeRouting ?? {}) as never)}, ${(input.domains ?? []) as string[]}
      )
      RETURNING id
    `;
    return { id: rows[0]!.id, merchantId: input.merchantId };
  }

  /**
   * The checkout profile `createProfile` stored most recently for this merchant.
   * No row is `not_configured`. A row returns the JSON and domains that write
   * stored, including empty objects. A non-object payload refuses; it is not
   * rewritten to `{}`.
   */
  async getCheckoutSettings(merchantId: string): Promise<
    | { status: 'not_configured' }
    | {
        status: 'configured';
        profileId: string;
        checkoutConfig: Record<string, unknown>;
        feeRouting: Record<string, unknown>;
        domains: string[];
        createdAt: string;
      }
  > {
    await this.getMerchant(merchantId);
    const rows = await this.sql<
      Array<{
        id: string;
        checkout_config: unknown;
        fee_routing: unknown;
        domains: unknown;
        created_at: Date;
      }>
    >`
      SELECT id, checkout_config, fee_routing, domains, created_at
        FROM pay.payment_profiles
       WHERE merchant_id = ${merchantId}
       ORDER BY created_at DESC, id DESC
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { status: 'not_configured' };
    const checkoutConfig = storedJsonObject(row.checkout_config);
    const feeRouting = storedJsonObject(row.fee_routing);
    const domains = storedDomainList(row.domains);
    if (!checkoutConfig || !feeRouting || !domains) {
      throw new PayError('Stored checkout settings are not a readable object', 'pay.checkout_settings_unreadable');
    }
    return {
      status: 'configured',
      profileId: row.id,
      checkoutConfig,
      feeRouting,
      domains,
      createdAt: row.created_at.toISOString(),
    };
  }

  /**
   * Create a shareable payment link.
   * Hosted page: GET /checkout?token= (see checkout-page.ts).
   *
   * THE TOKEN IS THE CHECKOUT CREDENTIAL. `resolvePaymentLink` and the hosted
   * page hash it and treat possession as permission to pay. There is no second
   * secret, so a separate public slug would be the same credential. The token
   * is stored on the row (`checkout_token`) so a caller who can list the link
   * can read the checkout path again. `token_hash` stays the public lookup
   * key. A database copy of `checkout_token` is a set of payable URLs until
   * the link expires or is deactivated.
   *
   * `idempotencyKey` is optional. Same key and same body returns the original
   * link, including its token. Same key and a different body refuses
   * `pay.idempotency_conflict`. The claim and the insert commit together.
   *
   * A PAYMENT LINK IS A CAPABILITY URL. Whoever holds one can pay against it,
   * and nobody has to log in to do so, so three properties are not optional:
   *
   *   EXPIRY is mandatory in effect, even though the parameter is not. A link
   *   with no expiry is a bearer credential with no end, sitting in an email
   *   thread, a screenshot, a Slack channel and a browser history forever. So an
   *   omitted `expiresAt` gets `linkDefaultTtlDays`, an explicit one is capped at
   *   `linkMaxTtlDays`, and an explicit `null` — "never expires" — is REFUSED.
   *
   *   BOUNDED USE is opt-in, via `maxUses`, and the default of unbounded is a
   *   decision rather than an oversight. A use is consumed by a completed
   *   payment; a completed payment against a merchant's own link is revenue. The
   *   merchant who is issuing an invoice sets `maxUses: 1` and gets single-use
   *   semantics; the merchant running a tip jar does not, and should not have to.
   *   The bound is checked at session open, where nothing has moved.
   *
   *   REVOCATION is `deactivatePaymentLink`, and it is one-way. There is no
   *   reactivate: a link a merchant has revoked was revoked for a reason, and
   *   the honest way to undo it is to issue a new token.
   */
  async createPaymentLink(input: {
    merchantId: string;
    label: string;
    profileId?: string | null;
    amount?: Amount;
    currency?: string;
    /**
     * A one-time fixed catalogue price (M-catalogue-03). The link charges its amount and asset and keeps it; an amount or
     * asset sent too must be the price's.
     */
    priceId?: string;
    /** Omit for the default lifetime. `null` — "never expires" — is refused. */
    expiresAt?: Date | null;
    /** Completed payments this link may take. Omit for unbounded. */
    maxUses?: number;
    /**
     * Caller's Idempotency-Key. Omit it and each call mints a new link.
     * Blank or over 255 characters is `pay.idempotency_required`.
     */
    idempotencyKey?: string;
    /** After payment. Omit to leave it unset. Blank and non-https refuse before a row exists. */
    confirmation?: LinkConfirmation;
  }): Promise<{
    id: string;
    token: string;
    prefix: string;
    label: string;
    expiresAt: Date;
    maxUses: number | null;
    checkoutUrl: string;
  }> {
    const key = paymentLinkCreateKey(input.idempotencyKey);
    if (!key.ok) {
      throw new PayError('Idempotency-Key must be 1 to 255 characters. Nothing was written.', 'pay.idempotency_required');
    }

    if (input.maxUses !== undefined && (!Number.isInteger(input.maxUses) || input.maxUses < 1)) {
      throw new PayError(`maxUses must be a positive integer, got ${input.maxUses}`, 'pay.invalid_amount');
    }

    const share = parseLinkConfirmation(input.confirmation);
    if (!share.ok) {
      throw new PayError(
        share.code === 'pay.link_redirect_not_https'
          ? 'A confirmation redirect must be an https address. Nothing was stored.'
          : 'A confirmation message cannot be blank. Nothing was stored.',
        share.code,
      );
    }

    // The body the caller named. Computed before the claim so a retry matches
    // even when the stored expiry was capped. Confirmation is part of the body
    // only when the caller sent one, so an older key still replays.
    const fingerprint = key.key
      ? paymentLinkCreateFingerprint({
          merchantId: input.merchantId,
          label: input.label,
          profileId: input.profileId ?? null,
          amount: input.amount === undefined ? null : formatAmount(input.amount),
          currency: input.currency ?? null,
          expiresAt: input.expiresAt === undefined ? 'default' : input.expiresAt === null ? 'null' : input.expiresAt.toISOString(),
          maxUses: input.maxUses ?? null,
          ...(input.confirmation !== undefined ? { confirmation: confirmationFingerprint(share.message, share.url) } : {}),
          ...(input.priceId !== undefined ? { priceId: input.priceId } : {}),
        })
      : null;

    if (!key.key) {
      // Merchant eligibility before the lifetime. An unapproved merchant is
      // refused as `pay.kyb_required` even when the lifetime is also unset.
      // A bad expiry still writes nothing, because there is no claim yet.
      this.assertMerchantActive(await this.getMerchant(input.merchantId));
      const expiresAt = this.linkExpiryFor(input.expiresAt);
      await this.assertLinkProfile(this.sql, input.merchantId, input.profileId);
      // One transaction, so a catalogue price stays held (and unarchived) until the link that sells it is written.
      return transaction(this.sql, async (tx) =>
        this.insertPaymentLink(tx, {
          ...input,
          ...(input.priceId !== undefined ? await linkPrice(tx, input.merchantId, input.priceId, input) : {}),
          expiresAt,
          confirmationMessage: share.message,
          confirmationUrl: share.url,
        }),
      );
    }

    const idempotencyKey = key.key;
    return transaction(this.sql, async (tx) => {
      const merchant = await this.lockMerchantForLinkCreate(tx, input.merchantId);
      const claimed = await tx<Array<{ idempotency_key: string }>>`
        INSERT INTO pay.payment_link_create_idempotency (
          merchant_id, idempotency_key, request_fingerprint
        ) VALUES (
          ${merchant.id}, ${idempotencyKey}, ${fingerprint}
        )
        ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
        RETURNING idempotency_key
      `;
      if (claimed.length === 0) {
        const prior = await tx<Array<{ request_fingerprint: string; link_id: string | null }>>`
          SELECT request_fingerprint, link_id
            FROM pay.payment_link_create_idempotency
           WHERE merchant_id = ${merchant.id}
             AND idempotency_key = ${idempotencyKey}
        `;
        const row = prior[0];
        if (!row || row.request_fingerprint !== fingerprint) {
          throw new PayError('Idempotency-Key was already used with a different request body', 'pay.idempotency_conflict');
        }
        if (!row.link_id) {
          throw new PayError('Payment link create idempotency claim has no link', 'pay.link_not_found');
        }
        return this.readCreatedLink(tx, merchant.id, row.link_id);
      }

      this.assertMerchantActive(merchant);
      // After eligibility, before the link row. A throw here rolls the claim back.
      const expiresAt = this.linkExpiryFor(input.expiresAt);
      await this.assertLinkProfile(tx, input.merchantId, input.profileId);
      const created = await this.insertPaymentLink(tx, {
        ...input,
        ...(input.priceId !== undefined ? await linkPrice(tx, input.merchantId, input.priceId, input) : {}),
        expiresAt,
        confirmationMessage: share.message,
        confirmationUrl: share.url,
      });
      const pointed = await tx`
        UPDATE pay.payment_link_create_idempotency
           SET link_id = ${created.id}
         WHERE merchant_id = ${merchant.id}
           AND idempotency_key = ${idempotencyKey}
           AND link_id IS NULL
      `;
      if (pointed.count !== 1) {
        throw new PayError('Payment link create idempotency claim was not stored', 'pay.link_not_found');
      }
      return created;
    });
  }

  private async lockMerchantForLinkCreate(sql: Sql, merchantId: string): Promise<MerchantRecord> {
    const rows = await sql<MerchantRow[]>`
      SELECT id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
        FROM pay.merchants WHERE id = ${merchantId} FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Merchant ${merchantId} not found`, 'pay.merchant_not_found');
    return toMerchant(row);
  }

  private async assertLinkProfile(sql: Sql, merchantId: string, profileId: string | null | undefined): Promise<void> {
    if (!profileId) return;
    const profiles = await sql<Array<{ id: string }>>`
      SELECT id FROM pay.payment_profiles
       WHERE id = ${profileId} AND merchant_id = ${merchantId}
    `;
    if (!profiles[0]) throw new PayError('payment profile not found for merchant', 'pay.profile_not_found');
  }

  private checkoutUrl(token: string): string {
    return checkoutUrlFor(token, this.checkoutPublicBasePath);
  }

  private async insertPaymentLink(
    sql: Sql,
    input: {
      merchantId: string;
      label: string;
      profileId?: string | null;
      amount?: Amount;
      currency?: string;
      priceId?: string;
      expiresAt: Date;
      maxUses?: number;
      confirmationMessage?: string | null;
      confirmationUrl?: string | null;
    },
  ): Promise<{
    id: string;
    token: string;
    prefix: string;
    label: string;
    expiresAt: Date;
    maxUses: number | null;
    checkoutUrl: string;
  }> {
    // 24 random bytes. The hash is what public resolve looks up. The token
    // itself is also stored so the merchant can read the checkout path later.
    const token = `pl_${randomBytes(24).toString('base64url')}`;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const prefix = token.slice(0, 10);
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.payment_links (
        merchant_id, profile_id, token_hash, token_prefix, checkout_token, label, amount, currency, expires_at, max_uses,
        confirmation_message, confirmation_url, price_id
      ) VALUES (
        ${input.merchantId},
        ${input.profileId ?? null},
        ${tokenHash},
        ${prefix},
        ${token},
        ${input.label},
        ${input.amount === undefined ? null : formatAmount(input.amount)}::numeric,
        ${input.currency ?? null},
        ${input.expiresAt},
        ${input.maxUses ?? null},
        ${input.confirmationMessage ?? null},
        ${input.confirmationUrl ?? null},
        ${input.priceId ?? null}
      )
      RETURNING id
    `;
    return {
      id: rows[0]!.id,
      token,
      prefix,
      label: input.label,
      expiresAt: input.expiresAt,
      maxUses: input.maxUses ?? null,
      checkoutUrl: this.checkoutUrl(token),
    };
  }

  /** Replay of a create. The token is the one stored with the link, not a new mint. */
  private async readCreatedLink(
    sql: Sql,
    merchantId: string,
    linkId: string,
  ): Promise<{
    id: string;
    token: string;
    prefix: string;
    label: string;
    expiresAt: Date;
    maxUses: number | null;
    checkoutUrl: string;
  }> {
    const rows = await sql<
      Array<{
        id: string;
        merchant_id: string;
        token_prefix: string;
        checkout_token: string | null;
        label: string;
        expires_at: Date | null;
        max_uses: number | null;
      }>
    >`
      SELECT id, merchant_id, token_prefix, checkout_token, label, expires_at, max_uses
        FROM pay.payment_links
       WHERE id = ${linkId}
         AND merchant_id = ${merchantId}
    `;
    const row = rows[0];
    if (!row || row.merchant_id !== merchantId || !row.checkout_token || !row.expires_at) {
      throw new PayError('Payment link create idempotency claim has no link', 'pay.link_not_found');
    }
    return {
      id: row.id,
      token: row.checkout_token,
      prefix: row.token_prefix,
      label: row.label,
      expiresAt: row.expires_at,
      maxUses: row.max_uses === null ? null : Number(row.max_uses),
      checkoutUrl: this.checkoutUrl(row.checkout_token),
    };
  }

  /**
   * The lifetime a link actually gets.
   *
   * `undefined` → the default. A date → capped. `null` → refused, and refusing
   * is the point: "never expires" is the only value a caller can pass that
   * makes the link strictly more dangerous than any other, so it is the one
   * value that has to be argued for rather than typed.
   */
  private linkExpiryFor(requested: Date | null | undefined): Date {
    const now = this.now().getTime();
    const maxDays = publishedLinkMaxTtlDays(this.linkMaxTtlDays);
    const cap = new Date(now + maxDays * 24 * 60 * 60 * 1000);

    if (requested === null) {
      throw new PayError(
        `A payment link cannot be created without an expiry — it is a capability URL, and whoever holds it can pay ` +
          `against it. Omit expiresAt for the owner-published default lifetime, or name a date at most ` +
          `${maxDays} days out.`,
        'pay.link_expiry_invalid',
      );
    }
    if (requested === undefined) {
      const days = publishedLinkDefaultTtlDays(this.linkDefaultTtlDays);
      return new Date(now + days * 24 * 60 * 60 * 1000);
    }
    if (Number.isNaN(requested.getTime())) throw new PayError('expiresAt is not a date', 'pay.link_expiry_invalid');
    if (requested.getTime() <= now) {
      throw new PayError('A payment link cannot be created already expired', 'pay.link_expiry_invalid');
    }
    // Capped rather than refused: a merchant asking for two years wants a
    // long-lived link, and silently shortening it to the cap is what every
    // other bounded-lifetime credential in this codebase does.
    return requested.getTime() > cap.getTime() ? cap : requested;
  }

  /**
   * Public resolve. Returns checkout intent only — no merchant secrets.
   *
   * PUBLIC AND UNAUTHENTICATED, so what it does NOT say matters as much as what
   * it does. There is no rail id in this response and there never will be: the
   * rail is chosen server-side at session open (see `openCheckoutSession`), and
   * a resolve that named one would be the first half of a payment link that
   * resolves to a rail.
   */
  async resolvePaymentLink(token: string): Promise<{
    id: string;
    merchantId: string;
    profileId: string | null;
    label: string;
    amount: string | null;
    currency: string | null;
    expiresAt: string | null;
    /** Null when the link is unbounded. Counts down as payments complete. */
    remainingUses: number | null;
    checkoutConfig: Record<string, unknown>;
  }> {
    return this.readLink(this.sql, token);
  }

  /**
   * The saved look (M-payments-core-08) of the business a payment link or checkout session belongs to, for the hosted
   * page: its brand colour and logo, or null for the default look (and for a token that opens nothing). The token is
   * the capability, as for `resolvePaymentLink`; only the page asks, so no other read carries the logo's bytes.
   */
  async checkoutLook(ref: { linkToken: string } | { sessionToken: string }): Promise<CheckoutLook | null> {
    const tokenHash = createHash('sha256')
      .update('linkToken' in ref ? ref.linkToken : ref.sessionToken)
      .digest('hex');
    const rows =
      'linkToken' in ref
        ? await this.sql<Array<{ brand_color: string; logo_type: string | null; logo_bytes: Buffer | null }>>`
            SELECT b.brand_color, b.logo_type, b.logo_bytes
              FROM pay.payment_links l JOIN pay.checkout_branding b ON b.merchant_id = l.merchant_id
             WHERE l.token_hash = ${tokenHash}`
        : await this.sql<Array<{ brand_color: string; logo_type: string | null; logo_bytes: Buffer | null }>>`
            SELECT b.brand_color, b.logo_type, b.logo_bytes
              FROM pay.checkout_sessions s JOIN pay.checkout_branding b ON b.merchant_id = s.merchant_id
             WHERE s.token_hash = ${tokenHash}`;
    return rows[0] ? checkoutLookOf(rows[0]) : null;
  }

  private async readLink(
    sql: Sql,
    token: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<{
    id: string;
    merchantId: string;
    profileId: string | null;
    label: string;
    amount: string | null;
    currency: string | null;
    expiresAt: string | null;
    remainingUses: number | null;
    checkoutConfig: Record<string, unknown>;
  }> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    // The lock is on the LINK, taken before any session row is counted or
    // written. Two payers opening a checkout on the same link at the same
    // instant must queue here, or both would see the same open-session count
    // and the same remaining uses.
    const rows = options.forUpdate
      ? await sql<LinkRow[]>`
          SELECT l.id, l.merchant_id, l.profile_id, l.label, l.amount::text, l.currency,
                 l.active, l.expires_at, l.max_uses, l.uses, NULL::jsonb AS checkout_config,
                 l.inactive_message
            FROM pay.payment_links l
           WHERE l.token_hash = ${tokenHash}
           FOR UPDATE
        `
      : await sql<LinkRow[]>`
          SELECT l.id, l.merchant_id, l.profile_id, l.label, l.amount::text, l.currency,
                 l.active, l.expires_at, l.max_uses, l.uses, p.checkout_config,
                 l.inactive_message
            FROM pay.payment_links l
            LEFT JOIN pay.payment_profiles p ON p.id = l.profile_id
           WHERE l.token_hash = ${tokenHash}
        `;

    const row = rows[0];
    // No row, or a deactivated link with no stored message, stays "not found".
    // A message the merchant stored is the answer the holder of this token sees.
    if (!row) throw new PayError('payment link not found', 'pay.link_not_found');
    if (!row.active) {
      const message = row.inactive_message?.trim() ?? '';
      if (!message) throw new PayError('payment link not found', 'pay.link_not_found');
      throw new PayError(message, 'pay.link_inactive');
    }
    if (row.expires_at && row.expires_at.getTime() < this.now().getTime()) {
      throw new PayError('payment link expired', 'pay.link_expired');
    }

    const maxUses = row.max_uses === null ? null : Number(row.max_uses);
    const remainingUses = maxUses === null ? null : Math.max(0, maxUses - Number(row.uses));
    if (remainingUses !== null && remainingUses <= 0) {
      throw new PayError('payment link has been used the maximum number of times', 'pay.link_exhausted');
    }

    return {
      id: row.id,
      merchantId: row.merchant_id,
      profileId: row.profile_id,
      label: row.label,
      amount: row.amount,
      currency: row.currency,
      expiresAt: row.expires_at?.toISOString() ?? null,
      remainingUses,
      checkoutConfig: row.checkout_config ?? {},
    };
  }

  async listPaymentLinks(
    merchantId: string,
    query:
      | { limit?: number; cursor?: string; search?: string; assetId?: string; from?: string; to?: string; active?: boolean }
      | number
      | undefined,
  ): Promise<{
    items: Array<{
      id: string;
      prefix: string;
      label: string;
      amount: string | null;
      currency: string | null;
      active: boolean;
      expiresAt: string | null;
      maxUses: number | null;
      uses: number;
      createdAt: string;
      /** Null when the link was minted before the checkout credential was stored. */
      token: string | null;
      /** Null when `token` is null. Path only — no invented host. */
      checkoutUrl: string | null;
      inactiveMessage: string | null;
      confirmationMessage: string | null;
      confirmationUrl: string | null;
      embedSnippet: string | null;
      priceId: string | null;
    }>;
    nextCursor: string | null;
  }> {
    await this.getMerchant(merchantId);
    const input = typeof query === 'number' || query === undefined ? { limit: query } : query;
    const page = assertPaymentLinkListLimit(input.limit);
    const filters = listFilters(input);
    const cursorAt = filters.cursor?.createdAtCursor ?? null;
    const cursorId = filters.cursor?.id ?? null;
    const rows = await this.sql<
      Array<{
        id: string;
        token_prefix: string;
        checkout_token: string | null;
        label: string;
        amount: string | null;
        currency: string | null;
        active: boolean;
        expires_at: Date | null;
        max_uses: number | null;
        uses: number;
        created_at: Date;
        created_at_cursor: string;
        inactive_message: string | null;
        confirmation_message: string | null;
        confirmation_url: string | null;
        price_id: string | null;
      }>
    >`
      SELECT id, token_prefix, checkout_token, label, amount::text, currency, active, expires_at, max_uses, uses, created_at,
             inactive_message, confirmation_message, confirmation_url, price_id,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
        FROM pay.payment_links
       WHERE merchant_id = ${merchantId}
         AND (${input.active ?? null}::boolean IS NULL OR active = ${input.active ?? null})
         AND (${filters.assetId}::text IS NULL OR currency = ${filters.assetId})
         AND (${filters.from}::timestamptz IS NULL OR created_at >= ${filters.from})
         AND (${filters.to}::timestamptz IS NULL OR created_at < ${filters.to})
         AND (
           ${filters.search}::text IS NULL
           OR id::text = lower(${filters.search})
           OR starts_with(lower(label), lower(${filters.search}))
         )
         AND (
           ${cursorAt}::text IS NULL
           OR (created_at, id) < ((${cursorAt}::text)::timestamptz, ${cursorId}::uuid)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT ${page + 1}
    `;
    const kept = rows.slice(0, page);
    const last = kept[kept.length - 1];
    return {
      items: kept.map((r) => this.toPaymentLinkListItem(r)),
      nextCursor: rows.length > page && last ? encodeListCursor(last.created_at_cursor, last.id) : null,
    };
  }

  /**
   * One link, for the merchant who already passed the list gate.
   * A link id from another merchant is `pay.link_not_found` — the same answer
   * as a missing id. The checkout token is included when it was stored.
   */
  async getPaymentLink(
    merchantId: string,
    linkId: string,
  ): Promise<{
    id: string;
    prefix: string;
    label: string;
    amount: string | null;
    currency: string | null;
    active: boolean;
    expiresAt: string | null;
    maxUses: number | null;
    uses: number;
    createdAt: string;
    token: string | null;
    checkoutUrl: string | null;
    inactiveMessage: string | null;
    confirmationMessage: string | null;
    confirmationUrl: string | null;
    embedSnippet: string | null;
    priceId: string | null;
  }> {
    await this.getMerchant(merchantId);
    const rows = await this.sql<
      Array<{
        id: string;
        token_prefix: string;
        checkout_token: string | null;
        label: string;
        amount: string | null;
        currency: string | null;
        active: boolean;
        expires_at: Date | null;
        max_uses: number | null;
        uses: number;
        created_at: Date;
        inactive_message: string | null;
        confirmation_message: string | null;
        confirmation_url: string | null;
        price_id: string | null;
      }>
    >`
      SELECT id, token_prefix, checkout_token, label, amount::text, currency, active, expires_at, max_uses, uses, created_at,
             inactive_message, confirmation_message, confirmation_url, price_id
        FROM pay.payment_links
       WHERE id = ${linkId}
         AND merchant_id = ${merchantId}
    `;
    const row = rows[0];
    if (!row) throw new PayError('payment link not found', 'pay.link_not_found');
    return this.toPaymentLinkListItem(row);
  }

  private toPaymentLinkListItem(r: {
    id: string;
    token_prefix: string;
    checkout_token: string | null;
    label: string;
    amount: string | null;
    currency: string | null;
    active: boolean;
    expires_at: Date | null;
    max_uses: number | null;
    uses: number;
    created_at: Date;
    inactive_message: string | null;
    confirmation_message: string | null;
    confirmation_url: string | null;
    price_id: string | null;
  }): {
    id: string;
    prefix: string;
    label: string;
    amount: string | null;
    currency: string | null;
    active: boolean;
    expiresAt: string | null;
    maxUses: number | null;
    uses: number;
    createdAt: string;
    token: string | null;
    checkoutUrl: string | null;
    inactiveMessage: string | null;
    confirmationMessage: string | null;
    confirmationUrl: string | null;
    embedSnippet: string | null;
    priceId: string | null;
  } {
    const token = r.checkout_token;
    const checkoutUrl = token ? this.checkoutUrl(token) : null;
    return {
      id: r.id,
      prefix: r.token_prefix,
      label: r.label,
      amount: r.amount,
      currency: r.currency,
      active: r.active,
      expiresAt: r.expires_at?.toISOString() ?? null,
      maxUses: r.max_uses === null ? null : Number(r.max_uses),
      uses: Number(r.uses),
      createdAt: r.created_at.toISOString(),
      token,
      checkoutUrl,
      inactiveMessage: r.inactive_message,
      confirmationMessage: r.confirmation_message,
      confirmationUrl: r.confirmation_url,
      embedSnippet: paymentLinkEmbedSnippet({
        checkoutUrl,
        amount: r.amount,
        currency: r.currency,
        label: r.label,
      }),
      priceId: r.price_id,
    };
  }

  /**
   * REVOCATION. Soft-disable a link so public resolve fails, and so no further
   * session can be opened against it. The token is never re-issued and there is
   * no reactivate — a link a merchant revoked was revoked for a reason.
   *
   * IT DOES NOT CANCEL SESSIONS ALREADY OPEN, and it must not. A payer who is
   * mid-checkout has been handed an acceptance address derived from their
   * payment id; killing the payment out from under them while their funds are in
   * flight is exactly how a payer's money ends up somewhere nothing points at.
   * Revocation stops NEW payers; the ones already committed are still owed a
   * working payment.
   */
  async deactivatePaymentLink(merchantId: string, linkId: string, message?: string): Promise<{ deactivated: boolean }> {
    await this.getMerchant(merchantId);
    const parsed = parseInactiveMessage(message);
    if (!parsed.ok) {
      throw new PayError('A deactivation message is too long. Nothing was changed.', parsed.code);
    }
    const result = await this.sql`
      UPDATE pay.payment_links
         SET active = false,
             inactive_message = ${parsed.message}
       WHERE id = ${linkId} AND merchant_id = ${merchantId} AND active = true
    `;
    return { deactivated: result.count > 0 };
  }

  // ── Hosted checkout (§6.1) ─────────────────────────────────────────────────
  //
  // THIS IS THE ONLY PUBLIC, UNAUTHENTICATED, VALUE-BEARING SURFACE IN THE
  // SERVICE. Everything below assumes the caller is hostile until proven
  // otherwise, and the design rules that follow from that are:
  //
  //   1. THE BROWSER DECIDES NOTHING THAT COSTS MONEY. The amount is frozen on
  //      the server at open and never re-read from a request. The rail is chosen
  //      from configuration and is never named by the caller — a hosted checkout
  //      that can name a rail is the route straight back to the P0 that
  //      `rails/posture.ts` closed.
  //   2. THE RAIL SAYS WHEN IT IS PAID, NOT THE PAGE. A session completes only
  //      when the payment behind it reaches `captured`, which happens on a
  //      verified webhook or an operator-driven capture. There is no
  //      "confirm payment" the payer can call.
  //   3. NOTHING IS FABRICATED. If no rail can honestly accept a public payment
  //      on this deployment, opening the session is REFUSED before any row is
  //      written and the payer is never shown a checkout that cannot complete.
  //   4. THE SESSION EXPIRES; THE PAYMENT DOES NOT. See `getCheckoutSession`.

  /**
   * Open a checkout session against a payment link. PUBLIC — the link token is
   * the capability, exactly as it is for `resolvePaymentLink`.
   *
   * ORDER OF OPERATIONS, AND WHY:
   *
   *   0. Choose a rail and check the posture. FIRST, before a row exists,
   *      because a refusal here must cost nothing and leave nothing behind.
   *   1. Lock the link, validate it, count open sessions, freeze the amount,
   *      write the payment and the session — one transaction, no external calls.
   *   2. Ask the rail how this payer pays. OUTSIDE the transaction, because it
   *      is a network call and because a crash here is resumable: the session is
   *      committed with no instruction, and the next read fills it in.
   *
   * IF THE PROCESS DIES AFTER (1) AND BEFORE (2), whose money is stranded?
   * Nobody's. No payer has been handed anywhere to send funds yet, and no value
   * has moved on any rail. The session sits `open` with a null instruction and
   * the first `getCheckoutSession` completes it, because `authorize` is
   * idempotent on the payment id and the acceptance address is derived from it.
   */
  async openCheckoutSession(input: {
    linkToken: string;
    /** Honoured ONLY when the link fixes no amount. Otherwise the link wins. */
    amount?: Amount;
    /** Honoured ONLY when the link fixes no currency. Otherwise the link wins. */
    assetId?: string;
    /**
     * ISO country the payer stated. Required for smart routing. Never invented.
     * Not a rail id.
     */
    geoCountry?: string;
    /**
     * Payment method (`crypto` / `card`), never a rail adapter id.
     * When omitted, the unique method on `checkoutRails` is used if there is exactly one.
     */
    method?: string;
    /**
     * Operator/test risk band. Public tRPC/HTML must not send this — use `checkoutRiskBand`.
     */
    riskBand?: string;
    /**
     * RC-merchant-09: the name on the bank account a payer will send a bank transfer from. Required for a bank transfer
     * (`pay.payer_name_required` before anything is written), kept with the payment, and ignored for any other method.
     */
    payerName?: string;
  }): Promise<{ sessionToken: string; session: CheckoutSessionView }> {
    // Step 0. Before anything exists. Smart routing (D26-P1-P3) replaces
    // preference-only selection. Blank geo/method/risk refuses rather than invent.
    // A payer still cannot name a rail adapter.
    // RC-merchant-08: the business's category decides which rails are candidates at all (a prohibited one opens
    // nothing). This read is a hint for routing only; the admission guard below re-checks inside the transaction.
    const categoryRule = await checkoutCategoryRule(this.sql, input.linkToken);
    if (categoryRule?.class === 'prohibited') assertCategoryAllows(categoryRule, null);
    // M-adv-payments-core-11: only a method the business offers for this country, currency and amount, in its order.
    const onlyRails = categoryRails(categoryRule) ?? undefined;
    const offeredMethod = await checkoutMethodFor(this.sql, this.checkoutMethodRails(onlyRails), input, this.now(), {
      categoryLimited: onlyRails !== undefined,
    });
    const decision = this.selectCheckoutRail(
      {
        geoCountry: input.geoCountry,
        method: offeredMethod,
        riskBand: input.riskBand,
      },
      onlyRails,
    );
    const adapter = decision.adapter;
    // Blank reserve terms (and any rule the routing hint did not cover) refuse by name before any row.
    assertCategoryAllows(categoryRule, adapter.id);
    const method = this.checkoutRails.find((r) => r.railId === adapter.id)!.method;
    // RC-merchant-09: the transfer will be checked against the name the payer gives, so a payment on a rail that checks
    // names opens only with one.
    const payerName = adapter.checksPayerName ? givenPayerName(input.payerName) : null;
    if (adapter.checksPayerName && payerName === null) {
      throw new PayError('Give the name on the bank account you will pay from', 'pay.payer_name_required', { method });
    }

    const opened = await transaction(
      this.sql,
      async (tx) => {
        const link = await this.readLink(tx, input.linkToken, { forUpdate: true });

        const merchant = await this.lockMerchantEligibility(tx, link.merchantId);
        // Same code the merchant integration path uses, and deliberately the
        // same refusal: a suspended merchant does not take money from the
        // public either.
        this.assertMerchantActive(merchant);

        // The floor under an anonymous caller opening rows off one URL forever.
        // Not a rate limiter — a rate limiter belongs at the edge, and this is
        // the bound that survives the edge being bypassed.
        const open = await tx<Array<{ n: string }>>`
          SELECT COUNT(*)::text AS n FROM pay.checkout_sessions
           WHERE link_id = ${link.id} AND status = 'open' AND expires_at > ${this.now()}
        `;
        const limit = publishedMaxOpenSessionsPerLink(this.maxOpenSessionsPerLink);
        if (Number.parseInt(open[0]?.n ?? '0', 10) >= limit) {
          throw new PayError(`Too many checkout sessions are already open on this payment link`, 'pay.checkout_busy', {
            limit,
          });
        }

        // ── THE AMOUNT. The link always wins. ──
        //
        // A supplied amount is not merged, not compared, not validated against
        // the link's — it is IGNORED whenever the link states one. Comparing
        // would mean there is a request in which the client's number is read,
        // and the whole property this surface needs is that there is not.
        const linkAmount = link.amount === null ? undefined : parseAmount(link.amount);
        const amount = linkAmount ?? input.amount;
        if (amount === undefined) {
          throw new PayError('This payment link needs the payer to state an amount', 'pay.checkout_amount_required');
        }
        if (amount <= 0n) throw new PayError('Payment amount must be positive', 'pay.invalid_amount');

        const currency = link.currency ?? input.assetId;
        if (!currency) {
          throw new PayError('This payment link needs the payer to state a currency', 'pay.checkout_amount_required');
        }

        const paymentId = randomUUID();
        const creationInput = {
          requestId: paymentId,
          merchantId: link.merchantId,
          profileId: link.profileId,
          amount,
          assetId: currency,
          method,
          railAdapter: adapter.id,
          metadata: { source: 'checkout', linkId: link.id },
        };
        // Seam: public checkout is intake too. Same hook and same lock order as
        // createPayment (seams/guards.ts): link row, merchant row (locked above),
        // THIS GUARD, then the payment insert. Before the admission record is
        // written so a refusal leaves nothing behind. The payment id is fresh, so
        // this is always a fresh admission; when identity admission is on, the
        // createPayment call below finds the row and is classified a replay.
        await this.guards.beforePaymentAdmit({
          tx,
          kind: 'payment.create',
          paymentId,
          merchantId: link.merchantId,
          payload: paymentCreationPayload(creationInput, paymentId),
          replay: FRESH,
        });
        if (this.identityOperationAdmission)
          await preparePaymentAdmission(
            tx,
            {
              paymentId,
              merchantId: link.merchantId,
              kind: 'payment.create',
              payload: paymentCreationPayload(creationInput, paymentId),
            },
            async () => this.assertMerchantActive(merchant),
            this.identityAuthorityGuard,
          );
        const payment = await insertPayment(tx, { ...creationInput, id: paymentId });
        if (payerName !== null) await recordGivenPayerName(tx, payment.id, payerName);

        // SPEC §5 — reason per decision. Taxonomy only (no cost/approval invent).
        // Survives in payment_events so a later dispute can answer "why this rail".
        await appendEvent(tx, payment.id, 'rail.selected', toRoutingDecisionRecord(decision));

        // Its own token, not the link's. A link is a MANY-payer capability and a
        // session is ONE payer's: addressing sessions by the link token would
        // let anybody holding the URL read a stranger's checkout.
        const sessionToken = `cs_${randomBytes(24).toString('base64url')}`;
        const rows = await tx<CheckoutSessionRow[]>`
          INSERT INTO pay.checkout_sessions (
            link_id, merchant_id, payment_id, token_hash, token_prefix,
            amount, currency, rail_adapter, expires_at
          ) VALUES (
            ${link.id}, ${link.merchantId}, ${payment.id},
            ${createHash('sha256').update(sessionToken).digest('hex')},
            ${sessionToken.slice(0, 10)},
            ${formatAmount(amount)}::numeric, ${currency}, ${adapter.id},
            ${new Date(this.now().getTime() + publishedCheckoutSessionTtlSeconds(this.checkoutSessionTtlSeconds) * 1000)}
          )
          RETURNING id, link_id, merchant_id, payment_id, amount, currency, rail_adapter, instruction, status, expires_at
        `;

        return { sessionToken, row: rows[0]!, label: link.label, method, creationInput };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );

    // Step 2, outside the transaction. Network call to the rail.
    if (this.identityOperationAdmission) {
      try {
        await this.createPayment(opened.creationInput);
      } catch (error) {
        await this.sql`UPDATE pay.checkout_sessions SET status='cancelled',updated_at=now() WHERE id=${opened.row.id}`;
        throw error;
      }
    }
    const withInstruction = await this.ensureInstruction(opened.row);

    return {
      sessionToken: opened.sessionToken,
      session: toCheckoutSessionView(withInstruction, opened.label, opened.method),
    };
  }

  /**
   * Read a session by its own token. PUBLIC — this is what the hosted page polls.
   *
   * A SESSION EXPIRING DOES NOT EXPIRE THE PAYMENT, and this method is where
   * that distinction is enforced. The session is a browser handoff measured in
   * minutes: past its expiry it is reported `expired` and no new instruction is
   * issued. The PAYMENT behind it is untouched — still `created`, still carrying
   * the acceptance address derived from its own id, still matched by
   * `payments (rail_adapter, rail_ref)` when the rail's webhook arrives.
   *
   * IF A PAYER SENDS FUNDS TEN MINUTES AFTER THEIR TAB TIMED OUT, whose money is
   * stranded? Nobody's. The transfer lands at an address we control, the watcher
   * delivers a verified event, `applyWebhook` matches the payment by rail
   * reference and books it, and the merchant is credited. What the payer loses
   * is a page that said "paid" — not their money. Expiring the payment along
   * with the session is the change that WOULD strand them, and it is why these
   * are two lifetimes on two tables rather than one.
   */
  async getCheckoutSession(sessionToken: string): Promise<CheckoutSessionView> {
    const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
    const rows = await this.sql<
      Array<CheckoutSessionRow & { label: string; confirmation_message: string | null; confirmation_url: string | null }>
    >`
      SELECT s.id, s.link_id, s.merchant_id, s.payment_id, s.amount::text, s.currency,
             s.rail_adapter, s.instruction, s.status, s.expires_at, l.label,
             l.confirmation_message, l.confirmation_url
        FROM pay.checkout_sessions s
        JOIN pay.payment_links l ON l.id = s.link_id
       WHERE s.token_hash = ${tokenHash}
    `;
    const row = rows[0];
    if (!row) throw new PayError('checkout session not found', 'pay.checkout_session_not_found');

    const method = this.checkoutRails.find((r) => r.railId === row.rail_adapter)?.method ?? 'crypto';

    if (row.status !== 'open') {
      const view = toCheckoutSessionView(row, row.label, method, {
        message: row.confirmation_message,
        url: row.confirmation_url,
      });
      // A closed window over a payment paid in part: the payer must still see what arrived and where the rest goes.
      return row.status === 'expired' ? { ...view, ...(await this.checkoutArrivals(row.payment_id, method)) } : view;
    }

    if (row.expires_at.getTime() <= this.now().getTime()) {
      // Lazily projected, and also swept by `expireCheckoutSessions`. Both, so
      // that a deployment with no sweeper still tells the payer the truth.
      await this.sql`
        UPDATE pay.checkout_sessions SET status = 'expired', updated_at = now()
         WHERE id = ${row.id} AND status = 'open'
      `;
      const view = toCheckoutSessionView({ ...row, status: 'expired' }, row.label, method);
      return { ...view, ...(await this.checkoutArrivals(row.payment_id, method)) };
    }

    // The resume: a session committed before the rail was asked. Idempotent on
    // the payment id, so re-running is free and produces the same address.
    const view = toCheckoutSessionView(await this.ensureInstruction(row), row.label, method);
    return { ...view, ...(await this.checkoutArrivals(row.payment_id, method)) };
  }

  /**
   * What has arrived for the payment, as the payer reads it: held for a payer-name review (RC-merchant-09), or the part
   * received so far. A held payment shows no "send the missing" line: nothing more should be sent until the review.
   */
  private async checkoutArrivals(
    paymentId: string | null,
    method: string,
  ): Promise<Pick<CheckoutSessionView, 'progress' | 'heldForReview'>> {
    if (paymentId && method === NAME_CHECKED_METHOD && (await isHeldOpenPayment(this.sql, paymentId))) {
      return { progress: null, heldForReview: true };
    }
    return { progress: await this.checkoutProgress(paymentId) };
  }

  /**
   * What the rail last said has arrived for a payment paid in parts: the newest `rail.pending` event that counted
   * something. Read from the payment's own events, so the page shows what the core recorded, never a figure of its own.
   */
  private async checkoutProgress(paymentId: string | null): Promise<CheckoutSessionView['progress']> {
    if (!paymentId) return null;
    const rows = await this.sql<Array<{ received: string | null; missing: string | null; confirming: string | null }>>`
      SELECT e.payload->>'received' AS received, e.payload->>'missing' AS missing, e.payload->>'confirming' AS confirming
        FROM pay.payment_events e
        JOIN pay.payments p ON p.id = e.payment_id
       WHERE e.payment_id = ${paymentId} AND e.event = 'rail.pending'
         -- Only while the payment still takes the rest: once it is authorized, captured or failed, "send the missing"
         -- would ask a payer for money nothing will count.
         AND p.status = 'created'
       ORDER BY e.seq DESC
       LIMIT 1
    `;
    const latest = rows[0];
    if (!latest?.received || !latest.missing) return null;
    const received = parseAmount(latest.received);
    const missing = parseAmount(latest.missing);
    if (received <= 0n || missing <= 0n) return null;
    const confirming = latest.confirming ? parseAmount(latest.confirming) : 0n;
    return { received: formatAmount(received), missing: formatAmount(missing), confirming: formatAmount(confirming) };
  }

  /**
   * Ask the rail how this payer pays, and remember the answer.
   *
   * `authorize` is the right call and not a special checkout-only path: on
   * `crypto-native` a fresh payment has nothing at its acceptance address yet, so
   * the rail answers `pending` and returns the ADDRESS as the rail reference —
   * which is precisely the instruction the payer needs. The core learns nothing
   * about chains to do this; it reads the reference the adapter already stores.
   *
   * A RAIL REFUSAL IS NOT TURNED INTO A PLAUSIBLE PAGE. `authorize` marks the
   * payment failed and throws; this cancels the session and rethrows, so the
   * payer is told the checkout could not be opened rather than being shown an
   * address nothing is watching.
   */
  private async ensureInstruction(row: CheckoutSessionRow): Promise<CheckoutSessionRow> {
    if (!row.payment_id) return row;
    if (typeof row.instruction?.reference === 'string' && row.instruction.reference) return row;

    let railRef: string | null;
    try {
      railRef = (await this.authorize(row.payment_id)).railRef;
    } catch (err) {
      await this.sql`
        UPDATE pay.checkout_sessions SET status = 'cancelled', updated_at = now()
         WHERE id = ${row.id} AND status = 'open'
      `;
      throw err;
    }

    // No reference yet is not an error and not an instruction either — the rail
    // took the request and has not answered. The session stays open with a null
    // instruction and the next poll asks again.
    if (!railRef) return row;

    const instruction = { reference: railRef, amount: row.amount, currency: row.currency };
    await this.sql`
      UPDATE pay.checkout_sessions
         SET instruction = ${this.sql.json(instruction as never)}, updated_at = now()
       WHERE id = ${row.id} AND status = 'open'
    `;
    return { ...row, instruction };
  }

  /**
   * Close out sessions whose handoff window has passed. Idempotent; safe to run
   * on a timer, and it touches NO payment and NO ledger account — expiring a
   * browser handoff is not an opinion about anybody's money.
   */
  async expireCheckoutSessions(): Promise<{ expired: number }> {
    const result = await this.sql`
      UPDATE pay.checkout_sessions
         SET status = 'expired', updated_at = now()
       WHERE status = 'open' AND expires_at <= ${this.now()}
    `;
    return { expired: result.count };
  }

  async createPayment(input: {
    requestId?: string;
    identityAuthority?: import('@intafaced/contracts').IdentityOperationIntent['authority'];
    merchantId: string;
    profileId?: string | null;
    amount: Amount;
    assetId: string;
    method: string;
    railAdapter: string;
    instrument?: PaymentIntent['instrument'];
    customerRef?: string;
    metadata?: Record<string, string>;
    /**
     * From the API key. `sandbox` is copied onto the created event and never
     * updated. Absent is not sandbox: a session or an in-process fixture is
     * not a sandbox credential.
     */
    keyEnv?: 'live' | 'sandbox';
  }): Promise<PaymentView> {
    return lifecycle.createPayment(this.internal, input);
  }

  private async admitPaymentOperation<T>(input: PreparedPaymentOperation, effect: (tx: Sql, admitted: boolean) => Promise<T>): Promise<T> {
    return lifecycle.admitPaymentOperation(this.internal, input, effect);
  }

  private async classifyPaymentAdmission(tx: Sql, input: PreparedPaymentOperation): Promise<GuardReplay> {
    return lifecycle.classifyPaymentAdmission(this.internal, tx, input);
  }

  private async existingPaymentCreation(
    tx: Sql,
    input: Parameters<PayService['createPayment']>[0],
    paymentId: string,
  ): Promise<PaymentView | null> {
    return lifecycle.existingPaymentCreation(this.internal, tx, input, paymentId);
  }

  async authorize(
    paymentId: string,
    options: { identityAuthority?: import('@intafaced/contracts').IdentityOperationIntent['authority'] } = {},
  ): Promise<PaymentView> {
    return lifecycle.authorize(this.internal, paymentId, options);
  }

  async capture(
    paymentId: string,
    options: {
      amount?: Amount;
      identityAuthority?: import('@intafaced/contracts').IdentityOperationIntent['authority'];
      /** The caller's API key. A sandbox key cannot capture into the live book. */
      keyEnv?: 'sandbox';
    } = {},
  ): Promise<PaymentView> {
    return lifecycle.capture(this.internal, paymentId, options);
  }

  private async finishBookedCapture(tx: Sql, row: PaymentRow, booked: BookedCaptureCompletion): Promise<PaymentView> {
    return lifecycle.finishBookedCapture(this.internal, tx, row, booked);
  }

  async reconcileAuthorizedCaptures(input: CaptureReconcileInput, mode: CaptureReconcileMode): Promise<CaptureReconcileReport> {
    return lifecycle.reconcileAuthorizedCaptures(this.internal, input, mode);
  }

  async refund(paymentId: string, amount: Amount, options: { refundId?: string; keyEnv?: 'sandbox' } = {}): Promise<PaymentView> {
    return refunds.refund(this.internal, paymentId, amount, options);
  }

  private async refundInner(paymentId: string, amount: Amount, options: { refundId?: string; keyEnv?: 'sandbox' }): Promise<PaymentView> {
    return refunds.refundInner(this.internal, paymentId, amount, options);
  }

  private async settledPotForPayment(sql: Sql, paymentId: string, merchantUserId: string): Promise<'proceeds' | 'user'> {
    return refunds.settledPotForPayment(this.internal, sql, paymentId, merchantUserId);
  }

  private async chargebackSettledPot(paymentId: string, merchantUserId: string): Promise<'proceeds' | 'user'> {
    return refunds.chargebackSettledPot(this.internal, paymentId, merchantUserId);
  }

  private async hasUnresolvedDispute(sql: Sql, merchantId: string, assetId: string): Promise<boolean> {
    return refunds.hasUnresolvedDispute(this.internal, sql, merchantId, assetId);
  }

  private async recognisedPayoutBook(input: {
    settlementId: string;
    merchantId: string;
    merchantUserId: string;
    window: string;
    assetId: string;
  }): Promise<'legacy' | 'proceeds'> {
    return refunds.recognisedPayoutBook(this.internal, input);
  }

  private async recoverBookedRefund(
    error: unknown,
    input: {
      key: string;
      paymentId: string;
      refundId: string;
      merchantId: string;
      merchantUserId: string;
      assetId: string;
      rail: string;
      amount: Amount;
    },
  ): Promise<{ tx: LedgerTx; source: 'clearing' | 'settled'; settledPot: 'proceeds' | 'user' } | null> {
    return refunds.recoverBookedRefund(this.internal, error, input);
  }

  async handleWebhook(railId: string, request: RailWebhookRequest): Promise<WebhookOutcome> {
    return webhooks.handleWebhook(this.internal, railId, request);
  }

  private async applyWebhook(adapter: RailAdapter, event: RailEvent): Promise<WebhookOutcome> {
    return webhooks.applyWebhook(this.internal, adapter, event);
  }

  private async markFailed(paymentId: string, failureCode: string): Promise<void> {
    return webhooks.markFailed(this.internal, paymentId, failureCode);
  }

  async markDisputed(
    paymentId: string,
    meta: {
      disputeId: string;
      reasonCode?: string | null;
      ledgerWire?: 'posted' | 'refused';
      ledgerTxId?: string | null;
    },
  ): Promise<PaymentView> {
    return webhooks.markDisputed(this.internal, paymentId, meta);
  }

  private async markDisputedIfLive(paymentId: string, meta: Parameters<PayService['markDisputed']>[1]): Promise<boolean> {
    return webhooks.markDisputedIfLive(this.internal, paymentId, meta);
  }

  private async restoreAfterWonDispute(paymentId: string, disputeId: string): Promise<void> {
    return webhooks.restoreAfterWonDispute(this.internal, paymentId, disputeId);
  }

  /** RC-merchant-10: one business's captured payments whose funds the rail still holds, with the day it named. */
  async heldClearing(merchantId: string, assetId?: string): Promise<HeldClearing[]> {
    return heldClearingOf(this.internal.sql, merchantId, assetId);
  }

  async settleWindow(input: {
    merchantId: string;
    /** Window label, e.g. '2026-07-27'. Half the business key. */
    window: string;
    assetId: string;
    /** Defaults to the UTC day named by `window`. */
    from?: Date;
    to?: Date;
    /** A sandbox key cannot freeze or post a live settlement. */
    keyEnv?: 'sandbox';
  }): Promise<SettlementRecord> {
    return settlement.settleWindow(this.internal, input);
  }

  private async postPendingSettlement(
    settlementId: string,
    replay: GuardReplay,
    span?: { setAttribute: (k: string, v: string | number) => void },
  ): Promise<SettlementRecord> {
    return settlement.postPendingSettlement(this.internal, settlementId, replay, span);
  }

  private async notifyPayAffiliateAccrue(posted: SettlementRecord, merchantUserId: string): Promise<void> {
    return settlement.notifyPayAffiliateAccrue(this.internal, posted, merchantUserId);
  }

  private async notifyPayAffiliatePayout(posted: SettlementRecord, merchantUserId: string): Promise<void> {
    return settlement.notifyPayAffiliatePayout(this.internal, posted, merchantUserId);
  }

  private async prepareSettlement(input: {
    merchantId: string;
    window: string;
    assetId: string;
    from?: Date;
    to?: Date;
  }): Promise<SettlementRecord> {
    return settlement.prepareSettlement(this.internal, input);
  }

  async releasePendingSettlement(input: {
    settlementId: string;
    /** Free-text ops reason (journaled; required so silent cancels are impossible). */
    reason: string;
  }): Promise<SettlementRecord> {
    return settlement.releasePendingSettlement(this.internal, input);
  }

  private async accountRailOutcome(input: {
    kind: 'failure' | 'success' | 'throw';
    target: PayHaltTarget;
    railId: string;
    failureCode?: string | null;
    eventKey?: string;
    connection?: Sql;
  }): Promise<void> {
    return settlement.accountRailOutcome(this.internal, input);
  }

  async payoutSettlement(input: {
    settlementId: string;
    railId: string;
    destination?: { kind: string; ref: string };
    identityAuthority?: import('@intafaced/contracts').IdentityOperationIntent['authority'];
    /** A sandbox key cannot enter a live payout. */
    keyEnv?: 'sandbox';
  }): Promise<SettlementRecord> {
    return payouts.payoutSettlement(this.internal, input);
  }

  async reconcileDispatchedPayout(settlementId: string): Promise<SettlementRecord> {
    return payouts.reconcileDispatchedPayout(this.internal, settlementId);
  }

  private async resolvePayoutDestination(railId: string, merchantId: string, connection?: Sql): Promise<{ kind: string; ref: string }> {
    return payouts.resolvePayoutDestination(this.internal, railId, merchantId, connection);
  }

  async getSettlement(settlementId: string, connection: Sql = this.sql): Promise<SettlementRecord> {
    return payouts.getSettlement(this.internal, settlementId, connection);
  }

  async listSettlements(input: {
    merchantId: string;
    status?: SettlementStatus;
    limit?: number;
    cursor?: string;
    search?: string;
    assetId?: string;
    from?: string;
    to?: string;
  }): Promise<SettlementPage> {
    return payouts.listSettlements(this.internal, input);
  }

  async readSettlement(settlementId: string): Promise<SettlementRead> {
    return payouts.readSettlement(this.internal, settlementId);
  }

  async listSettlementLines(input: { settlementId: string; limit?: number; cursor?: string }): Promise<SettlementLinePage> {
    return payouts.listSettlementLines(this.internal, input);
  }

  private async settlementPage(rows: SettlementDetailRow[], limit: number): Promise<SettlementPage> {
    return payouts.settlementPage(this.internal, rows, limit);
  }

  async getPayment(paymentId: string): Promise<PaymentView> {
    return paymentReads.getPayment(this.internal, paymentId);
  }

  async history(paymentId: string, requestedLimit?: number): Promise<PaymentEventRecord[]> {
    return paymentReads.history(this.internal, paymentId, requestedLimit);
  }

  async clearingBalance(merchantId: string, assetId: string): Promise<Amount> {
    return paymentReads.clearingBalance(this.internal, merchantId, assetId);
  }

  async merchantBalance(merchantId: string, assetId: string): Promise<Amount> {
    return paymentReads.merchantBalance(this.internal, merchantId, assetId);
  }

  async openChargeback(input: {
    disputeId: string;
    paymentId: string;
    merchantId: string;
    amount: string;
    assetId: string;
    /** A sandbox key cannot open a chargeback against live pots. */
    keyEnv?: 'sandbox';
  }): Promise<{ txId: string; openingTxId: string | null; shortfallTxId: string | null }> {
    return chargebacks.openChargeback(this.internal, input);
  }

  private async chargebackSplit(
    paymentId: string,
    disputeId: string,
    amount: Amount,
    settledPot: 'proceeds' | 'user',
    compute: () => Promise<{ fromClearing: Amount; fromMerchantBalance: Amount; shortfall: Amount }>,
  ): Promise<ChargebackSplit> {
    return chargebacks.chargebackSplit(this.internal, paymentId, disputeId, amount, settledPot, compute);
  }

  private async voidChargebackPlan(
    paymentId: string,
    disputeId: string,
    planSeq: string,
    idempotencyKey: string,
  ): Promise<{ id: string } | null> {
    return chargebacks.voidChargebackPlan(this.internal, paymentId, disputeId, planSeq, idempotencyKey);
  }

  private async ensureChargebackPlanLive(paymentId: string, disputeId: string, plan: ChargebackSplit): Promise<void> {
    return chargebacks.ensureChargebackPlanLive(this.internal, paymentId, disputeId, plan);
  }

  private async bookDisputeResolution(input: {
    disputeId: string;
    paymentId: string;
    merchantId: string;
    amount: string;
    assetId: string;
    outcome: 'won' | 'lost' | 'closed';
    /** True when the rail event named an amount. Absent means return the stored plan in full. */
    amountExplicit?: boolean;
  }): Promise<ChargebackLedgerEffect> {
    return chargebacks.bookDisputeResolution(this.internal, input);
  }

  private async reverseChargeback(input: {
    disputeId: string;
    paymentId: string;
    merchantId: string;
    amount: string;
    assetId: string;
    amountExplicit?: boolean;
  }): Promise<ChargebackLedgerEffect> {
    return chargebacks.reverseChargeback(this.internal, input);
  }

  private chargebackLedgerRefusal(e: unknown): PayError {
    return chargebacks.chargebackLedgerRefusal(this.internal, e);
  }

  private async throwUnfundedChargebackShortfall(input: {
    paymentId: string;
    disputeId: string;
    openingTxId: string | null;
    shortfall?: string;
    fund?: string;
  }): Promise<never> {
    return chargebacks.throwUnfundedChargebackShortfall(this.internal, input);
  }

  private async recordChargebackLedgerEffect(
    paymentId: string,
    disputeId: string,
    effect: Parameters<typeof chargebackLedgerEffect>[0],
  ): Promise<void> {
    return chargebacks.recordChargebackLedgerEffect(this.internal, paymentId, disputeId, effect);
  }

  private async withChargebackOutcomeLock<T>(disputeId: string, fn: () => Promise<T>): Promise<T> {
    return chargebacks.withChargebackOutcomeLock(this.internal, disputeId, fn);
  }

  private enqueueChargebackOutcome<T>(disputeId: string, run: () => Promise<T>): Promise<T> {
    return chargebacks.enqueueChargebackOutcome(this.internal, disputeId, run);
  }

  private async withChargebackOutcomeSlot<T>(run: () => Promise<T>): Promise<T> {
    return chargebacks.withChargebackOutcomeSlot(this.internal, run);
  }

  private acquireChargebackOutcomeSlot(): Promise<void> {
    return chargebacks.acquireChargebackOutcomeSlot(this.internal);
  }

  private releaseChargebackOutcomeSlot(): void {
    return chargebacks.releaseChargebackOutcomeSlot(this.internal);
  }

  private async lockChargebackOutcome<T>(disputeId: string, fn: () => Promise<T>): Promise<T> {
    return chargebacks.lockChargebackOutcome(this.internal, disputeId, fn);
  }

  private async chargebackBookedTx(key: string): Promise<LedgerTx | null> {
    return chargebacks.chargebackBookedTx(this.internal, key);
  }

  private async recordChargebackPlanConflict(input: {
    merchantId: string;
    disputeId: string;
    paymentId: string;
    amount: string;
    assetId: string;
    reasonCode: string | null;
    railEventId: string;
    railId: string;
    storedStatus: DisputeCaseStatus;
    outcome: RailResolutionOutcome;
    evidenceDueBy: Date | null;
  }): Promise<void> {
    return chargebacks.recordChargebackPlanConflict(this.internal, input);
  }

  private async postChargebackOpenOrRefuse(input: {
    disputeId: string;
    paymentId: string;
    merchantId: string;
    amount: string;
    assetId: string;
  }): Promise<{ ledgerPost?: { txId: string }; ledgerRefuse?: ChargebackLedgerRefuse }> {
    return chargebacks.postChargebackOpenOrRefuse(this.internal, input);
  }

  private async view(sql: Sql, row: PaymentRow): Promise<PaymentView> {
    const totals = await totalsFor(sql, row.id);
    return { ...toPayment(row), capturedAmount: totals.captured, refundedAmount: totals.refunded };
  }

  /**
   * One gate, every money-moving surface that should refuse a non-active
   * merchant: createPayment, openCheckout, createPaymentLink, authorize,
   * capture, settleWindow (post), prepareSettlement (new freeze),
   * payoutSettlement. Refund is intentionally not on this list (payer return).
   *
   * `status` is the operational cut-off (`suspended` / `closed` / `pending`).
   * Layer B also reads `kybStatus`: `rejected` never pays; `live-only` requires
   * approved KYB (`pay.kyb_required`). Does not invent `pay:*` scopes.
   */
  private assertMerchantActive(merchant: MerchantRecord): void {
    if (merchant.status !== 'active') {
      throw new PayError(`Merchant ${merchant.id} is ${merchant.status}`, 'pay.merchant_inactive');
    }
    const kybRefuse = merchantKybMoneyGateRefusal({
      merchantId: merchant.id,
      status: merchant.status,
      kybStatus: merchant.kybStatus,
      valueMovement: this.valueMovement,
    });
    if (kybRefuse) {
      throw new PayError(kybRefuse.message, kybRefuse.code, kybRefuse.detail);
    }
  }

  private portalFail(message: string, code: PayErrorCode): never {
    throw new PayError(message, code);
  }

  /** Saved payout destinations, masked. `default` only after the owner marks one. */
  listPayoutDestinations(input: { merchantId: string; limit?: number; cursor?: string }) {
    return listMerchantPayoutDestinations(this.sql, input, (message, code) => this.portalFail(message, code));
  }

  /** Owner write. Same authority as setPayoutDestination: no second approval. */
  setDefaultPayoutDestination(input: { merchantId: string; destinationId: string }) {
    return setDefaultMerchantPayoutDestination(this.sql, input, (message, code) => this.portalFail(message, code));
  }

  /** Unverified rows only. A verified destination is refused. An in-flight payout still blocks an unverified row. */
  removePayoutDestination(input: { merchantId: string; destinationId: string }) {
    return removeMerchantPayoutDestination(this.sql, input, (message, code) => this.portalFail(message, code));
  }

  listRefunds(input: Parameters<typeof listMerchantRefunds>[2]) {
    return listMerchantRefunds(this.sql, this.ledger, input, (message, code) => this.portalFail(message, code));
  }

  /** Merchant id only. The router fences before any amount parse or ledger read. A miss is `pay.refund_not_found`. */
  locateRefund(refundEventId: string) {
    return locateRefundMerchant(this.sql, refundEventId, (message, code) => this.portalFail(message, code));
  }

  /** The refund projection. Call only after the merchant fence. A miss is `pay.refund_not_found`. */
  readRefund(refundEventId: string) {
    return readMerchantRefund(this.sql, this.ledger, refundEventId, (message, code) => this.portalFail(message, code));
  }

  listStatement(input: Parameters<typeof listMerchantStatement>[2]) {
    return listMerchantStatement(this.sql, this.ledger, input, (message, code) => this.portalFail(message, code));
  }

  /**
   * Sandbox flag from the created event. Absent is not sandbox. The event is
   * insert-only, so a later call cannot clear it.
   */
  private async paymentIsSandbox(sql: Sql, paymentId: string): Promise<boolean> {
    const rows = await sql<Array<{ sandbox: string | null }>>`
      SELECT payload->>'sandbox' AS sandbox
        FROM pay.payment_events
       WHERE payment_id = ${paymentId} AND event = 'created'
       LIMIT 1
    `;
    return rows[0]?.sandbox === 'true';
  }

  /** True when a frozen window contains a payment created with a sandbox key. */
  private async settlementIncludesSandbox(sql: Sql, settlementId: string): Promise<boolean> {
    const rows = await sql<Array<{ ok: number }>>`
      SELECT 1 AS ok
        FROM pay.payment_events inc
        JOIN pay.payment_events created
          ON created.payment_id = inc.payment_id AND created.event = 'created'
       WHERE inc.event = 'settlement.included'
         AND inc.payload->>'settlementId' = ${settlementId}
         AND created.payload->>'sandbox' = 'true'
       LIMIT 1
    `;
    return rows.length > 0;
  }

  /** Refuse before `ledger.post` when a sandbox flag would touch a live account. */
  private refuseSandboxLive(sandbox: boolean, request: PostRequest): void {
    if (!sandbox) return;
    const live = liveAccountsIn(request);
    if (live.length === 0) return;
    throw new PayError('A sandbox payment cannot post to a live ledger account. NOTHING WAS POSTED.', 'pay.sandbox_live_account_refused', {
      accounts: live.map((account) =>
        account.purpose
          ? `${account.ownerType}:${account.ownerId}:${account.kind}:${account.purpose}`
          : `${account.ownerType}:${account.ownerId}:${account.kind}`,
      ),
    });
  }

  /** Timeline for one settlement. Status is derived inside the projection, not copied from the status column. */
  readPayoutLifecycle(settlementId: string) {
    return readPayoutLifecycleProjection(this.sql, settlementId, (message, code) => this.portalFail(message, code));
  }
}

/**
 * A session as the payer's browser sees it.
 *
 * The instruction is rebuilt from the row's own frozen amount and currency
 * rather than passed through from anywhere, so a page can never render a number
 * that differs from the one the payment was created for.
 */
function toCheckoutSessionView(
  row: CheckoutSessionRow,
  label: string,
  method: string,
  confirmation?: { message: string | null; url: string | null },
): CheckoutSessionView {
  const reference = typeof row.instruction?.reference === 'string' ? row.instruction.reference : null;
  return {
    id: row.id,
    status: row.status,
    label,
    amount: formatAmount(parseAmount(row.amount)),
    currency: row.currency,
    method,
    expiresAt: row.expires_at.toISOString(),
    instruction: reference ? { reference, amount: formatAmount(parseAmount(row.amount)), currency: row.currency } : null,
    confirmationMessage: confirmation?.message ?? null,
    confirmationUrl: confirmation?.url ?? null,
  };
}

/** Absent means one slot. A non-positive count would wait forever and hold the pool. */
function chargebackOutcomeSlotCount(slots: number | undefined): number {
  const value = slots ?? 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('pay.chargeback_outcome_slots: chargebackOutcomeSlots must be an integer of at least 1');
  }
  return value;
}

export type ChargebackSplit = {
  fromClearing: Amount;
  fromMerchantBalance: Amount;
  shortfall: Amount;
  settledPot: 'proceeds' | 'user';
  planSeq: string;
  amount: string;
  replayed: boolean;
};

export type ChargebackPlan = {
  amount: string;
  fromClearing: string;
  fromMerchantBalance: string;
  shortfall?: string;
  settledPot?: 'proceeds' | 'user';
  seq: string;
};

/**
 * Who moved a merchant's KYB, as `merchant_kyb_events` records it. The scope says which door: a `pay:*` scope is
 * the merchant (or the sandbox stub), anything else is INTAFACED. The portal history reads it that way.
 */
export interface KybActor {
  readonly id: string;
  readonly scope: string;
}
