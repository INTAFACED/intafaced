/**
 * Who may propose, approve, reject or consume an action type.
 *
 * `founder`: money, venue and treasury actions (`pay.*`, `matching.*`, `ledger.*`, `bank.*`, `token.*`, and a short list of
 * identity types that set fees, limits or pay out), except the protective verbs (halt, reduce-only, post-only, ledger freeze),
 * which stay operator so a brake never waits for both founders. Any target service not on the operator list is founder-only. Only a live founder (the founder pair, with an enabled founder
 * entitlement, an interactive MFA session, no API key or sub-account) may propose, approve or reject one, and identity
 * re-checks that BOTH the proposer and the approver are still live founders when the approval is consumed. A broad
 * `admin:*` scope, `market:ops` or `support:ops` does not make a founder.
 *
 * `operator`: every other four-eyes operator action (kyc.*, market.*, academy.*, p2p.*, account freezes,
 * and the protective brakes other than ledger freeze). Only an operator principal (founder, `admin:*`,
 * `market:ops`, `support:ops`) may propose, approve or reject one.
 *
 * `edge.kill` (kill and re-enable share that type), `ledger.freeze` and `ledger.unfreeze` are founder-level
 * even where a protective-brake list would have left freeze with operators. An `admin:*`, `market:ops` or
 * `support:ops` session is refused at approve. The audience is computed when the approval is decided, so a
 * row that was pending before this rule is judged by the rule, not by the rule that was current when it was proposed.
 *
 * `trade_ops`: `trading.restrict` filed against svc-identity. The caller must hold the trade-ops operator
 * permission (`admin:write`) on an interactive MFA session. `market:ops` and `support:ops` do not qualify.
 * The same type filed against any other service keeps the stricter founder answer.
 * Before this, any two self-registered users with a TOTP could propose and approve `matching.open` (issue #4724).
 *
 * `self`: a money-out step-up for the user's OWN intent (`SAME_PERSON_ACTION_TYPES`). Created
 * on its own door with a fresh factor and open to every signed-in user; never a four-eyes type.
 *
 * FAIL CLOSED: the only types listed as `self` are the same-person ones. Every other string,
 * known or not, is at least `operator`, so a new operator type is protected the day it is invented and an
 * unknown type is never open to ordinary users.
 *
 * The audience is decided from the whole request (type, target service and target id), never from the proposer-chosen
 * type alone. A target service consumes by target id and payload hash, not by the type string, so deciding on the type
 * only would let a founder-only action be filed under a harmless-looking type.
 */
import { isSamePersonActionType, PROTECTIVE_OPERATOR_APPROVALS } from '@intafaced/contracts';
import { factorActor } from './factor-gate.js';

export type ActionAudience = 'founder' | 'operator' | 'self' | 'trade_ops';

/**
 * Founder-level even when a protective list or an operator target service would say otherwise.
 * `edge.kill` covers both kill (`disabled: true`) and re-enable (`disabled: false`); both use target verb `kill`.
 */
export const FOUNDER_LEVEL_ACTION_TYPES: readonly string[] = ['edge.kill', 'ledger.freeze', 'ledger.unfreeze'];

/** Trading restriction filed at identity. The desk's older `account.trading_restriction` name is not this type. */
export const TRADING_RESTRICT_ACTION_TYPE = 'trading.restrict';
export const TRADING_RESTRICT_TARGET_SERVICE = 'svc-identity';
/**
 * Lifting a staff freeze on one account, filed at svc-identity with the account id as target. Operator-level (it moves
 * no money); identity's own restore door still admits only a live founder and spends the row there.
 */
export const IDENTITY_UNFREEZE_ACTION_TYPE = 'identity.account_unfreeze';
/** Staff close and reopen of one account (J-ops-console-04 #7). Operator-level, like the freeze: svc-identity is an operator target. */
export const IDENTITY_CLOSE_ACTION_TYPE = 'identity.account_close';
export const IDENTITY_REOPEN_ACTION_TYPE = 'identity.account_reopen';
/**
 * Staff archive of one closed customer record (J-ops-console-04 #10). Founder-level: it cannot be undone, so the approver
 * is the other founder, never any operator; identity also re-checks at consumption that the approver is a live founder.
 */
export const IDENTITY_ARCHIVE_ACTION_TYPE = 'identity.account_archive';
/**
 * Moving one account onto another product tier (J-ops-console-04 #11). Founder-level: a tier carries fees and limits, so
 * it sits with the fee and limit policy types below; identity also re-checks at consumption that the approver is a live founder.
 */
export const IDENTITY_TIER_MOVE_ACTION_TYPE = 'identity.account_tier_move';
/**
 * A customer limit override above the owner ceiling (J-ops-console-04 #12). Founder-level, as fee and limit policy; identity
 * also re-checks at consumption that the approver is a live founder.
 */
export const IDENTITY_LIMIT_CHANGE_ACTION_TYPE = 'identity.change_limit';
/**
 * Trade-ops operator permission. The trade desk's operator token is `admin:write` plus MFA.
 * There is no separate `trade:ops` scope. `market:ops` and `support:ops` are not this permission.
 */
export const TRADE_OPS_OPERATOR_PERMISSION = 'admin:write';

/** Whole namespaces that move money or change a venue or the book. A new type under one is founder-only the day it exists. */
export const FOUNDER_ACTION_PREFIXES: readonly string[] = ['pay.', 'matching.', 'ledger.', 'bank.', 'token.', 'treasury.'];

/** Individual types outside those namespaces that are treasury or fee/limit policy. */
export const FOUNDER_ACTION_TYPES: readonly string[] = [
  'identity.change_fee_tier',
  IDENTITY_LIMIT_CHANGE_ACTION_TYPE,
  IDENTITY_TIER_MOVE_ACTION_TYPE,
  IDENTITY_ARCHIVE_ACTION_TYPE,
  'affiliates.payout',
  'identity.auth_key_rotate',
  'identity.auth_key_remove_old',
];

/**
 * Target services whose approvals are operator-level (they do not move money, a venue or the book). A request filed
 * against ANY OTHER service, including one that does not exist yet, is founder-only: new money services are protected
 * the day they are invented. Unknown types inside these services stay operator.
 */
export const OPERATOR_TARGET_SERVICES: readonly string[] = ['svc-edge', 'svc-market', 'svc-academy', 'svc-p2p', 'svc-identity'];

/**
 * Protective verbs live in `PROTECTIVE_OPERATOR_APPROVALS` (contracts). A brake must not need both founders online,
 * so those rows are operator-level even though they sit in a founder namespace. The exception holds only when the
 * type, the target service AND the target verb all agree (a `matching.halt` filed against an `open:` target, or
 * against another service, gets the strict answer). Verbs that open or re-enable things (`resume`, `open`,
 * `unfreeze`, ...) are deliberately absent from that list.
 */

const norm = (v: string): string => v.trim().toLowerCase();
/** `halt:market-1` -> `halt`; `posting_freeze` -> `posting_freeze`. */
const verbOf = (targetId: string): string => {
  const n = norm(targetId);
  return n.includes(':') ? n.slice(0, n.indexOf(':')) : n;
};

function isFounderName(name: string): boolean {
  const n = norm(name);
  // Target ids of some services carry a verb and a subject (`open:market-1`, `kill:trade`): the verb is the type.
  const head = verbOf(name);
  return [n, head].some((x) => FOUNDER_ACTION_TYPES.includes(x) || FOUNDER_ACTION_PREFIXES.some((p) => x.startsWith(p)));
}

/**
 * True when the type or the target id sits in a founder namespace. A governed policy row never lowers such a request
 * below founders, whatever audience the row names.
 */
export function inFounderNamespace(subject: ApprovalSubject): boolean {
  return isFounderName(subject.actionType) || isFounderName(subject.targetId);
}

/** Audience of a bare action type string. Same rules as `audienceOfApproval` with no target to look at. */
export function audienceOf(actionType: string): ActionAudience {
  if (isSamePersonActionType(actionType)) return 'self';
  const type = norm(actionType);
  if (FOUNDER_LEVEL_ACTION_TYPES.includes(type)) return 'founder';
  if (type === TRADING_RESTRICT_ACTION_TYPE) return 'trade_ops';
  return isFounderName(actionType) ? 'founder' : 'operator';
}

export type ApprovalSubject = {
  readonly actionType: string;
  readonly targetService: string;
  readonly targetId: string;
  /** Absent means `four_eyes`. Only a `same_person` row can be `self`. */
  readonly kind?: 'four_eyes' | 'same_person' | undefined;
};

/**
 * Audience of a whole approval request.
 * - `self` only for a stored `same_person` row (its own door). A four-eyes request carrying a same-person type string
 *   is judged by type and target like any other, so the type cannot be used to skip the check.
 * - `operator` for a protective verb whose type, service and target verb all agree.
 * - `founder` when the type or the target id sits in a founder namespace, or the target service is not on the
 *   operator list. The strictest reading wins.
 * - `operator` otherwise.
 */
export function audienceOfApproval(subject: ApprovalSubject): ActionAudience {
  if (subject.kind === 'same_person') return 'self';
  const type = norm(subject.actionType);
  const service = norm(subject.targetService);
  const verb = verbOf(subject.targetId);
  // Before the protective exception, so ledger.freeze is not left with operators.
  if (FOUNDER_LEVEL_ACTION_TYPES.includes(type)) return 'founder';
  // Only this service. Filed against svc-trade or a money service, the stricter rule below wins.
  if (type === TRADING_RESTRICT_ACTION_TYPE && service === TRADING_RESTRICT_TARGET_SERVICE) return 'trade_ops';
  if (PROTECTIVE_OPERATOR_APPROVALS.some((p) => p.actionType === type && p.targetService === service && p.targetVerb === verb))
    return 'operator';
  if (isFounderName(subject.actionType) || isFounderName(subject.targetId)) return 'founder';
  if (!OPERATOR_TARGET_SERVICES.includes(service)) return 'founder';
  return 'operator';
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

/**
 * Who is a founder RIGHT NOW. Production wires `FounderControls.isLiveFounder`: a member of the configured founder pair,
 * with an enabled founder entitlement and an active account. This is the same founder notion `createFounderAuthority`
 * asks identity about for svc-pay's founder doors; `admin:*` scopes are deliberately not part of it.
 * Unwired or unreachable answers `false`: a founder-only action refuses closed.
 */
export interface FounderDirectory {
  isFounder(userId: string): Promise<boolean>;
}

/** Fixed-list directory (pair membership only, no entitlement lookup). For tests and tools; production uses the live one. */
export function staticFounderDirectory(ids: readonly string[]): FounderDirectory {
  const set = new Set(ids.map((i) => i.toLowerCase()));
  return { isFounder: async (userId) => set.has(userId.toLowerCase()) };
}

/**
 * A founder acts as a signed-in person: MFA satisfied, no API key, no sub-account. This is the principal half of the
 * founder check; membership of the founder pair is the directory's half.
 */
/** Interactive MFA session holding the trade-ops permission. An API key or sub-account is never one. */
export function isTradeOpsOperatorPrincipal(principal: {
  readonly mfa: boolean;
  readonly scopes: readonly string[];
  readonly kid?: string | undefined;
  readonly sub_account?: string | undefined;
}): boolean {
  return principal.mfa === true && !principal.kid && !principal.sub_account && principal.scopes.includes(TRADE_OPS_OPERATOR_PERMISSION);
}

export function isInteractiveFounderPrincipal(principal: {
  readonly mfa: boolean;
  readonly kid?: string | undefined;
  readonly sub_account?: string | undefined;
}): boolean {
  return principal.mfa === true && !principal.kid && !principal.sub_account;
}
