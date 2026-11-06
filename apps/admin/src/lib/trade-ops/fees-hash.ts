import { createHash } from 'node:crypto';

/**
 * The approval a fee schedule version needs is bound to a hash of exactly what will be written. svc-trade recomputes it
 * when the version is written (`admin.fees.set`, services/svc-trade/src/admin/service.ts) and refuses an approval bound to
 * anything else, so this is byte for byte its canonical form: keys sorted, no spaces, numbers as JSON numbers.
 */
export const FEE_SCHEDULE_SET_ACTION_TYPE = 'trade.fee_schedule_set';
export const FEE_SCHEDULE_TARGET_SERVICE = 'svc-trade';
export const FEE_SCHEDULE_TARGET_ID = 'spot-fee-schedule';
export const FEE_SCHEDULE_POLICY_VERSION = 'trade-fee-schedule-set-v1';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new Error('a fee schedule proposal must be plain JSON');
}

export interface FeeScheduleSetBody {
  readonly schedule: Readonly<Record<string, unknown>>;
  readonly effectiveAt: string;
  readonly expectedVersion: string;
  readonly reason: string;
}

export function feeScheduleSetPayloadHash(body: FeeScheduleSetBody): string {
  const payload = {
    actionType: FEE_SCHEDULE_SET_ACTION_TYPE,
    schedule: body.schedule,
    effectiveAt: body.effectiveAt,
    expectedVersion: body.expectedVersion,
    reason: body.reason,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}
