import { OpsError } from '../codes.js';
import type { OpsService } from '../ops-service.js';

/** What one check of a signal returned. A failed or empty check is never read as "normal". */
export type SignalReading =
  { readonly status: 'ok'; readonly value: string } | { readonly status: 'no_data' } | { readonly status: 'error'; readonly code: string };

export interface SignalReader {
  read(signal: string): Promise<SignalReading>;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

interface Decimal {
  readonly negative: boolean;
  readonly whole: string;
  /** Digits after the point, without trailing zeros. */
  readonly fraction: string;
}

/** Splits a decimal string into digits. Nothing is converted to a number or rounded. Null when it is not a plain decimal. */
function split(value: string): Decimal | null {
  const m = DECIMAL.exec(value);
  if (!m) return null;
  const whole = (m[2] ?? '0').replace(/^0+(?=\d)/, '');
  const fraction = (m[3] ?? '').replace(/0+$/, '');
  return { negative: m[1] === '-' && !(whole === '0' && fraction === ''), whole, fraction };
}

/** Exact comparison of two decimal strings, as digits: longer whole part wins, then the digits left to right. */
function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const magnitude =
    a.whole.length !== b.whole.length
      ? a.whole.length < b.whole.length
        ? -1
        : 1
      : a.whole !== b.whole
        ? a.whole < b.whole
          ? -1
          : 1
        : a.fraction === b.fraction
          ? 0
          : a.fraction < b.fraction
            ? -1
            : 1;
  return (a.negative ? -magnitude : magnitude) as -1 | 0 | 1;
}

/** True when the value is a plain decimal string this module can compare. */
export function isDecimal(value: string): boolean {
  return split(value) !== null;
}

export function breaches(operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq', value: string, threshold: string): boolean | null {
  const v = split(value);
  const t = split(threshold);
  if (v === null || t === null) return null;
  const order = compareDecimal(v, t);
  switch (operator) {
    case 'gt':
      return order > 0;
    case 'gte':
      return order >= 0;
    case 'lt':
      return order < 0;
    case 'lte':
      return order <= 0;
    case 'eq':
      return order === 0;
  }
}

/**
 * Reads a signal from the analytics surface svc-ops already serves. No warehouse, a stale lag or an unknown lag is an error reading
 * with the typed code; a wired but empty warehouse is "no data". Nothing is invented.
 */
export function warehouseSignalReader(ops: Pick<OpsService, 'revenue'>): SignalReader {
  return {
    async read(signal) {
      try {
        const surface = await ops.revenue();
        const points = surface.points.filter((p) => p.metricId === signal);
        if (surface.empty || points.length === 0) return { status: 'no_data' };
        // One reading per metric. Several points (one per dimension) would mix units if added, and a rule cannot name a dimension yet.
        if (points.length > 1) return { status: 'error', code: 'ops.alert_signal_ambiguous' };
        const value = points[0]?.value;
        if (value === undefined || !isDecimal(value)) return { status: 'error', code: 'ops.alert_signal_value_invalid' };
        return { status: 'ok', value };
      } catch (err) {
        if (err instanceof OpsError) return { status: 'error', code: err.code };
        return { status: 'error', code: 'ops.alert_signal_unreadable' };
      }
    },
  };
}
