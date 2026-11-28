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
  /** Missing from the book, seen for the first time: a later sweep a floor on may release them. */
  readonly firstSightedOrderIds: readonly string[];
  /** Missing from the book, first seen less than the floor ago: still waiting. */
  readonly waitingOrderIds: readonly string[];
  /** Missing from the book, but fills could not prove no fill: holds kept. */
  readonly failedClosedOrderIds: readonly string[];
  /** Missing from the book with no hold left: ended, nothing released. */
  readonly terminalizedNoHoldOrderIds: readonly string[];
  readonly otherActionOrderIds: readonly string[];
  /** Not read: nothing was done to them. */
  readonly unreadableOrderIds: readonly string[];
  /** The reconcile failed after it acted on the order: read each one before anything else. */
  readonly erroredAfterActingOrderIds: readonly string[];
  readonly ranAt: string;
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);

export function parseSweepResult(v: unknown): SweepResult | null {
  if (!rec(v) || !count(v.checked) || !count(v.released) || !ids(v.releasedOrderIds) || !str(v.ranAt)) return null;
  if (v.releasedOrderIds.length !== v.released) return null;
  const lists = {
    firstSightedOrderIds: v.firstSightedOrderIds,
    waitingOrderIds: v.waitingOrderIds,
    failedClosedOrderIds: v.failedClosedOrderIds,
    terminalizedNoHoldOrderIds: v.terminalizedNoHoldOrderIds,
    otherActionOrderIds: v.otherActionOrderIds,
    unreadableOrderIds: v.unreadableOrderIds,
    erroredAfterActingOrderIds: v.erroredAfterActingOrderIds,
  };
  // Every list must be there: a missing one would read as "none", which is a guess.
  if (!Object.values(lists).every(ids)) return null;
  return {
    checked: v.checked,
    released: v.released,
    releasedOrderIds: v.releasedOrderIds,
    ...(lists as Record<keyof typeof lists, string[]>),
    ranAt: v.ranAt,
  };
}

/** admin.orders.reconcileStatus: the last sweep svc-trade ran, or none ever (J-cex-spot-20 #2). */
export type ReconcileStatus = { readonly kind: 'none' } | { readonly kind: 'swept'; readonly at: string; readonly result: SweepResult };

export function parseReconcileStatus(v: unknown): ReconcileStatus | null {
  if (!rec(v)) return null;
  if (v.lastSweepAt === null && v.result === null) return { kind: 'none' };
  if (!str(v.lastSweepAt)) return null;
  const result = parseSweepResult(v.result);
  return result ? { kind: 'swept', at: v.lastSweepAt, result } : null;
}

/** "<n> orders checked · <m> holds released", the sweep's own counts. */
export function sweepLine(r: SweepResult): string {
  return `${r.checked} orders checked · ${r.released} holds released`;
}

/** What a sweep left for an operator to read: each list it could not settle, with its count; empty when none. */
export function sweepLeftOpen(r: SweepResult): string[] {
  const out: string[] = [];
  if (r.erroredAfterActingOrderIds.length) out.push(`${r.erroredAfterActingOrderIds.length} failed after acting (read these first)`);
  if (r.failedClosedOrderIds.length) out.push(`${r.failedClosedOrderIds.length} kept their hold: fills could not prove no fill`);
  if (r.unreadableOrderIds.length) out.push(`${r.unreadableOrderIds.length} could not be read`);
  if (r.waitingOrderIds.length) out.push(`${r.waitingOrderIds.length} waiting for a second look`);
  return out;
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

// ── A customer's routed order (J-cex-spot-18 #1 #2, row d115) ───────────────

/** A venue client order id (`0x` and 32 hex): the id a customer's routed order goes by, never an own-book order id. */
export const VENUE_ORDER_ID = /^0x[0-9a-f]{32}$/i;

/** Every routed-order id a customer wrote in their request, first seen first, each once, lower case. */
export function venueOrderIdsIn(...texts: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const text of texts) for (const m of (text ?? '').matchAll(/\b0x[0-9a-f]{32}\b/gi)) seen.add(m[0].toLowerCase());
  return [...seen];
}

/** The venue's own order status word (packages/venue-contracts VenueOrderStatus). */
export type VenueStatusWord = 'open' | 'partially_filled' | 'filled' | 'canceled' | 'rejected' | 'expired';
const VENUE_STATUSES: readonly VenueStatusWord[] = ['open', 'partially_filled', 'filled', 'canceled', 'rejected', 'expired'];

/** The status in the words the customer's own order page uses (apps/customer venue-copy `status_*`). */
export function venueStatusLabel(status: VenueStatusWord): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'partially_filled':
      return 'Partly filled';
    case 'filled':
      return 'Filled';
    case 'canceled':
      return 'Cancelled';
    case 'rejected':
      return 'Rejected';
    case 'expired':
      return 'Expired';
  }
}

export interface VenueOrderFill {
  readonly fillId: string;
  readonly price: string;
  readonly amount: string;
  readonly role: string;
  readonly venueFee: string;
  readonly builderFee: string;
  readonly feeAsset: string;
  readonly filledAt: string;
}

export interface VenueOrderView {
  readonly symbol: string;
  readonly side: string;
  readonly type: string;
  readonly timeInForce: string;
  readonly price: string;
  readonly amount: string;
  readonly filled: string;
  readonly remaining: string;
  readonly averagePrice: string | null;
  readonly status: VenueStatusWord;
}

export interface VenueOrderRead {
  readonly accountId: string;
  readonly venueId: string;
  readonly owner: string;
  readonly subAccount: string | null;
  readonly venueClientOrderId: string;
  readonly recordedAt: string;
  readonly sent: 'accepted' | 'refused' | 'unknown';
  readonly order: VenueOrderView | null;
  readonly fills: readonly VenueOrderFill[];
  readonly reject: { readonly source: string; readonly code: string; readonly detail: string } | null;
  readonly asOf: string;
}

/** `admin.orders.venueGet` → VenueOrderRead, or null when the answer is not that shape. */
export function parseVenueOrderRead(v: unknown): VenueOrderRead | null {
  if (!rec(v) || !str(v.accountId) || !str(v.venueId) || !str(v.owner) || !str(v.venueClientOrderId)) return null;
  if (!(v.subAccount === null || str(v.subAccount)) || !str(v.recordedAt) || !str(v.asOf)) return null;
  if (v.sent !== 'accepted' && v.sent !== 'refused' && v.sent !== 'unknown') return null;
  let order: VenueOrderView | null = null;
  if (v.order !== null) {
    const o = v.order;
    if (!rec(o) || !str(o.symbol) || !str(o.side) || !str(o.type) || !str(o.timeInForce)) return null;
    if (!dec(o.price) || !dec(o.amount) || !dec(o.filled) || !dec(o.remaining) || !decOrNull(o.averagePrice)) return null;
    if (!str(o.status) || !(VENUE_STATUSES as readonly string[]).includes(o.status)) return null;
    order = {
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      timeInForce: o.timeInForce,
      price: o.price,
      amount: o.amount,
      filled: o.filled,
      remaining: o.remaining,
      averagePrice: o.averagePrice,
      status: o.status as VenueStatusWord,
    };
  }
  if (!Array.isArray(v.fills)) return null;
  const fills: VenueOrderFill[] = [];
  for (const f of v.fills) {
    if (!rec(f) || !str(f.fillId) || !dec(f.price) || !dec(f.amount) || !str(f.role)) return null;
    if (!dec(f.venueFee) || !dec(f.builderFee) || !str(f.feeAsset) || !str(f.filledAt)) return null;
    fills.push({
      fillId: f.fillId,
      price: f.price,
      amount: f.amount,
      role: f.role,
      venueFee: f.venueFee,
      builderFee: f.builderFee,
      feeAsset: f.feeAsset,
      filledAt: f.filledAt,
    });
  }
  let reject: VenueOrderRead['reject'] = null;
  if (v.reject !== null) {
    const r = v.reject;
    if (!rec(r) || !str(r.source) || !str(r.code) || !str(r.detail)) return null;
    reject = { source: r.source, code: r.code, detail: r.detail };
  }
  return {
    accountId: v.accountId,
    venueId: v.venueId,
    owner: v.owner,
    subAccount: v.subAccount,
    venueClientOrderId: v.venueClientOrderId,
    recordedAt: v.recordedAt,
    sent: v.sent,
    order,
    fills,
    reject,
    asOf: v.asOf,
  };
}
