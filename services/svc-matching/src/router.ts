import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthError, requireMfa, requireScope } from '@intafaced/auth';
import { sbeCodec, type SbeCodec } from '@intafaced/sbe-codec';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { marketLifecycleAdmissionProofSchema, orderSideSchema, timeInForceSchema } from '@intafaced/exchange-contract';
import {
  DEFAULT_SERVICE_BODY_BIND_MODE,
  retainRawBody,
  assertEdgePrincipalLimits,
  edgePrincipalPublicKey,
  EdgeTrustError,
  verifyForwardedPrincipal,
  type EdgePrincipalLimits,
  verifyServiceRequest,
  type ServiceAuthMode,
  type ServiceVerifier,
  type ServiceBodyBindMode,
} from '@intafaced/contracts';
import type { MatchingEngine } from './engine/engine.js';
import type {
  AmendResult,
  CancelledRef,
  EngineAmend,
  EngineOrder,
  EngineSurveillanceCase,
  Fill,
  RestingRef,
  SubmitResult,
} from './engine/types.js';
import { adjudicateSurveillanceCase, detectorGap } from './engine/surveillance-persist.js';
import { fineSurveillanceCase } from './engine/surveillance-case.js';
import { massCancelSessionRefuse, readSessionId } from './engine/mass-cancel.js';
import { installMassQuote, type MassQuoteCommand, type MassQuoteResult } from './engine/mass-quote.js';
import { installMmp } from './engine/mmp.js';
import { missingSessionRefuse } from './engine/session.js';
import { operatorRefuse, readConfirmOperatorId, readOperatorId } from './engine/halt.js';
import { idempotencyKeyOrNull, matchingInFlightRead } from './operator-desk.js';
import {
  ActionApprovalConsumeError,
  ACTION_APPROVAL_MISSING,
  assertFounderAudienceAttestation,
  matchingActionPayloadHash,
  approvalEvidenceRef,
  readApprovalIds,
  unwiredApprovalConsumer,
  sameUser,
  ACTION_APPROVAL_NOT_OPERATOR,
  ACTION_APPROVAL_WRONG_ACTION,
  ACTION_APPROVAL_OPERATORS_UNSET,
  ACTION_APPROVAL_OPERATOR_MISMATCH,
  type ActionApprovalConsumer,
} from './action-approval-consume.js';
import { bindPostOnlyTif, postOnlyCannotRest } from './engine/post-only.js';
import { reconcile } from './reconcile.js';
import { readSpreadListing, spreadIdentity, toWireSpread } from './engine/spread-instrument.js';
import { presentRulebook, readRulebook } from './rulebook.js';
import { l4, nativeL3FromEngine, publicMakerIdentity } from './engine/l3-queue.js';
import {
  MATCHING_L2_LIMIT_UNSET,
  MATCHING_L3_DEPTH_LIMIT_UNSET,
  MATCHING_RESTING_ORDERS_LIMIT_UNSET,
  MATCHING_SURVEILLANCE_CASES_LIMIT_UNSET,
  parseMatchingListQueryLimit,
  parsePublicL2QueryLimit,
} from './l2-limit.js';
import { userCopy } from './user-copy.js';
import {
  concatenateSbePayloads,
  encodeMatchingL2Sbe,
  MATCHING_SBE_REFUSE_HTTP,
  matchingSbeRefuseBody,
  wantsMatchingSbe,
} from './sbe-l2.js';

installMassQuote();
installMmp();

/**
 * HTTP surface.
 *
 * §5.1 specifies gRPC for this service. It is HTTP+JSON here, deliberately and
 * temporarily:
 *
 * SOCKET §13 — gRPC transport. The engine's callable surface is `submit`,
 * `cancel`, and native `amend` — already narrow, already decimal strings. A
 * `.proto` in `packages/contracts` and a thin server in front of the same
 * `MatchingEngine` is the whole change; nothing in `engine/` moves. That proto
 * is a contracts PR (§15.2) and therefore cannot ship in this one.
 */

/** Decimal string. Reusing the exchange contract's rule rather than inventing a second one. */
const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are positive decimal strings with at most 18 decimal places');
/** Offset may be negative. Still a decimal string — never a JSON number. */
const signedDecimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'offsets are signed decimal strings with at most 18 decimal places');

/** §5.1 order types. `take_profit` is mapped down by svc-trade before it reaches here. */
const engineOrderTypeSchema = z.enum(['market', 'limit', 'stop', 'stop_limit']);

const submitBodySchema = z.object({
  orderId: z.string().guid(),
  /** §5.1: account ids only. This service never learns whose account it is. */
  accountId: z.string().min(1).max(128),
  type: engineOrderTypeSchema,
  side: orderSideSchema,
  qty: decimal,
  price: decimal.nullish(),
  stopPrice: decimal.nullish(),
  /** Caller stop trigger. Same money as stopPrice. The engine does not invent one. */
  stopPx: decimal.nullish(),
  tif: timeInForceSchema,
  /** Linked TP+SL sibling. First fill cancels the other; refuse if that sibling is already terminal. */
  ocoSiblingId: z.string().guid().optional(),
  /** One-cancels-other exit pair: take-profit (limit) and stop-loss (stop). Missing a leg refuses; the engine does not invent one. */
  oco: z.boolean().optional(),
  takeProfit: decimal.nullish(),
  stopLoss: decimal.nullish(),
  /** Limit price of the stop-loss leg (a stop-limit instead of a market stop). Needed to bound a buy-side stop. */
  stopLossLimit: decimal.nullish(),
  /** Caller expire instant for GTD/GTT. The engine does not invent one. */
  expireAt: z.string().min(1).optional(),
  /** Caller session for cancel-on-disconnect. Missing is untagged — the engine does not invent one. */
  sessionId: z.string().max(128).optional(),
  /** Rest only if it shrinks this account's position. The engine does not invent a mark. */
  reduceOnly: z.boolean().optional(),
  /** Rest only if it would not take. The engine does not invent a price. */
  postOnly: z.boolean().optional(),
  iceberg: z.boolean().optional(),
  displayQty: decimal.optional(),
  /** Trail distance. Required to rest a trailing stop. The engine does not invent a distance. */
  trail: decimal.nullish(),
  /** Injected mark the trail walks with. The engine does not invent a mark. */
  mark: decimal.nullish(),
  /** Strike. Required to rest an option. The engine does not invent a strike. */
  strike: decimal.nullish(),
  /** Expiry. Required to rest an option. The engine does not invent an expiry. */
  expiry: z.string().nullish(),
  /** Minimum fill qty. Missing or zero is not set. The engine does not invent a default. */
  minQty: decimal.nullish(),
  /** All-or-none. Missing or false is a normal order. The engine does not invent a fill. */
  aon: z.boolean().optional(),
  /** Pegged to caller reference + offset. Missing those refuses. The engine does not invent a mid. */
  peg: z.boolean().optional(),
  /** Midpoint. Unsupported — refuses. The engine does not invent a mid. */
  midpoint: z.boolean().optional(),
  /** Relative to caller reference + offset. Missing those refuses. The engine does not invent a mid. */
  relative: z.boolean().optional(),
  /** Caller reference for peg/relative. The engine does not invent a mid. */
  reference: decimal.nullish(),
  /** Caller offset for peg/relative. Added to reference. Missing refuses. */
  offset: signedDecimal.nullish(),
  /** Auction. Unsupported — refuses. The engine does not invent an auction price. */
  auction: z.boolean().optional(),
  /** Benchmark. Unsupported — refuses. The engine does not invent a benchmark price. */
  benchmark: z.boolean().optional(),
  /** Price collar. Missing or false is a normal order. */
  collar: z.boolean().optional(),
  /** Caller collar min. Required when collar is true. The engine does not invent last or mid. */
  min: decimal.nullish(),
  /** Caller collar max. Required when collar is true. The engine does not invent last or mid. */
  max: decimal.nullish(),
  /** Caller min notional. Missing notional when requested refuses. The engine does not invent last. */
  minNotional: decimal.nullish(),
  /** Combo / multi-leg. Named legs with ratios required. The engine does not invent a combo book. */
  combo: z.boolean().optional(),
  /** Named combo legs. Missing when combo is requested refuses. Ratio is a signed ledger decimal. */
  legs: z
    .array(
      z.object({
        name: z.string().nullish(),
        ratio: signedDecimal.nullish(),
        strike: decimal.nullish(),
        expiry: z.string().nullish(),
      }),
    )
    .nullish(),
  /** PX-S01 evidence is mandatory at this private risk-increasing boundary. */
  lifecycleProof: marketLifecycleAdmissionProofSchema,
});

const closePositionBodySchema = z.object({
  orderId: z.string().guid(),
  accountId: z.string().min(1).max(128),
  /** Same PLACE / market-lifecycle proof as a market submit. */
  lifecycleProof: marketLifecycleAdmissionProofSchema,
});

const massCancelBodySchema = z.object({
  /** §5.1: account ids only. This service never learns whose account it is. */
  accountId: z.string().min(1).max(128),
  /** Not on the book. Present and non-empty refuses rather than inventing a session. */
  sessionId: z.string().max(128).nullish(),
  /** Present buy|sell is that side only (book + stops). Missing/null is both. */
  side: orderSideSchema.nullish(),
});

/**
 * MMP magnitudes on the wire. Decimal string or blank.
 * Blank is still MMP intent — unpublished refuse. Never a JSON number, never invented 0.
 */
const mmpMagnitude = z
  .string()
  .regex(/^(?:\d+(?:\.\d{1,18})?)?$/, 'MMP magnitudes are decimal strings or blank — never JSON numbers')
  .nullish();

const mmpFieldsSchema = z.object({
  mmp: z.boolean().optional(),
  mmpMaxQuote: mmpMagnitude,
  mmpMaxPosition: mmpMagnitude,
  mmpMaxLoss: mmpMagnitude,
  mmpMaxDelta: mmpMagnitude,
  mmpMaxVega: mmpMagnitude,
  mmpVendor: z.boolean().optional(),
  sidecar: z.boolean().optional(),
});

const quoteSideSchema = z
  .object({
    orderId: z.string().guid(),
    type: engineOrderTypeSchema,
    qty: decimal,
    price: decimal.nullish(),
    tif: timeInForceSchema,
  })
  .merge(mmpFieldsSchema);

const massQuoteBodySchema = z
  .object({
    /** Quote set id. Empty refuses — the engine does not invent a set. */
    setId: z.string(),
    accountId: z.string().min(1).max(128),
    /** Explicit one-sided. Missing/false is a required two-sided pair (PTX-M11-R11). */
    oneSided: z.boolean().optional(),
    bid: quoteSideSchema.nullish(),
    ask: quoteSideSchema.nullish(),
    lifecycleProof: marketLifecycleAdmissionProofSchema,
  })
  .merge(mmpFieldsSchema);

type MmpWire = z.infer<typeof mmpFieldsSchema>;
type QuoteSideWire = z.infer<typeof quoteSideSchema>;
type MassQuoteEngine = MatchingEngine & {
  massQuote(cmd: MassQuoteCommand): Promise<MassQuoteResult>;
};

/** Halt/resume/mode mutate. Typed confirm is attribution only. Consume identity approval. */
/** What an emergency door hands the engine: the two operators, and the approval they used as its evidence. */
function emergencyCmd(authz: {
  readonly operatorId: string;
  readonly confirmOperatorId: string;
  readonly evidenceRefs: readonly string[];
}) {
  return { operatorId: authz.operatorId, confirmOperatorId: authz.confirmOperatorId, evidenceRefs: authz.evidenceRefs };
}

const venueKillBodySchema = z.object({
  operatorId: z.string().min(1).max(128),
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().max(128).nullish(),
  operationId: z.string().max(128).nullish(),
});

const sessionDeadBodySchema = z.object({
  /** Caller session. Missing/empty refuses — the engine does not invent a session. */
  sessionId: z.string().min(1).max(128),
});

const amendBodySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    qty: decimal.optional(),
    price: decimal.optional(),
    stopPrice: decimal.optional(),
    tif: timeInForceSchema.optional(),
    lifecycleProof: marketLifecycleAdmissionProofSchema,
  })
  .superRefine((body, ctx) => {
    if (body.qty === undefined && body.price === undefined && body.stopPrice === undefined && body.tif === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amend must change qty, price, stopPrice, or tif' });
    }
  });

const markBodySchema = z.object({ mark: decimal });

/**
 * Owner spread listing (CB-otc-16). Fields are strings or blank so a blank owner value reaches the typed refusal
 * instead of a generic 400. Consumed through the same dual-control approval as OPEN.
 */
const spreadListBodySchema = z.object({
  kind: z.string().max(32).nullish(),
  legs: z
    .array(
      z.object({
        symbol: z.string().max(128).nullish(),
        side: z.string().max(8).nullish(),
        ratio: z.string().max(64).nullish(),
      }),
    )
    .max(8)
    .nullish(),
  tick: z.string().max(64).nullish(),
  lot: z.string().max(64).nullish(),
  operatorId: z.string().min(1).max(128),
  confirmOperatorId: z.string().max(128).nullish(),
  approvalId: z.string().max(128).nullish(),
  operationId: z.string().max(128).nullish(),
});

/** A spread order. GTC limit at a signed spread price; the engine stamps the listing itself. */
const spreadOrderBodySchema = z.object({
  orderId: z.string().guid(),
  accountId: z.string().min(1).max(128),
  side: orderSideSchema,
  qty: decimal,
  /** Spread price: a weighted leg-price difference, so it may be zero or negative. */
  price: signedDecimal,
  tif: timeInForceSchema,
  /** Caller reference for the anchor leg (leg 0). Missing refuses. The engine does not invent a mark. */
  anchorReference: decimal.nullish(),
  clientOrderId: z.string().min(1).max(128).optional(),
  environment: z.string().max(64).optional(),
  sessionId: z.string().max(128).optional(),
  lifecycleProof: marketLifecycleAdmissionProofSchema,
});

const counterpartOrderSchema = z.object({
  orderId: z.string().min(1).max(128),
  marketId: z.string().min(1).max(128),
  state: z.enum(['pending', 'open', 'terminal']),
  remaining: decimal,
  funded: z.boolean(),
  detail: z.string().max(256).optional(),
});

const reconcileBodySchema = z.object({
  orders: z.array(counterpartOrderSchema).max(10_000),
});

function toEngineOrder(body: z.infer<typeof submitBodySchema>): EngineOrder {
  const stopPx = body.stopPx ?? body.stopPrice;
  return {
    orderId: body.orderId,
    accountId: body.accountId,
    type: body.type,
    side: body.side,
    qty: parseAmount(body.qty),
    price: body.price == null ? null : parseAmount(body.price),
    stopPrice: stopPx == null ? null : parseAmount(stopPx),
    tif: bindPostOnlyTif(body.tif, body.postOnly),
    ...(body.ocoSiblingId ? { ocoSiblingId: body.ocoSiblingId } : {}),
    ...(body.oco === true ? { oco: true } : {}),
    ...(body.takeProfit != null ? { takeProfit: parseAmount(body.takeProfit) } : {}),
    ...(body.stopLoss != null ? { stopLoss: parseAmount(body.stopLoss) } : {}),
    ...(body.stopLossLimit != null ? { stopLossLimit: parseAmount(body.stopLossLimit) } : {}),
    ...(body.expireAt ? { expireAt: body.expireAt } : {}),
    ...(body.sessionId ? { sessionId: body.sessionId } : {}),
    ...(body.reduceOnly === true ? { reduceOnly: true } : {}),
    ...(body.iceberg === true || body.displayQty != null
      ? { iceberg: true, displayQty: body.displayQty == null ? null : parseAmount(body.displayQty) }
      : {}),
    ...(body.trail !== undefined ? { trail: body.trail == null ? null : parseAmount(body.trail) } : {}),
    ...(body.mark !== undefined ? { mark: body.mark == null ? null : parseAmount(body.mark) } : {}),
    ...(body.strike !== undefined ? { strike: body.strike == null ? null : parseAmount(body.strike) } : {}),
    ...(body.expiry !== undefined ? { expiry: body.expiry == null ? null : body.expiry } : {}),
    ...(body.minQty !== undefined ? { minQty: body.minQty == null ? null : parseAmount(body.minQty) } : {}),
    ...(body.aon !== undefined ? { aon: body.aon === true } : {}),
    ...(body.peg !== undefined ? { peg: body.peg === true } : {}),
    ...(body.midpoint !== undefined ? { midpoint: body.midpoint === true } : {}),
    ...(body.relative !== undefined ? { relative: body.relative === true } : {}),
    ...(body.reference !== undefined ? { reference: body.reference == null ? null : parseAmount(body.reference) } : {}),
    ...(body.offset !== undefined ? { offset: body.offset == null ? null : parseAmount(body.offset) } : {}),
    ...(body.auction !== undefined ? { auction: body.auction === true } : {}),
    ...(body.benchmark !== undefined ? { benchmark: body.benchmark === true } : {}),
    ...(body.collar !== undefined ? { collar: body.collar === true } : {}),
    ...(body.min !== undefined ? { min: body.min == null ? null : parseAmount(body.min) } : {}),
    ...(body.max !== undefined ? { max: body.max == null ? null : parseAmount(body.max) } : {}),
    ...(body.minNotional !== undefined ? { minNotional: body.minNotional == null ? null : parseAmount(body.minNotional) } : {}),
    ...(body.combo !== undefined ? { combo: body.combo === true } : {}),
    ...(body.legs !== undefined
      ? {
          legs:
            body.legs == null
              ? null
              : body.legs.map((leg) => ({
                  name: leg.name ?? null,
                  ratio: leg.ratio == null ? null : parseAmount(leg.ratio),
                  strike: leg.strike == null ? null : parseAmount(leg.strike),
                  expiry: leg.expiry ?? null,
                })),
        }
      : {}),
  };
}

function readMmpMagnitude(raw: string | null | undefined): unknown | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === '') return raw;
  return parseAmount(raw);
}

function mmpOrderFields(set: MmpWire, side: MmpWire): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (set.mmp === true || side.mmp === true) fields.mmp = true;
  if (set.mmpVendor === true || side.mmpVendor === true) fields.mmpVendor = true;
  if (set.sidecar === true || side.sidecar === true) fields.sidecar = true;
  const quote = readMmpMagnitude(side.mmpMaxQuote !== undefined ? side.mmpMaxQuote : set.mmpMaxQuote);
  const position = readMmpMagnitude(side.mmpMaxPosition !== undefined ? side.mmpMaxPosition : set.mmpMaxPosition);
  const loss = readMmpMagnitude(side.mmpMaxLoss !== undefined ? side.mmpMaxLoss : set.mmpMaxLoss);
  const delta = readMmpMagnitude(side.mmpMaxDelta !== undefined ? side.mmpMaxDelta : set.mmpMaxDelta);
  const vega = readMmpMagnitude(side.mmpMaxVega !== undefined ? side.mmpMaxVega : set.mmpMaxVega);
  if (quote !== undefined) fields.mmpMaxQuote = quote;
  if (position !== undefined) fields.mmpMaxPosition = position;
  if (loss !== undefined) fields.mmpMaxLoss = loss;
  if (delta !== undefined) fields.mmpMaxDelta = delta;
  if (vega !== undefined) fields.mmpMaxVega = vega;
  return fields;
}

function toQuoteSideOrder(accountId: string, side: 'buy' | 'sell', body: QuoteSideWire, setMmp: MmpWire): EngineOrder {
  return {
    orderId: body.orderId,
    accountId,
    type: body.type,
    side,
    qty: parseAmount(body.qty),
    price: body.price == null ? null : parseAmount(body.price),
    stopPrice: null,
    tif: body.tif,
    ...mmpOrderFields(setMmp, body),
  } as EngineOrder;
}

function presentMassQuote(result: MassQuoteResult) {
  return {
    setId: result.setId,
    oneSided: result.oneSided,
    results: result.results.map((row) => ({
      side: row.side,
      status: row.status,
      orderId: row.orderId ?? null,
      rejected: row.rejected ?? null,
    })),
    rejected: result.rejected ?? null,
  };
}

function toEngineAmend(orderId: string, body: z.infer<typeof amendBodySchema>): EngineAmend {
  return {
    orderId,
    expectedVersion: body.expectedVersion,
    ...(body.qty !== undefined ? { qty: parseAmount(body.qty) } : {}),
    ...(body.price !== undefined ? { price: parseAmount(body.price) } : {}),
    ...(body.stopPrice !== undefined ? { stopPrice: parseAmount(body.stopPrice) } : {}),
    ...(body.tif !== undefined ? { tif: body.tif } : {}),
  };
}

const presentFill = (fill: Fill) => ({
  sequence: fill.sequence,
  makerOrderId: fill.makerOrderId,
  makerAccountId: fill.makerAccountId,
  takerOrderId: fill.takerOrderId,
  takerAccountId: fill.takerAccountId,
  takerSide: fill.takerSide,
  price: formatAmount(fill.price),
  qty: formatAmount(fill.qty),
  ...(fill.legs !== undefined
    ? {
        legs: fill.legs.map((leg) => ({
          symbol: leg.symbol,
          takerSide: leg.takerSide,
          qty: formatAmount(leg.qty),
          price: formatAmount(leg.price),
        })),
      }
    : {}),
});

const presentResting = (resting: RestingRef | null) =>
  resting === null
    ? null
    : {
        kind: resting.kind,
        orderId: resting.orderId,
        accountId: resting.accountId,
        side: resting.side,
        price: formatAmount(resting.price),
        remaining: formatAmount(resting.remaining),
        sequence: resting.sequence,
        version: resting.version,
      };

const presentCancellation = (cancellation: CancelledRef) => ({
  orderId: cancellation.orderId,
  accountId: cancellation.accountId,
  remainingQty: formatAmount(cancellation.remainingQty),
  sequence: cancellation.sequence,
  reason: cancellation.reason,
});

function presentSubmit(result: SubmitResult) {
  return {
    accepted: result.accepted,
    sequence: result.sequence,
    fills: result.fills.map(presentFill),
    resting: presentResting(result.resting),
    rejected: result.rejected ?? null,
    cancellations: result.cancellations.map(presentCancellation),
    triggered: result.triggered.map((t) => ({
      orderId: t.orderId,
      sequence: t.sequence,
      fills: t.fills.map(presentFill),
      resting: presentResting(t.resting),
      cancellations: t.cancellations.map(presentCancellation),
      rejected: t.rejected ?? null,
    })),
  };
}

function presentAmend(result: AmendResult) {
  return {
    accepted: result.accepted,
    orderId: result.orderId,
    sequence: result.sequence,
    version: result.version,
    priority: result.priority,
    fills: result.fills.map(presentFill),
    resting: presentResting(result.resting),
    rejected: result.rejected ?? null,
    cancellations: result.cancellations.map(presentCancellation),
    triggered: result.triggered.map((t) => ({
      orderId: t.orderId,
      sequence: t.sequence,
      fills: t.fills.map(presentFill),
      resting: presentResting(t.resting),
      cancellations: t.cancellations.map(presentCancellation),
      rejected: t.rejected ?? null,
    })),
  };
}

export class MatchingAuthError extends Error {
  readonly rejected: string;
  constructor(rejected: string) {
    super(userCopy('matching.unauthenticated'));
    this.name = 'MatchingAuthError';
    this.rejected = rejected;
  }
}

export class MatchingForbiddenError extends Error {
  constructor() {
    super(userCopy('error.forbidden'));
    this.name = 'MatchingForbiddenError';
  }
}

function unauthenticatedBody(err: unknown): { code: 'Unauthenticated'; message: string; rejected?: string } {
  const rejected = err instanceof MatchingAuthError ? err.rejected : undefined;
  return {
    code: 'Unauthenticated',
    message: userCopy('matching.unauthenticated'),
    ...(rejected ? { rejected } : {}),
  };
}

function forbiddenBody(): { code: 'Forbidden'; message: string } {
  return { code: 'Forbidden', message: userCopy('error.forbidden') };
}

export interface MatchingRouteOptions {
  /** Per-service keys (S2S v3). Unset keeps the shared secret alone; a failed key-signed call never falls back to it. */
  s2s?: { readonly verifier: ServiceVerifier; readonly mode: ServiceAuthMode };
  /** `INTERNAL_SERVICE_BODY_BIND`. Isolated tests default to accept-both. */
  bodyBind?: ServiceBodyBindMode;
  /** Owner-published rulebook version. Missing/blank is unpublished. */
  rulebookVersion?: string;
  /** Real Logic SBE adapter. Tests inject; production uses the package singleton. */
  sbe?: SbeCodec;
  /** Halt/resume/mode consume. Tests inject a stub. Unset → refuse. */
  approvals?: ActionApprovalConsumer;
  /**
   * User ids allowed to propose and approve `matching.open`
   * (`MATCHING_OPERATOR_IDS`). Unset / empty → nobody may open.
   */
  operatorIds?: ReadonlySet<string>;
  /**
   * Founder door verifies the edge principal. Unset → `/operator/*` answers 503
   * `matching.operator_auth_unconfigured` and does not read the book.
   * S2S halt stays on the HMAC routes. This door does not read a bearer.
   */
  edgePrincipalSecret?: string;
  /**
   * The edge's Ed25519 public key (`EDGE_PRINCIPAL_PUBLIC_KEY`). With it the founder door also accepts
   * public-key signatures; the shared secret above stays accepted too. A key without `principalLimits`
   * refuses the boot with `EdgeTrustError` rather than inventing a lifetime.
   */
  edgePublicKey?: string;
  principalLimits?: EdgePrincipalLimits;
}

export function registerRoutes(
  app: FastifyInstance,
  engine: MatchingEngine,
  internalSecret: string,
  options: MatchingRouteOptions = {},
): void {
  const mode = options.bodyBind ?? DEFAULT_SERVICE_BODY_BIND_MODE;
  const rulebookVersion = options.rulebookVersion ?? process.env.MATCHING_RULEBOOK_VERSION ?? '';
  const sbe = options.sbe ?? sbeCodec;
  const approvals = options.approvals ?? unwiredApprovalConsumer();
  const operatorIds = options.operatorIds ?? new Set<string>();
  const isOperator = (userId: string): boolean => operatorIds.has(userId.trim().toLowerCase());
  retainRawBody(app);

  /** Book writes from funded trade, execution basket children, and FIX NOS. HMAC still required. Unmapped refuse. */
  const TRADE_ONLY = new Set<string>(['svc-trade']);
  const BASKET_CHILD_CALLERS = new Set<string>(['svc-trade', 'svc-execution', 'svc-fix']);

  const requireService = (req: FastifyRequest, allowed: ReadonlySet<string>): void => {
    const verification = verifyServiceRequest(req, {
      verifier: options.s2s?.verifier,
      mode: options.s2s?.mode,
      legacySecret: internalSecret,
      bodyBindMode: mode,
    });

    if (verification.service) {
      if (!allowed.has(verification.service)) throw new MatchingForbiddenError();
      return;
    }

    throw new MatchingAuthError(verification.rejected ?? 'unauthenticated');
  };

  const requireTradingService = (req: FastifyRequest): void => requireService(req, TRADE_ONLY);
  const requireBasketChildService = (req: FastifyRequest): void => requireService(req, BASKET_CHILD_CALLERS);

  const authFailure = (err: unknown, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    if (err instanceof MatchingForbiddenError) return reply.code(403).send(forbiddenBody());
    return reply.code(401).send(unauthenticatedBody(err));
  };

  const consumeVenueKill = async (
    parsed: z.infer<typeof venueKillBodySchema>,
    actionType: string,
    fields: Record<string, string>,
    targetId: string,
  ): Promise<
    | {
        readonly ok: true;
        readonly operatorId: string;
        readonly confirmOperatorId: string;
        /** The consumed two-person approval, as the evidence an emergency action needs (rulebook-refuse.ts). */
        readonly evidenceRefs: readonly string[];
      }
    | {
        readonly ok: false;
        readonly status: 200;
        readonly operatorId: string | null;
        readonly confirmOperatorId: string | null;
        readonly rejected: { readonly code: string; readonly message: string };
      }
    | { readonly ok: false; readonly status: 400; readonly body: { readonly code: string; readonly message: string } }
  > => {
    const operatorId = readOperatorId(parsed);
    const confirmTyped = readConfirmOperatorId(parsed);
    const missing = operatorRefuse(operatorId);
    if (missing || operatorId === null) {
      return { ok: false, status: 200, operatorId, confirmOperatorId: confirmTyped, rejected: missing ?? operatorRefuse(null)! };
    }
    const refuse = (code: string, message: string) => ({ ok: false as const, status: 400 as const, body: { code, message } });
    try {
      const ids = readApprovalIds(parsed);
      // Stop early, before the single-use approval is spent: no operator list,
      // or a typed name that is not on it.
      if (operatorIds.size === 0) {
        return refuse(ACTION_APPROVAL_OPERATORS_UNSET, 'MATCHING_OPERATOR_IDS is unpublished; matching does not guess who is an operator');
      }
      if (!isOperator(operatorId)) {
        return refuse(ACTION_APPROVAL_NOT_OPERATOR, 'the requester is not an operator of this venue');
      }
      const consumed = await approvals.consume({
        approvalId: ids.approvalId,
        operationId: ids.operationId,
        payloadHash: matchingActionPayloadHash(actionType, fields),
        targetService: 'svc-matching',
        targetId,
        expectedVersion: '1',
      });
      // The approval must be for exactly this door and target. Identity stores the
      // action label the proposer typed, so matching checks it rather than trusting
      // the hash alone; a mislabelled approval for another action never runs here.
      if (
        consumed.actionType !== actionType ||
        consumed.targetService !== 'svc-matching' ||
        consumed.targetId !== targetId ||
        consumed.status !== 'CONSUMED'
      ) {
        return refuse(ACTION_APPROVAL_WRONG_ACTION, `the approval is not for ${actionType} on ${targetId}`);
      }
      // The body's operatorId is a claim. Identity recorded who actually
      // proposed; the two must be the same person.
      if (!sameUser(consumed.requesterId, operatorId)) {
        return refuse(ACTION_APPROVAL_OPERATOR_MISMATCH, 'operatorId is not the person who proposed this approval');
      }
      // Never fall back to the requester: a second person approved, or nothing runs.
      const approverId = consumed.approverId;
      if (approverId === null || sameUser(approverId, consumed.requesterId)) {
        return refuse(ACTION_APPROVAL_MISSING, 'the approval has no distinct approver');
      }
      if (!isOperator(consumed.requesterId) || !isOperator(approverId)) {
        return refuse(ACTION_APPROVAL_NOT_OPERATOR, 'both the proposer and the approver must be operators of this venue');
      }
      // #4790 kept the founder-only audience for matching.* (protective brakes skip it).
      assertFounderAudienceAttestation(consumed, { actionType, targetService: 'svc-matching', targetId });
      return {
        ok: true,
        operatorId: consumed.requesterId,
        confirmOperatorId: approverId,
        evidenceRefs: [approvalEvidenceRef(consumed.approvalId)],
      };
    } catch (err) {
      if (err instanceof ActionApprovalConsumeError) {
        return { ok: false, status: 400, body: { code: err.code, message: err.message } };
      }
      throw err;
    }
  };

  app.post('/markets/:marketId/orders', async (req, reply) => {
    try {
      requireBasketChildService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = submitBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    if (postOnlyCannotRest(parsed.data.tif, parsed.data.postOnly)) {
      return reply.code(400).send({
        code: 'BadRequest',
        issues: ['postOnly cannot rest an immediate time-in-force; the engine does not invent a price'],
      });
    }
    const expectedAction = parsed.data.tif === 'PO' || parsed.data.postOnly === true ? 'PLACE_POST_ONLY' : 'PLACE';
    const proofIssues: string[] = [];
    if (parsed.data.lifecycleProof.snapshot.marketId !== marketId) {
      proofIssues.push('lifecycleProof.snapshot.marketId: must match the route marketId');
    }
    if (parsed.data.lifecycleProof.action !== expectedAction) {
      proofIssues.push(`lifecycleProof.action: must be ${expectedAction} for this order`);
    }
    if (proofIssues.length > 0) return reply.code(400).send({ code: 'BadRequest', issues: proofIssues });

    const result = await engine.submit(marketId, toEngineOrder(parsed.data), parsed.data.lifecycleProof);
    return reply.code(200).send(presentSubmit(result));
  });

  app.post('/markets/:marketId/positions/close', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = closePositionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const proofIssues: string[] = [];
    if (parsed.data.lifecycleProof.snapshot.marketId !== marketId) {
      proofIssues.push('lifecycleProof.snapshot.marketId: must match the route marketId');
    }
    if (parsed.data.lifecycleProof.action !== 'PLACE') {
      proofIssues.push('lifecycleProof.action: must be PLACE for this order');
    }
    if (proofIssues.length > 0) return reply.code(400).send({ code: 'BadRequest', issues: proofIssues });

    const result = await engine.closePosition(
      marketId,
      { orderId: parsed.data.orderId, accountId: parsed.data.accountId },
      parsed.data.lifecycleProof,
    );
    return reply.code(200).send(presentSubmit(result));
  });

  app.patch('/markets/:marketId/orders/:orderId', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId, orderId } = req.params as { marketId: string; orderId: string };
    const parsed = amendBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const proofIssues: string[] = [];
    if (parsed.data.lifecycleProof.snapshot.marketId !== marketId) {
      proofIssues.push('lifecycleProof.snapshot.marketId: must match the route marketId');
    }
    if (parsed.data.lifecycleProof.action !== 'AMEND') {
      proofIssues.push('lifecycleProof.action: must be AMEND for this order');
    }
    if (proofIssues.length > 0) return reply.code(400).send({ code: 'BadRequest', issues: proofIssues });

    const result = await engine.amend(marketId, toEngineAmend(orderId, parsed.data), parsed.data.lifecycleProof);
    if (!result.accepted && result.rejected?.code === 'order_not_found') {
      return reply.code(404).send({ code: 'OrderNotFound', message: userCopy('matching.order_not_found') });
    }
    return reply.code(200).send(presentAmend(result));
  });

  // The mark that walks a market's trailing stops. It comes from svc-trade's own mark source, never from a customer.
  app.post('/markets/:marketId/mark', async (req, reply) => {
    try {
      requireBasketChildService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = markBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    const result = engine.markTrailingStops(marketId, parsed.data.mark);
    return reply.code(200).send(result);
  });

  app.delete('/markets/:marketId/orders/:orderId', async (req, reply) => {
    try {
      requireBasketChildService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId, orderId } = req.params as { marketId: string; orderId: string };
    const result = await engine.cancel(marketId, orderId);
    if (result.rejected) {
      return reply.code(200).send({
        cancelled: false,
        orderId: result.orderId,
        sequence: result.sequence,
        cancellation: null,
        rejected: result.rejected,
      });
    }
    if (!result.cancelled) return reply.code(404).send({ code: 'OrderNotFound', message: userCopy('matching.order_not_found') });
    return reply.code(200).send({
      cancelled: true,
      orderId: result.orderId,
      sequence: result.sequence,
      cancellation: result.cancellation ? presentCancellation(result.cancellation) : null,
    });
  });

  app.post('/markets/:marketId/orders/mass-cancel', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = massCancelBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const sessionRefuse = massCancelSessionRefuse(readSessionId(parsed.data));
    if (sessionRefuse) {
      return reply.code(200).send({
        accepted: false,
        accountId: parsed.data.accountId,
        cancellations: [],
        rejected: { code: sessionRefuse.code, message: sessionRefuse.message },
      });
    }

    const result = await engine.massCancel(marketId, {
      accountId: parsed.data.accountId,
      side: parsed.data.side ?? null,
    });
    return reply.code(200).send({
      accepted: result.accepted,
      accountId: result.accountId,
      cancellations: result.cancellations.map(presentCancellation),
      rejected: result.rejected ?? null,
    });
  });

  app.post('/markets/:marketId/mass-quote', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = massQuoteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const proofIssues: string[] = [];
    if (parsed.data.lifecycleProof.snapshot.marketId !== marketId) {
      proofIssues.push('lifecycleProof.snapshot.marketId: must match the route marketId');
    }
    if (parsed.data.lifecycleProof.action !== 'PLACE') {
      proofIssues.push('lifecycleProof.action: must be PLACE for this quote set');
    }
    if (proofIssues.length > 0) return reply.code(400).send({ code: 'BadRequest', issues: proofIssues });

    const setMmp: MmpWire = {
      mmp: parsed.data.mmp,
      mmpMaxQuote: parsed.data.mmpMaxQuote,
      mmpMaxPosition: parsed.data.mmpMaxPosition,
      mmpMaxLoss: parsed.data.mmpMaxLoss,
      mmpMaxDelta: parsed.data.mmpMaxDelta,
      mmpMaxVega: parsed.data.mmpMaxVega,
      mmpVendor: parsed.data.mmpVendor,
      sidecar: parsed.data.sidecar,
    };

    const result = await (engine as MassQuoteEngine).massQuote({
      setId: parsed.data.setId,
      marketId,
      accountId: parsed.data.accountId,
      oneSided: parsed.data.oneSided,
      bid: parsed.data.bid ? toQuoteSideOrder(parsed.data.accountId, 'buy', parsed.data.bid, setMmp) : null,
      ask: parsed.data.ask ? toQuoteSideOrder(parsed.data.accountId, 'sell', parsed.data.ask, setMmp) : null,
      lifecycleProof: parsed.data.lifecycleProof,
    });
    return reply.code(200).send(presentMassQuote(result));
  });

  app.post('/markets/:marketId/halt', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = venueKillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const authz = await consumeVenueKill(parsed.data, 'matching.halt', { marketId }, `halt:${marketId}`);
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) {
      return reply.code(200).send({
        accepted: false,
        marketId,
        halted: engine.isHalted(marketId),
        operatorId: authz.operatorId,
        confirmOperatorId: authz.confirmOperatorId,
        rejected: authz.rejected,
      });
    }

    const result = await engine.halt(marketId, emergencyCmd(authz));
    return reply.code(200).send({
      accepted: result.accepted,
      marketId: result.marketId,
      halted: result.halted,
      operatorId: result.operatorId,
      confirmOperatorId: result.confirmOperatorId ?? authz.confirmOperatorId,
      rejected: result.rejected ?? null,
    });
  });

  app.post('/markets/:marketId/resume', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = venueKillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const authz = await consumeVenueKill(parsed.data, 'matching.resume', { marketId }, `resume:${marketId}`);
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) {
      return reply.code(200).send({
        accepted: false,
        marketId,
        halted: engine.isHalted(marketId),
        operatorId: authz.operatorId,
        confirmOperatorId: authz.confirmOperatorId,
        rejected: authz.rejected,
      });
    }

    const result = await engine.resume(marketId, emergencyCmd(authz));
    return reply.code(200).send({
      accepted: result.accepted,
      marketId: result.marketId,
      halted: result.halted,
      operatorId: result.operatorId,
      confirmOperatorId: result.confirmOperatorId ?? authz.confirmOperatorId,
      rejected: result.rejected ?? null,
    });
  });

  app.post('/halt-all', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const parsed = venueKillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const authz = await consumeVenueKill(parsed.data, 'matching.halt_all', {}, 'halt_all');
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) {
      return reply.code(200).send({
        accepted: false,
        halted: engine.isVenueHalted,
        operatorId: authz.operatorId,
        confirmOperatorId: authz.confirmOperatorId,
        rejected: authz.rejected,
      });
    }

    const result = await engine.haltAll(emergencyCmd(authz));
    return reply.code(200).send({
      accepted: result.accepted,
      halted: result.halted,
      operatorId: result.operatorId,
      confirmOperatorId: result.confirmOperatorId ?? authz.confirmOperatorId,
      rejected: result.rejected ?? null,
    });
  });

  app.post('/resume-all', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const parsed = venueKillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const authz = await consumeVenueKill(parsed.data, 'matching.resume_all', {}, 'resume_all');
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) {
      return reply.code(200).send({
        accepted: false,
        halted: engine.isVenueHalted,
        operatorId: authz.operatorId,
        confirmOperatorId: authz.confirmOperatorId,
        rejected: authz.rejected,
      });
    }

    const result = await engine.resumeAll(emergencyCmd(authz));
    return reply.code(200).send({
      accepted: result.accepted,
      halted: result.halted,
      operatorId: result.operatorId,
      confirmOperatorId: result.confirmOperatorId ?? authz.confirmOperatorId,
      rejected: result.rejected ?? null,
    });
  });

  app.post('/session/dead', async (req, reply) => {
    try {
      requireBasketChildService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const parsed = sessionDeadBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const sessionId = readSessionId(parsed.data);
    if (sessionId === null) {
      const refuse = missingSessionRefuse();
      return reply.code(200).send({
        accepted: false,
        sessionId: null,
        cancellations: [],
        rejected: { code: refuse.code, message: refuse.message },
      });
    }

    const result = await engine.sessionDead({ sessionId });
    return reply.code(200).send({
      accepted: result.accepted,
      sessionId: result.sessionId,
      cancellations: result.cancellations.map(presentCancellation),
      rejected: result.rejected ?? null,
    });
  });

  app.post('/markets/:marketId/reduce-only', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = venueKillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const authz = await consumeVenueKill(parsed.data, 'matching.reduce_only', { marketId }, `reduce_only:${marketId}`);
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) {
      return reply.code(200).send({
        accepted: false,
        marketId,
        reduceOnly: engine.isReduceOnly(marketId),
        operatorId: authz.operatorId,
        confirmOperatorId: authz.confirmOperatorId,
        rejected: authz.rejected,
      });
    }

    const result = await engine.reduceOnly(marketId, { operatorId: authz.operatorId, confirmOperatorId: authz.confirmOperatorId });
    return reply.code(200).send({
      accepted: result.accepted,
      marketId: result.marketId,
      reduceOnly: result.reduceOnly,
      operatorId: result.operatorId,
      confirmOperatorId: result.confirmOperatorId ?? authz.confirmOperatorId,
      rejected: result.rejected ?? null,
    });
  });

  app.post('/markets/:marketId/reduce-only/resume', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = venueKillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const authz = await consumeVenueKill(parsed.data, 'matching.reduce_only_resume', { marketId }, `reduce_only_resume:${marketId}`);
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) {
      return reply.code(200).send({
        accepted: false,
        marketId,
        reduceOnly: engine.isReduceOnly(marketId),
        operatorId: authz.operatorId,
        confirmOperatorId: authz.confirmOperatorId,
        rejected: authz.rejected,
      });
    }

    const result = await engine.resumeReduceOnly(marketId, { operatorId: authz.operatorId, confirmOperatorId: authz.confirmOperatorId });
    return reply.code(200).send({
      accepted: result.accepted,
      marketId: result.marketId,
      reduceOnly: result.reduceOnly,
      operatorId: result.operatorId,
      confirmOperatorId: result.confirmOperatorId ?? authz.confirmOperatorId,
      rejected: result.rejected ?? null,
    });
  });

  app.post('/markets/:marketId/post-only', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = venueKillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const authz = await consumeVenueKill(parsed.data, 'matching.post_only', { marketId }, `post_only:${marketId}`);
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) {
      return reply.code(200).send({
        accepted: false,
        marketId,
        postOnly: engine.isPostOnly(marketId),
        operatorId: authz.operatorId,
        confirmOperatorId: authz.confirmOperatorId,
        rejected: authz.rejected,
      });
    }

    const result = await engine.postOnly(marketId, { operatorId: authz.operatorId, confirmOperatorId: authz.confirmOperatorId });
    return reply.code(200).send({
      accepted: result.accepted,
      marketId: result.marketId,
      postOnly: result.postOnly,
      operatorId: result.operatorId,
      confirmOperatorId: result.confirmOperatorId ?? authz.confirmOperatorId,
      rejected: result.rejected ?? null,
    });
  });

  app.post('/markets/:marketId/post-only/resume', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = venueKillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const authz = await consumeVenueKill(parsed.data, 'matching.post_only_resume', { marketId }, `post_only_resume:${marketId}`);
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) {
      return reply.code(200).send({
        accepted: false,
        marketId,
        postOnly: engine.isPostOnly(marketId),
        operatorId: authz.operatorId,
        confirmOperatorId: authz.confirmOperatorId,
        rejected: authz.rejected,
      });
    }

    const result = await engine.resumePostOnly(marketId, { operatorId: authz.operatorId, confirmOperatorId: authz.confirmOperatorId });
    return reply.code(200).send({
      accepted: result.accepted,
      marketId: result.marketId,
      postOnly: result.postOnly,
      operatorId: result.operatorId,
      confirmOperatorId: result.confirmOperatorId ?? authz.confirmOperatorId,
      rejected: result.rejected ?? null,
    });
  });

  app.post('/markets/:marketId/prelaunch', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = venueKillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const authz = await consumeVenueKill(parsed.data, 'matching.prelaunch', { marketId }, `prelaunch:${marketId}`);
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) {
      return reply.code(200).send({
        accepted: false,
        marketId,
        prelaunch: engine.isPrelaunch(marketId),
        operatorId: authz.operatorId,
        confirmOperatorId: authz.confirmOperatorId,
        rejected: authz.rejected,
      });
    }

    const result = await engine.prelaunch(marketId, { operatorId: authz.operatorId, confirmOperatorId: authz.confirmOperatorId });
    return reply.code(200).send({
      accepted: result.accepted,
      marketId: result.marketId,
      prelaunch: result.prelaunch,
      operatorId: result.operatorId,
      confirmOperatorId: result.confirmOperatorId ?? authz.confirmOperatorId,
      rejected: result.rejected ?? null,
    });
  });

  app.post('/markets/:marketId/open', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = venueKillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const authz = await consumeVenueKill(parsed.data, 'matching.open', { marketId }, `open:${marketId}`);
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) {
      return reply.code(200).send({
        accepted: false,
        marketId,
        prelaunch: engine.isPrelaunch(marketId),
        operatorId: authz.operatorId,
        confirmOperatorId: authz.confirmOperatorId,
        rejected: authz.rejected,
      });
    }

    const result = await engine.open(marketId, { operatorId: authz.operatorId, confirmOperatorId: authz.confirmOperatorId });
    return reply.code(200).send({
      accepted: result.accepted,
      marketId: result.marketId,
      prelaunch: result.prelaunch,
      operatorId: result.operatorId,
      confirmOperatorId: result.confirmOperatorId ?? authz.confirmOperatorId,
      rejected: result.rejected ?? null,
    });
  });

  app.post('/markets/:marketId/expire', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = venueKillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const authz = await consumeVenueKill(parsed.data, 'matching.expire', { marketId }, `expire:${marketId}`);
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) {
      return reply.code(200).send({
        accepted: false,
        marketId,
        expired: engine.isExpired(marketId),
        operatorId: authz.operatorId,
        confirmOperatorId: authz.confirmOperatorId,
        rejected: authz.rejected,
      });
    }

    const result = await engine.expire(marketId, emergencyCmd(authz));
    return reply.code(200).send({
      accepted: result.accepted,
      marketId: result.marketId,
      expired: result.expired,
      operatorId: result.operatorId,
      confirmOperatorId: result.confirmOperatorId ?? authz.confirmOperatorId,
      rejected: result.rejected ?? null,
    });
  });

  app.post('/markets/:marketId/delist', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { marketId } = req.params as { marketId: string };
    const parsed = venueKillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const authz = await consumeVenueKill(parsed.data, 'matching.delist', { marketId }, `delist:${marketId}`);
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) {
      return reply.code(200).send({
        accepted: false,
        marketId,
        delisted: engine.isDelisted(marketId),
        operatorId: authz.operatorId,
        confirmOperatorId: authz.confirmOperatorId,
        rejected: authz.rejected,
      });
    }

    const result = await engine.delist(marketId, { operatorId: authz.operatorId, confirmOperatorId: authz.confirmOperatorId });
    return reply.code(200).send({
      accepted: result.accepted,
      marketId: result.marketId,
      delisted: result.delisted,
      operatorId: result.operatorId,
      confirmOperatorId: result.confirmOperatorId ?? authz.confirmOperatorId,
      rejected: result.rejected ?? null,
    });
  });

  const sendMatchingL2Sbe = (
    reply: FastifyReply,
    marketId: string,
    depth: { bids: Array<[string, string]>; asks: Array<[string, string]>; sequence: number },
  ) => {
    const encoded = encodeMatchingL2Sbe(sbe, {
      marketId,
      sequence: depth.sequence,
      bids: depth.bids,
      asks: depth.asks,
    });
    if (!encoded.ok) {
      return reply.code(MATCHING_SBE_REFUSE_HTTP).send(matchingSbeRefuseBody(encoded.reason, userCopy('matching.sbe_unavailable')));
    }
    reply.header('content-type', 'application/octet-stream');
    reply.header('x-intafaced-book', 'L2');
    reply.header('x-intafaced-template', 'DepthLevel');
    return reply.code(200).send(concatenateSbePayloads(encoded.payloads));
  };

  const readPublicL2 = (req: FastifyRequest, reply: FastifyReply) => {
    const { marketId } = req.params as { marketId: string };
    const limit = parsePublicL2QueryLimit((req.query as { limit?: string }).limit);
    if (limit === undefined) {
      return {
        ok: false as const,
        reply: reply.code(400).send({
          code: MATCHING_L2_LIMIT_UNSET,
          message: userCopy(MATCHING_L2_LIMIT_UNSET),
        }),
      };
    }
    const depth = engine.depth(marketId, limit);
    if (depth === null) {
      return {
        ok: false as const,
        reply: reply.code(404).send({ code: 'MarketNotFound', message: userCopy('matching.market_not_found') }),
      };
    }
    return { ok: true as const, marketId, depth };
  };

  // Native L3/queue. Separate path so GET /depth stays L2 tuples — never relabeled L3.
  // `?format=l3` on /depth is ignored; this door is the only L3 HTTP.
  // Same 1..500 window as public L2 — never invent 50 / dump the whole book.
  app.get('/markets/:marketId/depth/l3', async (req, reply) => {
    const limit = parsePublicL2QueryLimit((req.query as { limit?: string }).limit);
    if (limit === undefined) {
      return reply.code(400).send({
        code: MATCHING_L3_DEPTH_LIMIT_UNSET,
        message: userCopy(MATCHING_L3_DEPTH_LIMIT_UNSET),
      });
    }

    const { marketId } = req.params as { marketId: string };
    // An opened market with no orders yet is a real, empty queue, as on /depth.
    const known = (typeof engine.hasMarket === 'function' && engine.hasMarket(marketId)) || engine.isListed?.(marketId) === true;
    if (!known) {
      return reply.code(404).send({ code: 'MarketNotFound', message: userCopy('matching.market_not_found') });
    }

    const read = nativeL3FromEngine(engine, marketId);
    if (!read.ok) {
      return reply.code(200).send({
        accepted: false,
        marketId,
        level: null,
        bids: [],
        asks: [],
        rejected: { code: read.rejected.code, message: read.rejected.message },
        ...publicMatchingFlags(engine, marketId),
      });
    }

    return reply.code(200).send({
      ...read.queue,
      bids: read.queue.bids.slice(0, limit),
      asks: read.queue.asks.slice(0, limit),
      ...publicMatchingFlags(engine, marketId),
      makerIdentity: publicMakerIdentity(marketId),
      l4: l4(marketId),
    });
  });

  // SBE L2. Separate path so GET /depth stays JSON tuples. Utf8 JSON is never labeled SBE.
  app.get('/markets/:marketId/depth/sbe', async (req, reply) => {
    const read = readPublicL2(req, reply);
    if (!read.ok) return read.reply;
    return sendMatchingL2Sbe(reply, read.marketId, read.depth);
  });

  app.get('/markets/:marketId/depth', async (req, reply) => {
    const read = readPublicL2(req, reply);
    if (!read.ok) return read.reply;
    const { marketId, depth } = read;
    // format=sbe is Real Logic octets or refuse — never the JSON ladder as SBE.
    // format=l3 does not switch this door to L3 (see /depth/l3).
    if (wantsMatchingSbe(req.query as { format?: string })) {
      return sendMatchingL2Sbe(reply, marketId, depth);
    }
    // Flags are public — a live ladder without them looks tradable while submits refuse.
    // Optional methods so router tests can mount a partial engine.
    return reply.code(200).send({ marketId, ...depth, ...publicMatchingFlags(engine, marketId) });
  });

  app.get('/markets/:marketId/orders', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const limit = parseMatchingListQueryLimit((req.query as { limit?: string }).limit);
    if (limit === undefined) {
      return reply.code(400).send({
        code: MATCHING_RESTING_ORDERS_LIMIT_UNSET,
        message: userCopy(MATCHING_RESTING_ORDERS_LIMIT_UNSET),
      });
    }

    const { marketId } = req.params as { marketId: string };
    if (!engine.hasMarket(marketId)) {
      return reply.code(404).send({ code: 'MarketNotFound', message: userCopy('matching.market_not_found') });
    }

    return reply.code(200).send({ marketId, orders: engine.restingOrders(marketId).slice(0, limit) });
  });

  app.post('/reconcile', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const parsed = reconcileBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const report = reconcile(engine.restingOrders(), parsed.data.orders);
    return reply.code(200).send(report);
  });

  app.get('/markets', async () => publicMatchingBoard(engine));

  // ── Spreads (CB-otc-16) ────────────────────────────────────────────
  // Public reads, like depth and the market list: a listing and a spread price are not secrets.

  app.get('/spreads', async () => ({ instruments: engine.spreadInstruments().map(toWireSpread) }));

  app.get('/spreads/:spreadId/book', async (req, reply) => {
    const limit = parsePublicL2QueryLimit((req.query as { limit?: string }).limit);
    if (limit === undefined) {
      return reply.code(400).send({ code: MATCHING_L2_LIMIT_UNSET, message: userCopy(MATCHING_L2_LIMIT_UNSET) });
    }
    const { spreadId } = req.params as { spreadId: string };
    const view = engine.spreadBook(spreadId, limit);
    if (view === null) {
      return reply.code(404).send({ code: 'spread_unlisted', message: userCopy('matching.spread_unlisted') });
    }
    return reply.code(200).send({
      spreadId,
      instrument: toWireSpread(view.instrument),
      bids: view.bids,
      asks: view.asks,
      sequence: view.sequence,
      bestBid: view.bestBid,
      bestAsk: view.bestAsk,
      lastPrice: view.lastPrice,
      ...publicMatchingFlags(engine, spreadId),
    });
  });

  app.post('/spreads/:spreadId/list', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { spreadId } = req.params as { spreadId: string };
    const parsed = spreadListBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }

    const refused = (code: string, message: string, operatorId: string | null, confirmOperatorId: string | null) =>
      reply.code(200).send({
        accepted: false,
        spreadId,
        instrument: null,
        alreadyListed: false,
        operatorId,
        confirmOperatorId,
        rejected: { code, message },
      });

    // Read the definition before the approval is spent: a blank owner field refuses and the approval stays unused.
    const read = readSpreadListing({ ...parsed.data, spreadId });
    if (!read.ok) return refused(read.rejected.code, read.rejected.message, parsed.data.operatorId, parsed.data.confirmOperatorId ?? null);

    // The approval binds the exact definition, so a different ratio or tick needs a new approval.
    const authz = await consumeVenueKill(
      parsed.data,
      'matching.spread_list',
      { spreadId: read.instrument.spreadId, definition: spreadIdentity(read.instrument) },
      `spread_list:${read.instrument.spreadId}`,
    );
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) return refused(authz.rejected.code, authz.rejected.message, authz.operatorId, authz.confirmOperatorId);

    const result = await engine.listSpread(
      { ...parsed.data, spreadId },
      { operatorId: authz.operatorId, confirmOperatorId: authz.confirmOperatorId },
    );
    return reply.code(200).send({
      accepted: result.accepted,
      spreadId: result.spreadId,
      instrument: result.instrument === null ? null : toWireSpread(result.instrument),
      alreadyListed: result.alreadyListed,
      operatorId: authz.operatorId,
      confirmOperatorId: authz.confirmOperatorId,
      rejected: result.rejected ?? null,
    });
  });

  app.post('/spreads/:spreadId/orders', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const { spreadId } = req.params as { spreadId: string };
    const parsed = spreadOrderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    const proofIssues: string[] = [];
    if (parsed.data.lifecycleProof.snapshot.marketId !== spreadId) {
      proofIssues.push('lifecycleProof.snapshot.marketId: must match the route spreadId');
    }
    if (parsed.data.lifecycleProof.action !== 'PLACE') proofIssues.push('lifecycleProof.action: must be PLACE for a spread order');
    if (proofIssues.length > 0) return reply.code(400).send({ code: 'BadRequest', issues: proofIssues });

    const body = parsed.data;
    const result = await engine.submitSpread(
      spreadId,
      {
        orderId: body.orderId,
        accountId: body.accountId,
        side: body.side,
        qty: parseAmount(body.qty),
        price: parseAmount(body.price),
        tif: body.tif,
        anchorReference: body.anchorReference == null ? null : parseAmount(body.anchorReference),
        clientOrderId: body.clientOrderId ?? null,
        environment: body.environment ?? null,
        sessionId: body.sessionId ?? null,
      },
      body.lifecycleProof,
    );
    return reply.code(200).send(presentSubmit(result));
  });

  app.get('/rulebook', async () => presentRulebook(readRulebook(rulebookVersion)));

  // H9 — open cases from journal/book. Evidence only. Auth like resting orders.
  app.get('/surveillance/cases', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }

    const limit = parseMatchingListQueryLimit((req.query as { limit?: string }).limit);
    if (limit === undefined) {
      return reply.code(400).send({
        code: MATCHING_SURVEILLANCE_CASES_LIMIT_UNSET,
        message: userCopy(MATCHING_SURVEILLANCE_CASES_LIMIT_UNSET),
      });
    }

    const listed =
      typeof engine.openSurveillanceCases === 'function' ? engine.openSurveillanceCases() : ([] as readonly EngineSurveillanceCase[]);
    return reply.code(200).send({
      cases: listed.slice(0, limit).map(presentSurveillanceCase),
      detectors: {
        spoofing: detectorGap('spoofing'),
        layering: detectorGap('layering'),
      },
    });
  });

  app.post('/surveillance/adjudicate', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }
    const body = (req.body ?? {}) as { reason?: string | null };
    const refused = adjudicateSurveillanceCase({ reason: body.reason });
    return reply.code(200).send({
      ok: refused.ok,
      code: refused.code,
      message: refused.message,
      cases: typeof engine.openSurveillanceCases === 'function' ? engine.openSurveillanceCases().map(presentSurveillanceCase) : [],
    });
  });

  app.post('/surveillance/fine', async (req, reply) => {
    try {
      requireTradingService(req);
    } catch (err) {
      return authFailure(err, reply);
    }
    const refused = fineSurveillanceCase();
    return reply.code(200).send({
      ok: refused.ok,
      code: refused.code,
      message: refused.message,
      amount: null,
    });
  });

  if (options.edgePublicKey !== undefined) {
    try {
      edgePrincipalPublicKey(options.edgePublicKey);
    } catch {
      throw new EdgeTrustError('svc-matching: EDGE_PRINCIPAL_PUBLIC_KEY must be a raw 32-byte Ed25519 public key, base64url.');
    }
    try {
      assertEdgePrincipalLimits(options.principalLimits);
    } catch (e) {
      throw new EdgeTrustError(`svc-matching: ${(e as Error).message}`, (e as EdgeTrustError).code);
    }
  }
  const edgeTrust = {
    ...(options.edgePrincipalSecret ? { hmacSecret: options.edgePrincipalSecret } : {}),
    ...(options.edgePublicKey !== undefined ? { publicKey: options.edgePublicKey, limits: options.principalLimits } : {}),
  };

  const founderIdem = new Map<string, { fingerprint: string; value: unknown }>();

  const headerValue = (req: FastifyRequest, name: string): string | undefined => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  const founderPrincipal = async (
    req: FastifyRequest,
    scope: 'admin:read' | 'admin:write',
  ): Promise<
    | { ok: true; userId: string }
    | {
        ok: false;
        status: number;
        body: { code: string; message: string; rejected?: 'bad-signature' | 'malformed' | 'expired' | 'unconfigured' | null };
      }
  > => {
    if (!options.edgePrincipalSecret && options.edgePublicKey === undefined) {
      return {
        ok: false,
        status: 503,
        body: {
          code: 'matching.operator_auth_unconfigured',
          message: 'EDGE_PRINCIPAL_SECRET is unpublished. The founder door does not read the book and does not halt.',
        },
      };
    }
    const region = headerValue(req, 'x-intafaced-region') ?? 'XX';
    const verified = verifyForwardedPrincipal(
      headerValue(req, 'x-intafaced-principal'),
      headerValue(req, 'x-intafaced-principal-sig'),
      edgeTrust,
      new Date(),
      region,
    );
    if (verified.principal === null) {
      return {
        ok: false,
        status: 401,
        body: {
          code: 'token.invalid',
          message: verified.rejected ? `Edge principal refused (${verified.rejected}).` : 'An edge-signed principal is required.',
          rejected: verified.rejected,
        },
      };
    }
    try {
      requireScope(verified.principal, scope);
      if (scope === 'admin:write') requireMfa(verified.principal);
      return { ok: true, userId: verified.principal.userId };
    } catch (err) {
      if (err instanceof AuthError) {
        return {
          ok: false,
          status: err.code === 'scope.denied' ? 403 : 401,
          body: { code: err.code, message: err.message },
        };
      }
      throw err;
    }
  };

  app.get('/operator/in-flight', async (req, reply) => {
    const auth = await founderPrincipal(req, 'admin:read');
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    return reply.code(200).send(matchingInFlightRead(engine, new Date().toISOString()));
  });

  const founderBody = z.object({
    marketId: z.string().min(1).max(64).optional(),
    approvalId: z.string().max(128),
    operationId: z.string().max(128),
    idempotencyKey: z.string(),
  });

  const founderMutate = async (
    req: FastifyRequest,
    reply: FastifyReply,
    spec: {
      readonly actionType: string;
      readonly needsMarket: boolean;
      readonly targetId: (marketId: string) => string;
      readonly fields: (marketId: string) => Record<string, string>;
      readonly apply: (
        marketId: string,
        operatorId: string,
        confirmOperatorId: string,
        evidenceRefs: readonly string[],
      ) => Promise<Record<string, unknown>>;
    },
  ) => {
    const auth = await founderPrincipal(req, 'admin:write');
    if (!auth.ok) return reply.code(auth.status).send(auth.body);
    const parsed = founderBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ code: 'BadRequest', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    const key = idempotencyKeyOrNull(parsed.data.idempotencyKey);
    if (!key.ok) {
      return reply.code(400).send({ code: 'matching.idempotency_key_invalid', message: 'idempotencyKey must be 8 to 200 characters' });
    }
    const marketId = parsed.data.marketId ?? '';
    if (spec.needsMarket && !marketId) {
      return reply.code(400).send({ code: 'matching.market_required', message: 'marketId is required for this door' });
    }
    const fingerprint = JSON.stringify({
      actionType: spec.actionType,
      marketId,
      approvalId: parsed.data.approvalId,
      operationId: parsed.data.operationId,
    });
    const prior = founderIdem.get(key.key);
    if (prior && prior.fingerprint !== fingerprint) {
      return reply.code(409).send({
        code: 'matching.idempotency_conflict',
        message: 'This idempotency key was already used for a different request',
      });
    }
    if (prior) return reply.code(200).send(prior.value);
    const authz = await consumeVenueKill(
      {
        operatorId: auth.userId,
        approvalId: parsed.data.approvalId,
        operationId: parsed.data.operationId,
      },
      spec.actionType,
      spec.fields(marketId),
      spec.targetId(marketId),
    );
    if (!authz.ok && authz.status === 400) return reply.code(400).send(authz.body);
    if (!authz.ok) {
      return reply.code(200).send({
        accepted: false,
        marketId: spec.needsMarket ? marketId : undefined,
        operatorId: authz.operatorId,
        confirmOperatorId: authz.confirmOperatorId,
        rejected: authz.rejected,
      });
    }
    const applied = await spec.apply(marketId, authz.operatorId, authz.confirmOperatorId, authz.evidenceRefs);
    const value = { ...applied, rejected: applied.rejected ?? null };
    founderIdem.set(key.key, { fingerprint, value });
    return reply.code(200).send(value);
  };

  app.post('/operator/halt', async (req, reply) =>
    founderMutate(req, reply, {
      actionType: 'matching.halt',
      needsMarket: true,
      targetId: (marketId) => `halt:${marketId}`,
      fields: (marketId) => ({ marketId }),
      apply: async (marketId, operatorId, confirmOperatorId, evidenceRefs) => {
        const result = await engine.halt(marketId, { operatorId, confirmOperatorId, evidenceRefs });
        return {
          accepted: result.accepted,
          marketId: result.marketId,
          halted: result.halted,
          operatorId: result.operatorId,
          confirmOperatorId: result.confirmOperatorId ?? confirmOperatorId,
          rejected: result.rejected ?? null,
        };
      },
    }),
  );

  app.post('/operator/resume', async (req, reply) =>
    founderMutate(req, reply, {
      actionType: 'matching.resume',
      needsMarket: true,
      targetId: (marketId) => `resume:${marketId}`,
      fields: (marketId) => ({ marketId }),
      apply: async (marketId, operatorId, confirmOperatorId, evidenceRefs) => {
        const result = await engine.resume(marketId, { operatorId, confirmOperatorId, evidenceRefs });
        return {
          accepted: result.accepted,
          marketId: result.marketId,
          halted: result.halted,
          operatorId: result.operatorId,
          confirmOperatorId: result.confirmOperatorId ?? confirmOperatorId,
          rejected: result.rejected ?? null,
        };
      },
    }),
  );

  app.post('/operator/halt-all', async (req, reply) =>
    founderMutate(req, reply, {
      actionType: 'matching.halt_all',
      needsMarket: false,
      targetId: () => 'halt_all',
      fields: () => ({}),
      apply: async (_marketId, operatorId, confirmOperatorId, evidenceRefs) => {
        const result = await engine.haltAll({ operatorId, confirmOperatorId, evidenceRefs });
        return {
          accepted: result.accepted,
          halted: result.halted,
          operatorId: result.operatorId,
          confirmOperatorId: result.confirmOperatorId ?? confirmOperatorId,
          rejected: result.rejected ?? null,
        };
      },
    }),
  );

  app.post('/operator/resume-all', async (req, reply) =>
    founderMutate(req, reply, {
      actionType: 'matching.resume_all',
      needsMarket: false,
      targetId: () => 'resume_all',
      fields: () => ({}),
      apply: async (_marketId, operatorId, confirmOperatorId, evidenceRefs) => {
        const result = await engine.resumeAll({ operatorId, confirmOperatorId, evidenceRefs });
        return {
          accepted: result.accepted,
          halted: result.halted,
          operatorId: result.operatorId,
          confirmOperatorId: result.confirmOperatorId ?? confirmOperatorId,
          rejected: result.rejected ?? null,
        };
      },
    }),
  );
}

function presentSurveillanceCase(row: EngineSurveillanceCase) {
  return {
    accountId: row.accountId,
    marketId: row.marketId,
    reason: row.reason,
    status: 'open' as const,
  };
}

/** Public matching mode. Missing methods (test stubs) are not invented OPEN flags. */
function publicMatchingFlags(
  engine: MatchingEngine,
  marketId: string,
): {
  readonly venueHalted: boolean;
  readonly halted: boolean;
  readonly prelaunch: boolean;
  readonly expired: boolean;
  readonly delisted: boolean;
  readonly reduceOnly: boolean;
  readonly postOnly: boolean;
} {
  return {
    venueHalted: engine.isVenueHalted === true,
    halted: engine.isHalted?.(marketId) === true,
    prelaunch: engine.isPrelaunch?.(marketId) === true,
    expired: engine.isExpired?.(marketId) === true,
    delisted: engine.isDelisted?.(marketId) === true,
    reduceOnly: engine.isReduceOnly?.(marketId) === true,
    postOnly: engine.isPostOnly?.(marketId) === true,
  };
}

function publicMatchingBoard(engine: MatchingEngine): {
  readonly markets: readonly string[];
  readonly venueHalted: boolean;
  readonly halted: readonly string[];
  /** When each halted market's halt began (ISO time), keyed by market id; and the venue halt's start, null when open. */
  readonly haltedSince: Readonly<Record<string, string>>;
  readonly venueHaltedSince: string | null;
  readonly prelaunch: readonly string[];
  readonly expired: readonly string[];
  readonly delisted: readonly string[];
  readonly reduceOnly: readonly string[];
  readonly postOnly: readonly string[];
} {
  const markets = [...(engine.markets ?? [])];
  return {
    markets,
    venueHalted: engine.isVenueHalted === true,
    halted: markets.filter((id) => engine.isHalted?.(id) === true),
    haltedSince: Object.fromEntries(
      markets.flatMap((id) => {
        const at = engine.haltedSinceOf?.(id) ?? null;
        return at === null ? [] : [[id, at]];
      }),
    ),
    venueHaltedSince: engine.venueHaltedSince ?? null,
    prelaunch: markets.filter((id) => engine.isPrelaunch?.(id) === true),
    expired: markets.filter((id) => engine.isExpired?.(id) === true),
    delisted: markets.filter((id) => engine.isDelisted?.(id) === true),
    reduceOnly: markets.filter((id) => engine.isReduceOnly?.(id) === true),
    postOnly: markets.filter((id) => engine.isPostOnly?.(id) === true),
  };
}
