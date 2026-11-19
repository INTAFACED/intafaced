/**
 * The Copy and Bots rooms' replies (svc-trade `copy.*`, `algo.*`, `bots.grid.*`, `signals.webhooks.*`; svc-market
 * `signals.*`; svc-quant `studio.list`), as the customer app reads them. Only fields the screen shows are kept, and no
 * service sentence is ever kept (`residual` and `statusLine` are deliberately left out). Browser-safe: zod only.
 */
import { z } from 'zod';
import { signedAmountSchema, unsignedAmountSchema } from './wire-amount.js';

export const copyDeskSchema = z.object({
  feeSharePublished: z.boolean(),
  jurisdictionPublished: z.boolean(),
  leaderShareBps: z.string().nullable(),
  autoMirrorPlace: z.object({ published: z.boolean() }).optional(),
  /** The owner's minimum investment per follow; null when unpublished (every follow refuses). */
  minInvestment: z.string().nullable().optional(),
});

export const copyAckSchema = z.object({
  followId: z.string(),
  relationshipState: z.string(),
  newIntentFenced: z.boolean(),
  disposition: z.string(),
});

/** A chart alert webhook (svc-trade `signals.webhooks.*`): one venue market and account. `token` is in the create reply only, once. */
export const signalWebhookSchema = z.object({
  webhookId: z.string(),
  symbol: z.string(),
  venueOwner: z.string(),
  path: z.string(),
  tokenPrefix: z.string(),
  state: z.enum(['active', 'paused', 'ended']),
  createdAt: z.string(),
  token: z.string().nullable().optional(),
});

/** A published signal (svc-market `signals.*`, J-copy-bots-otc-22): free or a monthly fee, never a profit share. */
export const providerSignalSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  assetId: z.string(),
  recommendedAmount: unsignedAmountSchema.nullable(),
  feeModel: z.enum(['free', 'monthly']),
  price: unsignedAmountSchema.nullable(),
  periodSeconds: z.number().int().nullable(),
  /** A monthly fee signal's Market listing, where a buyer pays one period. Null on a free signal. */
  listingId: z.string().nullable(),
  state: z.enum(['pending', 'published', 'archived']),
  createdAt: z.string(),
  archivedAt: z.string().nullable(),
});

/** The provider's one vetting against the platform's criteria, and what it saw. */
export const signalVettingSchema = z.object({
  minTier: z.string(),
  minFills: z.number().int(),
  tierSeen: z.string(),
  fillsSeen: z.number().int(),
  firstFillAt: z.string().nullable(),
  passedAt: z.string(),
});

export const signalCriteriaSchema = z.object({ set: z.boolean(), minTier: z.string().nullable(), minFills: z.number().int().nullable() });
export const signalPublishSchema = z.object({ signal: providerSignalSchema, vetting: signalVettingSchema, replayed: z.boolean() });
export const mySignalsSchema = z.object({ signals: z.array(providerSignalSchema), vetting: signalVettingSchema.nullable() });
export const signalEarningsSchema = z.object({
  from: z.string(),
  to: z.string(),
  settlement: z.literal('at_sale'),
  assets: z.array(
    z.object({
      assetId: z.string(),
      gross: unsignedAmountSchema,
      commission: unsignedAmountSchema,
      net: unsignedAmountSchema,
      sales: z.number().int(),
    }),
  ),
  profitShare: z.null(),
});

/** The scopes the platform has paused now (svc-trade `copy.platformPauses`, CB-ops-03). */
export const platformPausesSchema = z.object({
  leads: z.array(z.string()),
  botTypes: z.array(z.string()),
  symbols: z.array(z.string()),
});

export const algoPolicySchema = z.object({
  capability: z.object({ createEnabled: z.boolean(), jobsEnabled: z.boolean() }),
  immatureKinds: z.array(z.string()),
});

/** One of the person's bots, as the service lists it (newest first). The list is the service's, so it is the same in every browser. */
export const botListRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  market: z.string(),
  side: z.enum(['buy', 'sell']),
  totalQty: unsignedAmountSchema,
  filledQty: unsignedAmountSchema,
  status: z.enum(['active', 'paused', 'cancelled', 'completed', 'halted']),
  created: z.string(),
});

export const botListSchema = z.object({ rows: z.array(botListRowSchema), nextCursor: z.string().nullable() });

export const studioStrategySchema = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string(),
  cash: unsignedAmountSchema,
  risk: z.object({ maxDrawdown: unsignedAmountSchema, maxNotional: unsignedAmountSchema, kill: unsignedAmountSchema }),
  environment: z.string(),
  claimLabel: z.string(),
  live: z.boolean(),
  simulated: z.boolean(),
});

const held = <T extends z.ZodTypeAny>(value: T) => z.object({ value: value.nullable(), reason: z.string().nullable() });
export const LEADER_MODES = ['spot', 'futures', 'bot', 'signal'] as const;

/** One listed leader, as the operator published it. No user id is ever in it. */
export const leaderRowSchema = z.object({
  leaderRef: z.string(),
  displayName: z.string(),
  marketMode: z.enum(LEADER_MODES),
  recordKind: z.string(),
  tenureStart: z.string().nullable(),
  assets: z.array(z.string()),
  publishedReturn: held(signedAmountSchema),
  maximumDrawdown: held(signedAmountSchema),
  copiersCount: z.number(),
  capacity: held(z.number()),
  leaderShareBps: held(z.string()),
});

export const leaderPageSchema = z.object({ leaders: z.array(leaderRowSchema), nextCursor: z.string().nullable() });

export const leaderProfileSchema = z.object({
  leader: leaderRowSchema,
  status: z.string(),
  definitionsVersion: z.string().nullable(),
  metrics: z.array(
    z.object({
      key: z.enum(['publishedReturn', 'maximumDrawdown', 'winRate', 'sharpeRatio']),
      value: z.string().nullable(),
      reason: z.string().nullable(),
      definition: z.string().nullable(),
    }),
  ),
});

export const leaderTradeSchema = z.object({
  tradeId: z.string(),
  symbol: z.string(),
  state: z.enum(['open', 'closed']),
  openedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  entryPrice: unsignedAmountSchema.nullable(),
  qty: unsignedAmountSchema,
  margin: unsignedAmountSchema.nullable(),
  takeProfit: unsignedAmountSchema.nullable(),
  stopLoss: unsignedAmountSchema.nullable(),
  closePrice: unsignedAmountSchema.nullable(),
  closedQty: unsignedAmountSchema,
  roiPercent: signedAmountSchema.nullable(),
});

export const leaderTradesSchema = z.object({ trades: z.array(leaderTradeSchema), nextCursor: z.string().nullable() });

/** One order the copy placed for this person, read from their own order book. */
export const copyPositionSchema = z.object({
  orderId: z.string(),
  market: z.string(),
  side: z.enum(['buy', 'sell']),
  qty: unsignedAmountSchema,
  filledQty: unsignedAmountSchema,
  price: unsignedAmountSchema,
  status: z.string(),
  placedAt: z.string(),
  /** On a follow that copies on the venue: who placed it, and its fills with their fees, as the venue reports them. */
  venue: z
    .object({
      venueName: z.string(),
      test: z.boolean(),
      asOf: z.string(),
      placedBy: z.string(),
      fills: z.array(
        z.object({
          fillId: z.string(),
          amount: unsignedAmountSchema,
          price: unsignedAmountSchema,
          venueFee: unsignedAmountSchema,
          builderFee: unsignedAmountSchema,
          feeAsset: z.string(),
          filledAt: z.string(),
        }),
      ),
    })
    .optional(),
});

/** A spot grid bot as the service reports it (trade.bots.grid). Every amount is the service's decimal string. */
export const gridBotSchema = z.object({
  botId: z.string(),
  clientRequestId: z.string(),
  symbol: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  lowerPrice: unsignedAmountSchema,
  upperPrice: unsignedAmountSchema,
  gridCount: z.number(),
  investment: unsignedAmountSchema,
  reinitCount: z.number(),
  status: z.enum(['initializing', 'running', 'paused_range', 'initialization_failed', 'stopped']),
  statusReason: z.string().nullable(),
  reserve: z.object({ key: z.string(), asset: z.string(), amount: unsignedAmountSchema, releasedAt: z.string().nullable() }).nullable(),
  levels: z.array(
    z.object({
      index: z.number(),
      price: unsignedAmountSchema,
      qty: unsignedAmountSchema,
      hold: unsignedAmountSchema,
      openOrder: z.object({ side: z.enum(['buy', 'sell']), orderId: z.string(), clientOrderId: z.string() }).nullable(),
    }),
  ),
  orders: z.array(
    z.object({
      clientOrderId: z.string(),
      orderId: z.string(),
      levelIndex: z.number(),
      side: z.enum(['buy', 'sell']),
      cycle: z.number(),
      price: unsignedAmountSchema,
      qty: unsignedAmountSchema,
      holdAmount: unsignedAmountSchema,
      status: z.enum(['open', 'filled', 'partial', 'cancelled']),
      pairProfit: signedAmountSchema.nullable(),
    }),
  ),
  gridProfit: signedAmountSchema,
  closedPairs: z.number(),
  withdrawableProfit: unsignedAmountSchema,
  gridApr: z.discriminatedUnion('state', [
    z.object({ state: z.literal('under_a_day'), percent: z.null() }),
    z.object({ state: z.literal('set'), percent: signedAmountSchema }),
  ]),
  createdAt: z.string(),
});

/** A grid profit withdrawal receipt: the stored withdrawal row (trade.bots.grid.withdrawProfit, CB-bots-05). */
export const gridWithdrawalSchema = z.object({
  withdrawalId: z.string(),
  botId: z.string(),
  asset: z.string(),
  amount: unsignedAmountSchema,
  profitBefore: unsignedAmountSchema,
  profitAfter: unsignedAmountSchema,
  reserveBefore: unsignedAmountSchema,
  reserveAfter: unsignedAmountSchema,
  dailyCap: unsignedAmountSchema,
  capUsed: unsignedAmountSchema,
  capRemaining: unsignedAmountSchema,
  stepUpEventId: z.string(),
  appliedAt: z.string(),
});

/** A quote top-up as it was applied (trade.bots.grid.topUp, CB-bots-04). */
export const gridTopUpSchema = z.object({
  topUpId: z.string(),
  botId: z.string(),
  asset: z.string(),
  amount: unsignedAmountSchema,
  investmentBefore: unsignedAmountSchema,
  investmentAfter: unsignedAmountSchema,
  freeBefore: unsignedAmountSchema,
  appliedAt: z.string(),
  bot: gridBotSchema,
});

export const gridSetupSchema = z.object({
  countRange: z.object({ min: z.number(), max: z.number() }).nullable(),
  boundsMaxDistanceBps: z.number().nullable(),
});

export const gridPresetsSchema = z.object({ source: z.null(), presets: z.array(z.never()) });

/** One copied buy and what of it is still open (CB-copy-09/10). Amounts are in the market's base asset. */
export const copiedPositionSchema = z.object({
  positionId: z.string(),
  market: z.string(),
  bought: unsignedAmountSchema,
  open: unsignedAmountSchema,
  closing: unsignedAmountSchema,
  status: z.enum(['buying', 'open', 'closing', 'closed']),
  placedAt: z.string(),
  /** On a follow that copies on the venue: every figure is the venue's own, read at `asOf`. */
  reportedBy: z.object({ venue: z.string(), test: z.boolean(), asOf: z.string() }).optional(),
});

/** One market's copied position by average entry (J-copy-bots-otc-06 #2). A spot position has no funding: null. */
export const copiedMarketSchema = z.object({
  market: z.string(),
  fills: z.number().int().nullable(),
  filled: unsignedAmountSchema.nullable(),
  open: unsignedAmountSchema,
  averageEntry: unsignedAmountSchema.nullable(),
  funding: unsignedAmountSchema.nullable(),
});

/** A lead's own earnings: fee-share rows only, and the profit-share sentence (J-copy-bots-otc-06 #3). */
export const leadEarningsSchema = z.object({
  profitShare: z.string(),
  leaderShareBps: z.string().nullable(),
  totals: z.array(z.object({ assetId: z.string(), amount: unsignedAmountSchema })),
  items: z.array(
    z.object({
      fillId: z.string(),
      followId: z.string(),
      assetId: z.string(),
      feeOnFill: unsignedAmountSchema,
      appliedShareBps: z.number().int(),
      amount: unsignedAmountSchema,
      at: z.string(),
    }),
  ),
});

/** A lead's level: null while the owner's thresholds are blank; the maximum ratio is never set (J-copy-bots-otc-06 #5). */
export const leadLevelSchema = z.object({
  leaderRef: z.string().nullable(),
  listingState: z.string().nullable(),
  level: z.string().nullable(),
  levelReason: z.string(),
  maxRatio: z.string().nullable(),
});

/** The caller's lead account once approved (CB-copy-18): null until then. */
export const myLeadSchema = z
  .object({
    leaderRef: z.string(),
    applicationId: z.string(),
    displayName: z.string(),
    state: z.string(),
    instruments: z.array(z.string()),
  })
  .nullable();

/** The new-trader missions (CB-copy-12): each with what counts, as the service read it. */
export const leadMissionsSchema = z.object({
  missions: z.array(z.object({ id: z.enum(['apply', 'fund', 'listed']), done: z.boolean(), detail: z.string() })),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

export const leadTradeSchema = z.object({
  orderId: z.string(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  price: unsignedAmountSchema.nullable(),
  amount: unsignedAmountSchema,
  filled: unsignedAmountSchema,
  status: z.string(),
  at: z.string(),
});

/** The lead's own lead trades (CB-copy-15): the counts are the service's, never the page's rows. */
export const leadTradesSchema = z.object({
  ongoing: z.array(leadTradeSchema),
  history: z.array(leadTradeSchema),
  counts: z.object({ ongoing: z.number().int().nonnegative(), history: z.number().int().nonnegative() }),
});

/** One copier of the lead: the follow's short id, its state and start. No follower's name, balance or profit. */
export const leadCopiersSchema = z.array(
  z.object({ followRef: z.string(), status: z.enum(['Active', 'Paused', 'Stopping', 'Close only', 'Stopped']), since: z.string() }),
);

export const copyClosePositionSchema = z.object({
  positionId: z.string(),
  orderId: z.string(),
  qty: unsignedAmountSchema,
  duplicate: z.boolean(),
});

/** A leader fill this follow did not copy (CB-copy-11). The reason is an id; the screen says it in words. */
export const copySkipSchema = z.object({ leaderFillId: z.string(), reason: z.string(), at: z.string() });

/** copy.followPositions: the orders the copy placed for this person. */
export const followPositionsSchema = z.object({ positions: z.array(copyPositionSchema) });

/** copy.copiedPositions: the copied buys and each market's position by average entry. */
export const copiedPositionsSchema = z.object({ positions: z.array(copiedPositionSchema), markets: z.array(copiedMarketSchema) });

/** copy.skipLog: the leader fills this follow did not copy. */
export const copySkipLogSchema = z.object({ items: z.array(copySkipSchema) });

/** bots.grid.topUpFree: the quote asset free to top a grid bot up with. */
export const gridTopUpFreeSchema = z.object({ asset: z.string(), free: unsignedAmountSchema });

/** studio.list (svc-quant): the person's strategies. */
export const studioListSchema = z.object({ strategies: z.array(studioStrategySchema) });

/**
 * copy.checkVenueFollow (svc-trade copy-service.ts): a venue follow checked with nothing written, or the follow its key made.
 * The follow's own schema is the caller's, passed in.
 */
export const venueFollowCheckSchemaOf = <F extends z.ZodTypeAny>(follow: F) =>
  z.union([
    z.object({ followId: z.string(), follow }),
    z.object({ followId: z.string(), follow: z.null(), quoteAsset: z.string(), maxAggregateExposure: unsignedAmountSchema }),
  ]);
