import type { AdminOrderRow } from './reads';

/**
 * Pure logic of the Orders room: page-size choices, the honest status word of a row, filters, the summary strip,
 * the truncation notice, what a held order means, and a tiny CSV writer for "Save selected as CSV".
 * No React and no network here, so every rule is tested without a browser. Money and quantities stay decimal strings.
 * (B3 owns the shared csv.ts; this room keeps its own small writer on purpose.)
 */

export const PAGE_SIZES = [50, 100, 200, 500] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 200;

/** The page size from a URL value. Anything not in the list falls back to the default, and the result is always sent explicitly. */
export function parsePageSize(raw: string | string[] | undefined): PageSize {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = v !== undefined && /^\d+$/.test(v) ? Number(v) : NaN;
  return (PAGE_SIZES as readonly number[]).includes(n) ? (n as PageSize) : DEFAULT_PAGE_SIZE;
}

/** First 8 characters of an id, for the table. The full id is always in the copy button and the detail page. */
export const shortId = (id: string): string => (id.length > 8 ? id.slice(0, 8) : id);

const isZero = (d: string): boolean => /^-?0+(\.0+)?$/.test(d);

export type StatusTone = 'neutral' | 'lime' | 'warn' | 'error';
export interface StatusWord {
  /** Filter key. */
  readonly key: 'open' | 'partial' | 'held' | 'filled' | 'canceled' | 'expired' | 'rejected';
  readonly label: string;
  readonly tone: StatusTone;
}

/** The word an operator reads. Held always wins: funds are reserved and the outcome is not known. */
export function statusWord(o: AdminOrderRow): StatusWord {
  if (o.held) return { key: 'held', label: 'Held for recovery', tone: 'warn' };
  switch (o.status) {
    case 'open':
      return !isZero(o.filled) && !isZero(o.remaining)
        ? { key: 'partial', label: 'Partially filled', tone: 'lime' }
        : { key: 'open', label: 'Open', tone: 'lime' };
    case 'closed':
      return { key: 'filled', label: 'Filled', tone: 'neutral' };
    case 'canceled':
      return { key: 'canceled', label: 'Canceled', tone: 'neutral' };
    case 'expired':
      return { key: 'expired', label: 'Expired', tone: 'neutral' };
    case 'rejected':
      return { key: 'rejected', label: 'Rejected', tone: 'error' };
  }
}

export const STATUS_FILTERS: readonly { value: string; label: string }[] = [
  { value: 'all', label: 'Any status' },
  { value: 'open', label: 'Open' },
  { value: 'partial', label: 'Partially filled' },
  { value: 'held', label: 'Held for recovery' },
  { value: 'filled', label: 'Filled' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'expired', label: 'Expired' },
  { value: 'rejected', label: 'Rejected' },
];

export interface OrderFilters {
  readonly market: string; // 'all' or a symbol
  readonly side: string; // 'all' | 'buy' | 'sell'
  readonly origin: string; // 'all' | 'seeded' | 'customer'
  readonly status: string; // 'all' or a StatusWord key
  readonly userId: string; // substring, case-insensitive
  readonly idSearch: string; // substring, case-insensitive (order id or client order id)
}

export const NO_FILTERS: OrderFilters = { market: 'all', side: 'all', origin: 'all', status: 'all', userId: '', idSearch: '' };

export function filterOrders(rows: readonly AdminOrderRow[], f: OrderFilters): AdminOrderRow[] {
  const user = f.userId.trim().toLowerCase();
  const id = f.idSearch.trim().toLowerCase();
  return rows.filter((o) => {
    if (f.market !== 'all' && o.symbol !== f.market) return false;
    if (f.side !== 'all' && o.side !== f.side) return false;
    if (f.origin === 'seeded' && !o.seeded) return false;
    if (f.origin === 'customer' && o.seeded) return false;
    if (f.status !== 'all' && statusWord(o).key !== f.status) return false;
    if (user && !o.userId.toLowerCase().includes(user)) return false;
    if (id && !o.id.toLowerCase().includes(id) && !(o.clientOrderId ?? '').toLowerCase().includes(id)) return false;
    return true;
  });
}

export function marketsOf(rows: readonly AdminOrderRow[]): string[] {
  return [...new Set(rows.map((o) => o.symbol))].sort();
}

export interface OrdersSummary {
  readonly shown: number;
  readonly open: number;
  readonly seeded: number;
  readonly held: number;
}

/** Counts only. Notional is deliberately NOT summed: mixed quote currencies and unknown prices would make a false total. */
export function summarize(rows: readonly AdminOrderRow[]): OrdersSummary {
  let open = 0;
  let seeded = 0;
  let held = 0;
  for (const o of rows) {
    if (o.held) held += 1;
    else if (o.status === 'open') open += 1;
    if (o.seeded) seeded += 1;
  }
  return { shown: rows.length, open, seeded, held };
}

/** Said when the service returned exactly as many rows as we asked for: there may be more that we cannot see. */
export function truncationNotice(returned: number, limit: number): string | null {
  return returned >= limit ? `Showing the newest ${limit} open orders; there may be more. Raise the page size to look further.` : null;
}

export interface HoldExplanation {
  readonly heading: string;
  readonly stage: string;
  readonly meaning: string;
}

/** What a held order means, by its recovery reason. Unknown reasons are shown as given, never guessed. */
export function explainHold(reason: string | null): HoldExplanation {
  const meaning =
    'Funds for this order are reserved. The outcome at the matching engine is not known. The reconcile sweep in svc-trade decides it; an operator cannot force it from here.';
  switch (reason) {
    case 'OUTCOME_UNKNOWN':
      return {
        heading: 'Outcome unknown',
        stage: 'OUTCOME_UNKNOWN: the engine answered, but the answer could not be matched to this order.',
        meaning,
      };
    case 'SUBMIT_UNKNOWN':
      return {
        heading: 'Submit unknown',
        stage: 'SUBMIT_UNKNOWN: the order was sent and the reply was lost. It may or may not be on the book.',
        meaning,
      };
    case 'RECONCILING':
      return {
        heading: 'Reconciling',
        stage: 'RECONCILING: the sweep has picked this order up and is checking it against the engine journal.',
        meaning,
      };
    default:
      return {
        heading: 'Held for recovery',
        stage: reason ? `Reason given by the service: ${reason}` : 'The service gave no recovery reason.',
        meaning,
      };
  }
}

// ── CSV (client side, only the selected rows) ───────────────────────────────

export const CSV_COLUMNS = [
  'id',
  'account',
  'market',
  'side',
  'type',
  'time_in_force',
  'price',
  'amount',
  'filled',
  'remaining',
  'status',
  'seeded',
  'created',
] as const;

/** One CSV cell. A cell that a spreadsheet could read as a formula (= + - @ tab or CR first) gets a leading apostrophe. */
export function csvCell(value: string | null): string {
  let s = value ?? '';
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ordersToCsv(rows: readonly AdminOrderRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const o of rows) {
    lines.push(
      [
        o.id,
        o.userId,
        o.symbol,
        o.side,
        o.type,
        o.timeInForce,
        o.price,
        o.amount,
        o.filled,
        o.remaining,
        statusWord(o).label,
        o.seeded ? 'house seed' : 'customer',
        o.datetime,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Lookup box on the list page: an order id is any non-empty token without spaces or slashes. */
export function cleanOrderId(raw: string): string | null {
  const t = raw.trim();
  return t.length > 0 && t.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(t) ? t : null;
}

/** Find an order in the open projection. Closed orders are not in it and operators cannot look them up (blocker). */
export function findOrder(rows: readonly AdminOrderRow[], id: string): AdminOrderRow | null {
  return rows.find((o) => o.id === id) ?? null;
}
