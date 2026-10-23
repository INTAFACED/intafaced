import { createHash } from 'node:crypto';
import { CHART_DATA_CLASS_ACTION_TYPE, type ChartDataClass, type ChartScalarKey } from './charts-owner-values-model';

/**
 * The approval a data class change needs is bound to a hash of exactly what will be written. svc-trade recomputes it
 * from the request when the change is applied (`admin.chartOwnerValues.set`, key `dataClass`) and refuses an approval
 * bound to anything else. So this is byte for byte the service's form: keys sorted, no spaces, null for a blank value.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export interface ChartDataClassPayload {
  readonly symbol: string;
  readonly dataClass: ChartDataClass | null;
  readonly expectedVersion: string;
  readonly reason: string;
}

export function chartDataClassPayloadHash(body: ChartDataClassPayload): string {
  const payload = {
    actionType: CHART_DATA_CLASS_ACTION_TYPE,
    symbol: body.symbol,
    dataClass: body.dataClass,
    expectedVersion: body.expectedVersion,
    reason: body.reason,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}

/**
 * A business key for one scalar write: the same key, version, value and reason always name the same write, so a
 * double click or a retry returns the stored result instead of writing twice. Never a random id.
 */
export function chartScalarClientRequestId(key: ChartScalarKey, expectedVersion: string, value: number | null, reason: string): string {
  const digest = createHash('sha256').update(canonicalJson({ key, expectedVersion, value, reason })).digest('hex');
  return `chart-owner:${key}:v${expectedVersion}:${digest.slice(0, 24)}`;
}
