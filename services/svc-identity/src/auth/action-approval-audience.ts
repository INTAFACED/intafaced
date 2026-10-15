/**
 * Who may propose, approve, reject or consume an action type.
 *
 * `founder`: money, venue and treasury actions (`pay.*`, `matching.*`, `ledger.*`, `bank.*`, `token.*`, and a short list of
 * identity types that set fees, limits or pay out). Only a live founder (the founder pair, with an enabled founder
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

/** A request filed against one of these services is founder-only whatever type string it carries. */
export const FOUNDER_TARGET_SERVICES: readonly string[] = ['svc-pay', 'svc-matching', 'svc-ledger', 'svc-bank', 'svc-token'];

const norm = (v: string): string => v.trim().toLowerCase();

function isFounderName(name: string): boolean {
  const n = norm(name);
  // Target ids of some services carry a verb and a subject (`open:market-1`, `kill:trade`): the verb is the type.
  const head = n.includes(':') ? n.slice(0, n.indexOf(':')) : n;
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
};

/**
 * Audience of a whole approval request. Founder when the type, the target id or the target service says so;
 * the strictest reading wins. A `self` type is only ever `self` on its own door, so it is checked first.
 */
export function audienceOfApproval(subject: ApprovalSubject): ActionAudience {
  const byType = audienceOf(subject.actionType);
  if (byType === 'self') return 'self';
  if (byType === 'founder') return 'founder';
  if (isFounderName(subject.targetId)) return 'founder';
  if (FOUNDER_TARGET_SERVICES.includes(norm(subject.targetService))) return 'founder';
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
