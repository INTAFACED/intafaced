/**
 * P2P ORDER LIST (P-trade-orders-13) — pure helpers, no I/O.
 *
 * The six-state machine (ENGINE-SPEC R1, `state.ts`) is unchanged. On top of
 * it this file derives two read-only views, server-side so the client never
 * guesses a label:
 *
 *  - `tabOf`: which list tab (in progress, in dispute, completed, cancelled)
 *    a trade belongs to.
 *  - `displayStatus`: the readable status, which also tells apart a
 *    cancel by timeout and a cancel by dispute ruling, using the recorded
 *    resolution reason (`timeout.*`, `moderator:*`).
 *
 * Only the standard order type exists. Small-coin and web3 (chain-wait)
 * order types depend on a chain order type outside this lane and are not
 * offered here.
 */
import type { TradeStatus } from './state.js';

export const ORDER_TABS = ['in_progress', 'in_dispute', 'completed', 'cancelled'] as const;
export type OrderTab = (typeof ORDER_TABS)[number];

export const TAB_STATUSES: Record<OrderTab, readonly TradeStatus[]> = {
  in_progress: ['created', 'escrowed', 'fiat_sent'],
  in_dispute: ['disputed'],
  completed: ['released'],
  cancelled: ['cancelled'],
};

export function tabOf(status: TradeStatus): OrderTab {
  for (const tab of ORDER_TABS) if (TAB_STATUSES[tab].includes(status)) return tab;
  // A status outside the enum is a server/data fault, not a caller's bad filter.
  throw new Error(`order-list: unknown trade status ${String(status)}`);
}

export const DISPLAY_STATUSES = [
  'waiting_for_escrow',
  'waiting_for_buyer_to_pay',
  'waiting_for_seller_to_release',
  'appealing',
  'completed',
  'completed_by_dispute_ruling',
  'cancelled',
  'cancelled_by_timeout',
  'cancelled_by_dispute_ruling',
] as const;
export type DisplayStatus = (typeof DISPLAY_STATUSES)[number];

export function displayStatus(trade: { status: TradeStatus; resolutionReason: string | null }): DisplayStatus {
  const reason = trade.resolutionReason ?? '';
  switch (trade.status) {
    case 'created':
      return 'waiting_for_escrow';
    case 'escrowed':
      return 'waiting_for_buyer_to_pay';
    case 'fiat_sent':
      return 'waiting_for_seller_to_release';
    case 'disputed':
      return 'appealing';
    case 'released':
      return reason.startsWith('moderator:') ? 'completed_by_dispute_ruling' : 'completed';
    case 'cancelled':
      if (reason.startsWith('timeout.')) return 'cancelled_by_timeout';
      if (reason.startsWith('moderator:')) return 'cancelled_by_dispute_ruling';
      return 'cancelled';
  }
}

export class OrderListError extends Error {
  constructor(
    message: string,
    readonly code: 'p2p.cursor_invalid' | 'p2p.filter_invalid',
  ) {
    super(message);
    this.name = 'OrderListError';
  }
}

export interface OrderListFilter {
  readonly tab?: OrderTab;
  readonly asset?: string;
  /** Relative to the viewer: `buy` = viewer is the buyer. */
  readonly side?: 'buy' | 'sell';
  readonly from?: Date;
  readonly to?: Date;
  /** Order id or a leading part of it (hex and dashes). */
  readonly orderId?: string;
}

export interface RawOrderListFilter {
  tab?: string;
  asset?: string;
  side?: string;
  from?: string;
  to?: string;
  orderId?: string;
}

function bad(what: string): never {
  throw new OrderListError(`invalid order list filter: ${what}`, 'p2p.filter_invalid');
}

function parseInstant(raw: string, what: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(raw)) bad(what);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) bad(what);
  return d;
}

/** Every filter is optional; any present filter that is malformed refuses `p2p.filter_invalid`. */
export function parseOrderListFilter(raw: RawOrderListFilter = {}): OrderListFilter {
  const out: { -readonly [K in keyof OrderListFilter]: OrderListFilter[K] } = {};
  if (raw.tab !== undefined) {
    if (!(ORDER_TABS as readonly string[]).includes(raw.tab)) bad('tab');
    out.tab = raw.tab as OrderTab;
  }
  if (raw.asset !== undefined) {
    if (!/^[A-Z0-9]{2,15}$/.test(raw.asset)) bad('asset');
    out.asset = raw.asset;
  }
  if (raw.side !== undefined) {
    if (raw.side !== 'buy' && raw.side !== 'sell') bad('side');
    out.side = raw.side;
  }
  if (raw.from !== undefined) out.from = parseInstant(raw.from, 'from');
  if (raw.to !== undefined) out.to = parseInstant(raw.to, 'to');
  if (out.from && out.to && out.from.getTime() > out.to.getTime()) bad('from after to');
  if (raw.orderId !== undefined) {
    const q = raw.orderId.trim().toLowerCase();
    // This allowlist is what makes the unescaped LIKE prefix in pageTrades safe:
    // no '%', '_' or '\\' can pass. Widen it only together with LIKE escaping.
    if (!/^[0-9a-f-]{1,36}$/.test(q)) bad('orderId');
    out.orderId = q;
  }
  return out;
}

/**
 * Keyset cursor over (created_at in microseconds, id), newest first.
 * Opaque to the client; anything that does not decode refuses.
 */
export function encodeTradeCursor(createdAtMicros: string, id: string): string {
  return Buffer.from(`${createdAtMicros}\n${id}`, 'utf8').toString('base64url');
}

export function decodeTradeCursor(cursor: string): { createdAtMicros: string; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const [micros, id, extra] = raw.split('\n');
  if (
    extra !== undefined ||
    !micros ||
    !id ||
    !/^\d{1,20}$/.test(micros) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  ) {
    throw new OrderListError('p2p.cursor_invalid', 'p2p.cursor_invalid');
  }
  return { createdAtMicros: micros, id };
}
