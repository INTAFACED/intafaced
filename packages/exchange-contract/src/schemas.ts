import { z } from 'zod';
import { scheduleKeySchema } from '@intafaced/contracts/instruments';

/**
 * CCXT-SHAPED PUBLIC EXCHANGE API.
 *
 * The unified interface every trading bot, algo framework, and third-party
 * terminal already speaks. By publishing this shape, INTAFACED becomes a
 * first-class venue for software that was written before we existed.
 *
 * Why it is shaped like this, precisely:
 *   - CCXT's unified structures are a de-facto standard across ~100 venues.
 *     Matching them means integrators write zero adapter code.
 *   - The pro desktop terminal (docs/TERMINAL_INTEGRATION.md) drives its whole
 *     trading layer through CCXT. Serving this shape connects it with no
 *     modification to its source at all.
 *
 * Two deliberate divergences from stock CCXT, both non-negotiable here:
 *
 *   1. MONEY IS A DECIMAL STRING. CCXT hands back JS floats. We do not — the
 *      ledger reconciles to 18 decimal places and a float cannot carry that.
 *      Numeric fields that CCXT types as `number` are strings in our payloads;
 *      the `intafaced` CCXT class casts at the boundary, where the loss is
 *      visible and contained rather than silent and structural.
 *
 *   2. Timestamps are ms-since-epoch integers (CCXT convention) AND an ISO
 *      `datetime` string, because CCXT consumers use both.
 */

/** Decimal string. The only representation of value that crosses this boundary. */
export const decimal = z.string().regex(/^-?\d+(\.\d{1,18})?$/, 'amounts are decimal strings with at most 18 decimal places');

/** Strictly greater than zero. Character scan only — never a JS number. */
export function positiveDecimal(value: string): boolean {
  if (value.startsWith('-')) return false;
  for (const char of value) {
    if (char >= '1' && char <= '9') return true;
  }
  return false;
}

/** Zero is a present bound. A leading minus is not an absent limit. */
function nonNegativeDecimal(value: string): boolean {
  return !value.startsWith('-');
}

const positiveDecimalString = decimal.refine(positiveDecimal, 'must be a positive decimal string');
const nonNegativeDecimalString = decimal.refine(nonNegativeDecimal, 'must be a non-negative decimal string');

export const timestampMs = z.number().int().nonnegative();
export const isoDatetime = z.string().datetime({ offset: true });

// ── Markets ──────────────────────────────────────────────────────────────────

export const marketTypeSchema = z.enum(['spot', 'swap', 'future', 'option']);

/**
 * Stable schedule keys — derived from `@intafaced/contracts` `TRADING_SCHEDULES`
 * (D-S-05). Never a second handwritten list; drift fails at typecheck/import.
 */
export const marketScheduleKeySchema = scheduleKeySchema;
export type MarketScheduleKey = z.infer<typeof marketScheduleKeySchema>;

/** One open window on the venue's local week (day 0 = Sunday). */
export const marketSessionBoundarySchema = z.object({
  day: z.number().int().min(0).max(6),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

/**
 * When the venue trades. `continuous` is crypto (no close). `sessions` is
 * forex / commodity calendars — the same windows `assertMarketOpen` evaluates.
 *
 * OPERATOR NOTE on `holidays: []`: an empty list is NOT "no holidays ever". It
 * means none are configured, and the gate fails OPEN for those calendar days.
 * That is the wrong fail direction once FX/CME are live money; refresh from the
 * venue calendar before going live.
 */
export const marketHoursSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('continuous') }),
  z.object({
    kind: z.literal('sessions'),
    timezone: z.string().min(3),
    windows: z
      .array(
        z.object({
          open: marketSessionBoundarySchema,
          close: marketSessionBoundarySchema,
        }),
      )
      .min(1),
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  }),
]);
export type MarketHours = z.infer<typeof marketHoursSchema>;

/**
 * CCXT market. `symbol` is the unified form — 'BTC/USDT', 'BTC/USDT:USDT' for
 * a linear perp. `id` is our internal market id.
 *
 * Extensions beyond stock CCXT (kept top-level so bots do not need a second
 * map): `paper`, `schedule`, `sessionOpen`, `nextSessionChange`, `hours`.
 * A client that ignores unknown keys is no worse off; one that reads them can
 * refuse simulated markets and "venue shut" without guessing from empty books.
 */
/**
 * SP-order-entry-03: pair rules in words. Every protection value is either a
 * value string or the literal "not set" — never a guessed default.
 */
const pairRuleValueSchema = z.string().min(1);
export const pairRulesSchema = z.object({
  tick: z.string(),
  lot: z.string(),
  minQty: z.string(),
  minNotional: z.string(),
  maxQty: pairRuleValueSchema,
  protection: z.object({
    collar: pairRuleValueSchema,
    fatFinger: pairRuleValueSchema,
    /** Effective cap: operator cap, else the owner env cap, else "not set". */
    slippageCapBps: pairRuleValueSchema,
    openOrdersPerMarket: pairRuleValueSchema,
  }),
  /** Operator risk version the protection values came from; "0" when none was approved. */
  riskVersion: z.string(),
});
export type PairRules = z.infer<typeof pairRulesSchema>;

/**
 * SP-order-entry-03 review fix: operator circuit-breaker state. While set, the
 * order path refuses every order with `trade.circuit_breaker_reference_unset`.
 */
export const pairHaltSchema = z.object({
  circuitBreaker: pairRuleValueSchema,
  refusesAllOrders: z.boolean(),
  refusalCode: z.literal('trade.circuit_breaker_reference_unset').nullable(),
  riskVersion: z.string(),
});
export type PairHalt = z.infer<typeof pairHaltSchema>;

export const marketSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  base: z.string(),
  quote: z.string(),
  /** Settlement asset for derivatives; null on spot. */
  settle: z.string().nullable(),
  baseId: z.string(),
  quoteId: z.string(),
  type: marketTypeSchema,
  spot: z.boolean(),
  swap: z.boolean(),
  future: z.boolean(),
  option: z.boolean(),
  contract: z.boolean(),
  linear: z.boolean().nullable(),
  inverse: z.boolean().nullable(),
  /**
   * Listing status (`trade.markets.status === 'active'`). NOT session hours —
   * a permanently listed FX pair is `active: true` every weekend.
   */
  active: z.boolean(),
  /**
   * TRUE = simulated / paper market. Orders take no hold and never post to the
   * ledger. Not stock CCXT; emitted so a bot can refuse sim markets in one
   * line rather than booking a position that does not exist.
   */
  paper: z.boolean(),
  /** Stable key into the hours table the order path evaluates. */
  schedule: marketScheduleKeySchema,
  /**
   * Whether the venue SESSION is open at response time (schedule only).
   * Distinct from `active`. Order path refuses closed sessions with
   * `trade.market_closed` — bots should not treat empty books as "exchange down"
   * when `sessionOpen` is false.
   */
  sessionOpen: z.boolean(),
  /**
   * Next schedule flip from response time. Null for continuous markets (never
   * flip) or when the key is unknown (sessionOpen is then false).
   */
  nextSessionChange: z
    .object({
      /** True = session becomes open at `timestamp`; false = becomes closed. */
      open: z.boolean(),
      timestamp: timestampMs,
      datetime: isoDatetime,
    })
    .nullable(),
  /** Full hours payload — continuous or sessions + timezone + windows. */
  hours: marketHoursSchema,
  /** Taker/maker as a decimal rate (0.001 = 10 bps), per CCXT convention. */
  taker: decimal,
  maker: decimal,
  /** Null on spot. A contract size is a positive decimal string, never zero. */
  contractSize: positiveDecimalString.nullable(),
  expiry: timestampMs.nullable(),
  expiryDatetime: isoDatetime.nullable(),
  strike: decimal.nullable(),
  optionType: z.enum(['call', 'put']).nullable(),
  /**
   * CCXT `precisionMode`. Always TICK_SIZE here, because that is what our
   * engine actually enforces: `snapToTick` rounds a price to a multiple of
   * `tick_size` and the book rejects a quantity that is not a multiple of
   * `lot_size`. Neither is a count of decimal places.
   *
   * DECIMAL_PLACES cannot express our own live listings. `EUR/USD` has a lot
   * size of 1000 units and `NATGAS/USD` a lot size of 10; as a decimal-place
   * count both collapse to 0, so a client rounding to 0 places builds 1500
   * units of EUR/USD — a number the engine must reject. Reporting the value
   * is the only report that lets a client construct a fillable order.
   */
  precisionMode: z.literal('TICK_SIZE'),
  /**
   * The tick and lot themselves, as decimal strings — `price` is the minimum
   * price increment, `amount` the minimum quantity increment. Round to a
   * multiple of these, not to a number of decimal places. Zero and a leading
   * minus are refused. There is no invented floor.
   */
  precision: z.object({
    amount: positiveDecimalString,
    price: positiveDecimalString,
  }),
  /**
   * Null is the only absent bound. `"0"` is a real bound. Amount and price
   * reject a leading minus. Cost and leverage stay on the signed decimal.
   */
  limits: z.object({
    amount: z.object({ min: nonNegativeDecimalString.nullable(), max: nonNegativeDecimalString.nullable() }),
    price: z.object({ min: nonNegativeDecimalString.nullable(), max: nonNegativeDecimalString.nullable() }),
    cost: z.object({ min: decimal.nullable(), max: decimal.nullable() }),
    leverage: z.object({ min: decimal.nullable(), max: decimal.nullable() }),
  }),
  /** SP-order-entry-03 pair rules; null when the mount has no risk reader or the read failed; null = unknown, never no limits. Absent on older servers. */
  pairRules: pairRulesSchema.nullable().optional(),
  /** SP-order-entry-03 circuit-breaker state; null when the mount has no risk reader or the read failed; null = unknown, never not-halted. */
  pairHalt: pairHaltSchema.nullable().optional(),
});
export type Market = z.infer<typeof marketSchema>;

// ── Ticker ───────────────────────────────────────────────────────────────────

export const tickerSchema = z.object({
  symbol: z.string(),
  timestamp: timestampMs,
  datetime: isoDatetime,
  high: decimal.nullable(),
  low: decimal.nullable(),
  bid: decimal.nullable(),
  bidVolume: decimal.nullable(),
  ask: decimal.nullable(),
  askVolume: decimal.nullable(),
  vwap: decimal.nullable(),
  open: decimal.nullable(),
  close: decimal.nullable(),
  last: decimal.nullable(),
  previousClose: decimal.nullable(),
  change: decimal.nullable(),
  percentage: decimal.nullable(),
  average: decimal.nullable(),
  baseVolume: decimal.nullable(),
  quoteVolume: decimal.nullable(),
});
export type Ticker = z.infer<typeof tickerSchema>;

// ── Order book ───────────────────────────────────────────────────────────────

/** [price, amount] — CCXT's level shape. */
export const orderBookLevelSchema = z.tuple([decimal, decimal]);

export const orderBookSchema = z.object({
  symbol: z.string(),
  /** Descending by price. */
  bids: z.array(orderBookLevelSchema),
  /** Ascending by price. */
  asks: z.array(orderBookLevelSchema),
  timestamp: timestampMs,
  datetime: isoDatetime,
  /** Engine sequence — lets a consumer detect a gap and resynchronise. */
  nonce: z.number().int().nonnegative(),
});
export type OrderBook = z.infer<typeof orderBookSchema>;

// ── OHLCV ────────────────────────────────────────────────────────────────────

/** [timestamp, open, high, low, close, volume] */
export const ohlcvSchema = z.tuple([timestampMs, decimal, decimal, decimal, decimal, decimal]);
export type OHLCV = z.infer<typeof ohlcvSchema>;

export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '3d', '1w', '1M'] as const;
export const timeframeSchema = z.enum(TIMEFRAMES);
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Timeframe → milliseconds. Used for candle bucketing and range validation. */
export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000,
};

// ── Trades ───────────────────────────────────────────────────────────────────

export const tradeSchema = z.object({
  id: z.string(),
  order: z.string().nullable(),
  timestamp: timestampMs,
  datetime: isoDatetime,
  symbol: z.string(),
  type: z.string().nullable(),
  side: z.enum(['buy', 'sell']),
  takerOrMaker: z.enum(['taker', 'maker']).nullable(),
  price: decimal,
  amount: decimal,
  cost: decimal,
  fee: z.object({ cost: decimal, currency: z.string(), rate: decimal.nullable() }).nullable(),
  /** A maker rebate paid on this fill (in the asset the maker paid), never a negative fee. Absent when none. */
  rebate: z.object({ cost: decimal, currency: z.string(), rate: decimal }).optional(),
  /**
   * The order chose to pay its fees in the platform token, and this fill took the fee in the asset it received instead,
   * for this reason (`trade.fee_ifc_insufficient`, …). Absent when the fill paid as chosen, or no token was chosen.
   */
  feeFallback: z.string().optional(),
  /** Unix ms when this fills read was assembled. Absent on older wires. */
  serverTime: timestampMs.optional(),
});
export type Trade = z.infer<typeof tradeSchema>;

// ── Orders ───────────────────────────────────────────────────────────────────

export const orderTypeSchema = z.enum(['market', 'limit', 'stop', 'stop_limit', 'take_profit']);
export const orderSideSchema = z.enum(['buy', 'sell']);
export const timeInForceSchema = z.enum(['GTC', 'IOC', 'FOK', 'PO', 'MOC', 'GTD', 'GTT']);
export const orderStatusSchema = z.enum(['open', 'closed', 'canceled', 'expired', 'rejected']);

/**
 * Marks the parent of a linked take-profit / stop-loss pair: an OCO, or the exit OCO a bracket places. The engine
 * rests two legs under this one order and one hold; a plain limit read would hide that. `stopLossLimit` is the worst
 * price the stop leg may pay and is set only on a buy OCO. Absent on a plain order and on wires from before this field;
 * an OCO placed before its legs were stored carries no marker (unknown, not "not an OCO").
 */
export const orderExitSchema = z.object({
  kind: z.enum(['oco', 'bracket_exit']),
  takeProfit: decimal,
  stopLoss: decimal,
  stopLossLimit: decimal.nullable(),
});
export type OrderExit = z.infer<typeof orderExitSchema>;

/**
 * How an OTO entry and its attached close name each other. The entry carries its close price and, once its fill placed
 * the close, the close's id; the close carries its entry's id. Absent on every other order and on wires from before
 * this field.
 */
export const orderLinkSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('entry'), closePrice: decimal, closeOrderId: z.string().nullable() }),
  z.object({ role: z.literal('close'), entryOrderId: z.string() }),
]);
export type OrderLink = z.infer<typeof orderLinkSchema>;

export const orderSchema = z.object({
  id: z.string(),
  clientOrderId: z.string().nullable(),
  timestamp: timestampMs,
  datetime: isoDatetime,
  lastTradeTimestamp: timestampMs.nullable(),
  symbol: z.string(),
  type: orderTypeSchema,
  side: orderSideSchema,
  timeInForce: timeInForceSchema.nullable(),
  postOnly: z.boolean(),
  reduceOnly: z.boolean(),
  price: decimal.nullable(),
  stopPrice: decimal.nullable(),
  average: decimal.nullable(),
  amount: decimal,
  filled: decimal,
  remaining: decimal,
  /**
   * Quote notional of fills. `"0"` when unfilled. `null` when filled but
   * quote is not known without loading fills (e.g. market sell — no limit
   * price, no protectionPrice). Never invent a confident `"0"` for that case.
   */
  cost: decimal.nullable(),
  status: orderStatusSchema,
  /**
   * Engine reason when the order ended rejected, expired, or as an unfilled
   * remainder (`post_only_would_cross`, `fok_unfillable`, `ioc_remainder`, …).
   * Null when there is no engine reason. Absent on wires from before this field.
   */
  rejectCode: z.string().nullable().optional(),
  /** Unix ms when this read was assembled. Absent on wires from before this field. */
  serverTime: timestampMs.optional(),
  fee: z.object({ cost: decimal, currency: z.string() }).nullable(),
  trades: z.array(tradeSchema),
  /** The linked exit legs when this order is an OCO parent or a bracket's exit. Absent otherwise. */
  exit: orderExitSchema.nullable().optional(),
  /** An OTO entry's attached close, or the entry a close belongs to. Absent otherwise. */
  linked: orderLinkSchema.optional(),
  /** The caller's own label from the create body. Null when none was sent. Absent on wires from before this field. */
  tag: z.string().nullable().optional(),
  /**
   * What a live order still holds: the hold placed with it, less what its fills spent and what an amend released (quote
   * for a buy, base for a sell). Null on a closed or unresolved order (nothing stated). Absent on wires from before this
   * field.
   */
  hold: z.object({ asset: z.string(), amount: decimal }).nullable().optional(),
  /**
   * The rank fee discount the order trades with, as a rate ("0" when none). Its fills' fee rates already include it.
   * Absent on wires from before this field.
   */
  feeDiscount: decimal.optional(),
  /**
   * A stop order's trigger: when it fired, which price it watched (`last` trade, `mark` or `index`) and the price that
   * reached the stop. Null on a stop that has not fired, or fired with no record kept. Absent on other orders and on
   * wires from before this field.
   */
  triggered: z
    .object({ at: isoDatetime, by: z.enum(['last', 'mark', 'index']), referencePrice: decimal })
    .nullable()
    .optional(),
});
export type Order = z.infer<typeof orderSchema>;

export const createOrderRequestSchema = z
  .object({
    symbol: z.string(),
    type: orderTypeSchema,
    side: orderSideSchema,
    // The sign checks sit on the fields, not in the object refinement below: a field refinement runs even when another
    // field (a bad `side`) has already failed, so one refusal names every bad field (DV-errors-01).
    amount: decimal.refine(positiveDecimal, 'amount must be a positive decimal string'),
    price: decimal.refine(positiveDecimal, 'price must be a positive decimal string').optional(),
    stopPrice: decimal.refine(positiveDecimal, 'stopPrice must be a positive decimal string').optional(),
    timeInForce: timeInForceSchema.optional(),
    postOnly: z.boolean().optional(),
    reduceOnly: z.boolean().optional(),
    /**
     * Caller-supplied idempotency key. Required: a resubmitted order with the
     * same key returns the original rather than opening a second hold. Bots
     * retry; the book must not double.
     */
    clientOrderId: z.string().min(1).max(64),
    /** Sub-account to trade from (§4.1 sub_accounts). */
    subAccountId: z.string().guid().optional(),
    /** Caller expire instant for GTD/GTT. Never invented here. */
    expireAt: isoDatetime.optional(),
    /** Self-trade handling. A mode the engine does not support is refused by the service, never silently ignored. */
    stpMode: z.enum(['cancel_maker', 'cancel_taker', 'cancel_both']).optional(),
    /** A label for the caller's own books. Never part of the idempotency key. */
    tag: z.string().min(1).max(16).optional(),
    /**
     * The asset fees are paid in: the asset the order receives (the default), or the platform token on a plain spot
     * market or limit order when the owner publishes its terms. Anything else is refused by the service
     * (`trade.fee_currency_unsupported`, `trade.fee_currency_ifc_unset`, …), never silently dropped.
     */
    feeCurrency: z.string().min(1).max(32).optional(),
    /** The instant after which the caller no longer wants this order created. Past it, the service refuses the create before any hold. */
    requestDeadline: isoDatetime.optional(),
    /** Which price releases a stop. Only `last` is read today; the service refuses `mark` and `index` with a typed code. */
    triggerBy: z.enum(['last', 'mark', 'index']).optional(),
  })
  .superRefine((order, ctx) => {
    // A limit order without a price is the single most common integration bug.
    // Reject it at the boundary rather than guessing what the caller meant.
    // Zero and negative are present values, not a missing price.
    const needsPrice = order.type === 'limit' || order.type === 'stop_limit';
    if (needsPrice && order.price === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['price'], message: `a ${order.type} order requires a price` });
    }
    if (order.type === 'market' && order.price !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['price'], message: 'a market order must not carry a price' });
    }
    const needsStop = order.type === 'stop' || order.type === 'stop_limit' || order.type === 'take_profit';
    if (needsStop && order.stopPrice === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stopPrice'], message: `a ${order.type} order requires a stopPrice` });
    }
    if (order.type === 'market' && order.postOnly === true && order.timeInForce === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['postOnly'],
        message: 'postOnly cannot be set on a market order when timeInForce is omitted',
      });
    }
    if (order.postOnly && order.timeInForce && order.timeInForce !== 'GTC' && order.timeInForce !== 'PO') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['postOnly'],
        message: 'postOnly cannot be combined with an immediate time-in-force',
      });
    }
    if ((order.timeInForce === 'GTD' || order.timeInForce === 'GTT') && !order.expireAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expireAt'],
        message: 'GTD/GTT requires expireAt; the engine does not invent one',
      });
    }
  });
export type CreateOrderRequest = z.infer<typeof createOrderRequestSchema>;

// ── Balances ─────────────────────────────────────────────────────────────────

/**
 * CCXT balance shape. Maps directly onto ledger account kinds (§4.2):
 *   free  → `available`
 *   used  → hold + escrow + stake + collateral
 *   total → free + used
 *
 * There is no separate balance store behind this — it is a projection of the
 * ledger, which is the only place a balance exists (Doctrine §0.6).
 */
export const balanceEntrySchema = z.object({
  free: decimal,
  used: decimal,
  total: decimal,
});

export const balancesSchema = z.object({
  timestamp: timestampMs,
  datetime: isoDatetime,
  /** Unix ms of this read. Same clock as `GET /api/v1/time`. Absent on older wires. */
  serverTime: timestampMs.optional(),
  /** Keyed by asset code: { USDT: { free, used, total } } */
  balances: z.record(z.string(), balanceEntrySchema),
});
export type Balances = z.infer<typeof balancesSchema>;

// ── Positions (derivatives) ──────────────────────────────────────────────────

export const positionSchema = z.object({
  id: z.string().nullable(),
  symbol: z.string(),
  timestamp: timestampMs,
  datetime: isoDatetime,
  /** Same instant as `datetime`. Named so a desk can show "opened" without guessing. */
  openedAt: isoDatetime.optional(),
  /** Caller open key. Null on a legacy row that predates the column. */
  clientOpenId: z.string().nullable().optional(),
  side: z.enum(['long', 'short']),
  /**
   * Lifecycle. `closing` = trader asked to exit while no usable mark existed
   * (ADR 2026-08-07) — must never render as `open`. Optional for older
   * integrators; svc-trade always sets it on futures rows it returns.
   */
  status: z.enum(['open', 'closing', 'closed', 'liquidated']).nullable().optional(),
  /** Futures-namespaced reason while status=closing; null otherwise. */
  closingReason: z.string().nullable().optional(),
  contracts: decimal,
  contractSize: decimal.nullable(),
  entryPrice: decimal,
  markPrice: decimal.nullable(),
  notional: decimal,
  leverage: decimal.nullable(),
  /** Set when `leverage` is null because the row never recorded one. Never inferred. */
  leverageReason: z.enum(['leverage_not_recorded']).nullable().optional(),
  collateral: decimal.nullable(),
  initialMargin: decimal.nullable(),
  maintenanceMargin: decimal.nullable(),
  unrealizedPnl: decimal.nullable(),
  realizedPnl: decimal.nullable(),
  liquidationPrice: decimal.nullable(),
  marginMode: z.enum(['cross', 'isolated']).nullable(),
  /** Unrealised PnL over initial margin in percent points (CCXT): '20' means +20%. Null with a reason in fieldReasons. */
  percentage: decimal.nullable(),
  /** When the position closed. Null on an open row, and on a legacy closed row that never recorded one. */
  closedAt: isoDatetime.nullable().optional(),
  /** Row update time. Distinct from `timestamp`, which stays the open time. */
  updatedAt: isoDatetime.nullable().optional(),
  /**
   * Trading fees the position's fills paid, opening and reducing, in the margin asset. Null (with a reason in
   * fieldReasons) when the position has no fill that recorded one. Absent when the answer did not read them.
   */
  fees: decimal.nullable().optional(),
  /** Set on a repeated close of a position this caller already closed. */
  replayed: z.boolean().optional(),
  /** Why a field above is null. Absent when that field has a value. */
  fieldReasons: z.record(z.string(), z.string()).optional(),
});
export type Position = z.infer<typeof positionSchema>;

export const fundingRateSchema = z.object({
  symbol: z.string(),
  markPrice: decimal.nullable(),
  indexPrice: decimal.nullable(),
  fundingRate: decimal,
  fundingTimestamp: timestampMs,
  fundingDatetime: isoDatetime,
  nextFundingTimestamp: timestampMs.nullable(),
});
export type FundingRate = z.infer<typeof fundingRateSchema>;

export const tradingFeeSchema = z.object({
  symbol: z.string(),
  maker: decimal,
  taker: decimal,
  /** Effective rate after rank perks and IFC discount (§4.1, §4.3). */
  percentage: z.boolean(),
  /** Owner schedule integer bps. Same numbers preview returns as `feeBps`. */
  makerBps: z.number().int().nonnegative().optional(),
  takerBps: z.number().int().nonnegative().optional(),
  /** Owner `TRADE_FEE_SCHEDULE` version. Names the published schedule. */
  version: z.string().optional(),
});
export type TradingFee = z.infer<typeof tradingFeeSchema>;

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * CCXT's error taxonomy. Integrators branch on these names, so the mapping is
 * part of the contract — an exchange that returns the wrong error class breaks
 * every bot's retry logic.
 */
export const EXCHANGE_ERROR_CODES = [
  'BadRequest',
  'BadSymbol',
  'InsufficientFunds',
  'InvalidOrder',
  'OrderNotFound',
  'OrderImmediatelyFillable',
  'OrderNotFillable',
  'DuplicateOrderId',
  'AuthenticationError',
  'PermissionDenied',
  'AccountSuspended',
  'RateLimitExceeded',
  'ExchangeNotAvailable',
  'OnMaintenance',
  /**
   * The venue understood the call and will never serve it in its current shape:
   * a funding rate on a spot market, leverage on a venue with no derivatives.
   * CCXT's own `NotSupported`, and deliberately distinct from every retryable
   * code above — a bot that sees this must stop calling, not back off. Answering
   * 404 instead would say "wrong URL" about a route we mount on purpose.
   */
  'NotSupported',
  'ExchangeError',
] as const;

export type ExchangeErrorCode = (typeof EXCHANGE_ERROR_CODES)[number];

export const exchangeErrorSchema = z.object({
  code: z.enum(EXCHANGE_ERROR_CODES),
  message: z.string(),
  /** Our own finer-grained code, e.g. 'ledger.insufficient_funds'. */
  intafacedCode: z.string().optional(),
  /** Present on RateLimitExceeded — seconds until the caller may retry. */
  retryAfter: z.number().int().positive().optional(),
});
export type ExchangeError = z.infer<typeof exchangeErrorSchema>;
