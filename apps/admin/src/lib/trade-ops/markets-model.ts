import type { AdminOrderRow, LifecycleRow, LifecycleState, MarketRecordStatus, MarketRow } from './reads';
import type { Outcome } from './outcome';

/**
 * Pure logic for the Markets and Health rooms: how a lifecycle state is worded and grouped, how open orders are
 * counted per market, the list filters, the tile counts, and the check an action must pass before it is sent.
 * No network, no clock, no browser: safe to run in tests. Counts are whole numbers; money stays a decimal string elsewhere.
 */

// ── Lifecycle wording ────────────────────────────────────────────────────────

export type StatusGroup = 'open' | 'restricted' | 'halted' | 'ended' | 'not_live' | 'unknown';

export interface LifecycleLook {
  readonly word: string;
  readonly group: StatusGroup;
  readonly tone: 'neutral' | 'warn' | 'error' | 'lime';
  /** A shape that carries the meaning without colour. */
  readonly glyph: string;
}

const LOOKS: Record<LifecycleState, LifecycleLook> = {
  DRAFT: { word: 'Draft', group: 'not_live', tone: 'neutral', glyph: '○' },
  REVIEW: { word: 'In review', group: 'not_live', tone: 'neutral', glyph: '○' },
  APPROVED: { word: 'Approved', group: 'not_live', tone: 'neutral', glyph: '○' },
  PRELAUNCH: { word: 'Pre-launch', group: 'not_live', tone: 'neutral', glyph: '○' },
  AUCTION: { word: 'Auction', group: 'restricted', tone: 'warn', glyph: '◐' },
  OPEN: { word: 'Open', group: 'open', tone: 'neutral', glyph: '●' },
  POST_ONLY: { word: 'Post-only', group: 'restricted', tone: 'warn', glyph: '◐' },
  CANCEL_ONLY: { word: 'Cancel-only', group: 'restricted', tone: 'warn', glyph: '◐' },
  REDUCE_ONLY: { word: 'Reduce-only', group: 'restricted', tone: 'warn', glyph: '◐' },
  HALTED: { word: 'Halted', group: 'halted', tone: 'error', glyph: '■' },
  EXPIRING: { word: 'Expiring', group: 'restricted', tone: 'warn', glyph: '◐' },
  EXPIRED: { word: 'Expired', group: 'ended', tone: 'neutral', glyph: '✕' },
  SETTLING: { word: 'Settling', group: 'ended', tone: 'warn', glyph: '✕' },
  SETTLED: { word: 'Settled', group: 'ended', tone: 'neutral', glyph: '✕' },
  DELISTING: { word: 'Delisting', group: 'ended', tone: 'warn', glyph: '✕' },
  REFUSED: { word: 'Refused', group: 'ended', tone: 'error', glyph: '✕' },
  ARCHIVED: { word: 'Archived', group: 'ended', tone: 'neutral', glyph: '✕' },
};

export const UNKNOWN_LOOK: LifecycleLook = { word: 'Unknown', group: 'unknown', tone: 'neutral', glyph: '?' };

export function lifecycleLook(state: LifecycleState | null): LifecycleLook {
  return state ? LOOKS[state] : UNKNOWN_LOOK;
}

/** The market record status (svc-trade), which is coarser than the lifecycle state. */
export function recordStatusLook(status: MarketRecordStatus): { word: string; tone: 'neutral' | 'warn' | 'error' | 'lime'; glyph: string } {
  switch (status) {
    case 'active':
      return { word: 'Active', tone: 'neutral', glyph: '●' };
    case 'pending':
      return { word: 'Pending', tone: 'neutral', glyph: '○' };
    case 'halted':
      return { word: 'Halted', tone: 'error', glyph: '■' };
    case 'delisted':
      return { word: 'Delisted', tone: 'neutral', glyph: '✕' };
  }
}

// ── Joining markets, lifecycle and open orders ──────────────────────────────

export interface OrderTally {
  readonly open: number;
  readonly seeded: number;
  readonly held: number;
}

/** One list row: the market record, its lifecycle read (null = not read), and its open-order tally (null = orders not read). */
export interface MarketRowView {
  readonly market: MarketRow;
  readonly lifecycle: Outcome<LifecycleRow> | null;
  readonly orders: OrderTally | null;
}

export const ZERO_TALLY: OrderTally = { open: 0, seeded: 0, held: 0 };

/** Count open orders per symbol. Only status "open" counts; held (recovery) orders are counted as open AND held. */
export function tallyOrders(orders: readonly AdminOrderRow[]): Map<string, OrderTally> {
  const out = new Map<string, OrderTally>();
  for (const o of orders) {
    if (o.status !== 'open') continue;
    const t = out.get(o.symbol) ?? ZERO_TALLY;
    out.set(o.symbol, { open: t.open + 1, seeded: t.seeded + (o.seeded ? 1 : 0), held: t.held + (o.held ? 1 : 0) });
  }
  return out;
}

export function sumTallies(orders: readonly AdminOrderRow[]): OrderTally {
  let t = ZERO_TALLY;
  for (const o of orders)
    if (o.status === 'open') t = { open: t.open + 1, seeded: t.seeded + (o.seeded ? 1 : 0), held: t.held + (o.held ? 1 : 0) };
  return t;
}

/** Whole-number percent of open orders that are seeded. null when there are no open orders (not 0%). */
export function seededPercent(t: OrderTally | null): number | null {
  if (!t || t.open === 0) return null;
  return Math.round((t.seeded * 100) / t.open);
}

export function lifecycleOf(view: MarketRowView): LifecycleRow | null {
  return view.lifecycle?.kind === 'ok' ? view.lifecycle.data : null;
}

export function viewLook(view: MarketRowView): LifecycleLook {
  return lifecycleLook(lifecycleOf(view)?.state ?? null);
}

// ── Filters ──────────────────────────────────────────────────────────────────

export interface MarketFilter {
  readonly status: 'all' | MarketRecordStatus;
  readonly kind: 'all' | MarketRow['kind'];
  readonly search: string;
}

export const NO_FILTER: MarketFilter = { status: 'all', kind: 'all', search: '' };

export function filterMarkets(rows: readonly MarketRowView[], f: MarketFilter): MarketRowView[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (f.status === 'all' || r.market.status === f.status) &&
      (f.kind === 'all' || r.market.kind === f.kind) &&
      (q === '' || r.market.symbol.toLowerCase().includes(q)),
  );
}

// ── Health counts ────────────────────────────────────────────────────────────

export interface MarketCounts {
  readonly total: number;
  readonly byGroup: Readonly<Record<StatusGroup, number>>;
  readonly byRecord: Readonly<Record<MarketRecordStatus, number>>;
  /** Markets whose lifecycle was read successfully. */
  readonly lifecycleRead: number;
  /** Distinct refusal / unknown codes seen when reading lifecycles, for the tile text. */
  readonly lifecycleProblems: readonly string[];
}

export function countMarkets(rows: readonly MarketRowView[]): MarketCounts {
  const byGroup: Record<StatusGroup, number> = { open: 0, restricted: 0, halted: 0, ended: 0, not_live: 0, unknown: 0 };
  const byRecord: Record<MarketRecordStatus, number> = { pending: 0, active: 0, halted: 0, delisted: 0 };
  const problems = new Set<string>();
  let read = 0;
  for (const r of rows) {
    byRecord[r.market.status] += 1;
    byGroup[viewLook(r).group] += 1;
    if (r.lifecycle?.kind === 'ok') read += 1;
    else if (r.lifecycle?.kind === 'refused') problems.add(r.lifecycle.code);
    else if (r.lifecycle?.kind === 'unknown') problems.add('no answer');
    else problems.add('not read (limit)');
  }
  return { total: rows.length, byGroup, byRecord, lifecycleRead: read, lifecycleProblems: [...problems] };
}

/** The oldest of several ISO times, or null if there are none. Used for "data freshness: oldest as-of". */
export function oldestAsOf(times: readonly (string | null | undefined)[]): string | null {
  let best: { ms: number; iso: string } | null = null;
  for (const t of times) {
    if (!t) continue;
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) continue;
    if (best === null || ms < best.ms) best = { ms, iso: t };
  }
  return best?.iso ?? null;
}

/** "14:03:07 UTC" from an ISO time; "—" when missing. */
export function clockUtc(iso: string | null | undefined): string {
  return iso && iso.length >= 19 ? `${iso.slice(11, 19)} UTC` : '—';
}

// ── Actions ──────────────────────────────────────────────────────────────────

export type MarketActionName = 'halt' | 'reduce_only' | 'post_only' | 'resume' | 'delist';

export interface MarketActionRule {
  readonly name: MarketActionName;
  readonly label: string;
  /** A second, distinct operator and an approval id are required. */
  readonly twoPerson: boolean;
  /** The operator must type the symbol to confirm. */
  readonly typeSymbol: boolean;
}

export const MARKET_ACTIONS: readonly MarketActionRule[] = [
  { name: 'halt', label: 'Halt', twoPerson: true, typeSymbol: false },
  { name: 'reduce_only', label: 'Reduce-only', twoPerson: false, typeSymbol: false },
  { name: 'post_only', label: 'Post-only', twoPerson: false, typeSymbol: false },
  { name: 'resume', label: 'Resume', twoPerson: true, typeSymbol: false },
  { name: 'delist', label: 'Delist', twoPerson: true, typeSymbol: true },
];

export const REASON_MIN = 12;
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export interface ValidAction {
  readonly action: MarketActionName;
  readonly symbol: string;
  readonly reason: string;
  readonly confirmOperatorId: string | null;
  readonly approvalId: string | null;
}

export type ActionCheck =
  { readonly ok: true; readonly value: ValidAction } | { readonly ok: false; readonly code: string; readonly message: string };

const bad = (code: string, message: string): ActionCheck => ({ ok: false, code, message });
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * What must be true before any market action is sent. The signed-in user is the requester; the second person is a
 * DIFFERENT operator id carried by the approval, never the requester. Delist also needs the symbol typed back exactly.
 */
export function validateMarketAction(body: Record<string, unknown>, requesterId: string): ActionCheck {
  const rule = MARKET_ACTIONS.find((a) => a.name === body.action);
  if (!rule) return bad('trade_ops.bad_action', 'Unknown market action. Use halt, reduce_only, post_only, resume or delist.');
  const symbol = text(body.symbol);
  if (symbol === '') return bad('trade_ops.symbol_required', 'A market symbol is required.');
  const reason = text(body.reason);
  if (reason.length < REASON_MIN)
    return bad('trade_ops.reason_too_short', `A reason of at least ${REASON_MIN} characters is required: it is written to the audit.`);
  const second = text(body.confirmOperatorId);
  const approval = text(body.approvalId);
  if (rule.twoPerson && second === '')
    return bad('trade_ops.second_operator_required', `${rule.label} needs a second operator: enter their operator id.`);
  if (rule.twoPerson && approval === '')
    return bad('trade_ops.approval_required', `${rule.label} needs the approval id the second operator issued.`);
  if (second !== '' && !ID_SHAPE.test(second)) return bad('trade_ops.second_operator_invalid', 'The second operator id is not a valid id.');
  if (approval !== '' && !ID_SHAPE.test(approval)) return bad('trade_ops.approval_invalid', 'The approval id is not a valid id.');
  if (second !== '' && second.toLowerCase() === requesterId.toLowerCase())
    return bad('trade_ops.same_person', 'The second operator must be a different person from the one signed in.');
  if (rule.typeSymbol && text(body.typedSymbol) !== symbol)
    return bad('trade_ops.symbol_mismatch', `Delist is irreversible: type the symbol ${symbol} exactly to confirm.`);
  return { ok: true, value: { action: rule.name, symbol, reason, confirmOperatorId: second || null, approvalId: approval || null } };
}
