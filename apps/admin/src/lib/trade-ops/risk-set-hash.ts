import { createHash } from 'node:crypto';
import type { RiskSetBody } from './risk-limits-model';

/**
 * The approval a limit change needs is bound to a hash of exactly what will be written. svc-trade recomputes it from
 * the request when the change is applied (`admin.risk.set`) and refuses an approval bound to anything else, so this
 * has to be byte for byte the same canonical form: keys sorted, no spaces, null for an unset limit.
 */
export const RISK_SET_ACTION_TYPE = 'trade.risk_set';
export const RISK_SET_TARGET_SERVICE = 'svc-trade';
export const RISK_SET_POLICY_VERSION = 'trade-risk-set-v1';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function riskSetPayloadHash(body: RiskSetBody): string {
  const payload = {
    actionType: RISK_SET_ACTION_TYPE,
    market: body.market,
    limits: body.limits,
    expectedVersion: body.expectedVersion,
    reason: body.reason,
  };
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}
