/**
 * P2P EXPORT CAPS AND RECEIPTS (P-trade-orders-14) — pure policy, no I/O.
 *
 * Every limit is an owner value. Blank is not a number: an unset cap refuses
 * `p2p.config_unset` rather than inventing a range or a quota. Only CSV is
 * built; XLSX and PDF need a generator dependency and are refused by name.
 */

export interface ExportPolicy {
  /** Longest export range in whole days. */
  readonly maxRangeDays?: number;
  /** Most rows in one export file. */
  readonly maxRows?: number;
  /** Receipt downloads per user per UTC day. */
  readonly receiptDailyQuota?: number;
  /** Downloads of one trade's receipt per user, ever. */
  readonly receiptPerTradeQuota?: number;
}

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type ExportPolicyCode =
  | 'p2p.config_unset'
  | 'p2p.export_format_unbuilt'
  | 'p2p.export_range_too_large'
  | 'p2p.export_too_many_rows'
  | 'p2p.receipt_quota_reached'
  | 'p2p.receipt_not_available';

export class ExportPolicyError extends Error {
  constructor(
    message: string,
    readonly code: ExportPolicyCode,
  ) {
    super(message);
    this.name = 'ExportPolicyError';
  }
}

/** A configured positive integer, or a typed refusal naming the missing setting. */
export function requireSetting(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    throw new ExportPolicyError(`p2p.config_unset: ${name}`, 'p2p.config_unset');
  }
  return value;
}

export function assertFormatBuilt(format: ExportFormat): 'csv' {
  if (format !== 'csv') {
    throw new ExportPolicyError(`p2p.export_format_unbuilt: ${format}`, 'p2p.export_format_unbuilt');
  }
  return format;
}

const DAY_MS = 86_400_000;

export function assertRangeWithinCap(from: Date, to: Date, maxRangeDays: number): void {
  if (to.getTime() - from.getTime() > maxRangeDays * DAY_MS) {
    throw new ExportPolicyError(`p2p.export_range_too_large: at most ${maxRangeDays} days per file`, 'p2p.export_range_too_large');
  }
}

export function assertRowsWithinCap(rows: number, maxRows: number): void {
  if (rows > maxRows) {
    throw new ExportPolicyError(`p2p.export_too_many_rows: ${rows} rows, at most ${maxRows} per file`, 'p2p.export_too_many_rows');
  }
}

/** Start of the next UTC day: when a daily receipt quota resets. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
