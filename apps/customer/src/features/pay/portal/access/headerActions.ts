import type { BusinessPayApi } from '../../pay-api';
import { chromeCopy } from '../chrome/copy';
import type { PortalRoom } from '../routes';
import type { Need } from './capabilities';
import { isMoneyScope, moneyKindOf, moneyReasonFor, ownerOnlyReason } from './money-step';
import type { MerchantAccessValue } from './MerchantAccess';

/**
 * What a page's header action needs before it can work. `scope` is checked with `pay.access(scope)`, the same call the
 * buttons on the page use; `need` is a team permission the owner's scopes do not cover. An action not listed here is
 * a link to another page (or a back link) and needs nothing.
 */
type Gate = { scope: string; asks?: true } | { need: Need };
const GATES: Partial<Record<PortalRoom, Gate>> = {
  refunds: { scope: 'pay:refund' },
  payouts: { scope: 'pay:payout', asks: true },
  money: { scope: 'pay:payout', asks: true },
  settlements: { scope: 'pay:payout', asks: true },
  'payout-destinations': { scope: 'pay:payout' },
  payments: { scope: 'pay:write' },
  payment: { scope: 'pay:write' },
  links: { scope: 'pay:write' },
  link: { scope: 'pay:write' },
  dashboard: { scope: 'pay:write' },
  team: { need: 'team.manage' },
  'report-exports': { need: 'exports.create' },
};

/**
 * Why this page's header action is off for the signed-in person, in words, or null when they may use it. Anything
 * that cannot be proved fails closed: a missing `pay` or an access still loading switches the action off.
 */
export function headerActionReason(
  room: PortalRoom,
  access: Pick<MerchantAccessValue, 'access' | 'can'>,
  pay: Pick<BusinessPayApi, 'access' | 'authority'> | null,
): string | null {
  const gate = GATES[room];
  if (!gate) return null;
  if (access.access.status !== 'ready') return chromeCopy.t('headerActionWaiting');
  if ('need' in gate) return access.can(gate.need) ? null : chromeCopy.t('headerActionNoRole');
  const refusal = pay?.access(gate.scope) ?? null;
  if (pay && !refusal) return null;
  // Refund and payout say the same thing everywhere: who can (`money-step.ts`).
  if (isMoneyScope(gate.scope)) {
    const kind = moneyKindOf(gate.scope);
    // The payout pages' header action goes to the page that asks for a payout, which admins and finance may use too.
    const act = kind === 'payout' && gate.asks ? 'request' : 'send';
    const reason = moneyReasonFor(kind, access.access, act);
    // For those roles the older owner-only authority is not what decides: the role's permission is.
    if (act === 'request' && reason === null) return null;
    return reason ?? ownerOnlyReason(kind);
  }
  return refusal ? refusal.message : chromeCopy.t('headerActionNoRole');
}
