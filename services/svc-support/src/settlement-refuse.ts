/**
 * M17 support-channel takeover — the desk cannot settle.
 *
 * Support may cite KB articles and file a `money_request` escalation. It must
 * not mark a withdrawal complete, unfreeze an account, or move money. A
 * `resolved` that would imply a payout is the same act wearing a ticket status.
 */
import type { SupportEscalationReason, SupportTicketCategory, SupportTicketStatus } from '@intafaced/contracts';

export const SUPPORT_SETTLE_REFUSE = 'support.settle.refused' as const;

/** Named acts the desk has no authority to perform. */
export const SUPPORT_FORBIDDEN_SETTLEMENT_ACTS = ['complete_withdrawal', 'unfreeze_account', 'move_money'] as const;
export type SupportForbiddenSettlementAct = (typeof SUPPORT_FORBIDDEN_SETTLEMENT_ACTS)[number];

export type SupportSettleRefuseReason = 'forbidden_act' | 'implied_payout';

export type SupportSettlementCheck =
  | { readonly status: 'ok' }
  | { readonly status: 'refuse'; readonly reason: SupportSettleRefuseReason; readonly code: typeof SUPPORT_SETTLE_REFUSE };

/**
 * Claims that the money already moved or the freeze already lifted.
 * One function word may sit between a pair ("moved the money",
 * "withdrawal was completed"). "cannot refund" is not a claim —
 * only past-tense / completed forms.
 */
const CLAIM_BETWEEN = String.raw`(?:[\s_-]+(?:the|a|an|was|were|is|been|has|have|had)[\s_-]+|[\s_-]?)`;
const SETTLEMENT_CLAIM_RE = new RegExp(
  String.raw`\b(?:refunded|paid[\s_-]?out|payout|credited|unfroz(?:e|en)|` +
    String.raw`withdrawal${CLAIM_BETWEEN}complete(?:d)?|completed${CLAIM_BETWEEN}withdrawal|` +
    String.raw`settled|moved${CLAIM_BETWEEN}money)\b`,
  'i',
);

export function isForbiddenSettlementAct(act: string): act is SupportForbiddenSettlementAct {
  return (SUPPORT_FORBIDDEN_SETTLEMENT_ACTS as readonly string[]).includes(act);
}

export function noteImpliesSettlement(note: string | null | undefined): boolean {
  if (!note) return false;
  return SETTLEMENT_CLAIM_RE.test(note);
}

export type SupportSettlementInput = {
  readonly act?: string | null;
  readonly toStatus?: SupportTicketStatus;
  readonly category?: SupportTicketCategory;
  readonly note?: string | null;
  readonly escalationReason?: SupportEscalationReason | null;
};

/**
 * Pure settle check. Callers map the refuse to `support.settle.refused`.
 *
 * `resolved` on `deposit_withdraw`, or after a `money_request` escalation, is
 * a payout claim. `closed` without a settlement note is the desk finishing
 * without paying. Cite-KB is not an act this function sees.
 */
export function checkSupportSettlement(input: SupportSettlementInput): SupportSettlementCheck {
  if (input.act && isForbiddenSettlementAct(input.act)) {
    return { status: 'refuse', reason: 'forbidden_act', code: SUPPORT_SETTLE_REFUSE };
  }

  const finishing = input.toStatus === 'resolved' || input.toStatus === 'closed';
  if (finishing && noteImpliesSettlement(input.note)) {
    return { status: 'refuse', reason: 'implied_payout', code: SUPPORT_SETTLE_REFUSE };
  }

  if (input.toStatus === 'resolved' && input.category === 'deposit_withdraw') {
    return { status: 'refuse', reason: 'implied_payout', code: SUPPORT_SETTLE_REFUSE };
  }

  if (input.toStatus === 'resolved' && input.escalationReason === 'money_request') {
    return { status: 'refuse', reason: 'implied_payout', code: SUPPORT_SETTLE_REFUSE };
  }

  return { status: 'ok' };
}

/** Honesty board — the desk cannot settle. Cite articles; do not pay. */
export function describeSupportSettlement() {
  return {
    canSettle: false as const,
    canCompleteWithdrawal: false as const,
    canUnfreezeAccount: false as const,
    canMoveMoney: false as const,
    canCiteArticles: true as const,
    refuse: SUPPORT_SETTLE_REFUSE,
    forbiddenActs: SUPPORT_FORBIDDEN_SETTLEMENT_ACTS,
  };
}
