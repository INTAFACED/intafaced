import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireScope, type Principal } from '@intafaced/auth';
import { attachConvertExportRoute } from './convert/convert-history-rest.js';
import { checkAccess } from '@intafaced/config';
import { createEdgeContext, type Context, type EdgeRequest } from '@intafaced/contracts';
import { createOrderRequestSchema, type CreateOrderRequest } from '@intafaced/exchange-contract';
import {
  ZERO,
  add,
  formatAmount,
  mul,
  parseAmount,
  MoneyError,
  type AccountKind,
  type Amount,
  type Balance,
} from '@intafaced/ledger-client';
import {
  UNAUTHENTICATED,
  badRequest,
  badSymbol,
  invalidOrder,
  notSupported,
  permissionDenied,
  toCcxtError,
  type CcxtErrorResponse,
} from './ccxt-errors.js';
import type { Position } from '@intafaced/exchange-contract';
import type { MarketStateSnapshot } from '@intafaced/exchange-contract';
import { MARKETS_LIMIT_MAX, OpenOrdersLimitUnsetError, type AmendOrderInput, type PlaceOrderInput } from './spot/trade-service.js';
import { FEE_SCHEDULE_RESIDUAL, publishedProductBps, type OwnerFeeSchedule } from './spot/fee-schedule.js';
import {
  TradeError,
  type AmendOrderOutcome,
  type FillRecord,
  type Market,
  type OrderRecord,
  type OrderStatus,
  type ReplaceOrderOutcome,
} from './spot/types.js';
import { FuturesError } from './futures/position-service.js';
import { presentFuturesErrorWire } from './futures/futures-error-wire.js';
import { checkCollateralClassForMargin, checkMarginModeForFuturesOpen } from './futures/margin-mode.js';
import type { MarginCallWire } from './futures/margin-call-transport.js';
import type { AdlDisclosureWire } from './futures/adl-disclosure.js';
import type { AdlActionDisclosureWire } from './futures/adl-last-resort.js';
import { AdlDisclosureError } from './futures/adl-disclosure.js';
import { refuseArmById } from './ccxt-capability-matrix.js';
import { massCancelAccountRefuse, massCancelSessionRefuse, readSessionId } from './spot/matching-client.js';

/**
 * Private CCXT-style REST (trade.ccxt-api — authenticated).
 *
 * Paths match `REST_ROUTES` in `@intafaced/exchange-contract`:
 *   GET    /api/v1/orders/open     scope: trade:read  (?symbol=&limit=)
 *   GET    /api/v1/admin/orders/open scope: admin:read (canonical order rows)
 *   GET    /api/v1/admin/fees        scope: admin:read (fee schedule customers are charged, per market, with its source)
 *   GET    /api/v1/orders/closed   scope: trade:read  (?symbol=&limit=&since= ms)
 *   GET    /api/v1/orders/:id      scope: trade:read
 *   POST   /api/v1/orders          scope: trade:write + jurisdiction(module=trade)
 *   POST   /api/v1/orders/batch    scope: trade:write + jurisdiction(module=trade)
 *   POST   /api/v1/orders/batch-amend scope: trade:write + jurisdiction(module=trade)  (sequential native amend)
 *   POST   /api/v1/orders/:id/replace scope: trade:write + jurisdiction(module=trade)
 *   PATCH  /api/v1/orders/:id      scope: trade:write + jurisdiction(module=trade)  (native amend)
 *   DELETE /api/v1/orders/:id      scope: trade:write + jurisdiction(module=trade)
 *   DELETE /api/v1/orders          scope: trade:write + jurisdiction(module=trade)  (cancelAll; ?symbol= optional)
 *   POST   /api/v1/markets/:marketId/orders/mass-cancel scope: trade:write + jurisdiction  (matching mass-cancel; auth account only)
 *   GET    /api/v1/account/trades  scope: trade:read  (?symbol=&limit=&since= ms)
 *   GET    /api/v1/account/fees    scope: trade:read  (published maker/taker from markets)
 *   GET    /api/v1/account/balance scope: trade:read  (ledger projection; self-only)
 *   GET    /api/v1/positions       scope: trade:read  (open futures rows; [] when none)
 *   GET    /api/v1/positions/closed scope: trade:read (closed/liquidated; [] when none; ?symbol=&limit=&since= ms)
 *   GET    /api/v1/positions/:id   scope: trade:read  (one owned row; 404 if missing)
 *   GET    /api/v1/positions/:id/margin-call  scope: trade:read  (delivered call or 404)
 *   GET    /api/v1/futures/adl-disclosure     scope: trade:read  (copy + ack — DIRECTION:34)
 *   POST   /api/v1/futures/adl-disclosure/ack scope: trade:write (ack before open)
 *   GET    /api/v1/futures/adl-events         scope: trade:read  (disclosure-before-action; ?limit= 1..500)
 *   POST   /api/v1/positions       scope: trade:write (open funded position — F3)
 *   DELETE /api/v1/positions/:id   scope: trade:write (close + release margin — F3)
 *
 * Auth is the mount boundary: edge terminates the bearer (JWT or API key) and
 * forwards a signed principal on every `/api/*` hop. This service never parses
 * the caller's token — it verifies the edge signature via `createEdgeContext`,
 * exactly like the tRPC mount. A self-asserted principal header is anonymous.
 *
 * Money path: create/cancel/cancelAll call TradeService only — no second hold
 * path, no balances outside the ledger. Balance is a read of ledger.balances
 * for principal.userId only (Doctrine §0.6 projection, not a second store).
 */

const MAX_HISTORY = 500;
const MAX_FILLS = 500;

/** Blank / missing / non-integer / out of 1..max refuses. Never invent 100. */
export const TRADE_ADMIN_ORDERS_LIMIT_UNSET = 'trade.admin_orders_limit_unset' as const;
export const TRADE_ORDERS_CLOSED_LIMIT_UNSET = 'trade.orders_closed_limit_unset' as const;
export const TRADE_ORDERS_OPEN_LIMIT_UNSET = 'trade.orders_open_limit_unset' as const;
export const TRADE_ACCOUNT_TRADES_LIMIT_UNSET = 'trade.account_trades_limit_unset' as const;
export const TRADE_POSITIONS_CLOSED_LIMIT_UNSET = 'trade.positions_closed_limit_unset' as const;
export const TRADE_ADL_EVENTS_LIMIT_UNSET = 'trade.adl_events_limit_unset' as const;
/** Batch size is deliberately finite: each item owns its own retry fence and money path. */
export const MAX_BATCH_ORDERS = 100;

/** Spot-supported order types only (TradeService rejects stop/take-profit). */
function isSpotOrderType(type: string): type is 'market' | 'limit' {
  return type === 'market' || type === 'limit';
}

export interface PrivateRestDeps {
  /** Shared EDGE_PRINCIPAL_SECRET — same value tRPC uses. */
  edgeSecret: string;
  serviceName: string;
  convertExport?(principal: Principal, query: { from?: string; to?: string }): Promise<string>;
  openOrders(principal: Principal, marketId: string | undefined, limit: number): Promise<OrderRecord[]>;
  /** Operator projection. Unset mounts a typed refuse, never a fallback book. Limit required — never invent 100. */
  adminOpenOrders?(principal: Principal, limit: number): Promise<OrderRecord[]>;
  orderHistory(principal: Principal, input: { marketId?: string; limit: number; sinceMs?: number }): Promise<OrderRecord[]>;
  getOrder(principal: Principal, orderId: string): Promise<OrderRecord>;
  placeOrder(principal: Principal, input: PlaceOrderInput): Promise<OrderRecord>;
  cancelOrder(principal: Principal, orderId: string): Promise<OrderRecord>;
  /** Two-step cancel → finalized release → replacement submit saga. Never native amend. */
  replaceOrder?(principal: Principal, orderId: string, input: PlaceOrderInput): Promise<ReplaceOrderOutcome>;
  /** Native matching PATCH. Qty-down same price only. */
  amendOrder?(principal: Principal, orderId: string, input: AmendOrderInput): Promise<AmendOrderOutcome>;
  /** Cancel every open/pending order (optional market). Sequential money path. */
  cancelAllOrders(principal: Principal, marketId?: string): Promise<OrderRecord[]>;
  /** Matching mass-cancel for the authenticated account on one market. */
  massCancelOrders(principal: Principal, marketId: string): Promise<OrderRecord[]>;
  /**
   * Optional marketId filters fills in SQL (WHERE market_id = …).
   * Optional sinceMs (unix ms) filters fills.ts >= since in SQL.
   */
  myFills(principal: Principal, limit: number, marketId?: string, sinceMs?: number): Promise<FillRecord[]>;
  marketBySymbol(symbol: string): Promise<Market | null>;
  /** Resolve symbol for an order's marketId (wire needs the unified form). */
  marketById(marketId: string): Promise<Market | null>;
  /**
   * Listed markets page — symbols for `GET /account/fees`. Rates come from
   * `feeSchedule`, not from each row's maker_bps/taker_bps. Empty list → `{}`.
   * Limit required — never invent 50.
   */
  markets(limit: number): Promise<Market[]>;
  /**
   * Owner `TRADE_FEE_SCHEDULE`. Unpublished → `trade.fee_schedule_blank`.
   * Listing-row bps are not a second schedule.
   */
  feeSchedule?: OwnerFeeSchedule;
  /** Clock for `serverTime` on private reads. Default `new Date()`. */
  now?: () => Date;
  /** Authenticated PX-S01 projection; missing publisher remains typed refusal. */
  lifecycleForMarket?(market: Market): MarketStateSnapshot | null | Promise<MarketStateSnapshot | null>;
  /**
   * Ledger balances for one user. Route MUST pass only `principal.userId` —
   * never a client-supplied ownerId. S2S ledger client has no per-user gate;
   * self-only is enforced here at the edge of this surface.
   */
  userBalances(userId: string): Promise<readonly Balance[]>;
  /** Open futures positions for the principal (empty [] when none). Optional clientOpenId is the caller's own key. */
  listPositions(principal: Principal, symbol?: string, clientOpenId?: string): Promise<Position[]>;
  /** Closed/liquidated rows for the principal (empty [] when none). */
  listClosedPositions(principal: Principal, input: { symbol?: string; limit: number; sinceMs?: number }): Promise<Position[]>;
  /** One owned futures row. Missing / not theirs → 404, never another user's row. */
  getPosition(principal: Principal, positionId: string): Promise<Position>;
  /**
   * Open a futures position. NO PRICE PARAMETER, on purpose — the entry price is
   * read from the mark port inside the service. See `PRICE_FIELDS` below.
   */
  openPosition(
    principal: Principal,
    input: {
      symbol: string;
      side: 'long' | 'short';
      size: string;
      leverage: string;
      /**
       * `'isolated'` is the only inhabitant, deliberately — see
       * `crossMarginRefusal`. Named cash/cross/portfolio refuse; they are not
       * a disabled flag.
       */
      marginMode?: 'isolated';
      /** Posted IM class. Omitted → cash. Yield/staked/lending-idle refuse. */
      collateralClass?: string;
      /** Required retry key — same as spot clientOrderId; see positionIdFor. */
      clientOpenId: string;
      reduceOnly?: boolean;
      positionMode?: 'one_way' | 'hedge';
    },
  ): Promise<Position>;
  /** Close at the current mark. No price parameter, for the same reason. */
  closePosition(principal: Principal, positionId: string): Promise<Position>;
  /** Partial close. Quantity equal to the size is a full close. */
  closePositionQuantity?(principal: Principal, positionId: string, input: { quantity: string; clientCloseId: string }): Promise<Position>;
  closeAllPositions?(
    principal: Principal,
    input: { clientBatchId: string; market?: string },
  ): Promise<{ results: readonly { positionId: string; status: 'closed' | 'refused'; code?: string; reason?: string }[] }>;
  marginSummary?(principal: Principal): Promise<unknown>;
  readAccountMode?(principal: Principal): Promise<{ mode: 'one_way' | 'hedge' | null; source: string; code?: string }>;
  writeAccountMode?(
    principal: Principal,
    input: { mode: unknown; clientModeId: string },
  ): Promise<{ mode: 'one_way' | 'hedge' | null; source: string; code?: string }>;
  /**
   * Isolated live re-leverage within the explicit owner/listing cap. Extra IM
   * via ledger recipes; missing position 404; over-cap / would-be liquidation / insufficient
   * margin refuse without writing.
   */
  setLeverage(
    principal: Principal,
    input: { symbol: string; leverage: string; positionId?: string; clientAdjustmentId: string },
  ): Promise<Position>;
  /**
   * Isolated extra collateral via futuresMarginAdd. Does not change leverage or
   * margin mode. Amount is a decimal string; JSON numbers refused.
   */
  addIsolatedMargin(
    principal: Principal,
    input: { symbol: string; amount: string; positionId?: string; clientAdjustmentId: string; collateralClass?: string },
  ): Promise<Position>;
  /**
   * Isolated excess collateral out via futuresMarginRelease. Cannot pull below
   * IM. Would-be liquidation at the current mark refuses without writing.
   */
  reduceIsolatedMargin(
    principal: Principal,
    input: { symbol: string; amount: string; positionId?: string; clientAdjustmentId: string },
  ): Promise<Position>;
  /**
   * Open delivered margin call for a position owned by the principal.
   * Null → 404 (no call, or not theirs). Never invents a call.
   */
  getOpenMarginCall(principal: Principal, positionId: string): Promise<MarginCallWire | null>;
  /**
   * DIRECTION:34 — current ADL disclosure copy + whether this principal has ack'd.
   */
  getAdlDisclosure(principal: Principal): Promise<AdlDisclosureWire>;
  /** Record ack for the current disclosure version (required before open). */
  ackAdlDisclosure(principal: Principal): Promise<AdlDisclosureWire>;
  /**
   * Observable ADL disclosure-before-action events for this principal
   * (candidate side). Empty [] when none — never invents events.
   */
  listAdlDisclosureEvents(principal: Principal, limit: number): Promise<AdlActionDisclosureWire[]>;
}

/**
 * FIELDS A CALLER MAY NOT SET, BECAUSE THEY MOVE MONEY.
 *
 * `docs/adr/2026-08-05-futures-risk-and-mark-law.md`: a price that moves money
 * is never supplied by the party it pays. These used to be read straight off the
 * request — `entryPrice` from the POST body, `exitPrice` from the DELETE query —
 * and `exitPrice` alone decided the realised PnL that `futuresRealizeProfit`
 * then paid out of a house pot.
 *
 * Presence is REFUSED, not ignored. Silently substituting the real mark would
 * give a caller different behaviour from the one they asked for and no way to
 * notice: a bot closing at its own favourable number would keep sending it,
 * keep getting 200s, and keep booking a PnL it never actually chose. The ADR's
 * refuse table puts this in its first row for exactly that reason.
 */
const PRICE_FIELDS = ['entryPrice', 'exitPrice', 'price', 'markPrice'] as const;

/**
 * The positions list deliberately does not perform a fresh valuation. Make
 * that provenance explicit on the wire: a null mark is accompanied by a null
 * source, never by an implied local last or house quote. Decimal strings pass
 * through byte-for-byte.
 */
export function presentOpenPositions(rows: readonly Position[]): Array<Position & { markSource: null }> {
  return rows.map((row) => ({ ...row, markSource: null }));
}

/** Which forbidden price fields a request carries. Empty when it carries none. */
export function suppliedPriceFields(source: Record<string, unknown> | null | undefined): string[] {
  if (source == null) return [];
  return PRICE_FIELDS.filter((f) => source[f] !== undefined);
}

/** One refusal shape, so both routes say it identically. */
export function priceNotAcceptedBody(fields: readonly string[]): { error: string; message: string } {
  return {
    error: 'trade.price_not_accepted',
    message:
      `${fields.join(', ')} may not be supplied by the caller — a price that moves money is read from the mark source, ` +
      'not from the request. Resend without it and the current mark is used.',
  };
}

/**
 * CROSS / NAMED MODES ARE REFUSED, NOT COERCED.
 *
 * Isolated-only law stays. PTX-M08-R10 names cash/cross/portfolio so they
 * refuse as products, not as `trade.bad_request` typos. Law: `margin-mode.ts`.
 *
 * Returns the refusal body, or null when the value is acceptable.
 */
export function crossMarginRefusal(value: unknown): { error: string; message: string } | null {
  const check = checkMarginModeForFuturesOpen(value);
  if (check.ok) return null;
  return { error: check.code, message: check.reason };
}

/** Kinds that count as locked / not free under exchange-contract free/used/total. */
const USED_KINDS: ReadonlySet<AccountKind> = new Set(['hold', 'escrow', 'stake', 'collateral']);

/**
 * Project ledger Balance[] into CCXT `balancesSchema`:
 *   free  → `available`
 *   used  → hold + escrow + stake + collateral (all purposes summed per asset)
 *   total → free + used
 *
 * Empty ledger rows → honest empty `balances: {}`. No fabricated zero assets.
 * Unknown future kinds are ignored rather than guessed into free/used.
 */
export function presentCcxtBalances(
  rows: readonly Balance[],
  now: Date = new Date(),
): {
  timestamp: number;
  datetime: string;
  balances: Record<string, { free: string; used: string; total: string }>;
} {
  const freeBy = new Map<string, bigint>();
  const usedBy = new Map<string, bigint>();

  for (const row of rows) {
    const asset = row.account.assetId;
    const kind = row.account.kind;
    if (kind === 'available') {
      freeBy.set(asset, (freeBy.get(asset) ?? 0n) + row.amount);
    } else if (USED_KINDS.has(kind)) {
      usedBy.set(asset, (usedBy.get(asset) ?? 0n) + row.amount);
    }
  }

  const assets = [...new Set([...freeBy.keys(), ...usedBy.keys()])].sort();
  const balances: Record<string, { free: string; used: string; total: string }> = {};
  for (const asset of assets) {
    const free = freeBy.get(asset) ?? 0n;
    const used = usedBy.get(asset) ?? 0n;
    balances[asset] = {
      free: formatAmount(free),
      used: formatAmount(used),
      total: formatAmount(free + used),
    };
  }

  const timestamp = now.getTime();
  return {
    timestamp,
    datetime: now.toISOString(),
    balances,
  };
}

/** Map internal order status → CCXT `orderSchema.status`. */
export function toCcxtOrderStatus(status: OrderStatus): 'open' | 'closed' | 'canceled' | 'expired' | 'rejected' {
  switch (status) {
    case 'pending':
    case 'open':
      return 'open';
    case 'recovery_required':
      // CCXT has no unresolved state. The additive executionOutcome below is
      // authoritative and prevents clients from treating this as ordinary
      // OPEN; retaining the vocabulary keeps older adapters parseable.
      return 'open';
    case 'hold_unknown':
      // Same constraint: no CCXT slot for "hold reply lost". Not canceled
      // and not rejected — the order row is still hold_unknown.
      return 'open';
    case 'filled':
      return 'closed';
    case 'cancelled':
      return 'canceled';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
  }
}

/**
 * Quote notional for a CCXT order wire.
 *
 * Priority:
 *   1. Σ fill.quoteAmount when fills are loaded (true cost — audit ideal).
 *   2. limit price × filled, or market-buy protectionPrice × filled (R6).
 *   3. unfilled → `"0"` (nothing moved).
 *   4. filled but no basis and no fills → `null` (honest unknown).
 *
 * A sell's protectionPrice is the slippage floor, not the proceeds. Without a
 * limit price and without loaded fills the cost is unknown — return null.
 * Never invent a confident "0", and never price the sell at the floor.
 */
export function presentCcxtOrderCost(order: OrderRecord, fills?: readonly Pick<FillRecord, 'quoteAmount'>[]): string | null {
  if (order.filledQty === 0n) return '0';
  if (fills !== undefined) {
    let total: Amount = ZERO;
    for (const f of fills) total = add(total, f.quoteAmount);
    return formatAmount(total);
  }
  const costBasis = order.price ?? (order.side === 'buy' ? order.protectionPrice : null);
  if (costBasis === null) return null;
  return formatAmount(mul(costBasis, order.filledQty));
}

/**
 * CCXT `Order` shape (decimal strings). Fees/trades omitted on list/get unless
 * the fill set is loaded elsewhere — bots re-fetch fills via account/trades.
 * Pass `fills` when loaded so `cost` is Σ quote (true notional), not null.
 */
export function presentCcxtOrder(order: OrderRecord, symbol: string, opts?: { fills?: readonly Pick<FillRecord, 'quoteAmount'>[] }) {
  const ts = order.createdAt.getTime();
  const amount = formatAmount(order.qty);
  const filled = formatAmount(order.filledQty);
  const remaining = formatAmount(order.qty - order.filledQty);
  const price = order.price === null ? null : formatAmount(order.price);
  const cost = presentCcxtOrderCost(order, opts?.fills);

  return {
    id: order.id,
    // The reserved database key is an implementation detail. Clients receive
    // the caller's replacement key back, so retries remain understandable.
    clientOrderId:
      order.replacementOf !== null && order.clientOrderId?.startsWith('replace:')
        ? order.clientOrderId.slice('replace:'.length)
        : order.clientOrderId,
    timestamp: ts,
    datetime: new Date(ts).toISOString(),
    lastTradeTimestamp: null as number | null,
    symbol,
    type: order.type,
    side: order.side,
    timeInForce: order.tif,
    postOnly: order.tif === 'PO',
    reduceOnly: false,
    price,
    stopPrice: null as string | null,
    average: null as string | null,
    amount,
    filled,
    remaining,
    cost,
    status: toCcxtOrderStatus(order.status),
    rejectCode: order.rejectCode,
    /** Additive frozen-spine evidence; unresolved is never flattened to open/rejected. */
    recoveryReason: order.recoveryReason,
    reconciliationKey: order.reconciliationKey,
    executionOutcome:
      order.recoveryReason && order.reconciliationKey
        ? {
            outcome: 'OUTCOME_UNKNOWN' as const,
            state: order.recoveryReason === 'SUBMIT_UNKNOWN' ? ('SUBMIT_UNKNOWN' as const) : ('RECONCILING' as const),
            reasonCode: order.recoveryReason,
            reconciliationKey: order.reconciliationKey,
          }
        : null,
    recoveryRequired: order.status === 'recovery_required' || order.status === 'hold_unknown',
    holdUnknown: order.status === 'hold_unknown',
    lifecycleState: order.status === 'recovery_required' ? ('RECOVERY_REQUIRED' as const) : null,
    fee: null as { cost: string; currency: string } | null,
    trades: [] as [],
  };
}

/** Integer bps → decimal rate string for tradeSchema.fee.rate (10 bps → "0.001"). */
export function bpsToFeeRate(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) return '0';
  const whole = Math.floor(bps / 10_000);
  const frac = bps % 10_000;
  if (frac === 0) return String(whole);
  return `${whole}.${String(frac).padStart(4, '0')}`.replace(/0+$/, '');
}

/**
 * CCXT `TradingFee` from a market's published maker/taker bps.
 * `percentage: true` — maker/taker are rate fractions (10 bps → "0.001").
 * Rank/IFC effective rates are not applied here; bots re-read after fills.
 */
export function presentCcxtTradingFee(market: Market) {
  return {
    symbol: market.symbol,
    maker: bpsToFeeRate(market.makerBps),
    taker: bpsToFeeRate(market.takerBps),
    percentage: true as const,
  };
}

/**
 * Customer fee card. Maker/taker are the owner schedule, once per symbol.
 * Listing-row bps are not copied onto this wire.
 */
export function presentAccountFees(
  markets: readonly Market[],
  schedule: Extract<OwnerFeeSchedule, { published: true }>,
): Record<string, ReturnType<typeof presentCcxtTradingFee> & { makerBps: number; takerBps: number; version: string }> {
  const maker = bpsToFeeRate(schedule.makerBps);
  const taker = bpsToFeeRate(schedule.takerBps);
  const out: Record<string, ReturnType<typeof presentCcxtTradingFee> & { makerBps: number; takerBps: number; version: string }> = {};
  for (const market of markets) {
    out[market.symbol] = {
      symbol: market.symbol,
      maker,
      taker,
      percentage: true,
      makerBps: schedule.makerBps,
      takerBps: schedule.takerBps,
      version: schedule.version,
    };
  }
  return out;
}

/** Where the operator fee read gets its numbers. Listing-row bps are not charged and never appear on this wire. */
export const ADMIN_FEE_SOURCE = 'TRADE_FEE_SCHEDULE' as const;

export interface AdminMarketFee {
  readonly symbol: string;
  readonly kind: Market['kind'];
  /** Which published block the fill path reads for this market kind. Options have none. */
  readonly product: 'spot' | 'perpetual' | null;
  /** Rates before any per-customer rank discount, as decimal strings. Null with a `refusal` when the block is unpublished. */
  readonly charged: {
    readonly makerBps: string;
    readonly takerBps: string;
    readonly makerRate: string;
    readonly takerRate: string;
  } | null;
  readonly refusal: 'trade.fee_product_unpublished' | null;
}

/**
 * Operator view of the fees customers are charged: the owner `TRADE_FEE_SCHEDULE`, resolved per market kind the way the
 * fill path does (spot → top-level rates, futures → `perpetual` block, options → unpublished). Bps and rates are decimal
 * strings. Rank discounts are per customer and are not applied here.
 */
export function presentAdminFees(markets: readonly Market[], schedule: Extract<OwnerFeeSchedule, { published: true }>) {
  const rows: AdminMarketFee[] = markets.map((market) => {
    const product = market.kind === 'spot' ? 'spot' : market.kind === 'futures' ? 'perpetual' : null;
    const rates = product ? publishedProductBps(schedule, product) : null;
    return {
      symbol: market.symbol,
      kind: market.kind,
      product,
      charged: rates
        ? {
            makerBps: String(rates.makerBps),
            takerBps: String(rates.takerBps),
            makerRate: bpsToFeeRate(rates.makerBps),
            takerRate: bpsToFeeRate(rates.takerBps),
          }
        : null,
      refusal: rates ? null : ('trade.fee_product_unpublished' as const),
    };
  });
  return { source: ADMIN_FEE_SOURCE, version: schedule.version, markets: rows };
}

/**
 * CCXT private trade (my fill) — decimal strings; fee.rate from bps.
 * `order` is the caller's order id (not the counter).
 */
export function presentCcxtMyTrade(fill: FillRecord, symbol: string) {
  const ts = fill.ts.getTime();
  return {
    id: fill.id,
    order: fill.orderId,
    timestamp: ts,
    datetime: new Date(ts).toISOString(),
    symbol,
    type: null as string | null,
    side: fill.side,
    takerOrMaker: fill.liquidity,
    price: formatAmount(fill.price),
    amount: formatAmount(fill.qty),
    cost: formatAmount(fill.quoteAmount),
    fee: {
      cost: formatAmount(fill.feeAmount),
      currency: fill.feeAsset,
      rate: bpsToFeeRate(fill.feeBps),
    },
  };
}

/**
 * Owner/query-published history window. Missing / blank / non-integer / out of
 * 1..max is unpublished — never invent 100, never clamp a too-large window.
 */
export function parsePrivateRestLimit(raw: unknown, max: number): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > max) return undefined;
  return n;
}

/**
 * Optional CCXT `since` (unix ms). Absent/empty → no filter.
 * NaN or negative → invalid (caller returns 400). Zero is valid (epoch).
 */
export function parseSince(raw: unknown): { ok: true; sinceMs?: number } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, sinceMs: undefined };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, message: 'since must be a non-negative unix timestamp in milliseconds' };
  }
  return { ok: true, sinceMs: Math.floor(n) };
}

/**
 * Map CCXT create body → PlaceOrderInput (decimal strings → Amount).
 * Only market/limit; postOnly becomes tif PO when no other tif is set.
 */
export function mapCreateOrderBody(body: CreateOrderRequest): PlaceOrderInput {
  if (!isSpotOrderType(body.type)) {
    throw new TradeError(
      `order type "${body.type}" is not supported on this venue (spot supports market and limit)`,
      'trade.order_type_unsupported',
    );
  }
  if (body.reduceOnly === true) {
    throw new TradeError('reduceOnly is not supported on spot', 'trade.order_type_unsupported');
  }
  if (body.timeInForce === 'MOC') {
    throw new TradeError('maker-or-cancel is not yet accepted by the trade service', 'trade.invalid_tif');
  }

  let tif = body.timeInForce;
  if (body.postOnly === true) {
    if (tif && tif !== 'GTC' && tif !== 'PO') {
      throw new TradeError('postOnly cannot be combined with an immediate time-in-force', 'trade.invalid_price');
    }
    tif = 'PO';
  }

  return {
    symbol: body.symbol,
    side: body.side,
    type: body.type,
    qty: parseAmount(body.amount),
    price: body.price === undefined ? null : parseAmount(body.price),
    tif,
    clientOrderId: body.clientOrderId,
    subAccountId: body.subAccountId,
  };
}

export type AmendBodyParse = { ok: true; input: AmendOrderInput } | { ok: false; message: string };

/**
 * Map PATCH / batch-amend item body → AmendOrderInput (decimal strings → Amount).
 * Same honesty as native PATCH: qty is required; price/side/type/TIF/market are
 * passed through so TradeService can name CANCEL_REPLACE instead of silent replace.
 */
export function parseAmendOrderBody(body: unknown): AmendBodyParse {
  const rec = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!rec) return { ok: false, message: 'qty must be a positive decimal string' };

  const qtyRaw = rec.qty ?? rec.amount;
  if (typeof qtyRaw !== 'string') {
    return { ok: false, message: 'qty must be a positive decimal string' };
  }
  let qty: Amount;
  try {
    qty = parseAmount(qtyRaw);
  } catch {
    return { ok: false, message: 'qty must be a positive decimal string' };
  }
  if (qty <= ZERO) {
    return { ok: false, message: 'qty must be a positive decimal string' };
  }

  let price: Amount | undefined;
  if (typeof rec.price === 'string') {
    try {
      price = parseAmount(rec.price);
    } catch {
      return { ok: false, message: 'price must be a positive decimal string' };
    }
  }

  let expectedRemaining: Amount | undefined;
  if (rec.expectedRemaining !== undefined) {
    if (typeof rec.expectedRemaining !== 'string') {
      return { ok: false, message: 'expectedRemaining must be a decimal string' };
    }
    try {
      expectedRemaining = parseAmount(rec.expectedRemaining);
    } catch {
      return { ok: false, message: 'expectedRemaining must be a decimal string' };
    }
  }

  let expectedVersion: number | undefined;
  if (rec.expectedVersion !== undefined) {
    if (typeof rec.expectedVersion !== 'number' || !Number.isInteger(rec.expectedVersion) || rec.expectedVersion < 0) {
      return { ok: false, message: 'expectedVersion must be a non-negative integer' };
    }
    expectedVersion = rec.expectedVersion;
  }

  const tifRaw = rec.timeInForce;
  return {
    ok: true,
    input: {
      qty,
      ...(typeof rec.side === 'string' && (rec.side === 'buy' || rec.side === 'sell') ? { side: rec.side } : {}),
      ...(typeof rec.type === 'string' ? { type: rec.type } : {}),
      ...(tifRaw === 'GTC' || tifRaw === 'IOC' || tifRaw === 'FOK' || tifRaw === 'PO' ? { tif: tifRaw } : {}),
      ...(typeof rec.symbol === 'string' ? { symbol: rec.symbol } : {}),
      ...(typeof rec.marketId === 'string' ? { marketId: rec.marketId } : {}),
      ...(price !== undefined ? { price } : {}),
      ...(expectedRemaining !== undefined ? { expectedRemaining } : {}),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    },
  };
}

function batchAmendItemStatus(outcome: AmendOrderOutcome): 'APPLIED' | 'REFUSED' | 'OUTCOME_UNKNOWN' {
  if (outcome.reconciliationRequired || outcome.code === 'AMEND_UNKNOWN') return 'OUTCOME_UNKNOWN';
  if (outcome.accepted) return 'APPLIED';
  return 'REFUSED';
}

function batchAmendUnknownItem(base: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    status: 'OUTCOME_UNKNOWN',
    error: {
      code: 'ExchangeError',
      message: 'batch amend item outcome is unknown; holds are kept; reconcile by orderId',
      intafacedCode: 'trade.batch_amend_outcome_unknown',
    },
  };
}

async function symbolForOrder(
  order: OrderRecord,
  cache: Map<string, string>,
  marketById: (id: string) => Promise<Market | null>,
): Promise<string> {
  let symbol = cache.get(order.marketId);
  if (symbol === undefined) {
    const market = await marketById(order.marketId);
    symbol = market?.symbol ?? order.marketId;
    cache.set(order.marketId, symbol);
  }
  return symbol;
}

/** Send an already-mapped CCXT error. */
function sendCcxt(reply: FastifyReply, res: CcxtErrorResponse): FastifyReply {
  return reply.code(res.status).send(res.body);
}

/** Unix ms for this private read. Header `x-server-time` is the same number. */
function stampServerTime(reply: FastifyReply, deps: PrivateRestDeps): number {
  const serverTime = (deps.now ?? (() => new Date()))().getTime();
  reply.header('x-server-time', String(serverTime));
  return serverTime;
}

function presentAmendOutcome(outcome: AmendOrderOutcome, symbol: string) {
  return {
    accepted: outcome.accepted,
    idempotent: outcome.idempotent,
    code: outcome.code,
    reasonCode: outcome.reasonCode,
    reconciliationRequired: outcome.reconciliationRequired,
    path: outcome.path,
    priority: outcome.priority,
    orderId: outcome.order.id,
    order: presentCcxtOrder(outcome.order, symbol),
  };
}

function presentReplaceOutcome(outcome: ReplaceOrderOutcome, originalSymbol: string, replacementSymbol: string) {
  const original = presentCcxtOrder(outcome.original, originalSymbol);
  const replacement = outcome.replacement === null ? null : presentCcxtOrder(outcome.replacement, replacementSymbol);
  return {
    accepted: outcome.accepted,
    idempotent: outcome.idempotent,
    code: outcome.code,
    reasonCode: outcome.reasonCode,
    reconciliationRequired: outcome.reconciliationRequired,
    path: 'CANCEL_REPLACE' as const,
    originalOrderId: outcome.original.id,
    originalState: outcome.original.status,
    replacementOrderId: outcome.replacement?.id ?? null,
    replacementState: outcome.replacement?.status ?? null,
    original,
    replacement,
  };
}

/**
 * Domain → CCXT wire error for private REST.
 *
 * This used to publish our own internal codes (`trade.below_min_notional`,
 * `LedgerError`, `Unauthorized`) straight onto a surface whose entire purpose
 * is that an off-the-shelf CCXT client can read it. A client branches on the
 * error *class* to decide whether to retry, so an unrecognised code left it
 * with only the HTTP status — and the statuses alone cannot tell
 * `InsufficientFunds` (never retry) from `perks_unavailable` (retry) since both
 * arrived as 400/500 with an opaque label.
 *
 * The whole mapping, and the reasoning for each arm, is in `ccxt-errors.ts`.
 * `intafacedCode` still carries our finer-grained code for support and logs.
 *
 * Returns null when the error is not one we recognise, so the caller rethrows
 * and it surfaces as a real 500 rather than a relabelled retry instruction.
 */
function sendDomainError(reply: FastifyReply, err: unknown): FastifyReply | null {
  if (err instanceof OpenOrdersLimitUnsetError) {
    return sendCcxt(reply, badRequest(err.message, err.code));
  }
  const mapped = toCcxtError(err);
  if (!mapped) return null;
  return sendCcxt(reply, mapped);
}

/**
 * A replayed clientOrderId is safe only when the request is the same command.
 * TradeService owns the durable retry fence and returns the existing row; this
 * comparison makes a conflicting reuse an explicit item refusal without ever
 * opening another hold or submitting another engine command.
 */
function sameOrderRequest(input: PlaceOrderInput, order: OrderRecord, symbol: string): boolean {
  return (
    input.symbol === symbol &&
    input.side === order.side &&
    input.type === order.type &&
    input.qty === order.qty &&
    (input.price ?? null) === order.price &&
    (input.tif ?? 'GTC') === order.tif &&
    (input.subAccountId ?? null) === order.subAccountId &&
    input.clientOrderId === order.clientOrderId
  );
}

/**
 * Register private REST routes. Requires a real edge secret (≥32 chars) —
 * same boot bar as tRPC via `createEdgeContext`.
 */
export function registerPrivateRest(app: FastifyInstance, deps: PrivateRestDeps): void {
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, serviceName: deps.serviceName });

  function contextFrom(req: FastifyRequest): Context {
    const edgeReq: EdgeRequest = {
      headers: req.headers as Record<string, string | string[] | undefined>,
      id: req.id,
    };
    return edgeContext(edgeReq);
  }

  /** Fail closed: missing / forged / expired edge principal → 401. */
  function requirePrincipal(req: FastifyRequest, reply: FastifyReply): Principal | null {
    const principal = contextFrom(req).principal;
    if (!principal) {
      void sendCcxt(reply, UNAUTHENTICATED);
      return null;
    }
    return principal;
  }

  attachConvertExportRoute(app, deps.convertExport, requirePrincipal);

  /**
   * Jurisdiction gate for money writes — mirrors `scopedProcedure(..., { module: 'trade' })`.
   * Scope is still enforced inside TradeService; this refuses a region that may not trade.
   */
  function requireTradeJurisdiction(req: FastifyRequest, reply: FastifyReply, principal: Principal): boolean {
    const { region } = contextFrom(req);
    const decision = checkAccess({
      module: 'trade',
      plane: 'fiat',
      region,
      kycTier: principal.tier,
    });
    if (!decision.allowed) {
      // Credentials were fine; this principal may not trade from here. CCXT
      // `PermissionDenied` — a bot must stop, not re-sign and retry. The tier
      // requirement rides along so a client can tell the user what to do.
      void reply.code(403).send({
        ...permissionDenied(decision.reason, decision.code).body,
        ...(decision.requiredTier ? { requiredTier: decision.requiredTier } : {}),
      });
      return false;
    }
    return true;
  }

  // ── Static paths first (before :id) ───────────────────────────────────────

  app.get<{ Querystring: { limit?: string } }>('/api/v1/admin/orders/open', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    try {
      requireScope(principal, 'admin:read');
      const limit = parsePrivateRestLimit(req.query.limit, MAX_HISTORY);
      if (limit === undefined) {
        return sendCcxt(reply, badRequest('admin orders limit is unset — refuse to invent 100', TRADE_ADMIN_ORDERS_LIMIT_UNSET));
      }
      if (!deps.adminOpenOrders) {
        return reply.code(503).send({ error: 'admin order projection is not configured', code: 'trade.admin_orders_unconfigured' });
      }
      const orders = await deps.adminOpenOrders(principal, limit);
      const symbolByMarket = new Map<string, string>();
      const wire = [];
      for (const order of orders) {
        const symbol = await symbolForOrder(order, symbolByMarket, deps.marketById);
        wire.push({ ...presentCcxtOrder(order, symbol), userId: order.userId, seeded: order.seeded });
      }
      return reply.code(200).send(wire);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get('/api/v1/admin/fees', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    try {
      requireScope(principal, 'admin:read');
      const schedule = deps.feeSchedule;
      if (!schedule || schedule.published !== true) {
        return reply.code(503).send({
          code: 'ExchangeNotAvailable',
          message: FEE_SCHEDULE_RESIDUAL,
          intafacedCode: 'trade.fee_schedule_blank',
        });
      }
      return reply.code(200).send(presentAdminFees(await deps.markets(MARKETS_LIMIT_MAX), schedule));
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Querystring: { symbol?: string; limit?: string } }>('/api/v1/orders/open', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    let marketId: string | undefined;
    const symbolRaw = req.query.symbol;
    if (symbolRaw !== undefined && symbolRaw !== '') {
      const symbol = decodeURIComponent(symbolRaw);
      const market = await deps.marketBySymbol(symbol);
      if (!market) {
        return sendCcxt(reply, badSymbol(symbol));
      }
      marketId = market.id;
    }
    const limit = parsePrivateRestLimit(req.query.limit, MAX_HISTORY);
    if (limit === undefined) {
      return sendCcxt(reply, badRequest('orders/open limit is unset — refuse to invent 100', TRADE_ORDERS_OPEN_LIMIT_UNSET));
    }

    try {
      const orders = await deps.openOrders(principal, marketId, limit);
      const serverTime = stampServerTime(reply, deps);
      const symbolByMarket = new Map<string, string>();
      const wire = [];
      for (const order of orders) {
        const symbol = await symbolForOrder(order, symbolByMarket, deps.marketById);
        wire.push({ ...presentCcxtOrder(order, symbol), serverTime });
      }
      return reply.code(200).send(wire);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Querystring: { symbol?: string; limit?: string; since?: string } }>('/api/v1/orders/closed', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    let marketId: string | undefined;
    const symbolRaw = req.query.symbol;
    if (symbolRaw !== undefined && symbolRaw !== '') {
      const symbol = decodeURIComponent(symbolRaw);
      const market = await deps.marketBySymbol(symbol);
      if (!market) {
        return sendCcxt(reply, badSymbol(symbol));
      }
      marketId = market.id;
    }
    const limit = parsePrivateRestLimit(req.query.limit, MAX_HISTORY);
    if (limit === undefined) {
      return sendCcxt(reply, badRequest('orders/closed limit is unset — refuse to invent 100', TRADE_ORDERS_CLOSED_LIMIT_UNSET));
    }
    const sinceParsed = parseSince(req.query.since);
    if (!sinceParsed.ok) {
      return sendCcxt(reply, badRequest(sinceParsed.message, 'trade.invalid_since'));
    }

    try {
      // since → SQL on orders.created_at (timestamptz) via orderHistory.sinceMs.
      const orders = await deps.orderHistory(principal, {
        marketId,
        limit,
        sinceMs: sinceParsed.sinceMs,
      });
      const symbolByMarket = new Map<string, string>();
      const wire = [];
      for (const order of orders) {
        const symbol = await symbolForOrder(order, symbolByMarket, deps.marketById);
        wire.push(presentCcxtOrder(order, symbol));
      }
      return reply.code(200).send(wire);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Querystring: { symbol?: string; limit?: string; since?: string } }>('/api/v1/account/trades', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    const limit = parsePrivateRestLimit(req.query.limit, MAX_FILLS);
    if (limit === undefined) {
      return sendCcxt(reply, badRequest('account/trades limit is unset — refuse to invent 100', TRADE_ACCOUNT_TRADES_LIMIT_UNSET));
    }
    const sinceParsed = parseSince(req.query.since);
    if (!sinceParsed.ok) {
      return sendCcxt(reply, badRequest(sinceParsed.message, 'trade.invalid_since'));
    }
    let filterMarketId: string | undefined;
    const symbolRaw = req.query.symbol;
    if (symbolRaw !== undefined && symbolRaw !== '') {
      const symbol = decodeURIComponent(symbolRaw);
      const market = await deps.marketBySymbol(symbol);
      if (!market) {
        return sendCcxt(reply, badSymbol(symbol));
      }
      filterMarketId = market.id;
    }

    try {
      // Symbol + since resolve in SQL via myFills (fills.market_id, fills.ts),
      // not a post-filter of a user-wide page.
      const fills = await deps.myFills(principal, limit, filterMarketId, sinceParsed.sinceMs);
      const serverTime = stampServerTime(reply, deps);
      const symbolByMarket = new Map<string, string>();
      const wire = [];
      for (const fill of fills) {
        let symbol = symbolByMarket.get(fill.marketId);
        if (symbol === undefined) {
          const market = await deps.marketById(fill.marketId);
          symbol = market?.symbol ?? fill.marketId;
          symbolByMarket.set(fill.marketId, symbol);
        }
        wire.push({ ...presentCcxtMyTrade(fill, symbol), serverTime });
      }
      return reply.code(200).send(wire);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * Owner `TRADE_FEE_SCHEDULE` maker/taker, once per listed symbol. Same bps
   * order preview returns as `feeBps`. Listing-row maker_bps/taker_bps are not
   * this schedule. No rank personalisation. Empty listing → `{}`. Unpublished
   * schedule with symbols listed → `trade.fee_schedule_blank`.
   */
  app.get('/api/v1/account/fees', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    try {
      requireScope(principal, 'trade:read');
      const listed = await deps.markets(MARKETS_LIMIT_MAX);
      if (listed.length === 0) return reply.code(200).send({});
      const schedule = deps.feeSchedule;
      if (!schedule || schedule.published !== true) {
        return reply.code(503).send({
          code: 'ExchangeNotAvailable',
          message: 'published fee schedule is unavailable',
          intafacedCode: 'trade.fee_schedule_blank',
        });
      }
      return reply.code(200).send(presentAccountFees(listed, schedule));
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Params: { symbol: string } }>('/api/v1/account/market-lifecycle/:symbol', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    try {
      requireScope(principal, 'trade:read');
      const symbol = decodeURIComponent(req.params.symbol);
      const market = await deps.marketBySymbol(symbol);
      if (!market) return sendCcxt(reply, badSymbol(symbol));
      if (!deps.lifecycleForMarket) {
        return reply.code(503).send({
          error: 'market lifecycle authority is not configured',
          code: 'trade.lifecycle_authority_unavailable',
          state: 'REFUSED',
          recovery: { required: true, evidenceRefs: [] },
        });
      }
      const snapshot = await deps.lifecycleForMarket(market);
      if (!snapshot) {
        return reply.code(503).send({
          error: 'market lifecycle authority returned no evidence',
          code: 'trade.lifecycle_authority_unavailable',
          state: 'REFUSED',
          recovery: { required: true, evidenceRefs: [] },
        });
      }
      return reply.code(200).send(snapshot);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * Ledger projection for the authenticated user only.
   *
   * Owner is always `principal.userId` from the edge-signed principal — never a
   * query or body field. That is the same self-only rule as openOrders/myFills;
   * the S2S ledger client will answer for any ownerId, so the gate lives here.
   * Read-only: no recipe, no post, no second balance store (Doctrine §0.6).
   */
  app.get('/api/v1/account/balance', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    try {
      requireScope(principal, 'trade:read');
      const rows = await deps.userBalances(principal.userId);
      const serverTime = stampServerTime(reply, deps);
      return reply.code(200).send({ ...presentCcxtBalances(rows, new Date(serverTime)), serverTime });
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * Derivatives positions — REST_ROUTES.fetchPositions.
   *
   * Lists open and closing rows from trade.positions (F2/F3). Empty [] when none —
   * never invents leverage/mark. `closing` is a voluntary exit waiting on a mark
   * (ADR 2026-08-07) and must not look like a normal open. Optional ?symbol= filters.
   */
  app.get<{ Querystring: { symbol?: string; clientOpenId?: string } }>('/api/v1/positions', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    try {
      requireScope(principal, 'trade:read');
      const rows = await deps.listPositions(principal, req.query.symbol, req.query.clientOpenId);
      return reply.code(200).send(presentOpenPositions(rows));
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * Settled futures history. Mounted as `/closed` (not `:id`) so it cannot be
   * swallowed by GET /positions/:id. Empty [] when none — no invented mark.
   */
  app.get<{ Querystring: { symbol?: string; limit?: string; since?: string } }>('/api/v1/positions/closed', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    const limit = parsePrivateRestLimit(req.query.limit, MAX_HISTORY);
    if (limit === undefined) {
      return sendCcxt(reply, badRequest('positions/closed limit is unset — refuse to invent 100', TRADE_POSITIONS_CLOSED_LIMIT_UNSET));
    }
    const sinceParsed = parseSince(req.query.since);
    if (!sinceParsed.ok) {
      return sendCcxt(reply, badRequest(sinceParsed.message, 'trade.invalid_since'));
    }

    try {
      requireScope(principal, 'trade:read');
      const rows = await deps.listClosedPositions(principal, {
        symbol: req.query.symbol,
        limit,
        sinceMs: sinceParsed.sinceMs,
      });
      return reply.code(200).send(rows);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * Open a funded futures position (margin via ledger recipes).
   *
   * The entry price is NOT a parameter. It is read from the mark source, and a
   * body that carries one is refused before anything is locked.
   */
  app.post('/api/v1/positions', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    try {
      requireScope(principal, 'trade:write');
      const body = (req.body ?? {}) as Record<string, unknown>;

      // Refused first, before any other validation: a caller who sent a price
      // should hear about the price, not about a field they got right.
      const supplied = suppliedPriceFields(body);
      if (supplied.length > 0) {
        return reply.code(400).send(priceNotAcceptedBody(supplied));
      }

      const symbol = typeof body.symbol === 'string' ? body.symbol : '';
      const side = body.side === 'long' || body.side === 'short' ? body.side : null;
      const size = typeof body.size === 'string' ? body.size : typeof body.contracts === 'string' ? body.contracts : '';
      const leverageRaw = typeof body.leverage === 'string' ? body.leverage.trim() : '';
      if (!leverageRaw) {
        // Isolated entry does not default to 1×. DIRECTION §1 states a ceiling
        // (10×), not a silent substitute when the caller omitted the field.
        // A JSON number here is also refused — parseAmount is for a named string.
        return reply.code(400).send({
          ...badRequest('leverage is required on open — isolated entry does not default to 1x', 'trade.leverage_required').body,
        });
      }
      const leverage = leverageRaw;

      const marginRefusal = crossMarginRefusal(body.marginMode);
      if (marginRefusal) {
        return reply.code(400).send(marginRefusal);
      }
      const collateralClassRefusal = checkCollateralClassForMargin(body.collateralClass);
      if (!collateralClassRefusal.ok) {
        return reply.code(400).send({ error: collateralClassRefusal.code, message: collateralClassRefusal.reason });
      }
      const marginMode = body.marginMode === 'isolated' ? ('isolated' as const) : undefined;
      const collateralClass = typeof body.collateralClass === 'string' ? body.collateralClass : undefined;

      if (body.reduceOnly !== undefined && body.reduceOnly !== true && body.reduceOnly !== false) {
        return reply.code(400).send({
          ...badRequest('reduceOnly must be a boolean', 'trade.reduce_only_invalid').body,
        });
      }
      const reduceOnly = body.reduceOnly === true;
      let positionMode: 'one_way' | 'hedge' | undefined;
      if (body.positionMode === 'one_way' || body.positionMode === 'hedge') positionMode = body.positionMode;
      if (!positionMode && !reduceOnly && deps.readAccountMode) {
        const state = await deps.readAccountMode(principal);
        if (state.mode == null) {
          return reply.code(400).send({
            error: state.code ?? 'trade.position_mode_unset',
            message: 'position mode is unset',
            mode: null,
            source: state.source,
          });
        }
        positionMode = state.mode;
      }

      if (!symbol || !side || !size) {
        return reply.code(400).send({
          ...badRequest('symbol, side, size|contracts required', 'trade.bad_request').body,
        });
      }
      const clientOpenIdRaw =
        typeof body.clientOpenId === 'string' ? body.clientOpenId : typeof body.clientPositionId === 'string' ? body.clientPositionId : '';
      const clientOpenId = clientOpenIdRaw.trim();
      if (!clientOpenId || clientOpenId.length > 64) {
        return reply.code(400).send({
          ...badRequest('clientOpenId is required (1–64 chars) — omit would double-lock margin on retry', 'trade.client_open_id_required')
            .body,
        });
      }

      const pos = await deps.openPosition(principal, {
        symbol,
        side,
        size,
        leverage,
        marginMode,
        clientOpenId,
        ...(reduceOnly ? { reduceOnly: true } : {}),
        ...(positionMode !== undefined ? { positionMode } : {}),
        ...(collateralClass !== undefined ? { collateralClass } : {}),
      });
      return reply.code(200).send(pos);
    } catch (err) {
      if (err instanceof AdlDisclosureError) {
        return reply.code(err.status).send({ error: err.code, message: err.message });
      }
      if (err instanceof FuturesError) {
        return reply.code(err.status).send(presentFuturesErrorWire(err));
      }
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * DIRECTION:34 — in-product ADL disclosure (copy + ack state).
   * Open is refused until POST …/ack for the current version.
   */
  app.get('/api/v1/futures/adl-disclosure', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    try {
      requireScope(principal, 'trade:read');
      const wire = await deps.getAdlDisclosure(principal);
      return reply.code(200).send(wire);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.post('/api/v1/futures/adl-disclosure/ack', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    try {
      requireScope(principal, 'trade:write');
      const wire = await deps.ackAdlDisclosure(principal);
      return reply.code(200).send(wire);
    } catch (err) {
      if (err instanceof AdlDisclosureError) {
        return reply.code(err.status).send({ error: err.code, message: err.message });
      }
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/api/v1/futures/adl-events', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    const limit = parsePrivateRestLimit(req.query.limit, MAX_HISTORY);
    if (limit === undefined) {
      return sendCcxt(reply, badRequest('adl-events limit is unset — refuse to invent 500', TRADE_ADL_EVENTS_LIMIT_UNSET));
    }

    try {
      requireScope(principal, 'trade:read');
      const rows = await deps.listAdlDisclosureEvents(principal, limit);
      return reply.code(200).send(rows);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * Delivered margin call for one position (D26-P1-T1b / DIRECTION MVP-2).
   *
   * The liquidation tick raises + delivers into the durable store; this door
   * is how the trader observes it. 404 when none is open (or not theirs) —
   * never a fabricated healthy "no call" body that could be confused with a
   * delivered warning. Undelivered attempts are not exposed here.
   */
  app.get<{ Params: { id: string } }>('/api/v1/positions/:id/margin-call', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    try {
      requireScope(principal, 'trade:read');
      const call = await deps.getOpenMarginCall(principal, req.params.id);
      if (!call) {
        return reply.code(404).send({
          error: 'trade.margin_call_not_found',
          message: 'No delivered margin call is open for this position.',
        });
      }
      return reply.code(200).send(call);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * One owned futures position. Closed is still a row — 404 only when missing
   * or not theirs (same answer, no leak). Not a valuation: no invented mark.
   * Registered after `/positions/:id/margin-call` so that door stays specific.
   */
  app.get<{ Params: { id: string } }>('/api/v1/positions/:id', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    try {
      requireScope(principal, 'trade:read');
      const pos = await deps.getPosition(principal, req.params.id);
      return reply.code(200).send(pos);
    } catch (err) {
      if (err instanceof FuturesError) {
        return reply.code(err.status).send(presentFuturesErrorWire(err));
      }
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * Close a position at the CURRENT MARK.
   *
   * `?exitPrice=` used to be required here and was the whole realised PnL — the
   * trader named the number the platform paid them. It is now refused.
   */
  app.delete<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>('/api/v1/positions/:id', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    try {
      requireScope(principal, 'trade:write');

      const supplied = suppliedPriceFields(req.query as Record<string, unknown> | undefined);
      if (supplied.length > 0) {
        return reply.code(400).send(priceNotAcceptedBody(supplied));
      }

      const pos = await deps.closePosition(principal, req.params.id);
      return reply.code(200).send(pos);
    } catch (err) {
      if (err instanceof FuturesError) {
        return reply.code(err.status).send(presentFuturesErrorWire(err));
      }
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>('/api/v1/positions/:id/close', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;
    if (!deps.closePositionQuantity) {
      return reply.code(500).send({ error: 'trade.desk_door_unwired', message: 'partial close is not wired on this process' });
    }
    try {
      requireScope(principal, 'trade:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const supplied = suppliedPriceFields(body);
      if (supplied.length > 0) return reply.code(400).send(priceNotAcceptedBody(supplied));
      if (typeof body.quantity !== 'string' || typeof body.clientCloseId !== 'string') {
        return reply.code(400).send({
          ...badRequest('quantity and clientCloseId are required decimal/string fields', 'trade.client_close_id_required').body,
        });
      }
      const pos = await deps.closePositionQuantity(principal, req.params.id, {
        quantity: body.quantity,
        clientCloseId: body.clientCloseId,
      });
      return reply.code(200).send(pos);
    } catch (err) {
      if (err instanceof MoneyError) {
        return reply.code(400).send({ error: 'trade.close_quantity_invalid', message: err.message });
      }
      if (err instanceof FuturesError) return reply.code(err.status).send(presentFuturesErrorWire(err));
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.post('/api/v1/futures/positions/close-all', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;
    if (!deps.closeAllPositions) {
      return reply.code(500).send({ error: 'trade.desk_door_unwired', message: 'close-all is not wired on this process' });
    }
    try {
      requireScope(principal, 'trade:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.clientBatchId !== 'string') {
        return reply.code(400).send({
          ...badRequest('clientBatchId is required', 'trade.client_batch_id_required').body,
        });
      }
      const market = typeof body.market === 'string' ? body.market : undefined;
      const result = await deps.closeAllPositions(principal, { clientBatchId: body.clientBatchId, ...(market ? { market } : {}) });
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof FuturesError) return reply.code(err.status).send(presentFuturesErrorWire(err));
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get('/api/v1/futures/margin-summary', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.marginSummary) {
      return reply.code(500).send({ error: 'trade.desk_door_unwired', message: 'margin summary is not wired on this process' });
    }
    try {
      requireScope(principal, 'trade:read');
      return reply.code(200).send(await deps.marginSummary(principal));
    } catch (err) {
      if (err instanceof FuturesError) return reply.code(err.status).send(presentFuturesErrorWire(err));
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get('/api/v1/futures/position-mode', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.readAccountMode) {
      return reply.code(500).send({ error: 'trade.desk_door_unwired', message: 'position mode is not wired on this process' });
    }
    try {
      requireScope(principal, 'trade:read');
      return reply.code(200).send(await deps.readAccountMode(principal));
    } catch (err) {
      if (err instanceof FuturesError) return reply.code(err.status).send(presentFuturesErrorWire(err));
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.put('/api/v1/futures/position-mode', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;
    if (!deps.writeAccountMode) {
      return reply.code(500).send({ error: 'trade.desk_door_unwired', message: 'position mode is not wired on this process' });
    }
    try {
      requireScope(principal, 'trade:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.clientModeId !== 'string') {
        return reply.code(400).send({
          ...badRequest('clientModeId is required', 'trade.client_mode_id_required').body,
        });
      }
      const state = await deps.writeAccountMode(principal, { mode: body.mode, clientModeId: body.clientModeId });
      return reply.code(200).send(state);
    } catch (err) {
      if (err instanceof FuturesError) return reply.code(err.status).send(presentFuturesErrorWire(err));
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * POST leverage: isolated live re-leverage within the named cap (ledger delta).
   * POST margin-mode stays 501: isolated-at-open only — never a live mode flip.
   */
  const derivativesNotSupported = (what: string, intafacedCode: string) =>
    async function handler(req: FastifyRequest, reply: FastifyReply) {
      const principal = requirePrincipal(req, reply);
      if (!principal) return;

      try {
        requireScope(principal, 'trade:write');
      } catch (err) {
        const sent = sendDomainError(reply, err);
        if (sent) return sent;
        throw err;
      }

      return sendCcxt(reply, notSupported(`${what} is not available: set margin mode at open`, intafacedCode));
    };

  const setMarginModeArm = refuseArmById('setMarginMode');
  if (!setMarginModeArm || setMarginModeArm.httpStatus !== 501 || setMarginModeArm.ccxtCode !== 'NotSupported') {
    throw new Error('ccxt matrix setMarginMode must stay 501 NotSupported — isolated-at-open only');
  }

  const leverageHandler = (canonicalFuturesDoor: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    try {
      requireScope(principal, 'trade:write');

      const body = (req.body ?? {}) as Record<string, unknown>;
      const supplied = suppliedPriceFields(body);
      if (supplied.length > 0) {
        return reply.code(400).send(priceNotAcceptedBody(supplied));
      }

      const symbol = typeof body.symbol === 'string' ? body.symbol : '';
      const leverageRaw = typeof body.leverage === 'string' ? body.leverage.trim() : '';
      const marginMode = typeof body.marginMode === 'string' ? body.marginMode.trim() : '';
      if (marginMode) {
        const modeRefusal = checkMarginModeForFuturesOpen(marginMode);
        if (!modeRefusal.ok) {
          return reply.code(400).send({ error: modeRefusal.code, message: modeRefusal.reason });
        }
      }
      if (!leverageRaw) {
        return reply.code(400).send({
          ...badRequest('leverage is required — isolated re-leverage does not default', 'trade.leverage_required').body,
        });
      }
      try {
        parseAmount(leverageRaw);
      } catch (err) {
        const message = err instanceof MoneyError ? err.message : 'malformed leverage';
        return reply.code(400).send({
          ...badRequest(message, 'trade.leverage_invalid').body,
        });
      }
      if (!symbol) {
        return reply.code(400).send({
          ...badRequest('symbol is required', 'trade.bad_request').body,
        });
      }
      const positionIdRaw = typeof body.id === 'string' ? body.id : typeof body.positionId === 'string' ? body.positionId : '';
      const positionId = positionIdRaw.trim() || undefined;
      if (!positionId && !canonicalFuturesDoor) {
        return reply.code(400).send({
          ...badRequest('positionId is required for a retry-safe margin mutation', 'trade.position_id_required').body,
        });
      }
      const suppliedAdjustmentId = typeof body.clientAdjustmentId === 'string' ? body.clientAdjustmentId.trim() : '';
      if (!suppliedAdjustmentId && !canonicalFuturesDoor) {
        return reply.code(400).send({
          ...badRequest('clientAdjustmentId is required for retry-safe margin mutation', 'trade.idempotency_key_required').body,
        });
      }
      const clientAdjustmentId = suppliedAdjustmentId || `leverage:${leverageRaw}`;

      const pos = await deps.setLeverage(principal, { symbol, leverage: leverageRaw, positionId, clientAdjustmentId });
      return reply.code(200).send(pos);
    } catch (err) {
      if (err instanceof FuturesError) {
        return reply.code(err.status).send(presentFuturesErrorWire(err));
      }
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  };

  app.post('/api/v1/positions/leverage', async (req, reply) => leverageHandler(false)(req, reply));
  app.post('/api/v1/futures/leverage', leverageHandler(true));

  app.post('/api/v1/positions/margin', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    try {
      requireScope(principal, 'trade:write');

      const body = (req.body ?? {}) as Record<string, unknown>;
      const supplied = suppliedPriceFields(body);
      if (supplied.length > 0) {
        return reply.code(400).send(priceNotAcceptedBody(supplied));
      }

      const symbol = typeof body.symbol === 'string' ? body.symbol : '';
      if (!symbol) {
        return reply.code(400).send({
          ...badRequest('symbol is required', 'trade.bad_request').body,
        });
      }
      if (typeof body.amount !== 'string') {
        return reply.code(400).send({
          ...badRequest('amount is required as a decimal string — JSON numbers are not money', 'trade.bad_request').body,
        });
      }
      try {
        parseAmount(body.amount);
      } catch (err) {
        const message = err instanceof MoneyError ? err.message : 'malformed amount';
        return reply.code(400).send({
          ...badRequest(message, 'trade.bad_request').body,
        });
      }
      const positionIdRaw = typeof body.id === 'string' ? body.id : typeof body.positionId === 'string' ? body.positionId : '';
      const positionId = positionIdRaw.trim() || undefined;
      if (!positionId) {
        return reply.code(400).send({
          ...badRequest('positionId is required for a retry-safe margin mutation', 'trade.position_id_required').body,
        });
      }
      const clientAdjustmentId = typeof body.clientAdjustmentId === 'string' ? body.clientAdjustmentId.trim() : '';
      if (!clientAdjustmentId) {
        return reply.code(400).send({
          ...badRequest('clientAdjustmentId is required for retry-safe margin mutation', 'trade.idempotency_key_required').body,
        });
      }

      const collateralClassRefusal = checkCollateralClassForMargin(body.collateralClass);
      if (!collateralClassRefusal.ok) {
        return reply.code(400).send({ error: collateralClassRefusal.code, message: collateralClassRefusal.reason });
      }
      const collateralClass = typeof body.collateralClass === 'string' ? body.collateralClass : undefined;

      const pos = await deps.addIsolatedMargin(principal, {
        symbol,
        amount: body.amount,
        positionId,
        clientAdjustmentId,
        ...(collateralClass !== undefined ? { collateralClass } : {}),
      });
      return reply.code(200).send(pos);
    } catch (err) {
      if (err instanceof FuturesError) {
        return reply.code(err.status).send(presentFuturesErrorWire(err));
      }
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.post('/api/v1/positions/margin/reduce', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    try {
      requireScope(principal, 'trade:write');

      const body = (req.body ?? {}) as Record<string, unknown>;
      const supplied = suppliedPriceFields(body);
      if (supplied.length > 0) {
        return reply.code(400).send(priceNotAcceptedBody(supplied));
      }

      const symbol = typeof body.symbol === 'string' ? body.symbol : '';
      if (!symbol) {
        return reply.code(400).send({
          ...badRequest('symbol is required', 'trade.bad_request').body,
        });
      }
      if (typeof body.amount !== 'string') {
        return reply.code(400).send({
          ...badRequest('amount is required as a decimal string — JSON numbers are not money', 'trade.bad_request').body,
        });
      }
      try {
        parseAmount(body.amount);
      } catch (err) {
        const message = err instanceof MoneyError ? err.message : 'malformed amount';
        return reply.code(400).send({
          ...badRequest(message, 'trade.bad_request').body,
        });
      }
      const positionIdRaw = typeof body.id === 'string' ? body.id : typeof body.positionId === 'string' ? body.positionId : '';
      const positionId = positionIdRaw.trim() || undefined;
      if (!positionId) {
        return reply.code(400).send({
          ...badRequest('positionId is required for a retry-safe margin mutation', 'trade.position_id_required').body,
        });
      }
      const clientAdjustmentId = typeof body.clientAdjustmentId === 'string' ? body.clientAdjustmentId.trim() : '';
      if (!clientAdjustmentId) {
        return reply.code(400).send({
          ...badRequest('clientAdjustmentId is required for retry-safe margin mutation', 'trade.idempotency_key_required').body,
        });
      }

      const pos = await deps.reduceIsolatedMargin(principal, { symbol, amount: body.amount, positionId, clientAdjustmentId });
      return reply.code(200).send(pos);
    } catch (err) {
      if (err instanceof FuturesError) {
        return reply.code(err.status).send(presentFuturesErrorWire(err));
      }
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });
  app.post('/api/v1/positions/margin-mode', derivativesNotSupported('setMarginMode', setMarginModeArm.intafacedCode));

  // ── Create (money path) ───────────────────────────────────────────────────

  /**
   * POST /api/v1/orders/batch — bounded, sequential professional entry.
   *
   * Authorization and jurisdiction are checked before inspecting any item.
   * Items then use the same schema, mapper, and TradeService.placeOrder path as
   * the single-order route. Results are ordered and independent: a refusal or
   * unresolved outcome never rewrites an earlier item's result and there is no
   * batch hold, rollback, or atomicity promise.
   *
   * Both `{ orders: [...] }` and a bare `[...]` are accepted so clients can
   * send the existing create-order shape as a list without a second item type.
   */
  app.post('/api/v1/orders/batch', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    // Unlike the single route, the batch gate checks scope before parsing any
    // item: auth/scope/jurisdiction failure is request-wide by contract.
    try {
      requireScope(principal, 'trade:write');
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }

    const body = req.body as unknown;
    const rawItems = Array.isArray(body)
      ? body
      : body !== null && typeof body === 'object' && Array.isArray((body as { orders?: unknown }).orders)
        ? (body as { orders: unknown[] }).orders
        : null;
    if (rawItems === null) {
      return reply
        .code(400)
        .send(invalidOrder('batch body must be an array or an object with an orders array', 'trade.batch_body_invalid').body);
    }
    if (rawItems.length === 0) {
      return reply.code(400).send(invalidOrder('batch orders must be non-empty', 'trade.batch_empty').body);
    }
    if (rawItems.length > MAX_BATCH_ORDERS) {
      return reply.code(400).send(invalidOrder(`batch orders may contain at most ${MAX_BATCH_ORDERS} items`, 'trade.batch_too_large').body);
    }

    const results: Array<Record<string, unknown>> = [];
    for (const [index, rawItem] of rawItems.entries()) {
      const rawRecord = rawItem !== null && typeof rawItem === 'object' ? (rawItem as Record<string, unknown>) : null;
      const clientOrderId = typeof rawRecord?.clientOrderId === 'string' ? rawRecord.clientOrderId : null;
      const base = { index, clientOrderId };
      const parsed = createOrderRequestSchema.safeParse(rawItem);
      if (!parsed.success) {
        results.push({
          ...base,
          status: 'refused',
          error: {
            ...invalidOrder(parsed.error.issues[0]?.message ?? 'invalid create order body').body,
            issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
          },
        });
        continue;
      }

      let input: PlaceOrderInput;
      try {
        input = mapCreateOrderBody(parsed.data);
      } catch (err) {
        const mapped = toCcxtError(err);
        if (mapped) {
          results.push({ ...base, status: 'refused', error: mapped.body });
          continue;
        }
        results.push({
          ...base,
          status: 'unknown',
          error: {
            code: 'ExchangeError',
            message: 'batch item outcome is unknown; reconcile by clientOrderId',
            intafacedCode: 'trade.batch_outcome_unknown',
          },
        });
        continue;
      }

      try {
        // Sequential by design: each item independently executes the ordinary
        // TradeService hold → match → finalize path.
        const order = await deps.placeOrder(principal, input);
        const market = await deps.marketById(order.marketId);
        const symbol = market?.symbol ?? parsed.data.symbol;
        const wire = presentCcxtOrder(order, symbol);
        if (!sameOrderRequest(input, order, symbol)) {
          results.push({
            ...base,
            status: 'refused',
            error: {
              code: 'InvalidOrder',
              message: 'clientOrderId was already used for a different order request',
              intafacedCode: 'trade.client_order_id_conflict',
            },
          });
        } else if (wire.executionOutcome !== null) {
          results.push({ ...base, status: 'unknown', order: wire, evidence: wire.executionOutcome });
        } else {
          results.push({ ...base, status: 'success', order: wire });
        }
      } catch (err) {
        const mapped = toCcxtError(err);
        if (mapped) {
          results.push({ ...base, status: 'refused', error: mapped.body });
        } else {
          results.push({
            ...base,
            status: 'unknown',
            error: {
              code: 'ExchangeError',
              message: 'batch item outcome is unknown; reconcile by clientOrderId',
              intafacedCode: 'trade.batch_outcome_unknown',
            },
          });
        }
      }
    }

    return reply.code(200).send({ results });
  });

  /**
   * POST /api/v1/orders/batch-amend — bounded sequential native amend.
   *
   * Auth, scope, and jurisdiction are request-wide before any item. Each item
   * then uses the same parser and TradeService.amendOrder path as PATCH
   * /orders/:id. Results stay independent: mixed APPLIED / REFUSED /
   * OUTCOME_UNKNOWN, no batch rollback, no atomicity claim. Price/side/type
   * changes surface as named CANCEL_REPLACE (never a silent cancel-plus-new).
   *
   * `{ amends: [...] }`, `{ orders: [...] }`, and a bare `[...]` are accepted.
   */
  app.post('/api/v1/orders/batch-amend', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    try {
      requireScope(principal, 'trade:write');
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }

    const body = req.body as unknown;
    const rawItems = Array.isArray(body)
      ? body
      : body !== null && typeof body === 'object'
        ? Array.isArray((body as { amends?: unknown }).amends)
          ? (body as { amends: unknown[] }).amends
          : Array.isArray((body as { orders?: unknown }).orders)
            ? (body as { orders: unknown[] }).orders
            : null
        : null;
    if (rawItems === null) {
      return reply
        .code(400)
        .send(
          invalidOrder('batch amend body must be an array or an object with an amends or orders array', 'trade.batch_body_invalid').body,
        );
    }
    if (rawItems.length === 0) {
      return reply.code(400).send(invalidOrder('batch amend must be non-empty', 'trade.batch_empty').body);
    }
    if (rawItems.length > MAX_BATCH_ORDERS) {
      return reply.code(400).send(invalidOrder(`batch amend may contain at most ${MAX_BATCH_ORDERS} items`, 'trade.batch_too_large').body);
    }
    if (!deps.amendOrder) {
      return reply.code(503).send({ error: 'native order amend is not configured', code: 'trade.amend_unconfigured' });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const [index, rawItem] of rawItems.entries()) {
      const rawRecord = rawItem !== null && typeof rawItem === 'object' ? (rawItem as Record<string, unknown>) : null;
      const orderIdRaw = rawRecord?.id ?? rawRecord?.orderId;
      const orderId = typeof orderIdRaw === 'string' && orderIdRaw.length > 0 ? orderIdRaw : null;
      const base = { index, orderId };
      if (orderId === null) {
        results.push({
          ...base,
          status: 'REFUSED',
          error: invalidOrder('id must be a non-empty order id', 'trade.invalid_order_id').body,
        });
        continue;
      }

      const parsed = parseAmendOrderBody(rawItem);
      if (!parsed.ok) {
        results.push({
          ...base,
          status: 'REFUSED',
          error: invalidOrder(parsed.message).body,
        });
        continue;
      }

      try {
        const outcome = await deps.amendOrder(principal, orderId, parsed.input);
        const market = await deps.marketById(outcome.order.marketId);
        const symbol = market?.symbol ?? outcome.order.marketId;
        const presented = presentAmendOutcome(outcome, symbol);
        const status = batchAmendItemStatus(outcome);
        if (status === 'OUTCOME_UNKNOWN') {
          results.push({
            ...base,
            status,
            ...presented,
            evidence: {
              outcome: 'OUTCOME_UNKNOWN' as const,
              code: outcome.code,
              reasonCode: outcome.reasonCode,
              reconciliationRequired: outcome.reconciliationRequired,
            },
          });
        } else {
          results.push({ ...base, status, ...presented });
        }
      } catch (err) {
        const mapped = toCcxtError(err);
        if (mapped) {
          results.push({ ...base, status: 'REFUSED', error: mapped.body });
        } else {
          results.push(batchAmendUnknownItem(base));
        }
      }
    }

    return reply.code(200).send({ atomic: false, results });
  });

  app.post('/api/v1/orders', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    const parsed = createOrderRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      // CCXT `InvalidOrder`, not `BadRequest`: it is specifically the order
      // that is wrong, and that is the branch a client's order-builder listens
      // on. `issues` rides alongside so the integrator sees which field.
      return reply.code(400).send({
        ...invalidOrder(parsed.error.issues[0]?.message ?? 'invalid create order body').body,
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }

    let input: PlaceOrderInput;
    try {
      input = mapCreateOrderBody(parsed.data);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }

    try {
      const order = await deps.placeOrder(principal, input);
      const market = await deps.marketById(order.marketId);
      const symbol = market?.symbol ?? parsed.data.symbol;
      return reply.code(201).send(presentCcxtOrder(order, symbol));
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * POST /api/v1/markets/:marketId/orders/mass-cancel → matching mass-cancel.
   * Owner is the authenticated account. Body accountId, if present, must match.
   * Session id refuses. Unauthenticated refuses. Trade never invents a session.
   */
  app.post<{ Params: { marketId: string } }>('/api/v1/markets/:marketId/orders/mass-cancel', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    const body = (req.body ?? {}) as { accountId?: unknown; sessionId?: unknown };
    const sessionRefuse = massCancelSessionRefuse(
      readSessionId({
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : body.sessionId == null ? null : String(body.sessionId),
      }),
    );
    if (sessionRefuse) {
      return reply.code(200).send({
        accepted: false,
        accountId: principal.userId,
        cancellations: [],
        rejected: { code: sessionRefuse.code, message: sessionRefuse.message },
      });
    }

    const claimed =
      body.accountId === undefined || body.accountId === null
        ? null
        : typeof body.accountId === 'string'
          ? body.accountId
          : String(body.accountId);
    const accountRefuse = massCancelAccountRefuse(principal.userId, claimed);
    if (accountRefuse) {
      if (accountRefuse.code === 'missing_account') {
        return sendCcxt(reply, badRequest(accountRefuse.message, 'trade.missing_account'));
      }
      return sendCcxt(reply, permissionDenied(accountRefuse.message, 'trade.not_owner'));
    }

    try {
      const cancelled = await deps.massCancelOrders(principal, req.params.marketId);
      const symbolByMarket = new Map<string, string>();
      const wire = [];
      for (const order of cancelled) {
        const symbol = await symbolForOrder(order, symbolByMarket, deps.marketById);
        wire.push(presentCcxtOrder(order, symbol));
      }
      return reply.code(200).send({
        accepted: true,
        accountId: principal.userId,
        cancellations: wire,
        rejected: null,
      });
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  // ── Cancel all (static path — before :id is fine; Fastify matches exact) ──

  /**
   * DELETE /api/v1/orders[?symbol=] → TradeService.cancelAllOrders.
   * Same money path as single cancel (engine first, finalize second), sequential.
   * trade:write is enforced inside TradeService; jurisdiction here matches create/cancel.
   */
  app.delete<{ Querystring: { symbol?: string } }>('/api/v1/orders', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    let marketId: string | undefined;
    const symbolRaw = req.query.symbol;
    if (symbolRaw !== undefined && symbolRaw !== '') {
      const symbol = decodeURIComponent(symbolRaw);
      const market = await deps.marketBySymbol(symbol);
      if (!market) {
        return sendCcxt(reply, badSymbol(symbol));
      }
      marketId = market.id;
    }

    try {
      const cancelled = await deps.cancelAllOrders(principal, marketId);
      const symbolByMarket = new Map<string, string>();
      const wire = [];
      for (const order of cancelled) {
        const symbol = await symbolForOrder(order, symbolByMarket, deps.marketById);
        wire.push(presentCcxtOrder(order, symbol));
      }
      return reply.code(200).send(wire);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * POST /api/v1/orders/:id/replace — CANCEL_REPLACE saga.
   *
   * Original cancel/finalized release is complete before a replacement is
   * submitted. It is never advertised as native amend or queue-preserving.
   */
  app.post<{ Params: { id: string } }>('/api/v1/orders/:id/replace', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;
    if (!deps.replaceOrder) {
      return reply.code(503).send({ error: 'order replacement is not configured', code: 'trade.replace_unconfigured' });
    }

    const parsed = createOrderRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ...invalidOrder(parsed.error.issues[0]?.message ?? 'invalid replacement order body').body,
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }

    let input: PlaceOrderInput;
    try {
      input = mapCreateOrderBody(parsed.data);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }

    try {
      const outcome = await deps.replaceOrder(principal, req.params.id, input);
      const originalMarket = await deps.marketById(outcome.original.marketId);
      const replacementMarket = outcome.replacement === null ? originalMarket : await deps.marketById(outcome.replacement.marketId);
      return reply
        .code(200)
        .send(
          presentReplaceOutcome(
            outcome,
            originalMarket?.symbol ?? outcome.original.marketId,
            replacementMarket?.symbol ?? outcome.replacement?.marketId ?? outcome.original.marketId,
          ),
        );
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * PATCH /api/v1/orders/:id — native matching amend.
   *
   * Qty-down at the same price keeps queue priority. Side/market/price change
   * is named CANCEL_REPLACE and does not silently cancel-plus-new.
   */
  app.patch<{ Params: { id: string } }>('/api/v1/orders/:id', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;
    if (!deps.amendOrder) {
      return reply.code(503).send({ error: 'native order amend is not configured', code: 'trade.amend_unconfigured' });
    }

    const parsed = parseAmendOrderBody(req.body ?? {});
    if (!parsed.ok) {
      return reply.code(400).send({ ...invalidOrder(parsed.message).body });
    }

    try {
      const outcome = await deps.amendOrder(principal, req.params.id, parsed.input);
      const market = await deps.marketById(outcome.order.marketId);
      return reply.code(200).send(presentAmendOutcome(outcome, market?.symbol ?? outcome.order.marketId));
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  // ── By id ─────────────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>('/api/v1/orders/:id', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    try {
      const order = await deps.getOrder(principal, req.params.id);
      const market = await deps.marketById(order.marketId);
      const symbol = market?.symbol ?? order.marketId;
      return reply.code(200).send(presentCcxtOrder(order, symbol));
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/v1/orders/:id', async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    try {
      const order = await deps.cancelOrder(principal, req.params.id);
      const market = await deps.marketById(order.marketId);
      const symbol = market?.symbol ?? order.marketId;
      return reply.code(200).send(presentCcxtOrder(order, symbol));
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });
}

/** Test helper — build a minimal open OrderRecord. */
export function fakeOrder(partial: {
  id?: string;
  userId?: string;
  marketId?: string;
  clientOrderId?: string | null;
  side?: OrderRecord['side'];
  type?: OrderRecord['type'];
  price?: OrderRecord['price'];
  qty?: OrderRecord['qty'];
  filledQty?: OrderRecord['filledQty'];
  status?: OrderRecord['status'];
  tif?: OrderRecord['tif'];
  protectionPrice?: OrderRecord['protectionPrice'];
  rejectCode?: OrderRecord['rejectCode'];
  recoveryReason?: OrderRecord['recoveryReason'];
  reconciliationKey?: OrderRecord['reconciliationKey'];
  lifecycleProof?: OrderRecord['lifecycleProof'];
  replacementOf?: OrderRecord['replacementOf'];
  replacementRequestHash?: OrderRecord['replacementRequestHash'];
  sessionId?: OrderRecord['sessionId'];
  apiKeyId?: OrderRecord['apiKeyId'];
  createdAt?: Date;
}): OrderRecord {
  const qty = partial.qty ?? 1_000_000_000_000_000_000n; // 1.0
  return {
    id: partial.id ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: partial.userId ?? '11111111-1111-4111-8111-111111111111',
    subAccountId: null,
    marketId: partial.marketId ?? '00000000-0000-4000-8000-000000000001',
    clientOrderId: partial.clientOrderId === undefined ? 'cli-1' : partial.clientOrderId,
    side: partial.side ?? 'buy',
    type: partial.type ?? 'limit',
    price: partial.price === undefined ? 100_000_000_000_000_000_000n : partial.price, // 100.0
    qty,
    filledQty: partial.filledQty ?? 0n,
    status: partial.status ?? 'open',
    tif: partial.tif ?? 'GTC',
    holdAsset: 'USDT',
    holdAmount: 100_000_000_000_000_000_000n,
    amendReleased: 0n,
    feeDiscountBps: 0,
    protectionPrice: partial.protectionPrice === undefined ? null : partial.protectionPrice,
    engineSequence: 1,
    engineVersion: 1,
    seeded: false,
    rejectCode: partial.rejectCode ?? null,
    recoveryReason: partial.recoveryReason ?? null,
    reconciliationKey: partial.reconciliationKey ?? null,
    lifecycleProof: partial.lifecycleProof ?? null,
    replacementOf: partial.replacementOf ?? null,
    replacementRequestHash: partial.replacementRequestHash ?? null,
    sessionId: partial.sessionId ?? '99999999-9999-4999-8999-999999999999',
    apiKeyId: partial.apiKeyId ?? null,
    createdAt: partial.createdAt ?? new Date('2023-11-14T22:13:20.000Z'),
  };
}

/** Test helper — one fill for private trade wire. */
export function fakeFill(partial: {
  id?: string;
  orderId?: string;
  marketId?: string;
  userId?: string;
  side?: FillRecord['side'];
  liquidity?: FillRecord['liquidity'];
  price?: FillRecord['price'];
  qty?: FillRecord['qty'];
  quoteAmount?: FillRecord['quoteAmount'];
  feeAsset?: string;
  feeAmount?: FillRecord['feeAmount'];
  feeBps?: number;
  ts?: Date;
}): FillRecord {
  return {
    id: partial.id ?? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    orderId: partial.orderId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    counterOrderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    marketId: partial.marketId ?? '00000000-0000-4000-8000-000000000001',
    userId: partial.userId ?? '11111111-1111-4111-8111-111111111111',
    side: partial.side ?? 'buy',
    liquidity: partial.liquidity ?? 'taker',
    price: partial.price ?? 100_000_000_000_000_000_000n,
    qty: partial.qty ?? 1_000_000_000_000_000_000n,
    quoteAmount: partial.quoteAmount ?? 100_000_000_000_000_000_000n,
    feeAsset: partial.feeAsset ?? 'USDT',
    feeAmount: partial.feeAmount ?? 100_000_000_000_000_000n, // 0.1
    feeBps: partial.feeBps ?? 10,
    sequence: 1,
    ts: partial.ts ?? new Date('2023-11-14T22:13:20.000Z'),
    sessionId: '99999999-9999-4999-8999-999999999999',
    apiKeyId: null,
  };
}
