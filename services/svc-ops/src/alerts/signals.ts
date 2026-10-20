import { OpsError } from '../codes.js';
import type { OpsService } from '../ops-service.js';

/** What one check of a signal returned. A failed or empty check is never read as "normal". */
export type SignalReading =
  { readonly status: 'ok'; readonly value: string } | { readonly status: 'no_data' } | { readonly status: 'error'; readonly code: string };

export interface SignalReader {
  read(signal: string): Promise<SignalReading>;
}

const SCALE = 18;
const DECIMAL = /^(-?)(\d+)(?:\.(\d{1,18}))?$/;

/** Decimal string to a scaled bigint, so a money metric is never compared as a JS number. Null when it is not a decimal. */
export function toScaled(value: string): bigint | null {
  const m = DECIMAL.exec(value);
  if (!m) return null;
  const whole = BigInt(m[2] ?? '0') * 10n ** BigInt(SCALE);
  const fraction = BigInt((m[3] ?? '').padEnd(SCALE, '0') || '0');
  const scaled = whole + fraction;
  return m[1] === '-' ? -scaled : scaled;
}

export function breaches(operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq', value: string, threshold: string): boolean | null {
  const v = toScaled(value);
  const t = toScaled(threshold);
  if (v === null || t === null) return null;
  switch (operator) {
    case 'gt':
      return v > t;
    case 'gte':
      return v >= t;
    case 'lt':
      return v < t;
    case 'lte':
      return v <= t;
    case 'eq':
      return v === t;
  }
}

const format = (scaled: bigint): string => {
  const sign = scaled < 0n ? '-' : '';
  const abs = scaled < 0n ? -scaled : scaled;
  const whole = abs / 10n ** BigInt(SCALE);
  const fraction = (abs % 10n ** BigInt(SCALE)).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
};

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
        let total = 0n;
        for (const point of points) {
          const scaled = toScaled(point.value);
          if (scaled === null) return { status: 'error', code: 'ops.alert_signal_value_invalid' };
          total += scaled;
        }
        return { status: 'ok', value: format(total) };
      } catch (err) {
        if (err instanceof OpsError) return { status: 'error', code: err.code };
        return { status: 'error', code: 'ops.alert_signal_unreadable' };
      }
    },
  };
}
