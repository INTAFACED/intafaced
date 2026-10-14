/**
 * Who may propose or approve an action type.
 *
 * `operator`: four-eyes maker/checker over an operator action (matching.open, edge.kill,
 * ledger.freeze, bank.fund_pool, token.*, pay.*, market.vendor.vet, academy.*, identity.*...).
 * Only an operator principal may propose, approve or reject one. Before this, any two
 * self-registered users with a TOTP could propose and approve `matching.open` (issue #4724).
 *
 * `self`: a money-out step-up for the user's OWN intent (`SAME_PERSON_ACTION_TYPES`). Created
 * on its own door with a fresh factor and open to every signed-in user; never a four-eyes type.
 *
 * FAIL CLOSED: the only types listed as `self` are the same-person ones. Every other string,
 * known or not, is `operator`, so a new operator type is protected the day it is invented and an
 * unknown type is never open to ordinary users.
 */
import { isSamePersonActionType } from '@intafaced/contracts';
import { factorActor } from './factor-gate.js';

export type ActionAudience = 'operator' | 'self';

export function audienceOf(actionType: string): ActionAudience {
  return isSamePersonActionType(actionType) ? 'self' : 'operator';
}

/** Module-local operator scopes that are not `admin:*` but do operate (vendor vetting, support). */
const MODULE_OPERATOR_SCOPES: readonly string[] = ['market:ops', 'support:ops'];

/**
 * The existing operator notion, reused rather than re-invented: a founder (`privilegedUserIds`) or any
 * principal holding an `admin:*` scope is privileged (`factorActor`); `market:ops` / `support:ops` are
 * the module operator scopes. An API key or sub-account (delegated) is never an operator here.
 */
export function isOperatorPrincipal(
  principal: {
    readonly userId: string;
    readonly mfa: boolean;
    readonly scopes: readonly string[];
    readonly kid?: string | undefined;
    readonly sub_account?: string | undefined;
  },
  privilegedUserIds: readonly string[] = [],
): boolean {
  const actor = factorActor(principal, privilegedUserIds);
  if (actor.delegated) return false;
  return actor.privileged || principal.scopes.some((s) => MODULE_OPERATOR_SCOPES.includes(s));
}
