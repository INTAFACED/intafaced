/**
 * Fields a two-founder pay approval is bound to.
 *
 * `payActionPayloadHash` is the only hasher. Key order is part of the hash:
 * proposal, console, populate and consume must pass these objects, not a
 * hand-built one. A blank reason and an omitted reason are the same stored
 * outcome, so both hash as ''.
 */
import { payActionPayloadHash } from './action-approval-consume.js';

export const PAY_FRAUD_OPEN_DISPUTE = 'pay.fraud_open_dispute';
export const PAY_FRAUD_RESOLVE_REVIEW = 'pay.fraud_resolve_review';
export const PAY_FRAUD_CONTEST_DISPUTE = 'pay.fraud_contest_dispute';
export const PAY_MERCHANT_PROFILE_REVIEW = 'pay.merchant_profile_review';
export const PAY_DEPOSIT_CREDIT = 'pay.deposit_credit';
export const PAY_PSP_SET_PRICING = 'pay.psp_set_pricing';
export const PAY_PSP_ENABLE_MODE = 'pay.psp_enable_mode';

export function boundText(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

/** Only a strict true changes the payment to disputed. */
export function boundFlag(value: boolean | null | undefined): string {
  return value === true ? 'true' : 'false';
}

export function fraudOpenDisputeFields(input: {
  disputeId: string;
  paymentId: string;
  merchantId: string;
  amount: string;
  assetId: string;
  reasonCode?: string | null;
  markPaymentDisputed?: boolean | null;
}): Record<string, string> {
  return {
    disputeId: input.disputeId,
    paymentId: input.paymentId,
    merchantId: input.merchantId,
    amount: input.amount,
    assetId: input.assetId,
    reasonCode: boundText(input.reasonCode),
    markPaymentDisputed: boundFlag(input.markPaymentDisputed),
  };
}

export function fraudOpenDisputePayloadHash(input: Parameters<typeof fraudOpenDisputeFields>[0]): string {
  return payActionPayloadHash(PAY_FRAUD_OPEN_DISPUTE, fraudOpenDisputeFields(input));
}

export function fraudResolveReviewFields(input: {
  id: string;
  outcome: 'allow' | 'decline';
  note?: string | null;
}): Record<string, string> {
  return {
    id: input.id,
    outcome: input.outcome,
    note: boundText(input.note),
  };
}

export function fraudResolveReviewPayloadHash(input: Parameters<typeof fraudResolveReviewFields>[0]): string {
  return payActionPayloadHash(PAY_FRAUD_RESOLVE_REVIEW, fraudResolveReviewFields(input));
}

export function fraudContestDisputeFields(input: { disputeId: string }): Record<string, string> {
  return { disputeId: input.disputeId };
}

export function merchantProfileReviewFields(input: {
  merchantId: string;
  requestId: string;
  decision: 'approved' | 'rejected';
  expectedChangeHash: string;
  reason: string;
}): Record<string, string> {
  return {
    merchantId: input.merchantId,
    requestId: input.requestId,
    decision: input.decision,
    expectedChangeHash: input.expectedChangeHash,
    reason: boundText(input.reason),
  };
}

export function merchantProfileReviewPayloadHash(input: Parameters<typeof merchantProfileReviewFields>[0]): string {
  return payActionPayloadHash(PAY_MERCHANT_PROFILE_REVIEW, merchantProfileReviewFields(input));
}

export function depositCreditFields(input: {
  userId: string;
  assetId: string;
  amount: string;
  railId: string;
  railRef: string;
}): Record<string, string> {
  return {
    userId: input.userId,
    assetId: input.assetId,
    amount: input.amount,
    railId: input.railId,
    railRef: input.railRef,
  };
}

export function pspSetPricingFields(input: { merchantId: string; feeBps: number; reason: string }): Record<string, string> {
  return {
    merchantId: input.merchantId,
    feeBps: String(input.feeBps),
    reason: input.reason,
  };
}

export function pspEnableModeFields(input: { merchantId: string; reason: string }): Record<string, string> {
  return {
    merchantId: input.merchantId,
    reason: input.reason,
  };
}

/** `after` is the JSON of the normalized registry state. Reason is the event text. */
export function registryChangeFields(input: {
  registry: string;
  key: string;
  expectedVersion: string;
  after: string;
  reason: string;
}): Record<string, string> {
  return {
    registry: input.registry,
    key: input.key,
    expectedVersion: input.expectedVersion,
    after: input.after,
    reason: input.reason,
  };
}

/** The action a second person's approval must be issued for when a compliance officer releases a screened send. */
export const PAY_SCREENING_RELEASE = 'pay.screening_release';

export function screeningReleaseFields(input: { subjectKind: string; caseId: string; reason: string }): Record<string, string> {
  return { subjectKind: input.subjectKind, caseId: input.caseId, reason: input.reason };
}
