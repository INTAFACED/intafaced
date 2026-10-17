import { bigint, boolean, index, integer, jsonb, pgSchema, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { amount, bps, createdAt, tstz, updatedAt } from '@intafaced/db';

/**
 * THE PRODUCT LAYER (§5.2).
 *
 * What is listed, what was ordered, what was matched. THIS SERVICE'S SCHEMA
 * ONLY — svc-matching owns the book, svc-ledger owns the balances, and neither
 * is reachable from here except through its API.
 *
 * Doctrine §0.6 is the rule that shapes every column below: **this service
 * holds no balances.** `orders.filled_qty` is order state measured in the base
 * asset, not money. `orders.hold_amount` is an immutable record of the ledger
 * post that funded the order — it is written once at place. Native qty-down
 * records proven releases in `amend_released` rather than rewriting the
 * original post. The remainder owed back is derived
 * (`hold_amount - Σ fills - amend_released`), so it cannot drift from the
 * ledger.
 *
 * Scope of this migration is `trade.spot`. §5.2 also specifies `positions`,
 * `funding_rates`, `insurance_fund`, `copy_leaders`, `copy_follows` and
 * `otc_quotes` — those belong to `trade.futures`, `trade.copy` and `trade.otc`,
 * which are separate tracker features with their own PRs. The `kind` enum
 * already carries their values so listing a futures market later is a row, not
 * a migration.
 */
export const trade = pgSchema('trade');

/** §5.2 `markets.kind`. Only `spot` is served in this PR; the others are listed states. */
export const marketKindEnum = trade.enum('market_kind', ['spot', 'futures', 'options']);

/** European option call/put when kind=options (0017). NULL on non-options. */
export const optionTypeEnum = trade.enum('option_type', ['call', 'put']);

/** v1 European only (0017). American is a product decision + migration. */
export const optionStyleEnum = trade.enum('option_style', ['european']);

/** Isolated perp vs dated future when kind=futures (0045). NULL on non-futures. */
export const futuresContractStyleEnum = trade.enum('futures_contract_style', ['perpetual', 'dated']);

/**
 * What class of thing is listed (0001).
 *
 * A gold market and a BTC market are not the same product to a regulator, a risk
 * engine, or a tax report — and, more immediately, they do not keep the same
 * hours. Every column added alongside this one exists because `crypto` was
 * previously assumed everywhere.
 */
export const assetClassEnum = trade.enum('asset_class', ['crypto', 'commodity', 'forex']);

/**
 * What one unit of the base asset IS.
 *
 * `unit` is anything counted — a coin, a token, a unit of currency. The rest
 * name a physical measure and are not interchangeable: 10 of `WTI/USD` is ten
 * barrels and 10 of `XAU/USD` is ten troy ounces, and nothing downstream can
 * recover which was meant if the listing did not say.
 */
export const instrumentUnitEnum = trade.enum('instrument_unit', ['unit', 'troy_ounce', 'barrel', 'mmbtu']);

/**
 * A named trading calendar, not an embedded session table.
 *
 * The windows live in `@intafaced/contracts` (`TRADING_SCHEDULES`), evaluated
 * against a real IANA timezone so the forex week tracks US daylight saving
 * rather than drifting an hour twice a year. Storing a key keeps the database
 * from holding a second copy of the calendar that could disagree with it.
 */
export const tradingScheduleEnum = trade.enum('trading_schedule', ['crypto-24x7', 'fx-global', 'cme-globex']);

/**
 * Market lifecycle.
 *
 * `halted` is a distinct state from `delisted`, not a flag: a halted market
 * still has live orders and open holds that must be cancellable, while a
 * delisted one must have none. Collapsing them would make "can this order be
 * cancelled" ambiguous at exactly the moment an operator needs it not to be.
 */
export const marketStatusEnum = trade.enum('market_status', ['pending', 'active', 'halted', 'delisted']);

export const orderSideEnum = trade.enum('order_side', ['buy', 'sell']);

/**
 * Order types this service accepts. `stop`, `stop_limit` and `take_profit`
 * exist in `@intafaced/exchange-contract` and in the engine, but are not
 * accepted here — see the SOCKET §13 note in `spot/risk.ts`.
 */
export const orderTypeEnum = trade.enum('order_type', ['market', 'limit']);

export const timeInForceEnum = trade.enum('time_in_force', ['GTC', 'IOC', 'FOK', 'PO']);

/**
 * Order status.
 *
 * `pending` is the state an order occupies between "row written" and "funds
 * held". It exists so that a crash in that window strands nothing: a pending
 * row has no ledger post behind it and no engine presence, so the only correct
 * recovery — delete it — is also the only thing it can do. Every other status
 * implies a hold that is either live or provably released. `recovery_required`
 * is the explicit frozen-spine unknown outcome; its hold stays encumbered until
 * lookup/reconciliation proves a safe terminal transition. `hold_unknown` is
 * earlier: the `order.hold` reply was lost, so the row stays until
 * `order.hold:<orderId>` is read back.
 */
export const orderStatusEnum = trade.enum('order_status', [
  'pending',
  'open',
  'filled',
  'cancelled',
  'rejected',
  'expired',
  'recovery_required',
  'hold_unknown',
]);

/** Which side of the match a fill leg was. Fee rates differ, so it is stored, not inferred. */
export const liquidityEnum = trade.enum('liquidity', ['maker', 'taker']);

/**
 * A listed market (§5.2).
 *
 * `maker_bps` / `taker_bps` are the *published* rates. What a given user
 * actually pays is these minus their rank's `feeDiscountBps`, resolved once per
 * order and snapshotted on the order row — never re-read at fill time.
 */
export const markets = trade.table(
  'markets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** CCXT unified symbol, e.g. `BTC/USDT`. The id integrators actually use. */
    symbol: text('symbol').notNull(),
    baseAsset: text('base_asset').notNull(),
    quoteAsset: text('quote_asset').notNull(),
    kind: marketKindEnum('kind').notNull().default('spot'),
    /** Human label for the base — 'Gold', 'Crude Oil (WTI)'. i18n-keyed at the surface. */
    displayName: text('display_name').notNull().default(''),
    assetClass: assetClassEnum('asset_class').notNull().default('crypto'),
    /** The physical or notional unit one quoted price refers to. */
    quoteUnit: instrumentUnitEnum('quote_unit').notNull().default('unit'),
    /** How many `quoteUnit`s one quoted price covers. Almost always '1'. */
    unitSize: amount('unit_size').notNull().default('1'),
    /**
     * The conventional smallest quoted move — 0.0001 on most FX majors, 0.01 on
     * JPY crosses and on gold. NULL on crypto, which has no pip convention.
     *
     * DISTINCT from `tickSize`, which is what the ENGINE enforces. FX venues
     * quote fractional pips, so tick is routinely a tenth of this; conflating
     * the two displays every spread off by a factor of ten.
     */
    pipSize: amount('pip_size'),
    /** Which calendar this market keeps. Crypto is the only continuous one. */
    schedule: tradingScheduleEnum('schedule').notNull().default('crypto-24x7'),
    /** Paper/sim market — placeOrder never posts real ledger holds. */
    paper: boolean('paper').notNull().default(false),
    /** Local TEST listing. Default false. Hidden unless TRADE_FUTURES_TEST_SEED is on. */
    test: boolean('test').notNull().default(false),
    /** Explicit seed values. Null on production rows. */
    testFixture: jsonb('test_fixture'),
    /**
     * European option terms (0017) — all null unless kind=options.
     * CHECK `markets_options_terms_ck` makes half-listed options impossible.
     * `settlementFixing` is an opaque D7 stamp, not a fabricated oracle price.
     */
    optionType: optionTypeEnum('option_type'),
    optionStyle: optionStyleEnum('option_style'),
    optionStrike: amount('option_strike'),
    optionExpiryAt: tstz('option_expiry_at'),
    settlementFixing: text('settlement_fixing'),
    /**
     * Dated vs perpetual (0045) — all null unless kind=futures.
     * CHECK `markets_dated_futures_terms_ck` makes half-listed dated futures impossible.
     * `futuresSettlementFixing` is an opaque owner stamp, not a fabricated settlement price.
     */
    futuresContractStyle: futuresContractStyleEnum('futures_contract_style'),
    futuresExpiryAt: tstz('futures_expiry_at'),
    futuresSettlementFixing: text('futures_settlement_fixing'),
    /**
     * Which plane lists this market (§22, §17.5).
     *
     * Read by the DEX/CEX switch. A market carrying 'protocol' is one
     * svc-protocol can actually match; listing one it cannot would advertise a
     * book that does not exist.
     */
    planes: text('planes').array().notNull().default(['fiat']),
    /** Minimum price increment. A price that is not a multiple of it is rejected. */
    tickSize: amount('tick_size').notNull(),
    /** Minimum quantity increment. */
    lotSize: amount('lot_size').notNull(),
    /** §5.2 "size limits by rank/KYC tier" — the market's own floor and ceiling. */
    minQty: amount('min_qty').notNull(),
    /** NULL = no per-order ceiling. */
    maxQty: amount('max_qty'),
    /**
     * Smallest order value in the quote asset. This is what stops a fill whose
     * quote amount rounds to zero from ever being possible, which the ledger
     * would refuse to post (a movement of nothing is not a movement).
     */
    minNotional: amount('min_notional').notNull(),
    status: marketStatusEnum('status').notNull().default('pending'),
    makerBps: bps('maker_bps').notNull(),
    takerBps: bps('taker_bps').notNull(),
    listedAt: tstz('listed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** One market per symbol, ever. Two `BTC/USDT` rows would be two books. */
    uniqueIndex('markets_symbol_idx').on(t.symbol),
    index('markets_status_idx').on(t.status),
    index('markets_pair_idx').on(t.baseAsset, t.quoteAsset),
    /** The terminal's asset-class tabs read this. */
    index('markets_asset_class_idx').on(t.assetClass),
  ],
);

/**
 * An order (§5.2).
 *
 * The row is written *before* the ledger hold and *before* the engine sees it,
 * in `pending`. Read `spot/trade-service.ts` for why that ordering is the one
 * that strands nothing.
 */
export const orders = trade.table(
  'orders',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    /**
     * §4.1 sub-accounts. Recorded for reporting only: the ledger's hold and the
     * fill settlement are at USER level, because that is the owner the
     * `orderHold` / `tradeFill` recipes name. A sub-account is a reporting
     * dimension here, not a separate pot of money.
     */
    subAccountId: uuid('sub_account_id'),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.id),
    /**
     * Caller-supplied idempotency key. The order id is *derived* from it, so a
     * retry lands on the same row and therefore the same `order.hold:<id>`
     * ledger key. Bots retry; a retry must not open a second position.
     */
    clientOrderId: text('client_order_id'),
    side: orderSideEnum('side').notNull(),
    type: orderTypeEnum('type').notNull(),
    /** NULL for market orders. */
    price: amount('price'),
    qty: amount('qty').notNull(),
    /**
     * Base quantity matched so far. ORDER STATE, NOT MONEY — it is denominated
     * in the base asset but it is not a balance, and no value is derived from
     * it. It must always equal `SUM(fills.qty)` for this order; a test asserts
     * exactly that, which is only possible because the truth is the fills.
     */
    filledQty: amount('filled_qty').notNull().default('0'),
    status: orderStatusEnum('status').notNull().default('pending'),
    tif: timeInForceEnum('tif').notNull().default('GTC'),
    /** Quote for a buy, base for a sell (§5.2 step 2). */
    holdAsset: text('hold_asset').notNull(),
    /**
     * Exactly what `orderHold` posted. Immutable after the hold succeeds — the
     * amount still owed back is `hold_amount - Σ fills.<consumed> - amend_released`,
     * computed on demand rather than decremented, so it cannot drift.
     */
    holdAmount: amount('hold_amount').notNull(),
    /**
     * Cumulative ledger release from proven native qty-down amends.
     * Terminal `orderHoldRelease` still uses sequence 0 against the derived remainder.
     */
    amendReleased: amount('amend_released').notNull().default('0'),
    /**
     * The rank perk applied to this order's fees, snapshotted at placement.
     *
     * Snapshotted rather than read at fill time for the same reason
     * `token.stakes.multiplier_bps` is: a rank change must not retroactively
     * re-price an order that was already accepted on the old terms. It also
     * means the fill path makes no network call, which is what keeps a fill
     * settleable when svc-identity is down.
     */
    feeDiscountBps: bps('fee_discount_bps').notNull().default('0'),
    /**
     * The protection price a market BUY was submitted at. A market buy is
     * funded before it is matched, so it is sent to the engine as a marketable
     * IOC limit at this price — the engine then physically cannot fill it above
     * what was held. NULL for every other order.
     */
    protectionPrice: amount('protection_price'),
    /** Engine acceptance sequence — ties an order to the matching journal. */
    engineSequence: integer('engine_sequence'),
    /** Matching instruction version. Starts at 1; bumps on accepted native amend. */
    engineVersion: integer('engine_version').notNull().default(1),
    /**
     * Seed/mm honesty (SD-2). True when placed via the seed bot path.
     * Public volume / tape stats exclude fills involving seeded orders (SD-3).
     */
    seeded: boolean('seeded').notNull().default(false),
    /** Engine reject code (`post_only_would_cross`, `fok_unfillable`, …). */
    rejectCode: text('reject_code'),
    /** Contract-compatible recovery evidence; value remains in the ledger hold. */
    recoveryReason: text('recovery_reason'),
    reconciliationKey: text('reconciliation_key'),
    /** Exact PX-S01 admission proof retained across OUTCOME_UNKNOWN retries. */
    lifecycleProof: jsonb('lifecycle_proof'),
    /** Set only on an order submitted by the cancel-then-submit replacement saga. */
    replacementOf: uuid('replacement_of'),
    /** Canonical request digest used to refuse conflicting replacement retries. */
    replacementRequestHash: text('replacement_request_hash'),
    /** Signed principal sid at place. Null on pre-R-auth rows; writers refuse blank. */
    sessionId: text('session_id'),
    /** Signed principal kid, or house-mm for seed. */
    apiKeyId: text('api_key_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * THE RETRY GUARD. One order per (user, market, client id). The derived
     * order id makes this almost redundant — which is the point: the database
     * refuses a double even if the derivation is ever changed.
     */
    uniqueIndex('orders_client_id_idx').on(t.userId, t.marketId, t.clientOrderId),
    /** `fetchOpenOrders` — the hot read path for every terminal and bot. */
    index('orders_user_status_idx').on(t.userId, t.status),
    index('orders_market_status_idx').on(t.marketId, t.status),
    index('orders_created_idx').on(t.createdAt),
  ],
);

/** Durable caller idempotency fence for replacement attempts, including refusals. */
export const orderReplaceRequests = trade.table(
  'order_replace_requests',
  {
    userId: uuid('user_id').notNull(),
    marketId: uuid('market_id').notNull(),
    clientOrderId: text('client_order_id').notNull(),
    originalOrderId: uuid('original_order_id').notNull(),
    requestHash: text('request_hash').notNull(),
    replacementOrderId: uuid('replacement_order_id'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('order_replace_requests_key_idx').on(t.userId, t.marketId, t.clientOrderId),
    index('order_replace_requests_original_idx').on(t.originalOrderId),
  ],
);

/**
 * One leg of one match (§5.2).
 *
 * Two rows per fill — the maker's and the taker's — because each side has its
 * own fee, its own asset received, and its own tax record. The ledger post is
 * ONE transaction covering both legs (`tradeFill` is six entries, atomic); the
 * two rows here are the reporting projection of it, not two settlements.
 */
export const fills = trade.table(
  'fills',
  {
    /** Derived from (market, engine sequence, role) — never random. */
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    /** The other side's order. Not a FK: the counterparty's row is equally real, but the engine is the authority on the pairing. */
    counterOrderId: uuid('counter_order_id').notNull(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.id),
    userId: uuid('user_id').notNull(),
    side: orderSideEnum('side').notNull(),
    liquidity: liquidityEnum('liquidity').notNull(),
    price: amount('price').notNull(),
    qty: amount('qty').notNull(),
    /**
     * price x qty, floored, in the quote asset.
     *
     * Stored rather than recomputed because it is what the ledger actually
     * moved. Recomputing it later with a different rounding mode would produce
     * a number that disagrees with the book by a wei, and "the report disagrees
     * with the ledger" is not a rounding question, it is an incident.
     */
    quoteAmount: amount('quote_amount').notNull(),
    /** The asset the fee was taken in — whatever this side RECEIVED. */
    feeAsset: text('fee_asset').notNull(),
    feeAmount: amount('fee_amount').notNull(),
    /** Effective rate after the rank discount. Stored so a fee is explicable years later. */
    feeBps: bps('fee_bps').notNull(),
    /** Engine sequence. One match, one sequence, forever. */
    sequence: integer('sequence').notNull(),
    ts: tstz('ts').notNull().defaultNow(),
    /** Copied from the order at settle. Fill without session or API-key refuses. */
    sessionId: text('session_id'),
    apiKeyId: text('api_key_id'),
    createdAt: createdAt(),
  },
  (t) => [
    /** A match settles once per side. The engine sequence is the business key. */
    uniqueIndex('fills_market_sequence_role_idx').on(t.marketId, t.sequence, t.liquidity),
    index('fills_order_idx').on(t.orderId),
    index('fills_user_ts_idx').on(t.userId, t.ts),
    index('fills_market_ts_idx').on(t.marketId, t.ts),
  ],
);

/**
 * Materialized spot OHLCV (A-TRADE-SPOT-1). Closed buckets only, from non-seeded
 * taker fills. REST still reads live fills; this table is the durable job
 * output (default OFF). Absence of a row is honest silence — never zero-fill.
 */
export const spotCandles = trade.table(
  'spot_candles',
  {
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.id),
    timeframe: text('timeframe').notNull(),
    openTimeMs: bigint('open_time_ms', { mode: 'number' }).notNull(),
    open: amount('open').notNull(),
    high: amount('high').notNull(),
    low: amount('low').notNull(),
    close: amount('close').notNull(),
    volume: amount('volume').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.marketId, t.timeframe, t.openTimeMs] }),
    index('spot_candles_market_tf_time_idx').on(t.marketId, t.timeframe, t.openTimeMs),
  ],
);

/** Futures position side (§5.2 / trade.futures F2). */
export const positionSideEnum = trade.enum('position_side', ['long', 'short']);
export const marginModeEnum = trade.enum('margin_mode', ['cross', 'isolated']);
export const positionStatusEnum = trade.enum('position_status', ['open', 'closing', 'closed', 'liquidated']);

/**
 * Open / closing / closed futures positions. STATE ONLY — margin is ledger
 * collateral `position:<id>`, never a balance column that could drift.
 * `closing` = trader asked to leave while the feed was dark (ADR 2026-08-07).
 */
export const positions = trade.table(
  'positions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.id),
    side: positionSideEnum('side').notNull(),
    status: positionStatusEnum('status').notNull().default('open'),
    marginMode: marginModeEnum('margin_mode').notNull().default('isolated'),
    size: amount('size').notNull(),
    entryPrice: amount('entry_price').notNull(),
    leverage: amount('leverage').notNull().default('1'),
    marginInitial: amount('margin_initial').notNull(),
    /** Current residual margin after funding pays; planners read this, not margin_initial. */
    marginCurrent: amount('margin_current').notNull(),
    marginAsset: text('margin_asset').notNull(),
    fundingPaid: amount('funding_paid').notNull().default('0'),
    /** Last posted futuresMarginAdd/Release sequence; close residual uses 1. */
    marginAdjustSeq: integer('margin_adjust_seq').notNull().default(1),
    /** Durable saga intent. Non-null from prepare commit through ledger post/finalize. */
    marginAdjustRequest: text('margin_adjust_request'),
    liqPrice: amount('liq_price'),
    openedAt: tstz('opened_at').notNull().defaultNow(),
    closedAt: tstz('closed_at'),
    /** Set only while status=closing — futures-namespaced refuse code. */
    closingReason: text('closing_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('positions_user_status_idx').on(t.userId, t.status), index('positions_market_idx').on(t.marketId)],
);

export const positionMarginAdjustments = trade.table(
  'position_margin_adjustments',
  {
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    clientAdjustmentId: text('client_adjustment_id').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    sequence: integer('sequence').notNull(),
    status: text('status').notNull().default('pending'),
    result: jsonb('result'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    completedAt: tstz('completed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.positionId, t.clientAdjustmentId] }),
    uniqueIndex('position_margin_adjustments_one_pending_idx')
      .on(t.positionId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * Which funding periods have already moved a position's margin (0014).
 *
 * The applier runs between an idempotent ledger post and the settle marker that
 * stops the tick re-running, so a restart in that gap replays it. Without this
 * key a replayed decrement charges a trader's margin twice for one funding
 * period — liquidating early and releasing short, clamped at zero so nothing
 * raises. The claim and the margin update are one statement.
 *
 * Also the per-position funding audit trail: which periods this position has
 * actually paid, recorded rather than inferred from a running total.
 */
export const positionFundingApplied = trade.table(
  'position_funding_applied',
  {
    positionId: uuid('position_id')
      .notNull()
      .references(() => positions.id, { onDelete: 'cascade' }),
    periodId: text('period_id').notNull(),
    /** Signed: positive is margin paid out of this position, negative is received. */
    paid: amount('paid').notNull(),
    appliedAt: tstz('applied_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.positionId, t.periodId] }), index('position_funding_applied_period_idx').on(t.periodId)],
);

/** Observed futures marks. A 24h change is two of these, or null when the span is short. */
export const futuresMarkSamples = trade.table(
  'futures_mark_samples',
  {
    marketId: uuid('market_id')
      .notNull()
      .references(() => markets.id, { onDelete: 'cascade' }),
    price: amount('price').notNull(),
    observedAt: tstz('observed_at').notNull(),
    source: text('source').notNull(),
  },
  (t) => [primaryKey({ columns: [t.marketId, t.observedAt] })],
);

export const schema = {
  markets,
  orders,
  orderReplaceRequests,
  fills,
  positions,
  positionMarginAdjustments,
  positionFundingApplied,
  futuresMarkSamples,
};
