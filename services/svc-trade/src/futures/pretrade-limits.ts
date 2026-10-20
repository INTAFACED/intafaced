/**
 * Owner pre-trade limits: TRADE_MAX_ORDER, TRADE_MAX_POSITION, TRADE_MAX_LOSS
 * (CARD F5 / PTX-M09-R10 / PX-S06, issue #4725).
 *
 * `pretrade-credit.ts` only proved the three numbers are published. This file
 * is what compares an order against them. It is deliberately free of imports of
 * `TradeService` / `PositionService`, so both services can call it without an
 * import cycle; `pretrade-credit.ts` re-exports the published-integer parts.
 *
 * UNITS (the owner publishes whole integers, no unit is written down anywhere
 * else): every limit is a number of WHOLE units of the market's QUOTE asset
 * (USDT for BTC/USDT). Compared exactly in scaled bigint, never as a float.
 *
 *   - TRADE_MAX_ORDER    notional (price x qty) of ONE order, or ONE convert.
 *   - TRADE_MAX_POSITION notional of the user's resulting futures position on
 *                        ONE market after an open, valued at the entry mark.
 *   - TRADE_MAX_LOSS     the user's current UNREALISED loss on open futures
 *                        positions in that quote asset (sum of the losing
 *                        rows, wins do not offset). Above it, no new risk.
 *
 * Boundary: EXACTLY at the limit is allowed; one unit (1e-18) over is refused.
 * A published 0 refuses every new order (0 is published, not a default).
 *
 * Exempt, on purpose: closes, liquidation, ADL, reconcile and seeded market
 * maker orders never call this file; reducing risk must never be blocked.
 */
import { SCALE, formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { parseOwnerIntegerEnv } from '../owner-int-env.js';
import { unrealizedPnl } from './liquidation-planner.js';

export const MAX_ORDER_UNSET = 'trade.max_order_unset' as const;
export const MAX_POSITION_UNSET = 'trade.max_position_unset' as const;
export const MAX_LOSS_UNSET = 'trade.max_loss_unset' as const;

export type PreTradeCreditRefuseCode = typeof MAX_ORDER_UNSET | typeof MAX_POSITION_UNSET | typeof MAX_LOSS_UNSET;

export const LIMIT_MAX_ORDER = 'trade.limit_max_order' as const;
export const LIMIT_MAX_POSITION = 'trade.limit_max_position' as const;
export const LIMIT_MAX_LOSS = 'trade.limit_max_loss' as const;
export const LIMIT_MAX_OPEN_ORDERS = 'trade.limit_max_open_orders' as const;
export const MAX_OPEN_ORDERS_INVALID = 'trade.max_open_orders_invalid' as const;

export type PreTradeLimitCode = typeof LIMIT_MAX_ORDER | typeof LIMIT_MAX_POSITION | typeof LIMIT_MAX_LOSS;

/** HTTP status for a limit refusal on the futures door (spot maps through ccxt-errors). */
export const PRETRADE_LIMIT_HTTP_STATUS = 422;

export interface PreTradeCreditDimensions {
  readonly maxOrder?: string | number | null;
  readonly maxPosition?: string | number | null;
  readonly maxLoss?: string | number | null;
}

export type PreTradeCreditCheck =
  | { readonly ok: true; readonly maxOrder: number; readonly maxPosition: number; readonly maxLoss: number }
  | { readonly ok: false; readonly code: PreTradeCreditRefuseCode; readonly reason: string };

/** Owner integer. Blank / unset / non-integer → null. 0 is published, not a default. */
function publishedOwnerInteger(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  return parseOwnerIntegerEnv(raw);
}

export function readOwnerPreTradeCredit(env: NodeJS.ProcessEnv = process.env): PreTradeCreditDimensions {
  return {
    maxOrder: env.TRADE_MAX_ORDER,
    maxPosition: env.TRADE_MAX_POSITION,
    maxLoss: env.TRADE_MAX_LOSS,
  };
}

/**
 * Unset any dimension refuses. Published owner integers admit (including 0).
 * This function does not compare an order against a cap and does not collapse dimensions.
 */
export function checkPreTradeCreditDimensions(dims: PreTradeCreditDimensions): PreTradeCreditCheck {
  const maxOrder = publishedOwnerInteger(dims.maxOrder);
  if (maxOrder == null) {
    return {
      ok: false,
      code: MAX_ORDER_UNSET,
      reason: 'TRADE_MAX_ORDER is unset — refuse new risk rather than invent a max-order',
    };
  }
  const maxPosition = publishedOwnerInteger(dims.maxPosition);
  if (maxPosition == null) {
    return {
      ok: false,
      code: MAX_POSITION_UNSET,
      reason: 'TRADE_MAX_POSITION is unset — refuse new risk rather than invent a max-position',
    };
  }
  const maxLoss = publishedOwnerInteger(dims.maxLoss);
  if (maxLoss == null) {
    return {
      ok: false,
      code: MAX_LOSS_UNSET,
      reason: 'TRADE_MAX_LOSS is unset — refuse new risk rather than invent a max-loss',
    };
  }
  return { ok: true, maxOrder, maxPosition, maxLoss };
}

// ── Production posture ───────────────────────────────────────────────────────

const INSTALLED = Symbol.for('intafaced.trade.preTradeCreditInstalled');

/** Called by `installPreTradeCredit()` (live boot via ledger-client.ts). */
export function markPreTradeCreditInstalled(): void {
  (globalThis as Record<symbol, unknown>)[INSTALLED] = true;
}

function preTradeCreditInstalled(): boolean {
  return (globalThis as Record<symbol, unknown>)[INSTALLED] === true;
}

export interface PreTradeRefusal {
  readonly code: PreTradeLimitCode | PreTradeCreditRefuseCode | typeof LIMIT_MAX_OPEN_ORDERS;
  readonly message: string;
}

/** Whole-unit limits; null = unpublished and not required (only outside production posture). */
export interface AdmissionLimits {
  readonly maxOrder: number | null;
  readonly maxPosition: number | null;
  readonly maxLoss: number | null;
}

/**
 * Read the owner limits at the moment of admission.
 *
 * Production posture (the mill is installed, which live boot does through
 * ledger-client.ts): any unset / unparsable limit refuses with the existing
 * `trade.max_*_unset` code, so the doors that skip the place/open wrappers
 * (copy mirror, algo child, convert) fail closed too. Outside it (unit tests
 * that build a service by hand) an unpublished limit is simply not compared.
 */
export function resolveAdmissionLimits(
  env: NodeJS.ProcessEnv = process.env,
): { readonly refusal: PreTradeRefusal } | { readonly limits: AdmissionLimits } {
  const dims = readOwnerPreTradeCredit(env);
  if (preTradeCreditInstalled()) {
    const check = checkPreTradeCreditDimensions(dims);
    if (!check.ok) return { refusal: { code: check.code, message: check.reason } };
    return { limits: { maxOrder: check.maxOrder, maxPosition: check.maxPosition, maxLoss: check.maxLoss } };
  }
  return {
    limits: {
      maxOrder: publishedOwnerInteger(dims.maxOrder),
      maxPosition: publishedOwnerInteger(dims.maxPosition),
      maxLoss: publishedOwnerInteger(dims.maxLoss),
    },
  };
}

// ── TRADE_MAX_OPEN_ORDERS ────────────────────────────────────────────────────

/**
 * Owner cap on how many resting orders ONE user holds, across every market. It is a count, not a notional, so
 * it is its own dimension: it is not part of the three published-or-refuse limits above, and unset means no
 * cap is compared. A value that is set but is not a whole number refuses, so a typo never turns the cap off.
 * A published 0 refuses every new resting order.
 */
export function resolveOpenOrdersCap(
  env: NodeJS.ProcessEnv = process.env,
): { readonly refusal: { readonly code: typeof MAX_OPEN_ORDERS_INVALID; readonly message: string } } | { readonly cap: number | null } {
  const raw = env.TRADE_MAX_OPEN_ORDERS;
  if (raw == null || raw.trim() === '') return { cap: null };
  const cap = parseOwnerIntegerEnv(raw);
  if (cap == null || cap < 0) {
    return {
      refusal: {
        code: MAX_OPEN_ORDERS_INVALID,
        message: 'TRADE_MAX_OPEN_ORDERS is set but is not a whole number of 0 or more — refuse new resting orders rather than drop the cap',
      },
    };
  }
  return { cap };
}

/** The user already holds `cap` resting orders (or more): one more is refused. */
export function checkMaxOpenOrders(input: { readonly cap: number; readonly openCount: number }): PreTradeRefusal | null {
  if (input.openCount < input.cap) return null;
  return {
    code: LIMIT_MAX_OPEN_ORDERS,
    message: `${input.openCount} open orders already rest, the max-open-orders limit is ${input.cap} (TRADE_MAX_OPEN_ORDERS) — cancel an order or wait for one to fill before placing another`,
  };
}

// ── Pure comparisons ─────────────────────────────────────────────────────────

/** Whole-unit limit as a scaled Amount. */
export function limitAmount(whole: number): Amount {
  return BigInt(whole) * SCALE;
}

/** price x qty, rounded UP so a sub-unit overshoot is never rounded away in the user's favour. */
export function notionalCeil(price: Amount, qty: Amount): Amount {
  return mul(price, qty, 'ceil');
}

/** `price x qty > limit` decided exactly, with no rounding. */
function exceeds(price: Amount, qty: Amount, wholeLimit: number): boolean {
  return price * qty > limitAmount(wholeLimit) * SCALE;
}

function refuseOrder(limit: number, quoteAsset: string, price: Amount, qty: Amount, what: string): PreTradeRefusal {
  return {
    code: LIMIT_MAX_ORDER,
    message: `${what} notional ${formatAmount(notionalCeil(price, qty))} ${quoteAsset} exceeds the max-order limit of ${limit} ${quoteAsset} (TRADE_MAX_ORDER)`,
  };
}

/** TRADE_MAX_ORDER: one order's (or one convert's) notional. Null limit = nothing to compare. */
export function checkMaxOrder(input: {
  readonly limits: AdmissionLimits;
  readonly quoteAsset: string;
  readonly price: Amount;
  readonly qty: Amount;
  readonly what?: string;
}): PreTradeRefusal | null {
  const { maxOrder } = input.limits;
  if (maxOrder == null) return null;
  if (!exceeds(input.price, input.qty, maxOrder)) return null;
  return refuseOrder(maxOrder, input.quoteAsset, input.price, input.qty, input.what ?? 'order');
}

/** TRADE_MAX_ORDER for a ready-made notional (convert: the bound fill notional). */
export function checkMaxOrderNotional(input: {
  readonly limits: AdmissionLimits;
  readonly quoteAsset: string;
  readonly notional: Amount;
  readonly what: string;
}): PreTradeRefusal | null {
  const { maxOrder } = input.limits;
  if (maxOrder == null) return null;
  if (input.notional <= limitAmount(maxOrder)) return null;
  return {
    code: LIMIT_MAX_ORDER,
    message: `${input.what} notional ${formatAmount(input.notional)} ${input.quoteAsset} exceeds the max-order limit of ${maxOrder} ${input.quoteAsset} (TRADE_MAX_ORDER)`,
  };
}

/**
 * TRADE_MAX_POSITION: the position after this open, as signed size (long +, short -).
 * An open that does not increase |position| is never refused; a position that is
 * already over a lowered limit can still be reduced, never grown.
 */
export function checkMaxPosition(input: {
  readonly limits: AdmissionLimits;
  readonly quoteAsset: string;
  readonly existingSignedSize: Amount;
  readonly deltaSignedSize: Amount;
  readonly price: Amount;
}): PreTradeRefusal | null {
  const { maxPosition } = input.limits;
  if (maxPosition == null) return null;
  const before = input.existingSignedSize < 0n ? -input.existingSignedSize : input.existingSignedSize;
  const resulting = input.existingSignedSize + input.deltaSignedSize;
  const after = resulting < 0n ? -resulting : resulting;
  if (after <= before) return null;
  if (!exceeds(input.price, after, maxPosition)) return null;
  return {
    code: LIMIT_MAX_POSITION,
    message: `resulting position ${formatAmount(after)} (notional ${formatAmount(notionalCeil(input.price, after))} ${input.quoteAsset}) exceeds the max-position limit of ${maxPosition} ${input.quoteAsset} (TRADE_MAX_POSITION)`,
  };
}

/** TRADE_MAX_LOSS: current unrealised loss (scaled, positive = loss) must not be above the limit. */
export function checkMaxLoss(input: {
  readonly limits: AdmissionLimits;
  readonly quoteAsset: string;
  readonly unrealisedLoss: Amount;
}): PreTradeRefusal | null {
  const { maxLoss } = input.limits;
  if (maxLoss == null) return null;
  if (input.unrealisedLoss <= limitAmount(maxLoss)) return null;
  return {
    code: LIMIT_MAX_LOSS,
    message: `unrealised loss ${formatAmount(input.unrealisedLoss)} ${input.quoteAsset} exceeds the max-loss limit of ${maxLoss} ${input.quoteAsset} (TRADE_MAX_LOSS) — no new risk until it recovers or the owner raises the limit`,
  };
}

/** Signed size of a futures side. */
export function signedSize(side: 'long' | 'short', size: Amount): Amount {
  return side === 'long' ? size : -size;
}

// ── Futures open ─────────────────────────────────────────────────────────────

interface OpenRiskRow {
  market_id: string;
  symbol: string;
  side: 'long' | 'short';
  size: string;
  entry_price: string;
  margin_asset: string;
}

export interface OpenAdmissionInput {
  readonly sql: Sql;
  readonly userId: string;
  readonly marketId: string;
  readonly quoteAsset: string;
  readonly side: 'long' | 'short';
  readonly size: Amount;
  /** The entry mark this open is about to be priced at. */
  readonly entryPrice: Amount;
  /** `hedge`: each side is its own position. Anything else is one net position. */
  readonly positionMode?: unknown;
  /** Mark for ANOTHER open position's market (refuses when the feed cannot value it). */
  readonly markFor: (marketId: string, symbol: string) => Promise<Amount>;
}

/**
 * Admission for `PositionService.open`, before the margin lock.
 *
 * Order: max-order, max-position, max-loss. Concurrency: there is at most one
 * open row per (user, market, side) (`positions_open_unique_idx`), so two
 * concurrent opens cannot stack a side past MAX_POSITION; the loser fails at
 * the insert and its margin is released. MAX_LOSS reads other markets' rows
 * without a lock: it is best-effort per request, bounded by one open per
 * (market, side), and it only gates NEW risk.
 */
export async function checkOpenAdmission(input: OpenAdmissionInput): Promise<PreTradeRefusal | null> {
  const resolved = resolveAdmissionLimits();
  if ('refusal' in resolved) return resolved.refusal;
  const { limits } = resolved;

  const order = checkMaxOrder({
    limits,
    quoteAsset: input.quoteAsset,
    price: input.entryPrice,
    qty: input.size,
    what: 'open',
  });
  if (order) return order;
  if (limits.maxPosition == null && limits.maxLoss == null) return null;

  const rows = await input.sql<OpenRiskRow[]>`
    SELECT p.market_id, m.symbol, p.side, p.size, p.entry_price, p.margin_asset
    FROM trade.positions p
    JOIN trade.markets m ON m.id = p.market_id
    WHERE p.user_id = ${input.userId} AND p.status IN ('open', 'closing')
  `;

  const hedge = input.positionMode === 'hedge';
  let existing = 0n;
  for (const row of rows) {
    if (row.market_id !== input.marketId) continue;
    if (hedge && row.side !== input.side) continue;
    existing += signedSize(row.side, parseAmount(row.size));
  }
  const position = checkMaxPosition({
    limits,
    quoteAsset: input.quoteAsset,
    existingSignedSize: existing,
    deltaSignedSize: signedSize(input.side, input.size),
    price: input.entryPrice,
  });
  if (position) return position;

  if (limits.maxLoss == null) return null;
  let loss = 0n;
  for (const row of rows) {
    if (row.margin_asset !== input.quoteAsset) continue;
    const mark = row.market_id === input.marketId ? input.entryPrice : await input.markFor(row.market_id, row.symbol);
    const pnl = unrealizedPnl(row.side, parseAmount(row.size), parseAmount(row.entry_price), mark);
    if (pnl < 0n) loss += -pnl;
  }
  return checkMaxLoss({ limits, quoteAsset: input.quoteAsset, unrealisedLoss: loss });
}
