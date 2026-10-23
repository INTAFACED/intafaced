import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { checkOfferLimit, NO_OFFER_LIMITS, type OfferLimitPolicy } from './merchant-limits.js';
import type { MerchantStatus } from './merchant-programme.js';
import { isSupportedFiat } from '@intafaced/config';
import type { EventBus } from '@intafaced/events';
import {
  InsufficientFundsError,
  formatAmount,
  parseAmount,
  recipes,
  mulBps,
  tradeEscrowAccount,
  type Amount,
  type LedgerClient,
} from '@intafaced/ledger-client';
import { lockInstrumentOwners } from './instrument-lock.js';
import { assertWithinBounds, partiesFor, quote, PricingError, type PriceType, type ReferencePriceSource } from './pricing.js';
import {
  DEFAULT_DEADLINES,
  assertTransition,
  deadlineFor,
  escalationDeadline,
  holdsEscrow,
  isTerminal,
  timeoutActionFor,
  withDeadline,
  TradeStateError,
  type DeadlinePolicy,
  type Deadlines,
  type TradeResolution,
  type TradeStatus,
} from './state.js';
import {
  DEFAULT_XP_POLICY,
  EMPTY_COUNTERS,
  applyOutcome,
  snapshotOf,
  xpFor,
  xpKey,
  type P2pXpAction,
  type ReputationCounters,
  type ReputationSnapshot,
  type TradeOutcome,
  type XpPolicy,
} from './reputation.js';
import { InstrumentError, methodIdKey, methodsWithLiveDestination, missingSellDestinations, sellOfferBoardable } from './instruments.js';
import { P2P_COPY, resolveP2pCopy } from './user-copy.js';
import type { DenialSink } from './instrument-service.js';
import { withMoneySpan, withSpan } from './tracing.js';
import { affiliateLegAfterP2pRelease, fireAffiliateAccrue, NoopAffiliateAccrue, type AffiliateAccruePort } from './affiliate-accrue.js';
import { fireAffiliatePayout, NoopAffiliatePayout, type AffiliatePayoutPort } from './affiliate-payout.js';

/**
 * svc-p2p — PEER-TO-PEER TRADING WITH ESCROW (§6.2).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE THING THIS FILE IS FOR
 *
 * Locked funds must always reach exactly one terminal state. Not usually. Not
 * after an operator intervenes. Always, including when the process dies at the
 * worst possible instruction.
 *
 * Two properties do the work, and everything else is bookkeeping around them:
 *
 *   1 · **DECIDE, THEN POST.** A terminal decision is written and committed to
 *       `p2p_trades.resolution` BEFORE the ledger post that acts on it. The
 *       database allows exactly one resolution per trade
 *       (`p2p_trades_resolution_matches_status_ck`), so "released to both
 *       parties" is not a race to lose — it is a row that cannot be written.
 *       Crash between the decision and the post and the funds are *late*, not
 *       stranded: `sweepSettlements()` finds `resolved_at IS NOT NULL AND
 *       settled_at IS NULL` and re-posts, and every recipe is keyed on the
 *       trade id so re-posting moves nothing twice.
 *
 *   2 · **RE-DRIVE, DON'T INTERROGATE.** "Did the escrow lock post?" is
 *       answered by calling `escrowLock` again. Its business key
 *       (`p2p.escrow.lock:<tradeId>`) makes a retry return the original
 *       transaction if it did, and fail on funds if it did not. So a trade
 *       stuck in `created` is never ambiguous, and — critically — a refund is
 *       never posted against an escrow that was never funded. That matters
 *       because escrow is pooled per (user, asset): a spurious refund would not
 *       fail, it would quietly pay the seller out of somebody else's trade.
 *
 * Doctrine §0.6: this service holds no balances. `p2p_trades.amount` is the
 * quantity that was locked, recorded once and never mutated. The value itself
 * is in the ledger's `escrow` account kind, and `escrowIntegrity()` proves the
 * two agree.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type P2pErrorCode =
  | 'p2p.offer_not_found'
  | 'p2p.offer_not_active'
  | 'p2p.offer_method_unsupported'
  | 'p2p.self_trade'
  | 'p2p.trade_not_found'
  | 'p2p.trade_exists'
  | 'p2p.trade_id_required'
  | 'p2p.not_a_party'
  | 'p2p.not_the_seller'
  | 'p2p.not_the_buyer'
  | 'p2p.dispute_not_found'
  | 'p2p.dispute_already_open'
  | 'p2p.dispute_already_resolved'
  | 'p2p.escrow_missing'
  // The trade changed state between the moment a caller decided what to do with
  // it and the moment it took the row lock to do it. The timeout sweep is the
  // caller this exists for: it reads a status, then acts on it several round
  // trips later, and the action for the state it read is not the action for the
  // state the trade is now in.
  | 'p2p.trade_moved'
  | 'p2p.trading_disabled'
  | 'p2p.dispute_evidence_rejected'
  | 'p2p.erase_blocked'
  // An erase reached the end of its transaction unable to honestly make the
  // report it was about to return, so it rolled back rather than commit a
  // manifest that was wrong. See the re-assertion at the end of `eraseFor`.
  | 'p2p.erase_raced'
  // A ruling on a dispute was offered without a person's name on it.
  | 'p2p.ruling_not_attributed'
  /** Merchant programme (TRK-p2p.merchants Stage 1). */
  | 'p2p.merchant_ineligible'
  | 'p2p.merchant_exists'
  | 'p2p.merchant_not_found'
  | 'p2p.merchant_reason_required'
  | 'p2p.merchant_transition_invalid'
  | 'p2p.offer_limit_exceeded'
  // merchants.history page size unpublished. Blank is not the whole event log.
  | 'p2p.merchant_history_limit_unset'
  // offers.list page size unpublished. Blank is not 50.
  | 'p2p.offer_list_limit_unset'
  // disputes.list page size unpublished. Blank is not 50.
  | 'p2p.dispute_list_limit_unset'
  // ops.lateSettlements page size unpublished. Blank is not 100.
  | 'p2p.late_settlements_list_limit_unset'
  // trades.list page size unpublished. Blank is not 50.
  | 'p2p.trade_list_limit_unset'
  // sweepSettlements / sweepDeadlines batch unpublished. Blank is not 100.
  | 'p2p.sweep_settlements_limit_unset'
  | 'p2p.sweep_deadlines_limit_unset'
  // Fractional fee_bps would round in Postgres numeric(8,0); refuse instead.
  | 'p2p.invalid_fee_bps'
  // Owner house take unpublished. Blank P2P_FEE_BPS is not 30 and not 0.
  | 'p2p.fee_bps_unset'
  // Owner escrow clock unpublished. Blank P2P_ESCROW_DEADLINE_SECONDS is not 120.
  | 'p2p.escrow_deadline_unset'
  | 'p2p.invalid_escrow_deadline'
  // Owner instrument retention unpublished. Blank P2P_INSTRUMENT_RETENTION_DAYS is not 90.
  | 'p2p.instrument_retention_unset'
  | 'p2p.invalid_instrument_retention'
  // Owner payment/release/sweep/dispute SLA unpublished. Blank is not 15m / 30m / 7d / 1h / 30s.
  | 'p2p.payment_deadline_unset'
  | 'p2p.invalid_payment_deadline'
  | 'p2p.release_deadline_unset'
  | 'p2p.invalid_release_deadline'
  | 'p2p.dispute_sla_unset'
  | 'p2p.invalid_dispute_sla'
  | 'p2p.dispute_escalation_recheck_unset'
  | 'p2p.invalid_dispute_escalation_recheck'
  | 'p2p.sweep_interval_unset'
  | 'p2p.invalid_sweep_interval'
  // amount - ceil(fee) would leave the buyer with nothing — ledger refuses the
  // release recipe forever after a decision would strand the pot as late.
  | 'p2p.release_unpostable'
  // Deployment has no moderator allowlist and the caller does not hold
  // admin:compliance — the queue exists but nobody can authenticate into it.
  | 'p2p.moderation_unreachable'
  // Allowlist is set; this principal is simply not on it.
  | 'p2p.not_a_moderator'
  // Open wrote a dispute without a thread id. Should not happen: open allocates
  // when the trade has none. Named so a client never sees a fake empty chat.
  | 'p2p.chat_thread_unset'
  // Payment-instrument details are jsonb at rest. Live offer create stays
  // refuse-closed until OWNER KMS envelope encryption is wired — a key
  // improvised here is the appearance of protection without the substance.
  | 'p2p.instrument_kms_required';

/**
 * A lowercase canonical UUID — the natural-person identifier space, and the ONE
 * kind of principal that may rule on a dispute.
 *
 * The same rule as `p2p.is_natural_person_id` in
 * `drizzle/0003_p2p_dispute_ruling_invariant.sql`, and it lives in both places
 * on purpose: this one gives a caller a sentence they can act on, and the SQL
 * one is what makes it true against a migration, a psql session, or a writer
 * that never came through this service. Same arrangement as
 * `assertOwnerIdentifierSpace` and svc-ledger's §4.2 CHECK, which is where this
 * identifier space is defined.
 *
 * An ALLOWLIST, replacing a `LIKE 'system:%'` denylist that `System:p2p-backstop`
 * walked straight through — along with `automation:p2p` and `p2p-backstop`. A
 * denylist has to name every way a machine might describe itself and is wrong
 * as soon as someone invents another; the set of ways a PERSON is named here is
 * closed and has one member. Lowercase specifically, for the reason svc-ledger
 * 0005 STEP 1 gives: accepting both cases of one UUID is how a case bypass
 * re-enters through the identifier instead of through the namespace.
 */
export const NATURAL_PERSON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isNaturalPersonId = (id: string | null | undefined): boolean => typeof id === 'string' && NATURAL_PERSON_ID.test(id);

export class P2pError extends Error {
  constructor(
    message: string,
    readonly code: P2pErrorCode,
  ) {
    super(message);
    this.name = 'P2pError';
  }
}

/**
 * Absent and not-yours are this one error.
 *
 * The id is the one the caller already typed. A missing row and a trade the
 * caller is not a party to must produce the same code and the same sentence,
 * or a probe can tell them apart. A party still gets the specific refusal.
 */
export function unknownTrade(tradeId: string): P2pError {
  return new P2pError(`Trade ${tradeId} not found`, 'p2p.trade_not_found');
}

/** Owner-published offers.list page size. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertOfferListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new P2pError(resolveP2pCopy(P2P_COPY.offerListLimitUnset), 'p2p.offer_list_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new P2pError(resolveP2pCopy(P2P_COPY.offerListLimitUnset), 'p2p.offer_list_limit_unset');
  }
  return Math.min(200, n);
}

/** Owner-published disputes.list page size. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertDisputeListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new P2pError(resolveP2pCopy(P2P_COPY.disputeListLimitUnset), 'p2p.dispute_list_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new P2pError(resolveP2pCopy(P2P_COPY.disputeListLimitUnset), 'p2p.dispute_list_limit_unset');
  }
  return Math.min(200, n);
}

/** Owner-published ops.lateSettlements page size. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertLateSettlementsListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new P2pError(resolveP2pCopy(P2P_COPY.lateSettlementsListLimitUnset), 'p2p.late_settlements_list_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new P2pError(resolveP2pCopy(P2P_COPY.lateSettlementsListLimitUnset), 'p2p.late_settlements_list_limit_unset');
  }
  return Math.min(200, n);
}

/** Owner-published trades.list page size. Blank / non-finite / <1 refuses. Never invent 50. */
export function assertTradeListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new P2pError(resolveP2pCopy(P2P_COPY.tradeListLimitUnset), 'p2p.trade_list_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new P2pError(resolveP2pCopy(P2P_COPY.tradeListLimitUnset), 'p2p.trade_list_limit_unset');
  }
  return Math.min(200, n);
}

/** Owner-published settlement-sweep batch. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertSweepSettlementsLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new P2pError(resolveP2pCopy(P2P_COPY.sweepSettlementsLimitUnset), 'p2p.sweep_settlements_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new P2pError(resolveP2pCopy(P2P_COPY.sweepSettlementsLimitUnset), 'p2p.sweep_settlements_limit_unset');
  }
  return Math.min(200, n);
}

/** Owner-published deadline-sweep batch. Blank / non-finite / <1 refuses. Never invent 100. */
export function assertSweepDeadlinesLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new P2pError(resolveP2pCopy(P2P_COPY.sweepDeadlinesLimitUnset), 'p2p.sweep_deadlines_limit_unset');
  }
  const n = Math.floor(limit);
  if (n < 1) {
    throw new P2pError(resolveP2pCopy(P2P_COPY.sweepDeadlinesLimitUnset), 'p2p.sweep_deadlines_limit_unset');
  }
  return Math.min(200, n);
}

/** Published house take, or refuse. Blank env is not 30 and not 0. */
export function publishedFeeBps(feeBps: number | null | undefined): number {
  if (feeBps == null) {
    throw new P2pError('P2P_FEE_BPS is unset — refusing rather than inventing a house take', 'p2p.fee_bps_unset');
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 9_999) {
    throw new P2pError(`fee_bps must be an integer in 0..9999, got ${feeBps}`, 'p2p.invalid_fee_bps');
  }
  return feeBps;
}

/** Published created-state escrow clock, or refuse. Blank env is not 120s. */
export function publishedEscrowDeadlineSeconds(seconds: number | null | undefined): number {
  if (seconds == null) {
    throw new P2pError('P2P_ESCROW_DEADLINE_SECONDS is unset — refusing rather than inventing 120s', 'p2p.escrow_deadline_unset');
  }
  if (!Number.isInteger(seconds) || seconds < 30) {
    throw new P2pError(`P2P_ESCROW_DEADLINE_SECONDS must be an integer ≥ 30, got ${seconds}`, 'p2p.invalid_escrow_deadline');
  }
  return seconds;
}

/** Published closed-trade instrument retention, or refuse. Blank env is not 90d. */
export function publishedInstrumentRetentionDays(days: number | null | undefined): number {
  if (days == null) {
    throw new P2pError('P2P_INSTRUMENT_RETENTION_DAYS is unset — refusing rather than inventing 90d', 'p2p.instrument_retention_unset');
  }
  if (!Number.isInteger(days) || days < 30 || days > 3_650) {
    throw new P2pError(`P2P_INSTRUMENT_RETENTION_DAYS must be an integer in 30..3650, got ${days}`, 'p2p.invalid_instrument_retention');
  }
  return days;
}

/** Published escrowed-state payment clock, or refuse. Blank env is not 15m. */
export function publishedPaymentDeadlineSeconds(seconds: number | null | undefined): number {
  if (seconds == null) {
    throw new P2pError('P2P_PAYMENT_DEADLINE_SECONDS is unset — refusing rather than inventing 15m', 'p2p.payment_deadline_unset');
  }
  if (!Number.isInteger(seconds) || seconds < 60) {
    throw new P2pError(`P2P_PAYMENT_DEADLINE_SECONDS must be an integer ≥ 60, got ${seconds}`, 'p2p.invalid_payment_deadline');
  }
  return seconds;
}

/** Published fiat_sent-state release clock, or refuse. Blank env is not 30m. */
export function publishedReleaseDeadlineSeconds(seconds: number | null | undefined): number {
  if (seconds == null) {
    throw new P2pError('P2P_RELEASE_DEADLINE_SECONDS is unset — refusing rather than inventing 30m', 'p2p.release_deadline_unset');
  }
  if (!Number.isInteger(seconds) || seconds < 60) {
    throw new P2pError(`P2P_RELEASE_DEADLINE_SECONDS must be an integer ≥ 60, got ${seconds}`, 'p2p.invalid_release_deadline');
  }
  return seconds;
}

/** Published moderator SLA, or refuse. Blank env is not 7d. */
export function publishedDisputeSlaSeconds(seconds: number | null | undefined): number {
  if (seconds == null) {
    throw new P2pError('P2P_DISPUTE_SLA_SECONDS is unset — refusing rather than inventing 7d', 'p2p.dispute_sla_unset');
  }
  if (!Number.isInteger(seconds) || seconds < 3600) {
    throw new P2pError(`P2P_DISPUTE_SLA_SECONDS must be an integer ≥ 3600, got ${seconds}`, 'p2p.invalid_dispute_sla');
  }
  return seconds;
}

/** Published dispute re-raise interval, or refuse. Blank env is not 1h. */
export function publishedDisputeEscalationRecheckSeconds(seconds: number | null | undefined): number {
  if (seconds == null) {
    throw new P2pError(
      'P2P_DISPUTE_ESCALATION_RECHECK_SECONDS is unset — refusing rather than inventing 1h',
      'p2p.dispute_escalation_recheck_unset',
    );
  }
  if (!Number.isInteger(seconds) || seconds < 60) {
    throw new P2pError(
      `P2P_DISPUTE_ESCALATION_RECHECK_SECONDS must be an integer ≥ 60, got ${seconds}`,
      'p2p.invalid_dispute_escalation_recheck',
    );
  }
  return seconds;
}

/** Published sweep tick, or refuse. Blank env is not 30s. */
export function publishedSweepIntervalSeconds(seconds: number | null | undefined): number {
  if (seconds == null) {
    throw new P2pError('P2P_SWEEP_INTERVAL_SECONDS is unset — refusing rather than inventing 30s', 'p2p.sweep_interval_unset');
  }
  if (!Number.isInteger(seconds) || seconds < 5) {
    throw new P2pError(`P2P_SWEEP_INTERVAL_SECONDS must be an integer ≥ 5, got ${seconds}`, 'p2p.invalid_sweep_interval');
  }
  return seconds;
}

/**
 * A release must leave the buyer a positive leg after the house fee.
 *
 * `mulBps` ceils: amount = 1 scaled unit with any fee_bps ≥ 1 yields fee = 1 and
 * buyer = 0. The ledger recipe then throws InvalidEntryError. If we wrote
 * resolution=released first, settle would fail forever and the pot would sit
 * as "late" with no postable terminal. Refuse before the decision (and at take,
 * before any inventory is reserved).
 */
export function assertReleasePostable(amount: Amount, feeBps: number): void {
  const published = publishedFeeBps(feeBps);
  const fee = mulBps(amount, published);
  if (amount - fee <= 0n) {
    throw new P2pError(
      `Trade amount is too small for a ${feeBps} bps fee — after the fee the buyer would receive nothing. Raise the size or set fee to 0.`,
      'p2p.release_unpostable',
    );
  }
}

/**
 * The half of `InstrumentService` this file is allowed to know about.
 *
 * Narrow on purpose. svc-p2p's escrow paths need exactly one thing from payment
 * instruments — "freeze the seller's destination onto this trade, or refuse the
 * take" — and nothing here should be able to reach a disclosure path by
 * accident. The reveal rules live in `instrument-service.ts`, behind an
 * interface this file cannot call.
 */
export interface TradeInstrumentAttacher {
  /**
   * THE FLUSH BOUNDARY, and the only source of a `DenialSink`.
   *
   * `reserveTrade`'s transaction runs inside this. A refusal raised in there
   * cannot write its own access-log row: writing on `tx` loses the row to the
   * abort the refusal itself causes, and writing on the service's pool asks for
   * a second connection while this transaction holds the first — which, ten
   * concurrent refusals deep on a pool of ten, is a permanent deadlock nothing
   * times out of. So a refusal queues its row on the sink, and this wrapper
   * writes it after the transaction has settled and released its connection.
   */
  duringTake<T>(run: (sink: DenialSink) => Promise<T>): Promise<T>;

  attachToTrade(
    tx: Sql,
    input: { tradeId: string; sellerId: string; takerId: string; methodId: string; fiatCurrency: string; sink: DenialSink },
  ): Promise<{ instrumentId: string; fingerprint: string }>;

  /**
   * THE ONE REFUSAL. Queues the attempt against the seller, then throws.
   *
   * On the interface rather than built here because it produces an access-log
   * row, and this file must not own a second way to describe a payment
   * instrument. Both reasons a take can fail on the method — the OFFER not
   * accepting it, and the SELLER not holding a destination for it — go through
   * it, so a caller cannot tell them apart.
   *
   * The `sink` is required by the type system rather than by a comment: a
   * refusal that cannot be raised without one cannot be raised outside the
   * `duringTake` scope that ends by writing it down.
   */
  refuseTake(input: { takerId: string; sellerId: string; tradeId?: string; sink: DenialSink }): Promise<never>;

  /**
   * Method ids the owner can actually be paid on right now, for one fiat.
   *
   * Keys are lowercased (same rule as `methodIdKey` / instrument storage). Used
   * by sell-offer create and the board so a method with no live destination is
   * never advertised — closing the residual named on `TAKE_REFUSED_MESSAGE`.
   * Empty operator registry ⇒ empty set: a leftover destination is not a rail.
   */
  liveMethodKeys(ownerId: string, fiatCurrency: string): Promise<ReadonlySet<string>>;

  /**
   * Method ids an operator has registered and left enabled. Empty = no payable
   * rail exists yet — not "any string the maker types is a method".
   */
  enabledMethodKeys(): Promise<ReadonlySet<string>>;
}

export interface P2pServiceOptions {
  /**
   * Where the buyer will be told to send the fiat.
   *
   * NOT optional, and the compiler enforcing that is the point: a P2pService
   * built without one would take offers, lock escrow, and leave every buyer
   * with nowhere to pay — the exact hole this collaborator exists to close.
   */
  instruments: TradeInstrumentAttacher;
  /** Platform fee taken off the escrowed amount at release. Null/omit = unset refuse. */
  feeBps?: number | null;
  deadlines?: DeadlinePolicy;
  xp?: XpPolicy;
  /** Kill-switch. Blocks new offers and takes; never blocks settlement. */
  tradingEnabled?: boolean;
  /** Floating offers need one. Absent = floating offers cannot be taken. */
  referencePrices?: ReferencePriceSource;
  /**
   * Offer size ceilings by merchant standing (TRK-p2p.merchants Stage 2).
   * Absent = no ceiling, which is the behaviour before Stage 2 existed.
   */
  offerLimits?: OfferLimitPolicy;
  /**
   * This maker's merchant standing, or `null` when they are not in the programme.
   *
   * A PORT, not the service: svc-p2p's escrow paths must not be able to reach
   * the merchant writer by accident, and this file needs exactly one fact from
   * it. `index.ts` supplies it from `MerchantService`; tests supply a stub.
   */
  merchantStatusOf?: (userId: string) => Promise<MerchantStatus | null>;
  /**
   * Identity affiliate accrue after house p2p fees post. Default noop.
   * Failures must not unwind escrowRelease.
   */
  affiliateAccrue?: AffiliateAccruePort;
  /**
   * Identity affiliate payout after accrue. Default noop. Failures must not
   * unwind escrowRelease. Body is `{ feeEventId }` only.
   */
  affiliatePayout?: AffiliatePayoutPort;
}

/**
 * ONE PIECE OF EVIDENCE, AND WHO PUT IT THERE.
 *
 * Stored as an envelope rather than the bare item, for two reasons that are the
 * same reason twice:
 *
 *   · the record of a dispute has to say who said what, or a moderator ruling
 *     on it is ruling on an anonymous pile;
 *   · `disputes.get` shows a party their OWN submissions and nobody else's,
 *     which is not expressible without attribution on each entry.
 *
 * `seq` is assigned under the dispute's row lock and is dense from 1, so a gap
 * is visible. Nothing here is ever rewritten — the database refuses
 * (`p2p_disputes_evidence_append_only_trg`).
 */
export interface EvidenceEntry {
  readonly seq: number;
  /** `null` only for rows written before evidence was attributed. Never guessed. */
  readonly submittedBy: string | null;
  readonly submittedAt: Date | null;
  readonly item: unknown;
}

/** Caps, enforced here AND by the column's CHECK constraints. */
export const MAX_EVIDENCE_ENTRIES = 200;
export const MAX_EVIDENCE_PER_CALL = 10;
export const MAX_EVIDENCE_ITEM_BYTES = 8_192;

export interface OfferRecord {
  id: string;
  makerId: string;
  side: 'buy' | 'sell';
  asset: string;
  fiatCurrency: string;
  priceType: PriceType;
  price: Amount;
  minAmt: Amount;
  maxAmt: Amount;
  totalAmt: Amount;
  remainingAmt: Amount;
  methods: unknown[];
  terms: string;
  status: 'active' | 'paused' | 'closed';
  createdAt: Date;
}

export interface TradeRecord {
  id: string;
  offerId: string;
  takerId: string;
  makerId: string;
  sellerId: string;
  buyerId: string;
  asset: string;
  fiatCurrency: string;
  amount: Amount;
  price: Amount;
  fiatAmount: Amount;
  method: string;
  feeBps: number;
  status: TradeStatus;
  resolution: TradeResolution | null;
  resolutionReason: string | null;
  /** Present once a thread is allocated — at take never, at dispute open always. */
  chatThreadId: string | null;
  deadlines: Deadlines;
  deadlineAt: Date | null;
  createdAt: Date;
  escrowedAt: Date | null;
  fiatSentAt: Date | null;
  resolvedAt: Date | null;
  settledAt: Date | null;
}

export interface DisputeRecord {
  id: string;
  tradeId: string;
  openedBy: string;
  /**
   * `party` — a natural person called `disputes.open`.
   * `timeout` — the fiat_sent clock opened it; `openedBy` is the party of
   * interest (buyer who marked fiat sent), not a filing attribution.
   */
  openedVia: 'party' | 'timeout';
  reason: string;
  /** Null only on rows opened before 0007. New opens always persist one. */
  chatThreadId: string | null;
  evidence: readonly EvidenceEntry[];
  moderatorId: string | null;
  resolution: 'release' | 'refund' | null;
  resolutionNotes: string | null;
  status: 'open' | 'resolved';
  deadlineAt: Date;
  openedAt: Date;
  resolvedAt: Date | null;
  /** Non-null iff this row has actually been served to a moderator. */
  lastSeenByModeratorAt: Date | null;
  moderatorViews: number;
  escalatedAt: Date | null;
  escalations: number;
}

interface TradeRow {
  id: string;
  offer_id: string;
  taker_id: string;
  maker_id: string;
  seller_id: string;
  buyer_id: string;
  asset: string;
  fiat_currency: string;
  amount: string;
  price: string;
  fiat_amount: string;
  method: string;
  fee_bps: string;
  status: TradeStatus;
  resolution: TradeResolution | null;
  resolution_reason: string | null;
  chat_thread_id: string | null;
  deadlines: Deadlines;
  deadline_at: Date | null;
  created_at: Date;
  escrowed_at: Date | null;
  fiat_sent_at: Date | null;
  resolved_at: Date | null;
  settled_at: Date | null;
}

interface OfferRow {
  id: string;
  maker_id: string;
  side: 'buy' | 'sell';
  asset: string;
  fiat_currency: string;
  price_type: PriceType;
  price: string;
  min_amt: string;
  max_amt: string;
  total_amt: string;
  remaining_amt: string;
  methods: unknown[];
  terms: string;
  status: 'active' | 'paused' | 'closed';
  created_at: Date;
}

interface DisputeRow {
  id: string;
  trade_id: string;
  opened_by: string;
  opened_via: 'party' | 'timeout';
  reason: string;
  chat_thread_id: string | null;
  evidence: unknown;
  moderator_id: string | null;
  resolution: 'release' | 'refund' | null;
  resolution_notes: string | null;
  status: 'open' | 'resolved';
  deadline_at: Date;
  opened_at: Date;
  resolved_at: Date | null;
  last_seen_by_moderator_at: Date | null;
  moderator_views: number;
  escalated_at: Date | null;
  escalations: number;
}

/**
 * WHY ONE TRADE THE SWEEP TOUCHED DID NOT MOVE.
 *
 * The sweeps deliberately keep going when one trade fails — one bad trade must
 * not stop the next from settling — and the price of that used to be a bare
 * `catch { failed++ }`: a counter, and the reason discarded. Which is how the
 * escrow guard's refusal ("a disputed escrow terminates only on a human
 * ruling") reached a `catch`, was thrown away, and surfaced as an assertion
 * failure in another branch's test run that named nothing at all.
 *
 * The message is carried, not the Error: the caller logs this, and an Error
 * dragged into a log line brings a stack that says where the sweep is rather
 * than what refused.
 */
export interface SweepFailure {
  readonly tradeId: string;
  readonly status: TradeStatus;
  /** The service's own code where there is one — `p2p.escrow_missing`, etc. */
  readonly code: string | null;
  readonly error: string;
}

export interface SweepResult {
  readonly swept: number;
  readonly failed: number;
  readonly escalated: number;
  readonly failures: SweepFailure[];
}

function describeFailure(tradeId: string, status: TradeStatus, err: unknown): SweepFailure {
  const code =
    err instanceof P2pError || err instanceof TradeStateError || err instanceof PricingError
      ? err.code
      : ((err as { code?: unknown })?.code ?? null);
  return {
    tradeId,
    status,
    code: typeof code === 'string' ? code : null,
    error: err instanceof Error ? err.message : String(err),
  };
}

/** Who authorised a terminal decision. Goes on the event and into the trace. */
type Actor = 'seller' | 'buyer' | 'moderator' | 'timeout';

/**
 * THE CLOCK. Postgres', never this process'.
 *
 * `settled_at` is stamped by the database (`SET settled_at = now()`), and the
 * two properties this service exists to guarantee both compare against it:
 * "decide, then post" means `resolved_at <= settled_at`, and
 * `sweepSettlements()` orders the decisions it has to re-drive by `resolved_at`.
 * Reading `new Date()` for one side of those comparisons and `now()` for the
 * other put an unbounded skew term into an ordering that value depends on — a
 * Node clock a few milliseconds ahead of the server's is enough to record a
 * decision as having happened AFTER the movement it authorised, which is an
 * audit trail that contradicts itself.
 *
 * It also does not survive a second replica. Two svc-p2p processes each stamp
 * `resolved_at` from their own hardware, so the sweeper's FIFO becomes an
 * ordering over two clocks that were never synchronised. Postgres is the one
 * clock every replica already shares, so every instant on the row comes from
 * here — not just the two the test happens to compare.
 *
 * `now()` is the TRANSACTION timestamp, not the statement timestamp, and that
 * is deliberate:
 *
 *   · Within one transaction it is a constant, so `resolveDispute` stamps the
 *     trade's `resolved_at` and the dispute's `resolved_at` with the identical
 *     instant. One ruling happened at one moment; two rows disagreeing about
 *     when a moderator decided would be the audit-trail hole all over again.
 *   · Across transactions it still gives strict ordering where we need it.
 *     `settled_at` is written by a LATER, separate transaction — the decision
 *     has committed before the ledger post is even attempted — so its
 *     transaction timestamp is strictly greater. `clock_timestamp()` would buy
 *     no extra strictness here and would cost the constant above.
 *
 * The truncation is also in the safe direction: the driver parses Postgres'
 * microseconds down to JS millisecond precision, so a value read here and bound
 * back into a column is always <= the true transaction timestamp, never past it.
 */
async function txNow(tx: Sql): Promise<Date> {
  const rows = await tx<Array<{ now: Date }>>`SELECT now() AS now`;
  return rows[0]!.now;
}

export class P2pService {
  private readonly feeBps: number | null;
  private readonly deadlines: DeadlinePolicy;
  private readonly xpPolicy: XpPolicy;
  private readonly referencePrices: ReferencePriceSource | undefined;
  private readonly offerLimits: OfferLimitPolicy;
  private readonly merchantStatusOf: ((userId: string) => Promise<MerchantStatus | null>) | undefined;
  private readonly instruments: TradeInstrumentAttacher;
  private readonly affiliateAccrue: AffiliateAccruePort;
  private readonly affiliatePayout: AffiliatePayoutPort;
  private tradingEnabled: boolean;

  constructor(
    private readonly sql: Sql,
    private readonly ledger: LedgerClient,
    private readonly bus: EventBus,
    options: P2pServiceOptions,
  ) {
    this.instruments = options.instruments;
    if (options.feeBps == null) {
      this.feeBps = null;
    } else {
      this.feeBps = publishedFeeBps(options.feeBps);
    }
    this.deadlines = options.deadlines ?? DEFAULT_DEADLINES;
    this.xpPolicy = options.xp ?? DEFAULT_XP_POLICY;
    this.tradingEnabled = options.tradingEnabled ?? true;
    this.referencePrices = options.referencePrices;
    this.offerLimits = options.offerLimits ?? NO_OFFER_LIMITS;
    this.merchantStatusOf = options.merchantStatusOf;
    this.affiliateAccrue = options.affiliateAccrue ?? new NoopAffiliateAccrue();
    this.affiliatePayout = options.affiliatePayout ?? new NoopAffiliatePayout();
  }

  /**
   * Kill-switch (§14 admin controls).
   *
   * Blocks new offers and new takes only. Settlement, disputes and both sweeps
   * keep running, because a switch that could freeze settlement would be a
   * switch that strands every open escrow — the exact failure this service
   * exists to make impossible.
   */
  setTradingEnabled(enabled: boolean): void {
    this.tradingEnabled = enabled;
  }

  /** Same freeze new block/RFQ quotes and accepts honour. */
  isTradingEnabled(): boolean {
    return this.tradingEnabled;
  }

  // ── Offers (§6.2) ──────────────────────────────────────────────────────────

  async createOffer(input: {
    makerId: string;
    side: 'buy' | 'sell';
    asset: string;
    fiatCurrency: string;
    priceType: PriceType;
    price: Amount;
    minAmt: Amount;
    maxAmt: Amount;
    totalAmt?: Amount;
    methods?: unknown[];
    terms?: string;
    offerId?: string;
  }): Promise<OfferRecord> {
    this.assertTradingEnabled();

    const fiatCurrency = input.fiatCurrency.toUpperCase();
    if (!isSupportedFiat(fiatCurrency)) {
      // §6.2: 100+ fiat currencies are config, not code. The registry in
      // packages/config decides what we serve; this service never has a list.
      throw new PricingError(`Fiat currency "${fiatCurrency}" is not enabled`, 'p2p.unsupported_fiat');
    }

    // AN OFFER MUST DECLARE HOW IT CAN BE PAID.
    //
    // `methodAllowed` treats an offer with no declared methods as accepting
    // ANYTHING, which used to be a reasonable "the terms text is the contract"
    // default. It is not reasonable next to the take refusal: on an offer that
    // declares nothing, the ONLY thing that can refuse a take is the seller's
    // instrument set, so every method id a caller cares to try is answered
    // cleanly. That is the take oracle again, in its sharpest form — an offer
    // whose maker never chose to publish anything becomes a per-method probe of
    // its own seller.
    //
    // Refused at creation, for NEW offers only. Existing ones keep working and
    // refuse at take, honestly — breaking live offers to close a hole would
    // cost makers real liquidity for a fix they did not ask for.
    if (!Array.isArray(input.methods) || input.methods.length === 0) {
      throw new PricingError(resolveP2pCopy(P2P_COPY.offerMethodsRequired), 'p2p.offer_methods_required');
    }

    /**
     * AN EMPTY REGISTRY IS NOT A PAYABLE RAIL.
     *
     * `offer_method_no_destination` says "this method exists; go register a
     * destination." That is the wrong sentence when no operator has registered
     * a schema: it makes an invented string look like a live rail the seller
     * merely forgot to fill in. Buy offers used to skip every method check, so
     * the public board could advertise whatever the maker typed. Both sides
     * now require an enabled operator schema first. Destinations stay the
     * second gate, and only for sell.
     */
    const registered = await this.instruments.enabledMethodKeys();
    if (missingSellDestinations(input.methods, registered).length > 0) {
      throw new InstrumentError(resolveP2pCopy(P2P_COPY.methodUnknown), 'p2p.instrument_method_unknown');
    }

    /**
     * SELL OFFERS ONLY LIST METHODS THE MAKER CAN BE PAID ON.
     *
     * A sell maker is the seller. Advertising a method with no active destination
     * turns every take attempt into a confirm/deny of "do they hold details for
     * this rail" — the residual left after take refusals became uniform. Buy
     * offers skip this: the seller is the taker, unknown at post time.
     */
    if (input.side === 'sell') {
      const live = await this.instruments.liveMethodKeys(input.makerId, fiatCurrency);
      const missing = missingSellDestinations(input.methods, live);
      if (missing.length > 0) {
        throw new PricingError(resolveP2pCopy(P2P_COPY.offerMethodNoDestination), 'p2p.offer_method_no_destination');
      }
    }

    /**
     * OFFER CEILING BY MERCHANT STANDING (TRK-p2p.merchants Stage 2).
     *
     * An offer is a promise to complete a trade of that size, and an account
     * with no record promising a very large one is the shape of most exit
     * scams. The merchant programme is the record that justifies a bigger
     * promise, so the badge and the ceiling are one control seen from two sides.
     *
     * CREATE only. Standing is read on every create (or treated as not-in-
     * programme when no reader is wired) so a non-approved maker never inherits
     * the merchant slot. Missing reader + armed policy still applies the
     * standard band — skipping the check would let every size through.
     * Existing offers are never re-judged: breaking live liquidity to apply a
     * new rule costs makers real money for a change they did not ask for.
     */
    const standing = this.merchantStatusOf ? await this.merchantStatusOf(input.makerId) : null;
    const verdict = checkOfferLimit({ status: standing, maxAmt: input.maxAmt, asset: input.asset, policy: this.offerLimits });
    if (!verdict.withinLimit) throw new P2pError(verdict.reason, 'p2p.offer_limit_exceeded');

    const totalAmt = input.totalAmt ?? input.maxAmt;
    const offerId = input.offerId ?? crypto.randomUUID();

    const rows = await this.sql<OfferRow[]>`
      INSERT INTO p2p.offers (
        id, maker_id, side, asset, fiat_currency, price_type, price,
        min_amt, max_amt, total_amt, remaining_amt, methods, terms, status
      )
      VALUES (
        ${offerId}, ${input.makerId}, ${input.side}, ${input.asset}, ${fiatCurrency},
        ${input.priceType}, ${formatAmount(input.price)}::numeric,
        ${formatAmount(input.minAmt)}::numeric, ${formatAmount(input.maxAmt)}::numeric,
        ${formatAmount(totalAmt)}::numeric, ${formatAmount(totalAmt)}::numeric,
        ${this.sql.json((input.methods ?? []) as never)}, ${input.terms ?? ''}, 'active'
      )
      RETURNING *
    `;

    const offer = toOffer(rows[0]!);

    await this.bus.publish(
      'p2pOfferCreated',
      {
        offerId: offer.id,
        makerId: offer.makerId,
        side: offer.side,
        asset: offer.asset,
        fiatCurrency: offer.fiatCurrency,
        priceType: offer.priceType,
        price: formatAmount(offer.price),
        minAmount: formatAmount(offer.minAmt),
        maxAmount: formatAmount(offer.maxAmt),
      },
      { idempotencyKey: `p2p.offer:${offer.id}` },
    );

    return offer;
  }

  async listOffers(
    filter: {
      asset?: string;
      fiatCurrency?: string;
      side?: 'buy' | 'sell';
      makerId?: string;
      limit?: number;
    } = {},
  ): Promise<OfferRecord[]> {
    const limit = assertOfferListLimit(filter.limit);
    const rows = await this.sql<OfferRow[]>`
      SELECT * FROM p2p.offers
       WHERE status = 'active'
         AND remaining_amt >= min_amt
         AND (${filter.asset ?? null}::text IS NULL OR asset = ${filter.asset ?? null})
         AND (${filter.fiatCurrency ?? null}::text IS NULL OR fiat_currency = ${filter.fiatCurrency?.toUpperCase() ?? null})
         AND (${filter.side ?? null}::text IS NULL OR side::text = ${filter.side ?? null})
         AND (${filter.makerId ?? null}::text IS NULL OR maker_id = ${filter.makerId ?? null})
       ORDER BY price ASC, created_at ASC
       LIMIT ${limit}
    `;
    const offers = rows.map(toOffer);
    return this.projectBoardMethods(offers);
  }

  async getOffer(offerId: string): Promise<OfferRecord> {
    const offer = await this.loadOfferRaw(offerId);
    const [projected] = await this.projectBoardMethods([offer]);
    // Zero payable methods is not on the public board — same answer as missing,
    // so get-by-id cannot confirm "listed rails, no destination / no schema".
    if (!projected) throw new P2pError(`Offer ${offerId} not found`, 'p2p.offer_not_found');
    return projected;
  }

  /** Maker management / take path — unfiltered methods as stored. */
  private async loadOfferRaw(offerId: string): Promise<OfferRecord> {
    const rows = await this.sql<OfferRow[]>`SELECT * FROM p2p.offers WHERE id = ${offerId}`;
    const row = rows[0];
    if (!row) throw new P2pError(`Offer ${offerId} not found`, 'p2p.offer_not_found');
    return toOffer(row);
  }

  /**
   * Board honesty: only methods that are actually payable.
   *
   * Sell offers expose methods with a live destination on an enabled schema.
   * Buy offers cannot advertise a destination (the seller is the taker) but
   * they still must not list a method the operator has never registered —
   * that is how an empty registry looks like a rail. Offers with zero payable
   * methods drop off the board: an empty methods list would re-open the
   * "accept anything" take oracle that create already refuses.
   *
   * Live lookup is cached per (maker, fiat) inside one call so a 50-row board
   * does not issue 50 identical queries for one maker.
   */
  private async projectBoardMethods(offers: OfferRecord[]): Promise<OfferRecord[]> {
    const registered = await this.instruments.enabledMethodKeys();
    const cache = new Map<string, ReadonlySet<string>>();
    const liveFor = async (ownerId: string, fiat: string): Promise<ReadonlySet<string>> => {
      const key = `${ownerId}\0${fiat}`;
      let hit = cache.get(key);
      if (!hit) {
        hit = await this.instruments.liveMethodKeys(ownerId, fiat);
        cache.set(key, hit);
      }
      return hit;
    };

    const out: OfferRecord[] = [];
    for (const offer of offers) {
      if (offer.side !== 'sell') {
        const methods = methodsWithLiveDestination(offer.methods, registered);
        if (methods.length === 0) continue;
        out.push(methods === offer.methods ? offer : { ...offer, methods });
        continue;
      }
      const live = await liveFor(offer.makerId, offer.fiatCurrency);
      if (!sellOfferBoardable(offer.methods, live)) continue;
      const methods = methodsWithLiveDestination(offer.methods, live);
      out.push(methods === offer.methods ? offer : { ...offer, methods });
    }
    return out;
  }

  /**
   * Close an offer. Open trades against it are unaffected — closing withdraws
   * the *remaining* liquidity, it does not cancel commitments already made.
   */
  async closeOffer(offerId: string, makerId: string): Promise<OfferRecord> {
    const rows = await this.sql<OfferRow[]>`
      UPDATE p2p.offers SET status = 'closed', updated_at = now()
       WHERE id = ${offerId} AND maker_id = ${makerId} AND status <> 'closed'
      RETURNING *
    `;
    if (!rows[0]) {
      const existing = await this.loadOfferRaw(offerId);
      if (existing.makerId !== makerId) throw new P2pError('Only the maker can close an offer', 'p2p.not_a_party');
      return existing;
    }
    return toOffer(rows[0]);
  }

  /**
   * Pause an active offer — hide remaining liquidity without closing.
   *
   * The schema has always carried `paused` as a distinct status (not a flag): a
   * paused offer is invisible on the board and cannot be taken, but open trades
   * against it continue and the maker can resume. Closing withdraws inventory
   * permanently; pausing is the reversible cousin the enum promised and the
   * API never exposed.
   */
  async pauseOffer(offerId: string, makerId: string): Promise<OfferRecord> {
    const rows = await this.sql<OfferRow[]>`
      UPDATE p2p.offers SET status = 'paused', updated_at = now()
       WHERE id = ${offerId} AND maker_id = ${makerId} AND status = 'active'
      RETURNING *
    `;
    if (!rows[0]) {
      const existing = await this.loadOfferRaw(offerId);
      if (existing.makerId !== makerId) throw new P2pError('Only the maker can pause an offer', 'p2p.not_a_party');
      if (existing.status === 'paused') return existing;
      if (existing.status === 'closed') {
        throw new P2pError(`Offer ${offerId} is closed and cannot be paused`, 'p2p.offer_not_active');
      }
      throw new P2pError(`Offer ${offerId} is ${existing.status} and cannot be paused`, 'p2p.offer_not_active');
    }
    return toOffer(rows[0]);
  }

  /**
   * Resume a paused offer onto the board. Closed stays closed — re-list is a
   * new offer, not a resume of one the maker already withdrew.
   */
  async resumeOffer(offerId: string, makerId: string): Promise<OfferRecord> {
    this.assertTradingEnabled();
    const rows = await this.sql<OfferRow[]>`
      UPDATE p2p.offers SET status = 'active', updated_at = now()
       WHERE id = ${offerId} AND maker_id = ${makerId} AND status = 'paused'
      RETURNING *
    `;
    if (!rows[0]) {
      const existing = await this.loadOfferRaw(offerId);
      if (existing.makerId !== makerId) throw new P2pError('Only the maker can resume an offer', 'p2p.not_a_party');
      if (existing.status === 'active') return existing;
      if (existing.status === 'closed') {
        throw new P2pError(`Offer ${offerId} is closed and cannot be resumed`, 'p2p.offer_not_active');
      }
      throw new P2pError(`Offer ${offerId} is ${existing.status} and cannot be resumed`, 'p2p.offer_not_active');
    }
    return toOffer(rows[0]);
  }

  // ── Taking an offer → escrowLock (§6.2) ────────────────────────────────────

  /**
   * Take an offer.
   *
   * Three phases, in this order and no other:
   *
   *   A · Reserve (committed).  Bounds, liquidity and pricing are validated and
   *       the inventory is reserved under a row lock. Nothing has moved yet, so
   *       every rejection here happens **before any lock** — an over-max take,
   *       an under-min take, and the losing side of a concurrent race all fail
   *       with the seller's balance untouched.
   *
   *   B · Lock.  `escrowLock`, keyed `p2p.escrow.lock:<tradeId>`.
   *
   *   C · Advance (committed).  The trade becomes `escrowed`.
   *
   * *If this crashes exactly here, whose funds are stranded?*
   *
   *   · After A, before B — nobody's. Nothing is locked. The trade sits in
   *     `created` with a short deadline and the sweep unwinds it.
   *   · After B, before C — nobody's, but the answer is not obvious, which is
   *     why it is written down. The trade says `created` while the seller's
   *     asset is actually in escrow. The sweep re-calls `escrowLock`; it is
   *     idempotent, returns the original transaction, and the trade is then
   *     known to hold escrow and is refunded. The lock is never *guessed* at,
   *     because a wrong guess in the "it locked" direction pays the seller out
   *     of a different trade's escrow.
   */
  async takeOffer(input: {
    offerId: string;
    takerId: string;
    amount: Amount;
    method: string;
    /**
     * No per-take fee override. Fee is the service default only (`P2P_FEE_BPS` /
     * constructor). Rank discounts (§4.1) are product law not yet wired — when
     * they land, they must change the service fee policy, not a caller field
     * that lets a hostile take set fee to zero.
     */
    tradeId: string;
  }): Promise<TradeRecord> {
    this.assertTradingEnabled();

    const tradeId = input.tradeId.trim();
    if (!tradeId) {
      throw new P2pError('tradeId is required; a take does not mint one', 'p2p.trade_id_required');
    }

    return withMoneySpan(
      'p2p.takeOffer',
      { operation: 'escrow.lock', tradeId, offerId: input.offerId, amount: formatAmount(input.amount) },
      async (span) => {
        const reserved = await this.reserveTrade({ ...input, tradeId });
        span.setAttribute('intafaced.sellerId', reserved.sellerId);
        span.setAttribute('intafaced.buyerId', reserved.buyerId);
        span.setAttribute('intafaced.fiatAmount', formatAmount(reserved.fiatAmount));

        return this.ensureEscrowed(reserved.id);
      },
    );
  }

  /** Phase A — validate, price, reserve inventory, write the `created` row. */
  private async reserveTrade(input: {
    tradeId: string;
    offerId: string;
    takerId: string;
    amount: Amount;
    method: string;
  }): Promise<TradeRecord> {
    // Read the offer once, unlocked, purely to decide whether a reference price
    // is needed. Fetching a mark price is a network call; holding the offer's
    // row lock across it would serialise every taker behind the slowest feed.
    // Raw load: board projection must not make an unboardable sell look like a
    // missing offer mid-take. Take still refuses with the uniform message when
    // the destination is gone; get/list stay honest for strangers.
    const preview = await this.loadOfferRaw(input.offerId);
    const referencePrice =
      preview.priceType === 'float' ? ((await this.referencePrices?.price(preview.asset, preview.fiatCurrency)) ?? null) : null;

    /**
     * `duringTake` wraps the transaction, not the other way round.
     *
     * A refused take has to be written to the access log and the row has to
     * survive the abort the refusal causes, so it cannot go on `tx`. It also
     * cannot go on the service's own pool from in here: this transaction is
     * holding a connection, and a second request against the same pool is a
     * queue entry that only clears when this transaction ends — which it cannot
     * do, because it is waiting on that request. Ten of those, on the default
     * pool of ten, and svc-p2p never serves another request; the ten offers
     * stay row-locked too. Neither `statement_timeout` nor the transaction
     * retry can reach it, because no statement is running.
     *
     * So the refusal is queued in memory and written by `duringTake`'s
     * `finally`, once `transaction` has rolled back and given the connection
     * back. Same row, same reason, one connection at a time.
     */
    return this.instruments.duringTake((sink) =>
      transaction(
        this.sql,
        async (tx) => {
          // BEFORE ANY ROW LOCK, and before the offer is even read: this take
          // will copy one of these two people's bank details onto the trade,
          // and `eraseFor` is the other writer of that data. Whichever of them
          // arrives second must SEE the first rather than read around it —
          // without this, an erase committing between this transaction's
          // instrument read and its snapshot INSERT left cleartext account
          // details on a trade the person had just been told was clear.
          //
          // Both parties, because either can be the seller depending on the
          // offer's side; sorted inside the helper, so two takes cannot
          // deadlock on each other. `preview.makerId` rather than the locked
          // row's: locks must come before row locks, and `maker_id` is written
          // once and never updated. See `instrument-lock.ts`.
          await lockInstrumentOwners(tx, preview.makerId, input.takerId);

          const rows = await tx<OfferRow[]>`SELECT * FROM p2p.offers WHERE id = ${input.offerId} FOR UPDATE`;
          const row = rows[0];
          if (!row) throw new P2pError(`Offer ${input.offerId} not found`, 'p2p.offer_not_found');

          const offer = toOffer(row);
          if (offer.status !== 'active') {
            throw new P2pError(`Offer ${offer.id} is ${offer.status} and cannot be taken`, 'p2p.offer_not_active');
          }
          if (offer.makerId === input.takerId) {
            // Self-trading manufactures a completion record, and a flawless P2P
            // record raises limits platform-wide (§6.2 → §4.1).
            throw new P2pError('A maker cannot take their own offer', 'p2p.self_trade');
          }
          // Computed here rather than after pricing, because the refusal below
          // has to name the seller in the access log.
          const { sellerId, buyerId } = partiesFor(offer.side, offer.makerId, input.takerId);

          if (!methodAllowed(offer.methods, input.method)) {
            // NOT a distinct error any more. "The offer does not accept that
            // method" and "the seller holds no destination for that method" are
            // the same sentence to the caller, deliberately: any difference
            // between them is a bit of information about someone else's bank
            // accounts, handed out for free. See `TAKE_REFUSED_MESSAGE`.
            await this.instruments.refuseTake({ takerId: input.takerId, sellerId, tradeId: input.tradeId, sink });
          }

          // BEFORE ANY LOCK. Both bounds and the remaining liquidity, under the
          // row lock, so two concurrent takers cannot both pass the same check.
          assertWithinBounds(input.amount, { minAmt: offer.minAmt, maxAmt: offer.maxAmt, remainingAmt: offer.remainingAmt });

          const priced = quote({
            amount: input.amount,
            priceType: offer.priceType,
            price: offer.price,
            referencePrice,
            fiatCurrency: offer.fiatCurrency,
          });

          const now = await txNow(tx);
          const deadlineAt = deadlineFor('created', now, this.deadlines);
          const deadlines = withDeadline({}, 'created', deadlineAt);
          // Fee is constructor/`P2P_FEE_BPS` only — never a take-time argument.
          // Unset refuses rather than inventing 30 (or 0).
          const feeBps = publishedFeeBps(this.feeBps);
          // Before inventory moves: a dust take that cannot post a release would
          // lock value into a trade that can never settle.
          assertReleasePostable(input.amount, feeBps);

          await tx`
            UPDATE p2p.offers
               SET remaining_amt = remaining_amt - ${formatAmount(input.amount)}::numeric,
                   updated_at = now()
             WHERE id = ${offer.id}
          `;

          const inserted = await tx<TradeRow[]>`
            INSERT INTO p2p.p2p_trades (
              id, offer_id, taker_id, maker_id, seller_id, buyer_id, asset, fiat_currency,
              amount, price, fiat_amount, method, fee_bps, status, deadlines, deadline_at, created_at
            )
            VALUES (
              ${input.tradeId}, ${offer.id}, ${input.takerId}, ${offer.makerId}, ${sellerId}, ${buyerId},
              ${offer.asset}, ${offer.fiatCurrency},
              ${formatAmount(priced.amount)}::numeric, ${formatAmount(priced.price)}::numeric,
              ${formatAmount(priced.fiatAmount)}::numeric, ${input.method}, ${feeBps},
              'created', ${tx.json(deadlines as never)}, ${deadlineAt}, ${now}
            )
            ON CONFLICT (id) DO NOTHING
            RETURNING *
          `;

          if (!inserted[0]) {
            // A retry of the same take. The inventory was already reserved by the
            // original, so it must not be reserved again — abort the transaction
            // rather than let the decrement above stand.
            throw new P2pError(`Trade ${input.tradeId} already exists`, 'p2p.trade_exists');
          }

          // WHERE THE BUYER WILL SEND THE MONEY, frozen onto the trade in the same
          // transaction that created it. Two things follow from it being here:
          //
          //   · a trade with no destination is not a state that can be committed,
          //     so the buyer is never shown a payment step with nothing in it;
          //   · a seller with no destination is refused BEFORE any lock, with the
          //     rest of phase A. The alternative is escrowing their asset against
          //     a payment nobody can make and letting them find out fifteen
          //     minutes later, via a timeout, that it was knowable up front.
          //
          // The snapshot is taken now and never re-read, which is also what stops
          // a seller swapping the destination once the buyer has started paying.
          await this.instruments.attachToTrade(tx, {
            tradeId: input.tradeId,
            sellerId,
            takerId: input.takerId,
            methodId: input.method,
            fiatCurrency: offer.fiatCurrency,
            sink,
          });

          return toTrade(inserted[0]);
        },
        { isolation: 'read committed', maxAttempts: 5 },
      ),
    );
  }

  /**
   * Phase B + C — post `escrowLock` and advance the trade to `escrowed`.
   *
   * Idempotent and re-drivable from anywhere: the sweep calls it, a retry calls
   * it, and calling it on an already-escrowed trade is a no-op read.
   */
  private async ensureEscrowed(tradeId: string): Promise<TradeRecord> {
    const trade = await this.getTrade(tradeId);
    if (trade.status !== 'created') return trade;

    try {
      await this.ledger.post(
        recipes.escrowLock({
          tradeId: trade.id,
          sellerId: trade.sellerId,
          buyerId: trade.buyerId,
          assetId: trade.asset,
          amount: trade.amount,
        }),
      );
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        // DEFINITIVE. The ledger checks idempotency before it checks funds, so
        // an insufficient-funds error proves the lock has never posted — there
        // is nothing in escrow and nothing to refund. Void the trade, hand the
        // liquidity back to the offer, and let the caller see the real error.
        await this.recordDecision({
          tradeId: trade.id,
          to: 'cancelled',
          resolution: 'voided',
          reason: 'seller.escrow_lock_failed_insufficient_funds',
        });
        await this.settle(trade.id);
      }
      throw err;
    }

    // The lock is on the book. From here the trade provably holds escrow, which
    // is what makes the release and refund paths safe to reach.
    return this.advanceToEscrowed(trade.id);
  }

  private async advanceToEscrowed(tradeId: string): Promise<TradeRecord> {
    const updated = await transaction(
      this.sql,
      async (tx) => {
        const rows = await tx<TradeRow[]>`SELECT * FROM p2p.p2p_trades WHERE id = ${tradeId} FOR UPDATE`;
        const row = rows[0];
        if (!row) throw unknownTrade(tradeId);
        if (row.status !== 'created') return toTrade(row);

        const now = await txNow(tx);
        const deadlineAt = deadlineFor('escrowed', now, this.deadlines);
        const deadlines = withDeadline(row.deadlines ?? {}, 'escrowed', deadlineAt);

        const next = await tx<TradeRow[]>`
          UPDATE p2p.p2p_trades
             SET status = 'escrowed', escrowed_at = ${now}, deadline_at = ${deadlineAt},
                 deadlines = ${tx.json(deadlines as never)}
           WHERE id = ${tradeId} AND status = 'created'
          RETURNING *
        `;

        // Reputation counts a trade from the moment it reaches escrow. A take
        // that never locked cost the counterparty nothing and must not dilute
        // anyone's completion rate.
        await this.bumpReputation(tx, row.seller_id, 'escrowed');
        await this.bumpReputation(tx, row.buyer_id, 'escrowed');

        return toTrade(next[0] ?? row);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );

    if (updated.status === 'escrowed' && updated.escrowedAt) {
      await this.bus.publish(
        'p2pEscrowLocked',
        {
          tradeId: updated.id,
          offerId: updated.offerId,
          sellerId: updated.sellerId,
          buyerId: updated.buyerId,
          asset: updated.asset,
          amount: formatAmount(updated.amount),
          fiatCurrency: updated.fiatCurrency,
          fiatAmount: formatAmount(updated.fiatAmount),
          paymentDeadline: (updated.deadlineAt ?? updated.escrowedAt).toISOString(),
        },
        { idempotencyKey: `p2p.escrow.lock:${updated.id}` },
      );
    }

    return updated;
  }

  // ── Buyer marks the fiat sent ──────────────────────────────────────────────

  async markFiatSent(tradeId: string, actorId: string): Promise<TradeRecord> {
    return withSpan('p2p.markFiatSent', async () =>
      transaction(
        this.sql,
        async (tx) => {
          const trade = await this.lockTrade(tx, tradeId);
          if (trade.buyerId !== actorId && trade.sellerId !== actorId) throw unknownTrade(trade.id);
          if (trade.buyerId !== actorId) {
            throw new P2pError('Only the buyer can mark the fiat as sent', 'p2p.not_the_buyer');
          }
          assertTransition(trade.status, 'fiat_sent');

          const now = await txNow(tx);
          const deadlineAt = deadlineFor('fiat_sent', now, this.deadlines);
          const deadlines = withDeadline(trade.deadlines, 'fiat_sent', deadlineAt);

          const rows = await tx<TradeRow[]>`
            UPDATE p2p.p2p_trades
               SET status = 'fiat_sent', fiat_sent_at = ${now}, deadline_at = ${deadlineAt},
                   deadlines = ${tx.json(deadlines as never)}
             WHERE id = ${tradeId} AND status = ${trade.status}
            RETURNING *
          `;
          return toTrade(rows[0]!);
        },
        { isolation: 'read committed', maxAttempts: 5 },
      ),
    );
  }

  // ── Release · refund · dispute ─────────────────────────────────────────────

  /** Seller confirms the fiat landed → `escrowRelease`. The happy path. */
  async confirmFiatReceived(tradeId: string, actorId: string): Promise<TradeRecord> {
    return withMoneySpan('p2p.release', { operation: 'escrow.release', tradeId }, async () => {
      const trade = await this.getTrade(tradeId);
      if (trade.buyerId !== actorId && trade.sellerId !== actorId) throw unknownTrade(trade.id);
      if (trade.sellerId !== actorId) {
        throw new P2pError('Only the seller can confirm the fiat was received', 'p2p.not_the_seller');
      }
      // Same legible refuse as cancel: a disputed escrow terminates only on a
      // human ruling. Without this, the seller hits the DB trigger as a raw
      // check_violation instead of `p2p.dispute_already_open` — money still
      // safe, but the API lied about which path failed.
      if (trade.status === 'disputed') {
        throw new P2pError('A disputed trade is resolved by a moderator, not by the seller confirming receipt', 'p2p.dispute_already_open');
      }
      // Defense in depth: take already refuses unpostable dust, but a trade row
      // could predate the gate or arrive via a future writer.
      assertReleasePostable(trade.amount, trade.feeBps);
      await this.recordDecision({ tradeId, to: 'released', resolution: 'released', reason: 'seller.confirmed' });
      return this.settle(tradeId);
    });
  }

  /**
   * Cancel → `escrowRefund`, in full, to the seller.
   *
   * Who may cancel, and why the rule is asymmetric:
   *   · from `escrowed`  — either party. The buyer has not claimed to have paid,
   *     so nobody is out of pocket off-platform.
   *   · from `fiat_sent` — the SELLER only. A buyer who says they have paid and
   *     can then cancel would be able to take back their claim after the seller
   *     acted on it; their route is `openDispute`. The seller cancelling here is
   *     just the seller giving the asset back, which needs no protection.
   */
  async cancelTrade(tradeId: string, actorId: string, reason = 'cancelled'): Promise<TradeRecord> {
    return withMoneySpan('p2p.cancel', { operation: 'escrow.refund', tradeId }, async () => {
      const current = await this.getTrade(tradeId);
      if (current.sellerId !== actorId && current.buyerId !== actorId) throw unknownTrade(current.id);
      if (current.status === 'fiat_sent' && current.sellerId !== actorId) {
        throw new P2pError('The buyer has declared the fiat sent — open a dispute rather than cancelling', 'p2p.not_the_seller');
      }
      if (current.status === 'disputed') {
        throw new P2pError('A disputed trade is resolved by a moderator, not cancelled', 'p2p.dispute_already_open');
      }

      const actor: Actor = current.sellerId === actorId ? 'seller' : 'buyer';
      // The reason string carries the actor, so the refund event and the audit
      // trail both say who unwound the trade without a second column.
      return this.unwind(tradeId, `${actor}.${reason}`);
    });
  }

  /**
   * Refund path shared by cancel and the timeout sweep.
   *
   * Always re-drives the lock first. From `created` that is what turns "did it
   * lock?" from a guess into a fact; from `escrowed`/`fiat_sent` it is a no-op.
   */
  private async unwind(tradeId: string, reason: string, expectStatus?: TradeStatus): Promise<TradeRecord> {
    let trade = await this.getTrade(tradeId);

    // The timeout sweep chose this action from a status it read outside the row
    // lock, several round trips ago. If the trade has moved since, its new state
    // carries its own deadline and its own action, and the next sweep will take
    // that one — so this pass refuses rather than applying a decision made about
    // a trade that no longer exists in that form.
    //
    // `escalateDispute` already re-checks this way under its lock. This is the
    // same check on the two sweep paths that actually move value, which did not
    // have it.
    if (expectStatus && trade.status !== expectStatus) {
      throw new P2pError(`Trade ${tradeId} was ${expectStatus} when the sweep read it and is now ${trade.status}`, 'p2p.trade_moved');
    }

    if (trade.status === 'created') {
      try {
        trade = await this.ensureEscrowed(tradeId);
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          // ensureEscrowed already voided it — nothing was ever locked.
          return this.getTrade(tradeId);
        }
        throw err;
      }
    }

    if (!holdsEscrow(trade.status) && !isTerminal(trade.status)) {
      throw new P2pError(`Trade ${tradeId} is ${trade.status} and holds no escrow`, 'p2p.escrow_missing');
    }

    // The status observed just above, re-checked under the row lock. Closes the
    // window between that read and the decision write — the one a concurrent
    // `markFiatSent` fits into, on the cancel path as much as the sweep's.
    await this.recordDecision({ tradeId, to: 'cancelled', resolution: 'refunded', reason, expectStatus: trade.status });
    return this.settle(tradeId);
  }

  async openDispute(input: {
    tradeId: string;
    openedBy: string;
    reason?: string;
    evidence?: readonly unknown[];
    disputeId?: string;
  }): Promise<DisputeRecord> {
    return withSpan('p2p.openDispute', async () => this.openDisputeInner(input, 'party'));
  }

  private async openDisputeInner(
    input: { tradeId: string; openedBy: string; reason?: string; evidence?: readonly unknown[]; disputeId?: string },
    origin: 'party' | 'timeout',
  ): Promise<DisputeRecord> {
    const disputeId = input.disputeId ?? crypto.randomUUID();
    const supplied = assertEvidenceAcceptable(input.evidence ?? [], 0);

    const dispute = await transaction(
      this.sql,
      async (tx) => {
        const trade = await this.lockTrade(tx, input.tradeId);

        if (origin === 'party' && trade.sellerId !== input.openedBy && trade.buyerId !== input.openedBy) {
          throw unknownTrade(trade.id);
        }
        assertTransition(trade.status, 'disputed');

        const now = await txNow(tx);
        const deadlineAt = deadlineFor('disputed', now, this.deadlines);
        const deadlines = withDeadline(trade.deadlines, 'disputed', deadlineAt);
        // Copy the trade's thread when it already has one; otherwise allocate
        // and persist on BOTH rows. A uuid is an identifier, not a transcript.
        const chatThreadId = trade.chatThreadId ?? crypto.randomUUID();

        // Attributed from the first entry, not from the first APPEND. Evidence
        // filed at open and evidence filed on Tuesday are the same kind of
        // record and a moderator should not have to tell them apart by which
        // API call happened to carry them.
        const opening = envelopesFor(supplied, input.openedBy, now, 0);

        const rows = await tx<DisputeRow[]>`
          INSERT INTO p2p.p2p_disputes (id, trade_id, opened_by, opened_via, reason, evidence, status, deadline_at, opened_at, chat_thread_id)
          VALUES (
            ${disputeId}, ${input.tradeId}, ${input.openedBy}, ${origin}, ${input.reason ?? ''},
            ${tx.json(opening as never)}, 'open', ${deadlineAt}, ${now}, ${chatThreadId}
          )
          ON CONFLICT (trade_id) DO NOTHING
          RETURNING *
        `;

        if (!rows[0]) throw new P2pError(`Trade ${input.tradeId} already has a dispute`, 'p2p.dispute_already_open');
        if (!rows[0].chat_thread_id) {
          throw new P2pError('This trade has no chat thread to attach the dispute to', 'p2p.chat_thread_unset');
        }

        await tx`
          UPDATE p2p.p2p_trades
             SET status = 'disputed',
                 deadline_at = ${deadlineAt},
                 deadlines = ${tx.json(deadlines as never)},
                 chat_thread_id = COALESCE(chat_thread_id, ${chatThreadId}::uuid)
           WHERE id = ${input.tradeId}
        `;

        await this.bumpReputation(tx, trade.sellerId, 'disputed');
        await this.bumpReputation(tx, trade.buyerId, 'disputed');

        return toDispute(rows[0]);
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );

    await this.bus.publish(
      'p2pTradeDisputed',
      {
        tradeId: dispute.tradeId,
        disputeId: dispute.id,
        openedBy: dispute.openedBy,
        reason: dispute.reason,
        moderatorDeadline: dispute.deadlineAt.toISOString(),
      },
      { idempotencyKey: `p2p.dispute:${dispute.id}` },
    );

    return dispute;
  }

  /**
   * A PARTY ADDS EVIDENCE AFTER THE FACT.
   *
   * Before this, evidence could only be supplied in the single `disputes.open`
   * call — and a dispute opened by the release timeout carries a reason and
   * nothing else, so the party who was handed a dispute they did not ask for
   * had no way to put anything into it at all. A buyer who gets their bank
   * receipt an hour later had nowhere to put it.
   *
   * APPEND-ONLY, three times over, because the three are not the same promise:
   *
   *   · there is no update or delete procedure — the API has no verb for it;
   *   · the write is `evidence = evidence || …`, so this code cannot rewrite
   *     history even by mistake;
   *   · the database refuses any update whose evidence is not the old evidence
   *     with entries added on the end, from any client at all.
   *
   * Only while the dispute is OPEN. Once a moderator has ruled, the record the
   * ruling was made against must stay the record the ruling was made against.
   */
  async appendDisputeEvidence(input: { tradeId: string; actorId: string; evidence: readonly unknown[] }): Promise<DisputeRecord> {
    return withSpan('p2p.appendDisputeEvidence', async () =>
      transaction(
        this.sql,
        async (tx) => {
          const trade = await this.lockTrade(tx, input.tradeId);
          if (trade.sellerId !== input.actorId && trade.buyerId !== input.actorId) throw unknownTrade(trade.id);

          const rows = await tx<DisputeRow[]>`
            SELECT * FROM p2p.p2p_disputes WHERE trade_id = ${input.tradeId} FOR UPDATE
          `;
          const row = rows[0];
          if (!row) throw new P2pError(`Trade ${input.tradeId} has no dispute`, 'p2p.dispute_not_found');
          if (row.status === 'resolved') {
            throw new P2pError(
              `Dispute ${row.id} has been ruled on — the evidence a ruling was made against cannot change afterwards`,
              'p2p.dispute_already_resolved',
            );
          }

          const existing = normaliseEvidence(row.evidence);
          const supplied = assertEvidenceAcceptable(input.evidence, existing.length);
          const now = await txNow(tx);
          const added = envelopesFor(supplied, input.actorId, now, existing.length);

          const updated = await tx<DisputeRow[]>`
            UPDATE p2p.p2p_disputes
               SET evidence = evidence || ${tx.json(added as never)}::jsonb
             WHERE id = ${row.id} AND status = 'open'
            RETURNING *
          `;
          return toDispute(updated[0] ?? row);
        },
        { isolation: 'read committed', maxAttempts: 5 },
      ),
    );
  }

  // ── The moderator queue ────────────────────────────────────────────────────

  /**
   * THE QUEUE. Open disputes, most overdue first.
   *
   * Two things about this method are load-bearing and neither is the SELECT:
   *
   *   1 · **It stamps what it serves, in the same statement.** A row can only
   *       leave here if `last_seen_by_moderator_at` was written for it — the
   *       final SELECT reads out of the UPDATE's RETURNING, not out of the
   *       page CTE, so "served but unrecorded" is not a state this code can
   *       produce. That stamp is the only fact in the schema that distinguishes
   *       "we shipped a queue endpoint" from "a human reached this dispute",
   *       and the first one is a claim about our repo rather than about the
   *       world.
   *
   *   2 · **The order is the SLA.** `deadline_at ASC` over `status = 'open'` is
   *       exactly `p2p_disputes_open_idx`, which existed from the first
   *       migration and which, until this method, nothing queried. An escalated
   *       dispute keeps its original (now past) deadline precisely so it stays
   *       at the top of this list instead of being pushed down by the re-arm.
   *
   * Keyset pagination on `(deadline_at, id)`: an offset would let a dispute
   * resolved mid-page shift a later one out of view, and "the queue silently
   * skipped one" is the failure this whole exercise exists to end.
   */
  async listDisputes(input: {
    /** Who is reading. Recorded, because an unattributed queue read proves nothing. */
    moderatorId: string;
    status?: 'open' | 'resolved';
    limit?: number;
    cursor?: string | null;
  }): Promise<{ disputes: DisputeRecord[]; nextCursor: string | null }> {
    const status = input.status ?? 'open';
    const limit = assertDisputeListLimit(input.limit);
    const after = assertDisputeCursor(input.cursor ?? null);

    const rows = await this.sql<DisputeRow[]>`
      WITH page AS (
        SELECT id FROM p2p.p2p_disputes
         WHERE status = ${status}
           AND (
             ${after}::uuid IS NULL
             OR (deadline_at, id) > (
                  (SELECT c.deadline_at FROM p2p.p2p_disputes c WHERE c.id = ${after}::uuid),
                  ${after}::uuid
                )
           )
         ORDER BY deadline_at ASC, id ASC
         LIMIT ${limit}
      ),
      seen AS (
        UPDATE p2p.p2p_disputes d
           SET last_seen_by_moderator_at = now(), moderator_views = d.moderator_views + 1
          FROM page
         WHERE d.id = page.id
        RETURNING d.*
      )
      SELECT * FROM seen ORDER BY deadline_at ASC, id ASC
    `;

    const disputes = rows.map(toDispute);
    const last = disputes[disputes.length - 1];
    // A short page is the end of the queue. A full one may not be, so it hands
    // back a cursor rather than guessing.
    const nextCursor = disputes.length === limit && last ? last.id : null;
    return { disputes, nextCursor };
  }

  /**
   * One dispute, served to a moderator and stamped like the queue is.
   *
   * Separate from `getDispute` on purpose: a party reading their own dispute is
   * not evidence that moderation is reachable, and counting it as such would
   * make the one honest signal in this file dishonest.
   */
  async getDisputeAsModerator(tradeId: string, moderatorId: string): Promise<DisputeRecord> {
    void moderatorId;
    const rows = await this.sql<DisputeRow[]>`
      UPDATE p2p.p2p_disputes
         SET last_seen_by_moderator_at = now(), moderator_views = moderator_views + 1
       WHERE trade_id = ${tradeId}
      RETURNING *
    `;
    const row = rows[0];
    if (!row) throw new P2pError(`Trade ${tradeId} has no dispute`, 'p2p.dispute_not_found');
    return toDispute(row);
  }

  /**
   * What an operator alarm reads.
   *
   * The old backstop made this number invisible: a dispute nobody could reach
   * disappeared into a refund seven days later and the queue looked empty
   * because it was. Nothing disposes of these now, so the backlog is a real
   * number that grows if nobody is on shift — which is the point of measuring
   * it.
   */
  async moderationBacklog(): Promise<{ open: number; overdue: number; escalated: number; neverSeen: number }> {
    const rows = await this.sql<Array<{ open: string; overdue: string; escalated: string; never_seen: string }>>`
      SELECT
        count(*) AS open,
        count(*) FILTER (WHERE deadline_at <= now()) AS overdue,
        count(*) FILTER (WHERE escalated_at IS NOT NULL) AS escalated,
        count(*) FILTER (WHERE last_seen_by_moderator_at IS NULL) AS never_seen
      FROM p2p.p2p_disputes WHERE status = 'open'
    `;
    const row = rows[0]!;
    return {
      open: Number(row.open),
      overdue: Number(row.overdue),
      escalated: Number(row.escalated),
      neverSeen: Number(row.never_seen),
    };
  }

  /**
   * A moderator rules. Release to the buyer, or refund the seller. There is no
   * third option and no "leave it open" — §6.2's escrow promise is that every
   * dispute terminates.
   *
   * The decision is written to `p2p_disputes` AND `p2p_trades.resolution` in one
   * committed transaction, before any ledger post. §5: the audit trail explains
   * every movement, which means the explanation must exist first.
   */
  async resolveDispute(input: {
    tradeId: string;
    /**
     * A PERSON. The database refuses a `system:` principal here on the trade's
     * terminal write (`p2p_trades_disputed_needs_ruling_trg`), so a future
     * timer cannot quietly become a moderator again.
     */
    moderatorId: string;
    resolution: 'release' | 'refund';
    notes?: string;
  }): Promise<TradeRecord> {
    // Asked here first for a legible error, and asked again by the database —
    // `p2p.is_natural_person_id`, drizzle/0003. Same rule, two places, the same
    // arrangement `assertOwnerIdentifierSpace` and svc-ledger's §4.2 CHECK use:
    // this one produces a sentence a caller can act on, and the one down there
    // is what makes it TRUE against a psql session, a migration, or a future
    // writer that never came through this method.
    if (!isNaturalPersonId(input.moderatorId)) {
      throw new P2pError(
        `A dispute is ruled on by a person. "${input.moderatorId}" is not a natural-person id — that is a lowercase ` +
          `canonical UUID, the same identifier space the two parties are named in. The backstop timer that used to ` +
          `resolve disputes named itself "system:p2p-backstop"; nothing that is not a person may take its place ` +
          `under a different spelling.`,
        'p2p.ruling_not_attributed',
      );
    }

    // Release path must post; refuse before the ruling transaction if the fee
    // would zero the buyer leg (same dust trap as confirmFiatReceived).
    if (input.resolution === 'release') {
      const trade = await this.getTrade(input.tradeId);
      assertReleasePostable(trade.amount, trade.feeBps);
    }

    return withMoneySpan(
      'p2p.resolveDispute',
      {
        operation: input.resolution === 'release' ? 'escrow.release' : 'escrow.refund',
        tradeId: input.tradeId,
        moderatorId: input.moderatorId,
        resolution: input.resolution,
      },
      async () => {
        // ONE transaction: the moderator's ruling, the loser's record, and the
        // trade's resolution all commit together or not at all. A ruling that
        // survived without its resolution would be a decision the settlement
        // sweep could never act on.
        const disputeId = await transaction(
          this.sql,
          async (tx) => {
            const trade = await this.lockTrade(tx, input.tradeId);
            const disputes = await tx<DisputeRow[]>`
              SELECT * FROM p2p.p2p_disputes WHERE trade_id = ${input.tradeId} FOR UPDATE
            `;
            const dispute = disputes[0];
            if (!dispute) throw new P2pError(`Trade ${input.tradeId} has no dispute`, 'p2p.dispute_not_found');
            if (dispute.status === 'resolved') {
              throw new P2pError(`Dispute ${dispute.id} is already resolved`, 'p2p.dispute_already_resolved');
            }

            const to: TradeStatus = input.resolution === 'release' ? 'released' : 'cancelled';
            assertTransition(trade.status, to);

            // One reading, used for the dispute row and the trade row below, so
            // the ruling carries a single instant across both.
            const now = await txNow(tx);

            await tx`
              UPDATE p2p.p2p_disputes
                 SET status = 'resolved', moderator_id = ${input.moderatorId}, resolution = ${input.resolution},
                     resolution_notes = ${input.notes ?? null}, resolved_at = ${now}
               WHERE id = ${dispute.id}
            `;

            // The party who lost carries it on their record — the signal §6.2
            // sends into the XP graph as a negative.
            const loser = input.resolution === 'release' ? trade.sellerId : trade.buyerId;
            await this.bumpReputation(tx, loser, 'dispute_lost');

            await this.writeDecision(tx, {
              trade,
              to,
              resolution: input.resolution === 'release' ? 'released' : 'refunded',
              reason: `moderator:${input.resolution}`,
              now,
            });

            return dispute.id;
          },
          { isolation: 'read committed', maxAttempts: 5 },
        );

        // Published after the commit, never inside it: an event for a decision
        // that then rolled back is a consumer acting on something that did not
        // happen.
        await this.bus.publish(
          'p2pDisputeResolved',
          {
            disputeId,
            tradeId: input.tradeId,
            moderatorId: input.moderatorId,
            resolution: input.resolution,
            // Always false, and now provably so: nothing in this service can
            // reach `resolveDispute` without a human moderator id, and the
            // database refuses the terminal write if one is missing. The field
            // stays because the event contract declares it and a contract is
            // not this service's to change unilaterally (§15.1).
            automatic: false,
            ...(input.notes ? { notes: input.notes } : {}),
          },
          { idempotencyKey: `p2p.dispute.resolved:${disputeId}` },
        );

        return this.settle(input.tradeId);
      },
    );
  }

  // ── The two phases, in detail ──────────────────────────────────────────────

  /**
   * PHASE 1 — record the decision. Committed before anything moves.
   *
   * Under the trade's row lock, so two concurrent resolutions cannot both pass
   * the transition check. The loser of that race gets `p2p.trade_terminal` and
   * posts nothing at all.
   */
  private async recordDecision(input: {
    tradeId: string;
    to: TradeStatus;
    resolution: TradeResolution;
    /** `<actor>.<what happened>` — carried onto the event and the audit trail. */
    reason: string;
    /**
     * The status the caller decided on, re-checked here under the row lock.
     *
     * Checked AFTER `assertTransition` so a trade that reached a terminal state
     * still reports `p2p.trade_terminal` — "already released" and "moved while
     * you were deciding" are different incidents and a retrying caller needs to
     * tell them apart.
     */
    expectStatus?: TradeStatus;
  }): Promise<void> {
    await transaction(
      this.sql,
      async (tx) => {
        const trade = await this.lockTrade(tx, input.tradeId);
        assertTransition(trade.status, input.to);

        if (input.expectStatus && trade.status !== input.expectStatus) {
          // `escrowed → cancelled` and `fiat_sent → cancelled` are both legal
          // edges, so `assertTransition` cannot tell these apart — which is
          // exactly why the check has to be here. Refunding a trade that has
          // become `fiat_sent` hands the seller their asset back after the buyer
          // has already sent the fiat off-platform, and opens no dispute.
          throw new P2pError(
            `Trade ${input.tradeId} was ${input.expectStatus} when this was decided and is now ${trade.status}`,
            'p2p.trade_moved',
          );
        }

        if (input.resolution !== 'voided' && !holdsEscrow(trade.status)) {
          // Releasing or refunding requires the escrow to provably exist. From
          // `created` it does not, and posting anyway would move value out of
          // the seller's pooled escrow account — value belonging to a different
          // trade.
          throw new P2pError(
            `Trade ${input.tradeId} is ${trade.status}; there is no escrow to ${input.resolution === 'released' ? 'release' : 'refund'}`,
            'p2p.escrow_missing',
          );
        }

        await this.writeDecision(tx, {
          trade,
          to: input.to,
          resolution: input.resolution,
          reason: input.reason,
          now: await txNow(tx),
        });
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  /**
   * The decision write itself, shared by the plain and the moderator paths.
   *
   * `now` must be `txNow(tx)` — `settled_at` is compared against the
   * `resolved_at` written here, so a caller that reaches for its own clock
   * reopens the skew this service cannot tolerate.
   */
  private async writeDecision(
    tx: Sql,
    args: { trade: TradeRecord; to: TradeStatus; resolution: TradeResolution; reason: string; now: Date },
  ): Promise<void> {
    const { trade, to, resolution, reason, now } = args;

    await tx`
      UPDATE p2p.p2p_trades
         SET status = ${to}, resolution = ${resolution}, resolution_reason = ${reason},
             resolved_at = ${now}, deadline_at = NULL
       WHERE id = ${trade.id} AND resolution IS NULL
    `;

    // Liquidity that never traded goes back on the board. Only for a refund or
    // a void — a released trade consumed its inventory for real.
    if (resolution !== 'released') {
      await tx`
        UPDATE p2p.offers
           SET remaining_amt = LEAST(total_amt, remaining_amt + ${formatAmount(trade.amount)}::numeric),
               updated_at = now()
         WHERE id = ${trade.offerId} AND status <> 'closed'
      `;
    }

    if (resolution === 'released') {
      const releaseSecs = trade.escrowedAt ? Math.max(0, Math.round((now.getTime() - trade.escrowedAt.getTime()) / 1000)) : 0;
      await this.bumpReputation(tx, trade.sellerId, 'completed', releaseSecs);
      await this.bumpReputation(tx, trade.buyerId, 'completed', releaseSecs);
    } else if (resolution === 'refunded') {
      await this.bumpReputation(tx, trade.sellerId, 'cancelled');
      await this.bumpReputation(tx, trade.buyerId, 'cancelled');
    }
  }

  /**
   * PHASE 2 — act on the recorded decision.
   *
   * Idempotent from end to end: the recipe is keyed on the trade id, so a
   * re-run returns the original transaction rather than moving value again, and
   * `settled_at` is only stamped once the post AND the announcement have
   * succeeded. Everything between the decision and this stamp is the sweeper's
   * responsibility.
   */
  async settle(tradeId: string): Promise<TradeRecord> {
    try {
      return await this.settleOnce(tradeId);
    } catch (err) {
      // Durable reason for late pots — survives process restart; cleared on stamp.
      await this.persistSettleFailure(tradeId, err);
      throw err;
    }
  }

  private async settleOnce(tradeId: string): Promise<TradeRecord> {
    const trade = await this.getTrade(tradeId);

    if (!trade.resolution) throw new P2pError(`Trade ${tradeId} has no recorded resolution to settle`, 'p2p.escrow_missing');
    if (trade.settledAt) return trade;

    let fee: Amount = 0n;

    if (trade.resolution === 'released') {
      fee = mulBps(trade.amount, trade.feeBps);
      await this.ledger.post(
        recipes.escrowRelease({
          tradeId: trade.id,
          sellerId: trade.sellerId,
          buyerId: trade.buyerId,
          assetId: trade.asset,
          amount: trade.amount,
          feeBps: trade.feeBps,
        }),
      );
      await this.notifyP2pAffiliateAccrue(trade, fee);
      await this.notifyP2pAffiliatePayout(trade, fee);
    } else if (trade.resolution === 'refunded') {
      await this.ledger.post(
        recipes.escrowRefund({
          tradeId: trade.id,
          sellerId: trade.sellerId,
          buyerId: trade.buyerId,
          assetId: trade.asset,
          amount: trade.amount,
          resolution: trade.resolutionReason ?? 'cancelled',
        }),
      );
    }
    // `voided` posts nothing: the lock never happened, so there is nothing to
    // move. The row still terminates, which is what stops it being swept again.

    // ANNOUNCED BEFORE THE STAMP, not after.
    //
    // `settled_at` is what takes a trade off `sweepSettlements()`'s work list
    // (`resolved_at IS NOT NULL AND settled_at IS NULL`), and `settle()` returns
    // early on an already-stamped row. So anything that could fail AFTER the
    // stamp was a thing that would never be retried: one refused envelope — a
    // bus outage, a broker restart, a crash between the two statements — and the
    // release event and both parties' XP awards were gone for good. The value
    // had moved and nothing downstream would ever be told, with no work list
    // left holding the trade and no error to find it by.
    //
    // The reverse failure costs a re-publish, and that is the cheap direction:
    // every publish here carries a business idempotency key, JetStream dedupes
    // on it (`msgID`) and consumers dedupe on it again, so a second envelope
    // finds the original award. A lost one has nowhere to be found.
    await this.announceSettlement(trade, fee);

    const rows = await this.sql<TradeRow[]>`
      UPDATE p2p.p2p_trades
         SET settled_at = now(),
             last_settle_error = NULL,
             last_settle_error_at = NULL
       WHERE id = ${tradeId} AND settled_at IS NULL
      RETURNING *
    `;
    return rows[0] ? toTrade(rows[0]) : await this.getTrade(tradeId);
  }

  /** Best-effort; never throws. escrowRelease already posted. */
  private async notifyP2pAffiliateAccrue(trade: TradeRecord, fee: Amount): Promise<void> {
    await fireAffiliateAccrue(
      this.affiliateAccrue,
      affiliateLegAfterP2pRelease({
        tradeId: trade.id,
        sellerId: trade.sellerId,
        feeAmount: fee,
        feeAsset: trade.asset,
      }),
    );
  }

  /** Best-effort payout after accrue; never throws. escrowRelease already posted. */
  private async notifyP2pAffiliatePayout(trade: TradeRecord, fee: Amount): Promise<void> {
    await fireAffiliatePayout(
      this.affiliatePayout,
      affiliateLegAfterP2pRelease({
        tradeId: trade.id,
        sellerId: trade.sellerId,
        feeAmount: fee,
        feeAsset: trade.asset,
      }),
    );
  }

  /**
   * Write the last settle failure onto the late row. Never throws: a secondary
   * write failure must not mask the original settle error the caller needs.
   */
  private async persistSettleFailure(tradeId: string, err: unknown): Promise<void> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    try {
      await this.sql`
        UPDATE p2p.p2p_trades
           SET last_settle_error = ${message},
               last_settle_error_at = now()
         WHERE id = ${tradeId}
           AND resolved_at IS NOT NULL
           AND settled_at IS NULL
      `;
    } catch {
      // best-effort — the throw from settle still surfaces
    }
  }

  private async announceSettlement(trade: TradeRecord, fee: Amount): Promise<void> {
    const resolvedBy = resolvedByOf(trade.resolutionReason);

    if (trade.resolution === 'released') {
      const releaseSeconds =
        trade.escrowedAt && trade.resolvedAt
          ? Math.max(0, Math.round((trade.resolvedAt.getTime() - trade.escrowedAt.getTime()) / 1000))
          : 0;

      await this.bus.publish(
        'p2pEscrowReleased',
        {
          tradeId: trade.id,
          sellerId: trade.sellerId,
          buyerId: trade.buyerId,
          asset: trade.asset,
          amount: formatAmount(trade.amount),
          fee: formatAmount(fee),
          resolvedBy: resolvedBy === 'moderator' ? 'moderator' : 'seller',
          releaseSeconds,
        },
        { idempotencyKey: `p2p.escrow.release:${trade.id}` },
      );

      await this.awardXp(trade.id, trade.sellerId, 'trade.completed.seller');
      await this.awardXp(trade.id, trade.buyerId, 'trade.completed.buyer');
    } else if (trade.resolution === 'refunded') {
      await this.bus.publish(
        'p2pEscrowRefunded',
        {
          tradeId: trade.id,
          sellerId: trade.sellerId,
          buyerId: trade.buyerId,
          asset: trade.asset,
          amount: formatAmount(trade.amount),
          resolvedBy,
          reason: trade.resolutionReason ?? 'cancelled',
        },
        { idempotencyKey: `p2p.escrow.refund:${trade.id}` },
      );
    }

    // A dispute the moderator ruled against costs the loser XP. Emitted here so
    // it rides the same idempotency guarantee as the award on the winning side.
    if (trade.resolutionReason?.startsWith('moderator:')) {
      const loser = trade.resolution === 'released' ? trade.sellerId : trade.buyerId;
      await this.awardXp(trade.id, loser, 'dispute.lost');
    }
  }

  /**
   * §6.2 → §4.1: "Reputation events feed the same XP graph."
   *
   * Published, not called: svc-identity is the only writer to `rank_state`, and
   * `intafaced.identity.xp.earned` is the declared way in (§4.1). The key is a
   * business key, so a redelivered event finds the original award.
   */
  private async awardXp(tradeId: string, userId: string, action: P2pXpAction): Promise<void> {
    const xpDelta = xpFor(action, this.xpPolicy);
    if (xpDelta === 0) return;

    await this.bus.publish(
      'xpEarned',
      { userId, sourceModule: 'p2p', action, xpDelta, meta: { tradeId } },
      { idempotencyKey: xpKey(tradeId, userId, action) },
    );
  }

  // ── The sweeps — why a trade cannot sit in escrow forever ──────────────────

  /**
   * TIMEOUT SWEEP.
   *
   * Every live state carries a deadline (the database refuses one without:
   * `p2p_trades_live_has_deadline_ck`), and every deadline maps to an action
   * (`timeoutActionFor`, which is total over the status enum). So this loop is
   * the proof that no trade can sit in escrow indefinitely — there is no live
   * state it cannot pick up and no state it picks up that it leaves unchanged.
   *
   * Trades are processed one at a time and independently. One trade that fails
   * to settle must not stop the sweep reaching the next.
   *
   * `escalated` is counted separately from `swept` because it is the one
   * outcome where nothing was resolved. Folding it into `swept` would let a
   * growing pile of unreachable disputes read on a dashboard as a busy,
   * healthy sweep.
   */
  async sweepDeadlines(now?: Date, limit?: number): Promise<SweepResult> {
    const lim = assertSweepDeadlinesLimit(limit);
    // Every `deadline_at` was derived from the server clock, so the cutoff this
    // compares them against has to come from there too. A caller may still pass
    // its own instant — that is how a test asks "what would be due at T?" — but
    // the default must not reintroduce this process' clock.
    const at = now ?? (await txNow(this.sql));

    const due = await this.sql<Array<{ id: string; status: TradeStatus }>>`
      SELECT id, status FROM p2p.p2p_trades
       WHERE deadline_at IS NOT NULL AND deadline_at <= ${at} AND resolution IS NULL
       ORDER BY deadline_at ASC
       LIMIT ${lim}
    `;

    let swept = 0;
    let escalated = 0;
    const failures: SweepFailure[] = [];

    for (const row of due) {
      try {
        const outcome = await this.applyTimeout(row.id, row.status);
        if (outcome === 'escalated') escalated++;
        else swept++;
      } catch (err) {
        // Left with its deadline in the past, so the next sweep retries it. A
        // trade that cannot be resolved must keep asking, not go quiet.
        //
        // AND IT SAYS WHY. This `catch` used to be bare — `catch { failed++ }`
        // — so the sweep counted a number and threw the reason away. The cost
        // of that is not theoretical: the escrow guard's refusal ("a disputed
        // escrow terminates only on a human ruling") reached this line, was
        // discarded, and surfaced three files away as an assertion failure that
        // named nothing. A refusal a human never sees is most of the way back
        // to the problem this service exists to fix.
        failures.push(describeFailure(row.id, row.status, err));
      }
    }

    return { swept, failed: failures.length, escalated, failures };
  }

  private async applyTimeout(tradeId: string, status: TradeStatus): Promise<'acted' | 'escalated'> {
    const action = timeoutActionFor(status);
    if (!action) return 'acted';

    switch (action) {
      case 'settle_or_void': {
        // `created` — the take never finished. Re-drive the lock so we KNOW
        // whether anything is in escrow, then unwind whatever we find.
        const result = await this.unwind(tradeId, 'timeout.escrow_incomplete', status);
        await this.publishExpired(tradeId, status, result.resolution === 'voided' ? 'voided' : 'refunded');
        return 'acted';
      }

      case 'refund': {
        // `escrowed` — the buyer never even claimed to have paid. The seller's
        // asset goes home in full.
        await this.unwind(tradeId, 'timeout.payment_window_elapsed', status);
        await this.publishExpired(tradeId, status, 'refunded');
        return 'acted';
      }

      case 'open_dispute': {
        // `fiat_sent` — the buyer says paid and the seller has not confirmed.
        // That is two people disagreeing, not a stall. Auto-releasing here would
        // hand the asset to anyone willing to click "I paid" and wait.
        await this.openDisputeInner(
          {
            tradeId,
            openedBy: (await this.getTrade(tradeId)).buyerId,
            reason: 'timeout.seller_did_not_confirm',
          },
          'timeout',
        );
        await this.publishExpired(tradeId, status, 'disputed');
        return 'acted';
      }

      case 'escalate_dispute': {
        // `disputed` — the moderator SLA has passed and nobody has ruled.
        //
        // WHAT USED TO HAPPEN HERE: `resolveDispute` with
        // `moderatorId: 'system:p2p-backstop'` and a refund, seven days after
        // the dispute opened. That is an automated resolution of a disputed
        // release, which SPEC-OTC-RFQ-AND-EARN §33 says is the one place in the
        // platform where a human decision is the design rather than the
        // fallback — and it fired while there was no queue to find the dispute
        // in, no way to read its evidence, and no session that could hold
        // `admin:compliance`. A timer that acts because nobody could have
        // looked is not a fallback; it is the only path.
        //
        // It escalates instead. Nothing moves.
        await this.escalateDispute(tradeId);
        return 'escalated';
      }
    }
  }

  /**
   * SLA BREACHED. Re-arm, record, raise. Do not decide.
   *
   * The one real tension is `p2p_trades_live_has_deadline_ck`, which makes "a
   * trade sits in escrow with no clock on it" unrepresentable — and that
   * constraint is right. It is satisfied here without disposing of anything:
   * **the constraint requires a live trade to carry a deadline; it does not
   * require the deadline to dispose of value.** So the trade's deadline moves
   * to the next re-check and the sweeper keeps picking the trade up, forever if
   * that is what it takes.
   *
   * The DISPUTE's own `deadline_at` is deliberately left in the past. It is the
   * SLA, the SLA was missed, and the queue orders by it — moving it would push
   * the most neglected dispute to the bottom of the list a moderator reads.
   */
  private async escalateDispute(tradeId: string): Promise<void> {
    await transaction(
      this.sql,
      async (tx) => {
        const trade = await this.lockTrade(tx, tradeId);
        if (trade.status !== 'disputed' || trade.resolution !== null) return;

        const now = await txNow(tx);
        const nextCheck = escalationDeadline(now, this.deadlines);

        await tx`
          UPDATE p2p.p2p_disputes
             SET escalated_at = COALESCE(escalated_at, ${now}), escalations = escalations + 1
           WHERE trade_id = ${tradeId} AND status = 'open'
        `;

        // `deadlines.disputeBy` keeps the ORIGINAL SLA. The re-check is not a
        // new promise to the parties and must not be recorded as one.
        await tx`
          UPDATE p2p.p2p_trades SET deadline_at = ${nextCheck} WHERE id = ${tradeId} AND resolution IS NULL
        `;
      },
      { isolation: 'read committed', maxAttempts: 5 },
    );
  }

  private async publishExpired(
    tradeId: string,
    from: TradeStatus,
    outcome: 'released' | 'refunded' | 'voided' | 'disputed',
  ): Promise<void> {
    await this.bus.publish('p2pTradeExpired', { tradeId, from, outcome }, { idempotencyKey: `p2p.trade.expired:${tradeId}:${from}` });
  }

  /**
   * SETTLEMENT SWEEP — the other half of "decide, then post".
   *
   * A trade with a recorded resolution and no `settled_at` is a decision that
   * was made but not yet acted on: the only window in which P2P value can be
   * late. This closes it, and it is self-healing because every recipe is keyed
   * on the trade id.
   */
  async sweepSettlements(limit?: number): Promise<{ settled: number; failed: number; failures: SweepFailure[] }> {
    const lim = assertSweepSettlementsLimit(limit);
    const pending = await this.sql<Array<{ id: string; status: TradeStatus }>>`
      SELECT id, status FROM p2p.p2p_trades
       WHERE resolved_at IS NOT NULL AND settled_at IS NULL
       ORDER BY resolved_at ASC
       LIMIT ${lim}
    `;

    let settled = 0;
    const failures: SweepFailure[] = [];

    for (const row of pending) {
      try {
        await this.settle(row.id);
        settled++;
      } catch (err) {
        // The sharpest case in the service. A trade here has a COMMITTED
        // decision and no ledger post: value that is late. Swallowing the
        // reason left it sitting `resolved` and unsettled with nothing but a
        // counter to show for it, and `escrowIntegrity()` counts it as still
        // holding escrow — correctly — so it does not flag either.
        failures.push(describeFailure(row.id, row.status, err));
      }
    }

    return { settled, failed: failures.length, failures };
  }

  /**
   * SURFACE permanently-late settlements (ADR 2026-08-04 agents-may-implement).
   *
   * A trade with `resolved_at` set and `settled_at` null is a committed decision
   * whose ledger post has not landed. Operators must be able to list these
   * without grepping process logs — the sweep already logs failures each tick,
   * but a query is what a dashboard and a human on-call actually use.
   *
   * Does not invent error text for trades that have not yet been re-driven;
   * `ageSeconds` is derived from resolved_at so lateness is checkable.
   */
  async listLateSettlements(
    limit?: number,
    now: Date = new Date(),
  ): Promise<
    Array<{
      tradeId: string;
      status: TradeStatus;
      resolution: TradeResolution | null;
      resolutionReason: string | null;
      resolvedAt: Date;
      ageSeconds: number;
      /** Last settle failure if any attempt ran; null if not yet re-driven. */
      lastSettleError: string | null;
      lastSettleErrorAt: Date | null;
    }>
  > {
    const lim = assertLateSettlementsListLimit(limit);
    const rows = await this.sql<
      Array<{
        id: string;
        status: TradeStatus;
        resolution: TradeResolution | null;
        resolution_reason: string | null;
        resolved_at: Date;
        last_settle_error: string | null;
        last_settle_error_at: Date | null;
      }>
    >`
      SELECT id, status, resolution, resolution_reason, resolved_at,
             last_settle_error, last_settle_error_at
        FROM p2p.p2p_trades
       WHERE resolved_at IS NOT NULL AND settled_at IS NULL
       ORDER BY resolved_at ASC
       LIMIT ${lim}
    `;
    const nowMs = now.getTime();
    return rows.map((r) => {
      const resolvedAt = r.resolved_at instanceof Date ? r.resolved_at : new Date(r.resolved_at);
      const lastSettleErrorAt =
        r.last_settle_error_at == null
          ? null
          : r.last_settle_error_at instanceof Date
            ? r.last_settle_error_at
            : new Date(r.last_settle_error_at);
      return {
        tradeId: r.id,
        status: r.status,
        resolution: r.resolution,
        resolutionReason: r.resolution_reason,
        resolvedAt,
        ageSeconds: Math.max(0, Math.floor((nowMs - resolvedAt.getTime()) / 1000)),
        lastSettleError: r.last_settle_error,
        lastSettleErrorAt,
      };
    });
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async getTrade(tradeId: string): Promise<TradeRecord> {
    const rows = await this.sql<TradeRow[]>`SELECT * FROM p2p.p2p_trades WHERE id = ${tradeId}`;
    const row = rows[0];
    if (!row) throw unknownTrade(tradeId);
    return toTrade(row);
  }

  async listTrades(userId: string, limit?: number): Promise<TradeRecord[]> {
    const lim = assertTradeListLimit(limit);
    const rows = await this.sql<TradeRow[]>`
      SELECT * FROM p2p.p2p_trades
       WHERE seller_id = ${userId} OR buyer_id = ${userId}
       ORDER BY created_at DESC
       LIMIT ${lim}
    `;
    return rows.map(toTrade);
  }

  async getDispute(tradeId: string): Promise<DisputeRecord> {
    const rows = await this.sql<DisputeRow[]>`SELECT * FROM p2p.p2p_disputes WHERE trade_id = ${tradeId}`;
    const row = rows[0];
    if (!row) throw new P2pError(`Trade ${tradeId} has no dispute`, 'p2p.dispute_not_found');
    return toDispute(row);
  }

  async reputationOf(userId: string): Promise<ReputationSnapshot> {
    const rows = await this.sql<
      Array<{
        trades_total: number;
        completed: number;
        cancelled: number;
        disputed: number;
        disputes_lost: number;
        total_release_secs: number;
        release_samples: number;
      }>
    >`
      SELECT trades_total, completed, cancelled, disputed, disputes_lost, total_release_secs, release_samples
        FROM p2p.p2p_reputation WHERE user_id = ${userId}
    `;

    const row = rows[0];
    // No history is an empty record, not a perfect one. Rendering an unknown
    // trader as flawless is how a fresh account borrows a merchant's trust.
    if (!row) return snapshotOf(EMPTY_COUNTERS);

    return snapshotOf({
      tradesTotal: Number(row.trades_total),
      completed: Number(row.completed),
      cancelled: Number(row.cancelled),
      disputed: Number(row.disputed),
      disputesLost: Number(row.disputes_lost),
      totalReleaseSecs: Number(row.total_release_secs),
      releaseSamples: Number(row.release_samples),
    });
  }

  /**
   * DOCTRINE §0.6, as a query.
   *
   * "How much is in P2P escrow" has two independent answers: this service's
   * trade terms, and the ledger's per-trade escrow pots. They must agree
   * **per trade**. Aggregating by (seller, asset) first would hide
   * equal-and-opposite cross-trade theft — the pots are purpose-keyed for a
   * reason, and the alarm has to use the same grain.
   *
   * A trade that is decided but not yet settled still holds escrow — the post
   * has not happened — so it counts on this side too.
   */
  async escrowIntegrity(): Promise<
    | { ok: true }
    | {
        ok: false;
        drift: Array<{ tradeId: string; sellerId: string; asset: string; expected: string; actual: string }>;
      }
  > {
    const rows = await this.sql<Array<{ id: string; seller_id: string; asset: string; amount: string }>>`
      SELECT id, seller_id, asset, amount
        FROM p2p.p2p_trades
       WHERE status IN ('escrowed', 'fiat_sent', 'disputed')
          OR (resolution IN ('released', 'refunded') AND settled_at IS NULL)
    `;

    const drift: Array<{ tradeId: string; sellerId: string; asset: string; expected: string; actual: string }> = [];
    for (const row of rows) {
      const expected = parseAmount(row.amount);
      const actual = (await this.ledger.balance(tradeEscrowAccount(row.seller_id, row.asset, row.id))).amount;
      if (expected !== actual) {
        drift.push({
          tradeId: row.id,
          sellerId: row.seller_id,
          asset: row.asset,
          expected: formatAmount(expected),
          actual: formatAmount(actual),
        });
      }
    }

    return drift.length === 0 ? { ok: true } : { ok: false, drift };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private assertTradingEnabled(): void {
    if (!this.tradingEnabled) {
      throw new P2pError('P2P trading is disabled by the operator kill-switch', 'p2p.trading_disabled');
    }
  }

  private async lockTrade(tx: Sql, tradeId: string): Promise<TradeRecord> {
    const rows = await tx<TradeRow[]>`SELECT * FROM p2p.p2p_trades WHERE id = ${tradeId} FOR UPDATE`;
    const row = rows[0];
    if (!row) throw unknownTrade(tradeId);
    return toTrade(row);
  }

  /**
   * Reputation counters, updated inside the caller's transaction.
   *
   * Read-modify-write under the trade's row lock rather than a bare UPDATE …
   * SET x = x + 1, because the badge set and the completion rate are derived
   * from the whole row and must be recomputed from the post-increment values,
   * not from whatever a second statement would read back.
   */
  private async bumpReputation(tx: Sql, userId: string, outcome: TradeOutcome, releaseSecs?: number): Promise<void> {
    const rows = await tx<
      Array<{
        trades_total: number;
        completed: number;
        cancelled: number;
        disputed: number;
        disputes_lost: number;
        total_release_secs: number;
        release_samples: number;
      }>
    >`
      SELECT trades_total, completed, cancelled, disputed, disputes_lost, total_release_secs, release_samples
        FROM p2p.p2p_reputation WHERE user_id = ${userId} FOR UPDATE
    `;

    const current: ReputationCounters = rows[0]
      ? {
          tradesTotal: Number(rows[0].trades_total),
          completed: Number(rows[0].completed),
          cancelled: Number(rows[0].cancelled),
          disputed: Number(rows[0].disputed),
          disputesLost: Number(rows[0].disputes_lost),
          totalReleaseSecs: Number(rows[0].total_release_secs),
          releaseSamples: Number(rows[0].release_samples),
        }
      : EMPTY_COUNTERS;

    const next = snapshotOf(applyOutcome(current, outcome, releaseSecs));

    await tx`
      INSERT INTO p2p.p2p_reputation (
        user_id, trades_total, completed, cancelled, disputed, disputes_lost,
        completion_rate, total_release_secs, release_samples, avg_release_secs, badges, updated_at
      )
      VALUES (
        ${userId}, ${next.tradesTotal}, ${next.completed}, ${next.cancelled}, ${next.disputed}, ${next.disputesLost},
        ${next.completionRate}, ${next.totalReleaseSecs}, ${next.releaseSamples}, ${next.avgReleaseSecs},
        ${toPgTextArray(next.badges)}::text[], now()
      )
      ON CONFLICT (user_id) DO UPDATE SET
        trades_total = EXCLUDED.trades_total,
        completed = EXCLUDED.completed,
        cancelled = EXCLUDED.cancelled,
        disputed = EXCLUDED.disputed,
        disputes_lost = EXCLUDED.disputes_lost,
        completion_rate = EXCLUDED.completion_rate,
        total_release_secs = EXCLUDED.total_release_secs,
        release_samples = EXCLUDED.release_samples,
        avg_release_secs = EXCLUDED.avg_release_secs,
        badges = EXCLUDED.badges,
        updated_at = now()
    `;
  }
}

// ── Row mapping ──────────────────────────────────────────────────────────────

function toOffer(row: OfferRow): OfferRecord {
  return {
    id: row.id,
    makerId: row.maker_id,
    side: row.side,
    asset: row.asset,
    fiatCurrency: row.fiat_currency,
    priceType: row.price_type,
    price: parseAmount(row.price),
    minAmt: parseAmount(row.min_amt),
    maxAmt: parseAmount(row.max_amt),
    totalAmt: parseAmount(row.total_amt),
    remainingAmt: parseAmount(row.remaining_amt),
    methods: Array.isArray(row.methods) ? row.methods : [],
    terms: row.terms,
    status: row.status,
    createdAt: row.created_at,
  };
}

function toTrade(row: TradeRow): TradeRecord {
  return {
    id: row.id,
    offerId: row.offer_id,
    takerId: row.taker_id,
    makerId: row.maker_id,
    sellerId: row.seller_id,
    buyerId: row.buyer_id,
    asset: row.asset,
    fiatCurrency: row.fiat_currency,
    amount: parseAmount(row.amount),
    price: parseAmount(row.price),
    fiatAmount: parseAmount(row.fiat_amount),
    method: row.method,
    feeBps: Number(row.fee_bps),
    status: row.status,
    resolution: row.resolution,
    resolutionReason: row.resolution_reason,
    chatThreadId: row.chat_thread_id ?? null,
    deadlines: (row.deadlines ?? {}) as Deadlines,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    escrowedAt: row.escrowed_at,
    fiatSentAt: row.fiat_sent_at,
    resolvedAt: row.resolved_at,
    settledAt: row.settled_at,
  };
}

function toDispute(row: DisputeRow): DisputeRecord {
  return {
    id: row.id,
    tradeId: row.trade_id,
    openedBy: row.opened_by,
    // Pre-0006 rows defaulted to 'party' in the column; treat any unexpected
    // value as party rather than inventing a third origin on the wire.
    openedVia: row.opened_via === 'timeout' ? 'timeout' : 'party',
    reason: row.reason,
    chatThreadId: row.chat_thread_id ?? null,
    evidence: normaliseEvidence(row.evidence),
    moderatorId: row.moderator_id,
    resolution: row.resolution,
    resolutionNotes: row.resolution_notes,
    status: row.status,
    deadlineAt: row.deadline_at,
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
    lastSeenByModeratorAt: row.last_seen_by_moderator_at ?? null,
    moderatorViews: Number(row.moderator_views ?? 0),
    escalatedAt: row.escalated_at ?? null,
    escalations: Number(row.escalations ?? 0),
  };
}

// ── Evidence ─────────────────────────────────────────────────────────────────

interface EvidenceEnvelope {
  seq: number;
  submittedBy: string;
  submittedAt: string;
  item: unknown;
}

/**
 * What the caller sent, checked before a transaction is opened.
 *
 * The caps are here AND on the column, and that is not belt-and-braces: the
 * column's CHECK is the one that survives a migration, a fixture script, or a
 * future append path somebody adds without reading this function.
 */
function assertEvidenceAcceptable(items: readonly unknown[], existingCount: number): readonly unknown[] {
  if (!Array.isArray(items)) {
    throw new P2pError('Evidence must be a list', 'p2p.dispute_evidence_rejected');
  }
  if (items.length > MAX_EVIDENCE_PER_CALL) {
    throw new P2pError(`At most ${MAX_EVIDENCE_PER_CALL} pieces of evidence can be submitted at once`, 'p2p.dispute_evidence_rejected');
  }
  if (existingCount + items.length > MAX_EVIDENCE_ENTRIES) {
    throw new P2pError(`A dispute holds at most ${MAX_EVIDENCE_ENTRIES} pieces of evidence`, 'p2p.dispute_evidence_rejected');
  }
  for (const item of items) {
    if (item === undefined) {
      throw new P2pError('Evidence entries cannot be empty', 'p2p.dispute_evidence_rejected');
    }
    // Sized as JSON because that is what the column stores. A cap measured on
    // anything else is a cap on the wrong number.
    if (Buffer.byteLength(JSON.stringify(item) ?? '', 'utf8') > MAX_EVIDENCE_ITEM_BYTES) {
      throw new P2pError(`A piece of evidence must be under ${MAX_EVIDENCE_ITEM_BYTES} bytes`, 'p2p.dispute_evidence_rejected');
    }
  }
  return items;
}

/** Wrap raw items in attributed envelopes, numbered on from what is already there. */
function envelopesFor(items: readonly unknown[], submittedBy: string, at: Date, existingCount: number): EvidenceEnvelope[] {
  return items.map((item, i) => ({
    seq: existingCount + i + 1,
    submittedBy,
    submittedAt: at.toISOString(),
    item,
  }));
}

/**
 * Read the column back as entries.
 *
 * An element that is not an envelope is NOT attributed to the dispute's opener
 * on the assumption that it probably was theirs. It is returned with
 * `submittedBy: null` — unattributed, and visibly so. A guess recorded as a
 * fact is how an audit trail starts lying, and this one would be lying about
 * who accused whom.
 */
function normaliseEvidence(raw: unknown): readonly EvidenceEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((element, i) => {
    if (element && typeof element === 'object' && !Array.isArray(element) && 'item' in element && 'submittedBy' in element) {
      const e = element as Partial<EvidenceEnvelope>;
      const at = typeof e.submittedAt === 'string' ? new Date(e.submittedAt) : null;
      return {
        seq: typeof e.seq === 'number' ? e.seq : i + 1,
        submittedBy: typeof e.submittedBy === 'string' ? e.submittedBy : null,
        submittedAt: at && !Number.isNaN(at.getTime()) ? at : null,
        item: e.item,
      };
    }
    return { seq: i + 1, submittedBy: null, submittedAt: null, item: element };
  });
}

/**
 * What a party is allowed to see of the evidence: their own.
 *
 * The alternative — showing each side the other's submissions — is a product
 * decision with a legal shadow, not a serialisation detail. Evidence is
 * free-form and unmoderated: it carries bank references, names, and whatever
 * else a frightened counterparty pastes into a box, about a person who did not
 * consent to it being handed back to the person they are in dispute with.
 * There is no attachment store, no redaction, and no erase path
 * (`docs/adr/2026-08-04-p2p-escrow-and-dispute-law.md` Decision 5), so a
 * disclosure made here cannot be taken back.
 *
 * So the moderator-scoped read gets everything, and each party gets what they
 * filed. Widening it is one line and an owner's decision.
 */
function evidenceVisibleTo(dispute: DisputeRecord, viewerId: string): readonly EvidenceEntry[] {
  return dispute.evidence.filter((e) => e.submittedBy !== null && e.submittedBy === viewerId);
}

// ── The moderator queue cursor ───────────────────────────────────────────────

/**
 * THE QUEUE CURSOR IS A DISPUTE ID, AND NOTHING ELSE.
 *
 * Keyset, not offset: the queue is ordered by a column that changes underneath
 * a reader (a dispute resolves, a new one arrives, an escalation lands), and an
 * offset would let one of those shift a dispute past a page boundary and out of
 * view entirely. "The queue skipped one" is the exact failure this whole
 * surface exists to end.
 *
 * The obvious keyset cursor is `<deadline>|<id>`, and it is wrong here for a
 * reason worth writing down. Postgres describes `$n::timestamptz` as a
 * timestamptz parameter, so the driver serialises whatever it is given THROUGH
 * A JS DATE — which holds milliseconds, while the column holds microseconds. A
 * cursor built from the last row therefore lands a fraction of a millisecond
 * BEFORE that row, and every page repeats its predecessor's last entry. A
 * queue that repeats is the same broken promise as one that skips, arrived at
 * from the other side. (`.799344+00` went in; `.799+00` was compared.)
 *
 * So the timestamp never leaves the database. The cursor carries the id, and
 * the ordering key is looked up server-side at full precision. An unknown id
 * yields an empty page rather than an error — dispute rows are never deleted,
 * so the only way to present one is to have invented it.
 */
function assertDisputeCursor(cursor: string | null): string | null {
  if (!cursor) return null;
  if (!/^[0-9a-fA-F-]{36}$/.test(cursor)) {
    throw new P2pError('Malformed queue cursor', 'p2p.dispute_not_found');
  }
  return cursor;
}

export { evidenceVisibleTo };

/**
 * Does this offer accept this payment method?
 *
 * CASE IS NOT MEANING. An offer's `methods` are stored exactly as the maker
 * typed them; a method id is lowercased everywhere it is stored as an
 * instrument. Comparing the two with `===` made `"Bank_Transfer"` and
 * `"bank_transfer"` different methods — a distinction no maker or taker was
 * ever shown, and one that failed on both spellings: the take was refused here,
 * or it passed here and was refused a layer down by `attachToTrade`. Keyed
 * comparison is the same rule on both sides of the door.
 */
function methodAllowed(methods: unknown[], method: string): boolean {
  // An offer with no declared methods accepts anything — the maker's terms text
  // is the contract in that case. An offer WITH methods accepts only those.
  if (methods.length === 0) return true;
  const wanted = methodIdKey(method);
  return methods.some((m) => {
    if (typeof m === 'string') return methodIdKey(m) === wanted;
    if (m && typeof m === 'object' && 'id' in m) {
      const id = (m as { id: unknown }).id;
      return typeof id === 'string' && methodIdKey(id) === wanted;
    }
    return false;
  });
}

/**
 * Badges as a Postgres array literal.
 *
 * Sent as a string with an explicit `::text[]` cast rather than as a JS array:
 * the driver infers an array's element type from its first element, and the
 * common case here — a new trader with no badges yet — has no first element.
 */
function toPgTextArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
}

function resolvedByOf(reason: string | null): 'buyer' | 'seller' | 'moderator' | 'timeout' {
  if (!reason) return 'seller';
  if (reason.startsWith('moderator:')) return 'moderator';
  if (reason.startsWith('timeout.')) return 'timeout';
  if (reason.startsWith('buyer')) return 'buyer';
  return 'seller';
}

export { TradeStateError, PricingError };
