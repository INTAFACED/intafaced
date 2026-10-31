import type { ApiResult } from '../../../../shared/api';
import { knownRefusalCodes, registerNotLive, registerRefusals } from '../refusal';
import { reason } from '../chrome/copy';
import { mc } from './copy';

/**
 * Plain words for the service codes only the money pages meet. A code that already has words (here or in another
 * package) is skipped, so two packages can never make this module load fail.
 */
const words: Record<string, Parameters<typeof mc.t>[0]> = {
  'pay.settlement_not_payable': 'rSettlementNotPayable',
  'pay.settlement_in_flight': 'rSettlementInFlight',
  'pay.payout_clearing_pending': 'rClearingPending',
  'pay.kyb_required': 'rKybRequired',
  'pay.payout_destination_missing': 'rDestinationMissing',
  'pay.payout_destination_unverified': 'rDestUnverified',
  'pay.payout_destination_held': 'rDestHeld',
  'pay.payout_destination_not_held': 'rDestNotHeld',
  'pay.destination_verify_mismatch': 'rDestVerifyMismatch',
  'pay.payout_destination_verified_locked': 'rDestVerifiedLocked',
  'pay.approval_threshold_unconfigured': 'rThresholdUnset',
  'pay.cap_daily_payout_exceeded': 'rOverDailyPayout',
  'pay.caps_unconfigured': 'rCapsUnset',
  'pay.guard_halted': 'rHalted',
  'pay.guard_test_refused': 'rTestRefused',
  'pay.guard_screening_unavailable': 'rScreeningUnavailable',
  'pay.guard_screening_review': 'rScreeningReview',
  'pay.guard_screening_refuse': 'rScreeningRefuse',
  'pay.rail_failed': 'rRailRefused',
  'pay.rail_declined': 'rRailRefused',
  'pay.rail_not_live': 'rRailNotLive',
  'pay.rail_outcome_unknown': 'rRailUnknown',
  'pay.payout_admission_missing': 'rPayoutAdmission',
  'pay.payout_recovery_conflict': 'rPayoutRecovery',
  'pay.refund_exceeds_captured': 'rRefundTooMuch',
  'pay.refund_in_flight': 'rRefundInFlight',
  'pay.refund_id_conflict': 'rRefundConflict',
  'pay.refund_id_spent': 'rRefundSpent',
  'pay.nothing_captured': 'rNothingCaptured',
  'pay.limit_request_not_pending': 'rLimitNotPending',
  'pay.limit_request_not_found': 'rLimitNotFound',
  'pay.conversion_quote_expired': 'rQuoteExpired',
  'pay.conversion_quote_consumed': 'rQuoteConsumed',
  'pay.conversion_exceeds_settlement': 'rConvTooMuch',
  'pay.conversion_pair_unsupported': 'rConvPair',
  'pay.conversion_settlement_asset': 'rConvAsset',
  'pay.conversion_amount_invalid': 'rConvAmount',
  'pay.conversion_forbidden': 'rConvForbidden',
  'pay.conversion_not_found': 'rConvNotFound',
  'pay.statement_busy': 'rStatementBusy',
  'pay.payout_destination_in_flight': 'rDestInFlight',
  'pay.payout_destination_not_found': 'rDestNotFound',
};
const known = new Set(knownRefusalCodes());
registerRefusals(
  Object.fromEntries(
    Object.entries(words)
      .filter(([code]) => !known.has(code))
      .map(([code, key]) => [code, () => mc.t(key as never)]),
  ),
);

/** The codes that mean conversion is switched off for this account (the service starts with it off). */
export const CONVERSION_OFF = [
  'pay.conversion_venue_unconfigured',
  'pay.conversion_unavailable',
  'pay.conversion_slippage_unconfigured',
] as const;
registerNotLive(Object.fromEntries(CONVERSION_OFF.map((code) => [code, () => reason('reasonService')])));

export function isConversionOff(result: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  const code = result.code?.startsWith('pay.') ? result.code : (/^(pay\.[a-z0-9_]+)/.exec(result.message)?.[1] ?? result.code ?? '');
  return (
    (CONVERSION_OFF as readonly string[]).includes(code) ||
    code === 'pay.not_built' ||
    (result.reason === 'not_mounted' && !code.startsWith('pay.'))
  );
}

/** No top-up rail is wired for this business (svc-pay merchant-pay-dev-out/top-up.ts): a not-live card naming that. */
export const TOP_UP_OFF = 'pay.topup_unconfigured';
registerNotLive({ [TOP_UP_OFF]: () => mc.t('rTopUpUnconfigured') });
