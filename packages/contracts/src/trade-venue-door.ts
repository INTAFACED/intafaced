/**
 * svc-trade's user-venue door (`/api/v1/venue/*`) as the customer app reads it: the customer's own account on a
 * user-signed venue (B1). Browser-safe (zod only). The venue is the record of balances, locks, fills, positions and
 * withdrawals: every figure here is the venue's, with the venue's as-of time, and every amount is an exact decimal
 * string. A figure the venue does not publish is `known: false`. These follow `services/svc-trade/src/venue/user-venue-rest.ts`
 * and `packages/venue-contracts/src/user-venue.ts` field for field.
 */
import { z } from 'zod';
import { unsignedAmountSchema as decimalSchema, signedAmountSchema as signedDecimalSchema } from './wire-amount.js';

export const isoTime = z.string().datetime({ offset: true });
export const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** A figure the venue may not publish. */
export const maybeKnown = <T extends z.ZodTypeAny>(value: T) =>
  z.union([z.object({ known: z.literal(true), value }), z.object({ known: z.literal(false) })]);
export type MaybeKnown<T> = { known: true; value: T } | { known: false };

export const asOf = <T extends z.ZodTypeAny>(value: T) => z.object({ venueId: z.string(), value, asOf: isoTime });
export type AsOf<T> = { venueId: string; value: T; asOf: string };

export const refusalSchema = z.object({ venueId: z.string(), code: z.string(), detail: z.string() });
export type VenueRefusal = z.infer<typeof refusalSchema>;

/** `/venue/status`: `{ enabled: false }` when the door is off; else whether the venue answers, and who it is. */
export const venueStatusSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), available: z.literal(false), refusal: z.object({ code: z.string(), detail: z.string() }) }),
  z.object({
    enabled: z.literal(true),
    available: z.literal(true),
    venue: z.object({ id: z.string(), displayName: z.string(), proofLevel: z.enum(['simulator', 'partner-sandbox', 'live']) }),
    test: z.boolean(),
    label: z.literal('TEST').optional(),
    chainId: z.number().int().positive().nullable(),
    /** Where the person's own wallet sends a token to fund the venue account (B2); null or absent when the venue names none. */
    deposit: z
      .object({
        chainId: z.number().int().positive(),
        token: address,
        tokenDecimals: z.number().int().min(0).max(18),
        address,
        asset: z.string().min(1),
      })
      .nullable()
      .optional(),
    builder: z.object({ address, feeBps: decimalSchema }).nullable(),
    // J-derivatives-30 #1: our builder address alone, published even while the fee is blank (null: blank too).
    builderAddress: address.nullable().optional(),
    // J-derivatives-03 #9: the most orders the venue takes in one signed action; above 1, a reverse is signed once.
    ordersPerAction: z.number().int().positive().optional(),
    // J-cex-spot-05: whether the venue lowers an order in place, and how many it cancels in one signed action (0: one each).
    amendsInPlace: z.boolean().optional(),
    cancelsPerAction: z.number().int().min(0).optional(),
    // J-cex-spot-07: the venue's own scheduled cancel with the owner's published timeouts (null: blank); null where the
    // venue offers none.
    scheduledCancel: z
      .object({ minLeadMs: z.number().int().min(0), timeoutsSec: z.array(z.number().int().positive()).nullable() })
      .nullable()
      .optional(),
    // J-derivatives-28: true when more than one venue is configured; the ticket then routes over them.
    routes: z.boolean().optional(),
    // Every configured venue with its health and the position modes it offers (J-derivatives-28, J-derivatives-05 #1 #3).
    // Absent from an older door: the primary venue alone.
    venues: z
      .array(
        z.object({
          venueId: z.string().nullable(),
          displayName: z.string().nullable(),
          test: z.boolean(),
          health: z.object({ state: z.string() }).passthrough(),
          positionModes: z.array(z.enum(['one_way', 'hedge'])).optional(),
        }),
      )
      .optional(),
  }),
]);
export type VenueStatus = z.infer<typeof venueStatusSchema>;
export type VenueUp = Extract<VenueStatus, { available: true }>;

export const timeInForce = z.enum(['GTC', 'IOC', 'ALO']);
export const marginMode = z.enum(['cross', 'isolated']);
export type VenueTimeInForce = z.infer<typeof timeInForce>;
export type VenueMarginMode = z.infer<typeof marginMode>;

export const venueMarketSchema = z.object({
  symbol: z.string(),
  kind: z.enum(['spot', 'perpetual']),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  orderTypes: z.array(z.string()),
  timeInForce: z.array(timeInForce),
  marginModes: z.array(marginMode),
  maxLeverageBps: z.number().int().positive().nullable(),
  tickSize: decimalSchema,
  lotSize: decimalSchema,
  // The venue's published smallest order value (quote), price band (bps around the middle of its book) and open-order
  // cap per account, each null where the venue publishes none (J-cex-spot-04). Absent from an older door: not published.
  minOrderNotional: decimalSchema.nullable().optional(),
  priceBandBps: decimalSchema.nullable().optional(),
  maxOpenOrders: z.number().int().positive().nullable().optional(),
  // The venue's largest order, null where it reports none.
  maxOrderQty: decimalSchema.nullable().optional(),
  maxOrderNotional: decimalSchema.nullable().optional(),
  makerFeeBps: maybeKnown(signedDecimalSchema),
  takerFeeBps: maybeKnown(signedDecimalSchema),
  // The venue's own published words for the market, each "not published" where the venue gives none (J-derivatives-21).
  listedBy: maybeKnown(z.object({ kind: z.enum(['venue', 'hip3', 'ostium']), name: z.string() })),
  oracleRule: maybeKnown(z.string()),
  markRule: maybeKnown(z.string()),
  tradingHours: maybeKnown(z.string()),
  feed: maybeKnown(z.object({ state: z.enum(['live', 'stale']), lastOracleUpdateAt: isoTime, staleRule: maybeKnown(z.string()) })),
  // A stock perpetual's home market and the venue's off-hours mode, each in the venue's words (J-derivatives-27).
  session: maybeKnown(
    z.object({
      state: z.enum(['open', 'off_hours']),
      homeMarket: z.string(),
      offHoursMode: maybeKnown(z.string()),
      offHoursBand: maybeKnown(z.string()),
      offHoursMaxLeverageBps: z.number().int().positive().nullable(),
      reopensAt: isoTime.nullable(),
      offHoursRule: maybeKnown(z.string()),
    }),
  ),
  // The margin account a market's deployer keeps for it, apart from the main account, and its open interest with the
  // deployer's cap (J-derivatives-27 #7 #8). Absent from an older door: read as not published.
  marginAccount: maybeKnown(z.object({ name: z.string(), collateralAsset: z.string(), marginMode })).optional(),
  openInterest: maybeKnown(z.object({ size: decimalSchema, capSize: decimalSchema.nullable() })).optional(),
  // The latest deployer's halt or split that settled the market's positions, as the venue reports it (J-derivatives-27 #9 #10).
  lastEvent: maybeKnown(
    z.object({
      kind: z.enum(['deployer_halt', 'split']),
      eventAt: isoTime,
      settlementPrice: decimalSchema,
      reopenedAt: isoTime.nullable(),
      splitRatio: z.string().nullable(),
    }),
  ).optional(),
  // The contract strip's figures, each the venue's own or "not published" (J-derivatives-01 #4).
  contractSize: maybeKnown(decimalSchema),
  mark: maybeKnown(decimalSchema),
  funding: maybeKnown(
    z.object({
      rate: signedDecimalSchema,
      intervalSeconds: z.number().int().positive(),
      nextFundingAt: isoTime,
      // What the venue built the rate from, as it publishes them (J-derivatives-08 #1); absent from an older door: not published.
      inputs: maybeKnown(
        z.object({
          premium: signedDecimalSchema,
          interestRate: signedDecimalSchema,
          rateCap: decimalSchema,
          markPrice: decimalSchema,
          indexPrice: decimalSchema,
          rule: maybeKnown(z.string()),
        }),
      ).optional(),
    }),
  ),
  // The prices the venue judges its trigger orders on, and its published index (J-derivatives-03). Absent: none.
  triggerSources: z.array(z.enum(['mark', 'last'])).optional(),
  index: maybeKnown(decimalSchema).optional(),
  // The venue's own self-trade rule (J-cex-spot-03 #8); absent from an older door: read as not published.
  selfTrade: maybeKnown(z.enum(['cancel_resting', 'cancel_new', 'cancel_both'])).optional(),
  // The venue's published margin tiers, and what it takes as margin with each haircut (J-derivatives-02 #2 #3). Absent
  // from an older door: read as not published.
  marginTiers: maybeKnown(
    z.array(z.object({ fromNotional: decimalSchema, maxLeverageBps: z.number().int().positive(), maintenanceRate: decimalSchema })),
  ).optional(),
  collateral: maybeKnown(z.array(z.object({ asset: z.string(), haircut: maybeKnown(decimalSchema) }))).optional(),
  // The venue's own trading state for the market, null where it reports none, and our listing's routing beside it
  // (J-charts-desk-15 #6: the chart refuses order entry naming either). Absent from an older door: not reported.
  status: z.enum(['trading', 'halted', 'cancel_only', 'delisted']).nullable().optional(),
  listing: z.object({ routing: z.enum(['show', 'close_only', 'stop']), delisted: z.boolean().optional() }).optional(),
});
export type VenueMarket = z.infer<typeof venueMarketSchema>;
/** One of the venue's published margin tiers (J-derivatives-02 #2). */
export type VenueMarginTier = Extract<NonNullable<VenueMarket['marginTiers']>, { known: true }>['value'][number];
/** One asset the venue takes as margin, with its haircut (J-derivatives-02 #3). */
export type VenueCollateral = Extract<NonNullable<VenueMarket['collateral']>, { known: true }>['value'][number];
export type VenueSelfTradeMode = 'cancel_resting' | 'cancel_new' | 'cancel_both';
/** A perpetual's funding as the venue publishes it (J-derivatives-01 #4). */
export type VenueFunding = Extract<VenueMarket['funding'], { known: true }>['value'];
/** A deployer's halt or a split that settled a market's positions, as the venue reports it (J-derivatives-27 #9 #10). */
export type VenueMarketEvent = Extract<NonNullable<VenueMarket['lastEvent']>, { known: true }>['value'];
/** One owner's balance in a market deployer's own margin account, as the venue reports it (J-derivatives-27 #7). */
export const venueMarketMarginSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  collateralAsset: z.string(),
  marginMode,
  free: decimalSchema,
  locked: decimalSchema,
  total: decimalSchema,
});
export type VenueMarketMargin = z.infer<typeof venueMarketMarginSchema>;
/** The venue's scheduled cancel on one account (J-cex-spot-07): its time, or null, and its last firing. */
export const venueScheduledCancelSchema = z.object({
  cancelsAt: isoTime.nullable(),
  lastFired: z.object({ firedAt: isoTime, canceled: z.number().int().min(0) }).nullable(),
});
export type VenueScheduledCancel = z.infer<typeof venueScheduledCancelSchema>;

/** One statement job on the venue's own records (J-cex-spot-07 #5; svc-trade venue-statements.ts). */
export const venueStatementJobSchema = z.object({
  id: z.string(),
  requestKey: z.string(),
  venueId: z.string(),
  owner: z.string(),
  from: isoTime,
  to: isoTime,
  status: z.enum(['pending', 'finished', 'failed']),
  rows: z.object({ orders: z.number().int(), trades: z.number().int(), movements: z.number().int() }).nullable(),
  sha256: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: isoTime,
  finishedAt: isoTime.nullable(),
});
export type VenueStatementJob = z.infer<typeof venueStatementJobSchema>;

/**
 * One funding payment on one of the owner's positions, as the venue booked it when it closed a period (J-derivatives-08
 * #3 #4 #5): positive `amount` received, negative paid, in `asset`.
 */
export const venueFundingPaymentSchema = z.object({
  paymentId: z.string(),
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: decimalSchema,
  markPrice: decimalSchema,
  rate: signedDecimalSchema,
  amount: signedDecimalSchema,
  asset: z.string(),
  periodAt: isoTime,
});
export type VenueFundingPayment = z.infer<typeof venueFundingPaymentSchema>;

/** One of the owner's settlements in a deployer's halt or a split, as the venue records it (J-derivatives-27 #9 #10). */
export const venueSettlementSchema = z.object({
  symbol: z.string(),
  kind: z.enum(['deployer_halt', 'split']),
  side: z.enum(['long', 'short']).nullable(),
  size: decimalSchema,
  price: decimalSchema,
  realisedPnl: signedDecimalSchema,
  cancelledOrders: z.array(z.string().nullable()),
  settledAt: isoTime,
});
export type VenueSettlement = z.infer<typeof venueSettlementSchema>;
/** A stock perpetual's home-market session as the venue publishes it (J-derivatives-27). */
export type VenueSession = Extract<VenueMarket['session'], { known: true }>['value'];

export const venueBestPricesSchema = z.object({ symbol: z.string(), bid: decimalSchema.nullable(), ask: decimalSchema.nullable() });
export type VenueBestPrices = z.infer<typeof venueBestPricesSchema>;
/** The venue's best prices with the owner's market price protection (TRADE_MARKET_SLIPPAGE_CAP_BPS) svc-trade adds: blank is not known. */
export const venueBestPricesReadSchema = asOf(venueBestPricesSchema).extend({
  slippageCapBps: maybeKnown(decimalSchema),
  // The owner's spread limit for a spot market order (J-cex-spot-03 #2); absent from an older door: read as not set.
  spreadLimitBps: maybeKnown(decimalSchema).optional(),
});

// ── The venue's own market data on a market we list (J-cex-spot-01 #5: the spot desk's ticker, book, chart and tape) ──
export const venueLevelSchema = z.object({ price: decimalSchema, amount: decimalSchema });
export const venueBookReadSchema = asOf(
  z.object({ symbol: z.string(), bids: z.array(venueLevelSchema), asks: z.array(venueLevelSchema) }),
).extend({
  test: z.boolean(),
});
export type VenueBookRead = z.infer<typeof venueBookReadSchema>;
export const venuePrintSchema = z.object({
  tradeId: z.string(),
  symbol: z.string(),
  price: decimalSchema,
  amount: decimalSchema,
  takerSide: z.enum(['buy', 'sell']).nullable(),
  tradedAt: isoTime,
});
export type VenuePrint = z.infer<typeof venuePrintSchema>;
export const venueTradesReadSchema = asOf(z.array(venuePrintSchema)).extend({ test: z.boolean() });
export const venueCandleSchema = z.object({
  openAt: isoTime,
  openPrice: decimalSchema,
  highPrice: decimalSchema,
  lowPrice: decimalSchema,
  closePrice: decimalSchema,
  baseVolume: decimalSchema,
});
export type VenueCandle = z.infer<typeof venueCandleSchema>;
export const venueCandlesReadSchema = asOf(z.array(venueCandleSchema)).extend({ test: z.boolean() });

export const venueBalanceSchema = z.object({
  asset: z.string(),
  free: decimalSchema,
  locked: decimalSchema,
  total: decimalSchema,
  /** What holds `locked`, as the venue splits it (J-portfolio-01 #4); absent when the venue reports no split. */
  lockedBy: z.object({ inOrders: decimalSchema, margin: decimalSchema, staked: decimalSchema }).optional(),
});
export type VenueBalance = z.infer<typeof venueBalanceSchema>;

export const venueOrderSchema = z.object({
  venueOrderId: z.string().nullable(),
  venueClientOrderId: z.string().nullable(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  type: z.string(),
  timeInForce,
  price: decimalSchema,
  amount: decimalSchema,
  filled: decimalSchema,
  remaining: decimalSchema,
  averagePrice: decimalSchema.nullable(),
  status: z.string(),
  locked: decimalSchema,
  lockedAsset: z.string(),
  reduceOnly: z.boolean(),
  /** A trigger order's trigger, as the venue reports it (J-cex-spot-06 #6); absent on an ordinary order. */
  trigger: z
    .object({
      price: decimalSchema,
      source: z.string(),
      role: z.string(),
      state: z.enum(['waiting', 'triggered', 'failed']),
      triggeredAt: isoTime.nullable(),
      failure: z.string().nullable(),
    })
    .nullable()
    .optional(),
  /** Why the venue cancelled it, where it says (`position_closed`, `linked`). */
  cancelReason: z.string().nullable().optional(),
});
export type VenueOrder = z.infer<typeof venueOrderSchema>;

/** One page of the venue's own order history (`GET /venue/orders/history`, J-cex-spot-06 #1), newest placed first. */
export const venueHistoryPageSchema = z.object({
  orders: z.array(z.object({ order: venueOrderSchema, placedAt: isoTime })),
  next: z.string().nullable(),
  asOf: isoTime,
});
export type VenueHistoryPage = z.infer<typeof venueHistoryPageSchema>;
export type VenueHistoryQuery = { side?: string; status?: string; from?: string; to?: string; limit?: string; before?: string };

/** Our own record of one venue order (`GET /venue/orders/record`): the amendments the venue accepted and our builder fee. */
export const venueOrderRecordSchema = z.object({
  placedAt: isoTime.nullable(),
  amendments: z.array(z.object({ actionKey: z.string(), amount: decimalSchema, price: decimalSchema, recordedAt: isoTime })),
  builderFee: z
    .object({ chargedBps: decimalSchema, publishedBps: decimalSchema.nullable(), discountBps: z.number().int().nullable() })
    .nullable(),
});
export type VenueOrderRecord = z.infer<typeof venueOrderRecordSchema>;

/**
 * One order the person's door kept, read back from the venue (`GET /venue/orders`): `origin` is `agent:<keyId>` when their
 * own assistant placed it with its agent key (J-agents-21 #7), and `order` is the venue's record once it accepted it.
 */
export const venueKeptOrderSchema = z.object({
  actionKey: z.string(),
  venueClientOrderId: z.string().nullable(),
  origin: z.string().nullable(),
  state: z.enum(['accepted', 'unknown', 'refused', 'not_sent']),
  order: venueOrderSchema.nullable(),
  asOf: isoTime.nullable(),
});
export type VenueKeptOrder = z.infer<typeof venueKeptOrderSchema>;
export const venueOrderPageSchema = z.object({ orders: z.array(venueKeptOrderSchema), nextCursor: z.string().nullable() });

/** The person's agent accounts (J-agents-21): the wallet that owns each and its venue sub-account. */
export const agentAccountRowSchema = z.object({
  accountId: z.string(),
  status: z.string(),
  owner: z.string(),
  subAccount: z.string().nullable(),
});
export type AgentAccountRow = z.infer<typeof agentAccountRowSchema>;

export const venueFillSchema = z.object({
  fillId: z.string(),
  venueClientOrderId: z.string().nullable(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  price: decimalSchema,
  amount: decimalSchema,
  role: z.enum(['maker', 'taker']),
  venueFee: signedDecimalSchema,
  builderFee: decimalSchema,
  feeAsset: z.string(),
  realisedPnl: signedDecimalSchema.nullable(),
  filledAt: isoTime,
});
export type VenueFill = z.infer<typeof venueFillSchema>;

export const venuePositionSchema = z.object({
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: decimalSchema,
  entryPrice: decimalSchema,
  markPrice: decimalSchema,
  unrealisedPnl: signedDecimalSchema,
  marginMode,
  margin: decimalSchema,
  leverageBps: z.number().int().positive(),
  liquidationPrice: maybeKnown(decimalSchema),
  // The margin the venue requires to keep the position open (J-derivatives-05 #2); absent from an older door: not published.
  maintenanceMargin: maybeKnown(decimalSchema).optional(),
});
export type VenuePosition = z.infer<typeof venuePositionSchema>;

/** What a leverage change would do to the open position's margin, by the venue's own rule (J-derivatives-05 #4). */
export const venueLeverageChangeSchema = z.object({
  symbol: z.string(),
  leverageBps: z.number().int().positive(),
  marginMode,
  maxLeverageBps: z.number().int().positive().nullable(),
  positionSize: decimalSchema,
  marginNow: decimalSchema,
  marginAfter: decimalSchema,
  difference: signedDecimalSchema,
});
export type VenueLeverageChange = z.infer<typeof venueLeverageChangeSchema>;

/** An open isolated position's margin and the venue's own limit for removing it (J-derivatives-06 #2 #3). */
export const venueIsolatedMarginSchema = z.object({
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: decimalSchema,
  margin: decimalSchema,
  minimumMargin: decimalSchema,
  removable: decimalSchema,
  free: decimalSchema,
  asset: z.string(),
  liquidationPrice: maybeKnown(decimalSchema),
  rule: z.string(),
});
export type VenueIsolatedMargin = z.infer<typeof venueIsolatedMarginSchema>;

/** The account's margin as the venue reports it (J-derivatives-06 #1). */
export const venueAccountSummarySchema = z.object({
  asset: z.string(),
  equity: signedDecimalSchema,
  free: decimalSchema,
  usedMargin: decimalSchema,
  maintenanceMargin: decimalSchema,
  marginRatio: maybeKnown(decimalSchema),
  /** The account's cross margin as the venue judges it (J-derivatives-26): null with no cross position open. */
  cross: z
    .object({
      state: z.enum(['healthy', 'margin_call']),
      equity: signedDecimalSchema,
      maintenanceMargin: decimalSchema,
      marginRatio: maybeKnown(decimalSchema),
      liquidationEquity: decimalSchema,
      rule: z.string(),
    })
    .nullable()
    .optional(),
});
export type VenueAccountSummary = z.infer<typeof venueAccountSummarySchema>;

/**
 * The account's mode as the venue reports it (J-derivatives-29): `null` where it does not report it; in standard mode
 * its spot and perps balances apart; the day's action count against the mode's limit (`dailyLimit` null: none).
 */
export const venueAccountModeSchema = z.object({
  mode: z.enum(['standard', 'unified', 'portfolio_margin']).nullable(),
  spot: z.array(venueBalanceSchema).nullable(),
  perps: z.array(venueBalanceSchema).nullable(),
  actions: z.object({ usedToday: z.number().int().nonnegative(), dailyLimit: z.number().int().positive().nullable() }).nullable(),
});
export type VenueAccountModeRead = z.infer<typeof venueAccountModeSchema>;
export type VenueAccountMode = NonNullable<VenueAccountModeRead['mode']>;

// ── J-derivatives-31: the venue's vaults, a position in one, and its lock-up, each the venue's own figure ──────────

/**
 * One vault the venue lists (J-derivatives-31 #1): its lock-up in seconds, the leader's profit share in basis points, what
 * it holds and its past return over `days` (basis points, negative a loss); each `null` where the venue does not publish it.
 */
export const venueVaultSchema = z.object({
  address: z.string(),
  name: z.string(),
  kind: z.enum(['protocol', 'user']),
  leader: z.string().nullable(),
  asset: z.string(),
  lockUpSeconds: z.number().int().nonnegative().nullable(),
  profitShareBps: z.number().int().nonnegative().max(10_000).nullable(),
  vaultValue: decimalSchema.nullable(),
  pastReturn: z.object({ bps: z.number().int(), days: z.number().int().positive() }).nullable(),
});
export type VenueVault = z.infer<typeof venueVaultSchema>;

/**
 * The account's vault positions with their lock-up ends, its account value as the venue counts it (vault balances
 * included; `null` where it publishes none), and its vault transfers, newest first (J-derivatives-31 #2 #3 #5).
 */
export const venueVaultHoldingsSchema = z.object({
  positions: z.array(z.object({ vault: z.string(), name: z.string(), asset: z.string(), equity: decimalSchema, lockUpEndsAt: isoTime })),
  accountValue: z.object({ asset: z.string(), amount: decimalSchema }).nullable(),
  transfers: z.array(
    z.object({
      vault: z.string(),
      direction: z.enum(['deposit', 'withdraw']),
      amount: decimalSchema,
      creditedAmount: decimalSchema,
      leaderShare: decimalSchema.nullable(),
      transferredAt: isoTime,
      nonce: z.string(),
    }),
  ),
});
export type VenueVaultHoldings = z.infer<typeof venueVaultHoldingsSchema>;

// ── J-derivatives-07: a liquidation and its aftermath, each the venue's own figure ────────────────────────────────

/** One part of a liquidation the venue carried out, with its own id, size, price and fee. */
export const venueLiquidationPartSchema = z.object({
  partId: z.string(),
  size: decimalSchema,
  price: decimalSchema,
  fee: decimalSchema,
  feeAsset: z.string(),
  liquidatedAt: isoTime,
});
/** One liquidation of one position, every part listed (J-derivatives-07 #2). */
export const venueLiquidationSchema = z.object({
  liquidationId: z.string(),
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  state: z.enum(['in_progress', 'done']),
  parts: z.array(venueLiquidationPartSchema),
  startedAt: isoTime,
});
export type VenueLiquidation = z.infer<typeof venueLiquidationSchema>;
/** A position's liquidation state on one market and the venue's price and fee rules (J-derivatives-07 #1 #3). */
export const venueLiquidationStatusSchema = z.object({
  symbol: z.string(),
  state: z.enum(['none', 'in_progress', 'done']),
  liquidationId: z.string().nullable(),
  priceRule: z.string(),
  feeRule: z.string().nullable(),
});
export type VenueLiquidationStatus = z.infer<typeof venueLiquidationStatusSchema>;
/** The venue's insurance fund, or not published (J-derivatives-07 #4). */
export const venueInsuranceFundSchema = asOf(
  maybeKnown(z.object({ name: z.string(), asset: z.string(), balance: decimalSchema, whereToRead: z.string(), rule: z.string() })),
).extend({ venueName: z.string() });
export type VenueInsuranceFund = z.infer<typeof venueInsuranceFundSchema>;
/** The venue's auto-deleveraging rules and this person's acknowledged version (J-derivatives-07 #5). */
export const venueAdlDisclosureSchema = z.object({
  venueId: z.string(),
  venueName: z.string(),
  asOf: isoTime,
  rules: z.object({ version: z.string(), text: z.string() }).nullable(),
  acknowledged: z.boolean(),
  acknowledgedVersion: z.string().nullable(),
  acknowledgedAt: isoTime.nullable(),
});
export type VenueAdlDisclosure = z.infer<typeof venueAdlDisclosureSchema>;
/** One auto-deleveraging of the person's position, with the venue's notice (J-derivatives-07 #6). */
export const venueDeleverageSchema = z.object({
  adlId: z.string(),
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: decimalSchema,
  price: decimalSchema,
  realisedPnl: signedDecimalSchema,
  notice: z.string(),
  deleveragedAt: isoTime,
});
export type VenueDeleverage = z.infer<typeof venueDeleverageSchema>;
/** One public liquidation or auto-deleveraging alert: no account in it (J-derivatives-07 #7). */
export const venueLiquidationAlertSchema = z.object({
  kind: z.enum(['liquidation', 'deleverage']),
  symbol: z.string(),
  side: z.enum(['long', 'short']),
  size: decimalSchema,
  price: decimalSchema,
  alertedAt: isoTime,
});
export type VenueLiquidationAlert = z.infer<typeof venueLiquidationAlertSchema>;

export const venueWithdrawalSchema = z.object({
  nonce: z.string(),
  asset: z.string(),
  amount: decimalSchema,
  destination: z.string(),
  status: z.enum(['pending', 'done', 'failed']),
  fee: maybeKnown(decimalSchema),
  /** The network fee taken from what arrives (the contract's `UserVenueWithdrawal.networkFee`); "not known", never 0. */
  networkFee: maybeKnown(decimalSchema),
});
export type VenueWithdrawal = z.infer<typeof venueWithdrawalSchema>;

export const venueLeverageSchema = z.object({ symbol: z.string(), leverageBps: z.number().int().positive(), marginMode });
export type VenueLeverage = z.infer<typeof venueLeverageSchema>;

export const assetAmount = z.object({ asset: z.string(), amount: signedDecimalSchema });
/** The venue's maker and taker rates in bps (J-cex-spot-10); a maker rate below zero is the venue's rebate. */
export const feeRatesSchema = z.object({ makerFeeBps: maybeKnown(signedDecimalSchema), takerFeeBps: maybeKnown(signedDecimalSchema) });
export type VenueFeeRates = z.infer<typeof feeRatesSchema>;
export const feeTiersSchema = z.object({
  tiers: z.array(z.object({ name: z.string(), fromVolume: decimalSchema, spot: feeRatesSchema, perpetual: feeRatesSchema })).nullable(),
  volumeAsset: z.string(),
  volumeDays: z.number().int().positive(),
});
export type VenueFeeTiers = z.infer<typeof feeTiersSchema>;
/** `GET /venue/fees` (J-cex-spot-10 #2): the venue's tiers, each listed market's rates and builder-fee cap, and ours. */
export const venuePublicFeesSchema = asOf(
  z.object({
    venue: z.object({ id: z.string(), displayName: z.string() }),
    schedule: feeTiersSchema,
    markets: z.array(
      z.object({
        symbol: z.string(),
        kind: z.enum(['spot', 'perpetual']),
        makerFeeBps: maybeKnown(signedDecimalSchema),
        takerFeeBps: maybeKnown(signedDecimalSchema),
        builderFeeCapBps: maybeKnown(decimalSchema),
        builderFeeBps: maybeKnown(decimalSchema),
      }),
    ),
    test: z.boolean(),
  }),
);
export type VenuePublicFees = z.infer<typeof venuePublicFeesSchema>;
/** One fee the venue publishes beside its trading fees (J-derivatives-12 #2), in bps of what it is charged on. */
export const venueOtherFeeSchema = z.object({
  kind: z.enum(['settlement', 'liquidation', 'other']),
  name: z.string(),
  symbol: z.string().nullable(),
  feeBps: decimalSchema,
  rule: z.string(),
});
export type VenueOtherFee = z.infer<typeof venueOtherFeeSchema>;
/** `GET /venue/fee-tier` (J-cex-spot-10 #6): the account's tier, counted volume and rates as the venue reports them. */
export const venueFeeTierSchema = asOf(
  z.object({
    schedule: feeTiersSchema,
    // J-derivatives-12 #2: the venue's settlement and other fees; absent or null where it publishes none.
    otherFees: z.array(venueOtherFeeSchema).nullable().optional(),
    account: z
      .object({
        tierName: z.string().nullable(),
        volume: maybeKnown(decimalSchema),
        spot: feeRatesSchema,
        perpetual: feeRatesSchema,
        tierUpdatedAt: isoTime.nullable(),
      })
      .nullable(),
  }),
).and(z.object({ test: z.boolean() }));
export type VenueFeeTier = z.infer<typeof venueFeeTierSchema>;
export const venuePreviewSchema = z.object({
  symbol: z.string(),
  kind: z.enum(['spot', 'perpetual']),
  lock: assetAmount,
  role: z.enum(['maker', 'taker']),
  venueFee: maybeKnown(assetAmount),
  builderFee: maybeKnown(assetAmount),
  // The venue's rates for this account on this market, from the preview itself (J-cex-spot-10 #1).
  rates: feeRatesSchema.optional(),
  // What lowered our builder fee on this order (J-campaigns-09 #2): a fee-saver coupon or the rank, the larger of the two.
  feeDiscount: z
    .union([
      z.object({ source: z.literal('coupon'), bps: z.number().int(), code: z.string(), voucherId: z.string() }),
      z.object({ source: z.literal('rank'), bps: z.number().int() }),
    ])
    .nullable()
    .optional(),
  // What fills now against the venue's book, and at what average price (the venue's word; not a quote).
  fill: maybeKnown(z.object({ amount: decimalSchema, averagePrice: decimalSchema.nullable() })).optional(),
  perpetual: z
    .object({
      leverageBps: z.number().int().positive(),
      marginMode,
      initialMargin: maybeKnown(decimalSchema),
      liquidationPrice: maybeKnown(decimalSchema),
    })
    .nullable(),
});
export type VenuePreview = z.infer<typeof venuePreviewSchema>;

// ── Routing over several venues (J-derivatives-28) ───────────────────────────────────────────────────────────────

export const health = z.object({ state: z.enum(['up', 'down']), since: isoTime, reason: z.string().nullable(), checkedAt: isoTime });
export type VenueHealth = z.infer<typeof health>;
export const level = z.object({ price: decimalSchema, amount: decimalSchema });
export const marketVenueSchema = z.object({
  venueId: z.string().nullable(),
  displayName: z.string().nullable(),
  test: z.boolean(),
  health,
  listed: z.boolean().nullable(),
  market: z
    .object({
      kind: z.enum(['spot', 'perpetual']),
      baseAsset: z.string(),
      quoteAsset: z.string(),
      makerFeeBps: maybeKnown(decimalSchema),
      takerFeeBps: maybeKnown(decimalSchema),
      lotSize: decimalSchema,
      tickSize: decimalSchema,
    })
    .nullable(),
  book: z
    .object({ venueId: z.string(), asOf: isoTime, value: z.object({ symbol: z.string(), bids: z.array(level), asks: z.array(level) }) })
    .nullable(),
  builderFee: z
    .union([
      z.object({ published: z.literal(false) }),
      z.object({ published: z.literal(true), carries: z.literal(false) }),
      z.object({ published: z.literal(true), carries: z.literal(true), feeBps: decimalSchema }),
    ])
    .nullable(),
  account: z.enum(['signable', 'connect', 'unknown']),
});
export type MarketVenue = z.infer<typeof marketVenueSchema>;
export const marketVenuesSchema = z.object({ symbol: z.string(), venues: z.array(marketVenueSchema), at: isoTime });

export const cost = z.object({
  venueId: z.string(),
  fillsNow: decimalSchema.nullable(),
  averagePrice: decimalSchema.nullable(),
  fillsWhole: z.boolean(),
  notional: decimalSchema,
  knownFees: decimalSchema,
  total: signedDecimalSchema,
  unknownFees: z.array(z.enum(['venue_fee', 'builder_fee'])),
});
export type RouteCost = z.infer<typeof cost>;
export const shownBest = level.nullable();
export const routePreviewSchema = z.object({
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  amount: decimalSchema,
  quoteAsset: z.string().nullable(),
  chosen: z
    .object({
      venueId: z.string(),
      displayName: z.string(),
      test: z.boolean(),
      shownBest,
      preview: z.object({ venueId: z.string(), asOf: isoTime, value: venuePreviewSchema }),
      cost,
    })
    .nullable(),
  others: z.array(cost.extend({ displayName: z.string(), shownBest })),
  excluded: z.array(z.object({ venueId: z.string().nullable(), displayName: z.string().nullable(), code: z.string(), detail: z.string() })),
  reason: z.enum(['only_venue', 'fills_whole', 'lowest_cost', 'fills_most', 'tie_by_id', 'no_signable_venue_up']),
  at: isoTime,
});
export type RoutePreview = z.infer<typeof routePreviewSchema>;

/** The venue's own answer for one order of orders signed together (J-derivatives-03 #9). */
export const legOutcome = z.union([
  z.object({
    definite: z.literal(true),
    accepted: z.literal(true),
    venueRef: z.string().nullable(),
    order: venueOrderSchema.nullable(),
    asOf: isoTime,
  }),
  z.object({ definite: z.literal(true), accepted: z.literal(false), refusal: refusalSchema, asOf: isoTime }),
]);
export type VenueLegOutcome = z.infer<typeof legOutcome>;

export const orderOutcome = z.union([
  z.object({
    definite: z.literal(true),
    accepted: z.literal(true),
    venueRef: z.string().nullable(),
    order: venueOrderSchema.nullable(),
    /** Orders signed together: each order's own answer, in the order sent. */
    legs: z.array(legOutcome).optional(),
    asOf: isoTime,
  }),
  z.object({ definite: z.literal(true), accepted: z.literal(false), refusal: refusalSchema, asOf: isoTime }),
  z.object({ definite: z.literal(false), reason: z.enum(['timeout', 'connection_lost', 'venue_error_after_send', 'already_submitted']) }),
]);
export type VenueOutcome = z.infer<typeof orderOutcome>;

/** The wallet's payload, passed through as the door sent it (the venue rebuilds and checks it at submit). */
export const typedDataSchema = z.object({
  domain: z.record(z.string(), z.unknown()),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  primaryType: z.string(),
  message: z.record(z.string(), z.unknown()),
});

export const preparedAnswerSchema = z.object({
  actionKey: z.string(),
  prepared: z.object({
    venueId: z.string(),
    signer: z.object({ role: z.enum(['owner', 'agent']), address: z.string() }),
    nonce: z.string(),
    venueClientOrderId: z.string().nullable(),
    typedData: typedDataSchema,
    digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
  reused: z.boolean(),
  signed: z.boolean(),
  lastOutcome: orderOutcome.nullable(),
});
export type PreparedAnswer = z.infer<typeof preparedAnswerSchema>;

export const submitAnswerSchema = z.object({
  actionKey: z.string(),
  outcome: orderOutcome,
  readBack: z
    .union([
      z.object({ venueClientOrderId: z.string() }),
      z.object({ venueClientOrderIds: z.array(z.string()) }),
      z.object({ nonce: z.string() }),
    ])
    .nullable(),
});
export type SubmitAnswer = z.infer<typeof submitAnswerSchema>;
export const PROTECTION_KINDS = ['take_profit', 'stop_loss', 'stop_market', 'stop_limit', 'trailing_stop'] as const;
export type ProtectionKind = (typeof PROTECTION_KINDS)[number];
export const PROTECTION_SOURCES = ['mark', 'last', 'index'] as const;
export type ProtectionSource = (typeof PROTECTION_SOURCES)[number];

export const protectionViewSchema = z.object({
  id: z.string(),
  kind: z.enum(PROTECTION_KINDS),
  role: z.enum(['take_profit', 'stop_loss']),
  restsOn: z.enum(['venue', 'engine']),
  label: z.string(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  quantity: decimalSchema,
  triggerSource: z.enum(PROTECTION_SOURCES),
  triggerPrice: decimalSchema.nullable(),
  limitPrice: decimalSchema.nullable(),
  trailingDistance: decimalSchema.nullable(),
  currentTrigger: decimalSchema.nullable(),
  status: z.enum(['armed', 'triggered', 'filled', 'failed', 'cancelled']),
  failure: z.string().nullable(),
  cancelReason: z.string().nullable(),
  venueOrderId: z.string().nullable(),
  venueClientOrderId: z.string().nullable(),
  parentClientOrderId: z.string().nullable(),
  agentPermission: z.object({ agentAddress: z.string() }).nullable(),
  clientOrderId: z.string(),
  actionKey: z.string().nullable(),
});
export type ProtectionView = z.infer<typeof protectionViewSchema>;

export const protectionCreatedSchema = z.union([
  z.object({ restsOn: z.literal('venue'), actionKey: z.string(), prepared: preparedAnswerSchema.shape.prepared, reused: z.boolean() }),
  z.object({ restsOn: z.literal('engine'), protection: protectionViewSchema }),
]);
export type ProtectionCreated = z.infer<typeof protectionCreatedSchema>;

export const protectionAgentSchema = z.object({
  agentAddress: z.string(),
  agentName: z.string(),
  approved: z.boolean(),
  validUntil: z.string().nullable(),
});
export type ProtectionAgent = z.infer<typeof protectionAgentSchema>;

/** One protection to arm: only the price fields its kind takes are sent. Amounts are decimal strings. */
export interface ProtectionRequest {
  owner: string;
  symbol: string;
  kind: ProtectionKind;
  side: 'buy' | 'sell';
  quantity: string;
  triggerPrice?: string;
  limitPrice?: string;
  trailingDistance?: string;
  triggerSource: ProtectionSource;
  clientOrderId: string;
  /** The entry order's own client order key, for a take profit or stop loss attached to it. */
  attachTo?: string;
}

// ── Conditional spot orders (J-cex-spot-08; svc-trade src/venue/spot-conditionals.ts) ─────────────────────────────

export const SPOT_CONDITIONAL_KINDS = ['stop_limit', 'stop_market', 'oco', 'bracket', 'oto'] as const;
export type SpotConditionalKind = (typeof SPOT_CONDITIONAL_KINDS)[number];
/**
 * Every kind our engine keeps: the conditional kinds, and a good-till-date order (J-cex-spot-03 #7), which the desk's
 * own ticket places (the person's limit on the venue, cancelled by our engine at its expiry).
 */
export const SPOT_ORDER_KINDS = [...SPOT_CONDITIONAL_KINDS, 'gtd'] as const;
export type SpotOrderKind = (typeof SPOT_ORDER_KINDS)[number];
export const SPOT_LEG_ROLES = ['stop', 'take_profit', 'stop_loss', 'entry', 'close'] as const;
export type SpotLegRole = (typeof SPOT_LEG_ROLES)[number];

export const spotLegSchema = z.object({
  role: z.enum(SPOT_LEG_ROLES),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['limit', 'market']),
  price: decimalSchema.nullable(),
  triggerPrice: decimalSchema.nullable(),
  quantity: decimalSchema,
  restsOn: z.enum(['venue', 'engine']),
  signedBy: z.enum(['wallet', 'agent']),
  status: z.enum(['waiting', 'armed', 'triggered', 'open', 'partially_filled', 'filled', 'cancelled', 'failed']),
  orderKey: z.string().nullable(),
  venueClientOrderId: z.string().nullable(),
  filled: decimalSchema.nullable(),
  locked: decimalSchema.nullable(),
  lockedAsset: z.string().nullable(),
  linkedTo: z.enum(SPOT_LEG_ROLES).nullable(),
});
export type SpotLegView = z.infer<typeof spotLegSchema>;

export const spotConditionalSchema = z.object({
  id: z.string(),
  clientOrderId: z.string(),
  kind: z.enum(SPOT_ORDER_KINDS),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  quantity: decimalSchema,
  status: z.enum(['entry', 'placing', 'open', 'armed', 'firing', 'cancelling', 'fired', 'filled', 'failed', 'cancelled', 'expired']),
  restsOn: z.literal('engine'),
  label: z.string(),
  agentPermission: z.object({ agentAddress: z.string() }),
  triggerSource: z.literal('last'),
  triggerPrice: decimalSchema.nullable(),
  limitPrice: decimalSchema.nullable(),
  takeProfitPrice: decimalSchema.nullable(),
  entryPrice: decimalSchema.nullable(),
  entryTif: z.enum(['GTC', 'IOC']).nullable(),
  closePrice: decimalSchema.nullable(),
  exitQuantity: decimalSchema.nullable(),
  /** A good-till-date order's expiry (ISO), when our engine cancels it on the venue; null for every other kind. */
  expireAt: z.string().nullable(),
  referencePrice: decimalSchema.nullable(),
  failure: z.string().nullable(),
  cancelReason: z.string().nullable(),
  createdAt: z.string(),
  legs: z.array(spotLegSchema),
});
export type SpotConditionalView = z.infer<typeof spotConditionalSchema>;

export const spotConditionalCreatedSchema = z.union([
  z.object({ restsOn: z.literal('venue'), actionKey: z.string(), prepared: preparedAnswerSchema.shape.prepared, reused: z.boolean() }),
  z.object({
    restsOn: z.literal('engine'),
    conditional: spotConditionalSchema,
    reused: z.boolean(),
    entry: preparedAnswerSchema.nullable(),
  }),
]);
export type SpotConditionalCreated = z.infer<typeof spotConditionalCreatedSchema>;

export const spotFeeLegSchema = z.object({
  role: z.enum(SPOT_LEG_ROLES),
  side: z.enum(['buy', 'sell']),
  liquidity: z.enum(['maker', 'taker']),
  price: decimalSchema,
  quantity: decimalSchema,
  venueFeeBps: decimalSchema.nullable(),
  builderFeeBps: decimalSchema.nullable(),
  feeAsset: z.string(),
  estimatedFee: decimalSchema.nullable(),
});
export type SpotFeeLeg = z.infer<typeof spotFeeLegSchema>;
/** J-derivatives-01 #2: one perpetual open or blocked for this account, with every reason (svc-trade venue-gated-list.ts). */
export const venueGatedContractSchema = z.object({
  symbol: z.string(),
  open: z.boolean(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  blockers: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type VenueGatedContract = z.infer<typeof venueGatedContractSchema>;

/** J-derivatives-12 #5: the perpetuals this account is eligible for, or none with the reason (svc-trade venue-eligibility.ts). */
export const venueEligibleSchema = z.object({
  level: z.enum(['basic', 'full', 'institutional']).nullable(),
  reason: z.object({ code: z.string(), message: z.string() }).nullable(),
  instruments: z.array(z.object({ symbol: z.string(), settleAsset: z.string(), maxLeverageBps: z.number().int().positive().nullable() })),
});
export type VenueEligible = z.infer<typeof venueEligibleSchema>;

/** J-derivatives-12 #4: our builder fee on one fill of the person's own orders, and the ledger transaction it posted. */
export const venueBuilderFeeRowSchema = z.object({
  fillId: z.string(),
  amount: decimalSchema,
  asset: z.string(),
  filledAt: isoTime,
  status: z.enum(['posted', 'refused', 'not_our_order']),
  refusalCode: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
});
export type VenueBuilderFeeRow = z.infer<typeof venueBuilderFeeRowSchema>;

/** `GET /venue/agent-accounts` (J-agents-21). */
export const agentAccountsReadSchema = z.object({ accounts: z.array(agentAccountRowSchema) });
/** One of the owner's own sub-accounts, as the venue lists them on the main account (J-agents-08 #2). */
export const venueSubAccountSchema = z.object({ subAccount: z.string(), name: z.string() });
/** A statement job's file (J-cex-spot-07 #5). */
export const venueStatementFileSchema = z.object({ filename: z.string(), sha256: z.string(), csv: z.string() });
/** `GET /venue/protections` (J-derivatives-03). */
export const protectionListSchema = z.object({ protections: z.array(protectionViewSchema) });
/** `GET /venue/spot-orders` (J-cex-spot-08). */
export const spotConditionalListSchema = z.object({ orders: z.array(spotConditionalSchema) });
/** `POST /venue/spot-orders/review` (J-cex-spot-08). */
export const spotFeeReviewSchema = z.object({ legs: z.array(spotFeeLegSchema) });
