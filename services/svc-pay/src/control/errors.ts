import { PayGuardRefusal } from '../seams/guards.js';

/**
 * W1 ERRORS.
 *
 * Two shapes, one vocabulary:
 *  - `ControlRefusal` is thrown from a GUARD (seams/guards.ts). It IS a
 *    `PayGuardRefusal`, so `composeGuards` keeps it as is and the router maps it
 *    to FORBIDDEN / SERVICE_UNAVAILABLE. Its `code` is the control-room code
 *    (`pay.caps_unconfigured`), not a `pay.guard_*` one, so a client can branch
 *    on what actually happened.
 *  - `ControlError` is thrown by the services behind the procedures; the
 *    namespaces map it to a tRPC code.
 */

/** Codes a guard refuses with. Every "unconfigured" one means: an owner has not set the number, so nothing moves. */
export const CONTROL_REFUSAL_CODES = [
  'pay.tier_unassigned',
  'pay.caps_unconfigured',
  'pay.pricing_unconfigured',
  'pay.approval_threshold_unconfigured',
  'pay.cap_per_payment_exceeded',
  'pay.cap_daily_intake_exceeded',
  'pay.cap_monthly_intake_exceeded',
  'pay.cap_daily_payout_exceeded',
  'pay.cap_beneficiaries_exceeded',
  'pay.approval_required',
  'pay.control_unreadable',
] as const;
export type ControlRefusalCode = (typeof CONTROL_REFUSAL_CODES)[number];

export class ControlRefusal extends PayGuardRefusal {
  readonly detail?: Record<string, string>;
  constructor(code: ControlRefusalCode, kind: 'refused' | 'unavailable' = 'refused', detail?: Record<string, string>) {
    super(`pay.guard_${code.slice('pay.'.length)}` as `pay.guard_${string}`, kind);
    // The control-room code is what reaches the client (`error.data.cause.code`).
    Object.defineProperty(this, 'code', { value: code, enumerable: true });
    this.message = code;
    this.name = 'ControlRefusal';
    if (detail) this.detail = detail;
  }
}

export const CONTROL_ERROR_CODES = [
  'pay.merchant_not_found',
  'pay.merchant_inactive',
  'pay.interactive_required',
  'pay.limit_request_not_found',
  'pay.limit_request_not_pending',
  'pay.tier_unassigned',
  'pay.tier_not_found',
  'pay.approval_not_found',
  'pay.approval_forbidden',
  'pay.approval_self_approval',
  'pay.approval_not_pending',
  'pay.approval_not_required',
  'pay.approval_expired',
  'pay.approval_payload_mismatch',
  'pay.approval_mfa_required',
  'pay.approval_state_invalid',
  'pay.approval_threshold_unconfigured',
  'pay.approval_ttl_unconfigured',
  'pay.settlement_not_payable',
  'pay.payout_clearing_pending',
  'pay.payout_destination_missing',
  'pay.change_not_found',
  'pay.change_not_pending',
  'pay.change_hash_mismatch',
  'pay.request_id_reused',
  'pay.dual_control_required',
  'pay.control_invalid',
  'pay.pricing_unconfigured',
  'pay.reserve_ledger_unwired',
  'pay.caps_unconfigured',
  'pay.payout_daily_limit_exceeded',
] as const;
export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

export type ControlErrorClass = 'not_found' | 'forbidden' | 'precondition' | 'conflict' | 'bad_request' | 'unwired';

const CLASS_OF: Record<ControlErrorCode, ControlErrorClass> = {
  'pay.merchant_not_found': 'not_found',
  'pay.merchant_inactive': 'precondition',
  'pay.interactive_required': 'forbidden',
  'pay.limit_request_not_found': 'not_found',
  'pay.limit_request_not_pending': 'conflict',
  'pay.tier_not_found': 'not_found',
  'pay.approval_not_found': 'not_found',
  'pay.change_not_found': 'not_found',
  'pay.approval_forbidden': 'forbidden',
  'pay.approval_self_approval': 'forbidden',
  'pay.approval_mfa_required': 'forbidden',
  'pay.dual_control_required': 'precondition',
  'pay.approval_not_pending': 'conflict',
  'pay.approval_expired': 'conflict',
  'pay.approval_payload_mismatch': 'conflict',
  'pay.approval_state_invalid': 'conflict',
  'pay.change_not_pending': 'conflict',
  'pay.change_hash_mismatch': 'conflict',
  'pay.request_id_reused': 'conflict',
  'pay.approval_not_required': 'precondition',
  'pay.approval_threshold_unconfigured': 'precondition',
  'pay.approval_ttl_unconfigured': 'precondition',
  'pay.settlement_not_payable': 'precondition',
  'pay.payout_clearing_pending': 'precondition',
  'pay.payout_destination_missing': 'precondition',
  'pay.pricing_unconfigured': 'precondition',
  'pay.tier_unassigned': 'precondition',
  'pay.control_invalid': 'bad_request',
  'pay.reserve_ledger_unwired': 'unwired',
  'pay.caps_unconfigured': 'precondition',
  'pay.payout_daily_limit_exceeded': 'precondition',
};

export class ControlError extends Error {
  readonly errorClass: ControlErrorClass;
  /** Exact decimal still approvable today. Set on `pay.payout_daily_limit_exceeded`. */
  readonly remaining?: string;
  constructor(
    readonly code: ControlErrorCode,
    message?: string,
    remaining?: string,
  ) {
    super(message ?? code);
    this.name = 'ControlError';
    this.errorClass = CLASS_OF[code];
    if (remaining !== undefined) this.remaining = remaining;
  }
}
