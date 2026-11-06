/**
 * One order as svc-trade's operator read gives it (`admin.orders.get`, J-cex-spot-18 #1, #2), for any state: the row,
 * every fill and the reject code. The service writes one audit row per read (kind `orders.get`). Browser-safe: no
 * server-only import, so the page and its tests share it.
 */

const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const dec = (v: unknown): v is string => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v);
const decOrNull = (v: unknown): v is string | null => v === null || dec(v);

/** trade.order_status, the service's own word. */
export type OrderStatusWord = 'pending' | 'open' | 'filled' | 'cancelled' | 'rejected' | 'expired' | 'recovery_required' | 'hold_unknown';
const STATUSES: readonly OrderStatusWord[] = [
  'pending',
  'open',
  'filled',
  'cancelled',
  'rejected',
  'expired',
  'recovery_required',
  'hold_unknown',
];

/** The status word the customer's own API gives for the same order (CCXT): svc-trade private-rest.ts toCcxtOrderStatus. */
export type CustomerStatus = 'open' | 'closed' | 'canceled' | 'expired' | 'rejected';

export function customerStatusOf(status: OrderStatusWord): CustomerStatus {
  switch (status) {
    case 'pending':
    case 'open':
    case 'recovery_required':
    case 'hold_unknown':
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

/** The status in the words the customer's order page uses. */
export function statusLabel(status: OrderStatusWord): string {
  switch (status) {
    case 'pending':
      return 'Received';
    case 'open':
      return 'Open';
    case 'filled':
      return 'Filled';
    case 'cancelled':
      return 'Cancelled';
    case 'rejected':
      return 'Rejected';
    case 'expired':
      return 'Expired';
    case 'recovery_required':
      return 'Held: outcome being recovered';
    case 'hold_unknown':
      return 'Held: funds reply lost';
  }
}

export interface OrderReadFill {
  readonly id: string;
  readonly price: string;
  readonly qty: string;
  readonly quoteAmount: string;
  readonly feeAmount: string;
}

export interface OrderRead {
  readonly id: string;
  readonly accountId: string;
  readonly marketId: string;
  readonly status: OrderStatusWord;
  readonly side: string;
  readonly type: string;
  readonly price: string | null;
  readonly qty: string;
  readonly filled: string;
  readonly holdAsset: string;
  readonly holdAmount: string;
  readonly seeded: boolean;
  readonly rejectCode: string | null;
  readonly createdAt: string;
  readonly fills: readonly OrderReadFill[];
}

/** `admin.orders.get` → OrderRead, or null when the answer is not that shape (a mismatch is a read problem, never a guess). */
export function parseOrderRead(v: unknown): OrderRead | null {
  if (!rec(v) || !rec(v.order) || !Array.isArray(v.fills)) return null;
  const o = v.order;
  if (!str(o.id) || !str(o.user_id) || !str(o.market_id) || !str(o.side) || !str(o.type)) return null;
  if (!str(o.status) || !(STATUSES as readonly string[]).includes(o.status)) return null;
  if (!decOrNull(o.price) || !dec(o.qty) || !dec(o.filled_qty) || !str(o.hold_asset) || !dec(o.hold_amount)) return null;
  if (o.reject_code !== null && !str(o.reject_code)) return null;
  if (typeof o.seeded !== 'boolean') return null;
  const createdAt = str(o.created_at) ? o.created_at : null;
  if (!createdAt) return null;
  const fills: OrderReadFill[] = [];
  for (const f of v.fills) {
    if (!rec(f) || !str(f.id) || !dec(f.price) || !dec(f.qty) || !dec(f.quoteAmount) || !dec(f.feeAmount)) return null;
    fills.push({ id: f.id, price: f.price, qty: f.qty, quoteAmount: f.quoteAmount, feeAmount: f.feeAmount });
  }
  return {
    id: o.id,
    accountId: o.user_id,
    marketId: o.market_id,
    status: o.status as OrderStatusWord,
    side: o.side,
    type: o.type,
    price: o.price,
    qty: o.qty,
    filled: o.filled_qty,
    holdAsset: o.hold_asset,
    holdAmount: o.hold_amount,
    seeded: o.seeded,
    rejectCode: o.reject_code,
    createdAt,
    fills,
  };
}

/** The reject reason as recorded, or "None recorded": never a guessed reason. */
export const rejectText = (code: string | null): string => (code && code.trim() ? code : 'None recorded');

/** Every order id (a UUID) a customer wrote in their request, first seen first, each once. */
export function orderIdsIn(...texts: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const m of (text ?? '').matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi))
      seen.add(m[0].toLowerCase());
  }
  return [...seen];
}

// ── Reconcile sweep (J-cex-spot-18 #3) ──────────────────────────────────────

export interface SweepResult {
  readonly checked: number;
  readonly released: number;
  readonly releasedOrderIds: readonly string[];
  readonly failedClosedOrderIds: readonly string[];
  readonly unreadableOrderIds: readonly string[];
  readonly ranAt: string;
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);

export function parseSweepResult(v: unknown): SweepResult | null {
  if (!rec(v) || !count(v.checked) || !count(v.released) || !ids(v.releasedOrderIds) || !str(v.ranAt)) return null;
  if (v.releasedOrderIds.length !== v.released) return null;
  const failed = v.failedClosedOrderIds ?? [];
  const unreadable = v.unreadableOrderIds ?? [];
  if (!ids(failed) || !ids(unreadable)) return null;
  return {
    checked: v.checked,
    released: v.released,
    releasedOrderIds: v.releasedOrderIds,
    failedClosedOrderIds: failed,
    unreadableOrderIds: unreadable,
    ranAt: v.ranAt,
  };
}

/** "<n> orders checked · <m> holds released", the sweep's own counts. */
export function sweepLine(r: SweepResult): string {
  return `${r.checked} orders checked · ${r.released} holds released`;
}

// ── Trade operator audit (J-cex-spot-18 #5) ─────────────────────────────────

export interface TradeAuditRow {
  readonly id: string;
  readonly kind: string;
  readonly operatorId: string;
  readonly accountId: string | null;
  readonly objectId: string;
  readonly approverId: string | null;
  readonly reason: string | null;
  readonly occurredAt: string;
}

export function parseTradeAudit(v: unknown): { rows: TradeAuditRow[]; nextCursor: string | null } | null {
  if (!rec(v) || !Array.isArray(v.rows)) return null;
  if (v.nextCursor !== null && v.nextCursor !== undefined && !str(v.nextCursor)) return null;
  const rows: TradeAuditRow[] = [];
  for (const r of v.rows) {
    if (!rec(r) || !str(r.id) || !str(r.kind) || !str(r.operatorId) || !str(r.objectId) || !str(r.occurredAt)) return null;
    if (r.accountId !== null && !str(r.accountId)) return null;
    if (r.approverId !== null && !str(r.approverId)) return null;
    if (r.reason !== null && !str(r.reason)) return null;
    rows.push({
      id: r.id,
      kind: r.kind,
      operatorId: r.operatorId,
      accountId: r.accountId,
      objectId: r.objectId,
      approverId: r.approverId,
      reason: r.reason,
      occurredAt: r.occurredAt,
    });
  }
  return { rows, nextCursor: (v.nextCursor as string | null | undefined) ?? null };
}
