import { chromeCopy } from '../chrome/copy';

/**
 * Money leaving the account (a refund, a payout sent) needs a scope that identity puts on a session only after a
 * confirmed sign-in step. Today no session carries it, so every such control is drawn off, with this reason beside it.
 *
 * This file is the one place that decides. When the coming step-up (`auth.stepUpPay`) exists, change `moneyReason` to
 * return a "Confirm it's you" action instead of a sentence; no page needs to change.
 */
export type MoneyKind = 'refund' | 'payout';
export const MONEY_SCOPE: Record<MoneyKind, 'pay:refund' | 'pay:payout'> = { refund: 'pay:refund', payout: 'pay:payout' };

export const isMoneyScope = (scope: string): scope is 'pay:refund' | 'pay:payout' => scope === 'pay:refund' || scope === 'pay:payout';
export const moneyKindOf = (scope: 'pay:refund' | 'pay:payout'): MoneyKind => (scope === 'pay:refund' ? 'refund' : 'payout');

/** Why this money control is off for the session that holds `scopes`, in words, or null when the session may use it. */
export function moneyReason(kind: MoneyKind, scopes: ReadonlySet<string> | readonly string[] | null | undefined): string | null {
  const held = scopes
    ? Array.isArray(scopes)
      ? scopes.includes(MONEY_SCOPE[kind])
      : (scopes as ReadonlySet<string>).has(MONEY_SCOPE[kind])
    : false;
  if (held) return null;
  return chromeCopy.t(kind === 'refund' ? 'moneyStepRefund' : 'moneyStepPayout');
}
