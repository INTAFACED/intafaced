import { z } from 'zod';
import { AuthError, requireMfa } from '@intafaced/auth';
import { router, publicProcedure, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { enabledFiat } from '@intafaced/config';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import {
  ActionApprovalConsumeError,
  p2pActionPayloadHash,
  readApprovalIds,
  type ActionApprovalConsumer,
  unwiredApprovalConsumer,
} from './action-approval-consume.js';
import type { P2pErasure } from './erasure.js';
import {
  MAX_EVIDENCE_PER_CALL,
  P2pError,
  PricingError,
  unknownTrade,
  TradeStateError,
  evidenceVisibleTo,
  type DisputeRecord,
  type P2pService,
} from './p2p-service.js';
import { InstrumentError } from './instruments.js';
import type { InstrumentService } from './instrument-service.js';
import { assertModerator, isModerationConfigured, isModerator } from './moderation-auth.js';
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
import type { MerchantEvent, MerchantRecord, MerchantService } from './merchant-service.js';
import { BlockRfqError, type BlockRfqService } from './block-rfq.js';
import { refuseLiveOffersUntilOwnerKms } from './instrument-kms.js';

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

const offerOutput = z.object({
  id: z.string().uuid(),
  makerId: z.string(),
  side: z.enum(['buy', 'sell']),
  asset: z.string(),
  fiatCurrency: z.string(),
  priceType: z.enum(['fixed', 'float']),
  price: amountString,
  minAmount: amountString,
  maxAmount: amountString,
  remainingAmount: amountString,
  methods: z.array(z.unknown()),
  terms: z.string(),
  status: z.enum(['active', 'paused', 'closed']),
  createdAt: z.string(),
});

const tradeOutput = z.object({
  id: z.string().uuid(),
  offerId: z.string().uuid(),
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

const blockQuoteOutput = z.object({
  quoteId: z.string().uuid(),
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
  id: z.string().uuid(),
  tradeId: z.string().uuid(),
  openedBy: z.string(),
  /**
   * How the dispute was opened. `timeout` means the fiat_sent clock filed it;
   * `openedBy` is then the party of interest (buyer), not a claim they pressed
   * "open dispute". Same honesty class as evidence going write-only.
   */
  openedVia: z.enum(['party', 'timeout']),
  reason: z.string(),
  /** Null only on disputes opened before chat threads were persisted. */
  chatThreadId: z.string().uuid().nullable(),
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
  /** Null until a moderator has actually been served this row. */
  lastSeenByModeratorAt: z.string().nullable(),
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
function toTrpcError(err: unknown): TRPCError {
  // Procedures throw TRPCError deliberately (L2-7 party filter on trades.get /
  // disputes.get → NOT_FOUND, not FORBIDDEN). `guard` funnels every throw
  // through this mapper; re-wrapping those would turn a clean NOT_FOUND into
  // INTERNAL_SERVER_ERROR and undo the IDOR shape the caller is meant to see.
  if (err instanceof TRPCError) return err;

  if (err instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
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
      case 'p2p.rfq_last_look_forbidden':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      default:
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
  }

  if (err instanceof P2pError) {
    switch (err.code) {
      case 'p2p.offer_not_found':
      case 'p2p.trade_not_found':
      case 'p2p.dispute_not_found':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      case 'p2p.not_a_party':
      case 'p2p.not_the_seller':
      case 'p2p.not_the_buyer':
      case 'p2p.self_trade':
      case 'p2p.trading_disabled':
      case 'p2p.not_a_moderator':
        return new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
      // Not a client auth mistake — the deployment has no human who can rule.
      // PRECONDITION_FAILED so an operator dash can alarm on the code, not on
      // a generic FORBIDDEN that looks like a missing scope on the caller.
      case 'p2p.moderation_unreachable':
      case 'p2p.chat_thread_unset':
      // Instruments are jsonb at rest. Live offers stay refuse-closed until
      // OWNER KMS is wired. PRECONDITION_FAILED so an operator dash can alarm
      // on the code, not on a generic BAD_REQUEST that looks like a typo.
      case 'p2p.instrument_kms_required':
      case 'p2p.fee_bps_unset':
      case 'p2p.offer_list_limit_unset':
      case 'p2p.dispute_list_limit_unset':
      case 'p2p.late_settlements_list_limit_unset':
      case 'p2p.trade_list_limit_unset':
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
        return new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
      case 'p2p.merchant_not_found':
        return new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
      // The caller can fix these: earn the record, or supply a reason. Not a
      // permission problem, so not FORBIDDEN — that would send an applicant
      // looking for a scope they already have.
      case 'p2p.merchant_ineligible':
      case 'p2p.merchant_reason_required':
        return new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
      // State, not permission and not a typo: the row is real and the move is
      // wrong for where it currently stands.
      case 'p2p.merchant_exists':
      case 'p2p.merchant_transition_invalid':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      case 'p2p.dispute_already_open':
      case 'p2p.dispute_already_resolved':
      case 'p2p.trade_exists':
      case 'p2p.erase_blocked':
      // CONFLICT and not INTERNAL_SERVER_ERROR: nothing failed. The erase ran
      // out of a database it could honestly report on, wrote nothing, and the
      // caller can simply ask again — which is what a conflict is.
      case 'p2p.erase_raced':
        return new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
      case 'p2p.offer_not_active':
      case 'p2p.offer_method_unsupported':
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
});

const methodSchemaOutput = z.object({
  methodId: z.string(),
  country: z.string(),
  label: z.string(),
  fields: z.array(fieldSpecOutput),
  enabled: z.boolean(),
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
  id: z.string().uuid(),
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
  const approvals = options.approvals ?? unwiredApprovalConsumer();

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
    return consumed.approverId ?? consumed.requesterId;
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
        }),
      )
      .query(() => ({
        ok: true,
        service: 'svc-p2p' as const,
        ...moderationPublic,
        offerLimitsConfigured,
        offerLimitsPosture: offerLimitsPostureValue,
        instrumentKmsConfigured: false as const,
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

    offers: router({
      create: merchantApiProcedure('p2p:write')
        .input(
          z.object({
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
          }),
        )
        .output(offerOutput)
        .mutation(async () => guard(async () => refuseLiveOffersUntilOwnerKms())),

      list: merchantApiProcedure('p2p:read')
        .input(
          z
            .object({
              asset: z.string().optional(),
              fiatCurrency: z.string().length(3).optional(),
              side: z.enum(['buy', 'sell']).optional(),
              /**
               * Page size. Optional here so omit reaches the service named
               * refuse (`p2p.offer_list_limit_unset`) instead of a Zod
               * "Required" that looks like a typo. Blank is not 50; pass 50
               * explicitly when that is the page you want.
               */
              limit: z.number().int().min(1).max(200).optional(),
            })
            .optional(),
        )
        .output(z.array(offerOutput))
        .query(async ({ input }) => guard(async () => (await p2p.listOffers(input ?? {})).map(toOfferOut))),

      get: merchantApiProcedure('p2p:read')
        .input(z.object({ offerId: z.string().uuid() }))
        .output(offerOutput)
        .query(async ({ input }) => guard(async () => toOfferOut(await p2p.getOffer(input.offerId)))),

      close: merchantApiProcedure('p2p:write')
        .input(z.object({ offerId: z.string().uuid() }))
        .output(offerOutput)
        .mutation(async ({ ctx, input }) => guard(async () => toOfferOut(await p2p.closeOffer(input.offerId, ctx.principal.userId)))),

      pause: merchantApiProcedure('p2p:write')
        .input(z.object({ offerId: z.string().uuid() }))
        .output(offerOutput)
        .mutation(async ({ ctx, input }) => guard(async () => toOfferOut(await p2p.pauseOffer(input.offerId, ctx.principal.userId)))),

      resume: merchantApiProcedure('p2p:write')
        .input(z.object({ offerId: z.string().uuid() }))
        .output(offerOutput)
        .mutation(async ({ ctx, input }) => guard(async () => toOfferOut(await p2p.resumeOffer(input.offerId, ctx.principal.userId)))),
    }),

    trades: router({
      /** Take an offer → `escrowLock`. The first money path in this router. */
      take: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            offerId: z.string().uuid(),
            tradeId: z.string().uuid(),
            amount: amountString,
            method: z.string().min(1).max(64),
          }),
        )
        .output(tradeOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            toTradeOut(
              await p2p.takeOffer({
                offerId: input.offerId,
                takerId: ctx.principal.userId,
                amount: parseAmount(input.amount),
                tradeId: input.tradeId,
                method: input.method,
              }),
            ),
          ),
        ),

      markFiatSent: merchantApiProcedure('p2p:write')
        .input(z.object({ tradeId: z.string().uuid() }))
        .output(tradeOutput)
        .mutation(async ({ ctx, input }) => guard(async () => toTradeOut(await p2p.markFiatSent(input.tradeId, ctx.principal.userId)))),

      /** Seller confirms the fiat landed → `escrowRelease`. */
      confirmReceived: merchantApiProcedure('p2p:write')
        .input(z.object({ tradeId: z.string().uuid() }))
        .output(tradeOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => toTradeOut(await p2p.confirmFiatReceived(input.tradeId, ctx.principal.userId))),
        ),

      /** Cancel → `escrowRefund`, in full, to the seller. */
      cancel: merchantApiProcedure('p2p:write')
        .input(z.object({ tradeId: z.string().uuid(), reason: z.string().max(200).optional() }))
        .output(tradeOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => toTradeOut(await p2p.cancelTrade(input.tradeId, ctx.principal.userId, input.reason ?? 'cancelled'))),
        ),

      get: merchantApiProcedure('p2p:read')
        .input(z.object({ tradeId: z.string().uuid() }))
        .output(tradeOutput)
        .query(async ({ ctx, input }) =>
          guard(async () => {
            const trade = await p2p.getTrade(input.tradeId);
            // L2-7: any p2p:read holder could previously read any trade by id.
            if (trade.buyerId !== ctx.principal.userId && trade.sellerId !== ctx.principal.userId) {
              throw unknownTrade(input.tradeId);
            }
            return toTradeOut(trade);
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
        .input(z.object({ tradeId: z.string().uuid() }))
        .output(
          z.object({
            tradeId: z.string().uuid(),
            methodId: z.string(),
            country: z.string(),
            fiatCurrency: z.string(),
            label: z.string(),
            details: instrumentDetailsOutput,
            attachedAt: z.string(),
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
              attachedAt: view.attachedAt.toISOString(),
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
              takerId: z.string().uuid(),
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
        .input(z.object({ quoteId: z.string().uuid(), assertedPrice: amountString.optional() }).strict())
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
        .input(z.object({ quoteId: z.string().uuid() }).strict())
        .output(blockQuoteOutput)
        .mutation(async ({ ctx, input }) => guard(async () => requireBlockRfq().expire(ctx.principal, { quoteId: input.quoteId }))),

      get: merchantApiProcedure('p2p:read')
        .input(z.object({ quoteId: z.string().uuid() }).strict())
        .output(blockQuoteOutput)
        .query(async ({ ctx, input }) => guard(async () => requireBlockRfq().get(ctx.principal, input.quoteId))),

      allocate: merchantApiProcedure('p2p:write')
        .input(
          z
            .object({
              quoteId: z.string().uuid(),
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
              quoteId: z.string().uuid(),
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
              });
              const schema = await instruments.registerMethodSchema({
                methodId: input.methodId,
                country: input.country,
                label: input.label,
                fields: input.fields,
                ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
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
              const confirmOperatorId = await consumeOperatorApproval(input, 'p2p.method_set_enabled', {
                methodId: input.methodId,
                country: input.country,
                enabled: input.enabled ? 'true' : 'false',
              });
              const schema = await instruments.setMethodSchemaEnabled(input.methodId, input.country, input.enabled);
              return { ...schema, fields: [...schema.fields], confirmOperatorId };
            }),
          ),
      }),

      create: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            instrumentId: z.string().uuid(),
            methodId: z.string().min(1).max(64),
            country: z.string().length(2),
            fiatCurrency: z.string().length(3),
            label: z.string().max(120).optional(),
            /** Exactly the fields the method schema declared. An extra key is refused. */
            details: z.record(z.string(), z.string()),
          }),
        )
        .output(instrumentHeaderOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            toHeaderOut(
              await instruments.createInstrument({
                instrumentId: input.instrumentId,
                ownerId: ctx.principal.userId,
                methodId: input.methodId,
                country: input.country,
                fiatCurrency: input.fiatCurrency,
                ...(input.label === undefined ? {} : { label: input.label }),
                details: input.details,
              }),
            ),
          ),
        ),

      /**
       * Edit. Does NOT reach any trade already holding a snapshot — that is the
       * point of the snapshot, not a limitation of this call.
       */
      update: merchantApiProcedure('p2p:write')
        .input(
          z.object({
            instrumentId: z.string().uuid(),
            label: z.string().max(120).optional(),
            details: z.record(z.string(), z.string()).optional(),
          }),
        )
        .output(instrumentHeaderOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            toHeaderOut(
              await instruments.updateInstrument({
                instrumentId: input.instrumentId,
                ownerId: ctx.principal.userId,
                ...(input.label === undefined ? {} : { label: input.label }),
                ...(input.details === undefined ? {} : { details: input.details }),
              }),
            ),
          ),
        ),

      /** Removal is a state change. An in-flight trade keeps working. */
      remove: merchantApiProcedure('p2p:write')
        .input(z.object({ instrumentId: z.string().uuid() }))
        .output(instrumentHeaderOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () =>
            toHeaderOut(await instruments.removeInstrument({ instrumentId: input.instrumentId, ownerId: ctx.principal.userId })),
          ),
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
        .input(z.object({ instrumentId: z.string().uuid() }))
        .output(instrumentHeaderOutput.extend({ details: instrumentDetailsOutput }))
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const revealed = await instruments.revealOwn({ instrumentId: input.instrumentId, viewerId: ctx.principal.userId });
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
              id: z.string().uuid(),
              instrumentId: z.string().uuid().nullable(),
              viewerId: z.string(),
              viewerRole: z.enum(['owner', 'counterparty', 'moderator', 'other']),
              tradeId: z.string().uuid().nullable(),
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
            tradeId: z.string().uuid(),
            reason: z.string().min(1).max(2000),
            evidence: z.array(z.unknown()).max(MAX_EVIDENCE_PER_CALL).optional(),
          }),
        )
        .output(
          z.object({
            disputeId: z.string().uuid(),
            tradeId: z.string().uuid(),
            chatThreadId: z.string().uuid(),
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
            tradeId: z.string().uuid(),
            evidence: z.array(z.unknown()).min(1).max(MAX_EVIDENCE_PER_CALL),
          }),
        )
        .output(z.object({ disputeId: z.string().uuid(), tradeId: z.string().uuid(), evidence: z.array(evidenceOutput) }))
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
        .input(z.object({ tradeId: z.string().uuid() }))
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
      resolve: merchantApiProcedure('p2p:read')
        .input(
          z.object({
            tradeId: z.string().uuid(),
            resolution: z.enum(['release', 'refund']),
            notes: z.string().max(2000).optional(),
          }),
        )
        .output(tradeOutput)
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            assertModerator(ctx.principal, moderatorUserIds);
            const trade = await p2p.resolveDispute({
              tradeId: input.tradeId,
              moderatorId: ctx.principal.userId,
              resolution: input.resolution,
              ...(input.notes ? { notes: input.notes } : {}),
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
                tradeId: z.string().uuid(),
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
            reputation: z.unknown().nullable(),
            /**
             * Headers only. The values live behind `instruments.reveal`, which
             * writes an access-log row in the same statement that reads them —
             * and an export that also served them would be a second way to read
             * an account number with nothing recording that anyone did.
             */
            instruments: z.array(z.unknown()),
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

    reputation: router({
      /**
       * §6.2 → §4.1. The numbers a counterparty sees before they trade with
       * you, and the same numbers that feed the XP graph raising limits
       * everywhere else.
       */
      get: merchantApiProcedure('p2p:read')
        .input(z.object({ userId: z.string().uuid() }))
        .output(reputationOutput)
        .query(async ({ input }) =>
          guard(async () => {
            const r = await p2p.reputationOf(input.userId);
            const record = merchants ? await merchants.get(input.userId) : null;
            return reputationOnPublicDoor(r, programmeVouch(record?.status, Boolean(merchants)));
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
            userId: z.string().uuid(),
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
            userId: z.string().uuid(),
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

function toOfferOut(offer: Awaited<ReturnType<P2pService['getOffer']>>): OfferOut {
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
    methods: offer.methods,
    terms: offer.terms,
    status: offer.status,
    createdAt: offer.createdAt.toISOString(),
  };
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
    lastSeenByModeratorAt: d.lastSeenByModeratorAt?.toISOString() ?? null,
  };
}

function toTradeOut(trade: Awaited<ReturnType<P2pService['getTrade']>>): TradeOut {
  return {
    id: trade.id,
    offerId: trade.offerId,
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
