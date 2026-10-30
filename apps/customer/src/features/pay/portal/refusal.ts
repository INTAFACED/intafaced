import type { ApiResult, RefusalReason } from '../../../shared/api';
import { reason } from './chrome/copy';
import { portalCopy, type PlainKey } from './copy';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/**
 * Plain-English refusals (B8): what was refused, why, what to do next. The service answers with a stable code;
 * that code never reaches the screen. An id that belongs to someone else and an id that does not exist use the
 * same words, because the service gives the same answer for both (M1).
 */
const byCode: Record<string, PlainKey> = {
  'pay.subscription_not_found': 'rSubscriptionNotFound',
  'pay.mandate_not_found': 'rSubscriptionNotFound',
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
  'pay.team_business_shut': 'rTeamBusinessShut',
  'pay.team_invite_target_invalid': 'rInviteTarget',
  'pay.team_email_invalid': 'rEmailInvalid',
  'pay.team_user_id_reserved': 'rUserIdReserved',
  'pay.team_email_invite_unconfigured': 'rEmailInviteUnconfigured',
  'pay.team_email_invite_rate_limited': 'rEmailInviteRateLimited',
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
  'pay.merchant_forbidden': 'rForbidden',
  'pay.payment_not_found': 'rPaymentNotFound',
  'pay.settlement_not_found': 'rSettlementNotFound',
  'pay.approval_not_found': 'rApprovalNotFound',
  'pay.approval_forbidden': 'rApprovalForbidden',
  'pay.approval_self_approval': 'rApprovalSelf',
  'pay.approval_not_pending': 'rApprovalNotPending',
  'pay.approval_expired': 'rApprovalExpired',
  'pay.approval_payload_mismatch': 'rApprovalMismatch',
  'pay.approval_mfa_required': 'rApprovalMfa',
  'pay.approval_state_invalid': 'rApprovalState',
  'pay.pricing_unconfigured': 'rPricingUnconfigured',
  'pay.control_invalid': 'rControlInvalid',
  'pay.control_unreadable': 'rControlUnavailable',
  'pay.tier_unassigned': 'rTierUnassigned',
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

/** The service's `pay.*` code for a refusal, from `cause.code` or, when a gateway dropped it, the message. */
export const codeOf = (result: Failed) => {
  const raw = result.code ?? '';
  if (raw.startsWith('pay.')) return raw;
  // The service puts the code in the message too; some gateways drop `cause.code`.
  const m = /^(pay\.[a-z0-9_]+)/.exec(result.message);
  return m?.[1] ?? raw;
};

const registered = new Map<string, () => string>();
const notLive = new Map<string, (() => string) | undefined>();

/**
 * A package gives its own service codes their plain words, in its own copy file, without touching the shared table.
 * Each value is a function so the words follow the reader's language. A code registered twice, or one the shared table
 * already knows, throws when the module loads: the same code must never read two ways.
 */
export function registerRefusals(map: Record<string, () => string>): void {
  for (const [code, words] of Object.entries(map)) {
    if (registered.has(code) || code in byCode) throw new Error(`Refusal code registered twice: ${code}`);
    registered.set(code, words);
  }
}
/**
 * Codes that mean "this feature is switched off", so the page shows the not-live card instead of a refusal (for
 * example sandbox conversion). Each code says what it is waiting for, in the reader's language.
 */
export function registerNotLive(map: Record<string, () => string>): void {
  for (const [code, words] of Object.entries(map)) notLive.set(code, words);
}
/** What a not-live refusal is waiting for: its own words if it has them, else the general reason. */
export function notLiveReason(result: Failed): string {
  return notLive.get(codeOf(result))?.() ?? reason('reasonService');
}
/** For tests: the codes that have words, from the shared table and from packages. */
export function knownRefusalCodes(): string[] {
  return [...Object.keys(byCode), ...registered.keys()];
}

/** The procedure exists on the wire but nothing sits behind it yet, or the gateway has not mounted it. */
export function isNotLive(result: Failed): boolean {
  const code = codeOf(result);
  if (code === 'pay.not_built' || notLive.has(code)) return true;
  return result.reason === 'not_mounted' && !code.startsWith('pay.');
}

export function refusalText(result: Failed): string {
  if (result.code === 'portal.local') return result.message;
  const code = codeOf(result);
  const key = byCode[code];
  if (key) return portalCopy.t(key);
  const own = registered.get(code);
  if (own) return own();
  // Our own authored gateway messages (offline, timeouts) are already plain English.
  if (result.messageCopy) return result.message;
  return portalCopy.t(byReason[result.reason]);
}
/**
 * A failed result whose message still carries a service code ("pay.subscription_already_open") turned into one that says it
 * in words. Messages the page or the API layer already wrote in plain English are left alone.
 */
export function plainFailure<T>(result: ApiResult<T>): ApiResult<T> {
  if (result.ok || !/\bpay\.[a-z0-9_]+/i.test(result.message)) return result;
  return { ...result, message: refusalText({ ...result, messageCopy: undefined }) };
}
export function refusalTitle(result: Failed): string {
  return portalCopy.t(titles[result.reason]);
}

/** A refusal this screen writes itself (sign-in missing, form invalid), shaped like a service refusal. */
export function portalRefusal(key: PlainKey, reason: RefusalReason = 'error'): Failed {
  return { ok: false, reason, message: portalCopy.t(key), code: 'portal.local' };
}
