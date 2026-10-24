/**
 * Module-level helpers of `TradeService` that the class file and its area files share.
 *
 * Moved out of `trade-service.ts` as they were (owner decision 2026-10-23). Only `trade-service.ts` and
 * the files in this folder import this module; `trade-service.ts` re-exports the names it exported before.
 * It imports no value from `trade-service.ts`, so loading any area file first cannot hit a half-loaded class file.
 */

import { createHash } from 'node:crypto';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError, type OrderRecord, type OrderType, type TimeInForce } from '../types.js';
import type { PlaceOrderInput } from '../trade-service.js';

/** True only when `trade.fills` is empty and the order row claims no fill. */
export function fillsProveNoFill(filledQty: Amount, fills: { count: number; qty: Amount }): boolean {
  return fills.count === 0 && fills.qty === 0n && filledQty === 0n;
}

export const REPLACEMENT_CLIENT_PREFIX = 'replace:';

export function replacementClientOrderId(clientOrderId: string): string {
  return `${REPLACEMENT_CLIENT_PREFIX}${clientOrderId}`;
}

export function replacementRequestHash(originalId: string, input: PlaceOrderInput): string {
  const canonical = [
    originalId,
    input.symbol ?? '',
    input.marketId ?? '',
    input.side,
    input.type,
    formatAmount(input.qty),
    input.price == null ? '' : formatAmount(input.price),
    input.tif ?? 'GTC',
    input.subAccountId ?? '',
    input.clientOrderId ?? '',
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * A caller-owned identity is an idempotency fence, not permission to reinterpret
 * the command. Persisted fields are the fingerprint so retries need no second
 * table and can still resolve while mutable dependencies are unavailable.
 */
export function assertSamePlaceCommand(
  order: OrderRecord,
  input: PlaceOrderInput,
  orderType: OrderType,
  tif: TimeInForce,
  seeded: boolean,
): OrderRecord {
  const same =
    order.clientOrderId === input.clientOrderId &&
    order.subAccountId === (input.subAccountId ?? null) &&
    order.side === input.side &&
    order.type === orderType &&
    order.qty === input.qty &&
    order.price === (input.price ?? null) &&
    order.tif === tif &&
    order.seeded === seeded &&
    order.replacementOf === (input.replacementOf ?? null) &&
    order.replacementRequestHash === (input.replacementRequestHash ?? null);
  if (!same) {
    throw new TradeError('clientOrderId was already used for a different order request', 'trade.client_order_id_conflict');
  }
  return order;
}

/** Blank / non-integer / out of 1..500 public-tape limit refuse. Never invent 100. */
export const TRADE_PUBLIC_TAPE_LIMIT_UNSET = 'trade.public_tape_limit_unset' as const;

export const PUBLIC_TAPE_LIMIT_MAX = 500;

export class PublicTapeLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_PUBLIC_TAPE_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'PublicTapeLimitUnsetError';
  }
}

/** Owner-published tape window. Missing / null / non-int / out of 1..max refuses. Never invent 100. */
export function publishedPublicTapeLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > PUBLIC_TAPE_LIMIT_MAX) {
    throw new PublicTapeLimitUnsetError('public tape limit is unset — refuse to invent 100', TRADE_PUBLIC_TAPE_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..500 fills.mine / myFills limit refuse. Never invent 100. */
export const TRADE_FILLS_MINE_LIMIT_UNSET = 'trade.fills_mine_limit_unset' as const;

export const FILLS_MINE_LIMIT_MAX = 500;

export class FillsMineLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_FILLS_MINE_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'FillsMineLimitUnsetError';
  }
}

/** Owner-published user-fills window. Missing / null / non-int / out of 1..max refuses. Never invent 100. */
export function publishedFillsMineLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > FILLS_MINE_LIMIT_MAX) {
    throw new FillsMineLimitUnsetError('fills.mine limit is unset — refuse to invent 100', TRADE_FILLS_MINE_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..500 orders.history / orderHistory limit refuse. Never invent 100. */
export const TRADE_ORDER_HISTORY_LIMIT_UNSET = 'trade.order_history_limit_unset' as const;

export const ORDER_HISTORY_LIMIT_MAX = 500;

export class OrderHistoryLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_ORDER_HISTORY_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'OrderHistoryLimitUnsetError';
  }
}

/** Owner-published order-history window. Missing / null / non-int / out of 1..max refuses. Never invent 100. */
export function publishedOrderHistoryLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > ORDER_HISTORY_LIMIT_MAX) {
    throw new OrderHistoryLimitUnsetError('orders.history limit is unset — refuse to invent 100', TRADE_ORDER_HISTORY_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..500 adminOpenOrders limit refuse. Never invent 100. */
export const TRADE_ADMIN_OPEN_ORDERS_LIMIT_UNSET = 'trade.admin_open_orders_limit_unset' as const;

export const ADMIN_OPEN_ORDERS_LIMIT_MAX = 500;

export class AdminOpenOrdersLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_ADMIN_OPEN_ORDERS_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'AdminOpenOrdersLimitUnsetError';
  }
}

/** Owner-published admin open-orders window. Missing / null / non-int / out of 1..max refuses. Never invent 100. */
export function publishedAdminOpenOrdersLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > ADMIN_OPEN_ORDERS_LIMIT_MAX) {
    throw new AdminOpenOrdersLimitUnsetError('adminOpenOrders limit is unset — refuse to invent 100', TRADE_ADMIN_OPEN_ORDERS_LIMIT_UNSET);
  }
  return value;
}

/** Blank / non-integer / out of 1..500 openOrders limit refuse. Never invent 100. */
export const TRADE_OPEN_ORDERS_LIMIT_UNSET = 'trade.open_orders_limit_unset' as const;

export const OPEN_ORDERS_LIMIT_MAX = 500;

export class OpenOrdersLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof TRADE_OPEN_ORDERS_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'OpenOrdersLimitUnsetError';
  }
}

/** Owner-published self open-orders window. Missing / null / non-int / out of 1..max refuses. Never invent 100. */
export function publishedOpenOrdersLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > OPEN_ORDERS_LIMIT_MAX) {
    throw new OpenOrdersLimitUnsetError('orders.open limit is unset — refuse to invent 100', TRADE_OPEN_ORDERS_LIMIT_UNSET);
  }
  return value;
}
