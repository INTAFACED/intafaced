import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { venueGridSchema } from './trade-grid-procedures.js';
import { orderSideSchema } from './order-enums.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** The schemas svc-trade's records share, moved from the service so the records and every caller read one copy. */

/** The desk's answer schemas: each names every key its handler answers with (`answerKeys`), and checks no more. */
export const deskQuarantine = z.object({ operatorId: z.string(), reason: z.string(), at: z.string(), requestId: z.string() });

/** A value the desk could not read reads `known: false`; the two branches differ on the literal, so either order is safe. */
export const deskConnectionsAnswer = z.object({
  rows: z
    .array(
      z.object({
        keyId: z.string(),
        userId: z.string(),
        accountId: z.string(),
        connectedAt: z.string(),
        endedAt: z.string().nullable(),
        asset: z.string().nullable(),
        cap: z.string().nullable(),
        accountStatus: z.string().nullable(),
        balance: z.union([z.object({ known: z.literal(true), value: z.string() }), z.object({ known: z.literal(false) })]),
        keyState: z.enum(['live', 'revoked', 'missing', 'unknown']),
        lastAction: z.union([
          z.object({
            known: z.literal(true),
            value: z.object({ at: z.string(), method: z.string(), path: z.string(), status: z.number() }).nullable(),
          }),
          z.object({ known: z.literal(false) }),
        ]),
        quarantine: deskQuarantine.nullable(),
      }),
    )
    .readonly(),
  limit: z.number(),
  more: z.boolean(),
  test: z.boolean().nullable(),
});

/** An audit row, keys in the order the desk writes them: its own fields, then the quarantine's. */
export const deskAuditRow = z.object({
  id: z.string(),
  action: z.literal('quarantine'),
  keyId: z.string(),
  userId: z.string(),
  accountId: z.string(),
  ...deskQuarantine.shape,
});

export const deskAuditAnswer = z.object({ rows: z.array(deskAuditRow).readonly(), limit: z.number() });

export const deskConnectionAnswer = z.object({ keyId: z.string(), userId: z.string(), accountId: z.string() });

export const deskQuarantineAnswer = z.object({ quarantine: deskAuditRow, endedAt: z.string(), replayed: z.boolean() });

export const myLeadApplicationShape = z.object({
  applicationId: z.string(),
  state: z.enum(['submitted', 'under_review', 'approved', 'disapproved']),
  displayName: z.string(),
  submittedAt: z.string(),
  reason: z.string().nullable(),
  reapplyAfter: z.string().nullable(),
});

/** `copy.myLeadApplication`: the caller's newest application, or null. */
export const myLeadApplicationAnswer = myLeadApplicationShape.nullable();

/** `copy.leadEligibility`. The read form is tried first: only it has `owner`, `test`, `usdc` and `asOf`, and its state is `read`, which the other branch refuses. */
export const leadEligibilityAnswer = z.object({
  following: z.object({ leaderRef: z.string().nullable(), displayName: z.string() }).nullable(),
  threshold: z.string().nullable(),
  venue: z.union([
    z.object({ state: z.literal('read'), owner: z.string(), test: z.boolean(), usdc: z.string(), asOf: z.string() }),
    z.object({ state: z.enum(['off', 'none', 'unreadable']) }),
  ]),
});

/** `copy.applyToLead`: the caller's application, new or the open one answered again. */
export const applyToLeadAnswer = myLeadApplicationShape;

/** `copy.myLead`: the caller's lead account once approved, or null. */
export const myLeadAnswer = z
  .object({
    leaderRef: z.string(),
    applicationId: z.string(),
    displayName: z.string(),
    state: z.string(),
    instruments: z.array(z.string()).readonly(),
  })
  .nullable();

export const copyLeaderTradesAnswer = z.object({
  trades: z
    .array(
      z.object({
        tradeId: z.string(),
        symbol: z.string(),
        state: z.enum(['open', 'closed']),
        openedAt: z.string().nullable(),
        closedAt: z.string().nullable(),
        entryPrice: z.string().nullable(),
        qty: z.string(),
        margin: z.string().nullable(),
        takeProfit: z.string().nullable(),
        stopLoss: z.string().nullable(),
        closePrice: z.string().nullable(),
        closedQty: z.string(),
        roiPercent: z.string().nullable(),
      }),
    )
    .readonly(),
  nextCursor: z.string().nullable(),
});

/** Unsigned decimal string. Reuses the exchange contract's rule rather than inventing a second one. */
export const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amounts are unsigned decimal strings with at most 18 decimal places');

/** copy.follow's input, and copy.checkVenueFollow's without the agent account. */
export const copyFollowInput = z.object({
  leaderId: z.string().min(1).max(120).optional(),
  leaderRef: z.string().min(1).max(80).optional(),
  region: z.string().min(1).max(16),
  permittedMarkets: z.array(z.string().min(1).max(64)).min(1).max(64),
  maxNotionalPerOrder: decimal,
  maxAggregateExposure: decimal,
  maxLoss: decimal.optional(),
  maxSlippageBps: z.number().int().min(1).max(10_000).optional(),
  maxConcurrent: z.number().int().min(1).max(2_147_483_647).optional(),
  maxDrawdown: decimal.optional(),
  maxLeverage: z.union([z.string(), z.number()]).optional(),
  expiresAt: z.string().datetime(),
  /** The request's own key: a second press with the same key returns the same follow. */
  clientRequestId: z.string().min(8).max(120),
  /** Quote amount each copied order uses. Omitted means no fixed size. */
  fixedOrderSize: decimal.optional(),
  /** How each copy is sized; multiplier is accepted and refused (owner decision). Omitted → fixed amount. */
  sizingMode: z.enum(['fixed_amount', 'smart_sync', 'multiplier']).optional(),
  /** Most copied into one market, and per owner day. Omitted → not set. */
  maxPerMarket: decimal.optional(),
  maxPerDay: decimal.optional(),
  /**
   * One of the follower's own open agent accounts: the follow then copies on the venue, each copy a venue order
   * on that account placed by its agent permission, and nothing is held from a balance of ours (venue-copy.ts).
   */
  agentAccountId: z.string().uuid().optional(),
  leaderSettings: z
    .object({
      maxAllocation: decimal.optional(),
      permittedInstruments: z.array(z.string().min(1).max(64)).max(64).optional(),
      maxLoss: decimal.optional(),
      maxSlippageBps: z.number().int().min(1).max(10_000).optional(),
      maxConcurrent: z.number().int().min(1).max(2_147_483_647).optional(),
      maxDrawdown: decimal.optional(),
    })
    .optional(),
});

/** One follow as its follower sees it (follows.ts `presentCopyFollow`). */
export const copyFollowAnswer = z.object({
  followId: z.string(),
  followerId: z.string(),
  leaderId: z.string().nullable(),
  leaderRef: z.string().nullable(),
  permittedMarkets: z.array(z.string()).readonly(),
  maxNotionalPerOrder: z.string(),
  maxAggregateExposure: z.string(),
  fixedOrderSize: z.string().nullable(),
  sizingMode: z.enum(['fixed_amount', 'smart_sync']),
  smartSync: z.object({ followerTotal: z.string() }).nullable(),
  maxPerMarket: z.string().nullable(),
  maxPerDay: z.string().nullable(),
  reserve: z.object({ asset: z.string(), amount: z.string(), released: z.boolean() }).nullable(),
  maxLoss: z.string().nullable(),
  maxSlippageBps: z.number().nullable(),
  maxConcurrent: z.number().nullable(),
  maxDrawdown: z.string().nullable(),
  peakResult: z.string().nullable(),
  currentExposure: z.string(),
  remainingExposure: z.string(),
  expiresAt: z.string(),
  region: z.string(),
  createdAt: z.string(),
  feeShareKilled: z.boolean(),
  sessionKeyGranted: z.boolean(),
  sessionKeyRevoked: z.boolean(),
  relationshipState: z.enum(['ACTIVE', 'PAUSED', 'STOPPING', 'CLOSE_ONLY', 'DETACHED']),
  newIntentFenced: z.boolean(),
  leaderStatus: z.enum(['listed', 'suspended', 'delisted', 'unknown']),
  // Last, as presentCopyFollow spreads them after every other key (and a grant adds sessionKey after them).
  sessionKeyPrefix: z.string().optional(),
  sessionKeyId: z.string().optional(),
  sessionKey: z.string().optional(),
});

/**
 * The venue follow's check (copy-service.ts `checkVenueFollow`). The unwritten form is tried first: only it has
 * `quoteAsset`, and its follow is null, so a follow already written (an object) never reads as one.
 */
export const copyCheckVenueFollowAnswer = z.union([
  z.object({ followId: z.string(), follow: z.null(), quoteAsset: z.string(), maxAggregateExposure: z.string() }),
  z.object({ followId: z.string(), follow: copyFollowAnswer }),
]);

/** A new session key's grant: the follow with the key's id and its raw token, shown this once. `extend` keeps both keys where copyFollowAnswer puts them, last. */
export const copyGrantSessionKeyAnswer = copyFollowAnswer.extend({ sessionKeyId: z.string(), sessionKey: z.string() });

export const copyCloseCopiedPositionAnswer = z.object({
  followId: z.string(),
  positionId: z.string(),
  orderId: z.string(),
  qty: z.string(),
  duplicate: z.boolean(),
});

export const copySkipLogAnswer = z.object({
  items: z.array(
    z.object({
      leaderFillId: z.string(),
      reason: z.enum([
        'paused',
        'stopped',
        'lead_stopped',
        'platform_paused',
        'risk_control',
        'insufficient_funds',
        'max_copy_total',
        'per_contract_cap',
        'daily_cap',
        'copy_slippage_exceeded',
        'position_closed',
        'not_lead_order',
        'refused',
      ]),
      at: z.string(),
    }),
  ),
});

/** `copy.leadEarnings`. */
export const leadEarningsAnswer = z.object({
  profitShare: z.string(),
  leaderShareBps: z.string().nullable(),
  totals: z.array(z.object({ assetId: assetIdSchema, amount: z.string() })),
  items: z.array(
    z.object({
      fillId: z.string(),
      followId: z.string(),
      assetId: assetIdSchema,
      feeOnFill: z.string(),
      appliedShareBps: z.number(),
      amount: z.string(),
      at: z.string(),
      venueFillId: z.string().nullable(),
      ledgerKey: z.string(),
      owedBy: z.literal('intafaced'),
    }),
  ),
});

/** `copy.leadLevel`. */
export const leadLevelAnswer = z.object({
  leaderRef: z.string().nullable(),
  listingState: z.string().nullable(),
  level: z.null(),
  levelReason: z.literal('thresholds_unset'),
  maxRatio: z.null(),
});

/** `copy.leadMissions`. */
export const leadMissionsAnswer = z.object({
  missions: z.array(z.object({ id: z.enum(['apply', 'fund', 'listed']), done: z.boolean(), detail: z.string() })).readonly(),
  done: z.number(),
  total: z.number(),
});

export const leadTradeShape = z.object({
  orderId: z.string(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  price: z.string().nullable(),
  amount: z.string(),
  filled: z.string(),
  status: z.string(),
  at: z.string(),
});

/** `copy.leadTrades`. */
export const leadTradesAnswer = z.object({
  ongoing: z.array(leadTradeShape).readonly(),
  history: z.array(leadTradeShape).readonly(),
  counts: z.object({ ongoing: z.number(), history: z.number() }),
});

/** `copy.leadCopiers`. */
export const leadCopiersAnswer = z.array(
  z.object({
    followRef: z.string(),
    status: z.enum(['Active', 'Paused', 'Stopping', 'Close only', 'Stopped']),
    since: z.string(),
  }),
);

/** `copy.platformPauses`. */
export const platformPausesAnswer = z.object({
  leads: z.array(z.string()).readonly(),
  botTypes: z.array(z.string()).readonly(),
  symbols: z.array(z.string()).readonly(),
});

export const convertPairsOutput = z.object({
  assets: z.array(
    z.object({
      asset: z.string(),
      maxPerConvert: z.object({ amount: z.string(), asset: z.string() }).nullable(),
    }),
  ),
  restricted: z.array(z.string()),
  paused: z.boolean(),
});

export const limitConvertOutput = z.object({
  id: z.string(),
  clientLimitId: z.string(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  fromAsset: z.string(),
  toAsset: z.string(),
  amount: decimal,
  targetRate: decimal,
  status: z.enum(['placing', 'waiting', 'triggered', 'filled', 'cancelling', 'cancelled', 'ended']),
  quoteId: z.string().nullable(),
  fillId: z.string().nullable(),
  paid: decimal.nullable(),
  received: decimal.nullable(),
  endCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ALGO_STOP_REASONS = {
  cancel_incomplete: 'Cancel incomplete',
  market_closed: 'Market closed',
  mark_unavailable: 'Market price unavailable',
  price_band: 'Price outside the limit',
  no_liquidity: 'No liquidity',
  no_volume: 'No market volume',
  insufficient_balance: 'Insufficient balance',
  account_unavailable: 'Account unavailable',
  order_refused: 'Order refused',
  chase_max_distance: 'Maximum chase distance reached',
  chase_expired: 'Chase time ended',
  chase_child_unaccounted: 'Stopped: a fill is still settling',
  liquidation: 'Liquidation',
  delisting: 'Delisting',
  position_limit: 'Position limit',
  contract_change: 'Contract parameter change',
  copied_lead_stop: 'Copied lead stopped',
  unrecorded: 'Stop reason not recorded',
} as const;

export type AlgoStopReasonCode = keyof typeof ALGO_STOP_REASONS;

/** Shared TWAP parent presentation (create/get/pause/resume/cancel). */
export const algoStopReasonSchema = z
  .object({
    code: z.enum(Object.keys(ALGO_STOP_REASONS) as [AlgoStopReasonCode, ...AlgoStopReasonCode[]]),
    label: z.string(),
  })
  .nullable();

export const algoSchedulerOutputSchema = z.object({
  running: z.boolean().nullable(),
  reason: z.enum(['jobs_disabled', 'heartbeat_unknown', 'heartbeat_stale', 'jobs_interval_unset']).nullable(),
});

export const algoScheduleHonestySchema = {
  nextSliceAt: z.string().nullable(),
  scheduler: algoSchedulerOutputSchema,
};

/** Largest seed a schedule accepts: an unsigned 32-bit integer, the PRNG's whole state. */
export const MAX_ALGO_SEED = 0xffff_ffff;

export const signedDecimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'signed amounts are decimal strings with at most 18 decimal places');

export const algoResultOutputSchema = z.object({
  quotes: z.array(
    z.object({
      quoteAsset: z.string(),
      filledQty: decimal,
      notional: decimal,
      averageFillPrice: decimal.nullable(),
      feesPaid: z.array(z.object({ asset: z.string(), amount: decimal })).nullable(),
      feesReason: z.enum(['fee_not_recorded']).nullable(),
      arrivalPrice: decimal.nullable(),
      arrivalReason: z.enum(['arrival_not_recorded']).nullable(),
      shortfall: signedDecimal.nullable(),
      shortfallMissing: z
        .object({
          code: z.literal('missing_input'),
          fields: z.array(z.enum(['averageFillPrice', 'arrivalPrice'])),
        })
        .nullable(),
    }),
  ),
});

export const otcMaker = z.object({
  id: z.string(),
  name: z.string(),
  route: z.enum(['platform', 'outside']),
  spreadBps: z.number().optional(),
});

/** The two forms differ in their `published` literal, so neither can read as the other and the order is safe. */
export const otcMakersAnswer = z.union([
  z.object({ published: z.literal(false), makers: z.array(otcMaker), selectCap: z.null(), emptyLabel: z.string() }),
  z.object({ published: z.literal(true), makers: z.array(otcMaker), selectCap: z.number(), emptyLabel: z.null() }),
]);

export const otcSide = z.enum(['buy', 'sell']);

export const otcCounterparty = z.enum(['platform', 'maker']);

export const boundOtcFillFields = {
  quoteId: z.string(),
  side: otcSide,
  baseAsset: z.string(),
  quoteAsset: z.string(),
  qty: z.string(),
  fillPrice: z.string(),
  fillNotional: z.string(),
  spreadBps: z.number(),
  counterparty: otcCounterparty,
  counterpartyId: z.string(),
  acceptedAt: z.string(),
};

export const otcAcceptAnswer = z.object(boundOtcFillFields);

export const otcSettleAnswer = z.object({
  fillId: z.string(),
  takerOrderId: z.string(),
  makerOrderId: z.string(),
  ...boundOtcFillFields,
});

export const convertFlowBounds = z.object({ minQty: z.string(), maxQty: z.string() }).nullable();

export const otcConvertBoundsAnswer = z.object({ convert: convertFlowBounds, oneClickBuy: convertFlowBounds });

/** `presentOtcQuote` (rfq.ts). */
export const otcQuoteFields = {
  quoteId: z.string(),
  side: otcSide,
  baseAsset: z.string(),
  quoteAsset: z.string(),
  qty: z.string(),
  midPrice: z.string(),
  quotedPrice: z.string(),
  midNotional: z.string(),
  userNotional: z.string(),
  spreadBps: z.number(),
  spreadNotional: z.string(),
  counterparty: otcCounterparty,
  counterpartyId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  status: z.literal('open'),
  rfqId: z.string(),
  rfqSeq: z.number(),
  makerId: z.string().nullable(),
  test: z.boolean(),
};

/** `presentFirmRfq` (rfq.ts). */
export const firmRfqFields = {
  ...otcQuoteFields,
  lifecycle: z.enum(['open', 'bound', 'expired', 'settled']),
  acceptedAt: z.string().nullable(),
  fillPrice: z.string().nullable(),
  settleBy: z.string().nullable(),
  settleWindowMs: z.number().nullable(),
  bookFill: z.literal(false),
  midInvented: z.literal(false),
};

export const firmRfqAnswer = z.object(firmRfqFields);

/**
 * The answer schemas: each names every key its handler answers with (`answerKeys`) and checks no more than the
 * handler's own type, so a reply leaves exactly as it did before the schema was added.
 */
export const signalWebhookFields = {
  webhookId: z.string(),
  symbol: z.string(),
  venueOwner: z.string(),
  path: z.string(),
  tokenPrefix: z.string(),
  state: z.enum(['active', 'paused', 'ended']),
  createdAt: z.string(),
};

/** The new webhook with its token, shown once; null on a repeat of the same request. */
export const signalWebhookCreatedAnswer = z.object({ ...signalWebhookFields, token: z.string().nullable() });

/**
 * The answer schemas: each names every key its handler answers with (`answerKeys`) and checks no more than the
 * handler's own type, so a reply leaves exactly as it did before the schema was added.
 */
export const gridSetupAnswer = z.object({
  countRange: z.object({ min: z.number(), max: z.number() }).nullable(),
  boundsMaxDistanceBps: z.number().nullable(),
});

export const gridPresetsAnswer = z.object({ source: z.null(), presets: z.tuple([]).readonly() });

export const gridSide = z.enum(['buy', 'sell']);

/** A grid on our own book (grid-service.ts). */
export const ownGridAnswer = z.object({
  botId: z.string(),
  clientRequestId: z.string(),
  symbol: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  lowerPrice: z.string(),
  upperPrice: z.string(),
  gridCount: z.number(),
  investment: z.string(),
  reinitCount: z.number(),
  status: z.enum(['initializing', 'running', 'paused_range', 'initialization_failed', 'stopped']),
  statusReason: z.string().nullable(),
  reserve: z.object({ key: z.string(), asset: z.string(), amount: z.string(), releasedAt: z.string().nullable() }).nullable(),
  levels: z
    .array(
      z.object({
        index: z.number(),
        price: z.string(),
        qty: z.string(),
        hold: z.string(),
        openOrder: z.object({ side: gridSide, orderId: z.string(), clientOrderId: z.string() }).nullable(),
      }),
    )
    .readonly(),
  orders: z
    .array(
      z.object({
        clientOrderId: z.string(),
        orderId: z.string(),
        levelIndex: z.number(),
        side: gridSide,
        cycle: z.number(),
        price: z.string(),
        qty: z.string(),
        holdAmount: z.string(),
        status: z.enum(['open', 'filled', 'partial', 'cancelled']),
        pairProfit: z.string().nullable(),
      }),
    )
    .readonly(),
  exits: z.object({ stopBelow: z.string().nullable(), stopAbove: z.string().nullable(), rsi: z.object({ source: z.null() }) }),
  gridProfit: z.string(),
  withdrawableProfit: z.string(),
  closedPairs: z.number(),
  gridApr: z.union([
    z.object({ state: z.literal('under_a_day'), percent: z.null() }),
    z.object({ state: z.literal('set'), percent: z.string() }),
  ]),
  createdAt: z.string(),
});

/**
 * A grid on the person's own venue account (venue-grid.ts) or on our own book. The venue form is tried first: only it
 * has `venue`, so a grid on our own book never reads as one.
 */
export const gridAnswer = z.union([venueGridSchema, ownGridAnswer]);

export const gridTopUpFreeAnswer = z.object({ asset: z.string(), free: z.string() });

/** Decimal strings only on the wire; blank is allowed through so the service names the blank field. */
export const decimalOrBlank = z.string().max(64).optional().nullable();

export const gridTopUpAnswer = z.object({
  topUpId: z.string(),
  botId: z.string(),
  asset: z.string(),
  amount: z.string(),
  investmentBefore: z.string(),
  investmentAfter: z.string(),
  freeBefore: z.string(),
  appliedAt: z.string(),
  bot: ownGridAnswer,
});

export const gridWithdrawalAnswer = z.object({
  withdrawalId: z.string(),
  botId: z.string(),
  asset: z.string(),
  amount: z.string(),
  profitBefore: z.string(),
  profitAfter: z.string(),
  reserveBefore: z.string(),
  reserveAfter: z.string(),
  dailyCap: z.string(),
  capUsed: z.string(),
  capRemaining: z.string(),
  stepUpEventId: z.string(),
  appliedAt: z.string(),
});

export const convertSourceOutput = z.object({
  kind: z.literal('book'),
  symbol: z.string(),
  asOf: z.string(),
});

export const convertQuoteOutput = z.object({
  quoteId: z.string(),
  symbol: z.string(),
  side: orderSideSchema,
  requestedQty: decimal,
  filledQty: decimal,
  bookNotional: decimal,
  userNotional: decimal,
  avgPrice: decimal,
  fullyFilled: z.boolean(),
  convertSpreadBps: z.number().int(),
  expiresAt: z.string(),
  source: convertSourceOutput,
  inAsset: z.string(),
  outAsset: z.string(),
  inAmount: decimal,
  outAmount: decimal,
});

export const convertAcceptInput = z.object({
  quoteId: z.string().min(1).max(64),
  clientConvertId: z.string().min(1).max(48).optional(),
  symbol: z.string().min(3).optional(),
  side: orderSideSchema.optional(),
  qty: decimal.optional(),
  maxAvgPrice: decimal.optional(),
});

export const convertTradeOutput = z.object({
  quoteId: z.string(),
  fillId: z.string(),
  takerOrderId: z.string(),
  makerOrderId: z.string(),
  symbol: z.string(),
  side: orderSideSchema,
  inAsset: z.string(),
  outAsset: z.string(),
  inAmount: decimal,
  outAmount: decimal,
  fillPrice: decimal,
  fillNotional: decimal,
  convertSpreadBps: z.number().int(),
  source: convertSourceOutput,
  expiresAt: z.string(),
  acceptedAt: z.string(),
  settledAt: z.string(),
});

/**
 * What a POV participation rate is applied to: the taker volume traded in the last interval, or the resting
 * quantity on the opposite side of the book (the side the child would take from).
 */
export type PovBasis = 'traded_volume' | 'opposite_liquidity';

export const POV_BASES: readonly PovBasis[] = ['traded_volume', 'opposite_liquidity'];

export const algoParentOutputSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  side: orderSideSchema,
  kind: z.enum(['twap', 'vwap', 'pov', 'chase']),
  totalQty: decimal,
  durationMs: z.number().int(),
  sliceIntervalMs: z.number().int(),
  limitPrice: decimal.nullable(),
  status: z.enum(['active', 'paused', 'cancelled', 'completed', 'halted']),
  slicesPlanned: z.number().int(),
  nextSliceIndex: z.number().int(),
  childrenEmitted: z.number().int(),
  missesRecorded: z.number().int(),
  haltReason: z.string().nullable(),
  stopReason: algoStopReasonSchema,
  participationBps: z.number().int().nullable(),
  /** POV: what participation is applied to; null for TWAP and VWAP. */
  povBasis: z.enum(POV_BASES).nullable(),
  createdAt: z.string(),
  startedAt: z.string(),
  nextDueAt: z.string(),
  /** Projected wall-clock end after last re-space (ADR 2026-08-08). */
  projectedEndsAt: z.string(),
  /** Distinguishes user pause from tick outage; null until first stretch. */
  scheduleStretchReason: z.enum(['user_pause', 'tick_outage']).nullable(),
  /** Set when the slice sizes are random, fixed by this seed. */
  randomSeed: z.number().int().nullable(),
  /** The price the schedule waits for before its first slice; null when it starts at once. */
  triggerPrice: decimal.nullable(),
  triggeredAt: z.string().nullable(),
  awaitingTrigger: z.boolean(),
  /** Chase: the caller's maximum distance from the start price, in bps; null for other kinds. */
  chaseMaxDistanceBps: z.number().int().nullable(),
  /** Chase: the best same-side price read at create, the distance's origin. */
  chaseStartPrice: decimal.nullable(),
  /** Chase: the price of the newest child; null before the first child and for other kinds. */
  chasePrice: decimal.nullable(),
  /** Chase: how many times the child was re-priced (children placed after the first). */
  chaseReprices: z.number().int().nullable(),
});

export const algoGetOutputSchema = algoParentOutputSchema.extend({
  children: z.array(
    z.object({
      orderId: z.string(),
      sliceIndex: z.number().int(),
      time: z.string(),
      qty: decimal,
      basisQty: decimal.nullable(),
      price: decimal.nullable(),
    }),
  ),
  misses: z.array(z.object({ sliceIndex: z.number().int(), time: z.string(), code: z.string() })),
  filledQty: decimal,
  /** The planned size of every slice, in order, as stored with the parent. */
  plannedSliceQtys: z.array(decimal),
  ...algoScheduleHonestySchema,
});

export const algoPolicyAnswer = z.object({
  productKind: z.literal('twap'),
  capability: z.object({
    createEnabled: z.boolean(),
    jobsEnabled: z.boolean(),
    jobsDefault: z.literal(false),
    icebergs: z.literal('out'),
  }),
  parentHoldsNoBalance: z.literal(true),
  progressFromChildFillsOnly: z.literal(true),
  cancelIncompleteHalt: z.literal('cancel_incomplete'),
  cancelIncompleteCode: z.literal('trade.algo_cancel_incomplete'),
  resumeRefusedOnCancelIncomplete: z.literal(true),
  vwapPovImmatureRefused: z.literal(true),
  volumeImmatureCode: z.literal('trade.algo_volume_immature'),
  immatureKinds: z.tuple([z.literal('vwap'), z.literal('pov')]).readonly(),
  inventsParentFill: z.literal(false),
  inventsVwapCurve: z.literal(false),
  inventsPovVolume: z.literal(false),
  moneyViaLedgerClientOnly: z.literal(true),
});

/** The kinds an engine runs. */
export const ALGO_KINDS = ['twap', 'vwap', 'pov', 'chase'] as const;

/**
 * The algo order API's states (SP-conditional-algo-04), one set for every kind, in the order the developer page lists
 * them: live (running or waiting), effective (finished, filled whole), partially_effective (finished, part filled),
 * canceled, order_failed (halted, or finished with nothing filled). svc-trade maps each parent to one of them.
 */
export const ALGO_API_STATES = ['live', 'effective', 'partially_effective', 'canceled', 'order_failed'] as const;
export type AlgoApiState = (typeof ALGO_API_STATES)[number];

/** One algo create, as the web's `trade.algo.createTwap` and the public `POST /api/v1/algo` take it. */
export const algoCreateInputSchema = z.object({
  symbol: z.string().min(3),
  side: orderSideSchema,
  totalQty: decimal,
  durationMs: z.number().int().min(1_000).max(86_400_000),
  sliceIntervalMs: z.number().int().min(1_000).max(86_400_000),
  limitPrice: decimal.optional(),
  clientAlgoId: z.string().trim().min(1).max(48),
  subAccountId: z.string().guid().optional(),
  kind: z.enum(ALGO_KINDS).optional(),
  participationBps: z.number().int().min(1).max(10_000).optional(),
  chaseDistanceBps: z.number().int().min(1).max(10_000).optional(),
  povBasis: z.enum(POV_BASES).optional(),
  randomSeed: z.number().int().min(0).max(MAX_ALGO_SEED).optional(),
  triggerPrice: decimal.optional(),
});

export const algoListAnswer = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      market: z.string(),
      side: orderSideSchema,
      totalQty: z.string(),
      filledQty: z.string(),
      status: z.enum(['active', 'paused', 'cancelled', 'completed', 'halted']),
      created: z.string(),
      nextSliceAt: z.string().nullable(),
      scheduler: z.object({
        running: z.boolean().nullable(),
        reason: z.enum(['jobs_disabled', 'heartbeat_unknown', 'heartbeat_stale', 'jobs_interval_unset']).nullable(),
      }),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const otcConvertQuoteAnswer = z.object({
  flow: z.enum(['convert', 'oneClickBuy']),
  ...otcQuoteFields,
  settleWindowMs: z.number().nullable(),
});

/**
 * Closed set for the customer desk and blank-law refusals.
 * TRD-0722 names no code for an unmounted copy service, so that case is `trade.copy_unavailable`.
 */
export const COPY_DESK_BLOCKER_CODES = [
  'trade.copy_fee_share_blank',
  'trade.copy_jurisdiction_blank',
  'trade.copy_place_disabled',
  'trade.copy_unavailable',
] as const;

export type CopyDeskBlockerCode = (typeof COPY_DESK_BLOCKER_CODES)[number];

export const blockerCode = z.enum(COPY_DESK_BLOCKER_CODES as unknown as [CopyDeskBlockerCode, ...CopyDeskBlockerCode[]]);

export const copyDeskStatusOutput = z.object({
  sovereign: z.object({
    shape: z.literal('sovereign'),
    custody: z.literal(false),
    feeModel: z.literal('protocol_fee_share'),
    pnlFeeForbidden: z.literal(true),
    rankingForbidden: z.literal(true),
    killUnfollowReal: z.literal(true),
  }),
  feeSharePublished: z.boolean(),
  leaderShareBps: z.string().nullable(),
  jurisdictionPublished: z.boolean(),
  blockers: z.array(z.object({ code: blockerCode })),
  autoMirrorPlace: z.object({
    published: z.boolean(),
    socket: z.string(),
  }),
  /** The owner's minimum investment per follow in the quote asset; null when unpublished (every follow refuses). */
  minInvestment: z.string().nullable(),
});

export const copyListMyFollowsAnswer = z.array(copyFollowAnswer);

export function wireEnum<T extends string>(values: readonly [T, ...T[]]) {
  return z.enum(values as [T, ...T[]]);
}

export const COPY_RELATIONSHIP_STATES = ['ACTIVE', 'PAUSED', 'STOPPING', 'CLOSE_ONLY', 'DETACHED'] as const;

export const relationshipState = wireEnum(COPY_RELATIONSHIP_STATES);

export function controlOutput<T extends string>(disposition: readonly [T, ...T[]]) {
  return z.object({
    followId: z.string(),
    relationshipState,
    disposition: wireEnum(disposition),
    newIntentFenced: z.boolean(),
    flattenInvented: z.literal(false),
    sessionKeyRevoked: z.boolean(),
  });
}

export const COPY_CONTROL_DISPOSITIONS = ['PAUSE_NEW', 'STOP_NEW', 'STOP_CLOSE_ONLY', 'DETACH_KEEP', 'RESUME'] as const;

export const COPY_PAUSE_DISPOSITIONS = ['PAUSE_NEW'] as const satisfies readonly (typeof COPY_CONTROL_DISPOSITIONS)[number][];

export const copyPauseOutput = controlOutput(COPY_PAUSE_DISPOSITIONS);

export const COPY_STOP_DISPOSITIONS = [
  'STOP_NEW',
  'STOP_CLOSE_ONLY',
] as const satisfies readonly (typeof COPY_CONTROL_DISPOSITIONS)[number][];

export const copyStopOutput = controlOutput(COPY_STOP_DISPOSITIONS);

export const COPY_DETACH_DISPOSITIONS = ['DETACH_KEEP'] as const satisfies readonly (typeof COPY_CONTROL_DISPOSITIONS)[number][];

export const copyDetachOutput = controlOutput(COPY_DETACH_DISPOSITIONS);

export const COPY_RESUME_DISPOSITIONS = ['RESUME'] as const satisfies readonly (typeof COPY_CONTROL_DISPOSITIONS)[number][];

export const copyResumeOutput = controlOutput(COPY_RESUME_DISPOSITIONS);

/**
 * A held figure (leader-listing.ts `Held`): the set form is tried first. Only it has a non-null value, so a figure
 * with no record (value null) never reads as set and falls to the second form.
 */
export const heldText = z.union([
  z.object({ value: z.string(), reason: z.null() }),
  z.object({ value: z.null(), reason: z.literal('no_published_record') }),
]);

export const leaderDirectoryRowAnswer = z.object({
  leaderRef: z.string(),
  displayName: z.string(),
  marketMode: z.enum(['spot', 'futures', 'bot', 'signal']),
  recordKind: z.enum(['verified_live', 'paper', 'backtest', 'imported', 'self_reported']),
  tenureStart: z.string().nullable(),
  assets: z.array(z.string()).readonly(),
  strategyVersion: z.string().nullable(),
  publishedReturn: heldText,
  maximumDrawdown: heldText,
  windowStart: heldText,
  windowEnd: heldText,
  // The set form first, as in heldText: only it has a non-null value.
  netOfCosts: z.union([
    z.object({ value: z.boolean(), reason: z.null() }),
    z.object({ value: z.null(), reason: z.literal('no_published_record') }),
  ]),
  copiersCount: z.number(),
  capacity: z.union([
    z.object({ value: z.number(), reason: z.null() }),
    z.object({ value: z.null(), reason: z.literal('capacity_unpublished') }),
  ]),
  leaderShareBps: z.union([
    z.object({ value: z.string(), reason: z.null() }),
    z.object({ value: z.null(), reason: z.literal('leader_share_unpublished') }),
  ]),
});

export const copyListLeadersAnswer = z.object({
  leaders: z.array(leaderDirectoryRowAnswer).readonly(),
  nextCursor: z.string().nullable(),
});

export const copyLeaderProfileAnswer = z.object({
  leader: leaderDirectoryRowAnswer,
  status: z.enum(['listed', 'suspended', 'delisted', 'unknown']),
  definitionsVersion: z.string().nullable(),
  metrics: z
    .array(
      z.object({
        key: z.enum(['publishedReturn', 'maximumDrawdown', 'winRate', 'sharpeRatio']),
        value: z.string().nullable(),
        reason: z.enum(['no_published_record', 'definition_unpublished', 'not_held']).nullable(),
        definition: z.string().nullable(),
      }),
    )
    .readonly(),
});

export const copyFollowPositionsAnswer = z.object({
  positions: z.array(
    z.object({
      orderId: z.string(),
      market: z.string(),
      side: z.enum(['buy', 'sell']),
      qty: z.string(),
      filledQty: z.string(),
      price: z.string(),
      status: z.string(),
      placedAt: z.string(),
      venue: z
        .object({
          venueName: z.string(),
          test: z.boolean(),
          asOf: z.string(),
          placedBy: z.string(),
          fills: z
            .array(
              z.object({
                fillId: z.string(),
                amount: z.string(),
                price: z.string(),
                venueFee: z.string(),
                builderFee: z.string(),
                feeAsset: z.string(),
                filledAt: z.string(),
              }),
            )
            .readonly(),
        })
        .optional(),
    }),
  ),
});

export const copyCopiedPositionsAnswer = z.object({
  positions: z.array(
    z.object({
      positionId: z.string(),
      market: z.string(),
      bought: z.string(),
      open: z.string(),
      closing: z.string(),
      status: z.enum(['open', 'closed', 'buying', 'closing']),
      placedAt: z.string(),
      reportedBy: z.object({ venue: z.string(), test: z.boolean(), asOf: z.string() }).optional(),
    }),
  ),
  markets: z.array(
    z.object({
      market: z.string(),
      fills: z.number().nullable(),
      filled: z.string().nullable(),
      open: z.string(),
      averageEntry: z.string().nullable(),
      funding: z.null(),
    }),
  ),
});

export const COPY_FLATTEN_DISPOSITION = 'DETACH_FLATTEN' as const;

export const COPY_FLATTEN_WIRE_DISPOSITIONS = [COPY_FLATTEN_DISPOSITION] as const;

export const copyFlattenOutput = z.object({
  followId: z.string(),
  relationshipState: z.literal('DETACHED'),
  disposition: wireEnum(COPY_FLATTEN_WIRE_DISPOSITIONS),
  newIntentFenced: z.literal(true),
  flattenChosen: z.literal(true),
  flattenInvented: z.literal(false),
  sessionKeyRevoked: z.literal(true),
  orderIds: z.array(z.string()).readonly(),
});

export const midFeedSocket = z.literal('socket.otc-mid-feed');

/**
 * The desk's mid feed. The wired form is tried first: only it has `wiring`, so a plain status never reads as one, and a
 * wired status is never stripped of it. The two plain forms differ in their `published` literal.
 */
export const otcMidFeedAnswer = z.union([
  z.object({
    wiring: z.enum(['flag_off', 'flag_on_venue_unwired', 'flag_on_symbol_map_empty', 'live_observation']),
    published: z.boolean(),
    socket: midFeedSocket,
    residual: z.string().nullable(),
    bootMapAllowed: z.boolean(),
    liveObservationFeed: z.boolean(),
  }),
  z.object({
    published: z.literal(true),
    socket: midFeedSocket,
    residual: z.null(),
    bootMapAllowed: z.literal(false),
    liveObservationFeed: z.literal(true),
  }),
  z.object({
    published: z.literal(false),
    socket: midFeedSocket,
    residual: z.string(),
    bootMapAllowed: z.literal(true),
    liveObservationFeed: z.literal(false),
  }),
]);

export const otcDeskStatusAnswer = z.object({
  published: z.boolean(),
  statusLine: z.string(),
  residual: z.string().nullable(),
  assets: z.array(z.string()).readonly().nullable(),
  minTier: z.enum(['basic', 'full', 'institutional']).nullable(),
  makerRouting: z.object({ published: z.literal(false), socket: z.literal('socket.otc-maker-routing'), residual: z.string() }),
  midFeed: otcMidFeedAnswer,
  residuals: z.object({
    deskLaw: z.string().nullable(),
    assets: z.string().nullable(),
    minTier: z.string().nullable(),
    makerRouting: z.string(),
    midFeed: z.string().nullable(),
  }),
});

export const rfqQuoteAnswer = z.object({
  ...firmRfqFields,
  quotes: z.array(z.object({ ...otcQuoteFields, rank: z.number() })),
});

export const rfqBoardStatus = z.enum(['open', 'accepted', 'settled', 'expired']);

export const rfqBoardAnswer = z.object({
  groups: z
    .array(
      z.object({
        status: rfqBoardStatus,
        count: z.number(),
        requests: z
          .array(
            z.object({
              rfqId: z.string(),
              status: rfqBoardStatus,
              side: z.enum(['buy', 'sell']),
              baseAsset: z.string(),
              quoteAsset: z.string(),
              qty: z.string(),
              createdAt: z.string(),
              quotes: z
                .array(
                  z.object({
                    quoteId: z.string(),
                    makerId: z.string().nullable(),
                    rfqSeq: z.number(),
                    quotedPrice: z.string(),
                    userNotional: z.string(),
                    spreadBps: z.number(),
                    lifecycle: z.enum(['open', 'bound', 'expired', 'settled']),
                    test: z.boolean(),
                    rank: z.number(),
                    best: z.boolean(),
                    expiresAt: z.string(),
                  }),
                )
                .readonly(),
            }),
          )
          .readonly(),
      }),
    )
    .readonly(),
  more: z.boolean(),
});

export const signalWebhooksAnswer = z.array(z.object(signalWebhookFields));

export const optionsPolicyAnswer = z.object({
  socket: z.literal('socket.options-settlement-asset-law'),
  settlementLawUnsetCode: z.literal('trade.options_settlement_law_unset'),
  fixingUnconfiguredCode: z.literal('trade.options_fixing_unconfigured'),
  termsIncompleteCode: z.literal('trade.options_terms_incomplete'),
  settlementAssetLawStamped: z.boolean(),
  settlementFixingConfigured: z.boolean(),
  statusLine: z.string(),
  /** Typed as its one sentence (OPTIONS_SETTLEMENT_RESIDUAL); a string here checks no more than that. */
  residual: z.string(),
  blockers: z.tuple([z.literal('settlement_asset_law'), z.literal('settlement_fixing'), z.literal('european_terms')]).readonly(),
  allowed: z.object({
    nonOptionsListing: z.literal(true),
    optionsListing: z.boolean(),
    optionsOrders: z.boolean(),
    paperOptionsOrders: z.literal(true),
    liveOptionsOrders: z.literal(false),
  }),
  europeanOnly: z.literal(true),
  fullCollateralV1: z.literal(true),
  inventsLiveSet: z.literal(false),
  inventsSettlementAsset: z.literal(false),
  inventsIvSurface: z.literal(false),
  ordersStillRefuseUntilEngine: z.literal(false),
  liveOrdersStillRefuse: z.literal(true),
  paperEngine: z.literal(true),
});
