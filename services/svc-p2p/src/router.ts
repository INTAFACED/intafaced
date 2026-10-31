import { z } from 'zod';
import { AuthError, requireMfa, type Principal } from '@intafaced/auth';
import { router, publicProcedure, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { enabledFiat } from '@intafaced/config';
import { formatAmount, mulBps, parseAmount, sub, type Amount } from '@intafaced/ledger-client';
import {
  ActionApprovalConsumeError,
  consumeDisputeResolveApproval,
  p2pActionPayloadHash,
  readApprovalIds,
  type ActionApprovalConsumer,
  unwiredApprovalConsumer,
} from './action-approval-consume.js';
import { OpsReads } from './ops/ops-reads.js';
import type { P2pErasure } from './erasure.js';
import {
  MAX_EVIDENCE_PER_CALL,
  P2pError,
  PricingError,
  REMARK_MAX,
  unknownTrade,
  TradeStateError,
  evidenceVisibleTo,
  type DisputeRecord,
  type P2pService,
  type RemarkCase,
  type ShareLinkRecord,
} from './p2p-service.js';
import {
  CASH_RELEASE_MAX_SECONDS,
  CASH_RELEASE_MIN_SECONDS,
  CASH_TEXT_MAX,
  InstrumentError,
  methodIdFromOfferEntry,
  NOTE_FORBIDDEN_MAX_WORDS,
  NOTE_FORBIDDEN_WORD_MAX,
  NOTE_GUIDANCE_MAX,
  parseFieldSpecs,
  type MethodSettlement,
} from './instruments.js';
import { BOARD_SORTS, type BoardSort } from './customer-depth.js';
import { BULK_ACTIONS, MAX_BULK_OFFERS, MAX_PRESENCE_WINDOWS, PRESENCE_MODES, TODO_KINDS, type Presence } from './merchant-console.js';
import { ELIGIBILITY_CHECK_IDS, ELIGIBILITY_STATES, TakeGateError, unwiredTakeGate, type TakeGate } from './take-eligibility.js';
import { POSTING_CHECK_IDS, POSTING_CHECK_STATES, POSTING_POLICIES } from './posting-eligibility.js';
import { DELIST_REASONS, type InstrumentService } from './instrument-service.js';
import { assertModerator, isModerationConfigured, isModerator } from './moderation-auth.js';
import { TakeStepUpError, unwiredTakeStepUp, type TakeStepUp, type TakeStepUpCaller } from './take-step-up.js';
import { unwiredReleaseStepUp, type ReleaseStepUp } from './release-step-up.js';
import { unwiredInstrumentStepUp, type InstrumentStepUp } from './instrument-step-up.js';
import type { PublicProfileLookup } from './public-profile.js';
import type { ReminderState } from './seller-reminders.js';
import { MISMATCH_CLASSIFICATIONS, MISMATCH_KINDS, type MismatchReport } from './amount-mismatch.js';
import { moderationHonestySchema, moderationOnPublicDoor } from './moderation-honesty.js';
import {
  ceilingOnWire,
  limitsConfigured,
  limitsOnWire,
  NO_OFFER_LIMITS,
  offerLimitsPosture,
  type OfferLimitPolicy,
} from './merchant-limits.js';
import { isActiveMerchant, programmeVouch, reputationOnPublicDoor } from './merchant-programme.js';
import { COMPLETION_DEFINITION } from './completion-rate.js';
import { DISPLAY_STATUSES, ORDER_TABS, displayStatus, tabOf } from './order-list.js';
import { EXPORT_FORMATS } from './export-receipt.js';
import type { MerchantEvent, MerchantRecord, MerchantService } from './merchant-service.js';
import { BlockRfqError, type BlockRfqService } from './block-rfq.js';
import type { ReviewRecord } from './reviews.js';
import { refuseLiveOffersUntilOwnerKms } from './instrument-kms.js';
import { AdvertiserTermsError } from './advertiser-terms.js';
import { instrumentKeyHealth } from './instrument-key-provider.js';
import { cancelReasonOf } from './cancel-reasons.js';
import { P2P_CANCEL_REASONS, P2P_CANCELLED_BY } from '@intafaced/contracts/p2p-cancel';

export type P2pRouterOptions = {
  /** Natural-person ids from `P2P_MODERATOR_USER_IDS`. Empty = unconfigured. */
  moderatorUserIds?: readonly string[];
  /**
   * Offer ceilings by merchant standing (TRK-p2p.merchants Stage 2).
   * Unset / empty = unlimited = pre-Stage-2 behaviour. Never invent magnitudes.
   */
  offerLimits?: OfferLimitPolicy;
  /** Firm block/RFQ desk (PTX-M12). Unset → quote/accept/expire refuse as unwired. */
  blockRfq?: BlockRfqService;
  /** Identity action-bound approval. Unset → refuse-closed (no invented second person). */
  approvals?: ActionApprovalConsumer;
  /**
   * `local-test` lets `offers.create` run. Anything else keeps today's refusal.
   * This is not owner KMS: health still reports `instrumentKmsConfigured: false`.
   */
  instrumentKeyProvider?: 'none' | 'local-test';
  /**
   * Public handle and member-since from identity. Unset → reputation.get names
   * `p2p.public_profile_unwired` and returns nulls. Never a made-up handle.
   */
  publicProfile?: PublicProfileLookup;
  /**
   * Fan-out for a new chat message. Unset → the message is stored and the
   * response names `p2p.chat_notify_unwired`. svc-notify is a different service.
   */
  chatNotify?: {
    messageSent(input: { tradeId: string; messageId: string; senderId: string; recipientIds: string[] }): Promise<void>;
  };
  /** Operator offer and trade reads. Unset → those procedures refuse rather than reading nothing and calling it empty. */
  opsReads?: OpsReads;
  /**
   * When true, disputes.resolve consumes a p2p.dispute_resolve approval in the
   * ruling transaction. Default false: one moderator, fourEyes false on the row.
   * Turning this on is a lead policy decision. This service does not turn it on.
   */
  disputeResolveRequiresApproval?: boolean;
  /**
   * What a person needs before taking an ad: confirmed contact
   * (`take-eligibility.ts`). Unset → every take refuses
   * `p2p.take_gate_unwired`; a missing gate never means "no checks".
   */
  takeGate?: TakeGate;
  /**
   * P-trade-orders-07: the fresh passkey or authenticator confirmation a take
   * needs (`take-step-up.ts`). Unset → every take refuses `auth.step_up_failed`;
   * a missing wire never means "no confirmation needed".
   */
  takeStepUp?: TakeStepUp;
  /** P-trade-orders-07 and -16: the seller's fresh confirmation of a release. Unset refuses every release. */
  releaseStepUp?: ReleaseStepUp;
  /** P-ads-merchant-18: the person's fresh confirmation of a payment-method change. Unset refuses every change. */
  instrumentStepUp?: InstrumentStepUp;
};

/**
 * svc-p2p's API (§6.2).
 *
 * Money crosses this boundary as **decimal strings**, in and out. `parseAmount`
 * at the edge, `formatAmount` on the way back, `Amount` (scaled bigint) in
 * between. A JS number never touches a P2P amount — including the fiat leg,
 * where a rounding error is a payment the counterparty can refuse.
 *
 * Every P2P procedure starts with `scopedProcedure(..., { module: 'p2p' })`,
 * which checks the scope AND runs the jurisdiction matrix (§7). The router
 * then applies the merchant API gate to identity-issued key traffic: sessions
 * keep ordinary P2P access, while a key must belong to an approved merchant.
 * P2P is custodial on the Fiat Plane — the platform holds the escrowed asset —
 * so §22 puts it behind tiered verification.
 */

/** Decimal string on the wire. Rejects anything a float could have mangled. */
const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18dp');

/** P-ads-merchant-08: a person's presence, as the console shows it. */
const presenceOutput = z.object({
  mode: z.enum(PRESENCE_MODES),
  timezone: z.string(),
  windows: z.array(z.object({ day: z.number().int(), start: z.string(), end: z.string() })),
  onBoard: z.boolean(),
  nextChangeAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
const presentPresence = (presence: Presence): z.infer<typeof presenceOutput> => ({
  ...presence,
  nextChangeAt: presence.nextChangeAt ? presence.nextChangeAt.toISOString() : null,
  updatedAt: presence.updatedAt ? presence.updatedAt.toISOString() : null,
});

/**
 * Shared board filters. `offers.list` stays an array for the live customer
 * parser. `offers.page` is the cursor page. Cursor is not a list input.
 */
/** A take sized in the coin (`amount`) or in the ad's fiat (`fiatAmount`): exactly one. */
/** P-ads-merchant-07: a share token as `offers.shareLinks.create` makes it (32 base64url characters). */
const shareTokenInput = z.string().regex(/^[A-Za-z0-9_-]{32}$/);

const takeAmountInput = z
  .object({
    offerId: z.string().guid(),
    amount: amountString.optional(),
    fiatAmount: amountString.optional(),
    method: z.string().min(1).max(64),
    /** P-ads-merchant-07: the share link the taker came by; required for a private ad. */
    shareToken: shareTokenInput.optional(),
  })
  .refine((value) => (value.amount === undefined) !== (value.fiatAmount === undefined), {
    message: 'p2p.invalid_amount: give the amount in the coin or in fiat, not both',
    path: ['amount'],
  });

const takeAmountOf = (input: { amount?: string; fiatAmount?: string }): { amount: Amount } | { fiatAmount: Amount } =>
  input.amount !== undefined ? { amount: parseAmount(input.amount) } : { fiatAmount: parseAmount(input.fiatAmount!) };

const offerListShape = {
  asset: z.string().optional(),
  fiatCurrency: z.string().length(3).optional(),
  side: z.enum(['buy', 'sell']).optional(),
  /**
   * Page size. Optional here so omit reaches the service named refuse
   * (`p2p.offer_list_limit_unset`) instead of a Zod "Required" that looks
   * like a typo. Blank is not 50; pass 50 explicitly when that is the page
   * you want.
   */
  limit: z.number().int().min(1).max(200).optional(),
  methodId: z.string().min(1).max(64).optional(),
  makerId: z.string().min(1).max(128).optional(),
  /** Minimum fiat the offer can still trade, as an exact decimal. Float offers are left out: no reference is invented. */
  minFiat: amountString.optional(),
  /** P-trade-orders-01: a fiat amount the ad can take whole (within its limits and what is left). Fixed price only. */
  fiatAmount: amountString.optional(),
  /** P-trade-orders-01: fixed-price ads by price, cheapest or dearest first, then floating ads. Default cheapest. */
  sort: z.enum(BOARD_SORTS).optional(),
};

const offerOutput = z.object({
  id: z.string().guid(),
  makerId: z.string(),
  side: z.enum(['buy', 'sell']),
  asset: z.string(),
  fiatCurrency: z.string(),
  priceType: z.enum(['fixed', 'float']),
  price: amountString,
  minAmount: amountString,
  maxAmount: amountString,
  remainingAmount: amountString,
  totalAmount: amountString,
  filledAmount: amountString,
  tradesCompleted: z.number().int().nonnegative(),
  /**
   * Board reads only, floating ads only: the market reference the multiplier applies to, or null when no market feed
   * prices this pair (the ad then cannot be priced or taken). Absent on fixed-price ads and on single-offer reads.
   */
  referencePrice: amountString.nullable().optional(),
  methods: z.array(z.unknown()),
  /**
   * P-disputes-security-09: the listed methods whose money arrives within a settlement window, with the longest window
   * any market sets (null when a market leaves it blank and the published payment deadline applies). Instant methods
   * are not listed. The order carries the exact profile of the market it pays into.
   */
  nonInstantMethods: z.array(z.object({ methodId: z.string(), windowSeconds: z.number().int().positive().nullable() })),
  /** P-disputes-security-09: the seller consented at post to non-instant methods. */
  acceptsNonInstant: z.boolean(),
  terms: z.string(),
  status: z.enum(['active', 'paused', 'closed']),
  /** P-ads-merchant-18: why the service paused the ad (`method_removed`); null when active, closed or paused by hand. */
  pauseReason: z.enum(['method_removed']).nullable(),
  /** P-ads-merchant-06: why the ad is closed (`by_you`, `sold_out`); null when not closed or closed before reasons. */
  closeReason: z.enum(['by_you', 'sold_out']).nullable(),
  /** P-ads-merchant-07: `public` (on the board) or `private` (by share link only). */
  visibility: z.enum(['public', 'private']),
  /** P-ads-merchant-06: when the ad came into its present status. */
  statusSince: z.string(),
  /** P-ads-merchant-06: the closed ad this one relisted, or null. */
  relistedFrom: z.string().guid().nullable(),
  /** P-ads-merchant-06: `offers.mine` only, the ad a closed one was relisted as, or null. Absent elsewhere. */
  relistedAs: z.string().guid().nullable().optional(),
  createdAt: z.string(),
});

/** P-ads-merchant-07: one share link, as its maker reads it. */
const shareLinkOutput = z.object({
  id: z.string().guid(),
  offerId: z.string().guid(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});

function toShareLinkOut<T extends ShareLinkRecord>(
  link: T,
): z.infer<typeof shareLinkOutput> & (T extends { token: string } ? { token: string } : unknown) {
  return {
    id: link.id,
    offerId: link.offerId,
    createdAt: link.createdAt.toISOString(),
    expiresAt: link.expiresAt.toISOString(),
    revokedAt: link.revokedAt?.toISOString() ?? null,
    ...('token' in link ? { token: (link as { token: string }).token } : {}),
  } as never;
}

/** P-disputes-security-09: how money on a method arrives in one market. */
const settlementOutput = z.union([
  z.object({ instant: z.literal(true) }),
  z.object({ instant: z.literal(false), windowSeconds: z.number().int().positive().nullable() }),
]);

const tradeOutput = z.object({
  id: z.string().guid(),
  offerId: z.string().guid(),
  /** P-ads-merchant-07: the order was taken through a share link. */
  sharedFrom: z.boolean(),
  sellerId: z.string(),
  buyerId: z.string(),
  asset: z.string(),
  amount: amountString,
  fiatCurrency: z.string(),
  fiatAmount: amountString,
  price: amountString,
  method: z.string(),
  status: z.enum(['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed']),
  resolution: z.enum(['released', 'refunded', 'voided']).nullable(),
  deadlineAt: z.string().nullable(),
  createdAt: z.string(),
  escrowedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  settledAt: z.string().nullable(),
});
/**
 * P-trade-orders-15: how many reminders the buyer sent, when the last went, and when the next may go (null when none can:
 * the order is not waiting on release, the owner's count is spent, or the owner's figures are blank).
 */
const reminderOutput = z.object({
  count: z.number().int().nonnegative(),
  lastAt: z.string().datetime().nullable(),
  nextAt: z.string().datetime().nullable(),
  max: z.number().int().positive().nullable(),
});

/**
 * P-trade-orders-20: the seller's report of what arrived in their bank, and how the owner's band classified it:
 * `within_tolerance` (the order goes on), `outside_tolerance` (the seller is not to release; the dispute path is the way
 * on) or `reported` (the band is blank, so a person decides through a dispute). `toleranceBps` is the band used.
 */
const mismatchOutput = z.object({
  kind: z.enum(MISMATCH_KINDS),
  amountReceived: amountString,
  expected: amountString,
  classification: z.enum(MISMATCH_CLASSIFICATIONS),
  toleranceBps: z.number().int().nonnegative().nullable(),
  reportedAt: z.string().datetime(),
});

/**
 * One order as its page reads it: the ad's terms as they were when it was placed (null before terms were copied), the
 * readable status the order list shows, the fee rate frozen at take, and, for a released order only, the split the
 * ledger's escrow release posts from that rate (`mulBps`, fee off the escrowed amount). A refund or a void takes no fee,
 * so those carry no split.
 */
const tradeDetailOutput = tradeOutput.extend({
  terms: z.string().nullable(),
  displayStatus: z.enum(DISPLAY_STATUSES),
  feeBps: z.number().int(),
  fee: amountString.nullable(),
  netAmount: amountString.nullable(),
  /** P-disputes-security-09: the method's profile in the market the buyer pays into, copied at take. */
  settlement: settlementOutput,
  /**
   * P-trade-orders-16: while the escrow is held, the split a release would post (the same `mulBps` on the frozen rate),
   * so the seller reviews what the buyer gets and the fee before releasing. Null once the order is no longer held.
   */
  releasePreview: z.object({ fee: amountString, netAmount: amountString }).nullable(),
  /**
   * P-trade-orders-12: what of this order is still in escrow, from the record: the escrowed amount while it is held, and
   * while a decided release or refund has not yet been posted; zero once the ledger posted it, and for a void. Null while
   * the order is `created`: the lock is not provably done, so no amount is claimed either way.
   */
  escrowHeld: amountString.nullable(),
  /** P-trade-orders-15: the buyer's reminders to the seller on this order. */
  reminders: reminderOutput,
  /** P-trade-orders-20: the seller's amount report on this order, or null. */
  mismatch: mismatchOutput.nullable(),
  /**
   * P-trade-orders-11: whether the bank rail can check this order's payment. `blocker` names what stops it:
   * `rail.bank` (no rail is wired) or `p2p.method_not_rail_validated` (the rail does not cover the method); null when
   * it can be checked.
   */
  paymentValidation: z.object({ blocker: z.enum(['rail.bank', 'p2p.method_not_rail_validated']).nullable() }),
  /** P-trade-orders-19: on a cancelled order, who cancelled it and the reason code they chose; null otherwise. */
  cancelReason: z.object({ by: z.enum(P2P_CANCELLED_BY), code: z.enum(P2P_CANCEL_REASONS).nullable() }).nullable(),
});

const blockQuoteOutput = z.object({
  quoteId: z.string().guid(),
  makerId: z.string(),
  takerId: z.string(),
  side: z.enum(['buy', 'sell']),
  asset: z.string(),
  fiatCurrency: z.string(),
  size: amountString,
  price: amountString,
  notional: amountString,
  createdAt: z.string(),
  expiresAt: z.string(),
  lifecycle: z.enum(['open', 'bound', 'expired']),
  acceptedAt: z.string().nullable(),
  fillPrice: amountString.nullable(),
  capacity: z.enum(['principal', 'matched_principal', 'agency']),
  firmness: z.literal('firm'),
  lastLook: z.literal(false),
  bookFill: z.literal(false),
  midInvented: z.literal(false),
});

/**
 * ONE PIECE OF EVIDENCE, ON THE WIRE.
 *
 * `item` is `z.unknown()` because it is whatever the party submitted and this
 * service has no business asserting a shape for a screenshot reference or a
 * bank narrative. What it does assert is the envelope: who, when, and in what
 * order — the part a moderator has to be able to trust.
 */
const evidenceOutput = z.object({
  seq: z.number().int(),
  submittedBy: z.string().nullable(),
  submittedAt: z.string().nullable(),
  item: z.unknown(),
});

/**
 * A DISPUTE, ON THE WIRE — the same shape for `.get` and `.list`.
 *
 * `evidence` was the missing field. It was accepted by `disputes.open`, stored
 * in `p2p_disputes.evidence`, carried on `DisputeRecord`, and then never
 * serialised by anything: write-only, so a moderator could not read what they
 * were ruling on. It is here on both reads now.
 */
const disputeOutput = z.object({
  id: z.string().guid(),
  tradeId: z.string().guid(),
  openedBy: z.string(),
  /**
   * How the dispute was opened. `timeout` means the fiat_sent clock filed it;
   * `openedBy` is then the party of interest (buyer), not a claim they pressed
   * "open dispute". Same honesty class as evidence going write-only.
   */
  openedVia: z.enum(['party', 'timeout']),
  reason: z.string(),
  /** Null only on disputes opened before chat threads were persisted. */
  chatThreadId: z.string().guid().nullable(),
  status: z.enum(['open', 'resolved']),
  moderatorId: z.string().nullable(),
  resolution: z.enum(['release', 'refund']).nullable(),
  /**
   * Moderator notes on the ruling. Accepted by `disputes.resolve`, stored, and
   * previously never serialised — the same write-only trap evidence had.
   * Reviewable afterwards is half of ADR D-S-08's "recorded and reviewable".
   */
  resolutionNotes: z.string().nullable(),
  deadlineAt: z.string(),
  openedAt: z.string(),
  resolvedAt: z.string().nullable(),
  evidence: z.array(evidenceOutput),
  /** True when the SLA has passed. The queue's whole reason to exist. */
  overdue: z.boolean(),
  escalatedAt: z.string().nullable(),
  escalations: z.number().int(),
  escalatedBy: z.string().nullable(),
  escalationReason: z.string().nullable(),
  fourEyes: z.boolean().nullable(),
  /** Null until a moderator has actually been served this row. */
  lastSeenByModeratorAt: z.string().nullable(),
});

const appealOutput = z.object({
  id: z.string().guid(),
  userId: z.string(),
  tradeId: z.string().guid(),
  reason: z.string(),
  status: z.enum(['submitted', 'accepted', 'rejected']),
  submittedAt: z.string(),
  reviewDueAt: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
});

const ownStatsOutput = z.object({
  ordersTotal: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  disputed: z.number().int().nonnegative(),
  completionRate: z.number().min(0).max(1).nullable(),
  cancelRate: z.number().min(0).max(1).nullable(),
  avgReleaseSecs: z.number().int().nonnegative().nullable(),
  avgPaySecs: z.number().int().nonnegative().nullable(),
  volume: z.array(
    z.object({
      asset: z.string(),
      fiatCurrency: z.string(),
      amount: amountString,
      fiatAmount: amountString,
    }),
  ),
});

const reputationOutput = z.object({
  tradesTotal: z.number().int(),
  completed: z.number().int(),
  cancelled: z.number().int(),
  disputed: z.number().int(),
  disputesLost: z.number().int(),
  completionRate: z.number(),
  avgReleaseSecs: z.number().int(),
  badges: z.array(z.string()),
  /** Null when identity has not published a public profile to this service. */
  handle: z.string().nullable(),
  /** ISO timestamp from identity. Null when that read is unwired or absent. */
  memberSince: z.string().nullable(),
  profile: z.object({
    status: z.enum(['unwired', 'found', 'absent']),
    code: z.enum(['p2p.public_profile_unwired', 'p2p.public_profile_found', 'p2p.public_profile_absent']),
  }),
  /** Released trades this person was a party to in the last 30 days. Counted here, not invented. */
  trades30d: z.number().int().nonnegative(),
  /** P-trade-orders-21: decimal-string percents ("95.24"); null when nothing is counted. Definition in `completionDefinition`. */
  completionRate30d: z
    .string()
    .regex(/^\d{1,3}\.\d{2}$/)
    .nullable(),
  completionRateTotal: z
    .string()
    .regex(/^\d{1,3}\.\d{2}$/)
    .nullable(),
  completionDefinition: z.object({ numerator: z.string(), denominator: z.string(), window30d: z.string(), noHistory: z.string() }),
  /** Buyer side: average seconds from escrow lock to "marked paid". Null with no sample, never 0-as-fast. */
  avgPaySecs: z.number().int().nonnegative().nullable(),
  /**
   * P-ads-merchant-21: visible good/bad counts about this person.
   * Null when nothing is visible. A hidden review is not a zero.
   */
  rating: z
    .object({
      good: z.number().int().nonnegative(),
      bad: z.number().int().nonnegative(),
    })
    .nullable(),
  /** Identity verification level only (no documents). Null when identity has not published it. */
  verification: z.object({ level: z.string().min(1) }).nullable(),
  /**
   * Merchant standing, as a counterparty may see it (TRK-p2p.merchants Stage 2).
   *
   * ONLY `true` for an APPROVED merchant. An application under review, a
   * suspension and a withdrawal all read `false` — the badge is a claim made to
   * a stranger about to send money, so "in progress" must never look like
   * "vouched for". `null` means the programme is not enabled in this
   * deployment, which is a different fact from "this trader is not a merchant".
   */
  merchant: z.boolean().nullable(),
});

type OfferOut = z.infer<typeof offerOutput>;
type TradeOut = z.infer<typeof tradeOutput>;

/**
 * Map a service error onto a tRPC code.
 *
 * `p2p.trade_terminal` is deliberately CONFLICT and not BAD_REQUEST: a second
 * release attempt is not a malformed request, it is a request that arrived
 * after the escrow already reached a terminal state, and a client retrying a
 * timed-out call needs to be able to tell those apart.
 */
export function toTrpcError(err: unknown): TRPCError {
  // Procedures throw TRPCError deliberately (L2-7 party filter on trades.get /
  // disputes.get → NOT_FOUND, not FORBIDDEN). `guard` funnels every throw
  // through this mapper; re-wrapping those would turn a clean NOT_FOUND into
  // INTERNAL_SERVER_ERROR and undo the IDOR shape the caller is meant to see.
  if (err instanceof TRPCError) return err;

  if (err instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }

  // Confirm the order again: nothing was reserved or locked. Unverifiable is the deployment's, not the person's.
  if (err instanceof TakeStepUpError) {
    const code = err.code === 'p2p.step_up_unverifiable' ? 'PRECONDITION_FAILED' : 'FORBIDDEN';
    return new TRPCError({ code, message: err.message, cause: err });
  }

  // P-ads-merchant-01: accept the terms (the form opens them), read the current version, or the owner has not published one.
  if (err instanceof AdvertiserTermsError) {
    const code =
      err.code === 'p2p.terms_not_accepted' ? 'FORBIDDEN' : err.code === 'p2p.terms_version_stale' ? 'CONFLICT' : 'PRECONDITION_FAILED';
    return new TRPCError({ code, message: err.message, cause: err });
  }

  if (err instanceof TakeGateError) {
    switch (err.code) {
      // The person can fix this themself: confirm the address.
      case 'p2p.contact_required':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      // The deployment, not the caller: no gate installed or an unreachable identity service.
      default:
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
    }
  }

  if (err instanceof InstrumentError) {
    switch (err.code) {
      case 'p2p.instrument_not_found':
        // EVERY refusal to disclose lands here, whatever the real reason.
        // "This exists but is not yours" tells a stranger that a trade with
        // that id exists and that its seller has an account on file, which is
        // the first half of the thing they were trying to learn.
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'p2p.instrument_slot_taken':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      // P-ads-merchant-18: no verified legal name to check against yet, or identity could not answer.
      case 'p2p.holder_name_unverified':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      case 'p2p.holder_name_unverifiable':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      case 'p2p.instrument_retention_unset':
      case 'p2p.instrument_list_limit_unset':
      case 'p2p.method_schema_list_limit_unset':
      case 'p2p.access_log_limit_unset':
      case 'p2p.purge_snapshots_limit_unset':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      case 'p2p.take_refused':
        // ONE code, ONE message, for every reason a take could not name a
        // payment destination. `BAD_REQUEST` and not `NOT_FOUND`, because the
        // caller genuinely can fix it — by taking with a method the offer can
        // complete — and because the response must be identical whichever of
        // the reasons applied. See `TAKE_REFUSED_MESSAGE`.
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
      default:
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
  }

  if (err instanceof TradeStateError) {
    return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
  }

  if (err instanceof PricingError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
  }

  if (err instanceof BlockRfqError) {
    switch (err.code) {
      case 'p2p.rfq_not_found':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'p2p.rfq_not_a_party':
      case 'p2p.rfq_self_trade':
      case 'p2p.trading_disabled':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      case 'p2p.rfq_expired':
      case 'p2p.rfq_already_bound':
      case 'p2p.rfq_terms_conflict':
      case 'p2p.rfq_last_look_forbidden':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      default:
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
  }

  if (err instanceof P2pError) {
    switch (err.code) {
      case 'p2p.offer_not_found':
      case 'p2p.quote_not_found':
      case 'p2p.trade_not_found':
      case 'p2p.dispute_not_found':
      case 'p2p.user_not_found':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'p2p.not_a_party':
      case 'p2p.not_the_seller':
      case 'p2p.not_the_buyer':
      case 'p2p.self_trade':
      case 'p2p.trading_disabled':
      case 'p2p.not_a_moderator':
      // P-ads-merchant-19: the buyer writes the payment note; only the seller reports a remark in it.
      case 'p2p.remark_not_payee':
      case 'p2p.blocked':
      case 'p2p.contact_self':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      // Not a client auth mistake — the deployment has no human who can rule.
      // PRECONDITION_FAILED so an operator dash can alarm on the code, not on
      // a generic FORBIDDEN that looks like a missing scope on the caller.
      case 'p2p.moderation_unreachable':
      // Identity did not name the other side just now: never a made-up handle, never an untyped failure.
      case 'p2p.public_profile_unavailable':
      case 'p2p.chat_thread_unset':
      // Instruments are jsonb at rest. Live offers stay refuse-closed until
      // OWNER KMS is wired. PRECONDITION_FAILED so an operator dash can alarm
      // on the code, not on a generic BAD_REQUEST that looks like a typo.
      case 'p2p.chat_attachment_unwired':
      case 'p2p.chat_list_limit_unset':
      case 'p2p.instrument_kms_required':
      case 'p2p.escrow_terms_unproven':
      case 'p2p.escrow_lock_uncertain':
      case 'p2p.fee_bps_unset':
      case 'p2p.offer_list_limit_unset':
      case 'p2p.dispute_list_limit_unset':
      case 'p2p.late_settlements_list_limit_unset':
      case 'p2p.trade_list_limit_unset':
      case 'p2p.config_unset':
      case 'p2p.content_rules_invalid':
      case 'p2p.posting_thresholds_invalid':
      case 'p2p.export_format_unbuilt':
      case 'p2p.ops_offers_limit_unset':
      case 'p2p.ops_trades_limit_unset':
      case 'p2p.ops_count_invalid':
      case 'p2p.dispute_resolve_no_four_eyes':
      case 'p2p.dispute_resolve_approval_mismatch':
      case 'p2p.sweep_settlements_limit_unset':
      case 'p2p.sweep_deadlines_limit_unset':
      case 'p2p.merchant_history_limit_unset':
      case 'p2p.escrow_deadline_unset':
      case 'p2p.instrument_retention_unset':
      case 'p2p.payment_deadline_unset':
      case 'p2p.release_deadline_unset':
      case 'p2p.dispute_sla_unset':
      case 'p2p.dispute_escalation_recheck_unset':
      case 'p2p.sweep_interval_unset':
      case 'p2p.verification_limits_unset':
      case 'p2p.verification_limits_invalid':
      case 'p2p.verification_level_unwired':
      case 'p2p.security_change_lock_unset':
      case 'p2p.invalid_security_change_lock':
      case 'p2p.security_change_lock_unwired':
      case 'p2p.review_list_limit_unset':
      // No bank rail is wired, or it does not validate this method: nothing was checked and nothing moved.
      case 'rail.bank':
      case 'p2p.method_not_rail_validated':
      // P-trade-orders-19: the seller's cancellation request waits for the founders' decision.
      case 'p2p.owner_decision_pending':
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      case 'p2p.merchant_not_found':
      // P-ads-merchant-07: a private ad without a link to it reads as not there to everyone but its maker.
      case 'p2p.offer_private':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      // The caller can fix these: earn the record, or supply a reason. Not a
      // permission problem, so not FORBIDDEN — that would send an applicant
      // looking for a scope they already have.
      case 'p2p.merchant_ineligible':
      case 'p2p.merchant_reason_required':
      case 'p2p.quote_mismatch':
      // P-ads-merchant-05: the person changes the terms and posts again.
      case 'p2p.content_rule_violation':
      // P-ads-merchant-12: the person meets the fiat's posting thresholds, which the checklist shows.
      case 'p2p.posting_threshold_not_met':
      // P-ads-merchant-08: a presence schedule that is not a valid week; a bulk action naming no ads or too many.
      case 'p2p.schedule_invalid':
      case 'p2p.bulk_scope_invalid':
      // P-trade-orders-19: a cancel reason from the other side's list.
      case 'p2p.cancel_reason_invalid':
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
      // State, not permission and not a typo: the row is real and the move is
      // wrong for where it currently stands.
      case 'p2p.merchant_exists':
      case 'p2p.merchant_transition_invalid':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      case 'p2p.cancel_after_paid':
      case 'p2p.dispute_already_open':
      case 'p2p.dispute_already_resolved':
      case 'p2p.dispute_resolve_approval_consumed':
      case 'p2p.trade_exists':
      // The quote's window passed, or its price or fee moved: ask for a new quote.
      case 'p2p.quote_expired':
      case 'p2p.quote_changed':
      // Too many ongoing orders: one has to finish first. The error data lists them and the soonest deadline.
      case 'p2p.active_order_cap':
      // Buying is paused after too many cancelled orders; the error data says until when.
      case 'p2p.buying_restricted':
      // P-ads-merchant-06: an ad with open orders closes once they finish (the error data counts them).
      case 'p2p.offer_has_open_trades':
      // P-ads-merchant-08: the ad's maker is away; it takes orders again in their hours (the error data says when).
      case 'p2p.maker_offline':
      // P-ads-merchant-07: a share link that ended or was withdrawn; the person asks the maker for a new one.
      case 'p2p.share_link_expired':
      case 'p2p.share_link_revoked':
      // A reminder before the wait has passed (the error data says when it may go), or past the owner's count.
      case 'p2p.remind_too_early':
      case 'p2p.remind_rate_limited':
      // One amount report per order: more goes to the dispute.
      case 'p2p.mismatch_report_exists':
      // The bank rail's payment does not match the order: an exception row waits for a person; nothing was released.
      case 'p2p.rail_mismatch':
      // Selling into a buy ad from a balance that falls short: nothing was held; the error data says by how much.
      case 'p2p.insufficient_balance':
      // A sell ad whose maker holds less than it offers: the order was voided and nothing is held.
      case 'p2p.offer_unfunded':
      case 'p2p.idempotency_conflict':
      case 'p2p.idempotency_in_progress':
      case 'p2p.erase_blocked':
      // CONFLICT and not INTERNAL_SERVER_ERROR: nothing failed. The erase ran
      // out of a database it could honestly report on, wrote nothing, and the
      // caller can simply ask again — which is what a conflict is.
      case 'p2p.erase_raced':
      case 'p2p.appeal_used':
      case 'p2p.review_exists':
      // P-ads-merchant-18: the method is the last payable one of an active sell ad; the person confirms pausing them.
      case 'p2p.method_in_use':
      // P-ads-merchant-19: one remark report per party per order; more goes to the dispute.
      case 'p2p.remark_case_exists':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      case 'p2p.receipt_quota_reached':
      // P-ads-merchant-06: the daily edit cap; the error data says when editing opens again.
      case 'p2p.edit_quota_reached':
        return new TRPCError({ code: 'TOO_MANY_REQUESTS', message: err.message, cause: err });
      case 'p2p.offer_not_active':
      case 'p2p.offer_update_empty':
      case 'p2p.offer_cursor_invalid':
      case 'p2p.reason_required':
      case 'p2p.appeal_not_eligible':
      case 'p2p.cursor_invalid':
      case 'p2p.filter_invalid':
      case 'p2p.export_range_too_large':
      case 'p2p.export_too_many_rows':
      case 'p2p.receipt_not_available':
      case 'p2p.ops_cursor_invalid':
      case 'p2p.chat_text_required':
      case 'p2p.remark_invalid':
      case 'p2p.export_range_invalid':
      case 'p2p.offer_method_unsupported':
      case 'p2p.verification_limit_currency':
      case 'p2p.verification_order_min':
      case 'p2p.verification_order_max':
      case 'p2p.verification_daily_limit':
      case 'p2p.verification_lifetime_limit':
      case 'p2p.pair_limit_exceeded':
      // The ad lists a method the operator retired: choose another method or ad.
      case 'p2p.method_delisted':
      // P-disputes-security-09: a non-instant method without the sell ad's consent, and a dispute before the
      // settlement window ends.
      case 'p2p.non_instant_not_accepted':
      case 'p2p.dispute_before_settlement':
      // P-ads-merchant-19: cash in person has a locked price; post the ad at a fixed price.
      case 'p2p.floating_not_allowed_for_method':
      case 'p2p.offer_limit_exceeded':
      case 'p2p.invalid_fee_bps':
      case 'p2p.invalid_escrow_deadline':
      case 'p2p.invalid_instrument_retention':
      case 'p2p.invalid_payment_deadline':
      case 'p2p.invalid_release_deadline':
      case 'p2p.invalid_dispute_sla':
      case 'p2p.invalid_dispute_escalation_recheck':
      case 'p2p.invalid_sweep_interval':
      case 'p2p.release_unpostable':
      case 'p2p.dispute_evidence_rejected':
      // The caller can fix it — by being a person. Reachable only from a
      // principal whose user id is not a canonical UUID, which is a wiring
      // fault or a machine wearing a moderator's session.
      case 'p2p.review_not_eligible':
      case 'p2p.explanation_required':
      case 'p2p.ruling_not_attributed':
        // `offer_method_unsupported` is no longer reachable from `trades.take`
        // — that refusal goes through `refuseTake` so it is indistinguishable
        // from "the seller holds no destination". The case stays mapped rather
        // than deleted so a future caller that raises it does not fall through
        // to INTERNAL_SERVER_ERROR.
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
      case 'p2p.escrow_missing':
        // Not a client error: the caller asked for something reasonable and the
        // trade was not in a state that could honour it.
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      case 'p2p.trade_moved':
        // Same shape as the terminal case: the request was fine, the trade
        // changed underneath it. A client that retries will be answered by
        // whatever the trade's new state allows.
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
  }

  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Request failed', cause: err });
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toTrpcError(err);
  }
}

/**
 * A method's field requirements, as the "add a payment method" screen needs
 * them. About METHODS, never about people — the one instrument-adjacent surface
 * a browsing user may read.
 */
const fieldSpecOutput = z.object({
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
  pattern: z.string().optional(),
  minLength: z.number().int().optional(),
  maxLength: z.number().int().optional(),
  /** A hint for the input control. Not an access-control decision. */
  sensitive: z.boolean().optional(),
  help: z.string().optional(),
  /** P-ads-merchant-18: the account holder's name, checked against the person's verified legal name. */
  holderName: z.boolean().optional(),
});

const noteRulesInput = z.object({
  guidance: z.string().min(1).max(NOTE_GUIDANCE_MAX),
  forbidden: z.array(z.string().min(1).max(NOTE_FORBIDDEN_WORD_MAX)).max(NOTE_FORBIDDEN_MAX_WORDS).readonly(),
});
const cashRulesInput = z.object({
  meetingGuidance: z.string().min(1).max(CASH_TEXT_MAX),
  proof: z.string().min(1).max(CASH_TEXT_MAX),
  releaseWindowSeconds: z.number().int().min(CASH_RELEASE_MIN_SECONDS).max(CASH_RELEASE_MAX_SECONDS),
});

const remarkCaseOutput = z.object({
  id: z.string(),
  tradeId: z.string(),
  reporterId: z.string(),
  reportedId: z.string(),
  reporterRole: z.enum(['buyer', 'seller']),
  remark: z.string(),
  status: z.literal('open'),
  openedAt: z.string(),
});

function toRemarkCaseOut(report: RemarkCase): z.infer<typeof remarkCaseOutput> {
  return { ...report, openedAt: report.openedAt.toISOString() };
}

const methodSchemaOutput = z.object({
  methodId: z.string(),
  country: z.string(),
  label: z.string(),
  fields: z.array(fieldSpecOutput),
  enabled: z.boolean(),
  settlement: settlementOutput,
  /** P-ads-merchant-19: cash in person when the row carries cash rules; the rules themselves, or null. */
  kind: z.enum(['transfer', 'cash_in_person']),
  // Unbounded on the way out: the bounds judge what an operator registers, never a stored row on a read.
  noteRules: z.object({ guidance: z.string(), forbidden: z.array(z.string()).readonly() }).nullable(),
  cashRules: z.object({ meetingGuidance: z.string(), proof: z.string(), releaseWindowSeconds: z.number() }).nullable(),
});

/**
 * AN INSTRUMENT WITHOUT ITS VALUES. The only shape any list returns.
 *
 * There is deliberately no masked hint, no last-four, no partial anything. A
 * mask is still the data, it rides a path that is not access-logged, and it is
 * one helpful refactor away from being the whole value. The owner tells two
 * destinations apart by the label they chose.
 *
 * `fingerprint` is deliberately absent too: it is a hash of the account
 * details, and a hash handed to a caller is an oracle against which a guessed
 * account number can be checked. It stays server-side, where the audit trail
 * needs it and nobody can query it.
 */
const instrumentHeaderOutput = z.object({
  id: z.string().guid(),
  methodId: z.string(),
  country: z.string(),
  fiatCurrency: z.string(),
  label: z.string(),
  status: z.enum(['active', 'removed']),
  createdAt: z.string(),
  updatedAt: z.string(),
  removedAt: z.string().nullable(),
});

/** The values. Only ever produced by a call that wrote an access-log row. */
const instrumentDetailsOutput = z.record(z.string(), z.string());

const merchantOutput = z.object({
  userId: z.string(),
  status: z.enum(['applied', 'approved', 'rejected', 'suspended', 'withdrawn']),
  /** Reputation as it stood at application — stored, so a decision stays explicable. */
  appliedCompletionRate: z.number(),
  appliedTradesTotal: z.number().int(),
  appliedAt: z.string(),
  decidedAt: z.string().nullable(),
});

const merchantEventOutput = z.object({
  seq: z.string(),
  fromStatus: z.string(),
  toStatus: z.string(),
  reason: z.string(),
  actorId: z.string(),
  actorScope: z.string(),
  createdAt: z.string(),
});

const reviewOutput = z.object({
  id: z.string().guid(),
  tradeId: z.string().guid().nullable(),
  authorId: z.string().nullable(),
  subjectId: z.string(),
  rating: z.enum(['good', 'bad']),
  comment: z.string(),
  explanation: z.string().nullable(),
  reply: z.string().nullable(),
  repliedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hidden: z.boolean(),
  hiddenReason: z.string().nullable(),
});

/** One review on the wire. A viewer who is neither its author nor its subject gets no trade id, author or hide reason. */
function toReviewOut(row: ReviewRecord, viewerId?: string): z.infer<typeof reviewOutput> {
  const party = viewerId === undefined || viewerId === row.authorId || viewerId === row.subjectId;
  return {
    id: row.id,
    tradeId: party ? row.tradeId : null,
    authorId: party ? row.authorId : null,
    subjectId: row.subjectId,
    rating: row.rating,
    comment: row.comment,
    explanation: row.explanation,
    reply: row.reply,
    repliedAt: row.repliedAt ? row.repliedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hidden: row.hidden,
    hiddenReason: party ? row.hiddenReason : null,
  };
}

export function createP2pRouter(
  p2p: P2pService,
  instruments: InstrumentService,
  erasure?: P2pErasure,
  options: P2pRouterOptions = {},
  merchants?: MerchantService,
) {
  const moderatorUserIds = options.moderatorUserIds ?? [];
  const offerLimits = options.offerLimits ?? NO_OFFER_LIMITS;
  const blockRfq = options.blockRfq;
  const publicProfile = options.publicProfile;
  const chatNotify = options.chatNotify;
  const approvals = options.approvals ?? unwiredApprovalConsumer();
  const opsReads = options.opsReads;
  const disputeResolveRequiresApproval = options.disputeResolveRequiresApproval === true;
  const takeGate = options.takeGate ?? unwiredTakeGate();
  const takeStepUp = options.takeStepUp ?? unwiredTakeStepUp();
  const releaseStepUp = options.releaseStepUp ?? unwiredReleaseStepUp();
  const instrumentStepUp = options.instrumentStepUp ?? unwiredInstrumentStepUp();
  const stepUpCaller = (principal: Principal): TakeStepUpCaller => ({
    userId: principal.userId,
    sessionId: principal.sid,
    viaApiKey: principal.kid !== undefined,
  });

  const requireOpsReads = (): OpsReads => {
    if (!opsReads) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'p2p.ops_reads_unwired' });
    }
    return opsReads;
  };

  const mapDisputeApprovalError = (err: unknown): never => {
    if (err instanceof P2pError) throw err;
    if (err instanceof ActionApprovalConsumeError) {
      const message = err.message.toLowerCase();
      if (message.includes('already consumed') || message.includes('action_approval.consumed')) {
        throw new P2pError(`p2p.dispute_resolve_approval_consumed — ${err.message}`, 'p2p.dispute_resolve_approval_consumed');
      }
      if (message.includes('payload') || message.includes('target_mismatch') || message.includes('not p2p.dispute_resolve')) {
        throw new P2pError(`p2p.dispute_resolve_approval_mismatch — ${err.message}`, 'p2p.dispute_resolve_approval_mismatch');
      }
      throw new P2pError(`p2p.dispute_resolve_no_four_eyes — ${err.message}`, 'p2p.dispute_resolve_no_four_eyes');
    }
    throw err;
  };

  const consumeOperatorApproval = async (
    cmd: { readonly approvalId?: string | null; readonly operationId?: string | null },
    actionType: string,
    fields: Record<string, string>,
  ): Promise<string> => {
    const ids = readApprovalIds(cmd);
    const consumed = await approvals.consume({
      approvalId: ids.approvalId,
      operationId: ids.operationId,
      payloadHash: p2pActionPayloadHash(actionType, fields),
      targetService: 'svc-p2p',
      targetId: actionType,
      expectedVersion: '1',
    });
    if (!consumed.approverId?.trim() || consumed.approverId.trim().toLowerCase() === consumed.requesterId.trim().toLowerCase()) {
      throw new ActionApprovalConsumeError(
        'consumed approval has no distinct approver; the requester does not confirm the mutate',
        'action_approval.consume_failed',
      );
    }
    return consumed.approverId.trim();
  };

  const requireBlockRfq = (): BlockRfqService => {
    if (!blockRfq) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'P2P block/RFQ is not wired in this deployment.',
      });
    }
    return blockRfq;
  };

  /**
   * The programme, or an honest refusal.
   *
   * Not wired is not the same as empty. A deployment without the merchant
   * service returns PRECONDITION_FAILED — an operator dashboard can alarm on
   * that, where an empty list would look like "nobody has applied yet".
   */
  const requireMerchants = (): MerchantService => {
    if (!merchants) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'The P2P merchant programme is not enabled in this deployment.',
      });
    }
    return merchants;
  };

  /** The caller's own id, from the verified principal. Never from an input. */
  const presentOffers = async (offers: ReadonlyArray<Awaited<ReturnType<P2pService['getOffer']>>>): Promise<OfferOut[]> => {
    const [counts, settlements] = await Promise.all([p2p.releasedTradeCounts(offers.map((o) => o.id)), boardSettlements(offers)]);
    return offers.map((offer) => toOfferOut(offer, counts.get(offer.id) ?? 0, settlements));
  };
  const presentOffer = async (offer: Awaited<ReturnType<P2pService['getOffer']>>): Promise<OfferOut> => (await presentOffers([offer]))[0]!;

  /** One catalogue read per page for every listed method's settlement profile. */
  const boardSettlements = async (offers: ReadonlyArray<{ methods: readonly unknown[] }>) =>
    instruments.boardSettlements(
      offers.flatMap((offer) => offer.methods.map(methodIdFromOfferEntry).filter((id): id is string => id !== null)),
    );

  const presentBoard = async (
    viewerId: string,
    input:
      | {
          asset?: string;
          fiatCurrency?: string;
          side?: 'buy' | 'sell';
          limit?: number;
          methodId?: string;
          makerId?: string;
          minFiat?: string;
          fiatAmount?: string;
          sort?: BoardSort;
          cursor?: string | null;
        }
      | undefined,
    includeCursor: boolean,
  ) => {
    const page = await p2p.listOfferBoard({
      ...(input?.asset ? { asset: input.asset } : {}),
      ...(input?.fiatCurrency ? { fiatCurrency: input.fiatCurrency } : {}),
      ...(input?.side ? { side: input.side } : {}),
      ...(input?.methodId ? { methodId: input.methodId } : {}),
      ...(input?.makerId ? { makerId: input.makerId } : {}),
      ...(input?.minFiat ? { minFiat: input.minFiat } : {}),
      ...(input?.fiatAmount ? { fiatAmount: input.fiatAmount } : {}),
      ...(input?.sort ? { sort: input.sort } : {}),
      ...(includeCursor && input?.cursor ? { cursor: input.cursor } : {}),
      limit: input?.limit,
      viewerId,
    });
    const [counts, settlements] = await Promise.all([
      p2p.releasedTradeCounts(page.offers.map((offer) => offer.id)),
      boardSettlements(page.offers),
    ]);
    // One reference read per floating pair on the page, never per row.
    const references = new Map<string, Promise<string | null>>();
    const referenceFor = (asset: string, fiat: string) => {
      const key = `${asset}/${fiat}`;
      if (!references.has(key)) {
        references.set(
          key,
          p2p
            .referencePrice(asset, fiat)
            .then((price) => (price === null ? null : formatAmount(price)))
            // A feed that fails prices nothing: the floating ad says so, and the rest of the board still reads.
            .catch(() => null),
        );
      }
      return references.get(key)!;
    };
    return {
      offers: await Promise.all(
        page.offers.map(async (offer) => ({
          ...toOfferOut(offer, counts.get(offer.id) ?? 0, settlements),
          ...(offer.priceType === 'float' ? { referencePrice: await referenceFor(offer.asset, offer.fiatCurrency) } : {}),
        })),
      ),
      nextCursor: page.nextCursor,
    };
  };

  const requireUser = (ctx: { principal?: { userId?: string } | null }): string => {
    const userId = ctx.principal?.userId;
    if (!userId) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'This action is about your own account, so it needs one.' });
    return userId;
  };

  const toMerchantOut = (r: MerchantRecord) => ({
    userId: r.userId,
    status: r.status,
    appliedCompletionRate: r.appliedCompletionRate,
    appliedTradesTotal: r.appliedTradesTotal,
    appliedAt: r.appliedAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
  });
  const moderationPublic = moderationOnPublicDoor(isModerationConfigured(moderatorUserIds));
  const offerLimitsConfigured = limitsConfigured(offerLimits);
  const offerLimitsPostureValue = offerLimitsPosture(offerLimits);

  /**
   * Programme-gated P2P API procedure.
   *
   * `kid` comes from identity's verified API-key exchange. We do not mint,
   * store, revoke or rate-limit keys here: identity owns credentials and the
   * edge owns request throttling. This service owns the product entitlement.
   *
   * Standing is read on every key request, so an operator suspension removes
   * access immediately rather than waiting for a token to expire. Interactive
   * sessions remain ordinary P2P users and are not made merchant-only.
   */
  const merchantApiProcedure = (scope: 'p2p:read' | 'p2p:write') =>
    scopedProcedure(scope, { module: 'p2p' }).use(async ({ ctx, next }) => {
      if (!ctx.principal.kid) return next({ ctx });

      const record = await requireMerchants().get(ctx.principal.userId);
      if (!record || !isActiveMerchant(record.status)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'P2P API-key access requires current approved merchant standing. Use an interactive session to review or apply.',
        });
      }
      return next({ ctx });
    });

  const offerLimitsOutput = z.object({
    /** Largest ordinary maxAmt, or null when no numeric cap. Decimal string. */
    standardMax: z.string().nullable(),
    /** Largest approved-merchant maxAmt, or null when no numeric cap. Decimal string. */
    merchantMax: z.string().nullable(),
    /** True when at least one band is a number. */
    configured: z.boolean(),
    /** unset = env absent; unlimited = owner confirmed; configured = at least one number. */
    posture: z.enum(['unset', 'unlimited', 'configured']),
    standardMode: z.enum(['unset', 'unlimited', 'capped']),
    merchantMode: z.enum(['unset', 'unlimited', 'capped']),
    /** Same sentence the boot log prints — operator-readable posture. */
    summary: z.string(),
  });

  const myOfferCeilingOutput = z.object({
    /** Ceiling that binds this caller right now, or null when no numeric cap. */
    maxAmount: z.string().nullable(),
    /** Which policy slot applied — applicant/suspended stay on standard. */
    band: z.enum(['standard', 'merchant']),
    /** unset vs owner-confirmed unlimited vs capped for the binding band. */
    limitMode: z.enum(['unset', 'unlimited', 'capped']),
    merchantStatus: z.enum(['applied', 'approved', 'rejected', 'suspended', 'withdrawn']).nullable(),
  });

  const merchantApiAccessOutput = z.object({
    /** Derived from current standing; never a second stored entitlement. */
    eligible: z.boolean(),
    credential: z.enum(['session', 'api_key']),
    merchantStatus: z.enum(['applied', 'approved', 'rejected', 'suspended', 'withdrawn']).nullable(),
    /** Existing shared planes consumed by this service, not rebuilt here. */
    keyPlane: z.literal('identity'),
    rateLimitPlane: z.literal('edge'),
    /** D-S-08: no key, bot or timer may decide a disputed escrow. */
    disputeResolution: z.literal('interactive_human_only'),
  });

  /**
   * The owner's own instruments, mapped for the wire.
   *
   * A named function rather than an inline object literal at each call site,
   * because "which fields does a list return" is exactly the decision that
   * decays when it is written out four times.
   */
  const toHeaderOut = (i: Awaited<ReturnType<InstrumentService['createInstrument']>>) => ({
    id: i.id,
    methodId: i.methodId,
    country: i.country,
    fiatCurrency: i.fiatCurrency,
    label: i.label,
    status: i.status,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    removedAt: i.removedAt?.toISOString() ?? null,
  });

  return router({
    health: publicProcedure
      .output(
        z.object({
          ok: z.boolean(),
          service: z.literal('svc-p2p'),
          /** True when `P2P_MODERATOR_USER_IDS` names at least one person. Config, not a live probe. */
          moderationConfigured: z.boolean(),
          /** Absent or configured+unprobed. Never `reachable` from env. */
          moderation: moderationHonestySchema,
          /**
           * False until `P2P_OFFER_MAX_STANDARD` / `P2P_OFFER_MAX_MERCHANT` arms
           * a ceiling. Same honesty pattern as moderationConfigured: clients must
           * not imply the merchant badge buys a higher limit when none is set.
           */
          offerLimitsConfigured: z.boolean(),
          /** Public three-way posture so probes never need a scoped refuse-first read. */
          offerLimitsPosture: z.enum(['unset', 'unlimited', 'configured']),
          /**
           * Always false until OWNER KMS envelope encryption is wired.
           * A boolean env that unblocked plaintext would be the appearance of
           * protection without the substance.
           */
          instrumentKmsConfigured: z.literal(false),
          /** `local-test` is a test seal, not a configured KMS. */
          instrumentKeyProvider: z.enum(['none', 'local-test']),
        }),
      )
      .query(() => ({
        ok: true,
        service: 'svc-p2p' as const,
        ...moderationPublic,
        offerLimitsConfigured,
        offerLimitsPosture: offerLimitsPostureValue,
        ...instrumentKeyHealth(options.instrumentKeyProvider),
      })),

    /**
     * §6.2: "100+ fiat currencies = config, not code."
     *
     * Served straight out of `packages/config` — svc-p2p has no currency table
     * and adding a currency touches no service.
     */
    fiat: router({
      list: publicProcedure
        .output(z.array(z.object({ code: z.string(), name: z.string(), symbol: z.string(), minorUnits: z.number().int() })))
        .query(() => enabledFiat().map((f) => ({ code: f.code, name: f.name, symbol: f.symbol, minorUnits: f.minorUnits }))),
    }),

    /**
     * P-trade-orders-22, read only: the published house fee. Charged once, when an order is released, off the released
     * amount; an order keeps the rate it was taken under. Signed-out callers can read it, as the fee page does.
     */
    fees: router({
      schedule: publicProcedure
        .output(z.object({ feeBps: z.number().int().nonnegative(), chargedOn: z.literal('release'), basis: z.literal('released_amount') }))
        .query(() => guard(async () => ({ ...p2p.publishedFee(), chargedOn: 'release' as const, basis: 'released_amount' as const }))),
    }),

    offers: router({
      create: merchantApiProcedure('p2p:write')
        .input(
          z
            .object({
              side: z.enum(['buy', 'sell']),
              asset: z.string().min(1).max(16),
              fiatCurrency: z.string().length(3),
              priceType: z.enum(['fixed', 'float']),
              price: amountString,
              minAmount: amountString,
              maxAmount: amountString,
              totalAmount: amountString.optional(),
              /**
               * REQUIRED, and `min(1)`. An offer with no declared methods
               * accepts anything, so the only thing that can refuse a take on it
               * is the seller's instrument set — a clean per-method probe of the
               * maker. The service refuses it too; this is the message a client
               * can act on rather than a 400 from deeper down.
               *
               * Each entry is a method id (string) or `{ id }` — not `{}` / null /
               * numbers. `methodAllowed` only matches those shapes; junk would
               * board an offer that can never be taken.
               */
              methods: z.array(z.union([z.string().min(1).max(64), z.object({ id: z.string().min(1).max(64) })])).min(1),
              terms: z.string().max(4000).optional(),
              /**
               * P-disputes-security-09: the seller accepts methods whose money arrives within a settlement window. A sell
               * ad listing one without it refuses `p2p.non_instant_not_accepted`.
               */
              acceptsNonInstant: z.boolean().optional(),
              /** Client-chosen id. A retry with the same id must not publish a second offer. */
              offerId: z.string().guid().optional(),
              /** Client-chosen key. Required together with offerId: at least one. */
              idempotencyKey: z.string().min(8).max(128).optional(),
              /**
               * P-ads-merchant-01: the advertiser terms version the form showed. Optional for a merchant key, which
               * posts under the terms its person accepted; when sent, it must be the published version.
               */
              advertiserTermsVersion: z.string().min(1).max(64).optional(),
            })
            .refine((value) => value.offerId !== undefined || value.idempotencyKey !== undefined, {
              message: 'p2p.idempotency_key_required',
              path: ['idempotencyKey'],
            }),
        )
        .output(offerOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            if (options.instrumentKeyProvider !== 'local-test') refuseLiveOffersUntilOwnerKms();
            return presentOffer(
              await p2p.createOffer({
                makerId: ctx.principal.userId,
                side: input.side,
                asset: input.asset,
                fiatCurrency: input.fiatCurrency,
                priceType: input.priceType,
                price: parseAmount(input.price),
                minAmt: parseAmount(input.minAmount),
                maxAmt: parseAmount(input.maxAmount),
                ...(input.totalAmount === undefined ? {} : { totalAmt: parseAmount(input.totalAmount) }),
                methods: input.methods,
                ...(input.terms === undefined ? {} : { terms: input.terms }),
                ...(input.offerId === undefined ? {} : { offerId: input.offerId }),
                ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
                makerTier: ctx.principal.tier,
                ...(input.acceptsNonInstant === undefined ? {} : { acceptsNonInstant: input.acceptsNonInstant }),
                ...(input.advertiserTermsVersion === undefined ? {} : { advertiserTermsVersion: input.advertiserTermsVersion }),
              }),
            );
          }),
        ),

      /**
       * P-ads-merchant-01: the caller's own free balance of a coin, which a new sell ad's total may not exceed. The
       * same ledger read the post check makes. Nothing is reserved at post.
       */
      sellBalance: merchantApiProcedure('p2p:read')
        .input(z.object({ asset: z.string().min(1).max(16) }))
        .output(z.object({ asset: z.string(), available: z.string() }))
        .query(async ({ ctx, input }) =>
          guard(async () => {
            // A wallet balance is the person's to read: an API key's P2P scope covers ads and orders, not balances.
            if (ctx.principal.kid) throw new TRPCError({ code: 'FORBIDDEN', message: 'Your free balance is read signed in only.' });
            return { asset: input.asset, available: formatAmount(await p2p.sellBalance(requireUser(ctx), input.asset)) };
          }),
        ),

      list: merchantApiProcedure('p2p:read')
        .input(z.object(offerListShape).optional())
        .output(z.array(offerOutput))
        .query(async ({ ctx, input }) => guard(async () => (await presentBoard(ctx.principal.userId, input, false)).offers)),

      /** Cursor page: the customer board reads this, filtered and sorted here, and continues with `nextCursor`. */
      page: merchantApiProcedure('p2p:read')
        .input(z.object({ ...offerListShape, cursor: z.string().max(500).nullable().optional() }).optional())
        .output(z.object({ offers: z.array(offerOutput), nextCursor: z.string().nullable() }))
        .query(async ({ ctx, input }) => guard(async () => presentBoard(ctx.principal.userId, input, true))),

      get: merchantApiProcedure('p2p:read')
        .input(z.object({ offerId: z.string().guid(), shareToken: shareTokenInput.optional() }))
        .output(offerOutput)
        .query(async ({ ctx, input }) =>
          guard(async () => presentOffer(await p2p.getOffer(input.offerId, ctx.principal.userId, input.shareToken))),
        ),

      /** P-ads-merchant-18: the caller's own ads in one status, newest first; the board lists active ads only. */
      mine: merchantApiProcedure('p2p:read')
        .input(z.object({ status: z.enum(['active', 'paused', 'closed']), limit: z.number().int().min(1).max(200).optional() }))
        .output(z.array(offerOutput))
        .query(async ({ ctx, input }) =>
          guard(async () => {
            return presentOffers(await p2p.listOwnOffers(ctx.principal.userId, input.status, input.limit));
          }),
        ),

      /**
       * P-ads-merchant-06: the caller's ad edits today against the owner's daily cap, and when the count starts again.
       * Blank cap refuses `p2p.config_unset`.
       */
      editQuota: merchantApiProcedure('p2p:read')
        .output(
          z.object({
            limit: z.number().int().positive(),
            used: z.number().int().nonnegative(),
            remaining: z.number().int().nonnegative(),
            resetsAt: z.string().datetime(),
          }),
        )
        .query(async ({ ctx }) =>
          guard(async () => {
            const quota = await p2p.offerEditQuota(ctx.principal.userId);
            return { ...quota, resetsAt: quota.resetsAt.toISOString() };
          }),
        ),

      /**
       * P-ads-merchant-06: post a closed ad again, as a new ad that names it, through every check `create` makes. One
       * relist per closed ad; asking again returns the same new ad.
       */
      relist: merchantApiProcedure('p2p:write')
        .input(z.object({ offerId: z.string().guid() }))
        .output(offerOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            if (options.instrumentKeyProvider !== 'local-test') refuseLiveOffersUntilOwnerKms();
            return presentOffer(
              await p2p.relistOffer({
                offerId: input.offerId,
                makerId: ctx.principal.userId,
                makerTier: ctx.principal.tier,
              }),
            );
          }),
        ),

      /**
       * P-ads-merchant-08: pause, resume or remove (close) several of the caller's ads at once: named ads, or `all` that
       * the action applies to. Each ad answers for itself (`ok`, its status, or the code that refused it, such as
       * `p2p.offer_closed`). The key is answered once: a repeat returns the same results and changes nothing.
       */
      bulk: merchantApiProcedure('p2p:write')
        .input(
          z
            .object({
              action: z.enum(BULK_ACTIONS),
              offerIds: z.array(z.string().guid()).min(1).max(MAX_BULK_OFFERS).optional(),
              all: z.literal(true).optional(),
              idempotencyKey: z.string().min(8).max(200),
            })
            .refine((v) => (v.all === true) !== (v.offerIds !== undefined), { message: 'Name ads, or all, not both' }),
        )
        .output(
          z.object({
            action: z.enum(BULK_ACTIONS),
            replayed: z.boolean(),
            more: z.boolean(),
            results: z.array(
              z.object({
                offerId: z.string(),
                ok: z.boolean(),
                status: z.enum(['active', 'paused', 'closed']).nullable(),
                code: z.string().nullable(),
              }),
            ),
          }),
        )
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            p2p.bulkOffers({
              makerId: ctx.principal.userId,
              action: input.action,
              ...(input.offerIds ? { offerIds: input.offerIds } : {}),
              ...(input.all ? { all: true } : {}),
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),

      /** P-ads-merchant-07: public (on the board) or private (by share link only). Open orders are unaffected. */
      setVisibility: merchantApiProcedure('p2p:write')
        .input(z.object({ offerId: z.string().guid(), visibility: z.enum(['public', 'private']) }))
        .output(offerOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => presentOffer(await p2p.setOfferVisibility(input.offerId, ctx.principal.userId, input.visibility))),
        ),

      /**
       * P-ads-merchant-07: links to the caller's own ad. `create` returns the token once (only its hash is kept), living
       * `seconds` or the owner's longest (`P2P_SHARE_LINK_MAX_SECONDS`, blank refuses); `list` never returns tokens;
       * `revoke` ends a link at once.
       */
      shareLinks: router({
        create: merchantApiProcedure('p2p:write')
          .input(
            z.object({
              linkId: z.string().guid(),
              offerId: z.string().guid(),
              seconds: z.number().int().min(1).max(31_536_000).optional(),
            }),
          )
          .output(shareLinkOutput.extend({ token: shareTokenInput }))
          .mutation(async ({ ctx, input }) =>
            guard(async () =>
              toShareLinkOut(
                await p2p.createShareLink({
                  linkId: input.linkId,
                  offerId: input.offerId,
                  makerId: ctx.principal.userId,
                  ...(input.seconds === undefined ? {} : { seconds: input.seconds }),
                }),
              ),
            ),
          ),
        list: merchantApiProcedure('p2p:read')
          .input(z.object({ offerId: z.string().guid() }))
          .output(z.array(shareLinkOutput))
          .query(async ({ ctx, input }) =>
            guard(async () => (await p2p.listShareLinks(input.offerId, ctx.principal.userId)).map(toShareLinkOut)),
          ),
        revoke: merchantApiProcedure('p2p:write')
          .input(z.object({ linkId: z.string().guid() }))
          .output(shareLinkOutput)
          .mutation(async ({ ctx, input }) =>
            guard(async () => toShareLinkOut(await p2p.revokeShareLink(input.linkId, ctx.principal.userId))),
          ),
      }),

      close: merchantApiProcedure('p2p:write')
        .input(z.object({ offerId: z.string().guid() }))
        .output(offerOutput)
        .mutation(async ({ ctx, input }) => guard(async () => presentOffer(await p2p.closeOffer(input.offerId, ctx.principal.userId)))),

      pause: merchantApiProcedure('p2p:write')
        .input(z.object({ offerId: z.string().guid() }))
        .output(offerOutput)
        .mutation(async ({ ctx, input }) => guard(async () => presentOffer(await p2p.pauseOffer(input.offerId, ctx.principal.userId)))),

      resume: merchantApiProcedure('p2p:write')
        .input(z.object({ offerId: z.string().guid() }))
        .output(offerOutput)
        .mutation(async ({ ctx, input }) => guard(async () => presentOffer(await p2p.resumeOffer(input.offerId, ctx.principal.userId)))),

      /**
       * Edit a live offer. Open trades keep the price, size, method, fee and
       * terms text copied onto the trade at take (`terms_snapshot`).
       */
      update: merchantApiProcedure('p2p:write')
        .input(
          z
            .object({
              offerId: z.string().guid(),
              idempotencyKey: z.string().min(8).max(128),
              price: amountString.optional(),
              minAmount: amountString.optional(),
              maxAmount: amountString.optional(),
              totalAmount: amountString.optional(),
              methods: z
                .array(z.union([z.string().min(1).max(64), z.object({ id: z.string().min(1).max(64) })]))
                .min(1)
                .optional(),
              terms: z.string().max(4000).optional(),
            })
            .refine(
              (value) =>
                value.price !== undefined ||
                value.minAmount !== undefined ||
                value.maxAmount !== undefined ||
                value.totalAmount !== undefined ||
                value.methods !== undefined ||
                value.terms !== undefined,
              { message: 'p2p.offer_update_empty' },
            ),
        )
        .output(offerOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            presentOffer(
              await p2p.updateOffer({
                offerId: input.offerId,
                makerId: ctx.principal.userId,
                idempotencyKey: input.idempotencyKey,
                ...(input.price !== undefined ? { price: parseAmount(input.price) } : {}),
                ...(input.minAmount !== undefined ? { minAmt: parseAmount(input.minAmount) } : {}),
                ...(input.maxAmount !== undefined ? { maxAmt: parseAmount(input.maxAmount) } : {}),
                ...(input.totalAmount !== undefined ? { totalAmt: parseAmount(input.totalAmount) } : {}),
                ...(input.methods !== undefined ? { methods: input.methods } : {}),
                ...(input.terms !== undefined ? { terms: input.terms } : {}),
              }),
            ),
          ),
        ),
    }),

    /**
     * P-trade-orders-02. What the caller needs before taking an ad, check by
     * check, in the order the hub shows them. Scope only, no module gate: an
     * unverified person must be able to read that verification is the step
     * they are missing, which the jurisdiction gate would refuse to say.
     */
    access: router({
      eligibility: scopedProcedure('p2p:read')
        .output(
          z.object({
            checks: z.array(
              z.object({
                id: z.enum(ELIGIBILITY_CHECK_IDS),
                state: z.enum(ELIGIBILITY_STATES),
                reason: z.string(),
                fix: z.string().nullable(),
              }),
            ),
            canTake: z.boolean(),
          }),
        )
        .query(async ({ ctx }) =>
          guard(async () => {
            const { checks } = await takeGate.eligibility(ctx);
            return { checks: [...checks], canTake: checks.every((check) => check.state === 'met') };
          }),
        ),
    }),

    /**
     * P-disputes-security-15. The caller's own verification cap, and whether a
     * security-change sell lock is published. Neither invents a number.
     */
    limits: router({
      verification: merchantApiProcedure('p2p:read')
        .output(
          z.object({
            tier: z.enum(['none', 'basic', 'full', 'institutional']),
            currency: z.string().length(3),
            orderMin: amountString,
            orderMax: amountString,
            dailyMax: amountString,
            lifetimeMax: amountString,
            dailyUsed: amountString,
            lifetimeUsed: amountString,
            dailyRemaining: amountString,
            lifetimeRemaining: amountString,
          }),
        )
        .query(async ({ ctx }) =>
          guard(async () => p2p.verificationAllowance({ buyerId: ctx.principal.userId, tier: ctx.principal.tier })),
        ),

      /**
       * Unpublished → `p2p.security_change_lock_unset`. Published → the same
       * unwired refusal as a sell, because the change time is not on this
       * principal. There is no `locked: false`.
       */
      securityChange: merchantApiProcedure('p2p:read')
        .output(z.object({ seconds: z.number().int().positive() }))
        .query(async () => guard(async () => p2p.securityChangeLock())),
    }),

    trades: router({
      /**
       * Until when this session's takes need no new confirmation (P-trade-orders-07), or null when the next take does.
       * An API key is refused: it never confirms a take.
       */
      stepUpWindow: merchantApiProcedure('p2p:read')
        .output(z.object({ confirmedUntil: z.string().datetime().nullable() }))
        .query(async ({ ctx }) =>
          guard(async () => {
            const { confirmedUntil } = await takeStepUp.window(stepUpCaller(ctx.principal));
            return { confirmedUntil: confirmedUntil?.toISOString() ?? null };
          }),
        ),

      /**
       * Until when this session's releases need no new confirmation (P-trade-orders-07, -16), or null when the next one
       * does. A take's confirmation never counts here. An API key is refused: it never confirms a release.
       */
      releaseStepUpWindow: merchantApiProcedure('p2p:read')
        .output(z.object({ confirmedUntil: z.string().datetime().nullable() }))
        .query(async ({ ctx }) =>
          guard(async () => {
            const { confirmedUntil } = await releaseStepUp.window(stepUpCaller(ctx.principal));
            return { confirmedUntil: confirmedUntil?.toISOString() ?? null };
          }),
        ),

      /** Take an offer → `escrowLock`. The first money path in this router. */
      take: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            offerId: z.string().guid(),
            tradeId: z.string().guid(),
            amount: amountString,
            method: z.string().min(1).max(64),
            /** P-trade-orders-06: the locked quote (`trades.lockQuote`) this take places, inside its window. */
            quoteId: z.string().guid().optional(),
            /** P-trade-orders-07: identity's single-use confirmation of exactly this take. Optional inside a live window. */
            stepUpApprovalId: z.string().min(1).max(128).optional(),
            /** P-ads-merchant-07: the share link the taker came by; required for a private ad, and marks the order shared. */
            shareToken: shareTokenInput.optional(),
          }),
        )
        .output(tradeOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            // Before anything is reserved or locked: the same checks the eligibility panel shows.
            await takeGate.assertCanTake(ctx);
            // Then the fresh confirmation, over the strings this take carries.
            await takeStepUp.assertConfirmed(
              stepUpCaller(ctx.principal),
              {
                tradeId: input.tradeId,
                offerId: input.offerId,
                amount: input.amount,
                method: input.method,
                ...(input.quoteId ? { quoteId: input.quoteId } : {}),
              },
              input.stepUpApprovalId,
            );
            return toTradeOut(
              await p2p.takeOffer({
                offerId: input.offerId,
                takerId: ctx.principal.userId,
                amount: parseAmount(input.amount),
                tradeId: input.tradeId,
                method: input.method,
                ...(input.quoteId ? { quoteId: input.quoteId } : {}),
                ...(ctx.principal.tier === undefined ? {} : { tier: ctx.principal.tier }),
                ...(input.shareToken ? { shareToken: input.shareToken } : {}),
              }),
            );
          }),
        ),

      markFiatSent: merchantApiProcedure('p2p:write')
        .input(z.object({ tradeId: z.string().guid() }))
        .output(tradeOutput)
        .mutation(async ({ ctx, input }) => guard(async () => toTradeOut(await p2p.markFiatSent(input.tradeId, ctx.principal.userId)))),

      /**
       * Seller confirms the fiat landed → `escrowRelease`, confirmed with identity's single-use approval of this release,
       * or inside this session's ten-minute release window (P-trade-orders-07). A second press on an order this seller
       * already released returns that order and asks for nothing: the release was decided once and nothing more moves.
       */
      confirmReceived: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            tradeId: z.string().guid(),
            /** P-trade-orders-07: identity's single-use confirmation of exactly this release. */
            stepUpApprovalId: z.string().min(1).max(128).optional(),
          }),
        )
        .output(tradeOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const current = await p2p.getTrade(input.tradeId);
            if (current.buyerId !== ctx.principal.userId && current.sellerId !== ctx.principal.userId) {
              throw unknownTrade(input.tradeId);
            }
            const seller = current.sellerId === ctx.principal.userId;
            if (seller && current.status === 'released' && current.resolution === 'released') return toTradeOut(current);
            // Only the seller can release, so only the seller is asked for a confirmation, in every state that is or may
            // yet become a held escrow: `created` too, since its lock can land between this read and the locked decision.
            // A disputed or terminal order cannot reach a seller's release, so it gets the service's own refusal.
            if (seller && (current.status === 'created' || current.status === 'escrowed' || current.status === 'fiat_sent')) {
              await releaseStepUp.assertConfirmed(stepUpCaller(ctx.principal), input.tradeId, input.stepUpApprovalId);
            }
            return toTradeOut(await p2p.confirmFiatReceived(input.tradeId, ctx.principal.userId));
          }),
        ),

      /**
       * P-trade-orders-15 / J-p2p-02 #2: the buyer of a paid order reminds the seller to check the payment and release.
       * Refuses `p2p.remind_too_early` with the time it may go, `p2p.remind_rate_limited` once the owner's count is spent,
       * and `p2p.config_unset` while either owner figure is blank. Nothing moves.
       */
      remind: merchantApiProcedure('p2p:write')
        .input(z.object({ tradeId: z.string().guid() }))
        .output(reminderOutput)
        .mutation(async ({ ctx, input }) => guard(async () => toReminderOut(await p2p.remindSeller(input.tradeId, ctx.principal.userId)))),

      /**
       * P-ads-merchant-19 / J-p2p-04 #5: the seller reports a sensitive remark the buyer wrote in the payment note (the
       * buyer is refused `p2p.remark_not_payee`). A case opens against the buyer and they are told (svc-notify, by
       * caseId). One per order: the same report again returns the first, a different one (or a case id already used) refuses
       * `p2p.remark_case_exists`. An order never funded has no payment note: `p2p.invalid_transition` (or
       * `p2p.trade_terminal` once it is cancelled).
       */
      reportSensitiveRemark: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            /** The client's id for this report, made once per form: a lost reply sent again returns the same case. */
            caseId: z.string().guid(),
            tradeId: z.string().guid(),
            /** The remark as written in the payment note. Staff read it; the reported party is told a case opened. */
            remark: z.string().trim().min(1).max(REMARK_MAX),
          }),
        )
        .output(remarkCaseOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            toRemarkCaseOut(
              await p2p.reportSensitiveRemark({
                caseId: input.caseId,
                tradeId: input.tradeId,
                reporterId: ctx.principal.userId,
                remark: input.remark,
              }),
            ),
          ),
        ),

      /**
       * P-ads-merchant-19: the remark cases on this order as the caller may see them: their own report (or null), and
       * whether the other party reported them, with the case id and when, never the quote. A non-party gets not found.
       */
      remarkCase: merchantApiProcedure('p2p:read')
        .input(z.object({ tradeId: z.string().guid() }))
        .output(
          z.object({
            mine: remarkCaseOutput.nullable(),
            againstMe: z.object({ caseId: z.string(), openedAt: z.string() }).nullable(),
          }),
        )
        .query(async ({ ctx, input }) =>
          guard(async () => {
            const { mine, againstMe } = await p2p.remarkCasesOn(input.tradeId, ctx.principal.userId);
            return {
              mine: mine ? toRemarkCaseOut(mine) : null,
              againstMe: againstMe ? { caseId: againstMe.caseId, openedAt: againstMe.openedAt.toISOString() } : null,
            };
          }),
        ),

      /**
       * P-trade-orders-20 / J-p2p-02 #3: the seller of a paid order reports an under-, over- or part payment found in
       * their own bank. Answers the classification; the order stays paid either way and nothing moves. Refuses
       * `p2p.invalid_amount` when the amount contradicts the kind, and `p2p.mismatch_report_exists` for a second,
       * different report.
       */
      reportMismatch: merchantApiProcedure('p2p:write')
        .input(z.object({ tradeId: z.string().guid(), kind: z.enum(MISMATCH_KINDS), amountReceived: amountString }))
        .output(mismatchOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            toMismatchOut(
              await p2p.reportMismatch(input.tradeId, ctx.principal.userId, {
                kind: input.kind,
                amountReceived: parseAmount(input.amountReceived),
              }),
            ),
          ),
        ),

      /**
       * P-trade-orders-11 / J-p2p-02 #4: the seller of a paid order has the bank rail check the payment. An exact match
       * releases once (`released`); nothing arrived yet answers `pending`. Refuses `rail.bank` while no rail is wired,
       * `p2p.method_not_rail_validated` for a method the rail does not cover, and `p2p.rail_mismatch` (an exception row
       * for a person, no release) when what arrived differs. A check that can release asks for the same confirmation
       * as a release by hand (P-trade-orders-07), so the rail never becomes a release door without a fresh factor.
       */
      validatePayment: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            tradeId: z.string().guid(),
            /** P-trade-orders-07: identity's single-use confirmation of this release, or the session's release window. */
            stepUpApprovalId: z.string().min(1).max(128).optional(),
          }),
        )
        .output(z.object({ outcome: z.enum(['released', 'pending']), trade: tradeOutput }))
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const current = await p2p.getTrade(input.tradeId);
            if (current.buyerId !== ctx.principal.userId && current.sellerId !== ctx.principal.userId) {
              throw unknownTrade(input.tradeId);
            }
            // Only a check that could release is confirmed: a switched-off rail, the buyer, or a disputed or ended order
            // gets the service's own refusal first. `created` and `escrowed` are asked too, since the buyer can mark the
            // order paid between this read and the service's own.
            if (
              current.sellerId === ctx.principal.userId &&
              (current.status === 'created' || current.status === 'escrowed' || current.status === 'fiat_sent') &&
              p2p.paymentValidationBlocker(current) === null
            ) {
              await releaseStepUp.assertConfirmed(stepUpCaller(ctx.principal), input.tradeId, input.stepUpApprovalId);
            }
            const result = await p2p.validatePayment(input.tradeId, ctx.principal.userId);
            return { outcome: result.outcome, trade: toTradeOut(result.trade) };
          }),
        ),

      /** Cancel → `escrowRefund`, in full, to the seller. */
      cancel: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            tradeId: z.string().guid(),
            reason: z.string().max(200).optional(),
            /** P-trade-orders-19: a code from the caller's side's list; it wins over free text. */
            reasonCode: z.enum(P2P_CANCEL_REASONS).optional(),
          }),
        )
        .output(tradeOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            toTradeOut(await p2p.cancelTrade(input.tradeId, ctx.principal.userId, input.reason ?? 'cancelled', input.reasonCode)),
          ),
        ),

      /**
       * P-trade-orders-19 (2): the seller's cancellation request on a paid order. Parked until the founders choose how a
       * paid order may be cancelled: the seller of a paid order is always refused `p2p.owner_decision_pending`, and
       * nothing is written. It takes no reason yet: what a request carries is part of that decision.
       */
      requestCancel: merchantApiProcedure('p2p:write')
        .input(z.object({ tradeId: z.string().guid() }))
        .output(tradeOutput)
        .mutation(async ({ ctx, input }) => guard(async () => p2p.requestCancel(input.tradeId, ctx.principal.userId))),

      get: merchantApiProcedure('p2p:read')
        .input(z.object({ tradeId: z.string().guid() }))
        .output(tradeDetailOutput)
        .query(async ({ ctx, input }) =>
          guard(async () => {
            const trade = await p2p.getTrade(input.tradeId);
            // L2-7: any p2p:read holder could previously read any trade by id.
            if (trade.buyerId !== ctx.principal.userId && trade.sellerId !== ctx.principal.userId) {
              throw unknownTrade(input.tradeId);
            }
            return {
              ...toTradeOut(trade),
              terms: trade.termsSnapshot,
              displayStatus: displayStatus(trade),
              feeBps: trade.feeBps,
              ...releaseSplit(trade),
              settlement: trade.settlement,
              releasePreview: releasePreview(trade),
              escrowHeld: escrowHeld(trade),
              ...(await Promise.all([p2p.reminderState(trade), p2p.mismatchReport(trade.id)]).then(([reminders, mismatch]) => ({
                reminders: toReminderOut(reminders),
                mismatch: mismatch ? toMismatchOut(mismatch) : null,
              }))),
              paymentValidation: { blocker: p2p.paymentValidationBlocker(trade) },
              cancelReason: cancelReasonOf(trade),
            };
          }),
        ),

      list: merchantApiProcedure('p2p:read')
        .input(
          z
            .object({
              /**
               * Page size. Optional here so omit reaches the service named
               * refuse (`p2p.trade_list_limit_unset`) instead of a Zod
               * "Required" that looks like a typo. Blank is not 50; pass 50
               * explicitly when that is the page you want.
               */
              limit: z.number().int().min(1).max(200).optional(),
            })
            .optional(),
        )
        .output(z.array(tradeOutput))
        .query(async ({ ctx, input }) => guard(async () => (await p2p.listTrades(ctx.principal.userId, input?.limit)).map(toTradeOut))),

      /**
       * P-trade-orders-13: the order list. Keyset paging newest first,
       * filters {tab, asset, side, from, to, orderId prefix}, true per-tab
       * counts from a count query, and a server-derived `displayStatus` so
       * labels are never guessed on the client. Read-only.
       */
      page: merchantApiProcedure('p2p:read')
        .input(
          z.object({
            /** Optional so omit reaches the named `p2p.trade_list_limit_unset` refusal. */
            limit: z.number().int().min(1).max(200).optional(),
            cursor: z.string().max(512).optional(),
            tab: z.string().max(32).optional(),
            asset: z.string().max(32).optional(),
            side: z.string().max(8).optional(),
            from: z.string().max(40).optional(),
            to: z.string().max(40).optional(),
            orderId: z.string().max(64).optional(),
          }),
        )
        .output(
          z.object({
            trades: z.array(tradeOutput.extend({ tab: z.enum(ORDER_TABS), displayStatus: z.enum(DISPLAY_STATUSES) })),
            nextCursor: z.string().nullable(),
            counts: z.object({
              in_progress: z.number().int().nonnegative(),
              in_dispute: z.number().int().nonnegative(),
              completed: z.number().int().nonnegative(),
              cancelled: z.number().int().nonnegative(),
            }),
          }),
        )
        .query(async ({ ctx, input }) =>
          guard(async () => {
            const { limit, cursor, ...filter } = input;
            const out = await p2p.pageTrades({ userId: ctx.principal.userId, limit, cursor, filter });
            return {
              trades: out.trades.map((t) => ({ ...toTradeOut(t), tab: tabOf(t.status), displayStatus: displayStatus(t) })),
              nextCursor: out.nextCursor,
              counts: out.counts,
            };
          }),
        ),

      /**
       * What a take would lock, before it locks anything. Exact decimals from
       * the offer and the published fee. No row is written.
       */
      quote: merchantApiProcedure('p2p:read')
        .input(takeAmountInput)
        .output(
          z.object({
            amount: amountString,
            price: amountString,
            fiatAmount: amountString,
            feeBps: z.number().int().nonnegative(),
            fee: amountString,
            netAmount: amountString,
            reservationExpiresAt: z.string(),
          }),
        )
        .query(async ({ ctx, input }) =>
          guard(async () => {
            const quoted = await p2p.quoteTake({
              offerId: input.offerId,
              takerId: ctx.principal.userId,
              method: input.method,
              ...takeAmountOf(input),
              ...(ctx.principal.tier === undefined ? {} : { tier: ctx.principal.tier }),
              ...(input.shareToken ? { shareToken: input.shareToken } : {}),
            });
            return {
              amount: formatAmount(quoted.amount),
              price: formatAmount(quoted.price),
              fiatAmount: formatAmount(quoted.fiatAmount),
              feeBps: quoted.feeBps,
              fee: formatAmount(quoted.fee),
              netAmount: formatAmount(quoted.netAmount),
              reservationExpiresAt: quoted.reservationExpiresAt.toISOString(),
            };
          }),
        ),

      /**
       * P-trade-orders-06: lock the quote for its window. `trades.take` with this `quoteId` places exactly these terms,
       * or refuses `p2p.quote_expired` / `p2p.quote_changed` before anything is reserved. Client-chosen `quoteId`: a
       * retry returns the same quote.
       */
      lockQuote: merchantApiProcedure('p2p:write')
        .input(takeAmountInput.and(z.object({ quoteId: z.string().guid() })))
        .output(
          z.object({
            quoteId: z.string().guid(),
            amount: amountString,
            price: amountString,
            fiatAmount: amountString,
            feeBps: z.number().int().nonnegative(),
            fee: amountString,
            netAmount: amountString,
            expiresAt: z.string(),
            /** Time left by the service's clock when answered: count down from receipt, not from the device clock. */
            expiresInMs: z.number().int().nonnegative(),
          }),
        )
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const locked = await p2p.lockQuote({
              quoteId: input.quoteId,
              offerId: input.offerId,
              takerId: ctx.principal.userId,
              method: input.method,
              ...takeAmountOf(input),
              ...(ctx.principal.tier === undefined ? {} : { tier: ctx.principal.tier }),
              ...(input.shareToken ? { shareToken: input.shareToken } : {}),
            });
            return {
              quoteId: locked.quoteId,
              amount: formatAmount(locked.amount),
              price: formatAmount(locked.price),
              fiatAmount: formatAmount(locked.fiatAmount),
              feeBps: locked.feeBps,
              fee: formatAmount(locked.fee),
              netAmount: formatAmount(locked.netAmount),
              expiresAt: locked.expiresAt.toISOString(),
              expiresInMs: locked.expiresInMs,
            };
          }),
        ),

      /**
       * P-trade-orders-14: export under owner range and row caps
       * (`P2P_EXPORT_MAX_RANGE_DAYS`, `P2P_EXPORT_MAX_ROWS`; blank refuses
       * `p2p.config_unset`), one audit row per export, totals as decimal
       * strings. CSV only; xlsx/pdf refuse `p2p.export_format_unbuilt`.
       */
      export: merchantApiProcedure('p2p:read')
        .input(z.object({ from: z.string().min(1), to: z.string().min(1), format: z.enum(EXPORT_FORMATS).optional() }))
        .output(
          z.object({
            csv: z.string(),
            rows: z.number().int().nonnegative(),
            format: z.literal('csv'),
            totals: z.array(z.object({ asset: z.string(), fiatCurrency: z.string(), amount: amountString, fiatAmount: amountString })),
          }),
        )
        .query(async ({ ctx, input }) =>
          guard(async () => p2p.exportTrades({ userId: ctx.principal.userId, from: input.from, to: input.to, format: input.format })),
        ),

      /** P-trade-orders-14: receipt for one released trade, as data, under owner quotas. */
      receipt: merchantApiProcedure('p2p:read')
        .input(z.object({ tradeId: z.string().guid() }))
        .output(
          z.object({
            receipt: z.object({
              tradeId: z.string().guid(),
              offerId: z.string().guid(),
              role: z.enum(['buyer', 'seller']),
              asset: z.string(),
              amount: amountString,
              fiatCurrency: z.string(),
              fiatAmount: amountString,
              price: amountString,
              feeBps: z.number().int().nonnegative(),
              method: z.string(),
              createdAt: z.string(),
              escrowedAt: z.string().nullable(),
              fiatSentAt: z.string().nullable(),
              resolvedAt: z.string().nullable(),
            }),
            dailyRemaining: z.number().int().nonnegative(),
            tradeRemaining: z.number().int().nonnegative(),
          }),
        )
        .mutation(async ({ ctx, input }) => guard(async () => p2p.tradeReceipt({ userId: ctx.principal.userId, tradeId: input.tradeId }))),

      /**
       * WHERE TO SEND THE MONEY. The only path to a seller's account details.
       *
       * Deliberately its own procedure rather than a field on `trades.get`.
       * Three things follow from that, and each one is a bug that cannot now
       * happen:
       *
       *   · `trades.get` and `trades.list` cannot leak an instrument, because
       *     they never load one. A routine trade read is not a disclosure.
       *   · every disclosure is an explicit call, so the access log has one
       *     row per intent rather than one row per screen refresh.
       *   · the authorisation for reading account details is written in one
       *     place instead of being a clause inside a trade serialiser.
       *
       * `p2p:read` and not `p2p:write`, because a moderator adjudicating a
       * dispute holds moderator authority + `p2p:read` and never `p2p:write` —
       * the same pairing `disputes.get` already relies on. The scope is not
       * what protects this; being a party (or an allowlisted / compliance
       * moderator) to a live disputed trade is.
       */
      paymentInstrument: merchantApiProcedure('p2p:read')
        .input(z.object({ tradeId: z.string().guid() }))
        .output(
          z.object({
            tradeId: z.string().guid(),
            methodId: z.string(),
            country: z.string(),
            fiatCurrency: z.string(),
            label: z.string(),
            details: instrumentDetailsOutput,
            /** Each detail's label from the method schema, in its order. */
            fields: z.array(z.object({ key: z.string(), label: z.string() })),
            attachedAt: z.string(),
            /** P-trade-orders-08: the seller changed or removed this destination after the order was placed. The order still pays the details above. */
            payeeChange: z.object({ kind: z.enum(['changed', 'removed']) }).nullable(),
          }),
        )
        .query(async ({ ctx, input }) =>
          guard(async () => {
            const view = await instruments.revealForTrade({
              tradeId: input.tradeId,
              viewerId: ctx.principal.userId,
              isModerator: isModerator(ctx.principal, moderatorUserIds),
            });
            return {
              tradeId: view.tradeId,
              methodId: view.methodId,
              country: view.country,
              fiatCurrency: view.fiatCurrency,
              label: view.label,
              details: { ...view.details },
              fields: view.fields.map((field) => ({ key: field.key, label: field.label })),
              attachedAt: view.attachedAt.toISOString(),
              payeeChange: view.payeeChange && { kind: view.payeeChange.kind },
            };
          }),
        ),
    }),

    /**
     * BLOCK / RFQ (PTX-M12). Firm bilateral quotes — not a take from the offer
     * board and not a matching-engine fill. The maker names size, price,
     * expiry, capacity and firmness. Missing any of those refuses. A mid is
     * never taken from the caller and never invented. Last look / undisclosed
     * last look / unlabeled capacity refuse — the house model is never
     * invented. Give-up / allocation without a named receiving account refuse.
     * Named still refuse-closed until owner law exists.
     */
    rfq: router({
      quote: merchantApiProcedure('p2p:write')
        .input(
          z
            .object({
              takerId: z.string().guid(),
              side: z.enum(['buy', 'sell']),
              asset: z.string().min(1).max(16),
              fiatCurrency: z.string().length(3),
              size: amountString,
              price: amountString,
              expiresAt: z.string().min(1),
              capacity: z.string().optional(),
              firmness: z.string().optional(),
              lastLook: z.union([z.boolean(), z.string()]).optional(),
            })
            .strict(),
        )
        .output(blockQuoteOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            requireBlockRfq().quote(ctx.principal, {
              takerId: input.takerId,
              side: input.side,
              asset: input.asset,
              fiatCurrency: input.fiatCurrency,
              size: input.size,
              price: input.price,
              expiresAt: input.expiresAt,
              capacity: input.capacity,
              firmness: input.firmness,
              lastLook: input.lastLook,
            }),
          ),
        ),

      accept: merchantApiProcedure('p2p:write')
        .input(z.object({ quoteId: z.string().guid(), assertedPrice: amountString.optional() }).strict())
        .output(blockQuoteOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            requireBlockRfq().accept(ctx.principal, {
              quoteId: input.quoteId,
              ...(input.assertedPrice === undefined ? {} : { assertedPrice: input.assertedPrice }),
            }),
          ),
        ),

      expire: merchantApiProcedure('p2p:write')
        .input(z.object({ quoteId: z.string().guid() }).strict())
        .output(blockQuoteOutput)
        .mutation(async ({ ctx, input }) => guard(async () => requireBlockRfq().expire(ctx.principal, { quoteId: input.quoteId }))),

      get: merchantApiProcedure('p2p:read')
        .input(z.object({ quoteId: z.string().guid() }).strict())
        .output(blockQuoteOutput)
        .query(async ({ ctx, input }) => guard(async () => requireBlockRfq().get(ctx.principal, input.quoteId))),

      allocate: merchantApiProcedure('p2p:write')
        .input(
          z
            .object({
              quoteId: z.string().guid(),
              allocations: z.array(z.object({ receivingAccount: z.string().min(1).max(120) }).passthrough()).min(1),
            })
            .strict(),
        )
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            requireBlockRfq().allocate(ctx.principal, {
              quoteId: input.quoteId,
              allocations: input.allocations.map((line) => ({ receivingAccount: line.receivingAccount })),
            }),
          ),
        ),

      giveUp: merchantApiProcedure('p2p:write')
        .input(
          z
            .object({
              quoteId: z.string().guid(),
              receivingAccount: z.string().min(1).max(120),
            })
            .strict(),
        )
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            requireBlockRfq().giveUp(ctx.principal, {
              quoteId: input.quoteId,
              receivingAccount: input.receivingAccount,
            }),
          ),
        ),
    }),

    /**
     * PAYMENT INSTRUMENTS (§6.2 "any payment method").
     *
     * Who can see a seller's account details, stated once:
     *
     *   nobody, except the owner and the counterparty of a trade whose escrow
     *   is currently HELD — plus a moderator, and only while a dispute on that
     *   trade is open. Never on an offer, never to a browsing user, never after
     *   the trade closes. Every one of those reads is logged, including the
     *   owner's own and including the refusals.
     *
     * Nothing in this branch returns a field value except `reveal`, and
     * `reveal` cannot return one without having written an access-log row in
     * the same SQL statement (see `instrument-service.ts`).
     */
    instruments: router({
      methods: router({
        /**
         * The registry — what each method needs, per country.
         *
         * Ships empty. What a payer needs in order to send money differs by
         * method and by country, and it is not this repo's knowledge to invent;
         * an operator registers what a market actually requires and until they
         * do, that market refuses instruments. A seeded guess would be a wrong
         * answer that looks like a right one.
         */
        list: merchantApiProcedure('p2p:read')
          .input(
            z
              .object({
                country: z.string().length(2).optional(),
                methodId: z.string().max(64).optional(),
                /**
                 * Page size. Optional here so omit reaches the service named
                 * refuse (`p2p.method_schema_list_limit_unset`) instead of a
                 * Zod "Required" that looks like a typo. Blank is not 50;
                 * pass 50 explicitly when that is the page you want.
                 */
                limit: z.number().int().min(1).max(200).optional(),
              })
              .optional(),
          )
          .output(z.array(methodSchemaOutput))
          .query(async ({ input }) =>
            guard(async () =>
              (
                await instruments.listMethodSchemas({
                  ...(input?.country ? { country: input.country } : {}),
                  ...(input?.methodId ? { methodId: input.methodId } : {}),
                  limit: input?.limit,
                })
              ).map((s) => ({ ...s, fields: [...s.fields] })),
            ),
          ),

        /**
         * OPERATOR ONLY. `admin:compliance`, not `admin:write`.
         *
         * What a market's payment rails require is the same class of content as
         * a sanctions list: it is researched, it is jurisdictional, and getting
         * it wrong produces instruments that look complete and cannot be paid.
         * Dual-control: MFA + identity-consumed approval. A typed-in
         * `confirmOperatorId` is not a second person. Missing approval ids
         * refuse — one operator cannot rewrite the rails a stranger pays against.
         * `admin:compliance` is not in INTERACTIVE_ONLY_SCOPES; MFA is applied
         * locally, same as merchants.decide / edge kill-switch.
         */
        register: scopedProcedure('admin:compliance', { module: 'p2p' })
          .input(
            z.object({
              methodId: z.string().min(1).max(64),
              /** ISO 3166-1 alpha-2, or `*` for "the same everywhere". */
              country: z.string().min(1).max(2),
              label: z.string().min(1).max(120),
              fields: z.array(z.unknown()).min(1),
              enabled: z.boolean().optional(),
              /**
               * P-disputes-security-09: whether money on the method arrives at once here, or within `windowSeconds`
               * (null: the published payment deadline applies). Omitted keeps a row's profile; a new row is instant.
               */
              settlement: z
                .discriminatedUnion('instant', [
                  z.object({ instant: z.literal(true) }),
                  z.object({ instant: z.literal(false), windowSeconds: z.number().int().min(60).max(2_592_000).nullable() }),
                ])
                .optional(),
              /** P-ads-merchant-19: payment-note rules. Omitted keeps the row's; null clears them. */
              noteRules: noteRulesInput.nullable().optional(),
              /** P-ads-merchant-19: rules make the method cash in person; null makes it a transfer; omitted keeps. */
              cashRules: cashRulesInput.nullable().optional(),
              confirmOperatorId: z.string().max(128).nullish(),
              approvalId: z.string().max(128).nullish(),
              operationId: z.string().max(128).nullish(),
            }),
          )
          .output(methodSchemaOutput.extend({ confirmOperatorId: z.string() }))
          .mutation(async ({ ctx, input }) =>
            guard(async () => {
              try {
                requireMfa(ctx.principal);
              } catch (err) {
                if (err instanceof AuthError && err.code === 'mfa.required') {
                  throw new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
                }
                throw err;
              }
              void requireUser(ctx);
              const confirmOperatorId = await consumeOperatorApproval(input, 'p2p.method_register', {
                methodId: input.methodId,
                country: input.country,
                label: input.label,
                fields: JSON.stringify(parseFieldSpecs(input.fields)),
                enabled: input.enabled === undefined ? 'preserve-or-default' : input.enabled ? 'true' : 'false',
                // The approval covers the profile only when one is sent, so a register without it hashes as before.
                ...(input.settlement === undefined ? {} : { settlement: JSON.stringify(input.settlement) }),
                // The same for the rules: a register that sends none hashes as before.
                ...(input.noteRules === undefined ? {} : { noteRules: JSON.stringify(input.noteRules) }),
                ...(input.cashRules === undefined ? {} : { cashRules: JSON.stringify(input.cashRules) }),
              });
              const schema = await instruments.registerMethodSchema({
                methodId: input.methodId,
                country: input.country,
                label: input.label,
                fields: input.fields,
                ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
                ...(input.settlement === undefined ? {} : { settlement: input.settlement }),
                ...(input.noteRules === undefined ? {} : { noteRules: input.noteRules }),
                ...(input.cashRules === undefined ? {} : { cashRules: input.cashRules }),
              });
              return { ...schema, fields: [...schema.fields], confirmOperatorId };
            }),
          ),

        /**
         * OPERATOR ONLY. Dual-control: MFA + identity-consumed approval.
         * Disabling a rail is the same class of mutate as registering one —
         * one operator cannot silently take a market offline.
         */
        setEnabled: scopedProcedure('admin:compliance', { module: 'p2p' })
          .input(
            z.object({
              methodId: z.string().min(1).max(64),
              country: z.string().min(1).max(2),
              enabled: z.boolean(),
              /** Required when retiring (`enabled: false`); the customer is told it on a take. */
              reason: z.enum(DELIST_REASONS).optional(),
              confirmOperatorId: z.string().max(128).nullish(),
              approvalId: z.string().max(128).nullish(),
              operationId: z.string().max(128).nullish(),
            }),
          )
          .output(methodSchemaOutput.extend({ confirmOperatorId: z.string() }))
          .mutation(async ({ ctx, input }) =>
            guard(async () => {
              try {
                requireMfa(ctx.principal);
              } catch (err) {
                if (err instanceof AuthError && err.code === 'mfa.required') {
                  throw new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
                }
                throw err;
              }
              void requireUser(ctx);
              // Checked here as well as in the service so a refused change never spends the approval.
              if (!input.enabled && !input.reason) {
                throw new InstrumentError('Retiring a payment method needs a reason', 'p2p.delist_reason_required');
              }
              if (input.enabled && input.reason) {
                throw new TRPCError({ code: 'BAD_REQUEST', message: 'A payment method switched on has no retirement reason' });
              }
              const reason = input.enabled ? undefined : input.reason;
              const confirmOperatorId = await consumeOperatorApproval(input, 'p2p.method_set_enabled', {
                methodId: input.methodId,
                country: input.country,
                enabled: input.enabled ? 'true' : 'false',
                ...(reason ? { reason } : {}),
              });
              const schema = await instruments.setMethodSchemaEnabled(input.methodId, input.country, input.enabled, reason);
              return { ...schema, fields: [...schema.fields], confirmOperatorId };
            }),
          ),
      }),

      create: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            instrumentId: z.string().guid(),
            methodId: z.string().min(1).max(64),
            country: z.string().length(2),
            fiatCurrency: z.string().length(3),
            label: z.string().max(120).optional(),
            /** Exactly the fields the method schema declared. An extra key is refused. */
            details: z.record(z.string(), z.string()),
            /** Identity's approval of exactly this change and these details (P-ads-merchant-18). Without it, refused. */
            stepUpApprovalId: z.string().min(1).max(200).optional(),
          }),
        )
        .output(instrumentHeaderOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            // Saved details are sealed with the instrument key: without it nothing is saved, before any confirmation.
            if (options.instrumentKeyProvider !== 'local-test') refuseLiveOffersUntilOwnerKms();
            await instrumentStepUp.assertConfirmed(stepUpCaller(ctx.principal), {
              instrumentId: input.instrumentId,
              change: 'create',
              details: input.details,
              approvalId: input.stepUpApprovalId,
            });
            return toHeaderOut(
              await instruments.createInstrument({
                instrumentId: input.instrumentId,
                ownerId: ctx.principal.userId,
                methodId: input.methodId,
                country: input.country,
                fiatCurrency: input.fiatCurrency,
                ...(input.label === undefined ? {} : { label: input.label }),
                details: input.details,
              }),
            );
          }),
        ),

      /**
       * Edit. Does NOT reach any trade already holding a snapshot — that is the
       * point of the snapshot, not a limitation of this call.
       */
      update: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            instrumentId: z.string().guid(),
            label: z.string().max(120).optional(),
            details: z.record(z.string(), z.string()).optional(),
            stepUpApprovalId: z.string().min(1).max(200).optional(),
          }),
        )
        .output(instrumentHeaderOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            if (input.details !== undefined && options.instrumentKeyProvider !== 'local-test') refuseLiveOffersUntilOwnerKms();
            await instrumentStepUp.assertConfirmed(stepUpCaller(ctx.principal), {
              instrumentId: input.instrumentId,
              change: 'update',
              details: input.details,
              approvalId: input.stepUpApprovalId,
            });
            return toHeaderOut(
              await instruments.updateInstrument({
                instrumentId: input.instrumentId,
                ownerId: ctx.principal.userId,
                ...(input.label === undefined ? {} : { label: input.label }),
                ...(input.details === undefined ? {} : { details: input.details }),
              }),
            );
          }),
        ),

      /**
       * P-ads-merchant-18: the caller's active sell ads that list this method, and which of them it is the last payable
       * method for (`pauses`). Read before removing, so the warning names the ads. Ad ids and coins only.
       */
      removalImpact: merchantApiProcedure('p2p:read')
        .input(z.object({ instrumentId: z.string().guid() }))
        .output(
          z.object({
            instrumentId: z.string(),
            methodId: z.string(),
            fiatCurrency: z.string(),
            ads: z.array(z.object({ offerId: z.string(), asset: z.string(), fiatCurrency: z.string(), pauses: z.boolean() })),
          }),
        )
        .query(async ({ ctx, input }) => guard(async () => p2p.methodRemovalImpact(input.instrumentId, ctx.principal.userId))),

      /**
       * Removal is a state change. An in-flight trade keeps working. When the method is the last payable one of an active
       * sell ad, the removal is refused `p2p.method_in_use` unless `pauseOfferIds` names each of those ads.
       */
      remove: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            instrumentId: z.string().guid(),
            stepUpApprovalId: z.string().min(1).max(200).optional(),
            /** The ads `removalImpact` marked `pauses`, which the person agreed to pause with the method. */
            pauseOfferIds: z.array(z.string().guid()).max(1000).optional(),
          }),
        )
        .output(instrumentHeaderOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const pauseOfferIds = input.pauseOfferIds ?? [];
            // A removal the ads would refuse is refused before the person's confirmation is spent on it.
            await p2p.assertRemovalConfirmed(input.instrumentId, ctx.principal.userId, pauseOfferIds);
            await instrumentStepUp.assertConfirmed(stepUpCaller(ctx.principal), {
              instrumentId: input.instrumentId,
              change: 'remove',
              details: undefined,
              approvalId: input.stepUpApprovalId,
            });
            return toHeaderOut(
              await p2p.removeMethod({
                instrumentId: input.instrumentId,
                ownerId: ctx.principal.userId,
                pauseOfferIds,
              }),
            );
          }),
        ),

      /** The caller's own instruments. Headers only — no field values, ever. */
      list: merchantApiProcedure('p2p:read')
        .input(
          z
            .object({
              includeRemoved: z.boolean().optional(),
              /**
               * Page size. Optional here so omit reaches the service named
               * refuse (`p2p.instrument_list_limit_unset`) instead of a Zod
               * "Required" that looks like a typo. Blank is not 50; pass 50
               * explicitly when that is the page you want.
               */
              limit: z.number().int().min(1).max(200).optional(),
            })
            .optional(),
        )
        .output(z.array(instrumentHeaderOutput))
        .query(async ({ ctx, input }) =>
          guard(async () =>
            (await instruments.listInstruments(ctx.principal.userId, input?.includeRemoved === true, input?.limit)).map(toHeaderOut),
          ),
        ),

      /**
       * The owner reads their own account details — and it is logged like
       * anyone else's read.
       *
       * The owner is not exempt because an account takeover reads exactly like
       * an owner: it holds the session. A log with a hole shaped like "the
       * owner" says nothing about the one attack it most needs to describe.
       *
       * `p2p:write` rather than `p2p:read`: this is the only procedure whose
       * scope IS the whole gate, so making it the stronger one costs nothing
       * and stops a read-only API key dumping a user's stored bank details.
       */
      reveal: merchantApiProcedure('p2p:write')
        .input(z.object({ instrumentId: z.string().guid() }))
        .output(instrumentHeaderOutput.extend({ details: instrumentDetailsOutput }))
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const revealed = await instruments.revealOwn({ instrumentId: input.instrumentId, viewerId: ctx.principal.userId });
            return { ...toHeaderOut(revealed), details: { ...revealed.details } };
          }),
        ),

      /**
       * The owner's own details masked (J-p2p-04 #3): the account holder whole, every other value as its last four.
       * Logged like `reveal`, and `p2p:write` for the same reason. The room shows this; the whole values stay behind
       * `reveal`.
       */
      revealMasked: merchantApiProcedure('p2p:write')
        .input(z.object({ instrumentId: z.string().guid() }))
        .output(instrumentHeaderOutput.extend({ details: instrumentDetailsOutput }))
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const revealed = await instruments.revealOwnMasked({ instrumentId: input.instrumentId, viewerId: ctx.principal.userId });
            return { ...toHeaderOut(revealed), details: { ...revealed.details } };
          }),
        ),

      /**
       * "Who has looked at my account details, and when."
       *
       * Exposed to the owner on purpose. A log only compliance can read is a
       * log the person whose data it is cannot use — and they are the one who
       * knows whether a look was expected.
       */
      accessLog: merchantApiProcedure('p2p:read')
        .input(
          z
            .object({
              /**
               * Page size. Optional here so omit reaches the service named
               * refuse (`p2p.access_log_limit_unset`) instead of a Zod
               * "Required" that looks like a typo. Blank is not 100; pass 100
               * explicitly when that is the page you want.
               */
              limit: z.number().int().min(1).max(500).optional(),
            })
            .optional(),
        )
        .output(
          z.array(
            z.object({
              id: z.string().guid(),
              instrumentId: z.string().guid().nullable(),
              viewerId: z.string(),
              viewerRole: z.enum(['owner', 'counterparty', 'moderator', 'other']),
              tradeId: z.string().guid().nullable(),
              outcome: z.enum(['revealed', 'denied']),
              denyReason: z.string().nullable(),
              at: z.string(),
            }),
          ),
        )
        .query(async ({ ctx, input }) =>
          guard(async () =>
            (await instruments.accessLogFor(ctx.principal.userId, input?.limit)).map((e) => ({
              id: e.id,
              instrumentId: e.instrumentId,
              viewerId: e.viewerId,
              viewerRole: e.viewerRole,
              tradeId: e.tradeId,
              outcome: e.outcome,
              denyReason: e.denyReason,
              at: e.at.toISOString(),
            })),
          ),
        ),
    }),

    disputes: router({
      open: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            tradeId: z.string().guid(),
            reason: z.string().min(1).max(2000),
            evidence: z.array(z.unknown()).max(MAX_EVIDENCE_PER_CALL).optional(),
          }),
        )
        .output(
          z.object({
            disputeId: z.string().guid(),
            tradeId: z.string().guid(),
            chatThreadId: z.string().guid(),
            deadlineAt: z.string(),
            /**
             * THE DISPOSITION, DISCLOSED BEFORE IT CAN HAPPEN.
             *
             * The ADR asks that a party entering a dispute be told what happens
             * if nobody rules. The honest answer is now short, and it is this
             * literal rather than a configurable string because there is no
             * configuration that could make it say anything else.
             */
            ifNobodyRules: z.literal('escalated_and_held'),
            /**
             * Whether this deployment has named human moderators. False means
             * the dispute will escalate-and-hold with nobody able to resolve
             * until an operator sets `P2P_MODERATOR_USER_IDS` — disclosed here
             * so a client never implies a console is watching. Named ids are
             * configured, not a live probe of a person on shift.
             */
            moderationConfigured: z.boolean(),
            moderation: moderationHonestySchema,
          }),
        )
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const dispute = await p2p.openDispute({
              tradeId: input.tradeId,
              openedBy: ctx.principal.userId,
              reason: input.reason,
              ...(input.evidence ? { evidence: input.evidence } : {}),
            });
            if (!dispute.chatThreadId) {
              throw new P2pError('This trade has no chat thread to attach the dispute to', 'p2p.chat_thread_unset');
            }
            return {
              disputeId: dispute.id,
              tradeId: dispute.tradeId,
              chatThreadId: dispute.chatThreadId,
              deadlineAt: dispute.deadlineAt.toISOString(),
              ifNobodyRules: 'escalated_and_held' as const,
              ...moderationPublic,
            };
          }),
        ),

      /**
       * ADD EVIDENCE TO AN OPEN DISPUTE. A party, and append-only.
       *
       * There is no edit and no remove, here or anywhere: not a missing feature
       * but the shape of the thing. A dispute record whose earlier entries can
       * change is a record whose last writer decides what was said.
       */
      appendEvidence: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            tradeId: z.string().guid(),
            evidence: z.array(z.unknown()).min(1).max(MAX_EVIDENCE_PER_CALL),
          }),
        )
        .output(z.object({ disputeId: z.string().guid(), tradeId: z.string().guid(), evidence: z.array(evidenceOutput) }))
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const dispute = await p2p.appendDisputeEvidence({
              tradeId: input.tradeId,
              actorId: ctx.principal.userId,
              evidence: input.evidence,
            });
            // Their own back, so a client can confirm what landed — never the
            // counterparty's, for the reason in `evidenceVisibleTo`.
            return {
              disputeId: dispute.id,
              tradeId: dispute.tradeId,
              evidence: evidenceVisibleTo(dispute, ctx.principal.userId).map(toEvidenceOut),
            };
          }),
        ),

      get: merchantApiProcedure('p2p:read')
        .input(z.object({ tradeId: z.string().guid() }))
        .output(disputeOutput)
        .query(async ({ ctx, input }) =>
          guard(async () => {
            const trade = await p2p.getTrade(input.tradeId);
            const isParty = trade.buyerId === ctx.principal.userId || trade.sellerId === ctx.principal.userId;
            const moderator = isModerator(ctx.principal, moderatorUserIds);
            if (!isParty && !moderator) {
              throw unknownTrade(input.tradeId);
            }

            // A moderator's read is STAMPED. That stamp is what makes "has a
            // human ever reached this dispute" a question the database can
            // answer; a party reading their own dispute is not evidence of
            // anything about moderation and must not be counted as if it were.
            const d = moderator
              ? await p2p.getDisputeAsModerator(input.tradeId, ctx.principal.userId)
              : await p2p.getDispute(input.tradeId);

            return toDisputeOut(d, moderator ? null : ctx.principal.userId);
          }),
        ),

      /**
       * THE MODERATOR QUEUE. Open disputes, most overdue first, paginated.
       *
       * Before this existed a moderator could only call `.get({ tradeId })` and
       * had to already know the id — which meant, in practice, that nobody
       * could reach a dispute at all, and a seven-day timer refunded every one
       * of them without a person ever seeing it.
       *
       * Scoped to `p2p:read` (a real session can hold it) and then gated by
       * `assertModerator`: either `admin:compliance` or membership of
       * `P2P_MODERATOR_USER_IDS`. An empty allowlist honest-refuses with
       * `p2p.moderation_unreachable` — mounted is not the same as reachable.
       */
      list: merchantApiProcedure('p2p:read')
        .input(
          z
            .object({
              status: z.enum(['open', 'resolved']).optional(),
              /**
               * Page size. Optional here so omit reaches the service named
               * refuse (`p2p.dispute_list_limit_unset`) instead of a Zod
               * "Required" that looks like a typo. Blank is not 50; pass 50
               * explicitly when that is the page you want.
               */
              limit: z.number().int().min(1).max(200).optional(),
              cursor: z.string().max(200).nullable().optional(),
            })
            .optional(),
        )
        .output(z.object({ disputes: z.array(disputeOutput), nextCursor: z.string().nullable() }))
        .query(async ({ ctx, input }) =>
          guard(async () => {
            assertModerator(ctx.principal, moderatorUserIds);
            const page = await p2p.listDisputes({
              moderatorId: ctx.principal.userId,
              ...(input?.status ? { status: input.status } : {}),
              ...(input?.limit ? { limit: input.limit } : {}),
              ...(input?.cursor ? { cursor: input.cursor } : {}),
            });
            // Evidence rides the queue, not just `.get`. A triage list that
            // cannot show what is being alleged sends the moderator on a second
            // round trip for every row, which is how a queue stops being used.
            return { disputes: page.disputes.map((d) => toDisputeOut(d, null)), nextCursor: page.nextCursor };
          }),
        ),

      /**
       * P-ads-merchant-19: the open sensitive-remark cases, oldest first, for the same moderators as the dispute queue.
       * The outcome goes to the penalty ladder (P-ads-merchant-17) once it exists; until then a case stays open here.
       */
      remarkCases: merchantApiProcedure('p2p:read')
        .input(z.object({ limit: z.number().int().min(1).max(200) }))
        .output(z.object({ cases: z.array(remarkCaseOutput) }))
        .query(async ({ ctx, input }) =>
          guard(async () => {
            assertModerator(ctx.principal, moderatorUserIds);
            return { cases: (await p2p.listRemarkCases(input.limit)).map(toRemarkCaseOut) };
          }),
        ),

      /**
       * MODERATOR ONLY. Release to the buyer, or refund the seller. There is no
       * third option in the input schema, because there is no third option in
       * the escrow: §6.2's promise is that every dispute terminates.
       *
       * Same gate as `list` — not `p2p:write` (that would let either party
       * move the other's escrow) and not a fake auto-ruling.
       *
       * It is also the ONLY way a disputed escrow terminates. The timeout sweep
       * escalates and re-arms; the database refuses a terminal write on a
       * disputed trade without an attributed human ruling behind it.
       */
      /**
       * A moderator re-arms an open dispute the way the timeout sweep does.
       * No escrow movement. The same clientRequestId returns the first result.
       */
      escalate: merchantApiProcedure('p2p:read')
        .input(
          z.object({
            disputeId: z.string().guid(),
            reason: z.string().min(1).max(2000),
            clientRequestId: z.string().min(1).max(128),
          }),
        )
        .output(
          z.object({
            disputeId: z.string().guid(),
            tradeId: z.string().guid(),
            escalatedAt: z.string(),
            escalations: z.number().int(),
            deadlineAt: z.string(),
            actorId: z.string(),
            reason: z.string(),
            replay: z.boolean(),
          }),
        )
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            assertModerator(ctx.principal, moderatorUserIds);
            const row = await p2p.escalateOpenDispute({
              disputeId: input.disputeId,
              actorId: ctx.principal.userId,
              reason: input.reason,
              clientRequestId: input.clientRequestId,
            });
            return {
              disputeId: row.disputeId,
              tradeId: row.tradeId,
              escalatedAt: row.escalatedAt.toISOString(),
              escalations: row.escalations,
              deadlineAt: row.deadlineAt.toISOString(),
              actorId: row.actorId,
              reason: row.reason,
              replay: row.replay,
            };
          }),
        ),

      resolve: merchantApiProcedure('p2p:read')
        .input(
          z.object({
            tradeId: z.string().guid(),
            resolution: z.enum(['release', 'refund']),
            notes: z.string().max(2000).optional(),
            approvalId: z.string().max(128).optional(),
            operationId: z.string().max(128).optional(),
          }),
        )
        .output(tradeOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            assertModerator(ctx.principal, moderatorUserIds);
            const note = input.notes ?? '';
            const trade = await p2p.resolveDispute({
              tradeId: input.tradeId,
              moderatorId: ctx.principal.userId,
              resolution: input.resolution,
              ...(input.notes ? { notes: input.notes } : {}),
              fourEyes: disputeResolveRequiresApproval,
              ...(disputeResolveRequiresApproval
                ? {
                    consumeApproval: async (binding: { disputeId: string; winner: 'buyer' | 'seller'; note: string }) => {
                      const approvalId = input.approvalId?.trim() ?? '';
                      const operationId = input.operationId?.trim() ?? '';
                      if (!approvalId || !operationId) {
                        throw new P2pError(
                          'p2p.dispute_resolve_no_four_eyes — P2P_DISPUTE_RESOLVE_REQUIRES_APPROVAL is on and this ruling has no approval',
                          'p2p.dispute_resolve_no_four_eyes',
                        );
                      }
                      if (binding.note !== note) {
                        throw new P2pError(
                          'p2p.dispute_resolve_approval_mismatch — payload hash does not match the approved action',
                          'p2p.dispute_resolve_approval_mismatch',
                        );
                      }
                      try {
                        await consumeDisputeResolveApproval(approvals, {
                          approvalId,
                          operationId,
                          disputeId: binding.disputeId,
                          winner: binding.winner,
                          note: binding.note,
                        });
                      } catch (err) {
                        mapDisputeApprovalError(err);
                      }
                    },
                  }
                : {}),
            });

            /**
             * D26-P1-I2 / D-S-08: a moderated loss must pull the merchant badge.
             * Escrow already moved in `resolveDispute`; this only revises
             * standing so API keys and offer ceilings stop vouching for the loser.
             * release → seller lost; refund → buyer lost (same attribution as reputation).
             */
            if (merchants) {
              const loserId = input.resolution === 'release' ? trade.sellerId : trade.buyerId;
              const dispute = await p2p.getDispute(input.tradeId);
              await merchants.suspendIfStandingBrokenByDisputeLaw({
                userId: loserId,
                tradeId: input.tradeId,
                disputeId: dispute.id,
                actorId: ctx.principal.userId,
                actorScope: ctx.principal.scopes.includes('admin:compliance') ? 'admin:compliance' : 'p2p:read',
              });
            }

            return toTradeOut(trade);
          }),
        ),

      /**
       * The caller's own disputes. `disputes.list` stays moderator-only.
       * Evidence is the caller's own submissions, same rule as `disputes.get`.
       */
      mine: merchantApiProcedure('p2p:read')
        .input(
          z
            .object({
              status: z.enum(['open', 'resolved']).optional(),
              limit: z.number().int().min(1).max(200).optional(),
              cursor: z.string().max(200).nullable().optional(),
            })
            .optional(),
        )
        .output(z.object({ disputes: z.array(disputeOutput), nextCursor: z.string().nullable() }))
        .query(async ({ ctx, input }) =>
          guard(async () => {
            const page = await p2p.listMyDisputes({
              userId: ctx.principal.userId,
              ...(input?.status ? { status: input.status } : {}),
              ...(input?.limit ? { limit: input.limit } : {}),
              ...(input?.cursor ? { cursor: input.cursor } : {}),
            });
            return {
              disputes: page.disputes.map((row) => toDisputeOut(row, ctx.principal.userId)),
              nextCursor: page.nextCursor,
            };
          }),
        ),

      /**
       * OPERATOR COUNTS for the queue — open / overdue / escalated / neverSeen.
       *
       * `/internal/moderation-backlog` already serves this to service callers.
       * Without a tRPC surface, an allowlisted moderator with ordinary
       * `p2p:read` could list rows but not see the SLA shape of the backlog
       * (the number that grows when nobody is on shift). Same gate as `list`.
       */
      backlog: scopedProcedure('p2p:read', { module: 'p2p' })
        .output(
          z.object({
            open: z.number().int().nonnegative(),
            overdue: z.number().int().nonnegative(),
            escalated: z.number().int().nonnegative(),
            neverSeen: z.number().int().nonnegative(),
            moderationConfigured: z.boolean(),
            moderation: moderationHonestySchema,
          }),
        )
        .query(async ({ ctx }) =>
          guard(async () => {
            assertModerator(ctx.principal, moderatorUserIds);
            const backlog = await p2p.moderationBacklog();
            return { ...backlog, ...moderationPublic };
          }),
        ),
    }),

    /**
     * Operator surface for committed decisions whose ledger post is late
     * (ADR 2026-08-04 — permanently-failed / late settlements).
     *
     * Sweep failures already log reasons each tick; this list is the query a
     * human dashboard can call without grepping process logs. `admin:compliance`
     * only — not either party's `p2p:write`.
     */
    ops: router({
      lateSettlements: scopedProcedure('admin:compliance', { module: 'p2p' })
        .input(
          z
            .object({
              /**
               * Page size. Optional here so omit reaches the service named
               * refuse (`p2p.late_settlements_list_limit_unset`) instead of a
               * Zod "Required" that looks like a typo. Blank is not 100; pass
               * 100 explicitly when that is the page you want.
               */
              limit: z.number().int().min(1).max(200).optional(),
            })
            .optional(),
        )
        .output(
          z.object({
            trades: z.array(
              z.object({
                tradeId: z.string().guid(),
                status: z.enum(['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed']),
                resolution: z.enum(['released', 'refunded', 'voided']).nullable(),
                resolutionReason: z.string().nullable(),
                resolvedAt: z.string(),
                ageSeconds: z.number().int().nonnegative(),
                lastSettleError: z.string().nullable(),
                lastSettleErrorAt: z.string().nullable(),
              }),
            ),
          }),
        )
        .query(async ({ input }) =>
          guard(async () => {
            const rows = await p2p.listLateSettlements(input?.limit);
            return {
              trades: rows.map((r) => ({
                tradeId: r.tradeId,
                status: r.status,
                resolution: r.resolution,
                resolutionReason: r.resolutionReason,
                resolvedAt: r.resolvedAt.toISOString(),
                ageSeconds: r.ageSeconds,
                lastSettleError: r.lastSettleError,
                lastSettleErrorAt: r.lastSettleErrorAt?.toISOString() ?? null,
              })),
            };
          }),
        ),

      offers: scopedProcedure('admin:compliance', { module: 'p2p' })
        .input(
          z.object({
            status: z.enum(['active', 'paused', 'closed']),
            limit: z.number().int().min(1).max(200).optional(),
            cursor: z.string().max(500).nullable().optional(),
          }),
        )
        .output(
          z.object({
            offers: z.array(
              z.object({
                id: z.string().guid(),
                makerId: z.string(),
                side: z.enum(['buy', 'sell']),
                asset: z.string(),
                fiatCurrency: z.string(),
                price: z.string(),
                minAmount: z.string(),
                maxAmount: z.string(),
                totalAmount: z.string(),
                remainingAmount: z.string(),
                status: z.enum(['active', 'paused', 'closed']),
                methodIds: z.array(z.string()),
                createdAt: z.string(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        )
        .query(async ({ input }) =>
          guard(async () =>
            requireOpsReads().offers({
              status: input.status,
              ...(input.limit !== undefined ? { limit: input.limit } : {}),
              ...(input.cursor ? { cursor: input.cursor } : {}),
            }),
          ),
        ),

      trades: scopedProcedure('admin:compliance', { module: 'p2p' })
        .input(
          z.object({
            status: z.enum(['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed']),
            limit: z.number().int().min(1).max(200).optional(),
            cursor: z.string().max(500).nullable().optional(),
          }),
        )
        .output(
          z.object({
            trades: z.array(
              z.object({
                id: z.string().guid(),
                offerId: z.string().guid(),
                makerId: z.string(),
                takerId: z.string(),
                buyerId: z.string(),
                sellerId: z.string(),
                asset: z.string(),
                fiatCurrency: z.string(),
                amount: z.string(),
                price: z.string(),
                fiatAmount: z.string(),
                method: z.string(),
                feeBps: z.number().int(),
                status: z.enum(['created', 'escrowed', 'fiat_sent', 'released', 'cancelled', 'disputed']),
                resolution: z.enum(['released', 'refunded', 'voided']).nullable(),
                createdAt: z.string(),
              }),
            ),
            nextCursor: z.string().nullable(),
          }),
        )
        .query(async ({ input }) =>
          guard(async () =>
            requireOpsReads().trades({
              status: input.status,
              ...(input.limit !== undefined ? { limit: input.limit } : {}),
              ...(input.cursor ? { cursor: input.cursor } : {}),
            }),
          ),
        ),

      counts: scopedProcedure('admin:compliance', { module: 'p2p' })
        .output(
          z.object({
            offers: z.object({
              active: z.number().int().nonnegative(),
              paused: z.number().int().nonnegative(),
              closed: z.number().int().nonnegative(),
            }),
            trades: z.object({
              created: z.number().int().nonnegative(),
              escrowed: z.number().int().nonnegative(),
              fiat_sent: z.number().int().nonnegative(),
              released: z.number().int().nonnegative(),
              cancelled: z.number().int().nonnegative(),
              disputed: z.number().int().nonnegative(),
            }),
          }),
        )
        .query(async () => guard(async () => requireOpsReads().counts())),

      disputeRate24h: scopedProcedure('admin:compliance', { module: 'p2p' })
        .output(
          z.object({
            disputesOpened24h: z.number().int().nonnegative(),
            tradesCreated24h: z.number().int().nonnegative(),
            rate: z.string().nullable(),
          }),
        )
        .query(async () => guard(async () => requireOpsReads().disputeRate24h())),
    }),

    /**
     * WHAT WE HOLD ABOUT YOU, AND GETTING RID OF IT (§0.9).
     *
     * Self-only, and there is no `userId` in either input — the caller is the
     * subject, always. An export endpoint that takes a user id is a data-breach
     * endpoint with a friendly name.
     *
     * Mounted only when the service was built with an erasure collaborator, so
     * `p2p.erase` cannot exist in a half-wired deployment and refuse for the
     * wrong reason.
     */
    data: router({
      export: merchantApiProcedure('p2p:read')
        .output(
          z.object({
            userId: z.string(),
            at: z.string(),
            offers: z.array(z.unknown()),
            trades: z.array(z.unknown()),
            disputes: z.array(z.unknown()),
            /** Reviews this person wrote or received, including hidden ones. They are still held. */
            orderReviews: z.array(z.unknown()),
            remarkCases: z.array(z.unknown()),
            /** P-ads-merchant-06: the person's ad edits counted against the daily cap. */
            offerEdits: z.array(z.unknown()),
            /** P-ads-merchant-07: links the person made to their ads (no tokens; only their hashes are held). */
            shareLinks: z.array(z.unknown()),
            /** P-ads-merchant-08: the person's presence and their bulk ad actions' results. */
            presence: z.unknown().nullable(),
            bulkRuns: z.array(z.unknown()),
            reputation: z.unknown().nullable(),
            /**
             * Headers only. The values live behind `instruments.reveal`, which
             * writes an access-log row in the same statement that reads them —
             * and an export that also served them would be a second way to read
             * an account number with nothing recording that anyone did.
             */
            instruments: z.array(z.unknown()),
            /** Past P2P risk notice acceptances, still held though no take reads them. */
            riskAcceptances: z.array(z.unknown()),
            /** What a reader must go elsewhere for. Omitting this would be a lie by omission. */
            notCovered: z.array(z.string()),
          }),
        )
        .query(async ({ ctx }) =>
          guard(async () => {
            const out = await requireErasure(erasure).exportFor(ctx.principal.userId);
            return { ...out, at: out.at.toISOString(), reputation: out.reputation ?? null };
          }),
        ),

      erase: merchantApiProcedure('p2p:write')
        .output(
          z.object({
            userId: z.string(),
            at: z.string(),
            erased: z.array(z.object({ category: z.string(), rows: z.number().int() })),
            /**
             * NAMED, COUNTED AND EXPLAINED. An erase that quietly keeps half the
             * record is worse than one that refuses: the person believes
             * something untrue and finds out in a dispute.
             */
            retained: z.array(z.object({ category: z.string(), rows: z.number().int(), reason: z.string() })),
          }),
        )
        .mutation(async ({ ctx }) =>
          guard(async () => {
            const report = await requireErasure(erasure).eraseFor(ctx.principal.userId);
            return {
              userId: report.userId,
              at: report.at.toISOString(),
              erased: report.erased.map((l) => ({ category: l.category, rows: l.rows })),
              retained: report.retained.map((l) => ({ category: l.category, rows: l.rows, reason: l.reason ?? '' })),
            };
          }),
        ),
    }),

    chat: router({
      messages: router({
        list: merchantApiProcedure('p2p:read')
          .input(
            z.object({
              tradeId: z.string().guid(),
              cursor: z.string().guid().nullable().optional(),
              limit: z.number().int().min(1).max(200).optional(),
            }),
          )
          .output(
            z.object({
              messages: z.array(
                z.object({
                  id: z.string().guid(),
                  tradeId: z.string().guid(),
                  senderId: z.string(),
                  clientId: z.string(),
                  text: z.string(),
                  createdAt: z.string(),
                }),
              ),
              nextCursor: z.string().nullable(),
              unread: z.number().int().nonnegative(),
            }),
          )
          .query(async ({ ctx, input }) =>
            guard(async () => {
              const page = await p2p.listChatMessages({
                tradeId: input.tradeId,
                viewerId: ctx.principal.userId,
                asModerator: isModerator(ctx.principal, moderatorUserIds),
                cursor: input.cursor ?? null,
                limit: input.limit,
              });
              return {
                messages: page.messages.map((message) => ({
                  id: message.id,
                  tradeId: message.tradeId,
                  senderId: message.senderId,
                  clientId: message.clientId,
                  text: message.text,
                  createdAt: message.createdAt.toISOString(),
                })),
                nextCursor: page.nextCursor,
                unread: page.unread,
              };
            }),
          ),

        send: merchantApiProcedure('p2p:read')
          .input(
            z.object({
              tradeId: z.string().guid(),
              text: z.string().min(1).max(2000),
              clientId: z.string().min(1).max(128),
              /** No object store is wired. Any attachment refuses before a row is written. */
              attachment: z.unknown().optional(),
            }),
          )
          .output(
            z.object({
              id: z.string().guid(),
              tradeId: z.string().guid(),
              senderId: z.string(),
              clientId: z.string(),
              text: z.string(),
              createdAt: z.string(),
              created: z.boolean(),
              notify: z.object({
                delivered: z.boolean(),
                code: z.enum(['p2p.chat_notify_delivered', 'p2p.chat_notify_unwired', 'p2p.chat_notify_failed']),
              }),
            }),
          )
          .mutation(async ({ ctx, input }) =>
            guard(async () => {
              const moderator = isModerator(ctx.principal, moderatorUserIds);
              if (!ctx.principal.scopes.includes('p2p:write')) {
                const disputeOpen = moderator && (await p2p.disputeOpen(input.tradeId));
                if (!disputeOpen) {
                  throw new TRPCError({
                    code: 'FORBIDDEN',
                    message: 'Sending in a trade chat requires p2p:write.',
                  });
                }
              }
              const sent = await p2p.sendChatMessage({
                tradeId: input.tradeId,
                senderId: ctx.principal.userId,
                clientId: input.clientId,
                text: input.text,
                asModerator: isModerator(ctx.principal, moderatorUserIds),
                ...(input.attachment !== undefined ? { attachment: input.attachment } : {}),
              });
              let notify: { delivered: boolean; code: 'p2p.chat_notify_delivered' | 'p2p.chat_notify_unwired' | 'p2p.chat_notify_failed' } =
                { delivered: false, code: 'p2p.chat_notify_unwired' };
              if (!sent.created) {
                notify = { delivered: false, code: 'p2p.chat_notify_unwired' };
              } else if (!chatNotify) {
                notify = { delivered: false, code: 'p2p.chat_notify_unwired' };
              } else {
                const trade = await p2p.getTrade(input.tradeId);
                const recipientIds = [trade.buyerId, trade.sellerId].filter((id) => id !== ctx.principal.userId);
                try {
                  await chatNotify.messageSent({
                    tradeId: input.tradeId,
                    messageId: sent.message.id,
                    senderId: ctx.principal.userId,
                    recipientIds,
                  });
                  notify = { delivered: true, code: 'p2p.chat_notify_delivered' };
                } catch {
                  notify = { delivered: false, code: 'p2p.chat_notify_failed' };
                }
              }
              return {
                id: sent.message.id,
                tradeId: sent.message.tradeId,
                senderId: sent.message.senderId,
                clientId: sent.message.clientId,
                text: sent.message.text,
                createdAt: sent.message.createdAt.toISOString(),
                created: sent.created,
                notify,
              };
            }),
          ),
      }),

      unread: merchantApiProcedure('p2p:read')
        .input(z.object({ tradeId: z.string().guid() }))
        .output(z.object({ tradeId: z.string().guid(), unread: z.number().int().nonnegative() }))
        .query(async ({ ctx, input }) =>
          guard(async () => ({
            tradeId: input.tradeId,
            unread: await p2p.unreadChat({
              tradeId: input.tradeId,
              viewerId: ctx.principal.userId,
              asModerator: isModerator(ctx.principal, moderatorUserIds),
            }),
          })),
        ),
    }),

    contacts: router({
      list: merchantApiProcedure('p2p:read')
        .output(z.object({ following: z.array(z.string()), blocking: z.array(z.string()) }))
        .query(async ({ ctx }) => guard(async () => p2p.listContacts(ctx.principal.userId))),

      follow: merchantApiProcedure('p2p:write')
        .input(z.object({ peerId: z.string().guid(), idempotencyKey: z.string().min(8).max(128) }))
        .output(z.object({ following: z.array(z.string()), blocking: z.array(z.string()) }))
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            p2p.setContact({
              ownerId: ctx.principal.userId,
              peerId: input.peerId,
              kind: 'follow',
              present: true,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),

      unfollow: merchantApiProcedure('p2p:write')
        .input(z.object({ peerId: z.string().guid(), idempotencyKey: z.string().min(8).max(128) }))
        .output(z.object({ following: z.array(z.string()), blocking: z.array(z.string()) }))
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            p2p.setContact({
              ownerId: ctx.principal.userId,
              peerId: input.peerId,
              kind: 'follow',
              present: false,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),

      block: merchantApiProcedure('p2p:write')
        .input(z.object({ peerId: z.string().guid(), idempotencyKey: z.string().min(8).max(128) }))
        .output(z.object({ following: z.array(z.string()), blocking: z.array(z.string()) }))
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            p2p.setContact({
              ownerId: ctx.principal.userId,
              peerId: input.peerId,
              kind: 'block',
              present: true,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),

      unblock: merchantApiProcedure('p2p:write')
        .input(z.object({ peerId: z.string().guid(), idempotencyKey: z.string().min(8).max(128) }))
        .output(z.object({ following: z.array(z.string()), blocking: z.array(z.string()) }))
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            p2p.setContact({
              ownerId: ctx.principal.userId,
              peerId: input.peerId,
              kind: 'block',
              present: false,
              idempotencyKey: input.idempotencyKey,
            }),
          ),
        ),
    }),

    /**
     * P-ads-merchant-21. One review per party on a released trade. The order
     * page and the counterparty card read these. A second leave returns the
     * first. Edit needs an owner window; a blank window refuses.
     */
    reviews: router({
      leave: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            tradeId: z.string().guid(),
            rating: z.enum(['good', 'bad']),
            comment: z.string().max(2000).optional(),
            explanation: z.string().max(2000).optional(),
          }),
        )
        .output(reviewOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            toReviewOut(
              await p2p.leaveOrderReview({
                tradeId: input.tradeId,
                authorId: requireUser(ctx),
                rating: input.rating,
                ...(input.comment === undefined ? {} : { comment: input.comment }),
                ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
              }),
            ),
          ),
        ),

      edit: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            tradeId: z.string().guid(),
            rating: z.enum(['good', 'bad']).optional(),
            comment: z.string().max(2000).optional(),
            explanation: z.string().max(2000).optional(),
          }),
        )
        .output(reviewOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            toReviewOut(
              await p2p.editOrderReview({
                tradeId: input.tradeId,
                authorId: requireUser(ctx),
                ...(input.rating === undefined ? {} : { rating: input.rating }),
                ...(input.comment === undefined ? {} : { comment: input.comment }),
                ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
              }),
            ),
          ),
        ),

      reply: merchantApiProcedure('p2p:write')
        .input(z.object({ tradeId: z.string().guid(), text: z.string().max(2000) }))
        .output(reviewOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            toReviewOut(await p2p.replyOrderReview({ tradeId: input.tradeId, subjectId: requireUser(ctx), text: input.text })),
          ),
        ),

      list: merchantApiProcedure('p2p:read')
        .input(
          z.object({
            userId: z.string().guid(),
            /** Omitted so a missing page reaches `p2p.review_list_limit_unset`, not a Zod "Required". Blank is not 50. */
            limit: z.number().int().min(1).max(200).optional(),
            cursor: z.string().max(200).nullable().optional(),
          }),
        )
        .output(z.object({ reviews: z.array(reviewOutput), nextCursor: z.string().nullable() }))
        .query(async ({ ctx, input }) =>
          guard(async () => {
            const viewer = requireUser(ctx);
            // The same block reputation.get honours: a blocked pair reads neither the card nor the reviews behind it.
            await p2p.assertNotBlocked(viewer, input.userId);
            const page = await p2p.listOrderReviews({
              subjectId: input.userId,
              viewerId: viewer,
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.cursor ? { cursor: input.cursor } : {}),
            });
            // Who reviewed and on which order stays with the two people on it; anyone else reads the words and the rating.
            return { reviews: page.reviews.map((row) => toReviewOut(row, viewer)), nextCursor: page.nextCursor };
          }),
        ),

      /** The order page's review panel: the viewer's own review of this trade and the visible one about them. */
      forTrade: merchantApiProcedure('p2p:read')
        .input(z.object({ tradeId: z.string().guid() }))
        .output(z.object({ mine: reviewOutput.nullable(), theirs: reviewOutput.nullable() }))
        .query(async ({ ctx, input }) =>
          guard(async () => {
            const both = await p2p.orderReviewsForTrade({ tradeId: input.tradeId, viewerId: requireUser(ctx) });
            return { mine: both.mine && toReviewOut(both.mine), theirs: both.theirs && toReviewOut(both.theirs) };
          }),
        ),

      moderate: merchantApiProcedure('p2p:read')
        .input(z.object({ reviewId: z.string().guid(), reason: z.string().min(1).max(2000) }))
        .output(reviewOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            assertModerator(ctx.principal, moderatorUserIds);
            return toReviewOut(
              await p2p.moderateOrderReview({ reviewId: input.reviewId, actorId: requireUser(ctx), reason: input.reason }),
            );
          }),
        ),
    }),

    reputation: router({
      /** P-trade-orders-21: the caller's one-time completion appeal; null while still available. */
      myAppeal: merchantApiProcedure('p2p:read')
        .output(appealOutput.nullable())
        .query(async ({ ctx }) => guard(async () => p2p.myCompletionAppeal(requireUser(ctx)))),

      appeal: merchantApiProcedure('p2p:write')
        .input(z.object({ tradeId: z.string().guid(), reason: z.string().max(2000) }))
        .output(appealOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => p2p.submitCompletionAppeal({ userId: requireUser(ctx), tradeId: input.tradeId, reason: input.reason })),
        ),

      /**
       * §6.2 → §4.1. The numbers a counterparty sees before they trade with
       * you, and the same numbers that feed the XP graph raising limits
       * everywhere else.
       */
      get: merchantApiProcedure('p2p:read')
        .input(z.object({ userId: z.string().guid() }))
        .output(reputationOutput)
        .query(async ({ ctx, input }) =>
          guard(async () => {
            // A blocked pair cannot see each other's card: the block is the
            // viewer's (or the subject's) decision not to deal, and a profile is
            // the first step of a deal.
            await p2p.assertNotBlocked(requireUser(ctx), input.userId);
            const r = await p2p.reputationOf(input.userId);
            const record = merchants ? await merchants.get(input.userId) : null;
            const rates = await p2p.completionRatesOf(input.userId);
            const reputationDoor = {
              ...reputationOnPublicDoor(r, programmeVouch(record?.status, Boolean(merchants))),
              completionRate30d: rates.completionRate30d,
              completionRateTotal: rates.completionRateTotal,
              completionDefinition: COMPLETION_DEFINITION,
            };
            const trades30d = await p2p.tradesInWindow(input.userId);
            const { avgPaySecs } = await p2p.payTimingOf(input.userId);
            const rating = await p2p.reviewRating(input.userId);
            const door = { ...reputationDoor, avgPaySecs, rating, verification: null as { level: string } | null };
            if (!publicProfile) {
              return {
                ...door,
                handle: null,
                memberSince: null,
                profile: { status: 'unwired' as const, code: 'p2p.public_profile_unwired' as const },
                trades30d,
              };
            }
            const found = await publicProfile.lookup(input.userId);
            if (!found && r.tradesTotal === 0) {
              // Identity knows no such person and this service has no trade
              // with them: there is no counterparty, not an empty one.
              throw new P2pError('p2p.user_not_found', 'p2p.user_not_found');
            }
            if (!found) {
              return {
                ...door,
                handle: null,
                memberSince: null,
                profile: { status: 'absent' as const, code: 'p2p.public_profile_absent' as const },
                trades30d,
              };
            }
            return {
              ...door,
              verification: found.verificationLevel ? { level: found.verificationLevel } : null,
              handle: found.handle,
              memberSince: found.memberSince,
              profile: { status: 'found' as const, code: 'p2p.public_profile_found' as const },
              trades30d,
            };
          }),
        ),
    }),

    /**
     * THE MERCHANT PROGRAMME (TRK-p2p.merchants Stage 1).
     *
     * Membership only. Badges and limit ENFORCEMENT are Stage 2 and read this;
     * escrow still moves every coin through ledger recipes, so nothing here is
     * a balance or a custody grant.
     *
     * `merchants` is undefined when the service was not wired, and every
     * procedure then refuses honestly rather than pretending the programme is
     * empty — the same shape `moderationConfigured` uses above.
     */
    merchants: router({
      /**
       * P-ads-merchant-08: the caller's presence. Offline, or scheduled outside every window, takes their ads off the
       * board for others; open orders carry on. `nextChangeAt` is when a schedule next puts them on or off the board.
       */
      presence: merchantApiProcedure('p2p:read')
        .output(presenceOutput)
        .query(async ({ ctx }) => guard(async () => presentPresence(await p2p.presence(requireUser(ctx))))),

      setPresence: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            mode: z.enum(PRESENCE_MODES),
            timezone: z.string().min(1).max(64).optional(),
            windows: z
              .array(z.object({ day: z.number().int().min(1).max(7), start: z.string().max(5), end: z.string().max(5) }))
              .max(MAX_PRESENCE_WINDOWS)
              .optional(),
          }),
        )
        .output(presenceOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            presentPresence(
              await p2p.setPresence(requireUser(ctx), {
                mode: input.mode,
                ...(input.timezone ? { timezone: input.timezone } : {}),
                ...(input.windows ? { windows: input.windows } : {}),
              }),
            ),
          ),
        ),

      /**
       * P-ads-merchant-08: the console to-do list. The caller's open orders that wait on someone, soonest deadline
       * first: pay, release, the other side's move, an open dispute. Each item links to its order.
       */
      todos: merchantApiProcedure('p2p:read')
        .input(z.object({ limit: z.number().int().min(1).max(200) }))
        .output(
          z.object({
            items: z.array(
              z.object({
                kind: z.enum(TODO_KINDS),
                tradeId: z.string(),
                role: z.enum(['buyer', 'seller']),
                status: z.string(),
                asset: z.string(),
                amount: amountString,
                fiatCurrency: z.string(),
                fiatAmount: amountString,
                deadlineAt: z.string().nullable(),
                link: z.string(),
              }),
            ),
          }),
        )
        .query(async ({ ctx, input }) =>
          guard(async () => ({
            items: (await p2p.todos(requireUser(ctx), input.limit)).map((item) => ({
              ...item,
              amount: formatAmount(parseAmount(item.amount)),
              fiatAmount: formatAmount(parseAmount(item.fiatAmount)),
              deadlineAt: item.deadlineAt ? item.deadlineAt.toISOString() : null,
            })),
          })),
        ),

      /**
       * P-ads-merchant-20: the caller's own P2P performance for the user
       * center. Any signed-in trader, merchant or not; recomputed from trades.
       * Volume is decimal strings per (asset, fiat), never a JS number.
       */
      stats: merchantApiProcedure('p2p:read')
        .output(ownStatsOutput)
        .query(async ({ ctx }) => guard(async () => p2p.ownStats(requireUser(ctx)))),

      /**
       * Check whether current standing unlocks the merchant API.
       *
       * This procedure deliberately uses the base scoped guard, not the
       * merchant API guard, so a suspended key can learn why it was refused.
       */
      apiAccess: scopedProcedure('p2p:read', { module: 'p2p' })
        .output(merchantApiAccessOutput)
        .query(async ({ ctx }) =>
          guard(async () => {
            const record = await requireMerchants().get(requireUser(ctx));
            return {
              eligible: record !== null && isActiveMerchant(record.status),
              credential: ctx.principal.kid ? ('api_key' as const) : ('session' as const),
              merchantStatus: record?.status ?? null,
              keyPlane: 'identity' as const,
              rateLimitPlane: 'edge' as const,
              disputeResolution: 'interactive_human_only' as const,
            };
          }),
        ),

      /**
       * P-ads-merchant-01. The advertiser terms: the owner-published version and when the caller accepted it, or null.
       * A blank version refuses `p2p.config_unset` naming the setting.
       */
      advertiserTerms: merchantApiProcedure('p2p:read')
        .output(z.object({ version: z.string(), acceptedAt: z.string().nullable() }))
        .query(async ({ ctx }) =>
          guard(async () => {
            const terms = await p2p.advertiserTermsState(requireUser(ctx));
            return { version: terms.version, acceptedAt: terms.acceptedAt?.toISOString() ?? null };
          }),
        ),

      /**
       * Accept exactly the version shown; any other refuses `p2p.terms_version_stale`. Accepting again returns the
       * first acceptance. A person's own act: an API key, or a service holding a forwarded principal, cannot do it.
       */
      acceptAdvertiserTerms: scopedProcedure('p2p:write', { module: 'p2p', person: true })
        .input(z.object({ version: z.string().min(1).max(64) }))
        .output(z.object({ version: z.string(), acceptedAt: z.string() }))
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            if (ctx.principal.kid) {
              throw new TRPCError({ code: 'FORBIDDEN', message: 'Accepting the advertiser terms is interactive only.' });
            }
            const accepted = await p2p.acceptAdvertiserTerms(requireUser(ctx), input.version);
            return { version: accepted.version, acceptedAt: accepted.acceptedAt.toISOString() };
          }),
        ),

      /**
       * P-ads-merchant-12. The posting checklist for one fiat: what compliance published for it (`thresholds`, `none`,
       * `unset` or `invalid`) and every check, met, not met or unknown, with the caller's value and the target as strings.
       * Posting in that fiat refuses on the same checks. The thresholds are per fiat, the same for every coin.
       */
      postingEligibility: merchantApiProcedure('p2p:read')
        .input(z.object({ fiatCurrency: z.string().length(3) }))
        .output(
          z.object({
            fiatCurrency: z.string(),
            policy: z.enum(POSTING_POLICIES),
            checks: z.array(
              z.object({
                id: z.enum(POSTING_CHECK_IDS),
                state: z.enum(POSTING_CHECK_STATES),
                current: z.string().nullable(),
                required: z.string().nullable(),
                reason: z.string(),
              }),
            ),
          }),
        )
        .query(async ({ ctx, input }) =>
          guard(async () => {
            const eligibility = await p2p.postingEligibility({
              userId: requireUser(ctx),
              tier: ctx.principal.tier,
              fiatCurrency: input.fiatCurrency,
            });
            return { fiatCurrency: input.fiatCurrency.toUpperCase(), ...eligibility };
          }),
        ),

      /** Your own standing. Null means never applied — not "rejected". */
      me: merchantApiProcedure('p2p:read')
        .output(merchantOutput.nullable())
        .query(async ({ ctx }) =>
          guard(async () => {
            const record = await requireMerchants().get(requireUser(ctx));
            return record ? toMerchantOut(record) : null;
          }),
        ),

      /**
       * Deployment offer ceilings (TRK-p2p.merchants Stage 2 honest API).
       *
       * Policy, not standing: any reader with `p2p:read` can see what the
       * house has armed. Null maxes mean unlimited — the badge buys nothing
       * until an operator sets env. Magnitudes are never invented here.
       */
      offerLimits: merchantApiProcedure('p2p:read')
        .output(offerLimitsOutput)
        .query(() => limitsOnWire(offerLimits)),

      /**
       * The ceiling that binds the CALLER right now.
       *
       * Combines standing (from the programme) with the deployment policy so
       * a maker can show "you may offer up to X" before they type a size that
       * will refuse. Never applied → standard band; approved → merchant band.
       */
      myOfferCeiling: merchantApiProcedure('p2p:read')
        .output(myOfferCeilingOutput)
        .query(async ({ ctx }) =>
          guard(async () => {
            const userId = requireUser(ctx);
            const record = await requireMerchants().get(userId);
            return ceilingOnWire(record?.status ?? null, offerLimits);
          }),
        ),

      /**
       * Apply on your own behalf. The user id comes from the PRINCIPAL, never
       * from the input — an applicant who could name the account would be
       * applying for somebody else's.
       */
      // `submitApplication`, not `apply` — tRPC reserves that name because it
      // collides with Function.prototype.apply on the router object.
      submitApplication: merchantApiProcedure('p2p:write')
        .output(merchantOutput)
        .mutation(async ({ ctx }) => guard(async () => toMerchantOut(await requireMerchants().apply(requireUser(ctx), 'p2p:write')))),

      /** Leave the programme. Self-service, and terminal — re-entry is a new application. */
      withdraw: merchantApiProcedure('p2p:write')
        .input(z.object({ reason: z.string().min(1) }))
        .output(merchantOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const userId = requireUser(ctx);
            return toMerchantOut(
              await requireMerchants().transition({
                userId,
                to: 'withdrawn',
                by: 'self',
                reason: input.reason,
                actorId: userId,
                actorScope: 'p2p:write',
              }),
            );
          }),
        ),

      /**
       * Operator freeze / restore / reject. Dual-control: signed
       * `admin:compliance` + MFA + identity-consumed approval. A typed-in
       * `confirmOperatorId` is not a second person. Missing approval ids refuse
       * — one operator cannot grant or revoke programme privileges a stranger
       * relies on. `admin:compliance` is not in INTERACTIVE_ONLY_SCOPES
       * (value-off-platform test); MFA is applied locally, same as edge
       * kill-switch / kyc.approve. First approval and unfreeze re-check the
       * live reputation snapshot; they do not stamp badges.
       */
      decide: scopedProcedure('admin:compliance', { module: 'p2p' })
        .input(
          z.object({
            userId: z.string().guid(),
            to: z.enum(['approved', 'rejected', 'suspended']),
            reason: z.string().min(1),
            confirmOperatorId: z.string().max(128).nullish(),
            approvalId: z.string().max(128).nullish(),
            operationId: z.string().max(128).nullish(),
          }),
        )
        .output(merchantOutput.extend({ confirmOperatorId: z.string() }))
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            try {
              requireMfa(ctx.principal);
            } catch (err) {
              if (err instanceof AuthError && err.code === 'mfa.required') {
                throw new TRPCError({ code: 'UNAUTHORIZED', message: err.message, cause: err });
              }
              throw err;
            }
            const actorId = requireUser(ctx);
            const confirmOperatorId = await consumeOperatorApproval(input, 'p2p.merchants_decide', {
              userId: input.userId,
              to: input.to,
              reason: input.reason,
            });
            return {
              ...toMerchantOut(
                await requireMerchants().transition({
                  userId: input.userId,
                  to: input.to,
                  by: 'operator',
                  reason: input.reason,
                  // From the principal, never the body: otherwise the history
                  // records who the caller said they were.
                  actorId,
                  actorScope: 'admin:compliance',
                }),
              ),
              confirmOperatorId,
            };
          }),
        ),

      /** Why this merchant stands where they do. Newest first. */
      history: scopedProcedure('admin:compliance', { module: 'p2p' })
        .input(
          z.object({
            userId: z.string().guid(),
            /**
             * Page size. Optional here so omit reaches the service named
             * refuse (`p2p.merchant_history_limit_unset`) instead of a Zod
             * "Required" that looks like a typo. Blank is not 50; pass 50
             * explicitly when that is the page you want.
             */
            limit: z.number().int().min(1).max(200).optional(),
          }),
        )
        .output(z.array(merchantEventOutput))
        .query(async ({ input }) =>
          guard(async () =>
            (await requireMerchants().history(input.userId, input.limit)).map((e: MerchantEvent) => ({
              seq: e.seq,
              fromStatus: e.fromStatus,
              toStatus: e.toStatus,
              reason: e.reason,
              actorId: e.actorId,
              actorScope: e.actorScope,
              createdAt: e.createdAt.toISOString(),
            })),
          ),
        ),
    }),
  });
}

export type P2pRouter = ReturnType<typeof createP2pRouter>;

/**
 * A service built without an erasure collaborator does not get to answer an
 * erasure request with a shrug. `NOT_IMPLEMENTED` says the truth — the code is
 * missing, not the data.
 */
function requireErasure(erasure: P2pErasure | undefined): P2pErasure {
  if (!erasure) {
    throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: 'P2P export and erasure are not wired in this deployment' });
  }
  return erasure;
}

function toOfferOut(
  offer: Awaited<ReturnType<P2pService['getOffer']>>,
  tradesCompleted: number,
  settlements: ReadonlyMap<string, MethodSettlement>,
): OfferOut {
  const nonInstantMethods: OfferOut['nonInstantMethods'] = [];
  for (const id of new Set(offer.methods.map(methodIdFromOfferEntry))) {
    const settlement = id === null ? undefined : settlements.get(id);
    if (id !== null && settlement && !settlement.instant) nonInstantMethods.push({ methodId: id, windowSeconds: settlement.windowSeconds });
  }
  return {
    id: offer.id,
    makerId: offer.makerId,
    side: offer.side,
    asset: offer.asset,
    fiatCurrency: offer.fiatCurrency,
    priceType: offer.priceType,
    price: formatAmount(offer.price),
    minAmount: formatAmount(offer.minAmt),
    maxAmount: formatAmount(offer.maxAmt),
    remainingAmount: formatAmount(offer.remainingAmt),
    totalAmount: formatAmount(offer.totalAmt),
    filledAmount: formatAmount(subAmount(offer.totalAmt, offer.remainingAmt)),
    tradesCompleted,
    methods: offer.methods,
    nonInstantMethods,
    acceptsNonInstant: offer.acceptsNonInstant,
    terms: offer.terms,
    status: offer.status,
    pauseReason: offer.pauseReason ?? null,
    closeReason: offer.closeReason ?? null,
    visibility: offer.visibility ?? 'public',
    statusSince: offer.statusSince.toISOString(),
    relistedFrom: offer.relistedFrom ?? null,
    ...(offer.relistedAs === undefined ? {} : { relistedAs: offer.relistedAs }),
    createdAt: offer.createdAt.toISOString(),
  };
}

function subAmount(total: bigint, remaining: bigint): bigint {
  return total - remaining;
}

function toEvidenceOut(entry: DisputeRecord['evidence'][number]): z.infer<typeof evidenceOutput> {
  return {
    seq: entry.seq,
    submittedBy: entry.submittedBy,
    submittedAt: entry.submittedAt?.toISOString() ?? null,
    item: entry.item,
  };
}

/**
 * `viewerId === null` means a moderator is reading: the whole evidence set.
 *
 * Any other value is a party, and a party sees only what they filed. That is
 * not a serialisation convenience — it is the disclosure decision, made in one
 * place so it cannot be half-made in two. See `evidenceVisibleTo`.
 */
function toDisputeOut(d: DisputeRecord, viewerId: string | null): z.infer<typeof disputeOutput> {
  const evidence = viewerId === null ? d.evidence : evidenceVisibleTo(d, viewerId);
  return {
    id: d.id,
    tradeId: d.tradeId,
    openedBy: d.openedBy,
    openedVia: d.openedVia,
    reason: d.reason,
    chatThreadId: d.chatThreadId,
    status: d.status,
    moderatorId: d.moderatorId,
    resolution: d.resolution,
    resolutionNotes: d.resolutionNotes,
    deadlineAt: d.deadlineAt.toISOString(),
    openedAt: d.openedAt.toISOString(),
    resolvedAt: d.resolvedAt?.toISOString() ?? null,
    evidence: evidence.map(toEvidenceOut),
    overdue: d.status === 'open' && d.deadlineAt.getTime() <= Date.now(),
    escalatedAt: d.escalatedAt?.toISOString() ?? null,
    escalations: d.escalations,
    escalatedBy: d.escalatedBy ?? null,
    escalationReason: d.escalationReason ?? null,
    fourEyes: d.fourEyes ?? null,
    lastSeenByModeratorAt: d.lastSeenByModeratorAt?.toISOString() ?? null,
  };
}

/** The order's escrow still held: all of it until the decision is posted, none after, and none for a void (never locked). */
function escrowHeld(trade: { status: string; resolution: string | null; settledAt: Date | null; amount: Amount }): string | null {
  if (trade.resolution === 'voided') return '0';
  if (trade.status === 'created') return null;
  if (trade.resolution === null || trade.settledAt === null) return formatAmount(trade.amount);
  return '0';
}

function toMismatchOut(report: MismatchReport): z.infer<typeof mismatchOutput> {
  return {
    kind: report.kind,
    amountReceived: formatAmount(report.amountReceived),
    expected: formatAmount(report.expected),
    classification: report.classification,
    toleranceBps: report.toleranceBps,
    reportedAt: report.reportedAt.toISOString(),
  };
}

function toReminderOut(state: ReminderState): z.infer<typeof reminderOutput> {
  return {
    count: state.count,
    lastAt: state.lastAt?.toISOString() ?? null,
    nextAt: state.nextAt?.toISOString() ?? null,
    max: state.max,
  };
}

/** What a release of a held escrow would post, by the same rule as `releaseSplit`. Null when nothing is held. */
function releasePreview(trade: { status: string; amount: Amount; feeBps: number }): { fee: string; netAmount: string } | null {
  if (trade.status !== 'escrowed' && trade.status !== 'fiat_sent') return null;
  const split = releaseSplit({ resolution: 'released', amount: trade.amount, feeBps: trade.feeBps });
  return split.fee !== null && split.netAmount !== null ? { fee: split.fee, netAmount: split.netAmount } : null;
}

/**
 * What a released order paid the buyer and the house: the same `mulBps` the ledger's `escrowRelease` posts with, on the
 * rate frozen at take. Null for anything not released, and for a split with nothing left for the buyer (the release
 * refuses that, `assertReleasePostable`, so a released order never has one).
 */
function releaseSplit(trade: { resolution: string | null; amount: Amount; feeBps: number }): {
  fee: string | null;
  netAmount: string | null;
} {
  if (trade.resolution !== 'released') return { fee: null, netAmount: null };
  const fee = mulBps(trade.amount, trade.feeBps);
  const net = sub(trade.amount, fee);
  return net > 0n ? { fee: formatAmount(fee), netAmount: formatAmount(net) } : { fee: null, netAmount: null };
}

function toTradeOut(trade: Awaited<ReturnType<P2pService['getTrade']>>): TradeOut {
  return {
    id: trade.id,
    offerId: trade.offerId,
    sharedFrom: trade.sharedFrom === true,
    sellerId: trade.sellerId,
    buyerId: trade.buyerId,
    asset: trade.asset,
    amount: formatAmount(trade.amount),
    fiatCurrency: trade.fiatCurrency,
    fiatAmount: formatAmount(trade.fiatAmount),
    price: formatAmount(trade.price),
    method: trade.method,
    status: trade.status,
    resolution: trade.resolution,
    deadlineAt: trade.deadlineAt?.toISOString() ?? null,
    createdAt: trade.createdAt.toISOString(),
    escrowedAt: trade.escrowedAt?.toISOString() ?? null,
    resolvedAt: trade.resolvedAt?.toISOString() ?? null,
    settledAt: trade.settledAt?.toISOString() ?? null,
  };
}
