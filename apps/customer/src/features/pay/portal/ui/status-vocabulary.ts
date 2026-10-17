import type { PlainKey } from '../copy';

/** The statuses the older pages already used, with their plain words (keys in the shared copy). */
export type Tone = 'good' | 'attention' | 'bad' | 'neutral';
export const chips = {
  dispute: {
    open: ['chipDispute_open', 'tipDispute_open', 'attention'],
    contested: ['chipDispute_contested', 'tipDispute_contested', 'neutral'],
    accepted: ['chipDispute_accepted', 'tipDispute_accepted', 'neutral'],
    won: ['chipDispute_won', 'tipDispute_won', 'good'],
    lost: ['chipDispute_lost', 'tipDispute_lost', 'bad'],
  },
  kyb: {
    none: ['chipKyb_none', 'tipKyb_none', 'neutral'],
    pending: ['chipKyb_pending', 'tipKyb_pending', 'attention'],
    approved: ['chipKyb_approved', 'tipKyb_approved', 'good'],
    rejected: ['chipKyb_rejected', 'tipKyb_rejected', 'bad'],
  },
  export: {
    queued: ['chipExport_queued', 'tipExport_queued', 'neutral'],
    running: ['chipExport_running', 'tipExport_running', 'neutral'],
    ready: ['chipExport_ready', 'tipExport_ready', 'good'],
    failed: ['chipExport_failed', 'tipExport_failed', 'bad'],
    expired: ['chipExport_expired', 'tipExport_expired', 'neutral'],
  },
  member: {
    active: ['chipMember_active', 'tipMember_active', 'good'],
    invited: ['chipMember_invited', 'tipMember_invited', 'attention'],
    removed: ['chipMember_removed', 'tipMember_removed', 'neutral'],
  },
  payment: {
    created: ['chipPayment_created', 'tipPayment_created', 'neutral'],
    authorized: ['chipPayment_authorized', 'tipPayment_authorized', 'neutral'],
    captured: ['chipPayment_captured', 'tipPayment_captured', 'good'],
    settled: ['chipPayment_settled', 'tipPayment_settled', 'good'],
    refunded: ['chipPayment_refunded', 'tipPayment_refunded', 'neutral'],
    disputed: ['chipPayment_disputed', 'tipPayment_disputed', 'attention'],
    failed: ['chipPayment_failed', 'tipPayment_failed', 'bad'],
  },
  merchant: {
    pending: ['chipMerchant_pending', 'tipMerchant_pending', 'attention'],
    active: ['chipMerchant_active', 'tipMerchant_active', 'good'],
    suspended: ['chipMerchant_suspended', 'tipMerchant_suspended', 'bad'],
    closed: ['chipMerchant_closed', 'tipMerchant_closed', 'neutral'],
  },
  settlement: {
    pending: ['chipSettlement_pending', 'tipSettlement_pending', 'neutral'],
    posted: ['chipSettlement_posted', 'tipSettlement_posted', 'attention'],
    paid_out: ['chipSettlement_paid_out', 'tipSettlement_paid_out', 'good'],
    failed: ['chipSettlement_failed', 'tipSettlement_failed', 'bad'],
  },
  payout: {
    not_ready: ['chipPayout_not_ready', 'tipPayout_not_ready', 'neutral'],
    unknown: ['chipPayout_unknown', 'tipPayout_unknown', 'attention'],
    ready: ['chipPayout_ready', 'tipPayout_ready', 'attention'],
    awaiting_approval: ['chipPayout_awaiting_approval', 'tipPayout_awaiting_approval', 'attention'],
    approved: ['chipPayout_approved', 'tipPayout_approved', 'good'],
    rejected: ['chipPayout_rejected', 'tipPayout_rejected', 'bad'],
    paid_out: ['chipPayout_paid_out', 'tipPayout_paid_out', 'good'],
    failed: ['chipPayout_failed', 'tipPayout_failed', 'bad'],
  },
  approval: {
    pending: ['chipApproval_pending', 'tipApproval_pending', 'attention'],
    approved: ['chipApproval_approved', 'tipApproval_approved', 'good'],
    rejected: ['chipApproval_rejected', 'tipApproval_rejected', 'bad'],
    voided: ['chipApproval_voided', 'tipApproval_voided', 'bad'],
    expired: ['chipApproval_expired', 'tipApproval_expired', 'neutral'],
    consumed: ['chipApproval_consumed', 'tipApproval_consumed', 'good'],
  },
} as const satisfies Record<string, Record<string, readonly [PlainKey, PlainKey, Tone]>>;
export type ChipKind = keyof typeof chips;
