/**
 * Copy settlement oversight (CB-ops-02, J-copy-bots-otc-11 #1 to #4): the shapes svc-trade's `copy.ops.settlements.*`
 * reads return, parsed. Plain data, safe in server and browser code. Every amount stays the service's decimal string.
 */

export type HeldReason = 'settle_unfinished' | 'ledger_post_missing' | 'ledger_amount_differs' | 'venue_not_reported' | 'venue_fee_differs';

/** The words a held row shows, one per reason (svc-trade `HELD_REASON_TEXT`). */
export const HELD_REASON_TEXT: Record<HeldReason, string> = {
  settle_unfinished: 'The settle started and did not finish; nothing is owed on it yet.',
  ledger_post_missing: 'The ledger has no post under the key.',
  ledger_amount_differs: 'The ledger post is a different amount from the share.',
  venue_not_reported: 'The venue reports no builder fee for this fill.',
  venue_fee_differs: 'The venue reports a different builder fee from the fee the share is of.',
};

const REASONS = Object.keys(HELD_REASON_TEXT) as HeldReason[];

export interface SettlementRow {
  readonly followId: string;
  readonly fillId: string;
  readonly leaderId: string;
  readonly followerId: string;
  readonly assetId: string;
  readonly feeOfFill: string;
  readonly owed: string;
  readonly status: 'settled' | 'held' | 'not_owed';
  readonly key: string;
  readonly sweepKey: string;
  readonly ledgerAmount: string | null;
  readonly venueAmount: string | null;
  readonly venueId: string | null;
  readonly reasons: readonly HeldReason[];
  readonly notOwedReason: 'cap_reached' | 'zero_share' | null;
  readonly createdAt: string;
}

export interface SettlementCounts {
  readonly compared: number;
  readonly settled: number;
  readonly held: number;
  readonly notOwed: number;
  readonly byReason: Readonly<Record<HeldReason, number>>;
}

export interface SettlementList {
  readonly asOf: string;
  readonly rows: readonly SettlementRow[];
  readonly counts: SettlementCounts;
}

export interface ReconcileResult {
  readonly window: SettlementWindow;
  readonly from: string;
  readonly through: string;
  readonly verdict: 'matched' | 'held' | 'nothing_to_compare';
  readonly counts: SettlementCounts;
}

export interface CopiedPosition {
  readonly positionId: string;
  readonly market: string;
  readonly bought: string;
  readonly open: string;
  readonly closing: string;
  readonly status: string;
  readonly placedAt: string;
}

export interface FollowAccounting {
  readonly followId: string;
  readonly leaderId: string;
  readonly followerId: string;
  readonly createdAt: string;
  readonly feeShares: readonly SettlementRow[];
  readonly positions: readonly CopiedPosition[];
  readonly asOf: string;
}

/** The windows finance chooses from; there is no default. */
export const SETTLEMENT_WINDOWS = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
] as const;
export type SettlementWindow = (typeof SETTLEMENT_WINDOWS)[number]['value'];

export const WINDOW_REQUIRED = 'Choose a window to reconcile.';

export function isSettlementWindow(v: unknown): v is SettlementWindow {
  return SETTLEMENT_WINDOWS.some((w) => w.value === v);
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strOrNull = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' ? v : undefined);
const DECIMAL = /^\d+(\.\d+)?$/;
const dec = (v: unknown): string | null => (typeof v === 'string' && DECIMAL.test(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** tRPC wraps the data as `{ result: { data } }`; edgeCall may hand either. */
function unwrap(raw: unknown): Rec | null {
  const r = rec(raw);
  const data = rec(rec(r?.result)?.data);
  return data ?? r;
}

function parseRow(raw: unknown): SettlementRow | null {
  const r = rec(raw);
  if (!r) return null;
  const status = r.status === 'settled' || r.status === 'held' || r.status === 'not_owed' ? r.status : null;
  const reasons = Array.isArray(r.reasons) ? r.reasons.filter((x): x is HeldReason => REASONS.includes(x as HeldReason)) : null;
  const fields = {
    followId: str(r.followId),
    fillId: str(r.fillId),
    leaderId: str(r.leaderId),
    followerId: str(r.followerId),
    assetId: str(r.assetId),
    feeOfFill: dec(r.feeOfFill),
    owed: dec(r.owed),
    key: str(r.key),
    sweepKey: str(r.sweepKey),
    createdAt: str(r.createdAt),
  };
  const ledgerAmount = strOrNull(r.ledgerAmount);
  const venueAmount = strOrNull(r.venueAmount);
  const venueId = strOrNull(r.venueId);
  const notOwedReason = r.notOwedReason === 'cap_reached' || r.notOwedReason === 'zero_share' ? r.notOwedReason : null;
  if (Object.values(fields).some((v) => v === null) || !status || !reasons) return null;
  if (ledgerAmount === undefined || venueAmount === undefined || venueId === undefined) return null;
  return { ...(fields as { [K in keyof typeof fields]: string }), status, reasons, ledgerAmount, venueAmount, venueId, notOwedReason };
}

function parseCounts(raw: unknown): SettlementCounts | null {
  const r = rec(raw);
  const by = rec(r?.byReason);
  if (!r || !by) return null;
  const byReason = Object.fromEntries(REASONS.map((k) => [k, int(by[k])])) as Record<HeldReason, number | null>;
  const compared = int(r.compared);
  const settled = int(r.settled);
  const held = int(r.held);
  const notOwed = int(r.notOwed);
  if (compared === null || settled === null || held === null || notOwed === null || Object.values(byReason).some((v) => v === null))
    return null;
  return { compared, settled, held, notOwed, byReason: byReason as Record<HeldReason, number> };
}

function parseRows(raw: unknown): SettlementRow[] | null {
  if (!Array.isArray(raw)) return null;
  const rows = raw.map(parseRow);
  return rows.some((r) => r === null) ? null : (rows as SettlementRow[]);
}

export function parseSettlementList(raw: unknown): SettlementList | null {
  const r = unwrap(raw);
  const asOf = str(r?.asOf);
  const rows = parseRows(r?.rows);
  const counts = parseCounts(r?.counts);
  return asOf && rows && counts ? { asOf, rows, counts } : null;
}

export function parseReconcileResult(raw: unknown): ReconcileResult | null {
  const r = unwrap(raw);
  if (!r) return null;
  const counts = parseCounts(r.counts);
  const from = str(r.from);
  const through = str(r.through);
  const verdict = r.verdict === 'matched' || r.verdict === 'held' || r.verdict === 'nothing_to_compare' ? r.verdict : null;
  if (!counts || !from || !through || !verdict || !isSettlementWindow(r.window)) return null;
  return { window: r.window, from, through, verdict, counts };
}

function parsePosition(raw: unknown): CopiedPosition | null {
  const r = rec(raw);
  if (!r) return null;
  const p = {
    positionId: str(r.positionId),
    market: str(r.market),
    bought: dec(r.bought),
    open: dec(r.open),
    closing: dec(r.closing),
    status: str(r.status),
    placedAt: str(r.placedAt),
  };
  return Object.values(p).some((v) => v === null) ? null : (p as CopiedPosition);
}

export function parseFollowAccounting(raw: unknown): FollowAccounting | null {
  const r = unwrap(raw);
  if (!r) return null;
  const feeShares = parseRows(r.feeShares);
  const positions = Array.isArray(r.positions) ? r.positions.map(parsePosition) : null;
  const head = {
    followId: str(r.followId),
    leaderId: str(r.leaderId),
    followerId: str(r.followerId),
    createdAt: str(r.createdAt),
    asOf: str(r.asOf),
  };
  if (!feeShares || !positions || positions.some((p) => p === null) || Object.values(head).some((v) => v === null)) return null;
  return { ...(head as { [K in keyof typeof head]: string }), feeShares, positions: positions as CopiedPosition[] };
}

export const STATUS_LABEL: Record<SettlementRow['status'], string> = { settled: 'Settled', held: 'Held', not_owed: 'Not owed' };

/** One line for a reconcile run: what it compared, through when, and the counts. */
export function reconcileLine(r: ReconcileResult): string {
  const label = SETTLEMENT_WINDOWS.find((w) => w.value === r.window)?.label ?? r.window;
  if (r.verdict === 'nothing_to_compare') return `${label}: nothing to compare through ${r.through.slice(0, 19).replace('T', ' ')} UTC.`;
  return (
    `${label}: ${r.counts.compared} compared through ${r.through.slice(0, 19).replace('T', ' ')} UTC. ` +
    `Settled ${r.counts.settled}, held ${r.counts.held}, not owed ${r.counts.notOwed}.`
  );
}
