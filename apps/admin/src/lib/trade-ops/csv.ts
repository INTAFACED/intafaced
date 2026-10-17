/**
 * CSV writing for the desk's Exports room, in plain words: turn rows of text into a file an auditor can open.
 *
 *   · RFC 4180: comma separated, CRLF line ends, a cell is wrapped in double quotes when it holds a comma, a quote,
 *     a line break or a leading/trailing space; a quote inside is doubled.
 *   · Spreadsheet formula injection: Excel, Sheets and Numbers run a cell that starts with = + - @ tab or CR as a
 *     formula. Such a cell gets a leading apostrophe so it is read as text. The one exception is a plain decimal
 *     such as -12.5 : money and quantities must reach the file exactly as the service sent them, so a string that is
 *     only digits with an optional sign and fraction is never touched.
 *   · Decimals are strings end to end: no Number(), no rounding, no exponent form.
 *   · A header row first, no footer or totals row (a footer would be read as data).
 * Pure logic, no browser or server APIs, so it runs and tests anywhere.
 */

import type { AdminOrderRow } from './reads';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r]/;

/** The text of one cell, after the injection guard and before quoting. */
export function neutraliseCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (DECIMAL.test(value)) return value;
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** One cell as it appears in the file: guarded, then quoted when RFC 4180 needs it. */
export function csvCell(value: string | null | undefined): string {
  const text = neutraliseCell(value);
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Header row plus one line per row, joined with CRLF, ending in one CRLF. No footer. */
export function toCsv(columns: readonly string[], rows: readonly (readonly (string | null)[])[]): string {
  const lines = [columns.map((c) => csvCell(c)).join(','), ...rows.map((r) => columns.map((_, i) => csvCell(r[i] ?? null)).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

/** Characters that are safe in a file name on every system; everything else becomes a dash. */
const safeScope = (scope: string) =>
  scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'export';

/** `intafaced-<scope>-<as-of UTC>.csv`, e.g. intafaced-open-orders-20261017T031500Z.csv. */
export function exportFilename(scope: string, asOfIso: string): string {
  const t = new Date(asOfIso);
  const stamp = Number.isNaN(t.getTime())
    ? 'unknown-time'
    : t
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z');
  return `intafaced-${safeScope(scope)}-${stamp}.csv`;
}

// ── Datasets the desk can really export ─────────────────────────────────────

export const EXPORT_DATASETS = ['open_orders', 'kill_switch_audit', 'restriction_history'] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

export const ORDER_COLUMNS = [
  'id',
  'user',
  'symbol',
  'side',
  'type',
  'price',
  'amount',
  'filled',
  'remaining',
  'status',
  'held',
  'seeded',
  'created',
] as const;
export const KILL_SWITCH_COLUMNS = ['time', 'actor', 'confirming_operator', 'module', 'reason', 'previous', 'next'] as const;
export const RESTRICTION_COLUMNS = [
  'time',
  'audit_id',
  'request_id',
  'user',
  'action',
  'outcome',
  'code',
  'actor',
  'reason',
  'version_before',
  'version_after',
] as const;

export const DATASET_LABEL: Record<ExportDataset, string> = {
  open_orders: 'Open orders (all accounts)',
  kill_switch_audit: 'Kill-switch audit',
  restriction_history: 'Restriction history for one user',
};

/** Open orders as export rows. Seeded rows are dropped unless asked for. */
export function orderRows(orders: readonly AdminOrderRow[], includeSeeded: boolean): string[][] {
  return orders
    .filter((o) => includeSeeded || !o.seeded)
    .map((o) => [
      o.id,
      o.userId,
      o.symbol,
      o.side,
      o.type,
      o.price ?? '',
      o.amount,
      o.filled,
      o.remaining,
      o.status,
      o.held ? 'yes' : 'no',
      o.seeded ? 'yes' : 'no',
      o.datetime,
    ]);
}

export interface KillAuditLike {
  readonly at: string;
  readonly module: string;
  readonly actor: string;
  readonly confirmOperatorId?: string | null;
  readonly reason: string;
  readonly previous: boolean;
  readonly next: boolean;
}

const stopped = (disabled: boolean) => (disabled ? 'stopped' : 'running');

/** Kill-switch audit as export rows; `previous` and `next` are written as running / stopped. */
export function killSwitchRows(audit: readonly KillAuditLike[]): string[][] {
  return audit.map((a) => [a.at, a.actor, a.confirmOperatorId ?? '', a.module, a.reason, stopped(a.previous), stopped(a.next)]);
}

/** What the Exports BFF hands the browser: the rows as text, the columns, the file name and the honest limits of this file. */
export interface PreparedExport {
  readonly dataset: ExportDataset;
  readonly scope: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
  readonly filename: string;
  /** Limits worth knowing (cap reached, seeded excluded). Empty when none. */
  readonly notes: readonly string[];
}
