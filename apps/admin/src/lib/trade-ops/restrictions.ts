/**
 * Trading restrictions in plain words: the pure half of the Freezes room. No network here, so the browser and the
 * tests can use it. It checks what the operator typed, reads the service's answers with the real contract schemas,
 * and says each outcome and refusal code in a sentence.
 *
 * Three different freezes exist (see FREEZE_KINDS): this file is only about the first, the per-account TRADING
 * restriction that svc-identity keeps and svc-trade enforces on new orders.
 */
import type { AccountControlResult, AccountControlState } from '@intafaced/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export const HISTORY_LIMIT_MAX = 200;

export type Validated<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string };
const bad = (code: string, message: string): { ok: false; code: string; message: string } => ({ ok: false, code, message });

/** What the three kinds of freeze are, for the explainer. Source of truth for the wording. */
export const FREEZE_KINDS = [
  {
    id: 'trading',
    name: 'Trading restriction',
    owner: 'svc-identity records it, svc-trade enforces it',
    effect:
      'Blocks NEW orders for one account. Cancels still work, so the person can get out of what they hold. Funds and login are untouched.',
    where: 'This room.',
  },
  {
    id: 'identity',
    name: 'Identity freeze',
    owner: 'svc-identity',
    effect:
      'Freezes the whole account: sign-in and every money action are refused (auth.account_frozen). Much heavier than a trading restriction.',
    where: 'Accounts room of the console, not this desk.',
  },
  {
    id: 'ledger',
    name: 'Ledger posting freeze',
    owner: 'svc-ledger',
    effect: 'Stops new postings in the ledger itself, for everyone. Used to protect the books, not to restrict one person.',
    where: 'Ledger room of the console, not this desk.',
  },
] as const;

// ── What the operator types ─────────────────────────────────────────────────

export function validateUserId(raw: unknown): Validated<string> {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return bad('trade_ops.user_id_required', 'Enter the account user id (a UUID).');
  if (!isUuid(v))
    return bad('trade_ops.user_id_invalid', 'That is not a valid user id. It must be a UUID such as 3f2b8c1e-5d4a-4b7e-9c3a-1a2b3c4d5e6f.');
  return { ok: true, value: v.toLowerCase() };
}

export function validateLimit(raw: unknown): Validated<number> {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > HISTORY_LIMIT_MAX)
    return bad('trade_ops.limit_invalid', `History length must be a whole number from 1 to ${HISTORY_LIMIT_MAX}.`);
  return { ok: true, value: n };
}

/** The state version the service gave: digits, no leading zero (except 0 itself), at most 40 long. */
export const isVersion = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && /^(?:0|[1-9]\d*)$/.test(v);

export interface RestrictionChange {
  readonly userId: string;
  readonly action: 'restrict' | 'restore';
  readonly reason: string;
  readonly expectedVersion: string;
}

export const REASON_MIN = 3;
export const REASON_MAX = 500;

export function validateChange(body: Record<string, unknown>): Validated<RestrictionChange> {
  const user = validateUserId(body.userId);
  if (!user.ok) return user;
  if (body.action !== 'restrict' && body.action !== 'restore') return bad('trade_ops.action_invalid', 'Choose restrict or restore.');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX)
    return bad('trade_ops.reason_invalid', `The reason must be ${REASON_MIN} to ${REASON_MAX} characters.`);
  if (!isVersion(body.expectedVersion))
    return bad(
      'trade_ops.version_invalid',
      'Expected version must be the number shown in the account state (digits only). Look the account up first.',
    );
  return { ok: true, value: { userId: user.value, action: body.action, reason, expectedVersion: body.expectedVersion } };
}

// ── In words ────────────────────────────────────────────────────────────────

export const REFUSAL_WORDS: Record<string, string> = {
  'operator.denied': 'You are not allowed to change this. Your operator access is missing or was revoked.',
  'mfa.required': 'A second sign-in factor is needed. Verify your second factor, then try again.',
  'authority.unavailable': 'The service that decides account authority could not be reached, so nothing was changed. Try again shortly.',
  'edge.authority_unavailable': 'Temporary, retrying. The sign-in check did not finish, so nothing was changed.',
  'target.not_found': 'No trading account exists for that user id.',
  'restore.not_permitted': 'This restriction cannot be lifted by you. It needs a different authority.',
  'request.conflict': 'This request id was already used for a different change. Start a new request.',
  'restriction.version_conflict':
    'Someone changed this account since you looked. Reload the account, check the new state, and decide again.',
};

export const wordsForRefusal = (code: string): string => REFUSAL_WORDS[code] ?? `The service refused with ${code}.`;

export const stateWords = (s: Pick<AccountControlState, 'restricted'>): string =>
  s.restricted ? 'Restricted: new orders are blocked, cancels still work' : 'Not restricted: trading normally';

/** One sentence per history row. */
export function describeResult(r: AccountControlResult): string {
  const verb = r.action === 'restrict' ? 'restrict trading' : 'lift the restriction';
  switch (r.outcome) {
    case 'changed':
      return `Changed: asked to ${verb}; version ${r.before.version} to ${r.after.version}.`;
    case 'noop':
      return `No change: asked to ${verb} but the account was already ${r.after.restricted ? 'restricted' : 'unrestricted'} (version ${r.after.version}).`;
    case 'refused':
      return `Refused (${r.code}): ${wordsForRefusal(r.code)}`;
    case 'conflict':
      return `Refused (${r.code}): ${wordsForRefusal(r.code)} Current version ${r.current.version}.`;
  }
}

export interface RestrictionHistoryRow {
  readonly auditId: string;
  readonly requestId: string;
  readonly userId: string;
  readonly at: string;
  readonly actor: string | null;
  readonly action: 'restrict' | 'restore';
  readonly outcome: AccountControlResult['outcome'];
  readonly code: string | null;
  readonly reason: string;
  readonly versionBefore: string | null;
  readonly versionAfter: string | null;
  readonly summary: string;
}

export function historyRows(rows: readonly AccountControlResult[]): RestrictionHistoryRow[] {
  return rows.map((r) => ({
    auditId: r.auditId,
    requestId: r.requestId,
    userId: r.target.area === 'merchant' ? r.target.merchantId : r.target.userId,
    at: r.occurredAt,
    actor: r.actorUserId,
    action: r.action,
    outcome: r.outcome,
    code: 'code' in r ? r.code : null,
    reason: r.reason,
    versionBefore: 'before' in r ? r.before.version : 'current' in r && r.current ? r.current.version : null,
    versionAfter: 'after' in r ? r.after.version : null,
    summary: describeResult(r),
  }));
}
