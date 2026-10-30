import { createHash } from 'node:crypto';

/**
 * The approval a lead needs is bound to a hash of exactly what is approved: the application, the name it lists under
 * and the criteria the founders measured it by. svc-trade recomputes it when the second founder confirms
 * (services/svc-trade/src/copy/lead-applications.ts, `leadApprovalPayload`) and refuses an approval bound to anything
 * else, so this is byte for byte the same canonical form: keys sorted, no spaces, numbers as JSON writes them.
 */
export const COPY_LEAD_ACTION_TYPE = 'trade.copy_lead_approve';
export const COPY_LEAD_TARGET_SERVICE = 'svc-trade';
export const COPY_LEAD_POLICY_VERSION = 'trade-copy-lead-v1';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  throw new Error('payload is not JSON');
}

export function copyLeadPayloadHash(input: { applicationId: string; displayName: string; minTrackRecordDays: number }): string {
  const payload = {
    actionType: COPY_LEAD_ACTION_TYPE,
    applicationId: input.applicationId,
    displayName: input.displayName,
    minTrackRecordDays: input.minTrackRecordDays,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}
