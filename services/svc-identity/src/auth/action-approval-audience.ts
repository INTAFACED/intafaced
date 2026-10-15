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
 * `operator`: every other four-eyes operator action (edge.kill, kyc.*, market.*, academy.*, p2p.*, account freezes...).
 * Only an operator principal (founder, `admin:*`, `market:ops`, `support:ops`) may propose, approve or reject one.
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
import { isSamePersonActionType } from '@intafaced/contracts';
import { factorActor } from './factor-gate.js';

export type ActionAudience = 'founder' | 'operator' | 'self';

/** Whole namespaces that move money or change a venue or the book. A new type under one is founder-only the day it exists. */
export const FOUNDER_ACTION_PREFIXES: readonly string[] = ['pay.', 'matching.', 'ledger.', 'bank.', 'token.', 'treasury.'];

/** Individual types outside those namespaces that are treasury or fee/limit policy. */
export const FOUNDER_ACTION_TYPES: readonly string[] = ['identity.change_fee_tier', 'identity.change_limit', 'affiliates.payout'];

/**
 * Target services whose approvals are operator-level (they do not move money, a venue or the book). A request filed
 * against ANY OTHER service, including one that does not exist yet, is founder-only: new money services are protected
 * the day they are invented. Unknown types inside these services stay operator.
 */
export const OPERATOR_TARGET_SERVICES: readonly string[] = ['svc-edge', 'svc-market', 'svc-academy', 'svc-p2p', 'svc-identity'];

/**
 * Protective verbs: a brake must not need both founders online, so these are operator-level even though they sit in a
 * founder namespace. The exception holds only when the type, the target service AND the target verb all agree (a
 * `matching.halt` filed against an `open:` target, or against another service, gets the strict answer). Verbs that open
 * or re-enable things (`resume`, `open`, `unfreeze`, ...) are deliberately absent.
 */
export const PROTECTIVE_ACTIONS: readonly { readonly actionType: string; readonly targetService: string; readonly targetVerb: string }[] = [
  { actionType: 'matching.halt', targetService: 'svc-matching', targetVerb: 'halt' },
  { actionType: 'matching.halt_all', targetService: 'svc-matching', targetVerb: 'halt_all' },
  { actionType: 'matching.reduce_only', targetService: 'svc-matching', targetVerb: 'reduce_only' },
  { actionType: 'matching.post_only', targetService: 'svc-matching', targetVerb: 'post_only' },
  { actionType: 'ledger.freeze', targetService: 'svc-ledger', targetVerb: 'posting_freeze' },
];

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

/** Audience of a bare action type string. Same rules as `audienceOfApproval` with no target to look at. */
export function audienceOf(actionType: string): ActionAudience {
  if (isSamePersonActionType(actionType)) return 'self';
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
  if (PROTECTIVE_ACTIONS.some((p) => p.actionType === type && p.targetService === service && p.targetVerb === verb)) return 'operator';
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
export function isInteractiveFounderPrincipal(principal: {
  readonly mfa: boolean;
  readonly kid?: string | undefined;
  readonly sub_account?: string | undefined;
}): boolean {
  return principal.mfa === true && !principal.kid && !principal.sub_account;
}
