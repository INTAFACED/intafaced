/**
 * Two-person approvals in plain words: the pure half (no network, safe in the browser and in tests).
 *
 * How a restriction needs a second person: operator A PROPOSES (identity stores the exact change as a hash),
 * hands the approval id to operator B, B reviews the change and APPROVES with the hash they reviewed, and only
 * then could the restriction be applied. Requester and approver must be two different signed-in people:
 * the service refuses the same person (action_approval.same_person) and this desk refuses it first.
 *
 * Identity has no list or read-back for approvals, so the desk can only act on an approval BY ID, and keeps a
 * log of what this browser tab did (sessionStorage, this session only) so the operator can see their own actions.
 */
import { actionApprovalSchema, type ActionApproval } from '@intafaced/contracts';
import { isUuid, isVersion, type Validated } from './restrictions';

export const RESTRICTION_ACTION_TYPE = 'account.trading_restriction';
export const RESTRICTION_TARGET_SERVICE = 'svc-trade';
export const RESTRICTION_POLICY_VERSION = 'trading-restriction-v1';
export const restrictionTargetId = (userId: string) => `trading:${userId}`;

const bad = (code: string, message: string): { ok: false; code: string; message: string } => ({ ok: false, code, message });
const HASH = /^sha256:[a-f0-9]{64}$/;
export const isPayloadHash = (v: unknown): v is string => typeof v === 'string' && HASH.test(v);
/** Approval ids are opaque strings (1..128). */
export const isApprovalId = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 128;

export function parseApproval(raw: unknown): ActionApproval | null {
  const r = actionApprovalSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// ── Plain words for the service's own refusal codes ─────────────────────────

export const APPROVAL_CODE_WORDS: Record<string, string> = {
  'action_approval.same_person': 'The person who proposed this cannot approve or reject it. A different signed-in operator must do it.',
  'action_approval.payload_mismatch':
    'The hash you reviewed is not the hash of the change that was proposed. Nothing was approved. Get the exact change from the proposer.',
  'action_approval.expired': 'This approval ran out of time. Propose it again.',
  'action_approval.not_pending': 'This approval is no longer waiting for a decision (already approved, rejected, revoked or used).',
  'action_approval.not_found': 'No approval has that id.',
  'action_approval.already_terminal': 'This approval is already finished and cannot be changed.',
  'action_approval.not_requester': 'Only the person who proposed this can revoke it.',
  'action_approval.founder_only': 'This kind of action can only be decided by a founder with a verified second factor.',
  'action_approval.operator_only': 'This kind of action can only be decided by an operator.',
  'action_approval.founders_unavailable': 'Identity could not confirm who the founders are, so it refused. Try again shortly.',
  'action_approval.service_mismatch': 'This approval belongs to a different service.',
  'action_approval.target_mismatch': 'This approval is for a different target than the one named.',
  'action_approval.consumed': 'This approval was already used.',
  'action_approval.not_approved': 'This approval has not been approved yet.',
  'action_approval.type_not_four_eyes': 'This action type does not use two-person approval.',
  'mfa.required': 'A second sign-in factor is needed. Verify your second factor, then try again.',
  'operator.denied': 'Your operator access is missing or was revoked.',
};

/** The service puts its code in square brackets at the end of the message; `code` may be a generic http.* one. */
export function serviceCode(code: string, message: string): string {
  if (code.startsWith('action_approval.') || code === 'mfa.required' || code === 'operator.denied') return code;
  const m = /\[([a-z_]+(?:\.[a-z_]+)+)\]\s*$/.exec(message);
  return m?.[1] ?? code;
}

export const wordsForApprovalCode = (code: string): string | null => APPROVAL_CODE_WORDS[code] ?? null;

// ── What the operator types ─────────────────────────────────────────────────

export type ApprovalVerb = 'approve' | 'reject' | 'revoke';

export interface ActOnApproval {
  readonly verb: ApprovalVerb;
  readonly approvalId: string;
  /** Approve only: the hash the approver reviewed. */
  readonly expectedPayloadHash?: string;
  /** Who proposed it, if this tab knows (from its own log or what the proposer told the approver). */
  readonly knownRequesterId?: string;
}

export function validateAct(body: Record<string, unknown>, signedInUserId: string): Validated<ActOnApproval> {
  const verb = body.verb;
  if (verb !== 'approve' && verb !== 'reject' && verb !== 'revoke')
    return bad('trade_ops.verb_invalid', 'Choose approve, reject or revoke.');
  if (!isApprovalId(body.approvalId)) return bad('trade_ops.approval_id_invalid', 'Enter the approval id the proposer gave you.');
  const approvalId = (body.approvalId as string).trim();
  const known = typeof body.knownRequesterId === 'string' && body.knownRequesterId.trim() ? body.knownRequesterId.trim() : undefined;
  // Approve and reject are the checker's verbs: never the requester. Revoke is the requester's own verb.
  if (verb !== 'revoke' && known !== undefined && known.toLowerCase() === signedInUserId.toLowerCase())
    return bad('action_approval.same_person', APPROVAL_CODE_WORDS['action_approval.same_person']!);
  if (verb === 'approve') {
    const h = typeof body.expectedPayloadHash === 'string' ? body.expectedPayloadHash.trim() : '';
    if (!isPayloadHash(h))
      return bad('trade_ops.payload_hash_invalid', 'Enter the payload hash you reviewed (sha256: followed by 64 hex characters).');
    return { ok: true, value: { verb, approvalId, expectedPayloadHash: h, ...(known ? { knownRequesterId: known } : {}) } };
  }
  return { ok: true, value: { verb, approvalId, ...(known ? { knownRequesterId: known } : {}) } };
}

export interface ProposeInput {
  readonly userId: string;
  readonly action: 'restrict' | 'restore';
  readonly reason: string;
  readonly expectedVersion: string;
}

export const sameOperator = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The full "apply it" form (blocked at the service today): an APPROVED approval id and a fresh request id. */
export function validateApply(body: Record<string, unknown>): Validated<{ approvalId: string; requestId: string }> {
  if (!isApprovalId(body.approvalId)) return bad('trade_ops.approval_id_invalid', 'Enter the id of an APPROVED request.');
  if (!isUuid(body.requestId)) return bad('trade_ops.request_id_invalid', 'The request id must be a UUID.');
  return { ok: true, value: { approvalId: (body.approvalId as string).trim(), requestId: body.requestId } };
}
export { isVersion };

// ── This session's own actions (kept in the tab, never sent anywhere) ───────

export interface ApprovalLogEntry {
  readonly at: string;
  readonly actorUserId: string;
  readonly verb: 'propose' | ApprovalVerb;
  readonly approvalId: string | null;
  readonly actionType: string | null;
  readonly targetId: string | null;
  readonly requesterId: string | null;
  readonly reason: string | null;
  /** ok = the service confirmed; refused = the service said no; unknown = no confirmed answer. */
  readonly outcome: 'ok' | 'refused' | 'unknown';
  /** Service status after the action (APPROVED...) or its refusal code. */
  readonly result: string;
}

export const APPROVAL_LOG_KEY = 'trops.approval-log.v1';
const LOG_MAX = 200;

export function appendLog(existing: readonly ApprovalLogEntry[], entry: ApprovalLogEntry): ApprovalLogEntry[] {
  return [entry, ...existing].slice(0, LOG_MAX);
}

export function parseLog(text: string | null): ApprovalLogEntry[] {
  if (!text) return [];
  try {
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is ApprovalLogEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof e.at === 'string' &&
        typeof e.actorUserId === 'string' &&
        typeof e.verb === 'string' &&
        typeof e.outcome === 'string' &&
        typeof e.result === 'string',
    );
  } catch {
    return [];
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export const loadLog = (s: StorageLike): ApprovalLogEntry[] => parseLog(s.getItem(APPROVAL_LOG_KEY));
export function saveLog(s: StorageLike, entries: readonly ApprovalLogEntry[]): void {
  try {
    s.setItem(APPROVAL_LOG_KEY, JSON.stringify(entries));
  } catch {
    /* storage full or blocked: the log is a convenience, never a requirement */
  }
}

/** Who proposed an approval, if this tab has seen it. */
export function knownRequester(log: readonly ApprovalLogEntry[], approvalId: string): string | undefined {
  return log.find((e) => e.approvalId === approvalId && e.requesterId)?.requesterId ?? undefined;
}
