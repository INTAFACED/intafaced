import type { ApiResult, RefusalReason } from '../../../shared/api';
import { portalCopy, type PlainKey } from './copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * Plain-English refusals (B8): what was refused, why, what to do next. The service answers with a stable code;
 * that code never reaches the screen. An id that belongs to someone else and an id that does not exist use the
 * same words, because the service gives the same answer for both (M1).
 */
const byCode: Record<string, PlainKey> = {
  'pay.merchant_ops_unavailable': 'rUnavailable',
  'pay.merchant_ops_not_merchant': 'rNotMerchant',
  'pay.merchant_not_found': 'rMerchantNotFound',
  'pay.team_role_forbidden': 'rRoleForbidden',
  'pay.team_interactive_only': 'rNeedsVerifiedSession',
  'pay.team_member_unavailable': 'rMemberUnavailable',
  'pay.team_self_change_forbidden': 'rSelfChange',
  'pay.team_member_not_found': 'rMemberNotFound',
  'pay.team_owner_cannot_leave': 'rOwnerCannotLeave',
  'pay.team_invitation_not_found': 'rInvitationNotFound',
  'pay.dispute_not_found': 'rDisputeNotFound',
  'pay.dispute_closed': 'rDisputeClosed',
  'pay.dispute_invalid_transition': 'rDisputeTransition',
  'pay.dispute_evidence_required': 'rEvidenceRequired',
  'pay.request_id_reused': 'rRequestReused',
  'pay.customer_not_found': 'rCustomerNotFound',
  'pay.export_filter_invalid': 'rExportFilter',
  'pay.export_not_found': 'rExportNotFound',
  'pay.export_not_ready': 'rExportNotReady',
  'pay.export_expired': 'rExportExpired',
  'pay.notification_not_found': 'rNotificationNotFound',
  'pay.notification_threshold_unsupported': 'rThresholdUnsupported',
  'pay.cursor_invalid': 'rCursorInvalid',
  'pay.metrics_window_invalid': 'rMetricsWindow',
  'pay.metrics_window_unaligned': 'rMetricsWindow',
  'pay.metrics_window_too_wide': 'rMetricsWindow',
  'pay.metrics_balance_unavailable': 'rBalanceUnavailable',
  'pay.invalid_destination_ref': 'rDestinationRef',
  'pay.destination_kind_mismatch': 'rDestinationKind',
  'pay.submerchant_permission_denied': 'rForbidden',
};
const byReason: Record<RefusalReason, PlainKey> = {
  unauthorized: 'rSignIn',
  forbidden: 'rForbidden',
  not_mounted: 'rNotConnected',
  not_supported: 'rNotAvailable',
  unreachable: 'rUnreachable',
  invalid_response: 'rUnverified',
  aborted: 'rStopped',
  error: 'rGeneric',
  uncertain: 'rUncertain',
};
const titles: Record<RefusalReason, PlainKey> = {
  unauthorized: 'tSignIn',
  forbidden: 'tNotAllowed',
  not_mounted: 'tNotConnected',
  not_supported: 'tNotAvailable',
  unreachable: 'tUnreachable',
  invalid_response: 'tUnverified',
  aborted: 'tStopped',
  error: 'tNotAllowed',
  uncertain: 'tUncertain',
};

const codeOf = (result: Failed) => {
  const raw = result.code ?? '';
  if (raw.startsWith('pay.')) return raw;
  // The service puts the code in the message too; some gateways drop `cause.code`.
  const m = /^(pay\.[a-z0-9_]+)/.exec(result.message);
  return m?.[1] ?? raw;
};

/** The procedure exists on the wire but nothing sits behind it yet, or the gateway has not mounted it. */
export function isComingSoon(result: Failed): boolean {
  const code = codeOf(result);
  if (code === 'pay.not_built') return true;
  return result.reason === 'not_mounted' && !code.startsWith('pay.');
}

export function refusalText(result: Failed): string {
  if (result.code === 'portal.local') return result.message;
  const key = byCode[codeOf(result)];
  if (key) return portalCopy.t(key);
  // Our own authored gateway messages (offline, timeouts) are already plain English.
  if (result.messageCopy) return result.message;
  return portalCopy.t(byReason[result.reason]);
}
export function refusalTitle(result: Failed): string {
  return portalCopy.t(titles[result.reason]);
}

/** A refusal this screen writes itself (sign-in missing, form invalid), shaped like a service refusal. */
export function portalRefusal(key: PlainKey, reason: RefusalReason = 'error'): Failed {
  return { ok: false, reason, message: portalCopy.t(key), code: 'portal.local' };
}
