import { formatAmount, mulBps, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { MARKET_OPS_SCOPE, MarketError } from '../vendor-service.js';

/**
 * Operator sales window. Blank is not "all time" and not 30 days.
 * The span is the instants the caller named. Longer than 366 days refuses.
 */
export const MARKET_OPS_SALES_WINDOW_UNSET = 'market.ops_sales_window_unset' as const;
export const MARKET_OPS_SALES_WINDOW_TOO_WIDE = 'market.ops_sales_window_too_wide' as const;
export const MARKET_OPS_SALES_LIST_LIMIT_UNSET = 'market.ops_sales_list_limit_unset' as const;
export const MARKET_OPS_SALES_CURSOR_INVALID = 'market.ops_sales_cursor_invalid' as const;
export const MARKET_OPS_REQUIRED = 'market.ops_required' as const;

/** Inclusive window. 366 calendar days of 86400000 ms, not a default range. */
export const OPS_SALES_MAX_SPAN_MS = 366 * 24 * 60 * 60 * 1000;

export interface OpsSalesQuery {
  actorScope: string;
  from?: string | undefined;
  to?: string | undefined;
  vendorId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface OpsSalesRow {
  vendorId: string;
  assetId: string;
  /** Sum of settled prices. Exact decimal. */
  settledVolume: string;
  /** Count of settled purchases. Integer decimal, never a float. */
  settledCount: string;
  /**
   * Sum of per-row house commission. Each row is `mulBps(price, commissionBps, 'floor')`,
   * the same floor `marketPurchase` uses. Today's house rate is not read.
   */
  commission: string;
}

export interface OpsSalesPage {
  rows: OpsSalesRow[];
  /** Rejected purchases in the window. Not part of settled volume. */
  refusedCount: string;
  /** Pending purchases in the window. Not part of settled volume. */
  pendingCount: string;
  nextCursor: string | null;
}

interface PurchaseFact {
  vendor_id: string;
  asset_id: string;
  status: string;
  price: string;
  commission_bps: number;
}

interface SalesCursor {
  vendorId: string;
  assetId: string;
}

interface Group {
  vendorId: string;
  assetId: string;
  volume: Amount;
  count: number;
  commission: Amount;
}

/** House cut of one settled price at the bps stored on that purchase. */
export function commissionOfSnapshot(price: string, commissionBps: number): Amount {
  return mulBps(parseAmount(price), commissionBps, 'floor');
}

export function assertOpsSalesListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new MarketError(MARKET_OPS_SALES_LIST_LIMIT_UNSET, MARKET_OPS_SALES_LIST_LIMIT_UNSET);
  }
  const n = Math.floor(limit);
  if (n < 1) throw new MarketError(MARKET_OPS_SALES_LIST_LIMIT_UNSET, MARKET_OPS_SALES_LIST_LIMIT_UNSET);
  return Math.min(50, n);
}

export function requireOpsSalesWindow(from: string | undefined, to: string | undefined): { from: Date; to: Date } {
  const start = parseInstant(from);
  const end = parseInstant(to);
  if (!start || !end || end.getTime() < start.getTime()) {
    throw new MarketError(MARKET_OPS_SALES_WINDOW_UNSET, MARKET_OPS_SALES_WINDOW_UNSET);
  }
  if (end.getTime() - start.getTime() > OPS_SALES_MAX_SPAN_MS) {
    throw new MarketError(MARKET_OPS_SALES_WINDOW_TOO_WIDE, MARKET_OPS_SALES_WINDOW_TOO_WIDE);
  }
  return { from: start, to: end };
}

function parseInstant(value: string | undefined): Date | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed;
}

function encodeSalesCursor(vendorId: string, assetId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, vendorId, assetId }), 'utf8').toString('base64url');
}

function decodeSalesCursor(cursor: string | undefined): SalesCursor | null {
  if (cursor === undefined || cursor.trim() === '') return null;
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v?: unknown;
      vendorId?: unknown;
      assetId?: unknown;
    };
    if (raw.v !== 1 || typeof raw.vendorId !== 'string' || typeof raw.assetId !== 'string') {
      throw new MarketError(MARKET_OPS_SALES_CURSOR_INVALID, MARKET_OPS_SALES_CURSOR_INVALID);
    }
    return { vendorId: raw.vendorId, assetId: raw.assetId };
  } catch (err) {
    if (err instanceof MarketError) throw err;
    throw new MarketError(MARKET_OPS_SALES_CURSOR_INVALID, MARKET_OPS_SALES_CURSOR_INVALID);
  }
}

function afterCursor(group: Group, cursor: SalesCursor): boolean {
  if (group.vendorId > cursor.vendorId) return true;
  if (group.vendorId < cursor.vendorId) return false;
  return group.assetId > cursor.assetId;
}

/**
 * Settled volume, count, and commission per vendor and asset.
 * Commission is each row's own `commission_bps`, floored the way `marketPurchase` floors.
 * Rejected and pending rows are counts only.
 */
export async function queryOpsSales(sql: Sql, input: OpsSalesQuery): Promise<OpsSalesPage> {
  if (input.actorScope !== MARKET_OPS_SCOPE) {
    throw new MarketError(MARKET_OPS_REQUIRED, MARKET_OPS_REQUIRED);
  }
  const window = requireOpsSalesWindow(input.from, input.to);
  const limit = assertOpsSalesListLimit(input.limit);
  const cursor = decodeSalesCursor(input.cursor);
  const fromIso = window.from.toISOString();
  const toIso = window.to.toISOString();
  const vendorId = input.vendorId ?? null;

  const facts = await sql<PurchaseFact[]>`
    SELECT vendor_id, asset_id, status, price::text AS price, commission_bps
      FROM market.purchases
     WHERE (
       (status = 'settled' AND settled_at >= ${fromIso}::timestamptz AND settled_at <= ${toIso}::timestamptz
         -- A held purchase is a sale only once released to the seller.
         AND NOT EXISTS (
           SELECT 1 FROM market.purchase_holds h WHERE h.purchase_id = market.purchases.id AND h.state <> 'released'
         ))
       OR (status = 'pending' AND created_at >= ${fromIso}::timestamptz AND created_at <= ${toIso}::timestamptz)
       OR (status = 'rejected' AND created_at >= ${fromIso}::timestamptz AND created_at <= ${toIso}::timestamptz)
     )
       AND (${vendorId}::uuid IS NULL OR vendor_id = ${vendorId}::uuid)
  `;

  const groups = new Map<string, Group>();
  let refused = 0;
  let pending = 0;
  for (const fact of facts) {
    if (fact.status === 'rejected') {
      refused += 1;
      continue;
    }
    if (fact.status === 'pending') {
      pending += 1;
      continue;
    }
    if (fact.status !== 'settled') continue;
    const key = `${fact.vendor_id}\u0000${fact.asset_id}`;
    const commission = commissionOfSnapshot(fact.price, fact.commission_bps);
    const price = parseAmount(fact.price);
    const existing = groups.get(key);
    if (existing) {
      existing.volume += price;
      existing.commission += commission;
      existing.count += 1;
    } else {
      groups.set(key, {
        vendorId: fact.vendor_id,
        assetId: fact.asset_id,
        volume: price,
        commission,
        count: 1,
      });
    }
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.vendorId !== b.vendorId) return a.vendorId < b.vendorId ? -1 : 1;
    if (a.assetId !== b.assetId) return a.assetId < b.assetId ? -1 : 1;
    return 0;
  });
  const visible = cursor ? ordered.filter((group) => afterCursor(group, cursor)) : ordered;
  const page = visible.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((group) => ({
      vendorId: group.vendorId,
      assetId: group.assetId,
      settledVolume: formatAmount(group.volume),
      settledCount: String(group.count),
      commission: formatAmount(group.commission),
    })),
    refusedCount: String(refused),
    pendingCount: String(pending),
    nextCursor: last && visible.length > limit ? encodeSalesCursor(last.vendorId, last.assetId) : null,
  };
}
