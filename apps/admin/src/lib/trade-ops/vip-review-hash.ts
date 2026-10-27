import { createHash } from 'node:crypto';
import type { VipDecision, VipTrialRules } from './vip-review';

/**
 * The approvals a VIP decision needs are bound to a hash of exactly what will be decided. svc-trade recomputes it when
 * the decision is applied (services/svc-trade/src/admin/vip-review.ts) and refuses an approval bound to anything else,
 * so this is byte for byte the same canonical form: keys sorted, no spaces, numbers as JSON writes them.
 */
export const VIP_REVIEW_ACTION_TYPE = 'trade.vip_application_review';
export const VIP_TRIAL_GRANT_ACTION_TYPE = 'trade.vip_trial_grant';
export const VIP_TARGET_SERVICE = 'svc-trade';
export const VIP_POLICY_VERSION = 'trade-vip-review-v1';

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

const hash = (payload: unknown) => `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;

/** A review: the decision, its reason and the trial an approval would grant (none for a rejection). */
export function vipReviewPayloadHash(input: {
  applicationId: string;
  decision: VipDecision;
  reason: string;
  trial: VipTrialRules | null;
}): string {
  return hash({
    actionType: VIP_REVIEW_ACTION_TYPE,
    applicationId: input.applicationId,
    decision: input.decision,
    reason: input.reason,
    trial: input.decision === 'approve' ? input.trial : null,
  });
}

/** A trial grant for an application approved while none was published. */
export function vipTrialGrantPayloadHash(input: { applicationId: string; reason: string; trial: VipTrialRules }): string {
  return hash({ actionType: VIP_TRIAL_GRANT_ACTION_TYPE, applicationId: input.applicationId, reason: input.reason, trial: input.trial });
}
