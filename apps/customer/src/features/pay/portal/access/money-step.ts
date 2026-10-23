import { chromeCopy } from '../chrome/copy';
import type { Access } from './resolve';

/**
 * Money leaving the account (a refund, a payout sent) needs a short "Confirm it's you" step: a passkey or the
 * six-digit authenticator code. The confirmation mints a token that carries `pay:refund` or `pay:payout` for at most
 * ten minutes (`step-up.ts`). This file is the one place that decides whether a control is drawn on or off:
 *
 *  - on, when this person's role may do it. Opening the action asks them to confirm, then shows the usual review;
 *  - off, with a sentence that says who can, when it cannot be theirs.
 *
 * Whether the service accepts the money call is still decided by the service. Nothing here proves anything.
 */
export type MoneyKind = 'refund' | 'payout';
export const MONEY_SCOPE: Record<MoneyKind, 'pay:refund' | 'pay:payout'> = { refund: 'pay:refund', payout: 'pay:payout' };

export const isMoneyScope = (scope: string): scope is 'pay:refund' | 'pay:payout' => scope === 'pay:refund' || scope === 'pay:payout';
export const moneyKindOf = (scope: 'pay:refund' | 'pay:payout'): MoneyKind => (scope === 'pay:refund' ? 'refund' : 'payout');

/**
 * Which payout action is being opened. All of them carry `pay:payout`, but the service admits different people:
 * sending is the owner's alone; asking for approval, taking a request back and converting follow the role's permission
 * (`payout.request` or `payout.approve`, `payout.approve`), which admins and finance hold.
 */
export type PayoutAct = 'send' | 'request' | 'cancel' | 'convert';

/** Who can, in words. Refund and payout are the account owner's: the service admits no one else to either. */
export const ownerOnlyReason = (kind: MoneyKind): string => chromeCopy.t(kind === 'refund' ? 'moneyStepRefund' : 'moneyStepPayout');

/**
 * Why this money control is off for a person whose scopes are `scopes` (the older, scope-only check). The scopes a
 * session carries never include refund or payout, because the confirmation token is held apart from the session, so
 * the control is on only when the business access says so (`moneyReasonFor`). A page that has only scopes to go on
 * (the older tools) treats a missing scope as "not this person's to do" and says who can.
 */
export function moneyReason(kind: MoneyKind, scopes: ReadonlySet<string> | readonly string[] | null | undefined): string | null {
  const held = scopes
    ? Array.isArray(scopes)
      ? scopes.includes(MONEY_SCOPE[kind])
      : (scopes as ReadonlySet<string>).has(MONEY_SCOPE[kind])
    : false;
  return held ? null : ownerOnlyReason(kind);
}

/**
 * Why a refund or a payout cannot be started by the person `access` describes, or null when they may begin (the
 * confirmation comes when they open the action). Anything not yet known is off: nothing guesses that money may move.
 */
export function moneyReasonFor(kind: MoneyKind, access: Access, act: PayoutAct = 'send'): string | null {
  if (access.status !== 'ready') return chromeCopy.t('headerActionWaiting');
  if (kind === 'payout' && act !== 'send') {
    // Ask, take back, convert: the owner, or a role whose permission covers it.
    const held = access.capabilities;
    const mayAct =
      access.role === 'owner' ||
      (act === 'convert' ? held.has('payout.approve') : held.has('payout.request') || held.has('payout.approve'));
    if (!mayAct) return chromeCopy.t(act === 'convert' ? 'moneyStepConvert' : 'moneyStepRequest');
  } else if (access.role !== 'owner') return ownerOnlyReason(kind);
  if (access.accountStatus !== 'active') return chromeCopy.t('moneyStepInactive');
  if (access.sessionInteractive === false) return chromeCopy.t('moneyStepKeys');
  return null;
}
