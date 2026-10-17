import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { DeskError } from '../desk/errors.js';
import { TradeError, type Market, type OrderRecord, type OrderSide } from './types.js';
import { assertNotional, assertPrice, assertQty, holdFor } from './risk.js';
import type { PlaceOrderInput } from './trade-service.js';

/**
 * Remainder of totalQty after equal lot-sized slices is added to the LAST level.
 * Prices that do not land on the tick are refused; they are not rounded.
 */
export const SCALE_REMAINDER_LEVEL = 'last' as const;

/** Database-protection bound on how many child orders one group may place. Not a product ladder size. */
export const SCALE_LEVELS_MAX = 50;

export const TRADE_SCALE_LEVELS_UNSET = 'trade.scale_levels_unset' as const;
export const TRADE_SCALE_QTY_UNSET = 'trade.scale_qty_unset' as const;
export const TRADE_SCALE_PRICE_UNSET = 'trade.scale_price_unset' as const;
export const TRADE_SCALE_LEVEL_INVALID = 'trade.scale_level_invalid' as const;
export const TRADE_SCALE_INSUFFICIENT_BALANCE = 'trade.scale_insufficient_balance' as const;
export const TRADE_SCALE_BALANCE_UNREADABLE = 'trade.scale_balance_unreadable' as const;
export const TRADE_SCALE_GROUP_NOT_FOUND = 'trade.scale_group_not_found' as const;
export const TRADE_SCALE_CLIENT_ID_UNSET = 'trade.scale_client_id_unset' as const;

export type ScaleGroupState = 'open' | 'partial' | 'filled' | 'cancelled' | 'mixed';

export interface ScaleCreateInput {
  readonly market: string;
  readonly side: OrderSide;
  readonly totalQty: string;
  readonly levels?: number | null;
  readonly priceFrom: string;
  readonly priceTo: string;
  readonly clientGroupId: string;
}

export interface ScaleChildView {
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly index: number;
  readonly qty: string;
  readonly price: string;
  readonly status: string;
  readonly filledQty: string;
}

export interface ScaleGroupView {
  readonly groupId: string;
  readonly market: string;
  readonly side: OrderSide;
  readonly totalQty: string;
  readonly state: ScaleGroupState;
  readonly remainderLevel: typeof SCALE_REMAINDER_LEVEL;
  readonly children: ScaleChildView[];
}

interface PlannedLevel {
  readonly index: number;
  readonly qty: Amount;
  readonly price: Amount;
  readonly clientOrderId: string;
}

interface StoredGroup {
  id: string;
  user_id: string;
  client_group_id: string;
  market_id: string;
  side: OrderSide;
  params: {
    symbol: string;
    totalQty: string;
    levels: PlannedLevelWire[];
  };
  child_order_ids: string[];
}

interface PlannedLevelWire {
  index: number;
  qty: string;
  price: string;
  clientOrderId: string;
}

export interface ScaleGroupPorts {
  sql: Sql;
  placeOrder(principal: Principal, input: PlaceOrderInput): Promise<OrderRecord>;
  cancelOrder(principal: Principal, orderId: string): Promise<OrderRecord>;
  marketBySymbol(symbol: string): Promise<Market | null>;
  available(userId: string, assetId: string): Promise<Amount>;
}

export function planScaleLevels(market: Market, input: ScaleCreateInput): PlannedLevel[] {
  const levels = input.levels;
  if (levels == null || !Number.isInteger(levels) || levels < 1 || levels > SCALE_LEVELS_MAX) {
    throw new DeskError('scale levels is unset — refuse to invent a ladder length', TRADE_SCALE_LEVELS_UNSET);
  }
  if (input.clientGroupId.trim() === '' || input.clientGroupId.length > 48) {
    throw new DeskError('scale clientGroupId is unset', TRADE_SCALE_CLIENT_ID_UNSET);
  }
  let total: Amount;
  let priceFrom: Amount;
  let priceTo: Amount;
  try {
    if (input.totalQty.trim() === '') throw new Error('blank');
    total = parseAmount(input.totalQty);
  } catch {
    throw new DeskError('scale totalQty is unset', TRADE_SCALE_QTY_UNSET);
  }
  try {
    if (input.priceFrom.trim() === '' || input.priceTo.trim() === '') throw new Error('blank');
    priceFrom = parseAmount(input.priceFrom);
    priceTo = parseAmount(input.priceTo);
  } catch {
    throw new DeskError('scale priceFrom or priceTo is unset', TRADE_SCALE_PRICE_UNSET);
  }
  if (input.side !== 'buy' && input.side !== 'sell') {
    throw new DeskError('scale side is invalid', TRADE_SCALE_LEVEL_INVALID);
  }
  try {
    assertQty(market, total);
    assertPrice(market, priceFrom);
    assertPrice(market, priceTo);
  } catch (err) {
    throw new DeskError(err instanceof Error ? err.message : 'scale level is invalid', TRADE_SCALE_LEVEL_INVALID);
  }

  const lot = market.lotSize;
  const count = BigInt(levels);
  const base = (total / count / lot) * lot;
  if (base <= 0n) {
    throw new DeskError('scale level quantity is below one lot', TRADE_SCALE_LEVEL_INVALID);
  }
  const remainder = total - base * count;
  if (remainder < 0n || remainder % lot !== 0n) {
    throw new DeskError('scale totalQty does not split onto the lot', TRADE_SCALE_LEVEL_INVALID);
  }
  const qtys: Amount[] = [];
  for (let i = 0; i < levels; i++) qtys.push(base);
  qtys[levels - 1] = base + remainder;

  const prices: Amount[] = [];
  for (let i = 0; i < levels; i++) {
    let price: Amount;
    if (levels === 1) {
      if (priceFrom !== priceTo) {
        throw new DeskError('a one-level scale requires priceFrom = priceTo', TRADE_SCALE_LEVEL_INVALID);
      }
      price = priceFrom;
    } else {
      const span = priceTo - priceFrom;
      const num = span * BigInt(i);
      const den = BigInt(levels - 1);
      if (num % den !== 0n) {
        throw new DeskError(`scale price at level ${i} is not an exact tick`, TRADE_SCALE_LEVEL_INVALID);
      }
      price = priceFrom + num / den;
    }
    try {
      assertPrice(market, price);
      assertQty(market, qtys[i]!);
      assertNotional(market, price, qtys[i]!);
    } catch (err) {
      throw new DeskError(err instanceof Error ? err.message : 'scale level is invalid', TRADE_SCALE_LEVEL_INVALID);
    }
    prices.push(price);
  }

  return qtys.map((qty, index) => ({
    index,
    qty,
    price: prices[index]!,
    clientOrderId: `${input.clientGroupId}:${index}`,
  }));
}

export function scaleGroupState(children: readonly { status: string; filledQty: Amount }[]): ScaleGroupState {
  if (children.length === 0) return 'open';
  const live = (status: string) => status === 'open' || status === 'pending' || status === 'recovery_required' || status === 'hold_unknown';
  const dead = (status: string) => status === 'cancelled' || status === 'rejected' || status === 'expired';
  const filled = children.filter((c) => c.status === 'filled');
  const cancelled = children.filter((c) => dead(c.status));
  const open = children.filter((c) => live(c.status));
  if (filled.length === children.length) return 'filled';
  if (cancelled.length === children.length) return 'cancelled';
  if (open.length === children.length && children.every((c) => c.filledQty === 0n)) return 'open';
  if (cancelled.length === 0 && children.some((c) => c.status === 'filled' || c.filledQty > 0n)) return 'partial';
  return 'mixed';
}

export async function createScaleGroup(ports: ScaleGroupPorts, principal: Principal, input: ScaleCreateInput): Promise<ScaleGroupView> {
  requireScope(principal, 'trade:write');
  const existing = await loadByClient(ports.sql, principal.userId, input.clientGroupId);
  if (existing) return presentGroup(ports.sql, existing);

  const market = await ports.marketBySymbol(input.market);
  if (!market) throw new TradeError(`market ${input.market} not found`, 'trade.market_not_found');
  const plan = planScaleLevels(market, input);
  const hold = plan.reduce(
    (acc, level) => {
      const next = holdFor(market, input.side, level.price, level.qty);
      return { assetId: next.assetId, amount: acc.amount + next.amount };
    },
    { assetId: '', amount: 0n },
  );
  let available: Amount;
  try {
    available = await ports.available(principal.userId, hold.assetId);
  } catch {
    throw new DeskError('scale could not read the available balance', TRADE_SCALE_BALANCE_UNREADABLE);
  }
  if (available < hold.amount) {
    throw new DeskError(
      `scale hold ${formatAmount(hold.amount)} ${hold.assetId} exceeds available ${formatAmount(available)}`,
      TRADE_SCALE_INSUFFICIENT_BALANCE,
    );
  }

  const childIds: string[] = [];
  for (const level of plan) {
    const order = await ports.placeOrder(principal, {
      symbol: market.symbol,
      side: input.side,
      type: 'limit',
      qty: level.qty,
      price: level.price,
      clientOrderId: level.clientOrderId,
    });
    childIds.push(order.id);
  }

  const id = randomUUID();
  const params = {
    symbol: market.symbol,
    totalQty: formatAmount(parseAmount(input.totalQty)),
    levels: plan.map((level) => ({
      index: level.index,
      qty: formatAmount(level.qty),
      price: formatAmount(level.price),
      clientOrderId: level.clientOrderId,
    })),
  };
  await ports.sql`
    INSERT INTO scale_groups (id, user_id, client_group_id, market_id, side, params, child_order_ids)
    VALUES (
      ${id}, ${principal.userId}, ${input.clientGroupId}, ${market.id}, ${input.side},
      ${ports.sql.json(params)}, ${ports.sql.json(childIds)}
    )
    ON CONFLICT (user_id, client_group_id) DO NOTHING
  `;
  const stored = await loadByClient(ports.sql, principal.userId, input.clientGroupId);
  if (!stored) throw new DeskError('scale group was not stored', TRADE_SCALE_GROUP_NOT_FOUND);
  return presentGroup(ports.sql, stored);
}

export async function getScaleGroup(ports: Pick<ScaleGroupPorts, 'sql'>, principal: Principal, groupId: string): Promise<ScaleGroupView> {
  requireScope(principal, 'trade:read');
  const stored = await loadById(ports.sql, principal.userId, groupId);
  if (!stored) throw new DeskError('scale group not found', TRADE_SCALE_GROUP_NOT_FOUND);
  return presentGroup(ports.sql, stored);
}

export async function cancelScaleGroup(ports: ScaleGroupPorts, principal: Principal, groupId: string): Promise<ScaleGroupView> {
  requireScope(principal, 'trade:write');
  const stored = await loadById(ports.sql, principal.userId, groupId);
  if (!stored) throw new DeskError('scale group not found', TRADE_SCALE_GROUP_NOT_FOUND);
  const children = await loadChildren(ports.sql, stored);
  for (const child of children) {
    if (child.status === 'open' || child.status === 'pending' || child.status === 'recovery_required') {
      await ports.cancelOrder(principal, child.orderId);
    }
  }
  return presentGroup(ports.sql, stored);
}

async function loadByClient(sql: Sql, userId: string, clientGroupId: string): Promise<StoredGroup | null> {
  if (clientGroupId.trim() === '') return null;
  const rows = await sql<StoredGroup[]>`
    SELECT id, user_id, client_group_id, market_id, side, params, child_order_ids
    FROM scale_groups
    WHERE user_id = ${userId} AND client_group_id = ${clientGroupId}
  `;
  return rows[0] ?? null;
}

async function loadById(sql: Sql, userId: string, groupId: string): Promise<StoredGroup | null> {
  const rows = await sql<StoredGroup[]>`
    SELECT id, user_id, client_group_id, market_id, side, params, child_order_ids
    FROM scale_groups
    WHERE user_id = ${userId} AND id = ${groupId}
  `;
  return rows[0] ?? null;
}

async function loadChildren(sql: Sql, group: StoredGroup): Promise<ScaleChildView[]> {
  const ids = Array.isArray(group.child_order_ids) ? group.child_order_ids.map(String) : [];
  const planned = new Map((group.params.levels ?? []).map((level) => [level.clientOrderId, level]));
  if (ids.length === 0) return [];
  const rows = await sql<Array<{ id: string; client_order_id: string; status: string; qty: string; filled_qty: string; price: string }>>`
    SELECT id, client_order_id, status, qty::text AS qty, filled_qty::text AS filled_qty, price::text AS price
    FROM trade.orders
    WHERE user_id = ${group.user_id}::uuid AND id = ANY(${ids}::uuid[])
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    const plan =
      [...planned.values()].find((level) => level.clientOrderId.endsWith(`:${ids.indexOf(id)}`)) ?? planned.get(row?.client_order_id ?? '');
    return {
      orderId: id,
      clientOrderId: row?.client_order_id ?? plan?.clientOrderId ?? '',
      index: plan?.index ?? ids.indexOf(id),
      qty: row ? formatAmount(parseAmount(row.qty)) : (plan?.qty ?? '0'),
      price: row?.price ? formatAmount(parseAmount(row.price)) : (plan?.price ?? '0'),
      status: row?.status ?? 'open',
      filledQty: row ? formatAmount(parseAmount(row.filled_qty)) : '0',
    };
  });
}

async function presentGroup(sql: Sql, group: StoredGroup): Promise<ScaleGroupView> {
  const children = await loadChildren(sql, group);
  return {
    groupId: group.id,
    market: group.params.symbol,
    side: group.side,
    totalQty: group.params.totalQty,
    state: scaleGroupState(children.map((child) => ({ status: child.status, filledQty: parseAmount(child.filledQty) }))),
    remainderLevel: SCALE_REMAINDER_LEVEL,
    children,
  };
}
