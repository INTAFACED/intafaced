import { EXPORT_KINDS, resolveExportColumns, type ExportFilters, type ExportKind } from './exports.js';
import { MerchantOpsError } from './errors.js';
import { assertPermission, type MerchantCaller } from './roles.js';

/**
 * M-rep-01 (spec group merchant-disp-bill-rep): reports centre options and
 * day boundaries computed in the merchant's chosen time zone, on the server.
 *
 * Builds on the existing export pipeline (exports.ts): the column allowlist is
 * `resolveExportColumns`, and a zoned period becomes the same `from`/`to`
 * filters the generator already applies (`>= from`, `< to`). No second
 * pipeline, no new storage.
 */

/** Which timestamp each kind's period filter is applied to, read from the generator queries in exports.ts. */
const DATE_BASIS = {
  payments: 'created',
  settlements: 'created',
  payouts: 'created',
  refunds: 'occurred',
  ledger_statement: 'none',
  disputes: 'opened',
  fees: 'recorded',
} as const satisfies Record<ExportKind, 'created' | 'occurred' | 'opened' | 'recorded' | 'none'>;

/** Only CSV is generated today. PDF and Excel are not offered until built. */
export const REPORT_FORMATS = ['csv'] as const;

const unknownZone = () => new MerchantOpsError('pay.export_time_zone_unknown', 'bad_request');
const badPeriod = () => new MerchantOpsError('pay.export_filter_invalid', 'bad_request');

export function assertTimeZone(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw unknownZone();
  }
}

/** Offset (ms) of `timeZone` from UTC at the instant `t`. */
function zoneOffsetMs(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The UTC instant at which local midnight of `day` (YYYY-MM-DD) begins in `timeZone`. */
export function zonedMidnight(day: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw badPeriod();
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const check = new Date(wall);
  if (check.getUTCFullYear() !== Number(m[1]) || check.getUTCMonth() !== Number(m[2]) - 1 || check.getUTCDate() !== Number(m[3]))
    throw badPeriod();
  let t = wall - zoneOffsetMs(wall, timeZone);
  t = wall - zoneOffsetMs(t, timeZone);
  return new Date(t);
}

export interface ZonedPeriod {
  /** First local day included, YYYY-MM-DD. */
  readonly fromDay: string;
  /** Last local day included, YYYY-MM-DD. */
  readonly toDay: string;
  readonly timeZone: string;
}

function nextDay(day: string): string {
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Turn local days in a zone into the generator's `from`/`to` (half-open, UTC).
 * Refuses an unknown zone, a reversed period, a period that starts in the
 * future, and a request that also names raw `from`/`to` (one meaning only).
 */
export function zonedFilters(filters: ExportFilters, period: ZonedPeriod, now: Date): ExportFilters {
  if (filters.from !== undefined || filters.to !== undefined) throw badPeriod();
  const zone = assertTimeZone(period.timeZone);
  const from = zonedMidnight(period.fromDay, zone);
  const to = zonedMidnight(nextDay(period.toDay), zone);
  if (from.getTime() >= to.getTime()) throw badPeriod();
  if (from.getTime() > now.getTime()) throw new MerchantOpsError('pay.export_period_future', 'bad_request');
  return { ...filters, from: from.toISOString(), to: to.toISOString() };
}

/** What the create form may offer this caller: per kind, the date basis and the columns their role may pick. */
export function reportOptions(caller: MerchantCaller) {
  assertPermission(caller, 'exports.read');
  const role = caller.role;
  return {
    formats: [...REPORT_FORMATS],
    timeZones: 'iana' as const,
    kinds: EXPORT_KINDS.map((kind) => ({
      kind,
      dateBasis: DATE_BASIS[kind],
      columns: resolveExportColumns(kind, role, undefined),
    })),
  };
}
