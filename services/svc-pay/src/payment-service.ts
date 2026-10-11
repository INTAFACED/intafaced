import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { withPaymentAdmission, preparePaymentAdmission, type PreparedPaymentOperation } from './payment-admission.js';
import type { OwnerIdentityAuthorityPort } from './payment-authority.js';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  formatAmount,
  InvalidEntryError,
  merchantClearing,
  mulBps,
  parseAmount,
  recipes,
  userAvailable,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import type { PaymentIntent, RailAdapter, RailEvent, RailResult, RailWebhookRequest } from './rails/rail-adapter.js';
import type { RailRegistry } from './rails/registry.js';
import { assertRailMayMoveValue, PublicCheckoutUnavailable, type ValueMovementPolicy } from './rails/posture.js';
import {
  REFERENCE_RAIL_ROUTING_PROFILES,
  selectSmartCheckoutRail,
  SmartRoutingNoRailError,
  toRoutingDecisionRecord,
  type RailRoutingProfile,
} from './routing/decide.js';
import { RoutingInputError } from './routing-inputs.js';
import { merchantKybMoneyGateRefusal } from './merchant-kyb-money-gate.js';
import { assertPayoutDestinationKind, DestinationKindError } from './payout-destination.js';
import {
  assertOnlyPayoutDestinations,
  assertPersistableDestination,
  PayoutDestinationMissingError,
  type MerchantPayoutDestinations,
} from './merchant-payout-destination.js';
import { settlementLedgerPlan } from './settlement-ledger.js';
import {
  finalizePayoutIdentity,
  PayoutAdmissionError,
  insertPayoutAdmission,
  loadPayoutAdmission,
  payoutTransaction,
  withPayoutLock,
  stable,
  type IdentityPayoutAdmissionPort,
} from './payout-admission.js';
import { postDisputeOpening } from './chargeback-ledger.js';
import { withMoneySpan, withRailSpan } from './tracing.js';
import { defaultDisputeCaseStore, refuseChargebackUncovered, type ChargebackLedgerRefuse } from './fraud/dispute-case.js';
import { affiliateLegAfterPaySettlement, fireAffiliateAccrue, NoopAffiliateAccrue, type AffiliateAccruePort } from './affiliate-accrue.js';
import { fireAffiliatePayout, NoopAffiliatePayout, type AffiliatePayoutPort } from './affiliate-payout.js';

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
  /**
   * Principal is in the subject's PayFac tree but lacks the named permission area.
   * Distinct from merchant_forbidden so a parent that was never granted refund
   * does not look like a stranger.
   */
  | 'pay.submerchant_permission_denied'
  | 'pay.merchant_inactive'
  | 'pay.merchant_pricing_invalid'
  /** Owner `PAY_DEFAULT_FEE_BPS` unpublished. Blank env is not 0. */
  | 'pay.fee_bps_unset'
  /** KYB transition refused (wrong status, or stub decide blocked under live-only). */
  | 'pay.kyb_invalid'
  | 'pay.kyb_operator_required'
  /**
   * Live acquiring money door — merchant lacks approved KYB (D26-P1-P10 Layer B).
   * Distinct from scope issuance (Layer A); never invents `pay:*`.
   */
  | 'pay.kyb_required'
  | 'pay.payment_not_found'
  /** payment.list page size unpublished. Blank is not 50. */
  | 'pay.payment_list_limit_unset'
  /** payment.history page size unpublished. Blank is not 50 — never dump every payment_events row. */
  | 'pay.payment_history_limit_unset'
  /** merchant.listLinks page size unpublished. Blank is not 50 — never dump every link. */
  | 'pay.payment_link_list_limit_unset'
  | 'pay.profile_not_found'
  | 'pay.link_not_found'
  | 'pay.link_expired'
  /** The link's `maxUses` has been reached. Never resolved by retrying. */
  | 'pay.link_exhausted'
  /** A merchant asked for a link that never expires, or one past the lifetime cap. */
  | 'pay.link_expiry_invalid'
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
  | 'pay.invalid_amount'
  | 'pay.identity_admission_unavailable'
  | 'pay.identity_admission_denied'
  | 'pay.identity_admission_conflict'
  | 'pay.payout_admission_missing'
  | 'pay.payout_recovery_conflict'
  | 'pay.invalid_transition'
  | 'pay.capture_exceeds_authorized'
  | 'pay.partial_capture_unsupported'
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
  | 'pay.settlement_not_pending'
  | 'pay.rail_declined'
  | 'pay.rail_failed'
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
  | 'pay.fee_exceeds_gross'
  | 'pay.invalid_window'
  | 'pay.settlement_not_found'
  /** settlement.list page size unpublished. Blank is not 50. */
  | 'pay.settlement_list_limit_unset'
  // ── User money in and out (`user-money-service.ts`) ──
  | 'pay.rail_unknown'
  /** The rail exists but does not accept hand-typed operator credits. */
  | 'pay.rail_not_creditable'
  /** A rail reference already credited something else. Never resolved by retrying. */
  | 'pay.deposit_conflict'
  | 'pay.withdrawal_not_found'
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
  /** Crypto payout has no stored EVM dest — refused BEFORE withdrawHold. */
  | 'pay.payout_destination_missing'
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
  /**
   * Resuming would re-space periods past the mandate's `endsAt`.
   *
   * `adr/2026-08-08-twap-overdue-slice-disposition.md` forbids compressing the
   * schedule to fit and rejects silently dropping the tail. What is left is to
   * refuse and say by how much, so the merchant re-consents with a new mandate —
   * the same disposition that ADR gives a resume past 2× the original duration.
   */
  | 'pay.subscription_resume_exceeds_mandate';

export class PayError extends Error {
  constructor(
    message: string,
    readonly code: PayErrorCode,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PayError';
  }
}

/** Owner house take unpublished. Blank PAY_DEFAULT_FEE_BPS is not 0. */
export function publishedDefaultFeeBps(feeBps: number | null | undefined): number {
  if (feeBps == null) {
    throw new PayError('PAY_DEFAULT_FEE_BPS is unset — refusing rather than settling at 0 bps', 'pay.fee_bps_unset');
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new PayError(`Fee must be an integer between 0 and 10000 bps, got ${feeBps}`, 'pay.merchant_pricing_invalid');
  }
  return feeBps;
}

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

function assertOwnerPageLimit(limit: number | undefined, code: PayErrorCode, cap: number, message: string): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new PayError(message, code);
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new PayError(message, code);
  }
  return Math.min(cap, n);
}

/** payment.list page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertPaymentListLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.payment_list_limit_unset',
    200,
    'payment.list page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
  );
}

/** payment.history page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertPaymentHistoryLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.payment_history_limit_unset',
    200,
    'payment.history page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
  );
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

/** settlement.list page size unpublished. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertSettlementListLimit(limit: number | undefined): number {
  return assertOwnerPageLimit(
    limit,
    'pay.settlement_list_limit_unset',
    200,
    'settlement.list page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit).',
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

export interface PayServiceOptions {
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
   * Open sessions allowed against one link at once. An anti-abuse floor, not a rate limiter.
   * Unset / null refuses open — never invent 25. Owner may pass 25 explicitly.
   */
  readonly maxOpenSessionsPerLink?: number | null;

  /** Injectable clock. Expiry is half of this feature, so it has to be drivable. */
  readonly now?: () => Date;

  /** Test failpoint after settlement owns the merchant lock; never wired at boot. */
  readonly afterSettlementMerchantLock?: () => void | Promise<void>;

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

interface PaymentRow {
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

interface MerchantRow {
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

interface SettlementRow {
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

/** Which statuses may legally follow which. Anything else is a bug, not an edge case. */
const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  created: ['authorized', 'failed'],
  authorized: ['captured', 'failed'],
  captured: ['settled', 'refunded', 'disputed'],
  settled: ['refunded', 'disputed'],
  refunded: [],
  disputed: [],
  failed: [],
};

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

export class PayService {
  private readonly defaultFeeBps: number | null;
  private readonly valueMovement: ValueMovementPolicy;
  private readonly publicCheckoutMovement: ValueMovementPolicy;
  private readonly checkoutRails: readonly CheckoutRail[];
  private readonly checkoutRiskBand: string | undefined;
  private readonly routingProfiles: readonly RailRoutingProfile[];
  private readonly checkoutSessionTtlSeconds: number | null;
  private readonly linkDefaultTtlDays: number | null;
  private readonly linkMaxTtlDays: number | null;
  private readonly maxOpenSessionsPerLink: number | null;
  private readonly now: () => Date;
  private readonly afterPaymentEvent:
    | ((event: {
        type: 'payment.authorized' | 'payment.captured' | 'payment.refunded' | 'payment.failed';
        payment: PaymentView;
      }) => void | Promise<void>)
    | undefined;
  private readonly afterSettlementMerchantLock: (() => void | Promise<void>) | undefined;
  private readonly affiliateAccrue: AffiliateAccruePort;
  private readonly affiliatePayout: AffiliatePayoutPort;
  private readonly payoutDestinations: MerchantPayoutDestinations;
  private readonly identityOperationAdmission: IdentityPayoutAdmissionPort | undefined;
  private readonly identityAuthorityGuard: OwnerIdentityAuthorityPort | undefined;
  private readonly afterPayoutAdmission: (() => void | Promise<void>) | undefined;

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
    this.checkoutSessionTtlSeconds = options.checkoutSessionTtlSeconds ?? null;
    this.linkDefaultTtlDays = options.linkDefaultTtlDays ?? null;
    this.linkMaxTtlDays = options.linkMaxTtlDays ?? null;
    this.maxOpenSessionsPerLink = options.maxOpenSessionsPerLink ?? null;
    this.now = options.now ?? (() => new Date());
    this.afterPaymentEvent = options.afterPaymentEvent;
    this.afterSettlementMerchantLock = options.afterSettlementMerchantLock;
    this.affiliateAccrue = options.affiliateAccrue ?? new NoopAffiliateAccrue();
    this.affiliatePayout = options.affiliatePayout ?? new NoopAffiliatePayout();
    this.payoutDestinations = options.payoutDestinations ?? assertOnlyPayoutDestinations();
    this.identityOperationAdmission = options.identityOperationAdmission;
    this.identityAuthorityGuard = options.identityAuthorityGuard;
    this.afterPayoutAdmission = options.afterPayoutAdmission;
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
  private selectCheckoutRail(input: { geoCountry?: string; method?: string; riskBand?: string }) {
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
      });
    } catch (e) {
      if (e instanceof RoutingInputError) {
        throw new PayError(e.message, 'pay.routing_input_missing', { missing: e.missing });
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

  // ── Merchants ──────────────────────────────────────────────────────────────

  async createMerchant(input: {
    userId: string;
    mode?: MerchantRecord['mode'];
    tier?: number;
    kybStatus?: MerchantRecord['kybStatus'];
    status?: MerchantRecord['status'];
    /** A rate is required at onboarding. There is no implicit free processing. */
    pricing: { feeBps: number };
    settlementPrefs?: Record<string, unknown>;
  }): Promise<MerchantRecord> {
    assertFeeBps(input.pricing.feeBps);

    // Keyed on the user: onboarding is retried more than almost anything else
    // in a payments product, and a second merchant row for one account makes
    // "settle this account's takings" ambiguous forever after.
    await this.sql`
      INSERT INTO pay.merchants (user_id, mode, tier, kyb_status, status, pricing, settlement_prefs)
      VALUES (
        ${input.userId}, ${input.mode ?? 'gateway'}, ${input.tier ?? 0}, ${input.kybStatus ?? 'none'},
        ${input.status ?? 'active'}, ${this.sql.json(input.pricing as never)},
        ${this.sql.json((input.settlementPrefs ?? {}) as never)}
      )
      ON CONFLICT (user_id) DO NOTHING
    `;

    const rows = await this.sql<MerchantRow[]>`
      SELECT id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
        FROM pay.merchants WHERE user_id = ${input.userId}
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Merchant for user ${input.userId} not found after insert`, 'pay.merchant_not_found');
    return toMerchant(row);
  }

  async getMerchant(merchantId: string, connection: Sql = this.sql): Promise<MerchantRecord> {
    const rows = await connection<MerchantRow[]>`
      SELECT id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
        FROM pay.merchants WHERE id = ${merchantId}
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Merchant ${merchantId} not found`, 'pay.merchant_not_found');
    return toMerchant(row);
  }

  /** Serialize eligibility reads with KYB/status writers in the money-door transaction. */
  private async lockMerchantEligibility(sql: Sql, merchantId: string): Promise<MerchantRecord> {
    const rows = await sql<MerchantRow[]>`
      SELECT id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
        FROM pay.merchants WHERE id = ${merchantId} FOR SHARE
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Merchant ${merchantId} not found`, 'pay.merchant_not_found');
    return toMerchant(row);
  }

  async getMerchantByUserId(userId: string): Promise<MerchantRecord | null> {
    const rows = await this.sql<MerchantRow[]>`
      SELECT id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
        FROM pay.merchants WHERE user_id = ${userId}
    `;
    const row = rows[0];
    return row ? toMerchant(row) : null;
  }

  /**
   * KYB stub — merchant submits a dossier reference. Moves `none|rejected → pending`.
   * Does NOT invent a partner decision. Digital KYB / KYB vendors are `pay.psp`.
   */
  async submitKyb(input: { merchantId: string; kybRef: string }): Promise<MerchantRecord> {
    const ref = input.kybRef.trim();
    if (!ref || ref.length > 128) {
      throw new PayError('kybRef must be 1–128 characters', 'pay.kyb_invalid');
    }
    const merchant = await this.getMerchant(input.merchantId);
    if (merchant.kybStatus === 'pending' || merchant.kybStatus === 'approved') {
      throw new PayError(`Merchant KYB is already ${merchant.kybStatus}`, 'pay.kyb_invalid', {
        kybStatus: merchant.kybStatus,
      });
    }
    await this.sql`
      UPDATE pay.merchants
         SET kyb_status = 'pending', kyb_ref = ${ref}, updated_at = now()
       WHERE id = ${input.merchantId}
    `;
    return this.getMerchant(input.merchantId);
  }

  /**
   * Operator digital-KYB decide (`pay.psp`). Works under live-only.
   * Writes `merchants.kyb_status` pending → approved|rejected.
   * Does not invent a vendor webhook, fee bps, or `pay:*` scopes (Layer A).
   */
  async decideKyb(input: { merchantId: string; decision: 'approved' | 'rejected' }): Promise<MerchantRecord> {
    return this.writeKybDecision(input.merchantId, input.decision);
  }

  /**
   * KYB stub decide — sandbox/dev path only under `allow-sandbox` valueMovement.
   * Under live-only this refuses: use `merchant.decideKyb` (operator `admin:compliance`).
   * Never invents an external KYB vendor response.
   */
  async decideKybStub(input: { merchantId: string; decision: 'approved' | 'rejected' }): Promise<MerchantRecord> {
    if (this.valueMovement === 'live-only') {
      throw new PayError(
        'KYB decide stub is disabled under live-only; use merchant.decideKyb (operator admin:compliance) or kyb.decide',
        'pay.kyb_operator_required',
      );
    }
    return this.writeKybDecision(input.merchantId, input.decision);
  }

  private async writeKybDecision(merchantId: string, decision: 'approved' | 'rejected'): Promise<MerchantRecord> {
    return transaction(this.sql, async (tx) => {
      const rows = await tx<MerchantRow[]>`
        SELECT id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
          FROM pay.merchants WHERE id = ${merchantId} FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw new PayError(`Merchant ${merchantId} not found`, 'pay.merchant_not_found');
      const merchant = toMerchant(row);
      if (merchant.kybStatus !== 'pending') {
        throw new PayError(`Merchant KYB must be pending to decide (is ${merchant.kybStatus})`, 'pay.kyb_invalid', {
          kybStatus: merchant.kybStatus,
        });
      }
      const [updated] = await tx<MerchantRow[]>`
        UPDATE pay.merchants
           SET kyb_status = ${decision}, updated_at = now()
         WHERE id = ${merchantId}
         RETURNING id, user_id, mode, tier, kyb_status, kyb_ref, status, pricing, settlement_prefs
      `;
      if (!updated) throw new PayError(`Merchant ${merchantId} vanished during KYB decision`, 'pay.merchant_not_found');
      return toMerchant(updated);
    });
  }

  /**
   * Merchant payment list — durable status projection for the acquiring surface.
   * Status is whatever `payments.status` currently projects from `payment_events`.
   */
  async listPayments(input: { merchantId: string; status?: PaymentStatus; limit?: number }): Promise<PaymentView[]> {
    await this.getMerchant(input.merchantId);
    const limit = assertPaymentListLimit(input.limit);
    const rows = input.status
      ? await this.sql<PaymentRow[]>`
          SELECT id, merchant_id, profile_id, amount::text, currency, method, rail_adapter, rail_ref, status, created_at
            FROM pay.payments
           WHERE merchant_id = ${input.merchantId} AND status = ${input.status}
           ORDER BY created_at DESC
           LIMIT ${limit}
        `
      : await this.sql<PaymentRow[]>`
          SELECT id, merchant_id, profile_id, amount::text, currency, method, rail_adapter, rail_ref, status, created_at
            FROM pay.payments
           WHERE merchant_id = ${input.merchantId}
           ORDER BY created_at DESC
           LIMIT ${limit}
        `;
    const out: PaymentView[] = [];
    for (const row of rows) {
      out.push(await this.view(this.sql, row));
    }
    return out;
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
   * Create a shareable payment link. The raw token is returned once.
   * Hosted page: GET /checkout?token= (see checkout-page.ts).
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
    /** Omit for the default lifetime. `null` — "never expires" — is refused. */
    expiresAt?: Date | null;
    /** Completed payments this link may take. Omit for unbounded. */
    maxUses?: number;
  }): Promise<{ id: string; token: string; prefix: string; label: string; expiresAt: Date; maxUses: number | null }> {
    // A suspended merchant already cannot open a public session or create a
    // payment. Minting a fresh capability URL that only fails at pay-time is the
    // same class of honesty hole as letting them settle after suspension.
    this.assertMerchantActive(await this.getMerchant(input.merchantId));
    if (input.profileId) {
      const profiles = await this.sql<Array<{ id: string }>>`
        SELECT id FROM pay.payment_profiles
         WHERE id = ${input.profileId} AND merchant_id = ${input.merchantId}
      `;
      if (!profiles[0]) throw new PayError('payment profile not found for merchant', 'pay.profile_not_found');
    }

    if (input.maxUses !== undefined && (!Number.isInteger(input.maxUses) || input.maxUses < 1)) {
      throw new PayError(`maxUses must be a positive integer, got ${input.maxUses}`, 'pay.invalid_amount');
    }

    const expiresAt = this.linkExpiryFor(input.expiresAt);

    // 24 random bytes. Enumeration is not a threat model here, it is arithmetic
    // — but the token is still only ever STORED as a hash, because a leaked
    // database backup of payment links would otherwise be a wallet.
    const token = `pl_${randomBytes(24).toString('base64url')}`;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const prefix = token.slice(0, 10);

    const rows = await this.sql<Array<{ id: string }>>`
      INSERT INTO pay.payment_links (
        merchant_id, profile_id, token_hash, token_prefix, label, amount, currency, expires_at, max_uses
      ) VALUES (
        ${input.merchantId},
        ${input.profileId ?? null},
        ${tokenHash},
        ${prefix},
        ${input.label},
        ${input.amount === undefined ? null : formatAmount(input.amount)}::numeric,
        ${input.currency ?? null},
        ${expiresAt},
        ${input.maxUses ?? null}
      )
      RETURNING id
    `;

    return { id: rows[0]!.id, token, prefix, label: input.label, expiresAt, maxUses: input.maxUses ?? null };
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
                 l.active, l.expires_at, l.max_uses, l.uses, NULL::jsonb AS checkout_config
            FROM pay.payment_links l
           WHERE l.token_hash = ${tokenHash}
           FOR UPDATE
        `
      : await sql<LinkRow[]>`
          SELECT l.id, l.merchant_id, l.profile_id, l.label, l.amount::text, l.currency,
                 l.active, l.expires_at, l.max_uses, l.uses, p.checkout_config
            FROM pay.payment_links l
            LEFT JOIN pay.payment_profiles p ON p.id = l.profile_id
           WHERE l.token_hash = ${tokenHash}
        `;

    const row = rows[0];
    // A deactivated link is reported as NOT FOUND, not as revoked. Whoever holds
    // this URL is anonymous, and confirming that a token was once real tells
    // them the merchant exists and that the link was worth something.
    if (!row || !row.active) throw new PayError('payment link not found', 'pay.link_not_found');
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
    limit?: number,
  ): Promise<
    Array<{
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
    }>
  > {
    await this.getMerchant(merchantId);
    const page = assertPaymentLinkListLimit(limit);
    const rows = await this.sql<
      Array<{
        id: string;
        token_prefix: string;
        label: string;
        amount: string | null;
        currency: string | null;
        active: boolean;
        expires_at: Date | null;
        max_uses: number | null;
        uses: number;
        created_at: Date;
      }>
    >`
      SELECT id, token_prefix, label, amount::text, currency, active, expires_at, max_uses, uses, created_at
        FROM pay.payment_links
       WHERE merchant_id = ${merchantId}
       ORDER BY created_at DESC
       LIMIT ${page}
    `;
    return rows.map((r) => ({
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
    }));
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
  async deactivatePaymentLink(merchantId: string, linkId: string): Promise<{ deactivated: boolean }> {
    await this.getMerchant(merchantId);
    const result = await this.sql`
      UPDATE pay.payment_links
         SET active = false
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
  }): Promise<{ sessionToken: string; session: CheckoutSessionView }> {
    // Step 0. Before anything exists. Smart routing (D26-P1-P3) replaces
    // preference-only selection. Blank geo/method/risk refuses rather than invent.
    // A payer still cannot name a rail adapter.
    const decision = this.selectCheckoutRail({
      geoCountry: input.geoCountry,
      method: input.method,
      riskBand: input.riskBand,
    });
    const adapter = decision.adapter;
    const method = this.checkoutRails.find((r) => r.railId === adapter.id)!.method;

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
    const rows = await this.sql<Array<CheckoutSessionRow & { label: string }>>`
      SELECT s.id, s.link_id, s.merchant_id, s.payment_id, s.amount::text, s.currency,
             s.rail_adapter, s.instruction, s.status, s.expires_at, l.label
        FROM pay.checkout_sessions s
        JOIN pay.payment_links l ON l.id = s.link_id
       WHERE s.token_hash = ${tokenHash}
    `;
    const row = rows[0];
    if (!row) throw new PayError('checkout session not found', 'pay.checkout_session_not_found');

    const method = this.checkoutRails.find((r) => r.railId === row.rail_adapter)?.method ?? 'crypto';

    if (row.status !== 'open') return toCheckoutSessionView(row, row.label, method);

    if (row.expires_at.getTime() <= this.now().getTime()) {
      // Lazily projected, and also swept by `expireCheckoutSessions`. Both, so
      // that a deployment with no sweeper still tells the payer the truth.
      await this.sql`
        UPDATE pay.checkout_sessions SET status = 'expired', updated_at = now()
         WHERE id = ${row.id} AND status = 'open'
      `;
      return toCheckoutSessionView({ ...row, status: 'expired' }, row.label, method);
    }

    // The resume: a session committed before the rail was asked. Idempotent on
    // the payment id, so re-running is free and produces the same address.
    return toCheckoutSessionView(await this.ensureInstruction(row), row.label, method);
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

  // ── Payment lifecycle ──────────────────────────────────────────────────────

  /**
   * `created`. Nothing has been asked of a rail yet and no value has moved.
   *
   * The rail is chosen by the caller in this PR. Smart routing — geo, method,
   * amount band, risk score, live approval rates — is its own tracker feature
   * and slots in exactly here, choosing `railAdapter`, with nothing else in
   * this file changing.
   */
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
  }): Promise<PaymentView> {
    if (input.amount <= 0n) throw new PayError('Payment amount must be positive', 'pay.invalid_amount');

    // Resolved now so an unknown or incapable rail fails before a payment row
    // exists, rather than at authorize time with a buyer watching.
    this.rails.require(input.railAdapter, 'authorize');

    const paymentId = input.requestId?.toLowerCase() ?? randomUUID();
    if (input.requestId) await this.existingPaymentCreation(this.sql, input, paymentId);
    return this.admitPaymentOperation(
      {
        paymentId,
        merchantId: input.merchantId,
        kind: 'payment.create',
        authority: input.identityAuthority,
        payload: paymentCreationPayload(input, paymentId),
      },
      async (tx, admitted) => {
        if (!admitted) this.assertMerchantActive(await this.lockMerchantEligibility(tx, input.merchantId));
        const existing = await this.existingPaymentCreation(tx, input, paymentId);
        if (existing) return existing;
        const row = await insertPayment(tx, { ...input, id: paymentId });
        return { ...toPayment(row), capturedAmount: 0n, refundedAmount: 0n };
      },
    );
  }

  private async admitPaymentOperation<T>(input: PreparedPaymentOperation, effect: (tx: Sql, admitted: boolean) => Promise<T>): Promise<T> {
    try {
      return await withPaymentAdmission(
        this.sql,
        this.identityOperationAdmission,
        input,
        async (tx) => this.assertMerchantActive(await this.lockMerchantEligibility(tx, input.merchantId)),
        effect,
        this.identityAuthorityGuard,
      );
    } catch (error) {
      if (error instanceof PayoutAdmissionError) throw new PayError(error.message, error.code);
      throw error;
    }
  }
  private async existingPaymentCreation(
    tx: Sql,
    input: Parameters<PayService['createPayment']>[0],
    paymentId: string,
  ): Promise<PaymentView | null> {
    const existing = await tx`SELECT id FROM pay.payments WHERE id=${paymentId}`;
    if (!existing[0]) return null;
    const current = await readPayment(tx, paymentId);
    const [created] = await tx`SELECT payload FROM pay.payment_events WHERE payment_id=${paymentId} AND event='created' LIMIT 1`;
    const expected = {
      amount: formatAmount(input.amount),
      assetId: input.assetId,
      method: input.method,
      railAdapter: input.railAdapter,
      customerRef: input.customerRef ?? null,
      instrument: input.instrument ?? null,
      metadata: input.metadata ?? {},
    };
    if (
      current.merchant_id !== input.merchantId.toLowerCase() ||
      current.profile_id !== (input.profileId?.toLowerCase() ?? null) ||
      !created ||
      stable(created.payload) !== stable(expected)
    )
      throw new PayError('Creation request differs from the original payment', 'pay.identity_admission_conflict');
    return this.view(tx, current);
  }

  /**
   * `created → authorized`.
   *
   * No value moves here on any rail. A card authorization is a promise; a
   * crypto "authorization" is a confirmed transfer that is already ours but is
   * not booked until capture. Either way the ledger is untouched, which is why
   * this method can be retried freely.
   */
  async authorize(
    paymentId: string,
    options: { identityAuthority?: import('@intafaced/contracts').IdentityOperationIntent['authority'] } = {},
  ): Promise<PaymentView> {
    return withMoneySpan('pay.authorize', { operation: 'authorize', paymentId }, async () => {
      const original = await readPayment(this.sql, paymentId);
      if (['authorized', 'captured', 'settled'].includes(original.status)) return this.getPayment(paymentId);
      // Checkout commits a prepared row with its create marker before asking
      // identity. A cancelled creation must never become a usable instruction.
      if (this.identityOperationAdmission) {
        const prepared = await this
          .sql`SELECT payload FROM pay.payment_admissions WHERE business_id=${`payment.create:${paymentId.toLowerCase()}`}`;
        if (prepared[0])
          await this.admitPaymentOperation(
            {
              paymentId,
              merchantId: original.merchant_id,
              kind: 'payment.create',
              payload: prepared[0].payload as Record<string, unknown>,
            },
            async (tx) => this.view(tx, await readPayment(tx, paymentId)),
          );
      }
      const outcome = await this.admitPaymentOperation(
        {
          paymentId,
          merchantId: original.merchant_id,
          kind: 'payment.authorize',
          authority: options.identityAuthority,
          payload: {
            paymentId,
            merchantId: original.merchant_id,
            amount: formatAmount(parseAmount(original.amount)),
            assetId: original.currency,
            railId: original.rail_adapter,
            method: original.method,
            instrument: (await instrumentFor(this.sql, paymentId)) ?? null,
          },
        },
        async (tx, admitted) => {
          const observed = await readPayment(tx, paymentId);

          // Idempotent: an authorization that already happened is not an error.
          if (observed.status === 'authorized' || observed.status === 'captured' || observed.status === 'settled') {
            return { declined: false as const, view: await this.view(tx, observed) };
          }

          // Global money lock order: merchant eligibility, then payment. Settlement
          // freezes use the same order. Re-check the payment after both locks: it
          // may have completed while this operation waited on a cutoff/settlement.
          if (!admitted) this.assertMerchantActive(await this.lockMerchantEligibility(tx, observed.merchant_id));
          const row = await lockPayment(tx, paymentId);
          if (row.status === 'authorized' || row.status === 'captured' || row.status === 'settled') {
            return { declined: false as const, view: await this.view(tx, row) };
          }
          assertTransition(row, 'authorized');
          if (
            admitted &&
            (parseAmount(row.amount) !== parseAmount(original.amount) ||
              row.currency !== original.currency ||
              row.rail_adapter !== original.rail_adapter)
          )
            throw new PayError('Authorization payload changed after admission', 'pay.identity_admission_conflict');

          const adapter = this.rails.require(row.rail_adapter, 'authorize');

          const intent: PaymentIntent = {
            paymentId: row.id,
            merchantId: row.merchant_id,
            amount: parseAmount(row.amount),
            assetId: row.currency,
            method: row.method,
            instrument: await instrumentFor(tx, row.id),
          };

          const result = await withRailSpan(adapter.id, 'authorize', async () => adapter.authorize(intent));
          await appendEvent(tx, row.id, 'rail.authorize', railPayload(result));

          if (!result.ok) {
            await appendEvent(tx, row.id, 'failed', {
              failureCode: result.failureCode ?? 'rail.failed',
              failureReason: result.failureReason ?? null,
            });
            await tx`UPDATE pay.payments SET status = 'failed', updated_at = now() WHERE id = ${row.id}`;
            // Recorded, then thrown OUTSIDE the transaction. Throwing from in
            // here would roll back the very rows that say the payment failed,
            // and the next call would ask a rail that has already declined.
            return { declined: true as const, result, view: await this.view(tx, { ...row, status: 'failed' }) };
          }

          if (result.status === 'pending') {
            // The rail has taken the request but not completed it — on
            // crypto-native, the payer has not sent yet or is not deep enough.
            // The payment stays `created`: nothing has been authorized, and
            // saying otherwise is how a merchant ships against a transfer that
            // is still reorganisable.
            await tx`
              UPDATE pay.payments SET rail_ref = ${result.railRef || null}, updated_at = now() WHERE id = ${row.id}
            `;
            await appendEvent(tx, row.id, 'rail.pending', railPayload(result));
            return { declined: false as const, view: await this.view(tx, { ...row, rail_ref: result.railRef || null }) };
          }

          // What the rail authorized is what was agreed — it may exceed what was
          // asked (a payer who overpays on-chain has still sent the funds, and
          // they are at an address we control). Booking the smaller number would
          // strand the difference.
          await tx`
            UPDATE pay.payments
               SET status = 'authorized', rail_ref = ${result.railRef},
                   amount = ${formatAmount(result.amount)}::numeric, updated_at = now()
             WHERE id = ${row.id}
          `;
          await appendEvent(tx, row.id, 'authorized', { amount: formatAmount(result.amount), railRef: result.railRef });

          return {
            declined: false as const,
            view: await this.view(tx, {
              ...row,
              status: 'authorized',
              rail_ref: result.railRef,
              amount: formatAmount(result.amount),
            }),
          };
        },
      );

      if (outcome.declined) {
        throw new PayError(outcome.result.failureReason ?? 'Rail declined the authorization', 'pay.rail_declined', {
          failureCode: outcome.result.failureCode,
        });
      }

      if (outcome.view.status === 'authorized') {
        this.notifyPaymentEvent('payment.authorized', outcome.view);
      } else if (outcome.view.status === 'failed') {
        this.notifyPaymentEvent('payment.failed', outcome.view);
      }
      return outcome.view;
    });
  }

  /**
   * `authorized → captured`. THE INBOUND MONEY PATH.
   *
   * The rail moves first and the ledger books second: we only book value we
   * know has arrived.
   *
   * IF THIS CRASHES BETWEEN THE TWO, whose funds are stranded? Nobody's, but
   * they are in the wrong place for a while — captured at the rail, not yet in
   * the merchant's clearing account. The payment is still `authorized`, the
   * adapter's `capture` is idempotent, and `payment.capture:<paymentId>` means
   * the ledger post cannot double. Re-running this method finishes the job and
   * the merchant is made whole. That is the entire reason both halves are keyed
   * on the payment rather than on the attempt.
   */
  async capture(
    paymentId: string,
    options: { amount?: Amount; identityAuthority?: import('@intafaced/contracts').IdentityOperationIntent['authority'] } = {},
  ): Promise<PaymentView> {
    const original = await readPayment(this.sql, paymentId);
    if (['captured', 'settled'].includes(original.status)) return this.getPayment(paymentId);
    return withMoneySpan('pay.capture', { operation: 'capture', paymentId }, async (span) =>
      this.admitPaymentOperation(
        {
          paymentId,
          merchantId: original.merchant_id,
          kind: 'payment.capture',
          authority: options.identityAuthority,
          payload: {
            paymentId,
            merchantId: original.merchant_id,
            amount: formatAmount(parseAmount(original.amount)),
            requestedAmount: options.amount === undefined ? null : formatAmount(options.amount),
            assetId: original.currency,
            railId: original.rail_adapter,
            railRef: original.rail_ref,
          },
        },
        async (tx, admitted) => {
          const observed = await readPayment(tx, paymentId);

          if (observed.status === 'captured' || observed.status === 'settled') return this.view(tx, observed);

          // Merchant → payment is the single svc-pay money lock order. The shared
          // merchant lock intentionally spans the rail + ledger calls below: if
          // released earlier, a cutoff could commit after this check but before
          // the irreversible capture, recreating the stale-eligibility race.
          if (!admitted) this.assertMerchantActive(await this.lockMerchantEligibility(tx, observed.merchant_id));
          const row = await lockPayment(tx, paymentId);
          if (row.status === 'captured' || row.status === 'settled') return this.view(tx, row);
          assertTransition(row, 'captured');
          if (
            admitted &&
            (parseAmount(row.amount) !== parseAmount(original.amount) ||
              row.currency !== original.currency ||
              row.rail_adapter !== original.rail_adapter ||
              row.rail_ref !== original.rail_ref)
          )
            throw new PayError('Capture payload changed after admission', 'pay.identity_admission_conflict');

          const authorized = parseAmount(row.amount);

          if (options.amount !== undefined) {
            if (options.amount > authorized) {
              throw new PayError(
                `Cannot capture ${formatAmount(options.amount)} against an authorization of ${formatAmount(authorized)}`,
                'pay.capture_exceeds_authorized',
                { authorized: formatAmount(authorized), requested: formatAmount(options.amount) },
              );
            }
            if (options.amount < authorized) {
              // §6.1's interface is `capture(ref: string)` — there is nowhere to
              // put a partial amount. Refusing is honest; capturing the full
              // authorization while telling the caller we captured less is not.
              throw new PayError(
                'Partial capture is not expressible through the RailAdapter interface (§6.1) — refund the difference instead',
                'pay.partial_capture_unsupported',
                { authorized: formatAmount(authorized), requested: formatAmount(options.amount) },
              );
            }
          }

          if (!row.rail_ref) {
            throw new PayError(`Payment ${row.id} has no rail reference to capture`, 'pay.invalid_transition');
          }

          const adapter = this.rails.require(row.rail_adapter, 'capture');
          const railRef = row.rail_ref;

          const result = await withRailSpan(adapter.id, 'capture', async () => adapter.capture(railRef));
          await appendEvent(tx, row.id, 'rail.capture', railPayload(result));

          if (!result.ok) {
            // NOT marked failed. An authorization whose capture failed is still
            // an authorization, and a retry is the normal response. Marking it
            // failed here would abandon a buyer's held funds on a transient
            // acquirer error.
            throw new PayError(result.failureReason ?? 'Rail failed to capture', 'pay.rail_failed', {
              failureCode: result.failureCode,
            });
          }

          if (result.amount !== authorized) {
            // The rail captured something other than what we authorized. Book
            // neither number: one of the two systems is wrong and guessing which
            // is how a discrepancy becomes a loss.
            throw new PayError(
              `Rail captured ${formatAmount(result.amount)} against an authorization of ${formatAmount(authorized)}`,
              'pay.rail_amount_mismatch',
              { authorized: formatAmount(authorized), captured: formatAmount(result.amount) },
            );
          }

          const posted = await this.ledger.post(
            recipes.paymentCapture({
              paymentId: row.id,
              merchantId: row.merchant_id,
              assetId: row.currency,
              amount: result.amount,
              rail: adapter.id,
              railRef: result.railRef,
            }),
          );

          await appendEvent(tx, row.id, 'captured', {
            amount: formatAmount(result.amount),
            railRef: result.railRef,
            ledgerTxId: posted.id,
          });
          await tx`UPDATE pay.payments SET status = 'captured', updated_at = now() WHERE id = ${row.id}`;

          // In the SAME transaction as the capture, because a hosted checkout
          // that says "paid" out of step with the book is the whole failure mode
          // this feature has to avoid in both directions.
          await completeCheckoutSession(tx, row.id);

          span.setAttribute('intafaced.amount', formatAmount(result.amount));
          return this.view(tx, { ...row, status: 'captured' });
        },
      ).then((view) => {
        if (view.status === 'captured') this.notifyPaymentEvent('payment.captured', view);
        return view;
      }),
    );
  }

  /**
   * Refund, in full or in part. THE OUTBOUND MONEY PATH.
   *
   * Merchant refund of a captured payment through ledger-client
   * (`recipes.paymentRefund`). Refuse `pay.nothing_captured` if nothing was
   * captured — before the ledger posts. No PSP. No invented dest (crypto
   * returns to the payer).
   *
   * The ledger moves FIRST, in its own committed transaction, and only then is
   * the rail asked to send money out. That order is the whole design:
   *
   *   · The merchant must be shown to have the money before any of it leaves.
   *     A post-settlement refund the merchant cannot cover fails here, at the
   *     ledger, before anything irreversible happens.
   *
   *   · IF THIS CRASHES AFTER THE LEDGER POST AND BEFORE THE RAIL CALL, nothing
   *     is stranded: the book is already correct — the merchant is debited and
   *     the value sits at the rail boundary, which is exactly what "we owe this
   *     to a buyer" means. A `refund.posted` event with no `refunded` sibling is
   *     the marker an operator reconciles from.
   *
   *   · IF THE RAIL THEN REFUSES, the ledger post is reversed and the merchant
   *     gets their money back in the same call.
   *
   * A retry of a refund id that is already in flight is REFUSED rather than
   * re-sent. The rail receives the durable `refundId` (M226-02) so live crypto
   * can journal the outbound chain send under a stable key; "send it again and
   * hope" is how one refund becomes two.
   */
  async refund(paymentId: string, amount: Amount, options: { refundId?: string } = {}): Promise<PaymentView> {
    return withMoneySpan('pay.refund', { operation: 'refund', paymentId, amount: formatAmount(amount) }, async () =>
      this.refundInner(paymentId, amount, options),
    );
  }

  private async refundInner(paymentId: string, amount: Amount, options: { refundId?: string }): Promise<PaymentView> {
    if (amount <= 0n) throw new PayError('Refund amount must be positive', 'pay.invalid_amount');

    // ── Phase 1: debit the merchant, and commit the fact that we are about to
    // send money out. Nothing external is called inside this transaction.
    const prepared = await transaction(
      this.sql,
      async (tx) => {
        const row = await lockPayment(tx, paymentId);

        if (row.status !== 'captured' && row.status !== 'settled') {
          throw new PayError(`Payment ${row.id} has nothing captured (status ${row.status}) — refund refused`, 'pay.nothing_captured', {
            paymentId: row.id,
            status: row.status,
          });
        }

        // Pre-settlement only: a pending settlement freeze has claimed this
        // payment's clearing. Refunding from clearing under a frozen gross is
        // how another payment's capture funds the window (or the post sticks
        // forever on insufficient clearing). After the window posts the status
        // is `settled` and the refund draws on available instead — allowed.
        if (row.status === 'captured') {
          const pendingSettlement = await tx<Array<{ settlement_id: string }>>`
            SELECT e.payload->>'settlementId' AS settlement_id
              FROM pay.payment_events e
              JOIN pay.settlements s ON s.id = (e.payload->>'settlementId')::uuid
             WHERE e.payment_id = ${row.id}
               AND e.event = 'settlement.included'
               AND s.status = 'pending'
             LIMIT 1
          `;
          if (pendingSettlement[0]) {
            throw new PayError(
              `Payment ${row.id} is frozen in pending settlement ${pendingSettlement[0].settlement_id} — wait for the window to post, then refund from the merchant balance`,
              'pay.settlement_in_flight',
              { settlementId: pendingSettlement[0].settlement_id, paymentId: row.id },
            );
          }
        }

        const totals = await totalsFor(tx, row.id);
        if (totals.captured <= 0n) {
          throw new PayError(`Payment ${row.id} has nothing captured — refund refused`, 'pay.nothing_captured', { paymentId: row.id });
        }

        // A COMPLETED `refundId` IS A REPLAY, NOT A SECOND REFUND.
        //
        // `refundId` is a business key — it is what
        // `payment.refund:<paymentId>:<refundId>` makes the ledger idempotent
        // on. The ledger would therefore already dedupe a repeat and move
        // nothing, but the EVENT LOG would not:
        // `totalsFor` sums every `refunded` row, so appending a second one for
        // the same business key leaves the book correct and the PROJECTION
        // wrong — `refundedAmount` doubles, and refundable shrinks by a refund
        // that never happened. That desync is worse to unpick than a refusal.
        //
        // So a caller who repeats a completed refund id gets the payment as it
        // stands, having moved and recorded nothing. This is the same rule the
        // authorize path already states as "an authorization that already
        // happened is not an error", and it is what makes it safe for
        // `public-rest.ts` to derive this id from the caller's Idempotency-Key.
        //
        // Checked BEFORE the refundable comparison deliberately: after a FULL
        // refund the refundable balance is zero, so the refusal would otherwise
        // win and report `pay.refund_exceeds_captured` for what is actually a
        // retry of a refund that already succeeded.
        //
        // Only for an EXPLICIT id. The `${paymentId}:${sequence + 1}` default is
        // a fresh ordinal by construction and can never be a replay of itself.
        if (options.refundId !== undefined) {
          // A COMPLETED refundId is one business event with ONE amount.
          // Same id + same amount → replay (no second movement / event).
          // Same id + different amount → conflict: silent 200 with the old
          // amount would teach the merchant their second request succeeded.
          const alreadyDone = await tx<Array<{ amount: string | null }>>`
            SELECT payload->>'amount' AS amount
              FROM pay.payment_events
             WHERE payment_id = ${row.id}
               AND event = 'refunded'
               AND payload->>'refundId' = ${options.refundId}
             LIMIT 1
          `;
          if (alreadyDone[0]) {
            const prior = alreadyDone[0].amount;
            if (prior !== null && prior !== formatAmount(amount)) {
              throw new PayError(
                `Refund id ${options.refundId} already completed for ${prior}; requested ${formatAmount(amount)} — use a new refundId for a different amount`,
                'pay.refund_id_conflict',
                {
                  refundId: options.refundId,
                  paymentId: row.id,
                  completedAmount: prior,
                  requested: formatAmount(amount),
                },
              );
            }
            return { replay: true as const, view: await this.view(tx, row) };
          }

          // Spent after reverse: ledger key will no-op; rail may still pay.
          // A genuine re-attempt needs a new refundId (public REST: new
          // Idempotency-Key → new restRefundId).
          const spent = await tx<Array<{ n: string }>>`
            SELECT COUNT(*)::text AS n
              FROM pay.payment_events
             WHERE payment_id = ${row.id}
               AND event = 'refund.reversed'
               AND payload->>'refundId' = ${options.refundId}
          `;
          if (Number.parseInt(spent[0]?.n ?? '0', 10) > 0) {
            throw new PayError(
              `Refund id ${options.refundId} was already used and reversed — supply a new refundId for a genuine re-attempt`,
              'pay.refund_id_spent',
              { refundId: options.refundId, paymentId: row.id },
            );
          }
        }

        const refundable = totals.captured - totals.refunded;
        if (amount > refundable) {
          throw new PayError(
            `Refundable balance is ${formatAmount(refundable)}, requested ${formatAmount(amount)}`,
            'pay.refund_exceeds_captured',
            { refundable: formatAmount(refundable), requested: formatAmount(amount) },
          );
        }

        const inFlight = await tx<Array<{ refund_id: string }>>`
          SELECT p.payload->>'refundId' AS refund_id
            FROM pay.payment_events p
           WHERE p.payment_id = ${row.id} AND p.event = 'refund.posted'
             AND NOT EXISTS (
               SELECT 1 FROM pay.payment_events d
                WHERE d.payment_id = p.payment_id
                  AND d.event IN ('refunded', 'refund.reversed')
                  AND d.payload->>'refundId' = p.payload->>'refundId'
             )
        `;
        if (inFlight.length > 0) {
          throw new PayError(
            `Refund ${inFlight[0]!.refund_id} is already in flight — reconcile it against the rail before refunding again`,
            'pay.refund_in_flight',
            { refundId: inFlight[0]!.refund_id },
          );
        }

        // BEFORE THE LEDGER MOVES, not at the rail call in Phase 2. This
        // transaction is about to debit the merchant and commit "a refund is on
        // its way out"; refusing after that leaves a `refund.posted` event with
        // no rail behind it, which is the `pay.refund_in_flight` state — and that
        // state deliberately blocks every further refund on the payment until an
        // operator reconciles it. A refusal that was knowable here must not cost
        // the merchant that.
        assertRailMayMoveValue(this.rails.require(row.rail_adapter, 'refund'), 'refund', this.valueMovement);

        const sequence = await countEvents(tx, row.id, 'refund.posted');
        const refundId = options.refundId ?? `${row.id}:${sequence + 1}`;
        const merchant = await this.getMerchant(row.merchant_id);
        const source = row.status === 'settled' ? ('settled' as const) : ('clearing' as const);

        const posted = await this.ledger.post(
          recipes.paymentRefund({
            refundId,
            paymentId: row.id,
            merchantId: row.merchant_id,
            merchantUserId: merchant.userId,
            assetId: row.currency,
            amount,
            rail: row.rail_adapter,
            source,
          }),
        );

        await appendEvent(tx, row.id, 'refund.posted', {
          refundId,
          amount: formatAmount(amount),
          source,
          ledgerTxId: posted.id,
        });

        return { replay: false as const, row, refundId, source, merchant, captured: totals.captured, refunded: totals.refunded };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );

    // A repeat of a completed refund id. Nothing moved, nothing was appended,
    // and no rail was asked — the payment is returned exactly as it stands.
    if (prepared.replay) return prepared.view;

    // ── Phase 2: send it. The book already says this money is on its way out.
    const adapter = this.rails.require(prepared.row.rail_adapter, 'refund');
    const railRef = prepared.row.rail_ref!;
    const result = await withRailSpan(adapter.id, 'refund', async () => adapter.refund(railRef, amount, { refundId: prepared.refundId }));

    // ── Phase 3: record what the rail did, and reverse the ledger if it refused.
    const settled = await transaction(
      this.sql,
      async (tx) => {
        const row = await lockPayment(tx, paymentId);
        await appendEvent(tx, row.id, 'rail.refund', { ...railPayload(result), refundId: prepared.refundId });

        const refundInput = {
          refundId: prepared.refundId,
          paymentId: row.id,
          merchantId: row.merchant_id,
          merchantUserId: prepared.merchant.userId,
          assetId: row.currency,
          amount,
          rail: row.rail_adapter,
          source: prepared.source,
        };

        if (!result.ok) {
          // Put the merchant's money back. Its own business key, so a retry of
          // the reversal finds the reversal rather than the refund.
          await this.ledger.post(recipes.paymentRefundReverse(refundInput));
          await appendEvent(tx, row.id, 'refund.reversed', {
            refundId: prepared.refundId,
            amount: formatAmount(amount),
            failureCode: result.failureCode ?? 'rail.failed',
          });
          // Recorded, then thrown OUTSIDE this transaction. Throwing here would
          // roll back the very event that says the reversal happened, and the
          // next refund attempt would see a refund still in flight.
          return { ok: false as const, view: await this.view(tx, row) };
        }

        await appendEvent(tx, row.id, 'refunded', {
          refundId: prepared.refundId,
          amount: formatAmount(amount),
          source: prepared.source,
          railRef: result.railRef,
        });

        if (prepared.refunded + amount >= prepared.captured) {
          await tx`UPDATE pay.payments SET status = 'refunded', updated_at = now() WHERE id = ${row.id}`;
          return { ok: true as const, view: await this.view(tx, { ...row, status: 'refunded' }) };
        }

        // Partially refunded. The status stays where it was: the merchant is
        // still owed the remainder, and a settlement sweep must still see it.
        return { ok: true as const, view: await this.view(tx, row) };
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );

    if (!settled.ok) {
      throw new PayError(result.failureReason ?? 'Rail refused the refund', 'pay.rail_failed', {
        failureCode: result.failureCode,
        refundId: prepared.refundId,
      });
    }

    this.notifyPaymentEvent('payment.refunded', settled.view);
    return settled.view;
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────

  /**
   * Handle an inbound webhook.
   *
   * A PSP webhook WILL be delivered twice. The second delivery must change
   * NOTHING, and that is guaranteed at the database level rather than in this
   * method: `payment_events.rail_event_id` is unique, the insert is
   * `ON CONFLICT DO NOTHING`, and a delivery that inserts no row returns
   * `duplicate: true` without going near a rail or the ledger.
   *
   * THE EFFECT IS APPLIED BEFORE THE DEDUPE MARKER IS WRITTEN, not after. Write
   * the marker first and a crash in between leaves a delivery permanently
   * recorded as seen and never acted on — a captured payment nobody ever books.
   * This way the worst case is that a redelivery re-applies an effect that is
   * already idempotent on the payment id, which costs a wasted call and
   * changes nothing.
   */
  async handleWebhook(railId: string, request: RailWebhookRequest): Promise<WebhookOutcome> {
    const adapter = this.rails.require(railId, 'webhook');

    const event = adapter.verifyWebhook(request);
    if (!event) {
      // Deliberately uninformative to the caller. A verification endpoint that
      // explains WHY it rejected something is an oracle for forging the next
      // attempt.
      throw new PayError('Webhook signature verification failed', 'pay.webhook_invalid', { railId });
    }

    return withMoneySpan('pay.webhook', { operation: 'webhook', rail: railId, railRef: event.railRef }, async () =>
      this.applyWebhook(adapter, event),
    );
  }

  private async applyWebhook(adapter: RailAdapter, event: RailEvent): Promise<WebhookOutcome> {
    const rows = await this.sql<PaymentRow[]>`
      SELECT id, merchant_id, profile_id, amount, currency, method, rail_adapter, rail_ref, status, created_at
        FROM pay.payments WHERE rail_adapter = ${adapter.id} AND rail_ref = ${event.railRef}
    `;
    const payment = rows[0];

    if (!payment) {
      // A verified event about a payment we have no record of. Rejecting is
      // right — inventing a payment row from a webhook is how a rail's bug
      // becomes our liability — but it is also an operator signal, not a
      // client error.
      throw new PayError(`No payment for ${adapter.id} reference ${event.railRef}`, 'pay.webhook_unmatched', {
        railId: adapter.id,
        railRef: event.railRef,
        eventId: event.eventId,
      });
    }

    // Namespaced by rail. Two rails can and will use the same event id string,
    // and an unqualified collision would silently mark a genuine delivery a
    // duplicate — a captured payment nobody ever books.
    const deliveryKey = `${adapter.id}:${event.eventId}`;

    // The fast path, and the one the test "a webhook delivered twice changes
    // nothing" exercises: a delivery we have already recorded stops here,
    // before any rail call and before the ledger.
    const seen = await this.sql<Array<{ id: string }>>`
      SELECT id FROM pay.payment_events WHERE rail_event_id = ${deliveryKey}
    `;
    if (seen.length > 0) {
      return { railId: adapter.id, eventId: event.eventId, type: event.type, duplicate: true, paymentId: payment.id, applied: false };
    }

    // The effect. Every one of these is idempotent on the payment id, which is
    // what makes it safe to apply before the marker is written — and safe for
    // two concurrent deliveries of the same event to race here.
    let applied = false;
    switch (event.type) {
      case 'authorized':
        if (payment.status === 'created') {
          await this.authorize(payment.id);
          applied = true;
        }
        break;
      case 'captured':
        if (payment.status === 'authorized') {
          await this.capture(payment.id);
          applied = true;
        } else if (payment.status === 'created') {
          // Some rails announce authorization and capture in one delivery.
          await this.authorize(payment.id);
          await this.capture(payment.id);
          applied = true;
        }
        break;
      case 'failed':
        if (payment.status === 'created' || payment.status === 'authorized') {
          await this.markFailed(payment.id, event.failureCode ?? 'rail.failed');
          applied = true;
        }
        break;
      case 'refunded':
      case 'payout.completed':
        // Recorded, not acted on. A refund we did not initiate, or a payout the
        // rail is confirming, both need a human decision — acting on either
        // automatically would move money on a rail's say-so alone.
        break;
      case 'dispute.opened': {
        // Post the opening recipe via ledger-client, or named refuse. Never claim
        // posted without a tx id. Shortfall/won stay unwired (no invented cover).
        const disputeId = event.disputeId?.trim();
        if (disputeId) {
          const amount = event.amount === undefined ? payment.amount : formatAmount(event.amount);
          const assetId = event.assetId ?? payment.currency;
          const wire = await this.postChargebackOpenOrRefuse({
            disputeId,
            paymentId: payment.id,
            merchantId: payment.merchant_id,
            amount,
            assetId,
          });
          let marked = false;
          if (payment.status === 'settled' || payment.status === 'captured') {
            await this.markDisputed(payment.id, {
              disputeId,
              reasonCode: event.reasonCode ?? null,
              ledgerWire: wire.ledgerPost ? 'posted' : 'refused',
              ledgerTxId: wire.ledgerPost?.txId ?? null,
            });
            marked = true;
          }
          defaultDisputeCaseStore.open({
            disputeId,
            paymentId: payment.id,
            merchantId: payment.merchant_id,
            amount,
            assetId,
            reasonCode: event.reasonCode ?? null,
            paymentMarkedDisputed: marked,
            ledgerPost: wire.ledgerPost,
            ledgerRefuse: wire.ledgerRefuse,
          });
          applied = true;
        }
        break;
      }
      case 'dispute.won':
      case 'dispute.lost':
      case 'dispute.closed': {
        const disputeId = event.disputeId?.trim();
        if (disputeId && defaultDisputeCaseStore.get(disputeId)) {
          if (event.type === 'dispute.won') defaultDisputeCaseStore.markWon(disputeId);
          else if (event.type === 'dispute.lost') defaultDisputeCaseStore.markLost(disputeId);
          else defaultDisputeCaseStore.accept(disputeId);
          applied = true;
        }
        break;
      }
    }

    // The dedupe marker, written last. `ON CONFLICT DO NOTHING` because two
    // concurrent deliveries of one event both get here; the loser reports the
    // duplicate and neither has done anything twice.
    const claimed = await this.sql<Array<{ id: string }>>`
      INSERT INTO pay.payment_events (payment_id, event, payload, rail_event_id)
      VALUES (
        ${payment.id}, ${`webhook.${event.type}`},
        ${this.sql.json({
          type: event.type,
          railRef: event.railRef,
          amount: event.amount === undefined ? null : formatAmount(event.amount),
          assetId: event.assetId ?? null,
          occurredAt: event.occurredAt.toISOString(),
          failureCode: event.failureCode ?? null,
        } as never)},
        ${deliveryKey}
      )
      ON CONFLICT ("rail_event_id") WHERE "rail_event_id" IS NOT NULL DO NOTHING
      RETURNING id
    `;

    return {
      railId: adapter.id,
      eventId: event.eventId,
      type: event.type,
      duplicate: claimed.length === 0,
      paymentId: payment.id,
      applied,
    };
  }

  private async markFailed(paymentId: string, failureCode: string): Promise<void> {
    const view = await transaction(
      this.sql,
      async (tx) => {
        const row = await lockPayment(tx, paymentId);
        if (row.status !== 'created' && row.status !== 'authorized') return null;
        await appendEvent(tx, row.id, 'failed', { failureCode });
        await tx`UPDATE pay.payments SET status = 'failed', updated_at = now() WHERE id = ${row.id}`;
        return this.view(tx, { ...row, status: 'failed' });
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
    if (view) this.notifyPaymentEvent('payment.failed', view);
  }

  /**
   * D26-P1-P5 — make `captured|settled → disputed` reachable so settlement
   * cannot freeze a payment whose clearing already left via the opening recipe.
   *
   * Status only. Money moves in `openChargeback` / is named-refused there.
   */
  async markDisputed(
    paymentId: string,
    meta: {
      disputeId: string;
      reasonCode?: string | null;
      ledgerWire?: 'posted' | 'refused';
      ledgerTxId?: string | null;
    },
  ): Promise<PaymentView> {
    const ledgerWire = meta.ledgerWire ?? 'refused';
    return transaction(
      this.sql,
      async (tx) => {
        const row = await lockPayment(tx, paymentId);
        assertTransition(row, 'disputed');
        await appendEvent(tx, row.id, 'disputed', {
          disputeId: meta.disputeId,
          reasonCode: meta.reasonCode ?? null,
          ledgerWire,
          ledgerTxId: meta.ledgerTxId ?? null,
          ledgerSocket: ledgerWire === 'posted' ? null : 'socket.pay-chargeback-ledger-wire',
        });
        await tx`UPDATE pay.payments SET status = 'disputed', updated_at = now() WHERE id = ${row.id}`;
        return this.view(tx, { ...row, status: 'disputed' });
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  // ── Settlement (§6.1) ──────────────────────────────────────────────────────

  /**
   * Settle a window: merchant net posts to their ledger account — "the same
   * balance graph they trade and spend from — the doc's promise, kept".
   *
   * Two phases, because the alternative silently loses money:
   *
   *   1. Freeze. The payment set is fixed by appending `settlement.included` to
   *      each payment, and gross/fees/net are computed and stored `pending`.
   *   2. Post. The ledger transaction uses the FROZEN numbers.
   *
   * If it were one phase, a crash between posting and committing would leave a
   * ledger transaction keyed `settlement:<merchant>:<window>:<asset>` for one
   * gross while a retry — now including a payment that landed in the meantime —
   * computed a different gross, posted it, and got the ORIGINAL transaction
   * back from the idempotency check. The database would then record a
   * settlement the ledger never made. Freezing first makes the retry
   * arithmetically identical.
   *
   * MERCHANT STATUS. Only an `active` merchant freezes a new window or posts
   * one. `createPayment` and public checkout already refuse non-active; until
   * this gate, a suspended merchant could still settle captured volume and take
   * it out via `payoutSettlement` — suspension that stopped inbound only.
   * Re-reading an already-posted settlement is still fine (no value moves).
   */
  async settleWindow(input: {
    merchantId: string;
    /** Window label, e.g. '2026-07-27'. Half the business key. */
    window: string;
    assetId: string;
    /** Defaults to the UTC day named by `window`. */
    from?: Date;
    to?: Date;
  }): Promise<SettlementRecord> {
    return withMoneySpan(
      'pay.settleWindow',
      { operation: 'settlement', merchantId: input.merchantId, window: input.window, assetId: input.assetId },
      async (span) => {
        const prepared = await this.prepareSettlement(input);
        if (prepared.status !== 'pending') return prepared;
        return this.postPendingSettlement(prepared.id, span);
      },
    );
  }

  /**
   * Phase 2 of settle — post ledger + project, keyed by settlement id.
   * Used by settleWindow and by release heal (which must not re-parse window
   * labels — custom windows need from/to that release does not have).
   */
  private async postPendingSettlement(
    settlementId: string,
    span?: { setAttribute: (k: string, v: string | number) => void },
  ): Promise<SettlementRecord> {
    const head = await this.sql<SettlementRow[]>`
      SELECT id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
        FROM pay.settlements WHERE id = ${settlementId}
    `;
    const current = head[0];
    if (!current) throw new PayError(`Settlement ${settlementId} not found`, 'pay.settlement_not_found');
    if (current.status !== 'pending') return toSettlement(current);

    const merchant = await this.getMerchant(current.merchant_id);
    // About to post gross → merchant available. Suspension mid-freeze must
    // not finish the move; captured volume stays in clearing until reopen.
    this.assertMerchantActive(merchant);

    const posted = await transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<SettlementRow[]>`
          SELECT id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
            FROM pay.settlements WHERE id = ${settlementId} FOR UPDATE
        `;
        const row = rows[0]!;
        if (row.status !== 'pending') return toSettlement(row);

        const gross = parseAmount(row.gross);
        const fees = parseAmount(row.fees);

        const included = await tx<Array<{ payment_id: string }>>`
          SELECT payment_id FROM pay.payment_events
           WHERE event = 'settlement.included' AND payload->>'settlementId' = ${row.id}
           ORDER BY payment_id
        `;

        // Re-check live nets under payment row locks before the ledger
        // moves. The freeze promised these numbers; if a concurrent path
        // (or an operator) changed captured/refunded, posting the frozen
        // gross would take someone else's clearing.
        let liveGross = 0n;
        for (const { payment_id } of included) {
          await lockPayment(tx, payment_id);
          const totals = await totalsFor(tx, payment_id);
          const net = totals.captured - totals.refunded;
          if (net > 0n) liveGross += net;
        }
        if (liveGross !== gross) {
          throw new PayError(
            `Settlement ${row.id} frozen gross ${formatAmount(gross)} no longer matches live captured−refunded ${formatAmount(liveGross)} — refusing to post`,
            'pay.settlement_desynced',
            {
              settlementId: row.id,
              frozenGross: formatAmount(gross),
              liveGross: formatAmount(liveGross),
            },
          );
        }

        await this.ledger.post(
          recipes.merchantSettlement({
            merchantId: row.merchant_id,
            merchantUserId: merchant.userId,
            window: row.window,
            assetId: row.asset_id,
            gross,
            fee: fees,
          }),
        );

        await tx`
          UPDATE pay.settlements SET status = 'posted', payout_method = 'ledger', updated_at = now()
           WHERE id = ${row.id}
        `;

        for (const { payment_id } of included) {
          await appendEvent(tx, payment_id, 'settled', {
            settlementId: row.id,
            window: row.window,
            assetId: row.asset_id,
          });
          await tx`
            UPDATE pay.payments SET status = 'settled', updated_at = now()
             WHERE id = ${payment_id} AND status = 'captured'
          `;
        }

        span?.setAttribute('intafaced.amount', formatAmount(parseAmount(row.net)));
        span?.setAttribute('intafaced.payments', included.length);
        return toSettlement({ ...row, status: 'posted', payout_method: 'ledger' });
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
    await this.notifyPayAffiliateAccrue(posted, merchant.userId);
    await this.notifyPayAffiliatePayout(posted, merchant.userId);
    return posted;
  }

  /** Best-effort; never throws. Settlement already committed. */
  private async notifyPayAffiliateAccrue(posted: SettlementRecord, merchantUserId: string): Promise<void> {
    if (posted.status !== 'posted') return;
    await fireAffiliateAccrue(
      this.affiliateAccrue,
      affiliateLegAfterPaySettlement({
        settlementId: posted.id,
        merchantUserId,
        feeAmount: posted.fees,
        feeAsset: posted.assetId,
      }),
    );
  }

  /** Best-effort payout after accrue; never throws. Settlement already committed. */
  private async notifyPayAffiliatePayout(posted: SettlementRecord, merchantUserId: string): Promise<void> {
    if (posted.status !== 'posted') return;
    await fireAffiliatePayout(
      this.affiliatePayout,
      affiliateLegAfterPaySettlement({
        settlementId: posted.id,
        merchantUserId,
        feeAmount: posted.fees,
        feeAsset: posted.assetId,
      }),
    );
  }

  /**
   * Phase 1: freeze the set and the numbers. No external call, no value moved.
   *
   * Returning an already-frozen row is allowed for a non-active merchant (the
   * freeze already happened). Creating a NEW freeze is not — that would lock
   * more payments into a settlement a suspended operator can then try to post.
   */
  private async prepareSettlement(input: {
    merchantId: string;
    window: string;
    assetId: string;
    from?: Date;
    to?: Date;
  }): Promise<SettlementRecord> {
    const { from, to } = windowBounds(input.window, input.from, input.to);
    const merchant = await this.getMerchant(input.merchantId);
    const feeBps = merchant.pricing.feeBps !== undefined ? merchant.pricing.feeBps : publishedDefaultFeeBps(this.defaultFeeBps);

    return transaction(
      this.sql,
      async (tx) => {
        // Lock the merchant, not the settlement row (which may not exist yet).
        // Two settlement runs for one merchant must queue, or both would select
        // the same unsettled payments and freeze them into two settlements.
        // Re-read status under the lock so a suspend that races the getMerchant
        // above cannot slip a freeze through.
        const locked = await tx<Array<{ status: MerchantRecord['status']; kyb_status: MerchantRecord['kybStatus'] }>>`
          SELECT status, kyb_status FROM pay.merchants WHERE id = ${input.merchantId} FOR UPDATE
        `;
        const lockedRow = locked[0];
        if (!lockedRow) {
          throw new PayError(`Merchant ${input.merchantId} not found`, 'pay.merchant_not_found');
        }
        await this.afterSettlementMerchantLock?.();

        const existing = await tx<SettlementRow[]>`
          SELECT id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
            FROM pay.settlements
           WHERE merchant_id = ${input.merchantId} AND "window" = ${input.window} AND asset_id = ${input.assetId}
        `;
        if (existing[0]) return toSettlement(existing[0]);

        if (lockedRow.status !== 'active') {
          throw new PayError(`Merchant ${input.merchantId} is ${lockedRow.status}`, 'pay.merchant_inactive');
        }
        const kybRefuse = merchantKybMoneyGateRefusal({
          merchantId: input.merchantId,
          status: lockedRow.status,
          kybStatus: lockedRow.kyb_status,
          valueMovement: this.valueMovement,
        });
        if (kybRefuse) {
          throw new PayError(kybRefuse.message, kybRefuse.code, kybRefuse.detail);
        }

        // Candidate ids only first — lock each payment FOR UPDATE before reading
        // totals so a concurrent pre-settlement refund cannot drain clearing
        // after we freeze a gross that still included that payment.
        const candidateIds = await tx<Array<{ id: string }>>`
          SELECT p.id
            FROM pay.payments p
           WHERE p.merchant_id = ${input.merchantId}
             AND p.currency = ${input.assetId}
             AND p.status = 'captured'
             AND NOT EXISTS (
               -- Frozen into a settlement that has not been released. A released
               -- inclusion (ops path after desync) is eligible for a later window.
               SELECT 1 FROM pay.payment_events s
                WHERE s.payment_id = p.id AND s.event = 'settlement.included'
                  AND NOT EXISTS (
                    SELECT 1 FROM pay.payment_events r
                     WHERE r.payment_id = s.payment_id
                       AND r.event = 'settlement.released'
                       AND r.payload->>'settlementId' = s.payload->>'settlementId'
                  )
             )
             AND EXISTS (
               SELECT 1 FROM pay.payment_events c
                WHERE c.payment_id = p.id AND c.event = 'captured' AND c.ts >= ${from} AND c.ts < ${to}
             )
           ORDER BY p.id
           FOR UPDATE OF p
        `;

        let gross = 0n;
        const included: string[] = [];
        for (const { id: paymentId } of candidateIds) {
          // Skip payments with an open refund.posted — their clearing is already
          // leaving (or about to leave). Including them freezes a gross the
          // pool no longer holds.
          const openRefund = await tx<Array<{ refund_id: string }>>`
            SELECT p.payload->>'refundId' AS refund_id
              FROM pay.payment_events p
             WHERE p.payment_id = ${paymentId} AND p.event = 'refund.posted'
               AND NOT EXISTS (
                 SELECT 1 FROM pay.payment_events d
                  WHERE d.payment_id = p.payment_id
                    AND d.event IN ('refunded', 'refund.reversed')
                    AND d.payload->>'refundId' = p.payload->>'refundId'
               )
             LIMIT 1
          `;
          if (openRefund.length > 0) continue;

          const totals = await totalsFor(tx, paymentId);
          const net = totals.captured - totals.refunded;
          if (net <= 0n) continue; // Fully refunded inside the window — nothing to settle.
          gross += net;
          included.push(paymentId);
        }

        if (gross <= 0n) {
          throw new PayError(
            `Nothing to settle for merchant ${input.merchantId} in ${input.window} (${input.assetId})`,
            'pay.nothing_to_settle',
          );
        }

        // Fees round `ceil` — the house never pays a rounding unit on a merchant's
        // behalf, and the merchant is never short by one either, because net is
        // derived by subtraction rather than computed independently.
        const fees = mulBps(gross, feeBps, 'ceil');
        const net = gross - fees;
        if (net <= 0n) {
          throw new PayError(
            `Fee of ${formatAmount(fees)} consumes the whole ${formatAmount(gross)} window — check merchant pricing`,
            'pay.fee_exceeds_gross',
            { gross: formatAmount(gross), fees: formatAmount(fees), feeBps },
          );
        }

        const inserted = await tx<SettlementRow[]>`
          INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status)
          VALUES (
            ${input.merchantId}, ${input.window}, ${input.assetId},
            ${formatAmount(gross)}::numeric, ${formatAmount(fees)}::numeric, ${formatAmount(net)}::numeric, 'pending'
          )
          RETURNING id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
        `;
        const row = inserted[0]!;

        for (const paymentId of included) {
          await appendEvent(tx, paymentId, 'settlement.included', {
            settlementId: row.id,
            window: input.window,
            assetId: input.assetId,
          });
        }

        return toSettlement(row);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /**
   * G3 — release a stuck `pending` settlement so its payments can re-enter a
   * later window.
   *
   * After freeze, if post can never succeed (desync), payments stay marked
   * `settlement.included` forever and no later freeze can pick them up. This is
   * the honest ops path: mark the window `failed`, append `settlement.released`
   * per included payment, move no ledger value.
   *
   * HEAL BEFORE RELEASE. Dual-book lag (ledger `merchantSettlement` posted, SQL
   * txn rolled back) leaves the row `pending` while the merchant is already
   * credited. Releasing then would free payments into a later window and
   * double-credit under a new settlement key. Prefer `settleWindow` re-run —
   * which is idempotent on `settlement:<merchant>:<window>:<asset>` — and only
   * release when that re-run refuses as desynced (post truly cannot succeed).
   *
   * Only `pending` windows. Posted/paid_out/failed refuse (failed is idempotent).
   */
  async releasePendingSettlement(input: {
    settlementId: string;
    /** Free-text ops reason (journaled; required so silent cancels are impossible). */
    reason: string;
  }): Promise<SettlementRecord> {
    const reason = input.reason?.trim() ?? '';
    if (!reason) {
      throw new PayError('releasePendingSettlement requires a non-empty reason', 'pay.invalid_transition');
    }

    const head = await this.sql<SettlementRow[]>`
      SELECT id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
        FROM pay.settlements WHERE id = ${input.settlementId}
    `;
    const current = head[0];
    if (!current) throw new PayError(`Settlement ${input.settlementId} not found`, 'pay.settlement_not_found');
    if (current.status === 'failed') return toSettlement(current);
    if (current.status !== 'pending') {
      throw new PayError(
        `Settlement ${current.id} is ${current.status}; only a pending settlement can be released`,
        'pay.settlement_not_pending',
        { settlementId: current.id, status: current.status },
      );
    }

    // Prefer heal by settlement id (not settleWindow — custom window labels need
    // from/to that release does not carry). Ledger re-post is idempotent on
    // settlement:<merchant>:<window>:<asset>; projection catches up. Only
    // desync falls through to release.
    try {
      const healed = await this.postPendingSettlement(current.id);
      if (healed.status !== 'pending') return healed;
    } catch (err) {
      if (!(err instanceof PayError) || err.code !== 'pay.settlement_desynced') {
        throw err;
      }
    }

    return transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<SettlementRow[]>`
          SELECT id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
            FROM pay.settlements WHERE id = ${input.settlementId} FOR UPDATE
        `;
        const row = rows[0];
        if (!row) throw new PayError(`Settlement ${input.settlementId} not found`, 'pay.settlement_not_found');
        if (row.status === 'failed') return toSettlement(row);
        if (row.status !== 'pending') {
          // Healed under us, or concurrent post finished.
          return toSettlement(row);
        }

        const included = await tx<Array<{ payment_id: string }>>`
          SELECT payment_id FROM pay.payment_events
           WHERE event = 'settlement.included' AND payload->>'settlementId' = ${row.id}
           ORDER BY payment_id
        `;

        for (const { payment_id } of included) {
          await appendEvent(tx, payment_id, 'settlement.released', {
            settlementId: row.id,
            window: row.window,
            assetId: row.asset_id,
            reason,
          });
        }

        await tx`
          UPDATE pay.settlements SET status = 'failed', updated_at = now()
           WHERE id = ${row.id}
        `;

        return toSettlement({ ...row, status: 'failed' });
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /**
   * Pay a settled window out of the book, to a bank or a chain (§6.1 "payout to
   * bank/crypto via adapter `payout`").
   *
   * Reuses the ledger's existing withdrawal recipes rather than inventing a
   * fourth payment recipe, because the shape is exactly a withdrawal: hold the
   * funds while the rail works, settle on success, reverse on failure. There is
   * no state in which the merchant's money is neither in their available
   * balance, nor in their hold, nor gone with a rail reference against it.
   *
   * IF THIS CRASHES between the hold and the payout, the funds are in the
   * merchant's `hold` account and the settlement is still `posted`. Re-running
   * re-posts the hold (idempotent on the settlement id), asks the rail again
   * (idempotent on the settlement id), and finishes.
   */
  async payoutSettlement(input: {
    settlementId: string;
    railId: string;
    destination?: { kind: string; ref: string };
    identityAuthority?: import('@intafaced/contracts').IdentityOperationIntent['authority'];
  }): Promise<SettlementRecord> {
    return withMoneySpan(
      'pay.payoutSettlement',
      { operation: 'payout', settlementId: input.settlementId, rail: input.railId },
      async () => {
        return withPayoutLock(this.sql, input.settlementId, async (connection) => {
          const settlement = await this.getSettlement(input.settlementId, connection);
          let admission = await loadPayoutAdmission(connection, settlement.id, settlement.payoutAttempts);
          if (admission) {
            if (
              admission.rail_id !== input.railId ||
              (input.destination &&
                (input.destination.kind.trim() !== admission.destination_kind ||
                  input.destination.ref.trim() !== admission.destination_ref)) ||
              parseAmount(admission.net) !== settlement.net ||
              admission.asset_id !== settlement.assetId ||
              admission.window !== settlement.window ||
              admission.merchant_id !== settlement.merchantId
            ) {
              throw new PayError('Recovery parameters differ from the admitted payout', 'pay.payout_recovery_conflict');
            }
          }
          if (settlement.status === 'paid_out') return settlement;
          if (settlement.status !== 'posted' && settlement.status !== 'failed')
            throw new PayError('Settlement is not payable', 'pay.invalid_transition');
          const adapter = this.rails.require(admission?.rail_id ?? input.railId, 'payout');
          assertRailMayMoveValue(adapter, 'payout', this.valueMovement);
          if (!admission) {
            if (await this.ledger.getTxByKey(`withdraw.hold:${settlement.id}:${settlement.payoutAttempts}`))
              throw new PayError('Original payout owner record is missing', 'pay.payout_admission_missing');
            const merchant = await this.getMerchant(settlement.merchantId, connection);
            const destination = await this.resolvePayoutDestination(adapter.id, merchant.id, input.destination, connection);
            admission = await insertPayoutAdmission(
              connection,
              {
                settlement_id: settlement.id,
                merchant_id: merchant.id,
                merchant_user_id: merchant.userId,
                attempt: settlement.payoutAttempts,
                business_id: settlement.payoutAttempts === 0 ? settlement.id : `${settlement.id}:${settlement.payoutAttempts}`,
                net: formatAmount(settlement.net),
                asset_id: settlement.assetId,
                rail_id: adapter.id,
                destination_kind: destination.kind,
                destination_ref: destination.ref,
                window: settlement.window,
              },
              async (tx) => {
                this.assertMerchantActive(await this.lockMerchantEligibility(tx, merchant.id));
                if (await this.ledger.getTxByKey(`withdraw.hold:${settlement.id}:${settlement.payoutAttempts}`))
                  throw new PayError(
                    'Unrecorded payout requires attributed recovery; hold alone cannot establish original destination',
                    'pay.payout_admission_missing',
                  );
                const locked = await tx`SELECT status,payout_attempts FROM pay.settlements WHERE id=${settlement.id} FOR UPDATE`;
                if (
                  !locked[0] ||
                  !['posted', 'failed'].includes(String(locked[0].status)) ||
                  Number(locked[0].payout_attempts) !== settlement.payoutAttempts
                )
                  throw new PayError('Settlement changed before admission', 'pay.payout_recovery_conflict');
                if (adapter.id === 'crypto-native' && input.destination) {
                  await this.payoutDestinations.persist({ merchantId: merchant.id, railId: adapter.id, ...destination, connection: tx });
                }
              },
              this.identityOperationAdmission,
              input.identityAuthority,
              this.identityAuthorityGuard,
            );
            await this.afterPayoutAdmission?.();
          }
          try {
            await finalizePayoutIdentity(
              connection,
              admission,
              async (tx) => this.assertMerchantActive(await this.lockMerchantEligibility(tx, admission!.merchant_id)),
              this.identityOperationAdmission,
              this.identityAuthorityGuard,
            );
          } catch (error) {
            if (error instanceof PayoutAdmissionError) throw new PayError(error.message, error.code);
            throw error;
          }
          const plan = settlementLedgerPlan({
            settlementId: admission.settlement_id,
            payoutAttempt: admission.attempt,
            merchantUserId: admission.merchant_user_id,
            assetId: admission.asset_id,
            amount: parseAmount(admission.net),
            railId: admission.rail_id,
            destinationKind: admission.destination_kind,
          });
          const outcomes = await connection`SELECT kind,payload FROM pay.payout_outcomes WHERE admission_id=${admission.id}`;
          let accepted = outcomes.find((outcome) => outcome.kind === 'rail_accepted')?.payload as { railRef: string } | undefined;
          let refused = outcomes.find((outcome) => outcome.kind === 'rail_refused')?.payload as
            { failureReason: string; failureCode: string } | undefined;
          if (!refused && !accepted) {
            await this.ledger.post(plan.hold);
            const result = await withRailSpan(adapter.id, 'payout', () =>
              adapter.payout({
                settlementId: admission!.business_id,
                merchantId: admission!.merchant_id,
                amount: parseAmount(admission!.net),
                assetId: admission!.asset_id,
                window: admission!.window,
                destination: { kind: admission!.destination_kind, ref: admission!.destination_ref },
              }),
            );
            if (!result.ok) {
              refused = { failureReason: result.failureReason ?? 'Rail refused', failureCode: result.failureCode ?? 'rail.failed' };
              await connection`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${admission.id},'rail_refused',${connection.json(refused)})`;
            } else {
              if (result.amount !== parseAmount(admission.net) || result.assetId !== admission.asset_id)
                throw new PayError('Payout rail amount or asset differs', 'pay.rail_amount_mismatch');
              accepted = { railRef: result.railRef };
              await connection`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${admission.id},'rail_accepted',${connection.json(accepted)})`;
            }
          }
          if (!accepted) {
            await this.ledger.post(plan.reverse);
            await payoutTransaction(connection, async (tx) => {
              await tx`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${admission!.id},'reversed','{}') ON CONFLICT DO NOTHING`;
              await tx`UPDATE pay.settlements SET status='failed',payout_attempts=${admission!.attempt + 1},updated_at=now() WHERE id=${settlement.id}`;
            });
            throw new PayError(refused?.failureReason ?? 'Rail refused payout', 'pay.rail_failed', { failureCode: refused?.failureCode });
          }
          await this.ledger.post(plan.settle);
          await payoutTransaction(connection, async (tx) => {
            await tx`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${admission!.id},'settled','{}') ON CONFLICT DO NOTHING`;
            await tx`UPDATE pay.settlements SET status='paid_out',payout_method=${admission!.rail_id},payout_ref=${accepted!.railRef},updated_at=now() WHERE id=${settlement.id}`;
          });
          return { ...settlement, status: 'paid_out' as const, payoutMethod: admission.rail_id, payoutRef: accepted.railRef };
        });
      },
    ).catch((error) => {
      if (error instanceof PayoutAdmissionError) throw new PayError(error.message, error.code);
      throw error;
    });
  }

  /**
   * Resolve the original destination without writing before the merchant guard.
   * Crypto-native stores an offered destination inside admission preparation.
   * Refuse closed if no destination is offered or stored.
   * Does not invent a PSP. Does not live-wire bank-payout.
   */
  private async resolvePayoutDestination(
    railId: string,
    merchantId: string,
    offered?: { kind: string; ref: string },
    connection?: Sql,
  ): Promise<{ kind: string; ref: string }> {
    if (railId === 'crypto-native') {
      try {
        if (offered) {
          return assertPersistableDestination(railId, offered);
        }
        const stored = await this.payoutDestinations.require({ merchantId, railId, connection });
        assertPayoutDestinationKind(railId, stored);
        return stored;
      } catch (err) {
        if (err instanceof PayoutDestinationMissingError) {
          throw new PayError(err.message, 'pay.payout_destination_missing', { merchantId, railId });
        }
        if (err instanceof DestinationKindError) {
          throw new PayError(err.message, err.code);
        }
        throw err;
      }
    }

    if (!offered) {
      throw new PayError(`Merchant ${merchantId} has no payout destination for rail ${railId}`, 'pay.payout_destination_missing', {
        merchantId,
        railId,
      });
    }
    try {
      assertPayoutDestinationKind(railId, offered);
    } catch (err) {
      if (err instanceof DestinationKindError) {
        throw new PayError(err.message, err.code);
      }
      throw err;
    }
    return offered;
  }

  async getSettlement(settlementId: string, connection: Sql = this.sql): Promise<SettlementRecord> {
    const rows = await connection<SettlementRow[]>`
      SELECT id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
        FROM pay.settlements WHERE id = ${settlementId}
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Settlement ${settlementId} not found`, 'pay.settlement_not_found');
    return toSettlement(row);
  }

  /**
   * Merchant fleet list — settlements already stored; this only reads them.
   * No freeze, no post, no payout. Caller fences merchant ownership / area.
   */
  async listSettlements(input: { merchantId: string; status?: SettlementStatus; limit?: number }): Promise<SettlementRecord[]> {
    await this.getMerchant(input.merchantId);
    const limit = assertSettlementListLimit(input.limit);
    const rows = input.status
      ? await this.sql<SettlementRow[]>`
          SELECT id, merchant_id, "window", asset_id, gross, fees, net,
                 payout_method, payout_ref, payout_attempts, status
            FROM pay.settlements
           WHERE merchant_id = ${input.merchantId} AND status = ${input.status}
           ORDER BY created_at DESC
           LIMIT ${limit}
        `
      : await this.sql<SettlementRow[]>`
          SELECT id, merchant_id, "window", asset_id, gross, fees, net,
                 payout_method, payout_ref, payout_attempts, status
            FROM pay.settlements
           WHERE merchant_id = ${input.merchantId}
           ORDER BY created_at DESC
           LIMIT ${limit}
        `;
    return rows.map(toSettlement);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async getPayment(paymentId: string): Promise<PaymentView> {
    const rows = await this.sql<PaymentRow[]>`
      SELECT id, merchant_id, profile_id, amount, currency, method, rail_adapter, rail_ref, status, created_at
        FROM pay.payments WHERE id = ${paymentId}
    `;
    const row = rows[0];
    if (!row) throw new PayError(`Payment ${paymentId} not found`, 'pay.payment_not_found');
    return this.view(this.sql, row);
  }

  /** The append-only state history for one payment, oldest first (§6.1). Page size is owner-published — omit is not 50. */
  async history(paymentId: string, requestedLimit?: number): Promise<PaymentEventRecord[]> {
    const limit = assertPaymentHistoryLimit(requestedLimit);
    const rows = await this.sql<
      Array<{ id: string; event: string; payload: Record<string, unknown>; rail_event_id: string | null; ts: Date }>
    >`
      SELECT id, event, payload, rail_event_id, ts
        FROM pay.payment_events WHERE payment_id = ${paymentId} ORDER BY seq ASC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({ id: r.id, event: r.event, payload: r.payload, railEventId: r.rail_event_id, ts: r.ts }));
  }

  /**
   * What svc-pay currently owes a merchant but has not settled.
   *
   * Read from the LEDGER, not from these tables. Doctrine §0.6 means the
   * clearing account is the answer, and asking the ledger keeps the two
   * independent — which is the entire property a reconciliation job needs.
   */
  async clearingBalance(merchantId: string, assetId: string): Promise<Amount> {
    return (await this.ledger.balance(merchantClearing(merchantId, assetId))).amount;
  }

  /** What a merchant can actually spend — the balance they trade from. */
  async merchantBalance(merchantId: string, assetId: string): Promise<Amount> {
    const merchant = await this.getMerchant(merchantId);
    return (await this.ledger.balance(userAvailable(merchant.userId, assetId))).amount;
  }

  /**
   * Post the sole chargeback-open recipe. The recipe owns the legs; this
   * service only reads the two real pots and applies its documented
   * clearing-first split. No shortfall policy is invented here.
   */
  async openChargeback(input: {
    disputeId: string;
    paymentId: string;
    merchantId: string;
    amount: string;
    assetId: string;
  }): Promise<{ txId: string }> {
    const payment = await this.getPayment(input.paymentId);
    const merchant = await this.getMerchant(input.merchantId);
    if (payment.merchantId !== input.merchantId) throw new PayError('Payment does not belong to merchant', 'pay.payment_not_found');
    if (payment.assetId !== input.assetId) throw new PayError('Chargeback asset does not match payment', 'pay.invalid_amount');
    const amount = parseAmount(input.amount);
    const clearing = await this.clearingBalance(input.merchantId, input.assetId);
    const available = await this.merchantBalance(input.merchantId, input.assetId);
    const fromClearing = clearing < amount ? clearing : amount;
    const fromMerchantBalance = amount - fromClearing;
    if (fromMerchantBalance > available) {
      throw new PayError('Merchant balances cannot cover chargeback', 'pay.invalid_amount');
    }
    return postDisputeOpening(this.ledger, {
      disputeId: input.disputeId,
      paymentId: input.paymentId,
      merchantId: input.merchantId,
      merchantUserId: merchant.userId,
      assetId: input.assetId,
      rail: payment.railAdapter,
      fromClearing,
      fromMerchantBalance,
    });
  }

  /**
   * Webhook door: post the opening recipe or named refuse. Cover-fail does not
   * invent shortfall. Other ledger faults still throw so the rail can retry.
   */
  private async postChargebackOpenOrRefuse(input: {
    disputeId: string;
    paymentId: string;
    merchantId: string;
    amount: string;
    assetId: string;
  }): Promise<{ ledgerPost?: { txId: string }; ledgerRefuse?: ChargebackLedgerRefuse }> {
    try {
      return { ledgerPost: await this.openChargeback(input) };
    } catch (e) {
      if ((e instanceof PayError && e.code === 'pay.invalid_amount') || e instanceof InvalidEntryError) {
        return { ledgerRefuse: refuseChargebackUncovered({ disputeId: input.disputeId, paymentId: input.paymentId }) };
      }
      throw e;
    }
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
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Write a payment row and its `created` event.
 *
 * Extracted so `createPayment` (a merchant integration naming its own rail) and
 * `openCheckoutSession` (an anonymous payer on a rail the server chose) produce
 * BYTE-IDENTICAL rows and event payloads. Two code paths writing a payments row
 * two slightly different ways is how one of them ends up missing a field the
 * settlement sweep or a dispute later depends on.
 */
function paymentCreationPayload(input: Parameters<PayService['createPayment']>[0], paymentId: string): Record<string, unknown> {
  return {
    paymentId,
    merchantId: input.merchantId.toLowerCase(),
    profileId: input.profileId?.toLowerCase() ?? null,
    amount: formatAmount(input.amount),
    assetId: input.assetId,
    method: input.method,
    railAdapter: input.railAdapter,
    instrument: input.instrument ?? null,
    customerRef: input.customerRef ?? null,
    metadata: input.metadata ?? {},
  };
}
async function insertPayment(
  tx: Sql,
  input: {
    id?: string;
    merchantId: string;
    profileId?: string | null;
    amount: Amount;
    assetId: string;
    method: string;
    railAdapter: string;
    instrument?: PaymentIntent['instrument'];
    customerRef?: string;
    metadata?: Record<string, string>;
  },
): Promise<PaymentRow> {
  const rows = await tx<PaymentRow[]>`
    INSERT INTO pay.payments (id, merchant_id, profile_id, amount, currency, method, rail_adapter, status)
    VALUES (
      ${input.id ?? randomUUID()}, ${input.merchantId}, ${input.profileId ?? null}, ${formatAmount(input.amount)}::numeric,
      ${input.assetId}, ${input.method}, ${input.railAdapter}, 'created'
    )
    RETURNING id, merchant_id, profile_id, amount, currency, method, rail_adapter, rail_ref, status, created_at
  `;
  const row = rows[0]!;

  await appendEvent(tx, row.id, 'created', {
    amount: formatAmount(input.amount),
    assetId: input.assetId,
    method: input.method,
    railAdapter: input.railAdapter,
    customerRef: input.customerRef ?? null,
    // The instrument lives on the `created` event rather than in a column
    // because it is a rail's business, not ours, and because a tokenised
    // instrument is the sort of thing that must never end up in a WHERE clause
    // by accident.
    instrument: input.instrument ?? null,
    metadata: input.metadata ?? {},
  });

  return row;
}

/**
 * Mark a hosted-checkout session paid, and count the use against its link.
 *
 * Runs inside the capture transaction. Two properties are load-bearing:
 *
 *   IT IS IDEMPOTENT — the UPDATE only matches a session that is not already
 *   `completed` — so a redelivered webhook that re-runs capture does not count a
 *   second use against the link.
 *
 *   IT PROMOTES AN `expired` SESSION TO `completed`. A payer whose tab timed out
 *   and who then sent the funds anyway HAS PAID, and the session is the record of
 *   that payer's attempt. Leaving it `expired` next to a captured payment would
 *   be the books and the checkout disagreeing about the same money.
 *
 *   IT NEVER REFUSES. The link's `uses` is incremented UNCONDITIONALLY, even
 *   past `max_uses`. That is not sloppiness about the bound, it is the same rule
 *   that governs a deposit: money that has ALREADY ARRIVED must always be
 *   bookable. The bound is a gate on opening a checkout, where nothing has
 *   moved; enforcing it here would mean refusing to record value sitting at an
 *   address we control, and stranding it is a far worse outcome than a merchant
 *   taking one payment past their own ceiling.
 *
 * Which makes the bound honestly ADVISORY under concurrency: two payers who
 * open sessions at the same instant on a `maxUses: 1` link can both pay, and
 * both are booked. `payment_links.uses` then reads 2 and the next open is
 * refused. The service says so rather than implying a hard cap it cannot keep.
 */
async function completeCheckoutSession(tx: Sql, paymentId: string): Promise<void> {
  const closed = await tx<Array<{ link_id: string }>>`
    UPDATE pay.checkout_sessions
       SET status = 'completed', updated_at = now()
     WHERE payment_id = ${paymentId} AND status IN ('open', 'expired')
     RETURNING link_id
  `;
  for (const { link_id } of closed) {
    await tx`UPDATE pay.payment_links SET uses = uses + 1 WHERE id = ${link_id}`;
  }
}

/**
 * A session as the payer's browser sees it.
 *
 * The instruction is rebuilt from the row's own frozen amount and currency
 * rather than passed through from anywhere, so a page can never render a number
 * that differs from the one the payment was created for.
 */
function toCheckoutSessionView(row: CheckoutSessionRow, label: string, method: string): CheckoutSessionView {
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
  };
}

async function readPayment(tx: Sql, paymentId: string): Promise<PaymentRow> {
  const rows = await tx<PaymentRow[]>`
    SELECT id, merchant_id, profile_id, amount, currency, method, rail_adapter, rail_ref, status, created_at
      FROM pay.payments WHERE id = ${paymentId}
  `;
  const row = rows[0];
  if (!row) throw new PayError(`Payment ${paymentId} not found`, 'pay.payment_not_found');
  return row;
}

async function lockPayment(tx: Sql, paymentId: string): Promise<PaymentRow> {
  const rows = await tx<PaymentRow[]>`
    SELECT id, merchant_id, profile_id, amount, currency, method, rail_adapter, rail_ref, status, created_at
      FROM pay.payments WHERE id = ${paymentId} FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new PayError(`Payment ${paymentId} not found`, 'pay.payment_not_found');
  return row;
}

function assertTransition(row: PaymentRow, next: PaymentStatus): void {
  if (!TRANSITIONS[row.status].includes(next)) {
    throw new PayError(`Payment ${row.id} cannot go from ${row.status} to ${next}`, 'pay.invalid_transition', {
      from: row.status,
      to: next,
    });
  }
}

/**
 * Captured and refunded totals, summed from the append-only log.
 *
 * Deliberately not columns. A running total on the payment row would be a
 * second source of truth for money, and the day it disagrees with the event log
 * is the day nobody can say which one was right.
 */
async function totalsFor(sql: Sql, paymentId: string): Promise<{ captured: Amount; refunded: Amount }> {
  const rows = await sql<Array<{ captured: string; refunded: string }>>`
    SELECT
      COALESCE(SUM(CASE WHEN event = 'captured' THEN (payload->>'amount')::numeric END), 0) AS captured,
      COALESCE(SUM(CASE WHEN event = 'refunded' THEN (payload->>'amount')::numeric END), 0) AS refunded
      FROM pay.payment_events WHERE payment_id = ${paymentId}
  `;
  const row = rows[0];
  return { captured: parseAmount(row?.captured ?? '0'), refunded: parseAmount(row?.refunded ?? '0') };
}

async function countEvents(sql: Sql, paymentId: string, event: string): Promise<number> {
  const rows = await sql<Array<{ n: string }>>`
    SELECT COUNT(*)::text AS n FROM pay.payment_events WHERE payment_id = ${paymentId} AND event = ${event}
  `;
  return Number.parseInt(rows[0]?.n ?? '0', 10);
}

async function appendEvent(sql: Sql, paymentId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  await sql`
    INSERT INTO pay.payment_events (payment_id, event, payload)
    VALUES (${paymentId}, ${event}, ${sql.json(payload as never)})
  `;
}

/** The instrument the payment was created with, read back off the `created` event. */
async function instrumentFor(sql: Sql, paymentId: string): Promise<PaymentIntent['instrument']> {
  const rows = await sql<Array<{ payload: Record<string, unknown> }>>`
    SELECT payload FROM pay.payment_events WHERE payment_id = ${paymentId} AND event = 'created' LIMIT 1
  `;
  const instrument = rows[0]?.payload?.instrument;
  if (typeof instrument !== 'object' || instrument === null) return undefined;
  const i = instrument as Record<string, unknown>;
  if (typeof i.kind !== 'string') return undefined;
  return {
    kind: i.kind,
    token: typeof i.token === 'string' ? i.token : undefined,
    address: typeof i.address === 'string' ? i.address : undefined,
  };
}

function railPayload(result: RailResult): Record<string, unknown> {
  return {
    ok: result.ok,
    status: result.status,
    railRef: result.railRef,
    // Decimal string. A bigint does not survive JSON and a number does not
    // survive 18 decimal places.
    amount: formatAmount(result.amount),
    assetId: result.assetId,
    at: result.at.toISOString(),
    failureCode: result.failureCode ?? null,
    failureReason: result.failureReason ?? null,
  };
}

function toMerchant(row: MerchantRow): MerchantRecord {
  const feeBps = row.pricing?.feeBps;
  if (feeBps !== undefined && (typeof feeBps !== 'number' || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000)) {
    throw new PayError(`Merchant ${row.id} has malformed pricing`, 'pay.merchant_pricing_invalid', { pricing: row.pricing });
  }
  return {
    id: row.id,
    userId: row.user_id,
    mode: row.mode,
    tier: Number(row.tier),
    kybStatus: row.kyb_status,
    kybRef: row.kyb_ref ?? null,
    status: row.status,
    pricing: { feeBps: typeof feeBps === 'number' ? feeBps : undefined },
    settlementPrefs: row.settlement_prefs ?? {},
  };
}

function toPayment(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    profileId: row.profile_id,
    amount: parseAmount(row.amount),
    assetId: row.currency,
    method: row.method,
    railAdapter: row.rail_adapter,
    railRef: row.rail_ref,
    status: row.status,
    createdAt: row.created_at,
  };
}

function toSettlement(row: SettlementRow): SettlementRecord {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    window: row.window,
    assetId: row.asset_id,
    gross: parseAmount(row.gross),
    fees: parseAmount(row.fees),
    net: parseAmount(row.net),
    payoutMethod: row.payout_method,
    payoutRef: row.payout_ref,
    payoutAttempts: Number(row.payout_attempts),
    status: row.status,
  };
}

function assertFeeBps(feeBps: number): void {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new PayError(`Fee must be an integer between 0 and 10000 bps, got ${feeBps}`, 'pay.merchant_pricing_invalid');
  }
}

/** `'2026-07-27'` → that UTC day, half-open. Explicit bounds win. */
function windowBounds(window: string, from?: Date, to?: Date): { from: Date; to: Date } {
  if (from && to) return { from, to };
  const day = /^\d{4}-\d{2}-\d{2}$/.test(window) ? new Date(`${window}T00:00:00.000Z`) : null;
  if (!day || Number.isNaN(day.getTime())) {
    throw new PayError(
      `Window "${window}" is not a YYYY-MM-DD date; pass explicit from/to bounds for a custom window`,
      'pay.invalid_window',
    );
  }
  return { from: day, to: new Date(day.getTime() + 24 * 60 * 60 * 1000) };
}
