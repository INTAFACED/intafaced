import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireScope, type Principal } from '@intafaced/auth';
import { attachConvertExportRoute } from './convert/convert-history-rest.js';
import { attachStatementRoutes, type StatementRestDeps } from './statements/statement-rest.js';
import { attachCopyExportRoute } from './copy/copy-export-rest.js';
import { attachAlgoRestRoutes, type AlgoRestPort } from './algo/algo-rest.js';
import { attachRfqExportRoute } from './otc/rfq-history-rest.js';
import { attachIcebergDisplay, readRawDisplayQty, TRADE_ICEBERG_DISPLAY_INVALID, type IcebergDisplayStore } from './spot/iceberg-door.js';
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
import { hasSpentExpiry, refuseOptionsOnReplacement, refuseUnsupportedPlacementOptions } from './spot/placement-options.js';
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
import { SETTLEMENT_PENDING } from './ledger-public-code.js';
import type { Position } from '@intafaced/exchange-contract';
import type { MarketStateSnapshot } from '@intafaced/exchange-contract';
import {
  MARKETS_LIMIT_MAX,
  OpenOrdersLimitUnsetError,
  replacementClientOrderId,
  type AmendOrderInput,
  type PlaceOrderInput,
} from './spot/trade-service.js';
import {
  discountedFeeBps,
  FEE_SCHEDULE_RESIDUAL,
  FeeScheduleError,
  publicFeeSchedule,
  publishedProductBps,
  REGULAR_FEE_TIER,
  type OwnerFeeSchedule,
} from './spot/fee-schedule.js';
import {
  TradeError,
  type AmendOrderOutcome,
  type FillRecord,
  type Market,
  type OrderAmendment,
  type OrderRecord,
  type OrderStatus,
  type ReplaceOrderOutcome,
} from './spot/types.js';
import { FuturesError } from './futures/position-service.js';
import type { GatedContract, GatedListSubject } from './futures/gated-list.js';
import { attachMatchedOrderRoutes, type MatchedOrdersRestDeps } from './futures/matched-orders-rest.js';
import { isRolledBackMarkRefusal, presentFuturesErrorWire, presentRolledBackRefusal } from './futures/futures-error-wire.js';
import { resolveOpenPositionMode } from './futures/account-mode.js';
import {
  attemptMarginModeSwitch,
  checkCollateralClassForMargin,
  checkMarginModeForFuturesOpen,
  type MarginModeSwitchAudit,
} from './futures/margin-mode.js';
import { CANCEL_NOT_CLOSE } from './futures/cancel-not-close.js';
import type { MarginCallWire } from './futures/margin-call-transport.js';
import type { FuturesPayout } from './futures/futures-payouts.js';
import type { AdlDisclosureWire } from './futures/adl-disclosure.js';
import type { AdlActionDisclosureWire } from './futures/adl-last-resort.js';
import { isDerivativesAccessError, presentDerivativesAccessError } from './futures/derivatives-access.js';
import { refuseArmById } from './ccxt-capability-matrix.js';
import { assertStopTrigger, SPOT_ORDER_TYPES, TRADE_STOP_TRIGGER_INVALID, type StopTriggerStore } from './spot/stop-trigger-door.js';
import { stopMarketBody, type StopKind } from './spot/stop-market.js';
import { orderIdFor } from './spot/ids.js';
import type { OrderHold } from './spot/order-holds.js';
import type { EdgeTrust } from './edge-trust.js';
import { carryPlacementBody, schemaBodyOf } from './spot/placement-extras.js';
import { readBracketFromBody } from './spot/bracket-place.js';
import type { OrderLink } from './spot/order-links.js';
import { readOcoFromBody } from './spot/oco-place.js';
import { createBodyRefusal } from './create-body-refusal.js';
import { massCancelAccountRefuse, massCancelSessionRefuse, readSessionId } from './spot/matching-client.js';
import { privateRead, privateWith, privateWrite, publicRead } from './route-inventory.js';
import { attachGridRestRoutes } from './grid/grid-rest.js';
import type { GridService } from './grid/grid-service.js';

/**
 * Private CCXT-style REST (trade.ccxt-api — authenticated).
 *
 * Paths match `REST_ROUTES` in `@intafaced/exchange-contract`:
 *   GET    /api/v1/orders/open     scope: trade:read  (?symbol=&limit=)
 *   GET    /api/v1/admin/orders/open scope: admin:read (canonical order rows)
 *   GET    /api/v1/admin/fees        scope: admin:read (fee schedule customers are charged, per market, with its source)
 *   GET    /api/v1/orders/closed   scope: trade:read  (?symbol=&limit=&since= ms&until= ms&side=&status=&type=)
 *   GET    /api/v1/orders/by-client-id/:clientOrderId  scope: trade:read   (?symbol= required; also /orders/by-client/:clientOrderId)
 *   DELETE /api/v1/orders/by-client-id/:clientOrderId  scope: trade:write  (?symbol= required)
 *   GET    /api/v1/orders/:id      scope: trade:read
 *   GET    /api/v1/orders/:id/amendments  scope: trade:read   (each amend and replace, oldest first)
 *   POST   /api/v1/orders          scope: trade:write + jurisdiction(module=trade)
 *   POST   /api/v1/orders/batch    scope: trade:write + jurisdiction(module=trade)
 *   POST   /api/v1/orders/batch-amend scope: trade:write + jurisdiction(module=trade)  (sequential native amend)
 *   POST   /api/v1/orders/batch-cancel scope: trade:write + jurisdiction(module=trade)  (sequential cancel by order id list)
 *   POST   /api/v1/orders/cancel-all-after scope: trade:write + jurisdiction(module=trade)  (dead-man switch; timeout 0 disarms)
 *   POST   /api/v1/orders/:id/replace scope: trade:write + jurisdiction(module=trade)
 *   PATCH  /api/v1/orders/:id      scope: trade:write + jurisdiction(module=trade)  (native amend)
 *   DELETE /api/v1/orders/:id      scope: trade:write + jurisdiction(module=trade)
 *   DELETE /api/v1/orders          scope: trade:write + jurisdiction(module=trade)  (cancelAll; ?symbol= optional)
 *   POST   /api/v1/markets/:marketId/orders/mass-cancel scope: trade:write + jurisdiction  (matching mass-cancel; auth account only)
 *   GET    /api/v1/account/trades  scope: trade:read  (?symbol=&limit=&since= ms)
 *   GET    /api/v1/account/fees    scope: trade:read  (the caller's maker/taker: its tier, less its rank discount)
 *   GET    /api/v1/account/balance scope: trade:read  (ledger projection; self-only)
 *   GET    /api/v1/positions       scope: trade:read  (open futures rows; [] when none)
 *   GET    /api/v1/positions/closed scope: trade:read (closed/liquidated; [] when none; ?symbol=&limit=&since= ms)
 *   GET    /api/v1/positions/:id   scope: trade:read  (one owned row; 404 if missing)
 *   GET    /api/v1/positions/:id/margin-call  scope: trade:read  (delivered call or 404)
 *   GET    /api/v1/futures/adl-disclosure     scope: trade:read  (copy + ack — DIRECTION:34)
 *   POST   /api/v1/futures/adl-disclosure/ack scope: trade:write (voluntary ack; no open waits on it)
 *   GET    /api/v1/futures/adl-events         scope: trade:read  (disclosure-before-action; ?limit= 1..500)
 *   GET    /api/v1/account/gated-list         scope: trade:read  (each futures contract open or blocked for the caller, with every reason)
 *   GET    /api/v1/futures/liquidations      scope: trade:read  (caller's rungs; adlRank null until published)
 *   GET    /api/v1/futures/payouts           scope: trade:read  (caller's profit payouts: paid, or owed while the clearing pot is short)
 *   GET    /api/v1/positions/:id/funding-payments scope: trade:read (?cursor=)
 *   POST   /api/v1/positions       scope: trade:write (open funded position — F3)
 *   DELETE /api/v1/positions/:id   scope: trade:write (cancel-not-close — does not release margin)
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

/**
 * A request deadline that has passed is waived for a replay of a booked clientOrderId. The lookup runs only then, so an
 * order without a spent deadline pays no extra read and has no new failure mode.
 */
async function isDeadlineReplay(
  deps: PrivateRestDeps,
  principal: Principal,
  body: { requestDeadline?: string; timeInForce?: string; expireAt?: string; symbol: string; clientOrderId: string },
  now: Date,
): Promise<boolean> {
  const deadlineSpent = body.requestDeadline !== undefined && Date.parse(body.requestDeadline) <= now.getTime();
  if ((!deadlineSpent && !hasSpentExpiry(body, now)) || !deps.findClientOrder) return false;
  return (await deps.findClientOrder(principal, { symbol: body.symbol, clientOrderId: body.clientOrderId })) !== null;
}

/** Spot-supported order types only (TradeService rejects stop-market and take-profit). */
function isSpotOrderType(type: string): type is (typeof SPOT_ORDER_TYPES)[number] {
  return (SPOT_ORDER_TYPES as readonly string[]).includes(type);
}

const ORDER_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PrivateRestDeps {
  /** Shared EDGE_PRINCIPAL_SECRET — same value tRPC uses. */
  edgeSecret: string;
  edgeTrust?: EdgeTrust;
  serviceName: string;
  convertExport?(principal: Principal, query: { from?: string; to?: string }): Promise<string>;
  /** Ledger history and statement export (J-cex-spot-07 #5, #6). Absent: those routes answer 503 `trade.statements_unmounted`. */
  statements?: StatementRestDeps;
  /** Futures orders through the matching book, wired while TRADE_FUTURES_MATCHING_ENABLED is on. Absent: not mounted. */
  futuresOrders?: MatchedOrdersRestDeps;
  /** D-ops-01 gated list. Absent: the route answers 503 `trade.gated_list_unmounted`. */
  gatedList?: (subject: GatedListSubject) => Promise<readonly GatedContract[]>;
  copyExport?(principal: Principal, query: { followId?: string; from?: string; to?: string }): Promise<string>;
  /** The spot grid bot service behind `/api/v1/bots/grid` (J-copy-bots-otc-19). Omitted: every grid door answers 503. */
  grid?: GridService;
  /** The algo engine's calls (CB-execution-08). Absent: every `/api/v1/algo` door answers 503 `trade.algo_unavailable`. */
  algo?: AlgoRestPort;
  rfqExport?(principal: Principal, query: { from?: string; to?: string }): Promise<string>;
  icebergDisplay?: IcebergDisplayStore;
  /** Stop triggers of stop-limit orders. Absent: stop-limit is refused (fail closed). */
  stopTriggers?: StopTriggerStore;
  /**
   * The protection cap a stop-market on this market is placed at, the one its market orders are bounded by (the
   * operator's per-market cap, else `TRADE_MARKET_SLIPPAGE_CAP_BPS`): its limit is the stop plus (buy) or minus (sell)
   * this many basis points. Absent or null refuses a stop-market `trade.protection_unset`.
   */
  stopMarketCapBps?: (marketId: string) => Promise<number | null>;
  /** The stored legs for OCO parents (and bracket exits), by order id; absent when the store is not wired. */
  ocoExits?: (orderIds: readonly string[]) => Promise<ReadonlyMap<string, OcoExitLegs>>;
  /** How OTO entries and their closes name each other, by order id; absent when not wired, and then no order is linked. */
  orderLinks?: (orderIds: readonly string[]) => Promise<ReadonlyMap<string, OrderLink>>;
  /** What each live order still holds, by order id; absent when not wired, and then no order carries a hold. */
  orderHolds?: (orders: readonly OrderRecord[]) => Promise<ReadonlyMap<string, OrderHold>>;
  /**
   * Durable create-vs-replay signal for iceberg peaks. Looks up the caller's
   * clientOrderId before placeOrder. Absent only in tests that mock placeOrder.
   */
  findClientOrder?(
    principal: Principal,
    input: { symbol?: string; marketId?: string; clientOrderId?: string },
  ): Promise<OrderRecord | null>;
  openOrders(principal: Principal, marketId: string | undefined, limit: number): Promise<OrderRecord[]>;
  /** Operator projection. Unset mounts a typed refuse, never a fallback book. Limit required — never invent 100. */
  adminOpenOrders?(principal: Principal, limit: number): Promise<OrderRecord[]>;
  orderHistory(
    principal: Principal,
    input: {
      marketId?: string;
      limit: number;
      sinceMs?: number;
      untilMs?: number;
      side?: 'buy' | 'sell';
      status?: 'filled' | 'cancelled' | 'rejected' | 'expired';
      type?: ClosedOrderType;
      /** The last order of the previous page: the page holds only orders older than it (newest first, ties by id). */
      before?: string;
    },
  ): Promise<OrderRecord[]>;
  getOrder(principal: Principal, orderId: string): Promise<OrderRecord>;
  /** One of the caller's orders' fills, oldest first; another person's order is not found. Unset mounts a typed 503. */
  orderFills?(principal: Principal, orderId: string, limit: number): Promise<FillRecord[]>;
  /** Every amend and replace of one order, oldest first. Unset mounts a typed 503, never an empty list. */
  orderAmendments?(principal: Principal, orderId: string): Promise<OrderAmendment[]>;
  placeOrder(principal: Principal, input: PlaceOrderInput): Promise<OrderRecord>;
  cancelOrder(principal: Principal, orderId: string): Promise<OrderRecord>;
  /** Two-step cancel → finalized release → replacement submit saga. Never native amend. */
  replaceOrder?(principal: Principal, orderId: string, input: PlaceOrderInput): Promise<ReplaceOrderOutcome>;
  /** Native matching PATCH. Qty-down same price only. */
  amendOrder?(principal: Principal, orderId: string, input: AmendOrderInput): Promise<AmendOrderOutcome>;
  /** Cancel every open/pending order (optional market). Sequential money path. */
  cancelAllOrders(principal: Principal, marketId?: string, kind?: 'spot' | 'futures' | 'options'): Promise<OrderRecord[]>;
  /** Dead-man switch: arm (or with 0 disarm) the user's cancel-all-after countdown. Absent = door not mounted. */
  armCancelAllAfter?(principal: Principal, timeoutSec: number): Promise<{ armed: boolean; timeoutSec: number; deadline: Date | null }>;
  /** The caller's countdown and the owner's published timeouts (null = not published). Absent = door not mounted. */
  readCancelAllAfter?(
    principal: Principal,
  ): Promise<{ armed: boolean; timeoutSec: number; deadline: Date | null; published: readonly number[] | null }>;
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
  /** The schedule in force now (a later approved version, else `feeSchedule`). Absent: `feeSchedule` as booted. */
  feeScheduleNow?: () => Promise<OwnerFeeSchedule>;
  /** The caller's fee tier for a new spot order under `schedule` (the last finished snapshot). Absent: regular. */
  feeTier?(userId: string, schedule: OwnerFeeSchedule): Promise<string>;
  /** The caller's rank discount in bps of the published rate. Absent: none. */
  feeDiscountBps?(userId: string): Promise<number>;
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
      /** Edge region, handed to the derivatives gate to pick the jurisdiction text. Not part of the business payload. */
      region?: string;
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
   * Append-only record of a refused margin-mode switch. The door never updates
   * `margin_mode`. Production wires the SQL audit; tests may pass memory.
   */
  marginModeAudit?: MarginModeSwitchAudit;
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
  /** Record a voluntary ack for the current disclosure version. No open waits on it. */
  ackAdlDisclosure(principal: Principal): Promise<AdlDisclosureWire>;
  /**
   * Observable ADL disclosure-before-action events for this principal
   * (candidate side). Empty [] when none — never invents events.
   */
  listAdlDisclosureEvents(principal: Principal, limit: number): Promise<AdlActionDisclosureWire[]>;
  /**
   * Funding settlement postings for one position the caller owns.
   * Empty payments means no funding yet. Another account's id is not found.
   */
  listFundingPayments?(
    principal: Principal,
    positionId: string,
    cursor: string | undefined,
  ): Promise<{
    payments: readonly { time: string; rate: string | null; rateReason: string | null; amount: string; direction: 'paid' | 'received' }[];
    nextCursor: string | null;
  }>;
  /** The caller's liquidation rungs. adlRank stays null until a rank is actually computed. */
  listLiquidations?(principal: Principal): Promise<{ events: readonly unknown[] }>;
  /** D-margin-06: one owned position's liquidation rung timeline. Absent: the door answers 503 unwired. */
  positionLiquidation?(principal: Principal, positionId: string): Promise<unknown>;
  /** The caller's futures profit payouts, newest first: paid, or owed while the clearing pot is short. */
  listFuturesPayouts?(principal: Principal): Promise<{ payouts: readonly FuturesPayout[] }>;
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
/** A bare `stopPx` on a limit body would reach the engine with no stored trigger; the one door is `type: stop_limit`. */
function hasRawStopPx(body: unknown): boolean {
  return !!body && typeof body === 'object' && !Array.isArray(body) && (body as { stopPx?: unknown }).stopPx !== undefined;
}

/** The stop-limit body a `type: stop` (stop-market) request is placed with, or null when the request is no stop-market. */
async function stopMarketOf(deps: PrivateRestDeps, body: unknown): Promise<{ body: unknown } | null> {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || (body as { type?: unknown }).type !== 'stop') return null;
  const symbol = (body as { symbol?: unknown }).symbol;
  const market = typeof symbol === 'string' ? await deps.marketBySymbol(symbol) : null;
  const cap = market && deps.stopMarketCapBps ? await deps.stopMarketCapBps(market.id) : null;
  const out = stopMarketBody(body, market, cap);
  return out.kind === 'stop' ? { body: out.body } : null;
}

/** A stop-limit rests as a limit; its stored trigger turns the wire order back into the stop-limit the caller placed. */
async function withStopTriggers(deps: PrivateRestDeps, orders: readonly OrderRecord[]) {
  const ids = orders.map((o) => o.id);
  const triggers = deps.stopTriggers && orders.length > 0 ? await deps.stopTriggers.readMany(ids) : null;
  const fired = deps.stopTriggers && triggers && triggers.size > 0 ? await deps.stopTriggers.readFired(ids) : null;
  const markets = deps.stopTriggers && triggers && triggers.size > 0 ? await deps.stopTriggers.readStopMarkets(ids) : null;
  return <W extends { type: string; stopPrice: string | null }>(order: OrderRecord, wire: W): W => {
    const trigger = triggers?.get(order.id);
    if (!trigger) return wire;
    // `triggered`: when the stop fired and the price that reached it; null while it waits (or if no record was kept).
    const when = fired?.get(order.id);
    const triggered = when ? { at: when.at, by: when.by, referencePrice: when.referencePrice } : null;
    // A stop-market rests as the stop-limit at its protection price; its `price` stays that bound.
    return { ...wire, type: markets?.has(order.id) ? 'stop' : 'stop_limit', stopPrice: trigger, triggered };
  };
}

export type OcoExitLegs = { readonly takeProfit: string; readonly stopLoss: string; readonly stopLossLimit: string | null };

/**
 * An OCO parent (or a bracket's exit) carries its linked legs on the wire as `exit`, and an OTO entry or its close
 * carries `linked`; every other order is untouched.
 */
async function withOcoExit(deps: PrivateRestDeps, orders: readonly OrderRecord[]) {
  const ids = orders.map((o) => o.id);
  const [legs, links] = await Promise.all([
    deps.ocoExits && orders.length > 0 ? deps.ocoExits(ids) : null,
    deps.orderLinks && orders.length > 0 ? deps.orderLinks(ids) : null,
  ]);
  return <W extends object>(order: OrderRecord, wire: W): W => {
    const found = legs?.get(order.id);
    const link = links?.get(order.id);
    const linked = link ? { ...wire, linked: link } : wire;
    if (!found) return linked;
    const kind = /^bracket:.+:exit$/.test(order.clientOrderId ?? '') ? 'bracket_exit' : 'oco';
    return { ...linked, exit: { kind, ...found } };
  };
}

/**
 * An open order carries what it still holds as `hold`; other orders carry `null` (nothing stated). The hold is shown
 * beside the order, never needed to act on it: a failed hold read states nothing rather than failing the orders read.
 */
async function withHold(deps: PrivateRestDeps, orders: readonly OrderRecord[], log: { warn: (obj: object, msg: string) => void }) {
  const holds =
    deps.orderHolds && orders.length > 0
      ? await deps.orderHolds(orders).catch((err: unknown) => {
          log.warn({ err, orders: orders.length }, 'order hold read failed; the orders read states no hold');
          return new Map<string, OrderHold>();
        })
      : null;
  return <W extends object>(order: OrderRecord, wire: W): W => (holds ? { ...wire, hold: holds.get(order.id) ?? null } : wire);
}

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
    tag: order.tag ?? null,
    /** The rank fee discount this order trades with, as a rate ("0" when none). Its fills' fee rates already include it. */
    feeDiscount: Number.isInteger(order.feeDiscountBps) && order.feeDiscountBps >= 0 ? bpsToFeeRate(order.feeDiscountBps) : undefined,
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

/** Which published block the fill path charges a market from: spot rows, the futures `perpetual` block, none for options. */
export function feeProductOf(market: Market): 'spot' | 'perpetual' | null {
  return market.kind === 'spot' ? 'spot' : market.kind === 'futures' ? 'perpetual' : null;
}

/** Whether a market's rate depends on the caller's fee tier: live spot only (paper and futures are always regular). */
export function tieredMarket(market: Market): boolean {
  return market.kind === 'spot' && !market.paper;
}

/** Whose rates `presentAccountFees` answers: the caller's fee tier and rank discount, as the order check reads them. */
export interface AccountFeeTerms {
  readonly tierId: string;
  readonly discountBps: number;
}

const REGULAR_TERMS: AccountFeeTerms = { tierId: REGULAR_FEE_TIER, discountBps: 0 };

/**
 * Customer fee card: once per symbol, the rates `terms` pays on the owner schedule in force, the way placement and the
 * order check resolve them. Spot reads the market's pair-group row at the tier (a paper market is regular), futures the
 * `perpetual` block, and both take the rank discount; options have no rate and are left out. Listing-row bps are not
 * copied onto this wire. With no terms, the regular tier before any discount (the public schedule).
 */
export function presentAccountFees(
  markets: readonly Market[],
  schedule: Extract<OwnerFeeSchedule, { published: true }>,
  terms: AccountFeeTerms = REGULAR_TERMS,
): Record<
  string,
  ReturnType<typeof presentCcxtTradingFee> & { makerBps: number; takerBps: number; version: string; tier: string; discountBps: number }
> {
  const out: ReturnType<typeof presentAccountFees> = {};
  for (const market of markets) {
    const product = feeProductOf(market);
    if (!product) continue;
    const tierId = tieredMarket(market) ? terms.tierId : REGULAR_FEE_TIER;
    let rates: { makerBps: number; takerBps: number } | null;
    try {
      rates = publishedProductBps(schedule, product, product === 'spot' ? { symbol: market.symbol, tierId } : undefined);
      if (rates) {
        rates = {
          makerBps: discountedFeeBps(rates.makerBps, terms.discountBps),
          takerBps: discountedFeeBps(rates.takerBps, terms.discountBps),
        };
      }
    } catch (err) {
      // A market whose schedule row refuses shows no rate; the order path refuses it with the typed code.
      if (err instanceof FeeScheduleError) continue;
      throw err;
    }
    if (!rates) continue;
    out[market.symbol] = {
      symbol: market.symbol,
      maker: bpsToFeeRate(rates.makerBps),
      taker: bpsToFeeRate(rates.takerBps),
      percentage: true,
      makerBps: rates.makerBps,
      takerBps: rates.takerBps,
      version: schedule.version,
      tier: tierId,
      discountBps: terms.discountBps,
    };
  }
  return out;
}

/** Where the operator fee read gets its numbers. Listing-row bps are not charged and never appear on this wire. */
export const ADMIN_FEE_SOURCE = 'TRADE_FEE_SCHEDULE' as const;

export type AdminFeeRefusal =
  'trade.fee_product_unpublished' | 'trade.fee_schedule_blank' | 'trade.rebate_recipe_unavailable' | 'trade.min_fee_recipe_unavailable';

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
  readonly refusal: AdminFeeRefusal | null;
}

/**
 * Operator view of the fees customers are charged: the owner `TRADE_FEE_SCHEDULE`, resolved per market kind the way the
 * fill path does (spot → top-level rates, futures → `perpetual` block, options → unpublished). Bps and rates are decimal
 * strings. Rank discounts are per customer and are not applied here.
 */
export function presentAdminFees(markets: readonly Market[], schedule: Extract<OwnerFeeSchedule, { published: true }>) {
  const rows: AdminMarketFee[] = markets.map((market) => {
    const product = feeProductOf(market);
    let rates: { makerBps: number; takerBps: number } | null = null;
    let refusal: AdminFeeRefusal | null = null;
    if (product) {
      try {
        rates = publishedProductBps(schedule, product, product === 'spot' ? { symbol: market.symbol } : undefined);
      } catch (err) {
        if (!(err instanceof FeeScheduleError)) throw err;
        refusal = err.code === 'trade.fee_schedule_invalid' ? 'trade.fee_schedule_blank' : err.code;
      }
    }
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
      refusal: rates ? null : (refusal ?? 'trade.fee_product_unpublished'),
    };
  });
  return { source: ADMIN_FEE_SOURCE, version: schedule.version, markets: rows };
}

/**
 * CCXT private trade (my fill) — decimal strings; fee.rate from bps.
 * `order` is the caller's order id (not the counter). A maker rebate is its own `rebate` field, never a negative fee.
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
    ...(fill.rebate
      ? { rebate: { cost: formatAmount(fill.rebate.amount), currency: fill.rebate.asset, rate: bpsToFeeRate(fill.rebate.bps) } }
      : {}),
    // The order chose to pay in the platform token and this fill took the fee in what it received instead: why.
    ...(fill.feeFallback ? { feeFallback: fill.feeFallback } : {}),
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

const MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * Optional CCXT `since` (unix ms). Absent/empty → no filter.
 * NaN, negative or past the last representable Date → invalid (caller returns 400). Zero is valid (epoch).
 */
export function parseSince(raw: unknown): { ok: true; sinceMs?: number } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, sinceMs: undefined };
  const n = Number(raw);
  // 8.64e15 ms is the last instant a Date holds; past it the value would reach the database as an Invalid Date.
  if (!Number.isFinite(n) || n < 0 || n > MAX_DATE_MS) {
    return { ok: false, message: 'since must be a non-negative unix timestamp in milliseconds' };
  }
  return { ok: true, sinceMs: Math.floor(n) };
}

type ClosedQuery = {
  symbol?: string;
  limit?: string;
  since?: string;
  until?: string;
  side?: string;
  status?: string;
  before?: string;
};

const CLOSED_STATUS_WORDS: Record<string, 'filled' | 'cancelled' | 'rejected' | 'expired'> = {
  closed: 'filled',
  canceled: 'cancelled',
  rejected: 'rejected',
  expired: 'expired',
};

/** Optional `side` and `status` filters of orders/closed; CCXT status words, anything else is a 400. */
export type ClosedOrderType = 'market' | 'limit' | 'stop_limit' | 'stop';
const CLOSED_ORDER_TYPES: readonly string[] = ['market', 'limit', 'stop_limit', 'stop'];

export function parseClosedFilters(query: {
  side?: unknown;
  status?: unknown;
  type?: unknown;
}):
  | { ok: true; side?: 'buy' | 'sell'; status?: 'filled' | 'cancelled' | 'rejected' | 'expired'; type?: ClosedOrderType }
  | { ok: false; message: string } {
  const out: { side?: 'buy' | 'sell'; status?: 'filled' | 'cancelled' | 'rejected' | 'expired'; type?: ClosedOrderType } = {};
  if (query.type !== undefined && query.type !== '') {
    if (typeof query.type !== 'string' || !CLOSED_ORDER_TYPES.includes(query.type)) {
      return { ok: false, message: 'type must be market, limit, stop_limit or stop' };
    }
    out.type = query.type as ClosedOrderType;
  }
  if (query.side !== undefined && query.side !== '') {
    if (query.side !== 'buy' && query.side !== 'sell') return { ok: false, message: 'side must be buy or sell' };
    out.side = query.side;
  }
  if (query.status !== undefined && query.status !== '') {
    const mapped =
      typeof query.status === 'string' && Object.hasOwn(CLOSED_STATUS_WORDS, query.status) ? CLOSED_STATUS_WORDS[query.status] : undefined;
    if (!mapped) return { ok: false, message: 'status must be closed, canceled, rejected or expired' };
    out.status = mapped;
  }
  return { ok: true, ...out };
}

/**
 * Map CCXT create body → PlaceOrderInput (decimal strings → Amount).
 * Only market/limit; postOnly becomes tif PO when no other tif is set.
 */
/** The create-body fields a plain market or limit order has. Any other field places through an installer. */
const PLAIN_ORDER_FIELDS: ReadonlySet<string> = new Set([
  'symbol',
  'type',
  'side',
  'amount',
  'price',
  'timeInForce',
  'postOnly',
  'clientOrderId',
  'tag',
  'feeCurrency',
  'requestDeadline',
  'expireAt',
  'stpMode',
]);

/**
 * Spot takes the fee in the asset the order receives (base on a buy, quote on a sell), or in the platform token when
 * the order asks for it (fee-ifc.ts: the service decides, from the owner's terms and the stake). The token is carried
 * only on a plain market or limit order: a stop, an OCO, a bracket, an iceberg or a reduce-only order is placed through
 * an installer that does not carry it, so it is refused here rather than dropped. A market that does not exist is left
 * to the place door. Returns what to carry, or undefined when the order pays in the asset it receives.
 */
async function feeCurrencyFor(
  deps: Pick<PrivateRestDeps, 'marketBySymbol'>,
  body: { symbol: string; side: string; type: string; feeCurrency?: string },
  rawBody: unknown,
): Promise<string | undefined> {
  if (body.feeCurrency === undefined) return undefined;
  const market = await deps.marketBySymbol(body.symbol);
  if (!market) return undefined;
  const received = body.side === 'buy' ? market.baseAsset : market.quoteAsset;
  if (body.feeCurrency.trim().toUpperCase() === received.toUpperCase()) return undefined;
  const raw = rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody) ? Object.keys(rawBody) : [];
  const notPlain = body.type !== 'market' && body.type !== 'limit' ? body.type : raw.find((field) => !PLAIN_ORDER_FIELDS.has(field));
  if (notPlain !== undefined) {
    throw new TradeError(
      `fees on this order are taken in ${received}, the asset it receives; only a plain market or limit order ` +
        `(no ${notPlain}) can pay them in ${body.feeCurrency}`,
      'trade.fee_currency_unsupported',
    );
  }
  return body.feeCurrency;
}

function withFeeCurrency(input: PlaceOrderInput, feeCurrency: string | undefined): PlaceOrderInput {
  return feeCurrency === undefined ? input : { ...input, feeCurrency };
}

export function mapCreateOrderBody(body: CreateOrderRequest, opts: { allowStopLimit?: boolean } = {}): PlaceOrderInput {
  if (!isSpotOrderType(body.type) || (body.type === 'stop_limit' && opts.allowStopLimit !== true)) {
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

  const stopLimit = body.type === 'stop_limit';
  return {
    symbol: body.symbol,
    side: body.side,
    // A stop-limit is placed (and held) as the limit it becomes; the trigger rides as stopPx.
    type: stopLimit ? 'limit' : body.type,
    qty: parseAmount(body.amount),
    price: body.price === undefined ? null : parseAmount(body.price),
    tif,
    clientOrderId: body.clientOrderId,
    subAccountId: body.subAccountId,
    ...(body.tag !== undefined ? { tag: body.tag } : {}),
    ...(stopLimit ? { stopPx: parseAmount(body.stopPrice as string) } : {}),
  } as PlaceOrderInput;
}

/**
 * Attach the request's own placement options to its order input. Refuses a bracket or OCO the body cannot carry
 * here, before any hold. Called only once the caller is signed in and the body has passed the typed schema.
 */
/**
 * OCO and bracket have one door, the create-order route (`allowOco`); replace and batch still refuse them,
 * because they would reach the engine without the single parent hold an OCO needs. A bracket there is an
 * entry plus one sell OCO placed by svc-trade after the entry fills (spot/bracket-place.ts).
 */
function refuseExitLegs(body: unknown, allowOco = false): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  const rec = body as Record<string, unknown>;
  if (!allowOco && readBracketFromBody(rec) !== null) {
    throw new TradeError('bracket and OTO orders are available on the create-order route only', 'trade.order_type_unsupported');
  }
  if (!allowOco && readOcoFromBody(rec) !== null) {
    throw new TradeError('OCO orders are available on the create-order route only', 'trade.order_type_unsupported');
  }
}

/**
 * A trailing stop walks with a mark the server supplies. A `mark` in a request body is refused before any hold: the
 * engine would trigger at a price the caller chose. The `trail` distance is the customer's and goes through.
 */
function refuseClientTrailing(body: unknown): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  if (Object.hasOwn(body, 'mark')) {
    throw new TradeError('the trigger mark is server-side only', 'trade.order_type_unsupported');
  }
}

function carryPlacement(input: PlaceOrderInput, body: unknown, allowOco = false): PlaceOrderInput {
  refuseClientTrailing(body);
  refuseExitLegs(body, allowOco);
  return carryPlacementBody(input, body);
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
  if (rec.price !== undefined && rec.price !== null && typeof rec.price !== 'string') {
    return { ok: false, message: 'price must be a positive decimal string' };
  }
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
  const edgeContext = createEdgeContext({ secret: deps.edgeSecret, ...deps.edgeTrust, serviceName: deps.serviceName });

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
  attachCopyExportRoute(app, deps.copyExport, requirePrincipal);
  attachAlgoRestRoutes(app, deps.algo, { requirePrincipal, requireTradeJurisdiction });
  attachRfqExportRoute(app, deps.rfqExport, requirePrincipal);
  attachStatementRoutes(app, deps.statements, requirePrincipal);

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

  attachGridRestRoutes(app, deps.grid, { requirePrincipal, requireTradeJurisdiction });

  // Mounted only while futures orders go through the book; otherwise the conditional-orders refusal answers the path.
  if (deps.futuresOrders) {
    attachMatchedOrderRoutes(app, deps.futuresOrders, {
      requirePrincipal,
      requireTradeJurisdiction,
      regionOf: (req) => contextFrom(req).region,
      sendDomainError,
    });
  }

  // ── Static paths first (before :id) ───────────────────────────────────────

  app.get<{ Querystring: { limit?: string } }>('/api/v1/admin/orders/open', privateWith('trade:read', 'admin:read'), async (req, reply) => {
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

  app.get('/api/v1/admin/fees', privateWith('trade:read', 'admin:read'), async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    try {
      requireScope(principal, 'admin:read');
      const schedule = deps.feeScheduleNow ? await deps.feeScheduleNow() : deps.feeSchedule;
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

  app.get<{ Querystring: { symbol?: string; limit?: string } }>('/api/v1/orders/open', privateRead, async (req, reply) => {
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
      const withStop = await withStopTriggers(deps, orders);
      const withExit = await withOcoExit(deps, orders);
      const withHeld = await withHold(deps, orders, req.log);
      for (const order of orders) {
        const symbol = await symbolForOrder(order, symbolByMarket, deps.marketById);
        wire.push({ ...withHeld(order, withExit(order, withStop(order, presentCcxtOrder(order, symbol)))), serverTime });
      }
      return reply.code(200).send(wire);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Querystring: ClosedQuery }>('/api/v1/orders/closed', privateRead, async (req, reply) => {
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
    const untilParsed = parseSince(req.query.until);
    if (!untilParsed.ok) {
      return sendCcxt(reply, badRequest(untilParsed.message.replace('since', 'until'), 'trade.invalid_until'));
    }
    if (sinceParsed.sinceMs !== undefined && untilParsed.sinceMs !== undefined && untilParsed.sinceMs < sinceParsed.sinceMs) {
      return sendCcxt(reply, badRequest('until must not be before since', 'trade.invalid_until'));
    }
    const filters = parseClosedFilters(req.query);
    if (!filters.ok) {
      return sendCcxt(reply, badRequest(filters.message, 'trade.invalid_filter'));
    }
    const before = req.query.before;
    if (before !== undefined && before !== '' && !ORDER_ID_SHAPE.test(before)) {
      return sendCcxt(reply, badRequest('before must be the id of an order on the previous page', 'trade.invalid_cursor'));
    }

    try {
      // since/until → SQL on orders.created_at (timestamptz); side and status filter in SQL too.
      const orders = await deps.orderHistory(principal, {
        marketId,
        limit,
        sinceMs: sinceParsed.sinceMs,
        ...(untilParsed.sinceMs !== undefined ? { untilMs: untilParsed.sinceMs } : {}),
        ...(filters.side ? { side: filters.side } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.type ? { type: filters.type } : {}),
        ...(before ? { before } : {}),
      });
      const symbolByMarket = new Map<string, string>();
      const wire = [];
      const withStop = await withStopTriggers(deps, orders);
      const withExit = await withOcoExit(deps, orders);
      const withHeld = await withHold(deps, orders, req.log);
      for (const order of orders) {
        const symbol = await symbolForOrder(order, symbolByMarket, deps.marketById);
        wire.push(withHeld(order, withExit(order, withStop(order, presentCcxtOrder(order, symbol)))));
      }
      return reply.code(200).send(wire);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Querystring: { symbol?: string; limit?: string; since?: string } }>(
    '/api/v1/account/trades',
    privateRead,
    async (req, reply) => {
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
    },
  );

  /**
   * The rates this caller pays, once per listed symbol: the owner schedule in force at the caller's fee tier (the last
   * finished snapshot, as placement reads it) less its rank discount, the same bps the order check returns as `feeBps`
   * for an order on the account itself (a sub-account's orders are charged the regular tier, as placement does).
   * Listing-row maker_bps/taker_bps are not this schedule. Empty listing → `{}`. Unpublished schedule with symbols
   * listed → `trade.fee_schedule_blank`; a tier or rank read that fails refuses rather than answer the regular rate.
   * The volume behind the tier is `GET /api/v1/account/fee-tier`.
   */
  app.get('/api/v1/account/fees', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    try {
      requireScope(principal, 'trade:read');
      const listed = await deps.markets(MARKETS_LIMIT_MAX);
      if (listed.length === 0) return reply.code(200).send({});
      const schedule = deps.feeScheduleNow ? await deps.feeScheduleNow() : deps.feeSchedule;
      if (!schedule || schedule.published !== true) {
        return reply.code(503).send({
          code: 'ExchangeNotAvailable',
          message: 'published fee schedule is unavailable',
          intafacedCode: 'trade.fee_schedule_blank',
        });
      }
      // Read together. The tier is matched against the schedule just read, so the rows it names are the ones in force;
      // it is read only when a live spot market is listed, since nothing else is tiered.
      const refuse = (message: string, intafacedCode: string) =>
        reply.code(503).send({ code: 'ExchangeNotAvailable', message, intafacedCode });
      const [tier, discount] = await Promise.allSettled([
        deps.feeTier && listed.some(tieredMarket) ? deps.feeTier(principal.userId, schedule) : Promise.resolve(REGULAR_FEE_TIER),
        deps.feeDiscountBps ? deps.feeDiscountBps(principal.userId) : Promise.resolve(0),
      ]);
      if (tier.status === 'rejected') {
        req.log.warn({ err: tier.reason }, 'fee tier read failed; the fee read refuses');
        return refuse('fee tier is unavailable', 'trade.fee_tier_unavailable');
      }
      // A discount outside 0..9999 bps is not one the fill path would take: refuse rather than drop every market.
      if (discount.status === 'rejected' || !Number.isInteger(discount.value) || discount.value < 0 || discount.value >= 10_000) {
        req.log.warn(
          { err: discount.status === 'rejected' ? discount.reason : discount.value },
          'rank discount read failed; the fee read refuses',
        );
        return refuse('rank discount is unavailable', 'trade.perks_unavailable');
      }
      const tierId = tier.value;
      const discountBps = discount.value;
      return reply.code(200).send(presentAccountFees(listed, schedule, { tierId, discountBps }));
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * The published schedule for anyone, signed in or not: per listed market the regular-tier rate before any rank
   * discount (spot from its pair-group row, futures from the `perpetual` block, options left out), with the schedule
   * version, and the whole
   * schedule by pair group and tier (`groups`, `tiers`) for the public fee page. Strategy backtests in svc-quant price
   * their simulated fills with `fees`. Unpublished refuses `trade.fee_schedule_blank`; a
   * market whose row refuses is left out, never shown at zero. An empty listing answers an empty `fees` map.
   */
  app.get('/api/v1/fees/published', publicRead, async (_req, reply) => {
    try {
      const schedule = deps.feeScheduleNow ? await deps.feeScheduleNow() : deps.feeSchedule;
      if (!schedule || schedule.published !== true) {
        return reply.code(503).send({
          code: 'ExchangeNotAvailable',
          message: 'published fee schedule is unavailable',
          intafacedCode: 'trade.fee_schedule_blank',
        });
      }
      const listed = await deps.markets(MARKETS_LIMIT_MAX);
      const fees: Record<string, { makerBps: number; takerBps: number }> = {};
      for (const [symbol, row] of Object.entries(presentAccountFees(listed, schedule))) {
        fees[symbol] = { makerBps: row.makerBps, takerBps: row.takerBps };
      }
      const spotSymbols = listed.filter((market) => market.kind === 'spot').map((market) => market.symbol);
      // Paying a spot fee in the platform token: the owner's terms as published, or null (the desk then says why not).
      const feeToken = schedule.ifcFee ? { asset: schedule.ifcFee.tokenAsset, perUnit: schedule.ifcFee.perUnit } : null;
      return reply.code(200).send({ version: schedule.version, fees, ...publicFeeSchedule(schedule, spotSymbols), feeToken });
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Params: { symbol: string } }>('/api/v1/account/market-lifecycle/:symbol', privateRead, async (req, reply) => {
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
  app.get('/api/v1/account/balance', privateRead, async (req, reply) => {
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
  app.get<{ Querystring: { symbol?: string; clientOpenId?: string } }>('/api/v1/positions', privateRead, async (req, reply) => {
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
  app.get<{ Querystring: { symbol?: string; limit?: string; since?: string } }>(
    '/api/v1/positions/closed',
    privateRead,
    async (req, reply) => {
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
    },
  );

  /**
   * Open a funded futures position (margin via ledger recipes).
   *
   * The entry price is NOT a parameter. It is read from the mark source, and a
   * body that carries one is refused before anything is locked.
   */
  app.post('/api/v1/positions', privateWrite, async (req, reply) => {
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
      if (!reduceOnly) {
        const stored = deps.readAccountMode ? await deps.readAccountMode(principal) : null;
        const decision = resolveOpenPositionMode({
          requested: body.positionMode,
          stored: stored?.mode ?? null,
        });
        if (!decision.ok) {
          return reply.code(400).send({ error: decision.code, message: decision.reason });
        }
        if (body.positionMode != null || stored?.mode != null) positionMode = decision.mode;
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
        region: contextFrom(req).region,
      });
      return reply.code(200).send(pos);
    } catch (err) {
      if (isDerivativesAccessError(err)) {
        return reply.code(err.status).send(presentDerivativesAccessError(err));
      }
      if (err instanceof FuturesError) {
        if (isRolledBackMarkRefusal(err.code)) return reply.code(409).send(presentRolledBackRefusal(err));
        return reply.code(err.status).send(presentFuturesErrorWire(err));
      }
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /**
   * DIRECTION:34 — in-product ADL disclosure (copy + ack state). Product information:
   * no open waits on the ack (owner decision 2026-10-27, until launch prep).
   */
  app.get('/api/v1/futures/adl-disclosure', privateRead, async (req, reply) => {
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

  app.post('/api/v1/futures/adl-disclosure/ack', privateWrite, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    try {
      requireScope(principal, 'trade:write');
      const wire = await deps.ackAdlDisclosure(principal);
      return reply.code(200).send(wire);
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /** D-ops-01: each futures contract open or blocked for this account, with every reason. A read; it opens nothing. */
  app.get('/api/v1/account/gated-list', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    try {
      requireScope(principal, 'trade:read');
      if (!deps.gatedList)
        return reply.code(503).send({ error: 'trade.gated_list_unmounted', message: 'The gated list is not wired on this deployment.' });
      const contracts = await deps.gatedList({
        userId: principal.userId,
        tier: principal.tier ?? null,
        region: contextFrom(req).region ?? null,
      });
      return reply.code(200).send({ contracts });
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/api/v1/futures/adl-events', privateRead, async (req, reply) => {
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

  app.get<{ Params: { id: string } }>('/api/v1/positions/:id/liquidation', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.positionLiquidation) {
      return reply.code(503).send({
        error: 'trade.liquidations_unwired',
        message: 'the position liquidation timeline is not wired on this process',
      });
    }
    try {
      requireScope(principal, 'trade:read');
      return reply.code(200).send(await deps.positionLiquidation(principal, req.params.id));
    } catch (err) {
      if (err instanceof FuturesError) return reply.code(err.status).send(presentFuturesErrorWire(err));
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get('/api/v1/futures/liquidations', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.listLiquidations) {
      return reply.code(503).send({
        error: 'trade.liquidations_unwired',
        message: 'liquidation history is not wired on this process',
      });
    }
    try {
      requireScope(principal, 'trade:read');
      return reply.code(200).send(await deps.listLiquidations(principal));
    } catch (err) {
      if (err instanceof FuturesError) return reply.code(err.status).send(presentFuturesErrorWire(err));
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get('/api/v1/futures/payouts', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.listFuturesPayouts) {
      return reply.code(503).send({
        error: 'trade.futures_payouts_unwired',
        message: 'futures payout history is not wired on this process',
      });
    }
    try {
      requireScope(principal, 'trade:read');
      return reply.code(200).send(await deps.listFuturesPayouts(principal));
    } catch (err) {
      if (err instanceof FuturesError) return reply.code(err.status).send(presentFuturesErrorWire(err));
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { cursor?: string } }>(
    '/api/v1/positions/:id/funding-payments',
    privateRead,
    async (req, reply) => {
      const principal = requirePrincipal(req, reply);
      if (!principal) return;
      if (!deps.listFundingPayments) {
        return reply.code(503).send({
          error: 'trade.funding_payments_unwired',
          message: 'funding payment history is not wired on this process',
        });
      }
      try {
        requireScope(principal, 'trade:read');
        return reply.code(200).send(await deps.listFundingPayments(principal, req.params.id, req.query.cursor));
      } catch (err) {
        if (err instanceof FuturesError) return reply.code(err.status).send(presentFuturesErrorWire(err));
        const sent = sendDomainError(reply, err);
        if (sent) return sent;
        throw err;
      }
    },
  );

  /**
   * Delivered margin call for one position (D26-P1-T1b / DIRECTION MVP-2).
   *
   * The liquidation tick raises + delivers into the durable store; this door
   * is how the trader observes it. 404 when none is open (or not theirs) —
   * never a fabricated healthy "no call" body that could be confused with a
   * delivered warning. Undelivered attempts are not exposed here.
   */
  app.get<{ Params: { id: string } }>('/api/v1/positions/:id/margin-call', privateRead, async (req, reply) => {
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
  app.get<{ Params: { id: string } }>('/api/v1/positions/:id', privateRead, async (req, reply) => {
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
  app.delete<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>(
    '/api/v1/positions/:id',
    privateWrite,
    async (req, reply) => {
      const principal = requirePrincipal(req, reply);
      if (!principal) return;
      if (!requireTradeJurisdiction(req, reply, principal)) return;

      try {
        requireScope(principal, 'trade:write');

        const supplied = suppliedPriceFields(req.query as Record<string, unknown> | undefined);
        if (supplied.length > 0) {
          return reply.code(400).send(priceNotAcceptedBody(supplied));
        }

        // Cancel and close are different calls. DELETE does not run closeAtomically
        // and does not release margin. The close routes do.
        return reply.code(400).send({
          error: CANCEL_NOT_CLOSE,
          message: 'DELETE /api/v1/positions/:id does not close a position or release margin. Close on POST /api/v1/positions/:id/close.',
        });
      } catch (err) {
        if (err instanceof FuturesError) {
          return reply.code(err.status).send(presentFuturesErrorWire(err));
        }
        const sent = sendDomainError(reply, err);
        if (sent) return sent;
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/positions/:id/close', privateWrite, async (req, reply) => {
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
      if (err instanceof FuturesError) {
        if (isRolledBackMarkRefusal(err.code)) return reply.code(409).send(presentRolledBackRefusal(err));
        return reply.code(err.status).send(presentFuturesErrorWire(err));
      }
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.post('/api/v1/futures/positions/close-all', privateWrite, async (req, reply) => {
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
      if (err instanceof FuturesError) {
        if (isRolledBackMarkRefusal(err.code)) return reply.code(409).send(presentRolledBackRefusal(err));
        return reply.code(err.status).send(presentFuturesErrorWire(err));
      }
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.get('/api/v1/futures/margin-summary', privateRead, async (req, reply) => {
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

  app.get('/api/v1/futures/position-mode', privateRead, async (req, reply) => {
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

  app.put('/api/v1/futures/position-mode', privateWrite, async (req, reply) => {
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
  const setMarginModeArm = refuseArmById('setMarginMode');
  if (!setMarginModeArm || setMarginModeArm.httpStatus !== 501 || setMarginModeArm.ccxtCode !== 'NotSupported') {
    throw new Error('ccxt matrix setMarginMode must stay 501 NotSupported — isolated-at-open only');
  }

  const leverageHandler = async (req: FastifyRequest, reply: FastifyReply) => {
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
      if (!positionId) {
        return reply.code(400).send({
          ...badRequest('positionId is required for a retry-safe margin mutation', 'trade.position_id_required').body,
        });
      }
      // Both doors. Inventing `leverage:${raw}` replayed a stored adjustment
      // when a later set used the same leverage (salvage F0337 / c8246a4b).
      const clientAdjustmentId = typeof body.clientAdjustmentId === 'string' ? body.clientAdjustmentId.trim() : '';
      if (!clientAdjustmentId) {
        return reply.code(400).send({
          ...badRequest('clientAdjustmentId is required for retry-safe margin mutation', 'trade.idempotency_key_required').body,
        });
      }

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

  app.post('/api/v1/positions/leverage', privateWrite, async (req, reply) => leverageHandler(req, reply));
  app.post('/api/v1/futures/leverage', privateWrite, async (req, reply) => leverageHandler(req, reply));

  app.post('/api/v1/positions/margin', privateWrite, async (req, reply) => {
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

  app.post('/api/v1/positions/margin/reduce', privateWrite, async (req, reply) => {
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
  const derivativesNotSupported = (_arm: 'setMarginMode') => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const principal = requirePrincipal(req, reply);
      if (!principal) return;
      try {
        requireScope(principal, 'trade:write');
      } catch (err) {
        const sent = sendDomainError(reply, err);
        if (sent) return sent;
        throw err;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const to = typeof body.marginMode === 'string' ? body.marginMode.trim() : body.marginMode;
      if (deps.marginModeAudit) {
        // Eligible plus a named preview lets the audit record the product refusal
        // (cross / portfolio). The preview is not applied. The response stays 501.
        await attemptMarginModeSwitch(
          {
            from: 'isolated',
            to,
            hasOpenRisk: true,
            eligible: true,
            migrationPreviewId: 'live-switch-not-offered',
            positionId: typeof body.positionId === 'string' ? body.positionId : null,
            userId: principal.userId,
          },
          deps.marginModeAudit,
        );
      }
      return sendCcxt(reply, notSupported('setMarginMode is not available: set margin mode at open', setMarginModeArm.intafacedCode));
    };
  };
  app.post('/api/v1/positions/margin-mode', privateWrite, derivativesNotSupported('setMarginMode'));

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
  app.post('/api/v1/orders/batch', privateWrite, async (req, reply) => {
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
        results.push({ ...base, status: 'refused', error: createBodyRefusal(parsed.error, 'invalid create order body') });
        continue;
      }

      let input: PlaceOrderInput;
      try {
        refuseExitLegs(rawItem);
        const now = (deps.now ?? (() => new Date()))();
        const replay = await isDeadlineReplay(deps, principal, parsed.data, now);
        refuseUnsupportedPlacementOptions(parsed.data, now, replay);
        input = withFeeCurrency(mapCreateOrderBody(parsed.data), await feeCurrencyFor(deps, parsed.data, rawItem));
      } catch (err) {
        const mapped = toCcxtError(err);
        if (mapped?.body.intafacedCode === SETTLEMENT_PENDING) {
          // The engine may have acted: never report it as refused.
          results.push({ ...base, status: 'unknown', error: mapped.body });
          continue;
        } else if (mapped) {
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
        if (mapped?.body.intafacedCode === SETTLEMENT_PENDING) {
          // The engine may have acted: never report it as refused.
          results.push({ ...base, status: 'unknown', error: mapped.body });
        } else if (mapped) {
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
  app.post('/api/v1/orders/batch-amend', privateWrite, async (req, reply) => {
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

  /**
   * POST /api/v1/orders/batch-cancel — bounded, sequential cancel of an id list.
   *
   * Auth, scope and jurisdiction are request-wide, checked before any item. Each id then takes the same
   * TradeService.cancelOrder path as DELETE /orders/:id (engine first, hold release second). Results are ordered
   * and independent: a refusal or unresolved cancel never rewrites an earlier item and there is no rollback or
   * atomicity promise. Body: `{ ids: [...] }`, `{ orders: [{ id }|"id"] }`, or a bare array of ids.
   */
  app.post('/api/v1/orders/batch-cancel', privateWrite, async (req, reply) => {
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
    const container =
      body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as { ids?: unknown; orders?: unknown }) : null;
    const rawItems = Array.isArray(body)
      ? body
      : Array.isArray(container?.ids)
        ? container.ids
        : Array.isArray(container?.orders)
          ? container.orders
          : null;
    if (rawItems === null) {
      return reply
        .code(400)
        .send(invalidOrder('batch cancel body must be an array or an object with an ids array', 'trade.batch_body_invalid').body);
    }
    if (rawItems.length === 0) {
      return reply.code(400).send(invalidOrder('batch cancel ids must be non-empty', 'trade.batch_empty').body);
    }
    if (rawItems.length > MAX_BATCH_ORDERS) {
      return reply.code(400).send(invalidOrder(`batch cancel may contain at most ${MAX_BATCH_ORDERS} items`, 'trade.batch_too_large').body);
    }

    const results: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const [index, rawItem] of rawItems.entries()) {
      const idRaw =
        typeof rawItem === 'string'
          ? rawItem
          : rawItem !== null && typeof rawItem === 'object'
            ? ((rawItem as { id?: unknown; orderId?: unknown }).id ?? (rawItem as { orderId?: unknown }).orderId)
            : null;
      const orderId = typeof idRaw === 'string' && idRaw.length > 0 ? idRaw : null;
      const base = { index, orderId };
      if (orderId === null) {
        results.push({ ...base, status: 'refused', error: invalidOrder('id must be a non-empty order id', 'trade.invalid_order_id').body });
        continue;
      }
      if (seen.has(orderId)) {
        results.push({ ...base, status: 'refused', error: invalidOrder('order id repeated in this batch', 'trade.batch_duplicate').body });
        continue;
      }
      // Order ids are uuids. Anything else is no order of the caller's: refused as not found, never sent to the cancel
      // path, where the database would refuse the id and the item would read as an unknown outcome.
      if (!ORDER_ID_SHAPE.test(orderId)) {
        const notFound = toCcxtError(new TradeError(`order ${orderId} not found`, 'trade.order_not_found'));
        results.push({ ...base, status: 'refused', error: notFound?.body });
        continue;
      }
      seen.add(orderId);
      try {
        const order = await deps.cancelOrder(principal, orderId);
        const market = await deps.marketById(order.marketId);
        const symbol = market?.symbol ?? order.marketId;
        const wire = presentCcxtOrder(order, symbol);
        if (wire.executionOutcome !== null) {
          results.push({ ...base, status: 'unknown', order: wire, evidence: wire.executionOutcome });
        } else if (order.status === 'open' || order.status === 'pending' || order.status === 'recovery_required') {
          // The order stays with its hold until a fill the engine matched lands (#6874): not a success to re-place on.
          results.push({
            ...base,
            status: 'unknown',
            order: wire,
            error: {
              code: 'ExchangeError',
              message: 'the cancel waits for a fill the engine matched; read the order to reconcile',
              intafacedCode: 'trade.cancel_ahead_of_fill',
            },
          });
        } else {
          results.push({ ...base, status: 'success', order: wire });
        }
      } catch (err) {
        const mapped = toCcxtError(err);
        if (mapped?.body.intafacedCode === SETTLEMENT_PENDING) {
          // The engine may have acted: never report it as refused.
          results.push({ ...base, status: 'unknown', error: mapped.body });
        } else if (mapped) {
          results.push({ ...base, status: 'refused', error: mapped.body });
        } else {
          results.push({
            ...base,
            status: 'unknown',
            error: {
              code: 'ExchangeError',
              message: 'batch item outcome is unknown; read the order to reconcile',
              intafacedCode: 'trade.batch_outcome_unknown',
            },
          });
        }
      }
    }

    return reply.code(200).send({ atomic: false, results });
  });

  app.post('/api/v1/orders', privateWrite, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    // A stop-market is placed as the stop-limit it becomes, at the owner's protection price from its stop.
    let rawBody: unknown = req.body;
    let stopKind: StopKind = 'stop_limit';
    try {
      const stopMarket = deps.stopTriggers ? await stopMarketOf(deps, req.body) : null;
      if (stopMarket) {
        rawBody = stopMarket.body;
        stopKind = 'stop';
      }
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }

    const parsed = createOrderRequestSchema.safeParse(schemaBodyOf(rawBody));
    if (!parsed.success) {
      // CCXT `InvalidOrder`, not `BadRequest`: it is specifically the order
      // that is wrong, and that is the branch a client's order-builder listens
      // on. `errors` lists every bad field in one body (DV-errors-01).
      return reply.code(400).send(createBodyRefusal(parsed.error, 'invalid create order body'));
    }

    let input: PlaceOrderInput;
    let displayQty: string | null = null;
    let icebergMarketId: string | null = null;
    let stopTrigger: string | null = null;
    try {
      const now = (deps.now ?? (() => new Date()))();
      const replay = await isDeadlineReplay(deps, principal, parsed.data, now);
      refuseUnsupportedPlacementOptions(parsed.data, now, replay);
      const feeCurrency = await feeCurrencyFor(deps, parsed.data, rawBody);
      input = carryPlacement(
        withFeeCurrency(mapCreateOrderBody(parsed.data, { allowStopLimit: deps.stopTriggers !== undefined }), feeCurrency),
        rawBody,
        true,
      );
      const attached = await attachIcebergDisplay(deps, input, parsed.data, readRawDisplayQty(rawBody));
      input = attached.input;
      displayQty = attached.displayQty;
      icebergMarketId = attached.marketId;
      if (deps.stopTriggers && parsed.data.type !== 'stop_limit' && hasRawStopPx(rawBody)) {
        throw new TradeError('a stop is placed as type stop_limit with a stopPrice', TRADE_STOP_TRIGGER_INVALID);
      }
      if (deps.stopTriggers && parsed.data.type !== 'stop_limit') {
        // An id that already carries a trigger belongs to a stop; a plain order must not reuse it.
        const market = await deps.marketBySymbol(parsed.data.symbol);
        if (market && (await deps.stopTriggers.read(orderIdFor(principal.userId, market.id, parsed.data.clientOrderId)))) {
          throw new TradeError('this clientOrderId was already used for a stop-limit', TRADE_STOP_TRIGGER_INVALID);
        }
      }
      if (parsed.data.type === 'stop_limit' && deps.stopTriggers) {
        if (displayQty) throw new TradeError('a stop-limit cannot be an iceberg', TRADE_STOP_TRIGGER_INVALID);
        const market = await deps.marketBySymbol(parsed.data.symbol);
        if (!market) throw new TradeError(`market ${parsed.data.symbol} not found`, 'trade.market_not_found');
        const trigger = (input as PlaceOrderInput & { stopPx: Amount }).stopPx;
        assertStopTrigger(trigger, market.tickSize);
        // Written before the hold: a crash after the hold must never leave a live
        // order without its trigger. A replay keeps the first trigger.
        const orderId = orderIdFor(principal.userId, market.id, input.clientOrderId as string);
        // An order already placed under this id without a trigger is not a stop; do not relabel it.
        if (deps.findClientOrder && !(await deps.stopTriggers.read(orderId))) {
          const existing = await deps.findClientOrder(principal, {
            symbol: input.symbol,
            marketId: market.id,
            clientOrderId: input.clientOrderId,
          });
          if (existing) throw new TradeError('this clientOrderId was already used for a non-stop order', TRADE_STOP_TRIGGER_INVALID);
        }
        stopTrigger = await deps.stopTriggers.remember(orderId, principal.userId, formatAmount(trigger), stopKind);
        if (stopTrigger !== formatAmount(trigger)) {
          throw new TradeError('this clientOrderId was already used with a different stopPrice', TRADE_STOP_TRIGGER_INVALID);
        }
      }
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }

    try {
      const place = async (): Promise<OrderRecord> => {
        // Read inside the account's turn on the market, so a re-send racing its first request finds the order that won.
        const prior =
          displayQty && deps.findClientOrder
            ? await deps.findClientOrder(principal, { symbol: input.symbol, marketId: input.marketId, clientOrderId: input.clientOrderId })
            : null;
        let order: OrderRecord;
        try {
          order = await deps.placeOrder(principal, input);
        } catch (placeErr) {
          if (displayQty && deps.icebergDisplay && deps.findClientOrder && prior == null) {
            try {
              const row = await deps.findClientOrder(principal, {
                symbol: input.symbol,
                marketId: input.marketId,
                clientOrderId: input.clientOrderId,
              });
              if (row) await deps.icebergDisplay.remember(row.id, principal.userId, displayQty);
            } catch {
              // The customer's answer stays the original place error.
            }
          }
          throw placeErr;
        }
        if (displayQty && deps.icebergDisplay) {
          if (deps.findClientOrder && prior) {
            const storedPeak = await deps.icebergDisplay.read(order.id);
            if (!storedPeak) {
              throw new TradeError(
                'iceberg displayQty cannot be added to an order that was not placed as an iceberg',
                TRADE_ICEBERG_DISPLAY_INVALID,
              );
            }
          } else {
            await deps.icebergDisplay.remember(order.id, principal.userId, displayQty);
          }
        }
        return order;
      };
      // A new iceberg takes the account's one slot on its market; a re-send of the same request keeps the slot it holds.
      const order =
        displayQty && deps.icebergDisplay && icebergMarketId
          ? await deps.icebergDisplay.oneLivePerMarket(
              {
                userId: principal.userId,
                marketId: icebergMarketId,
                symbol: parsed.data.symbol,
                clientOrderId: input.clientOrderId ?? null,
              },
              place,
            )
          : await place();
      const stored = deps.icebergDisplay ? await deps.icebergDisplay.read(order.id) : displayQty;
      const market = await deps.marketById(order.marketId);
      const symbol = market?.symbol ?? parsed.data.symbol;
      // An OTO entry answers with its attached close, as every read of it does.
      const wire = (await withOcoExit(deps, [order]))(order, presentCcxtOrder(order, symbol));
      if (stopTrigger) return reply.code(201).send({ ...wire, type: stopKind, stopPrice: stopTrigger, triggered: null });
      return reply.code(201).send(stored ? { ...wire, displayQty: stored } : wire);
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
  app.post<{ Params: { marketId: string } }>('/api/v1/markets/:marketId/orders/mass-cancel', privateWrite, async (req, reply) => {
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

  // ── Cancel-all-after (dead-man switch) ────────────────────────────────────

  /**
   * POST /api/v1/orders/cancel-all-after { timeout: <whole seconds> }.
   *
   * Arms the caller's countdown; calling again before the deadline pushes it out, and `timeout: 0` disarms it.
   * When the deadline passes the sweep cancels every open order of the caller. The allowed timeouts are the
   * owner's published set (blank = typed refusal); the credential must outlive the deadline.
   */
  /**
   * GET /api/v1/orders/cancel-all-after: the caller's countdown (armed, timeout, triggerTime) and the timeouts the owner
   * has published (`timeouts`, null while none are). The desk reads it to offer only published values and to show
   * the trigger time after a reload.
   */
  app.get('/api/v1/orders/cancel-all-after', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.readCancelAllAfter) {
      return sendCcxt(reply, badRequest('cancel-all-after is not available on this venue', 'trade.cancel_all_after_unset'));
    }
    try {
      const out = await deps.readCancelAllAfter(principal);
      return reply.code(200).send({
        armed: out.armed,
        timeout: out.timeoutSec,
        triggerTime: out.deadline ? out.deadline.toISOString() : null,
        timeouts: out.published ? [...out.published] : null,
      });
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.post('/api/v1/orders/cancel-all-after', privateWrite, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;
    if (!deps.armCancelAllAfter) {
      return sendCcxt(reply, badRequest('cancel-all-after is not available on this venue', 'trade.cancel_all_after_unset'));
    }
    const body = req.body as { timeout?: unknown } | null;
    const timeout = body?.timeout;
    if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout)) {
      return reply.code(400).send(invalidOrder('timeout must be a whole number of seconds', 'trade.cancel_all_after_rejected').body);
    }
    try {
      const out = await deps.armCancelAllAfter(principal, timeout);
      return reply.code(200).send({
        armed: out.armed,
        timeout: out.timeoutSec,
        triggerTime: out.deadline ? out.deadline.toISOString() : null,
      });
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  // ── Cancel all (static path — before :id is fine; Fastify matches exact) ──

  /**
   * DELETE /api/v1/orders[?symbol=][&kind=spot|futures|options] → TradeService.cancelAllOrders.
   * Same money path as single cancel (engine first, finalize second), sequential.
   * trade:write is enforced inside TradeService; jurisdiction here matches create/cancel.
   * `kind` keeps the cancel to one product ("spot only"); any other value is refused, never read as "all".
   */
  app.delete<{ Querystring: { symbol?: string; kind?: string } }>('/api/v1/orders', privateWrite, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    const kindRaw = req.query.kind;
    if (kindRaw !== undefined && kindRaw !== 'spot' && kindRaw !== 'futures' && kindRaw !== 'options') {
      return sendCcxt(reply, badRequest('kind must be spot, futures or options', 'trade.invalid_filter'));
    }

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
      const cancelled = await deps.cancelAllOrders(principal, marketId, kindRaw);
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
  app.post<{ Params: { id: string } }>('/api/v1/orders/:id/replace', privateWrite, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;
    if (!deps.replaceOrder) {
      return reply.code(503).send({ error: 'order replacement is not configured', code: 'trade.replace_unconfigured' });
    }

    // A stop's trigger is changed by replacing the stop with one at the new trigger (J-cex-spot-08 #3): the original's
    // hold is released before the replacement takes its own, sized at the new limit or protection price.
    let rawBody: unknown = req.body;
    let stopKind: StopKind = 'stop_limit';
    try {
      const stopMarket = deps.stopTriggers ? await stopMarketOf(deps, req.body) : null;
      if (stopMarket) {
        rawBody = stopMarket.body;
        stopKind = 'stop';
      }
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }

    const parsed = createOrderRequestSchema.safeParse(schemaBodyOf(rawBody));
    if (!parsed.success) {
      // The same one body as create: every bad field listed (DV-errors-01).
      return reply.code(400).send(createBodyRefusal(parsed.error, 'invalid replacement order body'));
    }

    let input: PlaceOrderInput;
    try {
      refuseOptionsOnReplacement(parsed.data);
      if (hasSpentExpiry(parsed.data, (deps.now ?? (() => new Date()))())) {
        throw new TradeError('the order expiry is not in the future; nothing was replaced', 'trade.invalid_expiry');
      }
      // Replace has no stop door: a raw stopPx would reach the engine with no stored trigger.
      if (hasRawStopPx(req.body)) {
        throw new TradeError('a stop cannot be set on an order replacement', TRADE_STOP_TRIGGER_INVALID);
      }
      // An iceberg is placed only through the create door, which keeps its peak and its one slot per market.
      if (
        readRawDisplayQty(req.body) !== undefined ||
        (req.body !== null && typeof req.body === 'object' && Object.hasOwn(req.body, 'iceberg'))
      ) {
        throw new TradeError(
          'an iceberg cannot be set on an order replacement; cancel it and place the new iceberg',
          TRADE_ICEBERG_DISPLAY_INVALID,
        );
      }
      // The original is cancelled before the replacement is placed; a trailing stop that could then be refused for want
      // of a mark would leave the customer with neither order.
      if (req.body !== null && typeof req.body === 'object' && Object.hasOwn(req.body, 'trail')) {
        throw new TradeError('a trailing stop cannot be set on an order replacement', 'trade.order_type_unsupported');
      }
      const stopReplacement = parsed.data.type === 'stop_limit' && deps.stopTriggers !== undefined;
      if (deps.stopTriggers) {
        // Only a stop's trigger is changed this way, and only into the same kind of stop. A resting limit swapped for a
        // dormant stop, or a stop for a live limit at its protection price, is a different order: cancel and place it.
        const originalId = req.params.id;
        const originalStop = (await deps.stopTriggers.readMany([originalId])).has(originalId);
        const originalKind: StopKind | null = !originalStop
          ? null
          : (await deps.stopTriggers.readStopMarkets([originalId])).has(originalId)
            ? 'stop'
            : 'stop_limit';
        const replacementKind: StopKind | null = stopReplacement ? stopKind : null;
        if (originalKind !== replacementKind) {
          // One wording either way: the refusal never says what kind of order an id is before the saga checks its owner.
          throw new TradeError(
            'a replacement keeps the kind of the order it replaces (only a stop changes its trigger this way); cancel it and place the new order',
            TRADE_STOP_TRIGGER_INVALID,
          );
        }
      }
      input = carryPlacement(mapCreateOrderBody(parsed.data, { allowStopLimit: stopReplacement }), rawBody);
      if (stopReplacement && deps.stopTriggers) {
        const market = await deps.marketBySymbol(parsed.data.symbol);
        if (!market) throw new TradeError(`market ${parsed.data.symbol} not found`, 'trade.market_not_found');
        const trigger = (input as PlaceOrderInput & { stopPx: Amount }).stopPx;
        assertStopTrigger(trigger, market.tickSize);
        // Written before the original is cancelled: the replacement must never reach the engine without its trigger.
        const replacementId = orderIdFor(principal.userId, market.id, replacementClientOrderId(parsed.data.clientOrderId));
        const stored = await deps.stopTriggers.remember(replacementId, principal.userId, formatAmount(trigger), stopKind);
        if (stored !== formatAmount(trigger)) {
          throw new TradeError('this replacement key was already used with a different stopPrice', TRADE_STOP_TRIGGER_INVALID);
        }
      }
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }

    try {
      const outcome = await deps.replaceOrder(principal, req.params.id, input);
      const originalMarket = await deps.marketById(outcome.original.marketId);
      const replacementMarket = outcome.replacement === null ? originalMarket : await deps.marketById(outcome.replacement.marketId);
      const presented = presentReplaceOutcome(
        outcome,
        originalMarket?.symbol ?? outcome.original.marketId,
        replacementMarket?.symbol ?? outcome.replacement?.marketId ?? outcome.original.marketId,
      );
      // Both stops answer as the stops they are (kind, trigger, whether it fired), as every other read of them does.
      const asStop = await withStopTriggers(deps, outcome.replacement ? [outcome.original, outcome.replacement] : [outcome.original]);
      return reply.code(200).send({
        ...presented,
        original: asStop(outcome.original, presented.original),
        replacement:
          outcome.replacement && presented.replacement ? asStop(outcome.replacement, presented.replacement) : presented.replacement,
      });
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
  app.patch<{ Params: { id: string } }>('/api/v1/orders/:id', privateWrite, async (req, reply) => {
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

  // ── By client order id ────────────────────────────────────────────────────
  // A client id is unique per market (it keys the order id with the user and the market), so the symbol is required.

  async function orderByClientId(
    principal: Principal,
    req: { params: { clientOrderId: string }; query: { symbol?: string } },
    reply: FastifyReply,
  ): Promise<OrderRecord | null> {
    const symbolRaw = req.query.symbol;
    if (symbolRaw === undefined || symbolRaw === '') {
      sendCcxt(reply, badRequest('symbol is required: a clientOrderId is unique per market', 'trade.order_symbol_required'));
      return null;
    }
    const symbol = decodeURIComponent(symbolRaw);
    const market = await deps.marketBySymbol(symbol);
    if (!market) {
      sendCcxt(reply, badSymbol(symbol));
      return null;
    }
    const order = deps.findClientOrder
      ? await deps.findClientOrder(principal, { marketId: market.id, symbol, clientOrderId: req.params.clientOrderId })
      : null;
    if (!order) {
      throw new TradeError('order not found', 'trade.order_not_found');
      return null;
    }
    return order;
  }

  for (const path of ['/api/v1/orders/by-client-id/:clientOrderId', '/api/v1/orders/by-client/:clientOrderId']) {
    app.get<{ Params: { clientOrderId: string }; Querystring: { symbol?: string } }>(path, privateRead, async (req, reply) => {
      const principal = requirePrincipal(req, reply);
      if (!principal) return;
      try {
        requireScope(principal, 'trade:read');
        const found = await orderByClientId(principal, req, reply);
        if (!found) return reply;
        const order = await deps.getOrder(principal, found.id);
        const market = await deps.marketById(order.marketId);
        const symbol = market?.symbol ?? order.marketId;
        const withStop = await withStopTriggers(deps, [order]);
        const withExit = await withOcoExit(deps, [order]);
        const withHeld = await withHold(deps, [order], req.log);
        return reply.code(200).send(withHeld(order, withExit(order, withStop(order, presentCcxtOrder(order, symbol)))));
      } catch (err) {
        const sent = sendDomainError(reply, err);
        if (sent) return sent;
        throw err;
      }
    });

    app.delete<{ Params: { clientOrderId: string }; Querystring: { symbol?: string } }>(path, privateWrite, async (req, reply) => {
      const principal = requirePrincipal(req, reply);
      if (!principal) return;
      if (!requireTradeJurisdiction(req, reply, principal)) return;
      try {
        requireScope(principal, 'trade:write');
        const found = await orderByClientId(principal, req, reply);
        if (!found) return reply;
        const order = await deps.cancelOrder(principal, found.id);
        const market = await deps.marketById(order.marketId);
        const symbol = market?.symbol ?? order.marketId;
        const withStop = await withStopTriggers(deps, [order]);
        const withExit = await withOcoExit(deps, [order]);
        const withHeld = await withHold(deps, [order], req.log);
        return reply.code(200).send(withHeld(order, withExit(order, withStop(order, presentCcxtOrder(order, symbol)))));
      } catch (err) {
        const sent = sendDomainError(reply, err);
        if (sent) return sent;
        throw err;
      }
    });
  }

  // ── By id ─────────────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>('/api/v1/orders/:id', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;

    try {
      const order = await deps.getOrder(principal, req.params.id);
      const market = await deps.marketById(order.marketId);
      const symbol = market?.symbol ?? order.marketId;
      const withStop = await withStopTriggers(deps, [order]);
      const withExit = await withOcoExit(deps, [order]);
      const withHeld = await withHold(deps, [order], req.log);
      return reply.code(200).send(withHeld(order, withExit(order, withStop(order, presentCcxtOrder(order, symbol)))));
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  /** CCXT fetchOrderTrades: one order's fills, oldest first, each with its role, fee, fee asset and fee rate. */
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/v1/orders/:id/trades', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.orderFills) {
      return reply.code(503).send({ error: 'order fills are not configured', code: 'trade.order_fills_unconfigured' });
    }
    const limit = parsePrivateRestLimit(req.query.limit, MAX_FILLS);
    if (limit === undefined) {
      return sendCcxt(reply, badRequest('orders/:id/trades limit is unset — refuse to invent 100', TRADE_ACCOUNT_TRADES_LIMIT_UNSET));
    }
    try {
      // A malformed id is no order of the caller's: the same answer as another person's order, before any read.
      if (!ORDER_ID_SHAPE.test(req.params.id)) throw new TradeError('order not found', 'trade.order_not_found');
      const fills = await deps.orderFills(principal, req.params.id, limit);
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

  app.get<{ Params: { id: string } }>('/api/v1/orders/:id/amendments', privateRead, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.orderAmendments) {
      return reply.code(503).send({ error: 'order amendments are not configured', code: 'trade.amendments_unconfigured' });
    }
    try {
      const amendments = await deps.orderAmendments(principal, req.params.id);
      return reply.code(200).send({ orderId: req.params.id, amendments });
    } catch (err) {
      const sent = sendDomainError(reply, err);
      if (sent) return sent;
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/v1/orders/:id', privateWrite, async (req, reply) => {
    const principal = requirePrincipal(req, reply);
    if (!principal) return;
    if (!requireTradeJurisdiction(req, reply, principal)) return;

    try {
      const order = await deps.cancelOrder(principal, req.params.id);
      const market = await deps.marketById(order.marketId);
      const symbol = market?.symbol ?? order.marketId;
      const withStop = await withStopTriggers(deps, [order]);
      const withExit = await withOcoExit(deps, [order]);
      const withHeld = await withHold(deps, [order], req.log);
      return reply.code(200).send(withHeld(order, withExit(order, withStop(order, presentCcxtOrder(order, symbol)))));
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
    feeTier: 'regular',
    tag: null,
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
